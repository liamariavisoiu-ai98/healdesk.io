# One image, several task definitions (contract section 1): the web tier and
# the worker as services, the migrations and the role bootstrap as one-off
# tasks the deploy workflow runs. All of them on Fargate, x86_64 (the images
# are built on GitHub's x86 runners), in the private subnets.
#
# Terraform owns the shape of each task definition; the deploy workflow owns
# which revision runs. It registers a new revision from the family's latest
# one with the new image (so changes made here carry into the next deploy) and
# updates the services; the services therefore ignore task_definition and
# desired_count here. They are created at desired 0 and the workflow scales
# them up after the first good migration, reading the intended count from the
# service's DesiredCount tag, so nothing runs before an image exists.
#
# Terraform's own revisions name the image tag terraform-placeholder, which
# nothing pushes (locals.tf). Never roll back to one: pick a revision by its
# image, not its number. A failed first deploy has no earlier version to go
# back to, only Terraform's revision at 0 tasks, so deploy-app.yml sets the
# service back to 0 rather than leave the circuit breaker retrying an image
# that does not exist.
#
# No ECS Exec anywhere: it would put an interactive root shell on a container
# holding PHI. Maintenance runs as reviewed one-off tasks instead.

resource "aws_ecs_cluster" "main" {
  name = local.name

  setting {
    name  = "containerInsights"
    value = var.container_insights ? "enabled" : "disabled"
  }

  # Container Insights writes to a group AWS would otherwise create without
  # our key; logs.tf pre-creates it when the variable is on.
  depends_on = [aws_cloudwatch_log_group.container_insights]

  #checkov:skip=CKV_AWS_65:Container Insights is a variable (container_insights), off in the lean default for cost; its log group is pre-created with our key when it is turned on.
}

# ---------------------------------------------------------------------------
# The tasks' security group: in from the load balancer on the web target port
# only; out to HTTPS (vendor APIs, AWS APIs, ECR) and to Postgres.
# ---------------------------------------------------------------------------

resource "aws_security_group" "tasks" {
  name        = "${local.name}-tasks"
  description = "ECS tasks: in from the load balancer only; out to HTTPS and RDS"
  vpc_id      = aws_vpc.main.id

  tags = {
    Name = "${local.name}-tasks"
  }
}

resource "aws_vpc_security_group_ingress_rule" "tasks_from_alb" {
  security_group_id            = aws_security_group.tasks.id
  description                  = "Web target port from the load balancer (traffic and health checks)"
  ip_protocol                  = "tcp"
  from_port                    = local.web_target_port
  to_port                      = local.web_target_port
  referenced_security_group_id = aws_security_group.alb.id
}

resource "aws_vpc_security_group_egress_rule" "tasks_https" {
  security_group_id = aws_security_group.tasks.id
  description       = "HTTPS to Stripe, Meta, Anthropic, Resend, Google and AWS APIs, and image pulls"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_vpc_security_group_egress_rule" "tasks_postgres" {
  security_group_id            = aws_security_group.tasks.id
  description                  = "PostgreSQL to RDS"
  ip_protocol                  = "tcp"
  from_port                    = local.db_port
  to_port                      = local.db_port
  referenced_security_group_id = aws_security_group.rds.id
}

# ---------------------------------------------------------------------------
# Container definitions
# ---------------------------------------------------------------------------

