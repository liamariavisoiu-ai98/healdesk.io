#!/usr/bin/env bash
# =============================================================================
# Paste the host's external secrets into Parameter Store, from AWS CloudShell
# in us-east-1, signed in to the BAA account (865780386982).
#
#   bash put-external-secrets.sh                      every key in turn; Enter keeps a key as it is
#   bash put-external-secrets.sh RESEND_API_KEY ...   only the keys named
#   bash put-external-secrets.sh --status             which keys are set and which still __unset__
#
# Terraform creates each app parameter holding "__unset__" and never sees its
# value (infra/aws/ssm.tf); the image's entrypoint treats "__unset__" as
# unset, so a feature stays off until its key is pasted here.
# CLOUDFLARE_API_TOKEN is the exception: infra.yml reads it before Terraform
# runs, so this script creates it, under the bootstrap stack's key
# (alias/healdesk-terraform-state), which no task role can use. Every other
# parameter keeps the key it was created with.
#
# How a value travels: typed or pasted at a hidden prompt (read -s), so
# nothing shows and nothing reaches the shell history; written to a file in a
# private temporary directory and handed to the AWS CLI as file://, so it is
# never on a command line, where any process could read it; the file is
# deleted as soon as the write returns. The script prints key names and where
# each value came from, never a value or its length.
#
# STRIPE_MODE=live accepts a live Stripe key; without it only test keys are
# taken, because the host starts on test keys.
# =============================================================================
set -euo pipefail
set +x

export AWS_PAGER=""
REGION=us-east-1
ACCOUNT=865780386982
PREFIX=/healdesk/production
CI_KEY_ALIAS=alias/healdesk-terraform-state
PLACEHOLDER=__unset__

KEYS=(
  HEALDESK_PROVISION_SECRET
  STRIPE_SECRET_KEY
  STRIPE_CONNECT_WEBHOOK_SECRET
  RESEND_API_KEY
  GOOGLE_OAUTH_CLIENT_ID
  GOOGLE_OAUTH_CLIENT_SECRET
  META_APP_SECRET
  META_VERIFY_TOKEN
  ANTHROPIC_API_KEY
  HEALDESK_VOICE_WEBHOOK_SECRET
  HEALDESK_VOICE_TOOLS_SECRET
  CLOUDFLARE_API_TOKEN
)

say() { printf 'put-external-secrets: %s\n' "$*" >&2; }
fail() {
  say "$*"
  exit 1
}

parameter_for() {
  case "$1" in
    CLOUDFLARE_API_TOKEN) echo "$PREFIX/ci/$1" ;;
    *) echo "$PREFIX/app/$1" ;;
  esac
}

hint_for() {
  case "$1" in
    HEALDESK_PROVISION_SECRET) echo "signs apps/web's calls to the host; must equal HEALDESK_PROVISION_SECRET on Vercel" ;;
    STRIPE_SECRET_KEY) echo "Stripe secret key, ${STRIPE_MODE:-test} mode" ;;
    STRIPE_CONNECT_WEBHOOK_SECRET) echo "signing secret (whsec_...) of the Connect webhook endpoint on app.healdesk.io" ;;
    RESEND_API_KEY) echo "Resend API key (re_...)" ;;
    GOOGLE_OAUTH_CLIENT_ID) echo "Google OAuth client id (...apps.googleusercontent.com)" ;;
    GOOGLE_OAUTH_CLIENT_SECRET) echo "that Google OAuth client's secret" ;;
    META_APP_SECRET) echo "the Meta app's secret" ;;
    META_VERIFY_TOKEN) echo "the webhook verify token set in Meta's dashboard" ;;
    ANTHROPIC_API_KEY) echo "a key of the HIPAA-enabled Anthropic organisation, never the marketing one" ;;
    HEALDESK_VOICE_WEBHOOK_SECRET) echo "the voice provider's webhook signing secret" ;;
    HEALDESK_VOICE_TOOLS_SECRET) echo "the voice provider's tool-call secret" ;;
    CLOUDFLARE_API_TOKEN) echo "Cloudflare API token (Edit zone DNS, healdesk.io), read by infra.yml only" ;;
  esac
}

# Keys that switch on a path carrying patients' messages. The guide asks for
# them only once the business associate agreements behind that path are in
# place, so the script asks too.
patient_facing() {
  case "$1" in
    META_APP_SECRET | META_VERIFY_TOKEN | ANTHROPIC_API_KEY | HEALDESK_VOICE_WEBHOOK_SECRET | HEALDESK_VOICE_TOOLS_SECRET) return 0 ;;
  esac
  return 1
}

