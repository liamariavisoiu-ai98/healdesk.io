#!/bin/sh
# =============================================================================
# Provision healdesk_migrator and healdesk_app, then show what the database
# now says about them. Re-running is safe: provision-roles.sql resets the two
# passwords and re-checks everything else.
#
# Reads, from the environment only:
#   PGHOST, PGPORT, PGDATABASE    the instance endpoint and the app's database
#   PGUSER, PGPASSWORD            the RDS master user (ECS secrets)
#   PGSSLMODE, PGSSLROOTCERT      verify-full and the RDS bundle (image defaults)
#   APP_PASSWORD                  for healdesk_app (inside DATABASE_URL)
#   MIGRATOR_PASSWORD             for healdesk_migrator (inside MIGRATION_DATABASE_URL)
#
# Prints the host, database, user and TLS mode it connects with, psql's
# command tags and the role check at the end. It never prints a password.
# =============================================================================
set -eu

SCRIPT=/opt/healdesk/provision-roles.sql

if [ "$#" -gt 0 ]; then
  echo "db-admin: takes no arguments; it only provisions the roles" >&2
  exit 64
fi

missing=""
for name in PGHOST PGDATABASE PGUSER PGPASSWORD APP_PASSWORD MIGRATOR_PASSWORD; do
  eval "value=\${$name:-}"
  # "__unset__" is the placeholder the host's parameters start with: a role
  # must never be given it as a password.
  if [ -z "$value" ] || [ "$value" = "__unset__" ]; then
    missing="$missing $name"
  fi
done
if [ -n "$missing" ]; then
  echo "db-admin: not set:$missing" >&2
  exit 64
fi

# verify-full is the only mode that checks both the certificate and the host
# name. Anything else is refused unless a local test says so out loud: RDS
# forces TLS anyway, but require would accept any certificate inside the VPC.
sslmode=${PGSSLMODE:-}
if [ "$sslmode" != "verify-full" ]; then
  if [ "${DB_ADMIN_INSECURE_LOCAL_TEST_ONLY:-}" = "1" ]; then
    echo "db-admin: WARNING: PGSSLMODE=$sslmode, allowed for a local test only" >&2
  else
    echo "db-admin: PGSSLMODE must be verify-full (it is '${sslmode:-unset}')" >&2
    exit 64
  fi
elif [ ! -r "${PGSSLROOTCERT:-}" ]; then
  echo "db-admin: PGSSLROOTCERT is not a readable file (it is '${PGSSLROOTCERT:-unset}')" >&2
  exit 64
fi

echo "db-admin: provisioning on $PGHOST/$PGDATABASE as $PGUSER, sslmode=$sslmode"

psql -X -v ON_ERROR_STOP=1 \
  -v migrator_password="$MIGRATOR_PASSWORD" \
  -v app_password="$APP_PASSWORD" \
  -f "$SCRIPT"

# What the database now says. Both roles must read f for super, bypassrls,
# createrole and createdb, and t for login; public must grant the migrator
# UC and the app U, and nothing to PUBLIC; the database must grant the
# migrator Cc and the app c.
psql -X -v ON_ERROR_STOP=1 -P pager=off \
  -c "SELECT rolname, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolcanlogin
        FROM pg_roles WHERE rolname IN ('healdesk_app', 'healdesk_migrator') ORDER BY rolname" \
  -c "SELECT nspname, nspacl FROM pg_namespace WHERE nspname = 'public'" \
  -c "SELECT datname, datacl FROM pg_database WHERE datname = current_database()"

echo "db-admin: done. Next: migrations and queue:install as healdesk_migrator (the migrate task)."
