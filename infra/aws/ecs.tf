# One image, five task definitions (docs/handover.md, "Once AWS lands"):
#
#   web            the Next standalone server, behind the load balancer
#   worker         pg-boss and the scheduler (src/workers/index.ts)
#   db-admin       once: apps/app/scripts/provision-roles.sql as RDS's master user
#   migrate        each release: drizzle migrations as healdesk_migrator
#   queue-install  once, and after a pg-boss upgrade: scripts/install-queue.ts
#
# The one-off tasks are run by scripts/run-task.sh, never at boot: the app
# role must not hold the privileges a migration needs.
#
# The Retell voice endpoint is a third long-lived process from the same image
# once it exists (it does not yet); it gets its own service and target group.

locals {
  image = "${aws_ecr_repository.app.repository_url}:${var.image_tag}"

  # Plain settings. The ones below win over var.app_environment: the origins,
  # the key and the transports are this stack's to decide.
  app_environment = merge(var.app_environment, {
    AWS_REGION                     = var.region
    BETTER_AUTH_URL                = "https://${var.public_hostname}"
    HEALDESK_APP_URL               = "https://${var.internal_hostname}"
    HEALDESK_KMS_PROVIDER          = "aws-kms"
    HEALDESK_KMS_KEY_ID            = aws_kms_key.main.arn
    HEALDESK_EMAIL_TRANSPORT       = "resend"
    HEALDESK_SES_CONFIGURATION_SET = aws_sesv2_configuration_set.phi.configuration_set_name
    # npm writes its cache and logs under $HOME, which is /repo and not the
    # unprivileged user's to write.
    NPM_CONFIG_CACHE           = "/tmp/npm-cache"
    NPM_CONFIG_UPDATE_NOTIFIER = "false"
  })

  app_env_list = [
    for k in sort(keys(local.app_environment)) : { name = k, value = local.app_environment[k] }
  ]

  runtime_secrets = [
    for k in local.runtime_secret_keys : {
      name      = k
      valueFrom = "${aws_secretsmanager_secret.runtime.arn}:${k}::"
    }
  ]

  # Migrations and the queue installer read MIGRATION_DATABASE_URL first and
  # DATABASE_URL after it; both point at the migrator here, so neither tool
  # can fall through to a URL that is not the table owner's.
  migrator_secrets = [
    for name in ["MIGRATION_DATABASE_URL", "DATABASE_URL"] : {
      name      = name
      valueFrom = "${aws_secretsmanager_secret.admin.arn}:MIGRATION_DATABASE_URL::"
    }
  ]

  migrator_env_list = [
    { name = "AWS_REGION", value = var.region },
    { name = "NPM_CONFIG_CACHE", value = "/tmp/npm-cache" },
    { name = "NPM_CONFIG_UPDATE_NOTIFIER", value = "false" },
  ]

  master_secret_arn = aws_db_instance.main.master_user_secret[0].secret_arn

  logs = {
    for k, group in aws_cloudwatch_log_group.tasks : k => {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = group.name
        "awslogs-region"        = var.region
        "awslogs-stream-prefix" = k
      }
    }
  }
}

resource "aws_ecs_cluster" "main" {
  name = var.name

  setting {
    name  = "containerInsights"
    value = "disabled"
  }
}

# --- Long-lived services -----------------------------------------------------------

resource "aws_ecs_task_definition" "web" {
  family                   = "${var.name}-web"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.web_cpu
  memory                   = var.web_memory
  execution_role_arn       = aws_iam_role.runtime_execution.arn
  task_role_arn            = aws_iam_role.app_task.arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = var.cpu_architecture
  }

  container_definitions = jsonencode([{
    name             = "web"
    image            = local.image
    essential        = true
    portMappings     = [{ containerPort = 3001, protocol = "tcp" }]
    environment      = local.app_env_list
    secrets          = local.runtime_secrets
    linuxParameters  = { initProcessEnabled = true }
    logConfiguration = local.logs["web"]
  }])
}

resource "aws_ecs_task_definition" "worker" {
  family                   = "${var.name}-worker"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.worker_cpu
  memory                   = var.worker_memory
  execution_role_arn       = aws_iam_role.runtime_execution.arn
  task_role_arn            = aws_iam_role.app_task.arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = var.cpu_architecture
  }

  container_definitions = jsonencode([{
    name            = "worker"
    image           = local.image
    essential       = true
    command         = ["npm", "run", "worker", "-w", "@healdesk/app"]
    environment     = local.app_env_list
    secrets         = local.runtime_secrets
    linuxParameters = { initProcessEnabled = true }
    # Above pg-boss's 30-second graceful stop (lib/queue/boss.ts). A longer
    # drain needs pg-boss's `timeout` raised too; Fargate's maximum is 120.
    stopTimeout      = 60
    logConfiguration = local.logs["worker"]
  }])
}