# The shape of a few vendors' keys, so a value pasted under the wrong name is
# caught here rather than by a feature that fails later.
shape_problem() {
  local mode=${STRIPE_MODE:-test}
  case "$1" in
    STRIPE_SECRET_KEY)
      case "$2" in
        "sk_${mode}_"* | "rk_${mode}_"*) ;;
        *) echo "that is not a Stripe $mode secret key (sk_${mode}_... or rk_${mode}_...)" ;;
      esac
      ;;
    STRIPE_CONNECT_WEBHOOK_SECRET) [[ "$2" == whsec_* ]] || echo "a webhook signing secret starts with whsec_" ;;
    RESEND_API_KEY) [[ "$2" == re_* ]] || echo "a Resend API key starts with re_" ;;
    ANTHROPIC_API_KEY) [[ "$2" == sk-ant-* ]] || echo "an Anthropic API key starts with sk-ant-" ;;
    GOOGLE_OAUTH_CLIENT_ID) [[ "$2" == *.apps.googleusercontent.com ]] || echo "a Google OAuth client id ends with .apps.googleusercontent.com" ;;
  esac
}

# --- arguments --------------------------------------------------------------
status_only=false
selected=()
if [ "$#" -eq 1 ] && [ "$1" = --status ]; then
  status_only=true
  selected=("${KEYS[@]}")
elif [ "$#" -eq 0 ]; then
  selected=("${KEYS[@]}")
else
  unknown=()
  for arg in "$@"; do
    known=false
    for key in "${KEYS[@]}"; do
      if [ "$arg" = "$key" ]; then known=true; fi
    done
    if [ "$known" = true ]; then selected+=("$arg"); else unknown+=("$arg"); fi
  done
  if [ "${#unknown[@]}" -gt 0 ]; then
    say "refusing names this script does not hold: ${unknown[*]}. Nothing was changed."
    say "the keys are: ${KEYS[*]}"
    exit 64
  fi
fi
case "${STRIPE_MODE:-test}" in
  test | live) ;;
  *) fail "STRIPE_MODE must be test or live" ;;
esac

