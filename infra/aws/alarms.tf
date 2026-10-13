# Alarms go to one SNS topic with an email subscription the owner confirms
# once from the inbox. Alarm messages carry metric names, counts and
# thresholds, never patient data, which is also why the topic is not
# encrypted: CloudWatch can publish to an encrypted topic only if the key
# policy grants it, and the AWS-managed SNS key cannot be used by alarms.

resource "aws_sns_topic" "alarms" {
  name = "${local.name}-alarms"

  #checkov:skip=CKV_AWS_26:Alarm notifications carry no PHI; encrypting with our key would need a key-policy grant for CloudWatch the contract keeps out, and the AWS-managed SNS key cannot be used by CloudWatch alarms.
}

resource "aws_sns_topic_subscription" "alarm_email" {
  topic_arn = aws_sns_topic.alarms.arn
  protocol  = "email"
  endpoint  = var.alarm_email
}

locals {
  alarm_actions = [aws_sns_topic.alarms.arn]
}

# ---------------------------------------------------------------------------
# Load balancer
# ---------------------------------------------------------------------------

resource "aws_cloudwatch_metric_alarm" "alb_5xx" {
  alarm_name          = "${local.name}-alb-5xx"
  alarm_description   = "The load balancer itself answered 5xx (502/503/504): web tasks unreachable, failing health checks or closing connections."
  namespace           = "AWS/ApplicationELB"
  metric_name         = "HTTPCode_ELB_5XX_Count"
  dimensions          = { LoadBalancer = aws_lb.main.arn_suffix }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 5
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
}

resource "aws_cloudwatch_metric_alarm" "target_5xx" {
  alarm_name          = "${local.name}-target-5xx"
  alarm_description   = "The web tier answered 5xx to five or more requests in five minutes."
  namespace           = "AWS/ApplicationELB"
  metric_name         = "HTTPCode_Target_5XX_Count"
  dimensions          = { LoadBalancer = aws_lb.main.arn_suffix, TargetGroup = aws_lb_target_group.web.arn_suffix }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 5
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
}

resource "aws_cloudwatch_metric_alarm" "unhealthy_hosts" {
  alarm_name          = "${local.name}-web-unhealthy-hosts"
  alarm_description   = "A registered web task has failed the load balancer's liveness check for three of the last five minutes."
  namespace           = "AWS/ApplicationELB"
  metric_name         = "UnHealthyHostCount"
  dimensions          = { LoadBalancer = aws_lb.main.arn_suffix, TargetGroup = aws_lb_target_group.web.arn_suffix }
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 5
  datapoints_to_alarm = 3
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
}

# ---------------------------------------------------------------------------
# Running below desired. Without Container Insights, ECS publishes no task
# count, so each service is watched through a metric that exists only while
# its tasks run: healthy targets for the web tier (which also catches tasks
# that run but fail their checks), and the worker's own CPU metric, which ECS
# stops sending when no worker task is running. Missing data counts as
# breaching, because silence is exactly the outage. Both are in alarm from the
# first apply until the deploy workflow first scales the services up.
#
# When the worker shares the web task (worker_placement = "shared") it has no
# service and no metric of its own. It is an essential container there, so a
# worker that stops takes its task down and web-below-desired fires instead;
# a worker that runs but has stalled shows as the heartbeat the external
# uptime check reads from /api/health (docs/on-call.md).
# ---------------------------------------------------------------------------

resource "aws_cloudwatch_metric_alarm" "web_running" {
  alarm_name          = "${local.name}-web-below-desired"
  alarm_description   = "Fewer healthy web tasks than web_desired (${var.web_desired}) for five minutes."
  namespace           = "AWS/ApplicationELB"
  metric_name         = "HealthyHostCount"
  dimensions          = { LoadBalancer = aws_lb.main.arn_suffix, TargetGroup = aws_lb_target_group.web.arn_suffix }
  statistic           = "Minimum"
  period              = 60
  evaluation_periods  = 5
  threshold           = var.web_desired
  comparison_operator = "LessThanThreshold"
  treat_missing_data  = "breaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
}

resource "aws_cloudwatch_metric_alarm" "worker_running" {
  count = local.worker_shared ? 0 : 1

  alarm_name          = "${local.name}-worker-below-desired"
  alarm_description   = "No worker task has been running for five minutes: no clock, no outbox, no billing jobs."
  namespace           = "AWS/ECS"
  metric_name         = "CPUUtilization"
  dimensions          = { ClusterName = aws_ecs_cluster.main.name, ServiceName = aws_ecs_service.worker[0].name }
  statistic           = "SampleCount"
  period              = 60
  evaluation_periods  = 5
  threshold           = 1
  comparison_operator = "LessThanThreshold"
  treat_missing_data  = "breaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
}

