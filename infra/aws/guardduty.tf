# GuardDuty's foundational threat detection (CloudTrail management events, VPC
# flow and DNS logs, analysed by AWS without us storing them). Findings are in
# the console; routing them to the alarm topic is a later addition.
#
# Fargate Runtime Monitoring is not turned on here. If it is, with agent
# management, ECS injects a GuardDuty sidecar pulled through the execution
# role, whose ECR permissions are scoped to our three repositories (iam.tf).
#
# A region holds one detector. One already created in the console makes this
# apply fail with "detector already exists": import it into this address
# instead of creating a second one.

resource "aws_guardduty_detector" "main" {
  count = var.enable_guardduty ? 1 : 0

  enable = true

  #checkov:skip=CKV2_AWS_3:That check is about Organization-wide GuardDuty; this account must not join an Organization (an Organization's BAA would control instead).
}
