# Every CloudWatch log group in the account is created here, before anything
# writes to it, with our KMS key and no retention limit: "Never expire" is the
# maximum retention the AWS addendum section 4.2(c) asks for, and the account
# record says it supersedes any shorter one. A group AWS creates by itself
# (RDS log exports, Container Insights, flow logs) would get neither the key
# nor the retention, so each is pre-created by name.
#
# What reaches these groups is the app's allowlisted, scrubbing logger
# (lib/log.ts), Next's own error output, nginx's logs and the Postgres engine
# log with terse verbosity. skip_destroy keeps a group, and its logs, if it is
# ever renamed or removed from this file: the audit trail outlives the config.

resource "aws_cloudwatch_log_group" "app" {
  for_each = toset(["web", "worker", "migrate", "db-bootstrap", "destroy-due", "patient-export", "erase-person", "amend-contact", "reapply-erasures", "tls-proxy"])

  name              = "${local.log_prefix}/${each.key}"
  kms_key_id        = aws_kms_key.main.arn
  retention_in_days = 0
  skip_destroy      = true
}

# RDS exports the postgresql log into this exact name; it must exist first or
# RDS creates it without our key.
resource "aws_cloudwatch_log_group" "rds_postgresql" {
  name              = "/aws/rds/instance/${local.name}/postgresql"
  kms_key_id        = aws_kms_key.main.arn
  retention_in_days = 0
  skip_destroy      = true
}

resource "aws_cloudwatch_log_group" "container_insights" {
  count = var.container_insights ? 1 : 0

  name              = "/aws/ecs/containerinsights/${local.name}/performance"
  kms_key_id        = aws_kms_key.main.arn
  retention_in_days = 0
  skip_destroy      = true
}

resource "aws_cloudwatch_log_group" "flow_logs" {
  count = var.enable_flow_logs ? 1 : 0

  name              = "${local.log_prefix}/vpc-flow-logs"
  kms_key_id        = aws_kms_key.main.arn
  retention_in_days = 0
  skip_destroy      = true
}