locals {
  app_image       = "${aws_ecr_repository.this["app"].repository_url}:${local.placeholder_image_tag}"
  tls_proxy_image = "${aws_ecr_repository.this["tls-proxy"].repository_url}:${local.placeholder_image_tag}"
  db_admin_image  = "${aws_ecr_repository.this["db-admin"].repository_url}:${local.placeholder_image_tag}"

  # ECS ignores a Dockerfile HEALTHCHECK, so the web check is declared here. It
  # uses node because the slim image has no curl or wget, and the liveness
  # probe, which answers 200 whenever the process is up and touches nothing.
  web_app_container = {
    name      = "app"
    image     = local.app_image
    essential = true

    environment = [for k in sort(keys(local.web_environment)) : { name = k, value = local.web_environment[k] }]
    secrets     = [for k in local.web_secret_names : { name = k, valueFrom = local.app_secret_arns[k] }]

    # Behind the sidecar, Next is reached on 127.0.0.1:3001 inside the task
    # and its port is not exposed to the load balancer at all.
    portMappings = var.alb_to_task_tls ? [] : [{ containerPort = 3001, hostPort = 3001, protocol = "tcp" }]

    healthCheck = {
      command     = ["CMD", "node", "-e", "fetch('http://127.0.0.1:3001/api/health?probe=liveness').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
      interval    = 30
      timeout     = 5
      retries     = 3
      startPeriod = 60
    }

    logConfiguration = {
      logDriver = "awslogs"
      options = merge(local.log_driver_options, {
        awslogs-group         = aws_cloudwatch_log_group.app["web"].name
        awslogs-stream-prefix = "web"
      })
    }
  }

  # The sidecar terminates the load balancer's TLS on 8443 with a self-signed
  # certificate it generates at start (never baked into the image) and proxies
  # to 127.0.0.1:3001, passing WebSocket upgrades through
  # (infra/aws/images/tls-proxy). It starts once Next is healthy. Its check is
  # the image's own script: the same liveness path, through its TLS port, with
  # certificate verification off.
  tls_proxy_container = {
    name      = "tls-proxy"
    image     = local.tls_proxy_image
    essential = true

    # nginx's keep-alive toward the load balancer has to outlast the load
    # balancer's idle timeout, or the balancer can send a request on a
    # connection nginx has just closed (an intermittent 502). Derived from the
    # same variable so the two cannot drift; 130 for the default 120, which is
    # also the image's own default.
    environment = [{ name = "TLS_PROXY_KEEPALIVE_SECONDS", value = tostring(var.alb_idle_timeout + 10) }]

    portMappings = [{ containerPort = 8443, hostPort = 8443, protocol = "tcp" }]

    dependsOn = [{ containerName = "app", condition = "HEALTHY" }]

    healthCheck = {
      command     = ["CMD", "/usr/local/bin/tls-proxy-healthcheck"]
      interval    = 30
      timeout     = 5
      retries     = 3
      startPeriod = 30
    }

    logConfiguration = {
      logDriver = "awslogs"
      options = merge(local.log_driver_options, {
        awslogs-group         = aws_cloudwatch_log_group.app["tls-proxy"].name
        awslogs-stream-prefix = "tls-proxy"
      })
    }
  }

  # One process, not `npm run worker`: npm, sh and the tsx CLI in between
  # relay SIGTERM with a 30 ms handshake and then SIGKILL the worker, which
  # turns a graceful drain into a kill. stopTimeout 60 gives pg-boss's 30 s
  # graceful stop room to finish. No health check: the worker serves no HTTP,
  # and its liveness is the heartbeat the plain /api/health reports.
  worker_container = {
    name             = "app"
    image            = local.app_image
    essential        = true
    command          = ["node", "--import", "tsx", "src/workers/index.ts"]
    workingDirectory = "/repo/apps/app"
    stopTimeout      = 60

    environment = [for k in sort(keys(local.worker_environment)) : { name = k, value = local.worker_environment[k] }]
    secrets     = [for k in local.worker_secret_names : { name = k, valueFrom = local.app_secret_arns[k] }]

    linuxParameters = { initProcessEnabled = true }

    logConfiguration = {
      logDriver = "awslogs"
      options = merge(local.log_driver_options, {
        awslogs-group         = aws_cloudwatch_log_group.app["worker"].name
        awslogs-stream-prefix = "worker"
      })
    }
  }

  # The check docs/handover.md ("Restoring") runs after any restore, before
  # the service reopens: every clinic due for destruction destroyed now, and
  # exit 1 while any is still due. It is the worker's container with its own
  # command, because destruction needs what the worker has: the runtime
  # role's URL, the KMS key (a Google grant still standing is revoked first)
  # and the Google client. Registered by every deploy, run only from a
  # terminal (infra/aws/scripts/run-task.sh destroy-due), never by the deploy
  # role, which may register it but not run it.
  destroy_due_container = merge(local.worker_container, {
    command     = ["node", "--import", "tsx", "scripts/destroy-due.ts"]
    stopTimeout = 30

    logConfiguration = {
      logDriver = "awslogs"
      options = merge(local.log_driver_options, {
        awslogs-group         = aws_cloudwatch_log_group.app["destroy-due"].name
        awslogs-stream-prefix = "destroy-due"
      })
    }
  })

  # A leaving clinic's return bundle (docs/handover.md, "Retention and
  # offboarding", step 2), written to the export bucket (exports.tf) because
  # this task's disk goes with it. Run only from a terminal
  # (infra/aws/scripts/run-task.sh patient-export <clinic id> "<who asked>"),
  # which passes the clinic, who asked and the object key as environment
  # overrides: an id, a label and a key, none of them secret or a patient's.
  # It gets the runtime role's URL and nothing else secret, and the export
  # task's role, which may put a bundle in the bucket and do nothing more:
  # not the app task role, so it cannot open a clinic's credentials.
  patient_export_container = {
    name             = "app"
    image            = local.app_image
    essential        = true
    command          = ["node", "--import", "tsx", "scripts/patient-export.ts"]
    workingDirectory = "/repo/apps/app"

    environment = [
      { name = "AWS_REGION", value = var.region },
      { name = "HEALDESK_EXPORT_BUCKET", value = local.export_bucket },
      { name = "NODE_ENV", value = "production" },
      { name = "NODE_EXTRA_CA_CERTS", value = local.rds_ca_bundle },
    ]
    secrets = [{ name = "DATABASE_URL", valueFrom = local.app_secret_arns["DATABASE_URL"] }]

    linuxParameters = { initProcessEnabled = true }

    logConfiguration = {
      logDriver = "awslogs"
      options = merge(local.log_driver_options, {
        awslogs-group         = aws_cloudwatch_log_group.app["patient-export"].name
        awslogs-stream-prefix = "patient-export"
      })
    }
  }

  # Migrations then the queue install, as healdesk_migrator, before every
  # service update. It gets the migrator URL and nothing else: no app
  # secrets, no KMS settings, no task role. npm keeps its cache and logs under
  # $HOME, which is /repo and not the image user's to write, so both go to
  # /tmp, and npm does not ask the registry whether it is out of date.
  migrate_container = {
    name      = "app"
    image     = local.app_image
    essential = true
    command   = ["sh", "-c", "npm run db:migrate -w @healdesk/app && npm run queue:install -w @healdesk/app"]

    environment = [
      { name = "NODE_EXTRA_CA_CERTS", value = local.rds_ca_bundle },
      { name = "NPM_CONFIG_CACHE", value = "/tmp/npm-cache" },
      { name = "NPM_CONFIG_UPDATE_NOTIFIER", value = "false" },
    ]
    secrets = [{ name = "MIGRATION_DATABASE_URL", valueFrom = local.parameter_arns["MIGRATION_DATABASE_URL"] }]

    linuxParameters = { initProcessEnabled = true }

    logConfiguration = {
      logDriver = "awslogs"
      options = merge(local.log_driver_options, {
        awslogs-group         = aws_cloudwatch_log_group.app["migrate"].name
        awslogs-stream-prefix = "migrate"
      })
    }
  }

  # Run as the RDS master user, on a new database and after a password is
  # reset. First init-secrets: it generates, inside AWS, each of the six
  # internal parameters still "__unset__" (ssm.tf) and composes both URLs from
  # PGHOST, writing them with the key named here. Then provision-roles.sql
  # (RDS-safe) creates healdesk_migrator and healdesk_app with the two
  # passwords it reads back through its task role (iam.tf). The passwords are
  # therefore not ECS secrets here: they may still be "__unset__" when the
  # task starts. libpq reads the connection from the standard PG* variables,
  # so the master credentials arrive only as secrets (JSON keys of the
  # RDS-managed secret), and nothing sensitive is ever in the command or in a
  # run-task override.
  db_bootstrap_container = {
    name      = "db-admin"
    image     = local.db_admin_image
    essential = true

    # Both lists in name order, like the other containers', so a revision
    # always renders the same way.
    environment = [
      { name = "AWS_REGION", value = var.region },
      { name = "HEALDESK_KMS_KEY_ID", value = aws_kms_key.main.arn },
      { name = "HEALDESK_PARAMETER_PREFIX", value = local.param_prefix },
      { name = "PGDATABASE", value = local.db_name },
      { name = "PGHOST", value = aws_db_instance.main.address },
      { name = "PGPORT", value = tostring(local.db_port) },
      { name = "PGSSLMODE", value = "verify-full" },
      { name = "PGSSLROOTCERT", value = local.rds_ca_bundle },
    ]

    secrets = [
      { name = "PGPASSWORD", valueFrom = "${aws_db_instance.main.master_user_secret[0].secret_arn}:password::" },
      { name = "PGUSER", valueFrom = "${aws_db_instance.main.master_user_secret[0].secret_arn}:username::" },
    ]

    logConfiguration = {
      logDriver = "awslogs"
      options = merge(local.log_driver_options, {
        awslogs-group         = aws_cloudwatch_log_group.app["db-bootstrap"].name
        awslogs-stream-prefix = "db-bootstrap"
      })
    }
  }
}

# ---------------------------------------------------------------------------
# Task definitions
# ---------------------------------------------------------------------------

resource "aws_ecs_task_definition" "web" {
  family                   = local.task_families.web
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = "512"
  memory                   = "1024"
  execution_role_arn       = aws_iam_role.ecs_execution.arn
  task_role_arn            = aws_iam_role.app_task.arn

  container_definitions = var.alb_to_task_tls ? jsonencode([local.web_app_container, local.tls_proxy_container]) : jsonencode([local.web_app_container])

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }

  lifecycle {
    precondition {
      condition     = length(setintersection(concat(keys(local.web_environment), local.web_secret_names), local.never_on_app_tasks)) == 0
      error_message = "The web task must never be given any of: ${join(", ", local.never_on_app_tasks)} (contract section 3)."
    }

    precondition {
      condition     = length(setintersection(keys(local.web_environment), local.secret_environment_names)) == 0
      error_message = "A secret name is in the web task's plain environment; secrets come from SSM only (ssm.tf)."
    }

    precondition {
      condition     = length(setsubtract(keys(local.web_environment), concat(local.stack_environment_names, keys(var.app_environment)))) == 0
      error_message = "The web task sets a name missing from local.stack_environment_names (locals.tf); add it there so app_environment cannot override it."
    }
  }

  #checkov:skip=CKV_AWS_336:Next writes .next/cache at run time, so the app container needs a writable root until the image provides a writable mount, and the tls-proxy sidecar writes its key and nginx's run files at start; a read-only root for either needs a writable volume tried on Fargate first. Both run as non-root users.
}

