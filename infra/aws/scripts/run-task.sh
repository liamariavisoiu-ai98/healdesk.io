#!/usr/bin/env bash
# Run one of apps/app's one-off tasks on the cluster, wait for it, print its
# log and exit with its exit code.
#
#   infra/aws/scripts/run-task.sh db-admin       once, before the first migration
#   infra/aws/scripts/run-task.sh migrate        every release, before the services move
#   infra/aws/scripts/run-task.sh queue-install  once, and after a pg-boss upgrade
#
# Needs the AWS CLI signed in to the HIPAA account and Terraform initialised
# in infra/aws. The tasks run in the private subnets with the admin security
# group; none of them is reachable from outside.
set -euo pipefail

task="${1:-}"
case "$task" in
  db-admin | migrate | queue-install) ;;
  *)
    echo "usage: $0 db-admin|migrate|queue-install" >&2
    exit 2
    ;;
esac

tf_dir="$(cd "$(dirname "$0")/.." && pwd)"
outputs="$(terraform -chdir="$tf_dir" output -json)"
# Evaluates one Python expression over the outputs, bound to `o`.
read_output() { python3 -c "import json,sys; o = {k: v['value'] for k, v in json.load(sys.stdin).items()}; print(eval(sys.argv[1]))" "$1" <<<"$outputs"; }

cluster="$(read_output "o['cluster_name']")"
family="$(read_output "o['one_off_tasks']['$task']")"
subnets="$(read_output "','.join(o['task_network']['subnets'])")"
groups="$(read_output "','.join(o['task_network']['security_groups'])")"
log_group="$(read_output "o['admin_log_group']")"
region="us-east-1"

echo "starting $family on $cluster"
task_arn="$(aws ecs run-task --region "$region" \
  --cluster "$cluster" \
  --task-definition "$family" \
  --launch-type FARGATE \
  --count 1 \
  --network-configuration "awsvpcConfiguration={subnets=[$subnets],securityGroups=[$groups],assignPublicIp=DISABLED}" \
  --query 'tasks[0].taskArn' --output text)"

if [[ -z "$task_arn" || "$task_arn" == "None" ]]; then
  echo "ECS did not start the task" >&2
  exit 1
fi

echo "waiting for ${task_arn##*/} to stop"
aws ecs wait tasks-stopped --region "$region" --cluster "$cluster" --tasks "$task_arn"

read -r exit_code stop_reason < <(aws ecs describe-tasks --region "$region" \
  --cluster "$cluster" --tasks "$task_arn" \
  --query 'tasks[0].[containers[0].exitCode, stoppedReason]' --output text)

echo "--- log"
aws logs tail "$log_group" --region "$region" \
  --log-stream-name-prefix "admin/$task/${task_arn##*/}" --since 1h || true

echo "--- $task exited with $exit_code ($stop_reason)"
[[ "$exit_code" == "0" ]]
