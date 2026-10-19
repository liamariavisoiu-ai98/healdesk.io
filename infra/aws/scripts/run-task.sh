#!/usr/bin/env bash
# =============================================================================
# Run one of apps/app's one-off tasks from a terminal, outside GitHub Actions:
# AWS CloudShell in us-east-1, signed in to the BAA account (865780386982).
#
#   bash infra/aws/scripts/run-task.sh migrate        migrations, then queue:install
#   bash infra/aws/scripts/run-task.sh db-bootstrap   init-secrets, then the two roles
#   bash infra/aws/scripts/run-task.sh destroy-due    after a restore: destroy every clinic due
#   bash infra/aws/scripts/run-task.sh reapply-erasures   after a restore: delete again every person deleted
#   bash infra/aws/scripts/run-task.sh patient-export <clinic id>
#                                                     a leaving clinic's return bundle
#   bash infra/aws/scripts/run-task.sh patient-export <clinic id> <contact id> <who asked>
#                                                     one person's bundle (a patient-rights request)
#   bash infra/aws/scripts/run-task.sh erase-person <clinic id> <contact id> <who asked> <you@healdesk.io> [received at]
#   bash infra/aws/scripts/run-task.sh amend-contact <clinic id> <contact id> <fields to clear> <who asked> <you@healdesk.io>
#                                                     a person's deletion or correction request
#   bash infra/aws/scripts/run-task.sh patient-request <clinic id> <kind> <you@healdesk.io> [received at] [contact id]
#                                                     a patient's own request, passed to the practice (L32)
#   bash infra/aws/scripts/run-task.sh incident-affected <clinic id> <incident id> <contact ids> <you@healdesk.io> [add|remove]
#                                                     who an incident affected, for the practice's page (L29)
#   bash infra/aws/scripts/run-task.sh demo-clinic "<fictional practice>" "<your name>" <you@healdesk.io>
#                                                     healdesk's one demo clinic (scripts/demo-clinic.ts)
#   bash infra/aws/scripts/run-task.sh channels-link <clinic id> [meta|whatsapp] [days]
#                                                     a clinic's single-use Meta connect links
#
# It runs the family's newest revision that names a deployed image, never
# Terraform's own revisions: those name the image tag terraform-placeholder,
# which nothing pushes, so a task of one could only fail to pull. The deploy
# workflow registers the others, with the commit's image. destroy-due and
# patient-export run the newest revision naming the image the worker runs
# (its own service's, or the web task's "worker" container when the worker
# shares the web task), so after a rollback they run the code that is live, not the code
# rolled back from; destroy-due exits non-zero while any clinic is still due
# (docs/handover.md, "Restoring"). The network is the web service's (its
# private subnets and security group, the one the database admits, no public
# address), read at run time rather than copied in.
#
# run-task arguments are recorded by CloudTrail, so commands and secrets live
# in the task definition and nothing is overridden, with one exception:
# patient-export takes environment overrides: the clinic's id, who asked
# (always "practice" for a whole clinic's bundle, and nothing typed reaches
# the audit row) and the object key, clinic-<id>-<UTC time>.json; or, for one
# person, also the contact's id, who asked from the closed three, and the key
# clinic-<id>-patient-<UTC time>.json. None is secret or a patient's. The two
# patient-rights scripts take theirs the same way (apps/app/scripts/
# ops-erase-person.ts, ops-amend-contact.ts): the clinic's and the contact's
# ids, who asked (practice, person_via_practice or representative_via_practice),
# the operator's work address, and for erasure the day the request came, for an
# amendment the fields to clear (fullName, phone, email). Never a phone number,
# an address or a name: the person is named by the contact's id, found in the
# ops console first. patient-request (apps/app/scripts/ops-patient-request.ts)
# takes the clinic's id, what was asked (access, amendment, accounting,
# deletion or other), the operator's work address and, optionally, the day the
# request came and a contact's id: nothing of the patient's. incident-affected
# (apps/app/scripts/ops-incident-affected.ts) takes the clinic's and the
# incident's ids, the contacts' ids comma-separated, the operator's work
# address and add or remove: ids only, at most 150 contacts a run, because
# ECS takes no more than 8,192 characters of overrides. demo-clinic takes the fictional practice's name, the
# operator's name and the operator's own address (the script refuses any
# other), and channels-link the clinic's id, which channel and how many days
# the link lasts: nothing of a patient's, and no secret. The bundle lands in the export bucket (infra/aws/exports.tf);
# on success this prints its key and the commands to download it and, after
# the handover, delete it.
#
# It waits for the task to stop, then prints ECS's account of it (the stop
# code, the stopped reason, the container's exit code and reason) and exits 0
# only if the container exited 0. It never prints the task's own output:
# migrations can quote SQL and row values, so the log stays in CloudWatch,
# under the product key, and only its group and stream are named here. That
# holds for channels-link too, whose output is the link itself: a working,
# single-use credential to connect a clinic's Meta accounts. For it and
# demo-clinic this prints the command that reads the stream, to run when
# you want it.
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
  echo "usage: $0 migrate|db-bootstrap|destroy-due|reapply-erasures" >&2
  echo "       $0 patient-export <clinic id> [<contact id> <who asked>]" >&2
  echo "       $0 erase-person <clinic id> <contact id> <who asked> <you@healdesk.io> [received at, e.g. 2026-10-12]" >&2
  echo "       $0 amend-contact <clinic id> <contact id> <fields to clear, e.g. phone,email> <who asked> <you@healdesk.io>" >&2
  echo "       who asked: practice | person_via_practice | representative_via_practice" >&2
  echo "       $0 patient-request <clinic id> <access|amendment|accounting|deletion|other> <you@healdesk.io> [received at, e.g. 2026-10-12] [contact id]" >&2
  echo "       $0 incident-affected <clinic id> <incident id> <contact ids, comma-separated, at most 150> <you@healdesk.io> [add|remove]" >&2
  echo "       $0 demo-clinic \"<fictional practice>\" \"<your name>\" <you@healdesk.io>" >&2
  echo "       $0 channels-link <clinic id> [meta|whatsapp] [days the link lasts, 1 to 30]" >&2
  exit 64
}

