#!/usr/bin/env bash
# =============================================================================
# Run one of apps/app's one-off tasks from a terminal, outside GitHub Actions:
# AWS CloudShell in us-east-1, signed in to the BAA account (865780386982).
#
#   bash infra/aws/scripts/run-task.sh migrate        migrations, then queue:install
#   bash infra/aws/scripts/run-task.sh db-bootstrap   init-secrets, then the two roles
#   bash infra/aws/scripts/run-task.sh destroy-due    after a restore: destroy every clinic due
#   bash infra/aws/scripts/run-task.sh patient-export <clinic id> "<who asked>"
#                                                     a leaving clinic's return bundle
#
# It runs the family's newest revision that names a deployed image, never
# Terraform's own revisions: those name the image tag terraform-placeholder,
# which nothing pushes, so a task of one could only fail to pull. The deploy
# workflow registers the others, with the commit's image. destroy-due and
# patient-export run the newest revision naming the image the worker service
# runs, so after a rollback they run the code that is live, not the code
# rolled back from; destroy-due exits non-zero while any clinic is still due
# (docs/handover.md, "Restoring"). The network is the web service's (its
# private subnets and security group, the one the database admits, no public
# address), read at run time rather than copied in.
#
# run-task arguments are recorded by CloudTrail, so commands and secrets live
# in the task definition and nothing is overridden, with one exception:
# patient-export takes three environment overrides, the clinic's id, who
# asked (a label checked here to carry no email address or phone number) and
# the object key, clinic-<id>-<UTC time>.json. None is secret or a
# patient's. The bundle lands in the export bucket (infra/aws/exports.tf);
# on success this prints its key and the commands to download it and, after
# the handover, delete it.
#
# It waits for the task to stop, then prints ECS's account of it (the stop
# code, the stopped reason, the container's exit code and reason) and exits 0
# only if the container exited 0. It never prints the task's own output:
# migrations can quote SQL and row values, so the log stays in CloudWatch,
# under the product key, and only its group and stream are named here.
#
# RUN_TASK_TIMEOUT_MINUTES (default 30) bounds the wait. The task keeps
# running after a timeout; the message says how to stop it.
# =============================================================================
set -euo pipefail

export AWS_PAGER=""
REGION=us-east-1
ACCOUNT=865780386982
CLUSTER=healdesk-production
WEB_SERVICE=healdesk-production-web
WORKER_SERVICE=healdesk-production-worker
PLACEHOLDER_TAG=terraform-placeholder
TIMEOUT_MINUTES=${RUN_TASK_TIMEOUT_MINUTES:-30}

say() { printf 'run-task: %s\n' "$*"; }
fail() {
  printf 'run-task: %s\n' "$*" >&2
  exit 1
}
usage() {
  echo "usage: $0 migrate|db-bootstrap|destroy-due" >&2
  echo "       $0 patient-export <clinic id> \"<who asked, and the ticket>\"" >&2
  exit 64
}

EXPORT_BUCKET=healdesk-production-exports-$ACCOUNT
[ "$#" -ge 1 ] || usage
if [ "$1" = patient-export ]; then [ "$#" -eq 3 ] || usage; else [ "$#" -eq 1 ] || usage; fi
case "$1" in
  migrate)
    family=healdesk-production-migrate
    container=app
    ;;
  db-bootstrap)
    family=healdesk-production-db-bootstrap
    container=db-admin
    ;;
  destroy-due)
    family=healdesk-production-destroy-due
    container=app
    ;;
  patient-export)
    family=healdesk-production-patient-export
    container=app
    ;;
  *) usage ;;
esac