# Created with the HTTPS listener: ECS refuses a service whose target group
# no listener uses yet.
resource "aws_ecs_service" "web" {
  count                             = var.certificate_dns_ready ? 1 : 0
  name                              = "web"
  cluster                           = aws_ecs_cluster.main.id
  task_definition                   = aws_ecs_task_definition.web.arn
  desired_count                     = var.web_desired_count
  launch_type                       = "FARGATE"
  platform_version                  = "LATEST"
  propagate_tags                    = "SERVICE"
  health_check_grace_period_seconds = 60
  enable_execute_command            = false

  network_configuration {
    subnets          = aws_subnet.private[*].id
    security_groups  = [aws_security_group.web.id]
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.web.arn
    container_name   = "web"
    container_port   = 3001
  }

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  depends_on = [aws_lb_listener_rule.web]
}

resource "aws_ecs_service" "worker" {
  name                   = "worker"
  cluster                = aws_ecs_cluster.main.id
  task_definition        = aws_ecs_task_definition.worker.arn
  desired_count          = var.worker_desired_count
  launch_type            = "FARGATE"
  platform_version       = "LATEST"
  propagate_tags         = "SERVICE"
  enable_execute_command = false

  network_configuration {
    subnets          = aws_subnet.private[*].id
    security_groups  = [aws_security_group.worker.id]
    assign_public_ip = false
  }

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }
}

# --- One-off tasks --------------------------------------------------------------------

# Postgres's own image, for psql. The script is the repo's, passed in whole as
# an environment variable so there is one copy of it; the RDS certificate
# bundle is fetched so psql verifies the server it hands the passwords to.
resource "aws_ecs_task_definition" "db_admin" {
  family                   = "${var.name}-db-admin"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 256
  memory                   = 512
  execution_role_arn       = aws_iam_role.admin_execution.arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = var.cpu_architecture
  }

  container_definitions = jsonencode([{
    name      = "db-admin"
    image     = "public.ecr.aws/docker/library/postgres:${var.db_engine_version}-alpine"
    essential = true
    command = [
      "sh", "-c",
      join(" && ", [
        "wget -qO /tmp/rds.pem https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem",
        "printf '%s' \"$PROVISION_SQL\" > /tmp/provision-roles.sql",
        "psql -v ON_ERROR_STOP=1 -v app_password=\"$APP_PASSWORD\" -v migrator_password=\"$MIGRATOR_PASSWORD\" -f /tmp/provision-roles.sql",
        "echo 'roles provisioned'",
      ]),
    ]
    environment = [
      { name = "PGHOST", value = aws_db_instance.main.address },
      { name = "PGPORT", value = tostring(aws_db_instance.main.port) },
      { name = "PGDATABASE", value = aws_db_instance.main.db_name },
      { name = "PGSSLMODE", value = "verify-full" },
      { name = "PGSSLROOTCERT", value = "/tmp/rds.pem" },
      { name = "PROVISION_SQL", value = file("${path.module}/../../apps/app/scripts/provision-roles.sql") },
    ]
    secrets = [
      { name = "PGUSER", valueFrom = "${local.master_secret_arn}:username::" },
      { name = "PGPASSWORD", valueFrom = "${local.master_secret_arn}:password::" },
      { name = "APP_PASSWORD", valueFrom = "${aws_secretsmanager_secret.admin.arn}:APP_PASSWORD::" },
      { name = "MIGRATOR_PASSWORD", valueFrom = "${aws_secretsmanager_secret.admin.arn}:MIGRATOR_PASSWORD::" },
    ]
    logConfiguration = local.logs["admin"]
  }])
}

resource "aws_ecs_task_definition" "migrate" {
  family                   = "${var.name}-migrate"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 512
  memory                   = 1024
  execution_role_arn       = aws_iam_role.admin_execution.arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = var.cpu_architecture
  }

  container_definitions = jsonencode([{
    name             = "migrate"
    image            = local.image
    essential        = true
    command          = ["npm", "run", "db:migrate", "-w", "@healdesk/app"]
    environment      = local.migrator_env_list
    secrets          = local.migrator_secrets
    linuxParameters  = { initProcessEnabled = true }
    logConfiguration = local.logs["admin"]
  }])
}

resource "aws_ecs_task_definition" "queue_install" {
  family                   = "${var.name}-queue-install"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 512
  memory                   = 1024
  execution_role_arn       = aws_iam_role.admin_execution.arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = var.cpu_architecture
  }

  container_definitions = jsonencode([{
    name             = "queue-install"
    image            = local.image
    essential        = true
    command          = ["npm", "run", "queue:install", "-w", "@healdesk/app"]
    environment      = local.migrator_env_list
    secrets          = local.migrator_secrets
    linuxParameters  = { initProcessEnabled = true }
    logConfiguration = local.logs["admin"]
  }])
}
