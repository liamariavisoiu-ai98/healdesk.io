#!/bin/sh
# =============================================================================
# db-admin: the one-off task healdesk-production-db-bootstrap, run by
# deploy-app.yml (bootstrap_db) or infra/aws/scripts/run-task.sh. It takes no
# arguments and does two things, in this order.
#
# 1. init-secrets. Terraform creates the eight internal parameters below holding
#    the literal "__unset__" and never writes their values, so no secret is in
#    its state or its plans. This step gives each one that still holds
#    "__unset__" a value, here inside AWS, and keeps every one that is set. It
#    never makes a new value for a parameter that has one: database passwords
#    changed without the roles being given them would lock every task out, and
#    a new HEALDESK_IDENTIFIER_REF_KEY would orphan every reference stored under
#    the old one.
#
#      db/APP_PASSWORD, db/MIGRATOR_PASSWORD      48 random letters and digits
#      app/BETTER_AUTH_SECRET                     64 random letters and digits
#      app/HEALDESK_IDENTIFIER_REF_KEY            64 random letters and digits
#      app/DATABASE_URL                           healdesk_app and its password
#      migrator/MIGRATION_DATABASE_URL            healdesk_migrator and its password
#      db/READONLY_PASSWORD                       48 random letters and digits
#      readonly/READONLY_DATABASE_URL             healdesk_readonly and its password
#                                                 (the db-query task; docs/design/db-access-2026-10-22.md)
#
#    A URL reads postgresql://<role>:<password>@<PGHOST>:<PGPORT>/<PGDATABASE>
#    ?sslmode=verify-full&sslrootcert=/etc/ssl/rds/us-east-1-bundle.pem, and
#    letters and digits need no escaping in it. A URL that is set is kept only
#    if it carries its role's password, and a password that is "__unset__"
#    while its URL is set is refused: a new password needs a new URL, so set
#    both to "__unset__". Both refusals come before anything is written.
#
# 2. provision-roles. It reads the three passwords back from Parameter Store,
#    runs apps/app/scripts/provision-roles.sql as the RDS master user, then
#    signs in as each role with the password Parameter Store holds, so a run
#    that succeeds shows the two URLs will connect.
#
# No value is ever on a command line (every process in the container can read
# those), in the output, or in the task definition. Values pass between the AWS
# CLI, Python and psql through files in a private directory that is removed on
# exit, and the AWS CLI reads them as file://. PostgreSQL never receives a
# password either: psql sends the SCRAM-SHA-256 verifier made here
# (scram-verifier.py), which the server stores as it is. A failed ALTER ROLE
# that the server logs with its statement then cannot put a password into the
# never-expiring RDS log.
#
# Environment (the task definition):
#   PGHOST, PGPORT, PGDATABASE   the instance endpoint, 5432 and healdesk
#   PGUSER, PGPASSWORD           the RDS master user (ECS secrets)
#   PGSSLMODE, PGSSLROOTCERT     verify-full and the RDS bundle (image defaults)
#   HEALDESK_KMS_KEY_ID          the key the parameters are encrypted with,
#                                written exactly as Terraform's key_id names it
#                                (the key's ARN); any other spelling would read
#                                as a change to Terraform's next plan
#   HEALDESK_PARAMETER_PREFIX    /healdesk/production unless set
#   AWS_REGION                   set by ECS; otherwise read from PGHOST
# The task role may get and put those eight parameters and use the key through
# Parameter Store, and nothing else.
#
# Prints parameter names with "generated" or "kept", psql's command tags, the
# role check and the sign-in check. Never a value.
# =============================================================================
set -eu
umask 077

PROVISION_SQL=/opt/healdesk/provision-roles.sql
SCRAM_VERIFIER=/opt/healdesk/scram-verifier.py
# Where the app image keeps the RDS bundle (apps/app/Dockerfile). The URLs are
# read by that image, so they name its path, which this image happens to share.
APP_CA_BUNDLE=/etc/ssl/rds/us-east-1-bundle.pem
PLACEHOLDER=__unset__

say() { printf 'db-admin: %s\n' "$*"; }
fail() {
  printf 'db-admin: %s\n' "$*" >&2
  exit 1
}
refuse() {
  printf 'db-admin: %s\n' "$*" >&2
  exit 64
}

if [ "$#" -gt 0 ]; then
  refuse "takes no arguments"
fi

missing=""
for name in PGHOST PGDATABASE PGUSER PGPASSWORD HEALDESK_KMS_KEY_ID; do
  eval "value=\${$name:-}"
  if [ -z "$value" ] || [ "$value" = "$PLACEHOLDER" ]; then
    missing="$missing $name"
  fi