EXPORT_BUCKET=healdesk-production-exports-$ACCOUNT
[ "$#" -ge 1 ] || usage
case "$1" in
  patient-export) [ "$#" -eq 2 ] || [ "$#" -eq 4 ] || usage ;;
  erase-person) [ "$#" -eq 5 ] || [ "$#" -eq 6 ] || usage ;;
  amend-contact) [ "$#" -eq 6 ] || usage ;;
  patient-request) [ "$#" -ge 4 ] && [ "$#" -le 6 ] || usage ;;
  incident-affected) [ "$#" -eq 5 ] || [ "$#" -eq 6 ] || usage ;;
  demo-clinic) [ "$#" -eq 4 ] || usage ;;
  channels-link) [ "$#" -ge 2 ] && [ "$#" -le 4 ] || usage ;;
  *) [ "$#" -eq 1 ] || usage ;;
esac
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
  reapply-erasures)
    family=healdesk-production-reapply-erasures
    container=app
    ;;
  patient-export)
    family=healdesk-production-patient-export
    container=app
    ;;
  erase-person)
    family=healdesk-production-erase-person
    container=app
    ;;
  amend-contact)
    family=healdesk-production-amend-contact
    container=app
    ;;
  patient-request)
    family=healdesk-production-patient-request
    container=app
    ;;
  incident-affected)
    family=healdesk-production-incident-affected
    container=app
    ;;
  demo-clinic)
    family=healdesk-production-demo-clinic
    container=app
    ;;
  channels-link)
    family=healdesk-production-channels-link
    container=app
    ;;
  *) usage ;;
esac

is_uuid() { printf '%s' "$1" | grep -Eqi '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'; }
lower() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }
check_requester() {
  case "$1" in
    practice | person_via_practice | representative_via_practice) ;;
    *) fail "who asked is one of practice, person_via_practice, representative_via_practice: chosen, never typed" ;;
  esac
}
check_operator() {
  if [ "${#1}" -gt 254 ] || ! printf '%s' "$1" | grep -Eq '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$'; then
    fail "the operator is your healdesk work address (it names every row the script writes)"
  fi
}