resource "aws_ecs_task_definition" "worker" {
  family                   = local.task_families.worker
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = "512"
  memory                   = "1024"
  execution_role_arn       = aws_iam_role.ecs_execution.arn
  task_role_arn            = aws_iam_role.app_task.arn

  container_definitions = jsonencode([local.worker_container])

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }

  lifecycle {
    precondition {
      condition     = length(setintersection(concat(keys(local.worker_environment), local.worker_secret_names), local.never_on_app_tasks)) == 0
      error_message = "The worker task must never be given any of: ${join(", ", local.never_on_app_tasks)} (contract section 3)."
    }

    precondition {
      condition     = length(setintersection(keys(local.worker_environment), local.secret_environment_names)) == 0
      error_message = "A secret name is in the worker task's plain environment; secrets come from SSM only (ssm.tf)."
    }

    precondition {
      condition     = length(setsubtract(keys(local.worker_environment), concat(local.stack_environment_names, keys(var.app_environment)))) == 0
      error_message = "The worker task sets a name missing from local.stack_environment_names (locals.tf); add it there so app_environment cannot override it."
    }
  }

  #checkov:skip=CKV_AWS_336:tsx compiles the worker at start and writes its cache and IPC pipe under /tmp; a read-only root needs a writable /tmp mount the image does not provide yet. The image runs as a non-root user.
}