done
value=""
if [ -n "$missing" ]; then
  refuse "not set:$missing"
fi

# verify-full is the only mode that checks both the certificate and the host
# name. Anything else is refused unless a local test says so out loud: RDS
# forces TLS anyway, but require would accept any certificate inside the VPC.
sslmode=${PGSSLMODE:-}
if [ "$sslmode" != "verify-full" ]; then
  if [ "${DB_ADMIN_INSECURE_LOCAL_TEST_ONLY:-}" = "1" ]; then
    echo "db-admin: WARNING: PGSSLMODE=$sslmode, allowed for a local test only" >&2
  else
    refuse "PGSSLMODE must be verify-full (it is '${sslmode:-unset}')"
  fi
elif [ ! -r "${PGSSLROOTCERT:-}" ]; then
  refuse "PGSSLROOTCERT is not a readable file (it is '${PGSSLROOTCERT:-unset}')"
fi

# ECS sets AWS_REGION on Fargate. The instance endpoint names its region too
# (<id>.<hash>.us-east-1.rds.amazonaws.com), so a task definition without it
# still works.
region=${AWS_REGION:-${AWS_DEFAULT_REGION:-}}
if [ -z "$region" ]; then
  case "$PGHOST" in
    *.rds.amazonaws.com)
      region=${PGHOST%.rds.amazonaws.com}
      region=${region##*.}
      ;;
  esac
fi
if [ -z "$region" ]; then
  refuse "no AWS region: set AWS_REGION"
fi

prefix=${HEALDESK_PARAMETER_PREFIX:-/healdesk/production}
prefix=${prefix%/}
case "$prefix" in
  /?*) ;;
  *) refuse "HEALDESK_PARAMETER_PREFIX must be a path such as /healdesk/production (it is '$prefix')" ;;
esac

work=$(mktemp -d "${TMPDIR:-/tmp}/db-admin.XXXXXX")
trap 'rm -rf "$work"' EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

# --- Parameter Store ---------------------------------------------------------

# The AWS CLI in the task's region, never paging, its error output kept for
# the two reports below rather than printed as it comes.
aws_call() {
  aws --region "$region" --no-cli-pager "$@" 2>"$work/aws.err"
}

# A read sends no value, so the CLI's own message is safe to show.
read_failed() {
  printf 'db-admin: reading %s failed:\n' "$1" >&2
  sed 's/^/  /' "$work/aws.err" >&2
  exit 1
}

# A refused write can be quoted back with the value it carried, so only the
# AWS error code is shown.
write_failed() {
  code=$(sed -n 's/.*An error occurred (\([^)]*\)).*/\1/p' "$work/aws.err" | head -n 1)
  fail "writing $1 failed (${code:-no AWS error code}); the AWS CLI's message is not shown because it can quote the value"
}

# fetch NAME FILE: NAME's decrypted value into FILE, without a newline.
fetch() {
  fetched=$(aws_call ssm get-parameter --name "$1" --with-decryption \
    --query Parameter.Value --output text) || read_failed "$1"
  printf '%s' "$fetched" >"$2"
  fetched=""
}

# holds_placeholder NAME: whether NAME still holds "__unset__". The CLI makes
# the comparison itself, so the two app secrets, never needed here once they
# are set, never leave it.
holds_placeholder() {
  answer=$(aws_call ssm get-parameter --name "$1" --with-decryption \
    --query "Parameter.Value == '$PLACEHOLDER'" --output text) || read_failed "$1"
  case "$answer" in
    True) return 0 ;;
    False) return 1 ;;
  esac
  fail "reading $1: unexpected answer '$answer'"
}

# store NAME FILE: FILE as NAME's new value. Only the value and the key are
# sent, and the key as Terraform names it, so the description, the tier and
# the rest stay as Terraform made them and its next plan finds nothing to
# change. Without --key-id, Parameter Store would encrypt with the account's
# default key instead.
store() {
  aws_call ssm put-parameter --name "$1" --type SecureString \
    --key-id "$HEALDESK_KMS_KEY_ID" --overwrite --value "file://$2" \
    --query Version --output text >/dev/null || write_failed "$1"
}

# generate LENGTH FILE: random letters and digits from Python's secrets
# module, written straight to FILE.
generate() {
  python3 -c 'import secrets, string, sys
alphabet = string.ascii_letters + string.digits
sys.stdout.write("".join(secrets.choice(alphabet) for _ in range(int(sys.argv[1]))))' "$1" >"$2"
}