# patient-export's overrides, checked before any AWS call: the whole clinic
# (who asked is always the practice), or one person named by a contact's id
# (a patient-rights request) with who asked from the closed three, under a
# clinic-<id>-patient-<time>.json key, never the contact's id.
overrides=""
export_key=""
if [ "$1" = patient-export ]; then
  is_uuid "$2" || fail "the clinic id must be the clinic's uuid (the ops console shows it)"
  clinic_id=$(lower "$2")
  stamp=$(date -u +%Y%m%dT%H%M%SZ)
  if [ "$#" -eq 4 ]; then
    is_uuid "$3" || fail "the contact id must be the contact's uuid; until the M5 portal nothing on AWS turns a number, an address or a name into one (docs/handover.md, \"Deletion requests\"), and a person is never named by any of those here"
    check_requester "$4"
    export_key="clinic-$clinic_id-patient-$stamp.json"
    overrides=$(printf '{"containerOverrides":[{"name":"app","environment":[{"name":"HEALDESK_EXPORT_CLINIC_ID","value":"%s"},{"name":"HEALDESK_EXPORT_CONTACT_ID","value":"%s"},{"name":"HEALDESK_EXPORT_REQUESTED_BY","value":"%s"},{"name":"HEALDESK_EXPORT_KEY","value":"%s"}]}]}' \
      "$clinic_id" "$(lower "$3")" "$4" "$export_key")
  else
    export_key="clinic-$clinic_id-$stamp.json"
    overrides=$(printf '{"containerOverrides":[{"name":"app","environment":[{"name":"HEALDESK_EXPORT_CLINIC_ID","value":"%s"},{"name":"HEALDESK_EXPORT_REQUESTED_BY","value":"%s"},{"name":"HEALDESK_EXPORT_KEY","value":"%s"}]}]}' \
      "$clinic_id" practice "$export_key")
  fi
fi

# The patient-rights scripts' overrides, checked the same way. Every value is
# drawn from a character set that needs no quoting in JSON.
if [ "$1" = erase-person ] || [ "$1" = amend-contact ]; then
  is_uuid "$2" || fail "the clinic id must be the clinic's uuid (the ops console shows it)"
  is_uuid "$3" || fail "the contact id must be the contact's uuid; until the M5 portal nothing on AWS turns a number, an address or a name into one (docs/handover.md, \"Deletion requests\"), and a person is never named by any of those here"
  clinic_id=$(lower "$2")
  contact_id=$(lower "$3")
fi
if [ "$1" = erase-person ]; then
  check_requester "$4"
  check_operator "$5"
  received=""
  if [ "$#" -eq 6 ]; then
    if ! printf '%s' "$6" | grep -Eq '^[0-9]{4}-[0-9]{2}-[0-9]{2}(T[0-9]{2}:[0-9]{2}(:[0-9]{2}(\.[0-9]{1,3})?)?(Z|[+-][0-9]{2}:[0-9]{2}))?$'; then
      fail "received at is an ISO date or time, e.g. 2026-10-12 or 2026-10-12T15:30:00Z"
    fi
    received=$(printf ',{"name":"HEALDESK_ERASURE_RECEIVED_AT","value":"%s"}' "$6")
  fi
  overrides=$(printf '{"containerOverrides":[{"name":"app","environment":[{"name":"HEALDESK_ERASURE_CLINIC_ID","value":"%s"},{"name":"HEALDESK_ERASURE_CONTACT_ID","value":"%s"},{"name":"HEALDESK_ERASURE_REQUESTED_BY","value":"%s"},{"name":"HEALDESK_OPS_OPERATOR","value":"%s"}%s]}]}' \
    "$clinic_id" "$contact_id" "$4" "$(lower "$5")" "$received")
fi
if [ "$1" = amend-contact ]; then
  if ! printf '%s' "$4" | grep -Eq '^(fullName|phone|email)(,(fullName|phone|email))*$'; then
    fail "the fields to clear are a comma list of fullName, phone and email; new values wait for the portal"
  fi
  check_requester "$5"
  check_operator "$6"
  overrides=$(printf '{"containerOverrides":[{"name":"app","environment":[{"name":"HEALDESK_AMEND_CLINIC_ID","value":"%s"},{"name":"HEALDESK_AMEND_CONTACT_ID","value":"%s"},{"name":"HEALDESK_AMEND_CLEAR","value":"%s"},{"name":"HEALDESK_AMEND_REQUESTED_BY","value":"%s"},{"name":"HEALDESK_OPS_OPERATOR","value":"%s"}]}]}' \
    "$clinic_id" "$contact_id" "$4" "$5" "$(lower "$6")")