# patient-export's three overrides, checked before any AWS call. The label
# goes into a recorded override and the audit row, so it may hold letters,
# digits, spaces and a little punctuation, and nothing shaped like an email
# address or a phone number.
overrides=""
export_key=""
if [ "$1" = patient-export ]; then
  clinic_id=$2
  requested_by=$3
  if ! printf '%s' "$clinic_id" | grep -Eqi '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'; then
    fail "the clinic id must be the clinic's uuid (the ops console shows it)"
  fi
  clinic_id=$(printf '%s' "$clinic_id" | tr '[:upper:]' '[:lower:]')
  if [ "${#requested_by}" -lt 3 ] || [ "${#requested_by}" -gt 200 ]; then
    fail "say who asked, and the ticket, in 3 to 200 characters"
  fi
  if ! printf '%s' "$requested_by" | grep -Eq "^[A-Za-z0-9 ,.:;()'/_-]+\$"; then
    fail "who asked may hold letters, digits, spaces and , . : ; ( ) ' / _ - only"
  fi
  # The audit row's own test (apps/app/src/lib/audit.ts, PHONE_LIKE): ten or
  # more digits and separators read as a phone number, and so does a date
  # written in digits, which is why dates go in words.
  if printf '%s' "$requested_by" | grep -Eq '[0-9][0-9 ().-]{8,}[0-9]'; then
    fail "who asked looks like it holds a phone number; describe it without one, and write any date in words (1 October 2026)"
  fi
  export_key="clinic-$clinic_id-$(date -u +%Y%m%dT%H%M%SZ).json"
  overrides=$(printf '{"containerOverrides":[{"name":"app","environment":[{"name":"HEALDESK_EXPORT_CLINIC_ID","value":"%s"},{"name":"HEALDESK_EXPORT_REQUESTED_BY","value":"%s"},{"name":"HEALDESK_EXPORT_KEY","value":"%s"}]}]}' \
    "$clinic_id" "$requested_by" "$export_key")
fi
case "$TIMEOUT_MINUTES" in
  '' | *[!0-9]* | 0) fail "RUN_TASK_TIMEOUT_MINUTES must be a whole number of minutes" ;;
esac

aws_() { aws --region "$REGION" "$@"; }

# The BAA account and nothing else.
account=$(aws_ sts get-caller-identity --query Account --output text) ||
  fail "the AWS CLI is not signed in (open CloudShell from the AWS console)"
if [ "$account" != "$ACCOUNT" ]; then
  fail "signed in to account $account, not $ACCOUNT, the account designated under the AWS BAA"
fi

# --- the network, from the web service --------------------------------------
# The backticks are JMESPath literals for the AWS CLI, not the shell's.
# shellcheck disable=SC2016
service=$(aws_ ecs describe-services --cluster "$CLUSTER" --services "$WEB_SERVICE" --output text \
  --query 'services[0].[status, networkConfiguration.awsvpcConfiguration.assignPublicIp, join(`,`, networkConfiguration.awsvpcConfiguration.subnets), join(`,`, networkConfiguration.awsvpcConfiguration.securityGroups)]')
IFS=$'\t' read -r service_status public_ip subnets groups <<<"$service"
if [ "$service_status" != ACTIVE ]; then
  fail "$WEB_SERVICE is not an active service of $CLUSTER (got: $service_status). Run infra.yml with apply first."
fi
if [ "$public_ip" != DISABLED ] || [ -z "$subnets" ] || [ "$subnets" = None ] || [ -z "$groups" ] || [ "$groups" = None ]; then
  fail "$WEB_SERVICE has no private network to lend (assignPublicIp $public_ip, subnets '$subnets', security groups '$groups')"
fi

# --- destroy-due: the image the worker runs ----------------------------------
want_image=""
if [ "$1" = destroy-due ] || [ "$1" = patient-export ]; then
  worker_td=$(aws_ ecs describe-services --cluster "$CLUSTER" --services "$WORKER_SERVICE" \
    --query 'services[0].taskDefinition' --output text)
  case "$worker_td" in
    '' | None) fail "$WORKER_SERVICE has no task definition. Run deploy-app.yml first." ;;
  esac
  want_image=$(aws_ ecs describe-task-definition --task-definition "$worker_td" --output text \
    --query "taskDefinition.containerDefinitions[?name=='app'] | [0].image")
  case "$want_image" in
    None | '' | *":$PLACEHOLDER_TAG") fail "$WORKER_SERVICE runs no deployed image yet. Run deploy-app.yml first." ;;
  esac
  say "the worker runs ${want_image##*/}"
fi

# --- the revision: the newest that names a deployed image -------------------
revisions=$(aws_ ecs list-task-definitions --family-prefix "$family" --status ACTIVE --sort DESC \
  --max-items 25 --query 'taskDefinitionArns[]' --output text)