# --- the account, and a private place for values ----------------------------
umask 077
tmp=$(mktemp -d)
cleanup() {
  rm -rf "$tmp"
  if [ -t 0 ]; then stty echo 2>/dev/null || true; fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

aws_() { aws --region "$REGION" "$@" 2>"$tmp/aws.err"; }
aws_says() { sed 's/^/  /' "$tmp/aws.err" >&2; }

account=$(aws_ sts get-caller-identity --query Account --output text) || {
  aws_says
  fail "the AWS CLI is not signed in (open CloudShell from the AWS console)"
}
if [ "$account" != "$ACCOUNT" ]; then
  fail "signed in to account $account, not $ACCOUNT, the account designated under the AWS BAA"
fi

# describe NAME: "<type><TAB><key id>", or "None" when there is no such parameter.
describe() {
  aws_ ssm describe-parameters --parameter-filters "Key=Name,Option=Equals,Values=$1" \
    --query 'Parameters[0].[Type, KeyId]' --output text || {
    aws_says
    fail "could not read $1's description"
  }
}

# holds_placeholder NAME: asked so that the value itself never leaves the AWS CLI.
holds_placeholder() {
  local answer
  answer=$(aws_ ssm get-parameter --name "$1" --with-decryption \
    --query "Parameter.Value == '$PLACEHOLDER'" --output text) || {
    aws_says
    fail "could not read $1"
  }
  [ "$answer" = True ]
}

# --- --status ---------------------------------------------------------------
if [ "$status_only" = true ]; then
  for key in "${selected[@]}"; do
    name=$(parameter_for "$key")
    meta=$(describe "$name")
    if [ "$meta" = None ]; then
      state="missing"
    elif holds_placeholder "$name"; then
      state="$PLACEHOLDER"
    else
      state="set"
    fi
    printf '  %-31s %s\n' "$key" "$state"
  done
  exit 0
fi

# --- paste ------------------------------------------------------------------
summary=()
pasted_app=false
pasted_provision=false
pasted_ci=false

for key in "${selected[@]}"; do
  name=$(parameter_for "$key")
  meta=$(describe "$name")
  create=false
  if [ "$meta" = None ]; then
    if [ "$key" != CLOUDFLARE_API_TOKEN ]; then
      fail "$name does not exist yet: run infra.yml with apply first, which creates it holding $PLACEHOLDER. Keys before it were handled as listed above."
    fi
    aws_ kms describe-key --key-id "$CI_KEY_ALIAS" --query KeyMetadata.KeyState --output text >/dev/null || {
      aws_says
      fail "$CI_KEY_ALIAS is not there to encrypt $name: launch the bootstrap stack (infra/aws/bootstrap/bootstrap.yaml) first"
    }
    create=true
    key_id=$CI_KEY_ALIAS
    current="missing"
  else
    IFS=$'\t' read -r type key_id <<<"$meta"
    if [ "$type" != SecureString ]; then
      fail "$name is a $type, not a SecureString: it was not made by Terraform or this script"
    fi
    if [ -z "$key_id" ] || [ "$key_id" = None ] || [ "$key_id" = alias/aws/ssm ]; then
      fail "$name is encrypted with the account's default key, not the product's: recreate it with Terraform"
    fi
    if holds_placeholder "$name"; then current=$PLACEHOLDER; else current="set"; fi
  fi

  echo >&2
  say "$key ($current): $(hint_for "$key")"
  if patient_facing "$key"; then
    answer=""
    read -r -p "  $key switches on a path that carries patients' messages. Type yes once its agreements are in place: " answer || true
    if [ "$answer" != yes ]; then
      summary+=("$key|kept ($current)")
      continue
    fi
  fi
  value=""
  IFS= read -r -s -p "  Paste $key (nothing will show), then Enter; Enter alone keeps it: " value || true
  echo >&2

  # A paste of several lines leaves the rest waiting; take none of it.
  if [ -t 0 ]; then
    extra=""
    IFS= read -r -s -t 0.3 extra || true
    if [ -n "$extra" ]; then
      while IFS= read -r -s -t 0.3 extra; do :; done
      value="" extra=""
      say "$key: that paste held more than one line, so nothing was saved"
      summary+=("$key|kept ($current)")
      continue
    fi
  fi

  # Leading and trailing white space is a paste artefact; none of these
  # values has any.
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  if [ -z "$value" ]; then
    summary+=("$key|kept ($current)")
    continue
  fi
  problem=""
  if [[ "$value" =~ [[:space:][:cntrl:]] ]]; then
    problem="it contains a space or a control character"
  elif [ "$value" = "$PLACEHOLDER" ]; then
    problem="that is the placeholder itself"
  elif [ "${#value}" -gt 4096 ]; then
    problem="it is longer than a parameter can hold"
  else
    problem=$(shape_problem "$key" "$value")
  fi
  if [ -n "$problem" ]; then
    value=""
    say "$key: nothing was saved: $problem"
    summary+=("$key|kept ($current)")
    continue
  fi

  printf '%s' "$value" >"$tmp/value"
  value=""
  extra_args=()
  if [ "$create" = true ]; then
    extra_args=(--description "Cloudflare API token for infra.yml (Edit zone DNS on healdesk.io). Pasted with infra/aws/scripts/put-external-secrets.sh.")
  fi
  if ! aws_ ssm put-parameter --name "$name" --type SecureString --key-id "$key_id" --overwrite \
    --value "file://$tmp/value" ${extra_args[@]+"${extra_args[@]}"} --query Version --output text >/dev/null; then
    rm -f "$tmp/value"
    # A refused write can be quoted back with the value it carried: the
    # error code alone.
    code=$(sed -n 's/.*An error occurred (\([^)]*\)).*/\1/p' "$tmp/aws.err" | head -n 1)
    fail "writing $name failed (${code:-no AWS error code}); the AWS CLI's message is not shown because it can quote the value"
  fi
  rm -f "$tmp/value"
  say "$key: saved to $name"
  summary+=("$key|pasted")
  case "$key" in
    CLOUDFLARE_API_TOKEN) pasted_ci=true ;;
    HEALDESK_PROVISION_SECRET)
      pasted_app=true
      pasted_provision=true
      ;;
    *) pasted_app=true ;;
  esac
done

echo >&2
say "where each value came from:"
for line in "${summary[@]}"; do
  printf '  %-31s %s\n' "${line%%|*}" "${line#*|}" >&2
done
if [ "$pasted_provision" = true ]; then
  say "HEALDESK_PROVISION_SECRET must be the same value as apps/web's on Vercel, or every signed call fails."
fi
if [ "$pasted_app" = true ]; then
  say "tasks read their parameters when they start: run deploy-app.yml with restart_only for web and worker to use the new values."
fi
if [ "$pasted_ci" = true ]; then
  say "infra.yml reads CLOUDFLARE_API_TOKEN at its next run."
fi