resource "aws_ecs_task_definition" "patient_export" {
  family                   = local.task_families.patient_export
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = "512"
  memory                   = "2048"
  execution_role_arn       = aws_iam_role.ecs_execution.arn
  task_role_arn            = aws_iam_role.export_task.arn

  container_definitions = jsonencode([local.patient_export_container])

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }

  #checkov:skip=CKV_AWS_336:tsx compiles the script at start and writes its cache under /tmp, as the worker does; a read-only root needs a writable /tmp mount the image does not provide yet. It runs once, by hand, as a non-root user.
}

resource "aws_ecs_task_definition" "migrate" {
  family                   = local.task_families.migrate
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = "512"
  memory                   = "1024"
  execution_role_arn       = aws_iam_role.ecs_execution.arn

  container_definitions = jsonencode([local.migrate_container])

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }

  #checkov:skip=CKV_AWS_336:npm and tsx write caches and temp files at run time; a read-only root needs writable mounts the image does not provide yet. The task runs once per deploy as a non-root user.
}

# The worker's shape, roles and preconditions: the same environment and
# secrets, so the same refusals apply.
resource "aws_ecs_task_definition" "destroy_due" {
  family                   = local.task_families.destroy_due
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = "512"
  memory                   = "1024"
  execution_role_arn       = aws_iam_role.ecs_execution.arn
  task_role_arn            = aws_iam_role.app_task.arn

  container_definitions = jsonencode([local.destroy_due_container])

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }

  lifecycle {
    precondition {
      condition     = length(setintersection(concat(keys(local.worker_environment), local.worker_secret_names), local.never_on_app_tasks)) == 0
      error_message = "The destroy-due task must never be given any of: ${join(", ", local.never_on_app_tasks)} (contract section 3)."
    }
  }

  #checkov:skip=CKV_AWS_336:tsx compiles the script at start and writes its cache under /tmp, as the worker does; a read-only root needs a writable /tmp mount the image does not provide yet. It runs once, by hand, as a non-root user.
}