# ---------------------------------------------------------------------------
# Database
# ---------------------------------------------------------------------------

resource "aws_cloudwatch_metric_alarm" "rds_cpu" {
  alarm_name          = "${local.name}-rds-cpu"
  alarm_description   = "Database CPU above 80% for fifteen minutes (a t4g also starts paying for burst)."
  namespace           = "AWS/RDS"
  metric_name         = "CPUUtilization"
  dimensions          = { DBInstanceIdentifier = aws_db_instance.main.identifier }
  statistic           = "Average"
  period              = 300
  evaluation_periods  = 3
  threshold           = 80
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "missing"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
}

resource "aws_cloudwatch_metric_alarm" "rds_free_storage" {
  alarm_name          = "${local.name}-rds-free-storage"
  alarm_description   = "Database free storage below 10% of the allocated ${var.db_allocated_storage} GiB."
  namespace           = "AWS/RDS"
  metric_name         = "FreeStorageSpace"
  dimensions          = { DBInstanceIdentifier = aws_db_instance.main.identifier }
  statistic           = "Minimum"
  period              = 300
  evaluation_periods  = 1
  threshold           = floor(var.db_allocated_storage * 0.1 * 1073741824)
  comparison_operator = "LessThanThreshold"
  treat_missing_data  = "missing"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
}

# An eighth of the instance's memory: 256 MiB on a db.t4g.small, as first
# set, and 128 MiB on a micro, where RDS's own buffers leave less free from
# the start. A class missing from the table is read as 2 GiB.
locals {
  db_class_memory_mib = {
    "db.t4g.micro"  = 1024
    "db.t4g.small"  = 2048
    "db.t4g.medium" = 4096
    "db.t4g.large"  = 8192
  }
  db_freeable_memory_alarm_mib = lookup(local.db_class_memory_mib, var.db_instance_class, 2048) / 8
}

resource "aws_cloudwatch_metric_alarm" "rds_freeable_memory" {
  alarm_name          = "${local.name}-rds-freeable-memory"
  alarm_description   = "Database freeable memory below ${local.db_freeable_memory_alarm_mib} MiB (an eighth of a ${var.db_instance_class}) for fifteen minutes."
  namespace           = "AWS/RDS"
  metric_name         = "FreeableMemory"
  dimensions          = { DBInstanceIdentifier = aws_db_instance.main.identifier }
  statistic           = "Minimum"
  period              = 300
  evaluation_periods  = 3
  threshold           = local.db_freeable_memory_alarm_mib * 1048576
  comparison_operator = "LessThanThreshold"
  treat_missing_data  = "missing"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
}

# A transaction held open. docs/handover.md asks for an alarm on any
# transaction open longer than five minutes (pg_stat_activity.xact_start),
# because one that shortens a clinic's record clock or starts its offboarding
# and then stays open commits a change whose wait has already run, holding the
# clinic's row locked all that time.
#
# This is the part infrastructure can see without logging in to the database
# or killing anything: Performance Insights' counter for the longest session
# idle inside a transaction, which is how a client holding one open between
# statements looks. CloudWatch reads it through DB_PERF_INSIGHTS (and creates
# its own service-linked role for that on the first apply); the counter
# carries no query text, so it needs no right on our key. It does not see a
# transaction kept open by one statement that runs for longer than five
# minutes (a long query, or a pg_sleep): Performance Insights has no counter
# for the age of an active transaction, only its age in transaction ids. That
# part of the handover's alarm stays open, for a check run inside the
# database. No timeout setting is used instead: one would kill the runtime
# role's transactions.
resource "aws_cloudwatch_metric_alarm" "rds_idle_in_transaction" {
  alarm_name          = "${local.name}-rds-idle-in-transaction"
  alarm_description   = "A database session has held a transaction open, idle, for more than five minutes. See docs/handover.md, Retention and offboarding."
  comparison_operator = "GreaterThanThreshold"
  threshold           = 300
  evaluation_periods  = 1
  datapoints_to_alarm = 1
  treat_missing_data  = "notBreaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions

  metric_query {
    id          = "idle"
    label       = "Longest idle-in-transaction time (seconds)"
    expression  = "DB_PERF_INSIGHTS('RDS', '${aws_db_instance.main.resource_id}', 'db.state.idle_in_transaction_max_time.max')"
    period      = 60
    return_data = true
  }
}