fi
# A patient's own request (L32): the clinic, what was asked from the closed
# five, the operator, and after them, each at most once and in either order,
# when it reached us (an ISO date or time) and the contact it is about, by
# its uuid. Nothing of the patient's.
if [ "$1" = patient-request ]; then
  is_uuid "$2" || fail "the clinic id must be the clinic's uuid (the ops console shows it)"
  case "$3" in
    access | amendment | accounting | deletion | other) ;;
    *) fail "what was asked is one of access, amendment, accounting, deletion, other: chosen, never typed" ;;
  esac
  check_operator "$4"
  request_env=$(printf '{"name":"HEALDESK_PATIENT_REQUEST_CLINIC_ID","value":"%s"},{"name":"HEALDESK_PATIENT_REQUEST_KIND","value":"%s"},{"name":"HEALDESK_OPS_OPERATOR","value":"%s"}' \
    "$(lower "$2")" "$3" "$(lower "$4")")
  received=""
  contact=""
  shift_args=("${@:5}")
  for extra in ${shift_args[@]+"${shift_args[@]}"}; do
    if [ -z "$contact" ] && is_uuid "$extra"; then
      contact=$(lower "$extra")
      request_env="$request_env$(printf ',{"name":"HEALDESK_PATIENT_REQUEST_CONTACT_ID","value":"%s"}' "$contact")"
    elif [ -z "$received" ] && printf '%s' "$extra" | grep -Eq '^[0-9]{4}-[0-9]{2}-[0-9]{2}(T[0-9]{2}:[0-9]{2}(:[0-9]{2}(\.[0-9]{1,3})?)?(Z|[+-][0-9]{2}:[0-9]{2}))?$'; then
      received=$extra
      request_env="$request_env$(printf ',{"name":"HEALDESK_PATIENT_REQUEST_RECEIVED_AT","value":"%s"}' "$received")"
    else
      fail "after the operator: when the request reached us (an ISO date or time, e.g. 2026-10-12) and the contact's uuid, each at most once; until the M5 portal nothing on AWS turns a number, an address or a name into one, and a person is never named by any of those here"
    fi
  done
  overrides=$(printf '{"containerOverrides":[{"name":"app","environment":[%s]}]}' "$request_env")
fi
# Who an incident affected (L29's list, read by the practice behind its
# passkey): the clinic, the incident (from /admin/incidents), the contacts by
# their uuids, the operator, and add (the default) or remove for a contact
# named in error. Ids only; the script itself refuses anything else.
if [ "$1" = incident-affected ]; then
  is_uuid "$2" || fail "the clinic id must be the clinic's uuid (the ops console shows it)"
  is_uuid "$3" || fail "the incident id must be the incident's uuid (/admin/incidents shows it)"
  contacts=$(lower "$4")
  count=0
  IFS=',' read -r -a contact_list <<<"$contacts"
  for contact in ${contact_list[@]+"${contact_list[@]}"}; do
    is_uuid "$contact" || fail "the contacts are their uuids, comma-separated with no spaces; never a number, an address or a name"
    count=$((count + 1))
  done
  [ "$count" -ge 1 ] || fail "name at least one contact, by its uuid"
  [ "$count" -le 150 ] || fail "at most 150 contacts a run (ECS takes 8,192 characters of overrides); run it again for the rest"
  check_operator "$5"
  action=${6:-add}
  case "$action" in
    add | remove) ;;
    *) fail "the last argument is add (the default) or remove, for a contact named in error" ;;
  esac
  overrides=$(printf '{"containerOverrides":[{"name":"app","environment":[{"name":"HEALDESK_INCIDENT_CLINIC_ID","value":"%s"},{"name":"HEALDESK_INCIDENT_ID","value":"%s"},{"name":"HEALDESK_INCIDENT_CONTACT_IDS","value":"%s"},{"name":"HEALDESK_INCIDENT_ACTION","value":"%s"},{"name":"HEALDESK_OPS_OPERATOR","value":"%s"}]}]}' \
    "$(lower "$2")" "$(lower "$3")" "$contacts" "$action" "$(lower "$5")")
fi
# A name for the demo clinic or its signatory: letters, digits, spaces and
# the punctuation a practice's name has, nothing JSON would need escaped.
check_name() {
  if [ "${#1}" -lt 2 ] || [ "${#1}" -gt 100 ] || ! printf '%s' "$1" | grep -Eq "^[A-Za-z0-9 .,&'-]+$"; then
    fail "$2 is 2 to 100 letters, digits, spaces and . , & ' -"
  fi
}
if [ "$1" = demo-clinic ]; then
  check_name "$2" "the practice's name"
  check_name "$3" "your name"
  check_operator "$4"
  overrides=$(printf '{"containerOverrides":[{"name":"app","environment":[{"name":"HEALDESK_DEMO_NAME","value":"%s"},{"name":"HEALDESK_DEMO_OPERATOR_NAME","value":"%s"},{"name":"HEALDESK_OPS_OPERATOR","value":"%s"}]}]}' \
    "$2" "$3" "$(lower "$4")")