container_query="taskDefinition.containerDefinitions[?name=='$container'] | [0].[image, logConfiguration.options.\"awslogs-group\", logConfiguration.options.\"awslogs-stream-prefix\"]"
newest=""
chosen=""
for arn in $revisions; do
  # --family-prefix matches by prefix; keep this family's own revisions.
  case "${arn##*:task-definition/}" in
    "$family":*) ;;
    *) continue ;;
  esac
  [ -n "$newest" ] || newest=${arn##*/}
  details=$(aws_ ecs describe-task-definition --task-definition "$arn" --output text --query "$container_query")
  IFS=$'\t' read -r image log_group log_prefix <<<"$details"
  case "$image" in
    None | '' | *":$PLACEHOLDER_TAG") continue ;;
  esac
  if [ -n "$want_image" ] && [ "$image" != "$want_image" ]; then continue; fi
  chosen=${arn##*/}
  break
done
if [ -z "$newest" ]; then
  fail "$family has no active revision. Run infra.yml with apply first."
fi
if [ -z "$chosen" ] && [ -n "$want_image" ]; then
  fail "no recent revision of $family names the image the worker runs (${want_image##*/}): a full deploy-app.yml registers one."
fi
if [ -z "$chosen" ]; then
  fail "no revision of $family names a deployed image yet: run deploy-app.yml first (with bootstrap_db on a new database)."
fi
say "$chosen, image ${image##*/}"
if [ "$chosen" != "$newest" ] && [ -n "$want_image" ]; then
  say "note: $chosen, not the newest ($newest), names the image the worker runs."
elif [ "$chosen" != "$newest" ]; then
  say "note: $newest is Terraform's latest and names no pushed image, so $chosen, the last one the deploy workflow registered, runs instead. A Terraform change to this task definition reaches a run after the next deploy-app.yml."
fi

# --- run it -----------------------------------------------------------------
quote_list() { printf '"%s"' "${1//,/\",\"}"; }
network=$(printf '{"awsvpcConfiguration":{"subnets":[%s],"securityGroups":[%s],"assignPublicIp":"DISABLED"}}' \
  "$(quote_list "$subnets")" "$(quote_list "$groups")")
override_args=()
if [ -n "$overrides" ]; then override_args=(--overrides "$overrides"); fi
started=$(aws_ ecs run-task --cluster "$CLUSTER" --task-definition "$chosen" --launch-type FARGATE \
  --count 1 --network-configuration "$network" --started-by run-task-sh "${override_args[@]}" --output text \
  --query '[tasks[0].taskArn, failures[0].reason, failures[0].detail]')
IFS=$'\t' read -r task failure_reason failure_detail <<<"$started"
if [ -z "$task" ] || [ "$task" = None ]; then
  fail "ECS did not start $chosen: $failure_reason ${failure_detail#None}"
fi
task_id=${task##*/}
say "task $task_id started on $CLUSTER"

deadline=$(($(date +%s) + TIMEOUT_MINUTES * 60))
last=""
while :; do
  # A read that fails is tried again on the next round.
  status=$(aws_ ecs describe-tasks --cluster "$CLUSTER" --tasks "$task" \
    --query 'tasks[0].lastStatus' --output text 2>/dev/null) || status=unreadable
  if [ "$status" != "$last" ]; then
    say "task $task_id: $status"
    last=$status
  fi
  [ "$status" = STOPPED ] && break
  if [ "$(date +%s)" -ge "$deadline" ]; then
    fail "task $task_id was still $status after $TIMEOUT_MINUTES minutes, and is still running. Stop it with: aws ecs stop-task --region $REGION --cluster $CLUSTER --task $task_id"
  fi
  sleep 10
done

# --- what ECS says about it ---------------------------------------------------
result=$(aws_ ecs describe-tasks --cluster "$CLUSTER" --tasks "$task" --output text \
  --query "tasks[0].[stopCode, stoppedReason, containers[?name=='$container'] | [0].exitCode, containers[?name=='$container'] | [0].reason]")
IFS=$'\t' read -r stop_code stopped_reason exit_code container_reason <<<"$result"
say "stopped ($stop_code): $stopped_reason"
if [ "$container_reason" != None ] && [ -n "$container_reason" ]; then
  say "container $container: exit code $exit_code, $container_reason"
else
  say "container $container: exit code $exit_code"
fi
say "its output is in CloudWatch Logs, group $log_group, stream $log_prefix/$container/$task_id (not shown here: it can carry data)"
if [ "$exit_code" != 0 ]; then
  fail "$1 failed"
fi
say "$1 succeeded"
if [ "$1" = patient-export ]; then
  say "the bundle is s3://$EXPORT_BUCKET/$export_key (it is deleted after 7 days if nobody deletes it first)"
  say "download it here, then Actions > Download file:  aws s3 cp s3://$EXPORT_BUCKET/$export_key ."
  say "after the handover, delete both copies:  aws s3 rm s3://$EXPORT_BUCKET/$export_key && rm -f $export_key"
  say "then record the handover on the clinic's care page in the ops console"
fi