resource "aws_ecs_task_definition" "db_bootstrap" {
  family                   = local.task_families.db_bootstrap
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = "256"
  memory                   = "512"
  execution_role_arn       = aws_iam_role.ecs_execution.arn
  task_role_arn            = aws_iam_role.db_admin_task.arn

  container_definitions = jsonencode([local.db_bootstrap_container])

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }

  #checkov:skip=CKV_AWS_336:The entrypoint passes values between the AWS CLI, Python and psql through files in a private temporary directory, removed on exit; the task runs once, by hand or from the deploy workflow, and holds no long-lived state.
}

# ---------------------------------------------------------------------------
# Services
# ---------------------------------------------------------------------------

resource "aws_ecs_service" "web" {
  name             = "${local.name}-web"
  cluster          = aws_ecs_cluster.main.id
  task_definition  = aws_ecs_task_definition.web.arn
  desired_count    = 0
  launch_type      = "FARGATE"
  platform_version = "LATEST"

  enable_execute_command  = false
  enable_ecs_managed_tags = true
  propagate_tags          = "SERVICE"

  # Next starts in seconds, but the sidecar only starts once the app is
  # healthy and the target needs two passing checks after that.
  health_check_grace_period_seconds = 120

  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200

  # A deployment whose tasks never become healthy is rolled back to the last
  # one that completed. With one task, ECS needs three failed tasks to decide.
  # On a first deploy that is Terraform's placeholder revision (see the top of
  # this file), which deploy-app.yml then sets back to 0 tasks.
  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  network_configuration {
    subnets          = aws_subnet.private[*].id
    security_groups  = [aws_security_group.tasks.id]
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.web.arn
    container_name   = local.web_target_container
    container_port   = local.web_target_port
  }

  tags = {
    DesiredCount = tostring(var.web_desired)
  }

  lifecycle {
    ignore_changes = [task_definition, desired_count]
  }

  # ECS refuses a service whose target group no listener uses yet, and the
  # group is used only through the listener rules (the listener's own default
  # is a 404), which wait for the validated certificate.
  depends_on = [
    aws_acm_certificate_validation.app,
    aws_lb_listener.https,
    aws_lb_listener_rule.internal_signed,
    aws_lb_listener_rule.public,
  ]
}