fi
if [ "$1" = channels-link ]; then
  is_uuid "$2" || fail "the clinic id must be the clinic's uuid (demo-clinic's log, or the ops console, shows it)"
  link_env=$(printf '{"name":"HEALDESK_LINK_CLINIC_ID","value":"%s"}' "$(lower "$2")")
  shift_args=("${@:3}")
  for extra in ${shift_args[@]+"${shift_args[@]}"}; do
    case "$extra" in
      meta | whatsapp) link_env="$link_env$(printf ',{"name":"HEALDESK_LINK_ONLY","value":"%s"}' "$extra")" ;;
      [1-9] | [12][0-9] | 30) link_env="$link_env$(printf ',{"name":"HEALDESK_LINK_DAYS","value":"%s"}' "$extra")" ;;
      *) fail "after the clinic id: meta or whatsapp, and the days the link lasts, 1 to 30 (got '$extra')" ;;
    esac
  done
  overrides=$(printf '{"containerOverrides":[{"name":"app","environment":[%s]}]}' "$link_env")
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
  fail "$WEB_SERVICE is not an active service of $CLUSTER (got: $service_status). The host is in standby or was never applied: turn it on with host.yml (mode active)."
fi
if [ "$public_ip" != DISABLED ] || [ -z "$subnets" ] || [ "$subnets" = None ] || [ -z "$groups" ] || [ "$groups" = None ]; then
  fail "$WEB_SERVICE has no private network to lend (assignPublicIp $public_ip, subnets '$subnets', security groups '$groups')"
fi

# --- destroy-due: the image the worker runs ----------------------------------
want_image=""
if [ "$1" != migrate ] && [ "$1" != db-bootstrap ]; then
  # The worker's own service when it has one (worker_placement = "separate");
  # otherwise it is the web task's "worker" container (infra/aws/ecs.tf).
  worker_td=$(aws_ ecs describe-services --cluster "$CLUSTER" --services "$WORKER_SERVICE" \
    --query "services[?status=='ACTIVE'] | [0].taskDefinition" --output text)
  worker_container=app
  worker_where=$WORKER_SERVICE
  case "$worker_td" in
    '' | None)
      worker_td=$(aws_ ecs describe-services --cluster "$CLUSTER" --services "$WEB_SERVICE" \
        --query 'services[0].taskDefinition' --output text)
      worker_container=worker
      worker_where="$WEB_SERVICE (its worker container)"
      ;;
  esac
  case "$worker_td" in
    '' | None) fail "neither $WORKER_SERVICE nor $WEB_SERVICE has a task definition. Run deploy-app.yml first." ;;
  esac
  want_image=$(aws_ ecs describe-task-definition --task-definition "$worker_td" --output text \
    --query "taskDefinition.containerDefinitions[?name=='$worker_container'] | [0].image")
  case "$want_image" in
    None | '' | *":$PLACEHOLDER_TAG") fail "$worker_where runs no deployed worker image yet. Run deploy-app.yml first." ;;
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
  say "the bundle is s3://$EXPORT_BUCKET/$export_key: download it now (S3 deletes it within two days if nobody deletes it first)"
  say "download it here, then Actions > Download file:  aws s3 cp s3://$EXPORT_BUCKET/$export_key ."
  say "after the handover, delete both copies:  aws s3 rm s3://$EXPORT_BUCKET/$export_key && rm -f $export_key"
  say "then record the handover on the clinic's care page in the ops console"
fi
if [ "$1" = erase-person ] || [ "$1" = amend-contact ]; then
  say "its result (the request id, counts and any deadline: ids and numbers only) is in that log stream"
fi
if [ "$1" = incident-affected ]; then
  say "its result (how many were added or removed, and how many are on the list now: counts only) is in that log stream"
fi
if [ "$1" = patient-request ]; then
  say "its result (the request's id, the day the practice is asked to mark it received by, and what is left to do by hand) is in that log stream"
fi
if [ "$1" = demo-clinic ] || [ "$1" = channels-link ]; then
  if [ "$1" = demo-clinic ]; then
    say "the clinic's id and slug are in that log stream. Read it with:"
  else
    say "the link is in that log stream, and only there: it connects the clinic's Meta accounts once, so share it with no one but who will use it. Read it with:"
  fi
  printf "  aws logs get-log-events --region %s --log-group-name %s --log-stream-name %s --query 'events[].message' --output text\n" \
    "$REGION" "$log_group" "$log_prefix/$container/$task_id"
fi
