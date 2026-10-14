#!/usr/bin/env bash
# =============================================================================
# plan-guard.sh: refuse a saved Terraform plan that deletes what this host
# keeps, before it is applied.
#
#   terraform show -json tfplan >plan.json
#   bash scripts/plan-guard.sh plan.json            # infra.yml, host.yml's active applies
#   bash scripts/plan-guard.sh plan.json --release  # host.yml's first standby apply
#   bash scripts/plan-guard.sh plan.json --standby  # host.yml's standby removal
#
# Why it exists. The database used to carry prevent_destroy, which makes any
# plan that would delete or replace it fail. Standby has to remove it, and
# prevent_destroy is a literal that cannot depend on a variable, so rds.tf
# drops it and this guard does its job on every plan the workflows apply
# (README, "Standby"). The others keep prevent_destroy; the guard checks them
# too, so a later edit that removed one is still caught here.
#
# Every plan, refused if it deletes or replaces (replacement is a delete):
#   - the KMS key, every SSM parameter but the retired ones
#     (aws_ssm_parameter.retired, ssm.tf), the image repositories and the S3
#     buckets: the keys, secrets, images and records standby keeps;
#   - the RDS instance, except as below. A replacement is refused always:
#     it would be a new, empty database under the same name.
#
# With --release (host.yml's first standby apply, targeted at the database
# and the load balancer), additionally: nothing may be created, deleted or
# replaced at all. That apply only lifts two protections and names a
# snapshot; a create there would mean a resource the state still lists has
# gone from AWS, and Terraform was about to make it again.
#
# With --standby (host.yml's second standby apply), additionally:
#   - the RDS instance may be deleted (it takes the final snapshot the first
#     apply recorded), never replaced;
#   - every other plain deletion must be one standby makes: the load balancer
#     and its listeners, rules and target groups, the NAT instance or gateways
#     with their addresses, the ECS services, the alarms, the two CNAMEs to the
#     load balancer, the db-bootstrap task definition, the WAF, the SES events
#     subscription, and the retired parameters. Anything else stops the run.
#     A replacement outside that list (a task definition a merged commit
#     changed, say) is a change the apply carries with it, as infra.yml's
#     would, and passes unless it is one of the kept resources above.
#
# Reads only addresses, types and actions from the plan, and prints nothing
# else of it: the JSON form of a plan holds every value in clear, sensitive
# ones included, so the caller deletes it once this has run, and never
# uploads it.
#
# Exit status: 0 the plan may be applied; 1 it may not (each reason on an
# ::error:: line); 2 a usage error.
# =============================================================================
set -euo pipefail

usage() {
  echo "usage: plan-guard.sh PLAN_JSON [--release | --standby]" >&2
  exit 2
}

if [ "$#" -lt 1 ] || [ "$#" -gt 2 ]; then
  usage
fi
plan_json=$1
standby=false
release=false
if [ "$#" = 2 ]; then
  case "$2" in
    --standby) standby=true ;;
    --release) release=true ;;
    *) usage ;;
  esac
fi
[ -r "$plan_json" ] || {
  echo "plan-guard: cannot read $plan_json" >&2
  exit 2
}

# One line per managed resource instance the plan deletes:
# "<address> <type> <replace|delete>". Data sources only read.
deletions=$(jq -r '
  [.resource_changes // [] | .[]
   | select(.mode == "managed" and (.change.actions | index("delete")))
   | "\(.address) \(.type) \(if (.change.actions | index("create")) then "replace" else "delete" end)"]
  | .[]' "$plan_json")

failed=0
refuse() {
  echo "::error::plan-guard: $1"
  failed=1
}

# --release: only updates (and the no-op moves that count = 0 or 1 adds).
if [ "$release" = true ]; then
  while read -r address actions; do
    [ -n "$address" ] || continue
    refuse "$address would be $actions, and standby's first apply only lifts the protections of the database and the load balancer and names the final snapshot. If the state lists something AWS no longer has, find out why before going on."
  done < <(jq -r '
    .resource_changes // [] | .[]
    | select(.mode == "managed")
    | select((.change.actions - ["no-op", "update", "read"]) | length > 0)
    | "\(.address) \(.change.actions | join("+"))"' "$plan_json")
fi

# What standby removes (variables.tf), by address.
standby_removes() {
  case "$1" in
    aws_db_instance.main | aws_db_instance.main\[*) return 0 ;;
    aws_lb.main | aws_lb.main\[*) return 0 ;;
    aws_lb_listener.* | aws_lb_listener_rule.* | aws_lb_target_group.*) return 0 ;;
    aws_instance.nat\[*) return 0 ;;
    aws_nat_gateway.main\[* | aws_eip.nat\[*) return 0 ;;
    aws_ecs_service.*) return 0 ;;
    aws_cloudwatch_metric_alarm.*) return 0 ;;
    cloudflare_dns_record.app | cloudflare_dns_record.app\[* | cloudflare_dns_record.internal | cloudflare_dns_record.internal\[*) return 0 ;;
    aws_ecs_task_definition.db_bootstrap | aws_ecs_task_definition.db_bootstrap\[*) return 0 ;;
    aws_wafv2_web_acl.main\[* | aws_wafv2_web_acl_association.alb\[*) return 0 ;;
    aws_sns_topic_subscription.ses_events_app\[*) return 0 ;;
    aws_ssm_parameter.retired\[*) return 0 ;;
  esac
  return 1
}

count=0
while read -r address type action; do
  [ -n "$address" ] || continue
  count=$((count + 1))
  echo "plan-guard: $action $address"

  case "$type" in
    aws_kms_key)
      refuse "$address would be ${action}d: the product key is never replaced (kms.tf)."
      continue
      ;;
    aws_ssm_parameter)
      case "$address" in
        aws_ssm_parameter.retired\[*) ;;
        *)
          refuse "$address would be ${action}d, and its value with it: no parameter is deleted but a retired one (ssm.tf)."
          continue
          ;;
      esac
      ;;
    aws_ecr_repository)
      refuse "$address would be ${action}d with its images (ecr.tf)."
      continue
      ;;
    aws_s3_bucket)
      refuse "$address would be ${action}d (cloudtrail.tf, config.tf, exports.tf, storage.tf)."
      continue
      ;;
    aws_db_instance)
      if [ "$action" = replace ]; then
        refuse "$address would be replaced: a new, empty database under the same name. Find the argument that forces it (an engine downgrade, a snapshot_identifier change) and fix the configuration instead."
        continue
      fi
      if [ "$standby" != true ]; then
        refuse "$address would be deleted. Only host.yml's standby deletes the database, after recording its final snapshot; if a standby stopped half-way, run host.yml with standby again (or active to bring the host back)."
        continue
      fi
      ;;
  esac

  if [ "$standby" = true ] && [ "$action" = delete ] && ! standby_removes "$address"; then
    refuse "$address would be deleted, and standby removes only the database, the load balancer, the NAT, the services, their alarms, the two CNAMEs, the db-bootstrap task definition, the WAF and the SES subscription (variables.tf)."
  fi
done <<<"$deletions"

if [ "$failed" = 1 ]; then
  echo "::error::plan-guard: nothing was applied."
  exit 1
fi
mode_note=""
[ "$standby" = false ] || mode_note=" for standby"
[ "$release" = false ] || mode_note=" for standby's first apply"
echo "plan-guard: $count deletion(s), all allowed$mode_note."