resource "aws_ecs_service" "worker" {
  name             = "${local.name}-worker"
  cluster          = aws_ecs_cluster.main.id
  task_definition  = aws_ecs_task_definition.worker.arn
  desired_count    = 0
  launch_type      = "FARGATE"
  platform_version = "LATEST"

  enable_execute_command  = false
  enable_ecs_managed_tags = true
  propagate_tags          = "SERVICE"

  # Overlapping old and new workers during a deploy is safe: the clock, the
  # job locks and the outbox leases are all held in the database.
  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200

  # As the web service's: a failed first deploy has only Terraform's
  # placeholder revision behind it, and deploy-app.yml sets it back to 0.
  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  network_configuration {
    subnets          = aws_subnet.private[*].id
    security_groups  = [aws_security_group.tasks.id]
    assign_public_ip = false
  }

  tags = {
    DesiredCount = tostring(var.worker_desired)
  }

  lifecycle {
    ignore_changes = [task_definition, desired_count]
  }
}

# ---------------------------------------------------------------------------
# The Retell voice endpoint: NOT BUILT, deliberately left as a placeholder
# (enable_voice must stay false). Retell opens one WebSocket per call to a
# Healdesk-hosted custom-LLM endpoint and holds it for the whole call. Next
# route handlers cannot accept the upgrade, so it will be its own long-lived
# Node process from this same image. When the code exists, it needs:
#
#   - a third task definition and service (healdesk-<env>-voice), at least two
#     tasks so a call survives the loss of one, with the app task role and the
#     same environment as the web tier;
#   - its own target group: HTTP to the process, a plain HTTP GET health path
#     (ALB health checks cannot speak WebSocket), and a deregistration delay
#     of up to 3600 s, because ECS waits for draining before it stops a task
#     and that, not stopTimeout (120 s at most on Fargate), is what lets a
#     call in progress finish during a deploy;
#   - an HTTPS listener rule on this load balancer (for example the path
#     /llm-websocket/*) forwarding to that group; the ALB passes WebSocket
#     upgrades natively, and Retell's 2-second ping keeps the socket inside
#     the idle timeout;
#   - the tls-proxy sidecar's upgrade headers (already passed through) if the
#     hop stays encrypted, a longer wait in the deploy workflow for that
#     service, and an alarm on its own liveness.
# ---------------------------------------------------------------------------

# The variable's own validation already refuses true; this keeps the reason
# next to the placeholder it guards.
check "voice_endpoint_not_built" {
  assert {
    condition     = !var.enable_voice
    error_message = "enable_voice is true, but the Retell voice endpoint is not built: nothing in this module deploys it (see the placeholder above)."
  }
}
