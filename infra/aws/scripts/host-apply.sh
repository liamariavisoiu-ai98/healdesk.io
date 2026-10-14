#!/usr/bin/env bash
# =============================================================================
# host-apply.sh: one Terraform plan, the plan guard over it, and its apply,
# for .github/workflows/host.yml. Run from infra/aws after `terraform init`,
# with the Terraform role's credentials and the TF_VAR_* settings infra.yml
# also passes.
#
#   bash scripts/host-apply.sh LABEL GUARD [PLAN_ARGUMENTS...]
#
#   LABEL           a few words for the log and the job summary ("turn on")
#   GUARD           active, release or standby: plan-guard.sh's rules for this apply
#   PLAN_ARGUMENTS  given to `terraform plan` after -var-file=production.tfvars,
#                   so a -var here overrides the file (-var standby=true, ...)
#
# The same steps as infra.yml's apply, so what changes is what the log shows:
# a saved plan, rendered for the log (Terraform redacts sensitive values in
# the rendering), checked by plan-guard.sh in its JSON form, which is deleted
# straight after because it holds every value in clear, and applied exactly.
# The Cloudflare token is read here, after the role is assumed, masked, and
# exported to Terraform alone.
#
# Writes the plan's "Plan:" line to the job summary, and leaves the rendering
# as plan-<label>.txt for the workflow to upload. Exits non-zero if any step
# fails or the guard refuses.
# =============================================================================
set -euo pipefail

[ "$#" -ge 2 ] || {
  echo "usage: host-apply.sh LABEL active|release|standby [PLAN_ARGUMENTS...]" >&2
  exit 2
}
label=$1
guard=$2
shift 2
case "$guard" in
  active) guard_flags=() ;;
  release) guard_flags=(--release) ;;
  standby) guard_flags=(--standby) ;;
  *)
    echo "host-apply: GUARD must be active, release or standby" >&2
    exit 2
    ;;
esac

slug=$(tr -cs 'a-z0-9' '-' <<<"${label,,}")
slug=${slug%-}
plan_file="tfplan-$slug"
rendered="plan-$slug.txt"
json="$(mktemp)"
trap 'rm -f "$json"' EXIT

parameter=${CLOUDFLARE_TOKEN_PARAMETER:?CLOUDFLARE_TOKEN_PARAMETER is not set}
if ! token=$(aws ssm get-parameter --name "$parameter" --with-decryption \
  --query Parameter.Value --output text 2>"$json"); then
  if grep -q ParameterNotFound "$json"; then
    echo "::error::$parameter is not in Parameter Store. Paste the Cloudflare API token (Edit zone DNS on healdesk.io) in CloudShell with: bash put-external-secrets.sh CLOUDFLARE_API_TOKEN (infra/aws/scripts/). Then run this again."
  else
    cat "$json" >&2
  fi
  exit 1
fi
if [ -z "$token" ] || [ "$token" = __unset__ ]; then
  echo "::error::$parameter holds no token yet. Paste it in CloudShell with: bash put-external-secrets.sh CLOUDFLARE_API_TOKEN (infra/aws/scripts/). Then run this again."
  exit 1
fi
echo "::add-mask::$token"
export CLOUDFLARE_API_TOKEN="$token"
token=""

echo "host-apply: $label: terraform plan -var-file=production.tfvars $*"
set +e
terraform plan -input=false -lock-timeout=5m -var-file=production.tfvars "$@" \
  -out="$plan_file" -detailed-exitcode
code=$?
set -e
case "$code" in
  0) changes=false ;;
  2) changes=true ;;
  *) exit "$code" ;;
esac

terraform show -no-color "$plan_file" >"$rendered"
summary_line=$(grep -E '^(Plan:|No changes\.)' "$rendered" || true)
{
  echo "#### $label"
  echo
  echo "${summary_line:-No changes.}"
  echo
} >>"${GITHUB_STEP_SUMMARY:-/dev/null}"

if [ "$changes" = false ]; then
  echo "host-apply: $label: no changes, nothing to apply"
  exit 0
fi

terraform show -json "$plan_file" >"$json"
bash "$(dirname "$0")/plan-guard.sh" "$json" "${guard_flags[@]}"
rm -f "$json"

terraform apply -input=false -lock-timeout=5m "$plan_file"
echo "host-apply: $label: applied"