holds() { [ "$(cat "$1")" = "$2" ]; }

report() { printf 'db-admin:   %-34s %s\n' "$1" "$2"; }

# url_for ROLE PASSWORD_FILE: the URL the app image reads (see the header).
url_for() {
  printf 'postgresql://%s:%s@%s:%s/%s?sslmode=verify-full&sslrootcert=%s' \
    "$1" "$(cat "$2")" "$PGHOST" "${PGPORT:-5432}" "$PGDATABASE" "$APP_CA_BUNDLE"
}

# --- 1. init-secrets ---------------------------------------------------------

# check_role ROLE PASSWORD URL TAG: refuse, before anything is written, a
# password or URL that is set but could not be used as it is.
check_role() {
  password_file=$work/$4.password
  url_file=$work/$4.url
  if holds "$password_file" "$PLACEHOLDER"; then
    if ! holds "$url_file" "$PLACEHOLDER"; then
      fail "$prefix/$2 is $PLACEHOLDER but $prefix/$3 is set, and a new password needs a new URL. Set $3 to $PLACEHOLDER as well, then run this again. Nothing was written."
    fi
    return 0
  fi

  # Kept passwords go into a URL unescaped and into psql and a password file
  # unquoted, so they must be the URL-safe characters this step makes.
  candidate=$(cat "$password_file")
  case "$candidate" in
    *[!A-Za-z0-9._~-]*)
      fail "$prefix/$2 holds a character a URL would need escaped. Set it and $3 to $PLACEHOLDER to have both made again, then run this again. Nothing was written."
      ;;
  esac
  if [ "${#candidate}" -lt 32 ]; then
    fail "$prefix/$2 is shorter than 32 characters. Set it and $3 to $PLACEHOLDER to have both made again, then run this again. Nothing was written."
  fi

  if ! holds "$url_file" "$PLACEHOLDER"; then
    current=$(cat "$url_file")
    rest=${current#postgresql://}
    if [ "$rest" = "$current" ] || [ "${rest%%@*}" != "$1:$candidate" ]; then
      current="" rest="" candidate=""
      fail "$prefix/$3 does not carry $1 with the password in $2, so it could not connect once the role is given that password. Set $3 to $PLACEHOLDER to have it made again, then run this again. Nothing was written."
    fi
    # The host may differ while PGHOST is overridden for a restore drill;
    # the URL then still names production's endpoint, which is right. The
    # rest must be as this step writes it: the app refuses any other sslmode.
    endpoint=${rest#*@}
    endpoint=${endpoint%%/*}
    if [ "${rest#*@"$endpoint"}" != "/$PGDATABASE?sslmode=verify-full&sslrootcert=$APP_CA_BUNDLE" ]; then
      current="" rest="" candidate=""
      fail "$prefix/$3 is not in the form this task writes (database, sslmode or sslrootcert differ). Set $3 to $PLACEHOLDER to have it made again, then run this again. Nothing was written."
    fi
    if [ "$endpoint" != "$PGHOST:${PGPORT:-5432}" ]; then
      say "note: $3 names $endpoint, not $PGHOST: kept as it is (expected while PGHOST is overridden, as in a restore drill)"
    fi
    current="" rest=""
  fi
  candidate=""
}

# ensure_password NAME TAG
ensure_password() {
  if holds "$work/$2.password" "$PLACEHOLDER"; then
    generate 48 "$work/$2.password"
    store "$prefix/$1" "$work/$2.password"
    report "$1" generated
    new_passwords="$new_passwords $1"
  else
    report "$1" kept
  fi
}

# ensure_secret NAME LENGTH
ensure_secret() {
  if holds_placeholder "$prefix/$1"; then
    generate "$2" "$work/secret"
    store "$prefix/$1" "$work/secret"
    rm -f "$work/secret"
    report "$1" generated
  else
    report "$1" kept
  fi
}

# ensure_url NAME ROLE TAG
ensure_url() {
  if holds "$work/$3.url" "$PLACEHOLDER"; then
    url_for "$2" "$work/$3.password" >"$work/$3.url"
    store "$prefix/$1" "$work/$3.url"
    report "$1" generated
  else
    report "$1" kept
  fi
}

new_passwords=""
say "init-secrets: the internal parameters under $prefix"
fetch "$prefix/db/APP_PASSWORD" "$work/app.password"
fetch "$prefix/db/MIGRATOR_PASSWORD" "$work/migrator.password"
fetch "$prefix/app/DATABASE_URL" "$work/app.url"
fetch "$prefix/migrator/MIGRATION_DATABASE_URL" "$work/migrator.url"
fetch "$prefix/db/READONLY_PASSWORD" "$work/readonly.password"
fetch "$prefix/readonly/READONLY_DATABASE_URL" "$work/readonly.url"
check_role healdesk_app db/APP_PASSWORD app/DATABASE_URL app
check_role healdesk_migrator db/MIGRATOR_PASSWORD migrator/MIGRATION_DATABASE_URL migrator
check_role healdesk_readonly db/READONLY_PASSWORD readonly/READONLY_DATABASE_URL readonly

ensure_password db/APP_PASSWORD app
ensure_password db/MIGRATOR_PASSWORD migrator
ensure_password db/READONLY_PASSWORD readonly
ensure_secret app/BETTER_AUTH_SECRET 64
ensure_secret app/HEALDESK_IDENTIFIER_REF_KEY 64
ensure_url app/DATABASE_URL healdesk_app app
ensure_url migrator/MIGRATION_DATABASE_URL healdesk_migrator migrator
ensure_url readonly/READONLY_DATABASE_URL healdesk_readonly readonly
rm -f "$work/app.url" "$work/migrator.url" "$work/readonly.url"

# --- 2. provision-roles ------------------------------------------------------

# read_back NAME TAG: NAME as Parameter Store now returns it, which must be
# what this run holds for it (a value written a moment ago included).
read_back() {
  tries=0
  while :; do
    fetch "$prefix/$1" "$work/$2.stored"
    if cmp -s "$work/$2.stored" "$work/$2.password"; then
      return 0
    fi
    tries=$((tries + 1))
    if [ "$tries" -ge 5 ]; then
      fail "$prefix/$1 does not read back as the value this run holds for it; nothing was provisioned"
    fi
    sleep 2
  done
}

read_back db/APP_PASSWORD app
read_back db/MIGRATOR_PASSWORD migrator
read_back db/READONLY_PASSWORD readonly

# psql variables, set from a file rather than with -v on the command line.
python3 "$SCRAM_VERIFIER" migrator_password <"$work/migrator.stored" >"$work/roles.psql"
python3 "$SCRAM_VERIFIER" app_password <"$work/app.stored" >>"$work/roles.psql"
python3 "$SCRAM_VERIFIER" readonly_password <"$work/readonly.stored" >>"$work/roles.psql"

say "provision-roles: on $PGHOST/$PGDATABASE as $PGUSER, sslmode=$sslmode"
psql -X -v ON_ERROR_STOP=1 -f "$work/roles.psql" -f "$PROVISION_SQL"
rm -f "$work/roles.psql"

# What the database now says. Both roles must read f for super, bypassrls,
# createrole and createdb, and t for login; public must grant the migrator
# UC and the app U, and nothing to PUBLIC; the database must grant the
# migrator Cc and the app c.
psql -X -v ON_ERROR_STOP=1 -P pager=off \
  -c "SELECT rolname, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolcanlogin
        FROM pg_roles WHERE rolname IN ('healdesk_app', 'healdesk_migrator', 'healdesk_readonly') ORDER BY rolname" \
  -c "SELECT nspname, nspacl FROM pg_namespace WHERE nspname = 'public'" \
  -c "SELECT datname, datacl FROM pg_database WHERE datname = current_database()"

# Sign in as each role with the password Parameter Store holds, through a
# private password file: the master's PGPASSWORD is taken away for these two,
# because libpq prefers it to the file.
printf '*:*:*:healdesk_app:%s\n*:*:*:healdesk_migrator:%s\n*:*:*:healdesk_readonly:%s\n' \
  "$(cat "$work/app.stored")" "$(cat "$work/migrator.stored")" "$(cat "$work/readonly.stored")" >"$work/pgpass"
for role in healdesk_app healdesk_migrator healdesk_readonly; do
  who=$(env -u PGPASSWORD PGUSER="$role" PGPASSFILE="$work/pgpass" \
    psql -X -A -t -v ON_ERROR_STOP=1 -c "SELECT current_user") ||
    fail "$role could not sign in with the password Parameter Store holds for it"
  if [ "$who" != "$role" ]; then
    fail "signing in as $role gave '$who'"
  fi
  say "provision-roles: $role signs in with its password from Parameter Store"
done

if [ -n "$new_passwords" ]; then
  say "new this run:$new_passwords. Web or worker tasks that were already running hold the previous one: restart them (deploy-app.yml with restart_only)."
fi
say "done. Next: migrations and queue:install as healdesk_migrator (the migrate task)."
