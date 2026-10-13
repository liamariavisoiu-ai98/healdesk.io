# `terraform test` against mocked providers: no credentials, and nothing
# reaches AWS or Cloudflare. Every run is a plan. Mocked values are generated
# at plan time (override_during = plan), so the assertions can read computed
# attributes; an apply would regenerate them and fail on the difference.
#
#   terraform -chdir=infra/aws init -backend=false -lockfile=readonly
#   terraform -chdir=infra/aws test
#
# It holds the rules a later edit could break without validate noticing: what
# each task gets as environment and as secrets, that no secret value passes
# through Terraform, the trust and task policies, the two hostnames and their
# listener rules, the lock-label switch, the switched-off pieces (the voice
# endpoint, the transcript bucket) on and off, and the variable guards. Mock
# tips, learned the hard way: the provider still validates ARNs, so every type
# whose ARN is passed on gets a well-formed default; a nested block the mock
# cannot fill is read with try(); every instance of a type shares the
# default, so a test that must tell two apart overrides one.

mock_provider "aws" {
  override_during = plan

  override_data {
    target = data.aws_caller_identity.current
    values = {
      account_id = "865780386982"
    }
  }

  override_resource {
    target = aws_kms_key.main
    values = {
      arn    = "arn:aws:kms:us-east-1:865780386982:key/11111111-2222-3333-4444-555555555555"
      key_id = "11111111-2222-3333-4444-555555555555"
    }
  }

  override_resource {
    target = aws_acm_certificate.app
    values = {
      arn = "arn:aws:acm:us-east-1:865780386982:certificate/66666666-7777-8888-9999-000000000000"
      domain_validation_options = [
        {
          domain_name           = "app.healdesk.io"
          resource_record_name  = "_a1.app.healdesk.io."
          resource_record_type  = "CNAME"
          resource_record_value = "_a2.acm-validations.aws."
        },
        {
          domain_name           = "app-internal.healdesk.io"
          resource_record_name  = "_b1.app-internal.healdesk.io."
          resource_record_type  = "CNAME"
          resource_record_value = "_b2.acm-validations.aws."
        },
      ]
    }
  }

  # The NAT instance's interface and the tasks' security group, so the route
  # tables and the instance's ingress rule can be checked against them.
  override_resource {
    target = aws_instance.nat
    values = {
      primary_network_interface_id = "eni-0bbbbbbbbbbbbbbbb"
    }
  }

  override_resource {
    target = aws_security_group.tasks
    values = {
      id = "sg-0aaaaaaaaaaaaaaaa"
    }
  }

  override_resource {
    target = aws_db_instance.main
    values = {
      address     = "healdesk-production.abcdefghijkl.us-east-1.rds.amazonaws.com"
      resource_id = "db-ABCDEFGHIJKLMNOPQRSTUVWXY1"
      master_user_secret = [
        {
          kms_key_id    = "arn:aws:kms:us-east-1:865780386982:key/11111111-2222-3333-4444-555555555555"
          secret_arn    = "arn:aws:secretsmanager:us-east-1:865780386982:secret:rds!db-0000-AbCdEf"
          secret_status = "active"
        },
      ]
    }
  }

  override_resource {
    target = aws_sesv2_email_identity.main
    values = {
      arn = "arn:aws:ses:us-east-1:865780386982:identity/healdesk.io"
      # A nested block is overridden as one object, not a list of them.
      dkim_signing_attributes = {
        current_signing_key_length    = "RSA_2048_BIT"
        last_key_generation_timestamp = "2026-10-08T00:00:00Z"
        signing_attributes_origin     = "AWS_SES"
        status                        = "PENDING"
        tokens                        = ["tokenone", "tokentwo", "tokenthree"]
      }
    }
  }

  # The provider still validates planned values (ARNs, policy JSON), so the
  # generated strings are replaced by well-formed ones per type.
  mock_resource "aws_lb" {
    defaults = {
      arn        = "arn:aws:elasticloadbalancing:us-east-1:865780386982:loadbalancer/app/healdesk-production/0123456789abcdef"
      arn_suffix = "app/healdesk-production/0123456789abcdef"
      dns_name   = "healdesk-production-1234567890.us-east-1.elb.amazonaws.com"
    }
  }

  mock_resource "aws_lb_target_group" {
    defaults = {
      arn        = "arn:aws:elasticloadbalancing:us-east-1:865780386982:targetgroup/healdesk-production-web-https/0123456789abcdef"
      arn_suffix = "targetgroup/healdesk-production-web-https/0123456789abcdef"
    }
  }

  mock_resource "aws_lb_listener" {
    defaults = {
      arn = "arn:aws:elasticloadbalancing:us-east-1:865780386982:listener/app/healdesk-production/0123456789abcdef/0123456789abcdef"
    }
  }

  mock_resource "aws_iam_role" {
    defaults = {
      arn = "arn:aws:iam::865780386982:role/healdesk-production-mock"
    }
  }

  mock_resource "aws_sns_topic" {
    defaults = {
      arn = "arn:aws:sns:us-east-1:865780386982:healdesk-production-alarms"
    }
  }

  mock_resource "aws_ecs_cluster" {
    defaults = {
      arn = "arn:aws:ecs:us-east-1:865780386982:cluster/healdesk-production"
      id  = "arn:aws:ecs:us-east-1:865780386982:cluster/healdesk-production"
    }
  }

  mock_resource "aws_ecs_task_definition" {
    defaults = {
      arn = "arn:aws:ecs:us-east-1:865780386982:task-definition/healdesk-production-mock:1"
    }
  }

  mock_resource "aws_ssm_parameter" {
    defaults = {
      arn = "arn:aws:ssm:us-east-1:865780386982:parameter/healdesk/production/mock"
    }
  }

  mock_resource "aws_cloudwatch_log_group" {
    defaults = {
      arn = "arn:aws:logs:us-east-1:865780386982:log-group:/healdesk/production/mock"
    }
  }

  mock_resource "aws_ecr_repository" {
    defaults = {
      arn            = "arn:aws:ecr:us-east-1:865780386982:repository/healdesk/mock"
      repository_url = "865780386982.dkr.ecr.us-east-1.amazonaws.com/healdesk/mock"
    }
  }

  mock_resource "aws_s3_bucket" {
    defaults = {
      arn = "arn:aws:s3:::healdesk-production-mock-865780386982"
    }
  }

  # NAT gateways' ids, so the gateway-mode run can see the routes use them.
  mock_resource "aws_nat_gateway" {
    defaults = {
      id = "nat-0cccccccccccccccc"
    }
  }

  mock_resource "aws_wafv2_web_acl" {
    defaults = {
      arn = "arn:aws:wafv2:us-east-1:865780386982:regional/webacl/healdesk-production/00000000-0000-0000-0000-000000000000"
    }
  }

  mock_resource "aws_sesv2_configuration_set" {
    defaults = {
      arn = "arn:aws:ses:us-east-1:865780386982:configuration-set/healdesk-production-phi"
    }
  }

  mock_data "aws_iam_policy_document" {
    defaults = {
      json = "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Action\":\"sts:AssumeRole\",\"Principal\":{\"Service\":\"ecs-tasks.amazonaws.com\"}}]}"
    }
  }
}

mock_provider "cloudflare" {
  override_during = plan
}

# The four personal values infra.yml passes as TF_VAR_*, here as test values.
variables {
  cloudflare_zone_id   = "0123456789abcdef0123456789abcdef"
  alarm_email          = "alarms@example.com"
  healdesk_admin_email = "operator@example.com"
}

# ---------------------------------------------------------------------------
# The production defaults
# ---------------------------------------------------------------------------

run "production_defaults" {
  command = plan

  # --- web task: the app, the TLS sidecar and the shared worker, environment versus secrets ---
  assert {
    condition     = toset([for c in jsondecode(aws_ecs_task_definition.web.container_definitions) : c.name]) == toset(["app", "tls-proxy", "worker"])
    error_message = "The web task must run exactly the app, the tls-proxy sidecar and, with worker_placement shared (the default), the worker."
  }

  # The worker in the web task is the worker task's container under its own
  # name: the same command, environment, secrets, stop timeout and log group,
  # essential so its loss replaces the task.
  assert {
    condition = (
      merge(one([for c in jsondecode(aws_ecs_task_definition.web.container_definitions) : c if c.name == "worker"]), { name = "app" }) ==
      jsondecode(aws_ecs_task_definition.worker.container_definitions)[0] &&
      one([for c in jsondecode(aws_ecs_task_definition.web.container_definitions) : c if c.name == "worker"]).essential
    )
    error_message = "The web task's worker container must be the worker task's container, renamed, and essential."
  }

  assert {
    condition = toset([
      for e in one([for c in jsondecode(aws_ecs_task_definition.web.container_definitions) : c if c.name == "app"]).environment : e.name
      ]) == toset([
      "AWS_REGION", "BETTER_AUTH_URL", "HEALDESK_ADMIN_EMAIL", "HEALDESK_APP_URL", "HEALDESK_EMAIL_FROM",
      "HEALDESK_EMAIL_TRANSPORT", "HEALDESK_KMS_KEY_ID", "HEALDESK_KMS_PROVIDER", "HEALDESK_SES_CONFIGURATION_SET",
      "HEALDESK_SES_EVENTS_TOPIC_ARN", "HOSTNAME", "KEEP_ALIVE_TIMEOUT", "NODE_ENV", "NODE_EXTRA_CA_CERTS", "PORT",
    ])
    error_message = "The web app container's plain environment differs from contract section 3 and the integration brief."
  }

  assert {
    condition = {
      for e in one([for c in jsondecode(aws_ecs_task_definition.web.container_definitions) : c if c.name == "app"]).environment : e.name => e.value
      if contains(["BETTER_AUTH_URL", "HEALDESK_APP_URL", "HEALDESK_KMS_KEY_ID", "HEALDESK_KMS_PROVIDER", "KEEP_ALIVE_TIMEOUT", "HEALDESK_EMAIL_TRANSPORT"], e.name)
      } == {
      BETTER_AUTH_URL          = "https://app.healdesk.io"
      HEALDESK_APP_URL         = "https://app-internal.healdesk.io"
      HEALDESK_KMS_KEY_ID      = "arn:aws:kms:us-east-1:865780386982:key/11111111-2222-3333-4444-555555555555"
      HEALDESK_KMS_PROVIDER    = "aws-kms"
      KEEP_ALIVE_TIMEOUT       = "125000"
      HEALDESK_EMAIL_TRANSPORT = "resend"
    }
    error_message = "Web must have the public origin as BETTER_AUTH_URL, the internal one as HEALDESK_APP_URL, the key's full ARN and a keep-alive 5 s above the idle timeout."
  }

  assert {
    condition = toset([
      for e in one([for c in jsondecode(aws_ecs_task_definition.web.container_definitions) : c if c.name == "app"]).secrets : e.name
      ]) == toset([
      "ANTHROPIC_API_KEY", "BETTER_AUTH_SECRET", "DATABASE_URL", "GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET",
      "HEALDESK_IDENTIFIER_REF_KEY", "HEALDESK_PROVISION_SECRET", "HEALDESK_RETELL_LLM_SECRET",
      "HEALDESK_VOICE_TOOLS_SECRET", "HEALDESK_VOICE_WEBHOOK_SECRET", "META_APP_SECRET", "META_VERIFY_TOKEN",
      "RESEND_API_KEY", "STRIPE_CONNECT_WEBHOOK_SECRET", "STRIPE_SECRET_KEY",
    ])
    error_message = "The web app container must get every app/ parameter as a secret, and nothing else."
  }

  # Each secret comes from the parameter of its own name, under app/.
  assert {
    condition = alltrue([
      for e in one([for c in jsondecode(aws_ecs_task_definition.web.container_definitions) : c if c.name == "app"]).secrets :
      e.valueFrom == "arn:aws:ssm:us-east-1:865780386982:parameter/healdesk/production/app/${e.name}"
    ])
    error_message = "A web secret is wired to the wrong parameter."
  }

  assert {
    condition = alltrue([
      for e in one([for c in jsondecode(aws_ecs_task_definition.web.container_definitions) : c if c.name == "app"]).environment :
      !strcontains(e.value, "postgres") && e.value != "__unset__"
    ])
    error_message = "No database URL or placeholder may be in the web task's plain environment."
  }

  assert {
    condition = (
      strcontains(join(" ", one([for c in jsondecode(aws_ecs_task_definition.web.container_definitions) : c if c.name == "app"]).healthCheck.command), "/api/health?probe=liveness") &&
      one([for c in jsondecode(aws_ecs_task_definition.web.container_definitions) : c if c.name == "app"]).healthCheck.startPeriod == 60 &&
      length(one([for c in jsondecode(aws_ecs_task_definition.web.container_definitions) : c if c.name == "app"]).portMappings) == 0
    )
    error_message = "The app container probes ?probe=liveness with a 60 s start period, and behind the sidecar its port is not mapped."
  }

  assert {
    condition = (
      one([for c in jsondecode(aws_ecs_task_definition.web.container_definitions) : c if c.name == "tls-proxy"]).portMappings[0].containerPort == 8443 &&
      one([for c in jsondecode(aws_ecs_task_definition.web.container_definitions) : c if c.name == "tls-proxy"]).environment == [{ name = "TLS_PROXY_KEEPALIVE_SECONDS", value = "130" }] &&
      one([for c in jsondecode(aws_ecs_task_definition.web.container_definitions) : c if c.name == "tls-proxy"]).dependsOn[0].condition == "HEALTHY"
    )
    error_message = "The sidecar listens on 8443, is told to keep connections 130 s (10 above the idle timeout), and waits for a healthy app."
  }

  # --- worker ---
  assert {
    condition = toset([for e in jsondecode(aws_ecs_task_definition.worker.container_definitions)[0].environment : e.name]) == toset([
      "AWS_REGION", "BETTER_AUTH_URL", "HEALDESK_ADMIN_EMAIL", "HEALDESK_APP_URL", "HEALDESK_EMAIL_FROM",
      "HEALDESK_EMAIL_TRANSPORT", "HEALDESK_KMS_KEY_ID", "HEALDESK_KMS_PROVIDER", "HEALDESK_SES_CONFIGURATION_SET",
      "NODE_ENV", "NODE_EXTRA_CA_CERTS",
    ])
    error_message = "The worker's plain environment differs from contract section 3 and the integration brief."
  }

  assert {
    condition = toset([for e in jsondecode(aws_ecs_task_definition.worker.container_definitions)[0].secrets : e.name]) == toset([
      "BETTER_AUTH_SECRET", "DATABASE_URL", "GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET",
      "HEALDESK_IDENTIFIER_REF_KEY", "HEALDESK_PROVISION_SECRET", "RESEND_API_KEY", "STRIPE_SECRET_KEY",
    ])
    error_message = "The worker's secrets differ from what its code reads (Google included, for the calendar watch)."
  }

  assert {
    condition = alltrue([
      for e in jsondecode(aws_ecs_task_definition.worker.container_definitions)[0].secrets :
      e.valueFrom == "arn:aws:ssm:us-east-1:865780386982:parameter/healdesk/production/app/${e.name}"
    ])
    error_message = "A worker secret is wired to the wrong parameter."
  }

  assert {
    condition = (
      jsondecode(aws_ecs_task_definition.worker.container_definitions)[0].stopTimeout == 60 &&
      jsondecode(aws_ecs_task_definition.worker.container_definitions)[0].command == ["node", "--import", "tsx", "src/workers/index.ts"] &&
      jsondecode(aws_ecs_task_definition.worker.container_definitions)[0].workingDirectory == "/repo/apps/app" &&
      !contains(keys(jsondecode(aws_ecs_task_definition.worker.container_definitions)[0]), "healthCheck") &&
      !contains(keys(jsondecode(aws_ecs_task_definition.worker.container_definitions)[0]), "portMappings")
    )
    error_message = "The worker runs node --import tsx in /repo/apps/app with stopTimeout 60, no port and no health check."
  }

  # --- destroy-due: the worker's environment, secrets and role, its own
  # command and log group; registered by the deploy role, never run by it ---
  assert {
    condition = (
      jsondecode(aws_ecs_task_definition.destroy_due.container_definitions)[0].command == ["node", "--import", "tsx", "scripts/destroy-due.ts"] &&
      jsondecode(aws_ecs_task_definition.destroy_due.container_definitions)[0].workingDirectory == "/repo/apps/app" &&
      jsondecode(aws_ecs_task_definition.destroy_due.container_definitions)[0].name == "app" &&
      jsondecode(aws_ecs_task_definition.destroy_due.container_definitions)[0].environment == jsondecode(aws_ecs_task_definition.worker.container_definitions)[0].environment &&
      jsondecode(aws_ecs_task_definition.destroy_due.container_definitions)[0].secrets == jsondecode(aws_ecs_task_definition.worker.container_definitions)[0].secrets &&
      jsondecode(aws_ecs_task_definition.destroy_due.container_definitions)[0].logConfiguration.options["awslogs-group"] == "/healdesk/production/destroy-due" &&
      aws_ecs_task_definition.destroy_due.family == "healdesk-production-destroy-due" &&
      aws_ecs_task_definition.destroy_due.task_role_arn == aws_iam_role.app_task.arn &&
      aws_ecs_task_definition.destroy_due.execution_role_arn == aws_iam_role.ecs_execution.arn
    )
    error_message = "destroy-due is the worker's container (environment, secrets, task role) running scripts/destroy-due.ts, logging to its own group."
  }

  assert {
    condition = (
      contains(one([for st in data.aws_iam_policy_document.github_deploy.statement : st if st.sid == "RegisterOurTaskDefinitions"]).resources, "arn:aws:ecs:us-east-1:865780386982:task-definition/healdesk-production-destroy-due:*") &&
      !anytrue([for st in data.aws_iam_policy_document.github_deploy.statement : strcontains(jsonencode(st.resources), "destroy-due") if contains(st.actions, "ecs:RunTask")])
    )
    error_message = "The deploy role registers destroy-due revisions but may never run one: it is run by hand after a restore."
  }

  # --- migrate ---
  assert {
    condition = (
      jsondecode(aws_ecs_task_definition.migrate.container_definitions)[0].environment == [
        { name = "NODE_EXTRA_CA_CERTS", value = "/etc/ssl/rds/us-east-1-bundle.pem" },
        { name = "NPM_CONFIG_CACHE", value = "/tmp/npm-cache" },
        { name = "NPM_CONFIG_UPDATE_NOTIFIER", value = "false" },
      ] &&
      jsondecode(aws_ecs_task_definition.migrate.container_definitions)[0].secrets == [
        { name = "MIGRATION_DATABASE_URL", valueFrom = "arn:aws:ssm:us-east-1:865780386982:parameter/healdesk/production/migrator/MIGRATION_DATABASE_URL" },
      ] &&
      aws_ecs_task_definition.migrate.task_role_arn == null
    )
    error_message = "The migrate task gets the migrator URL, the CA bundle and npm's cache in /tmp, and no task role."
  }

  # --- db-bootstrap: the endpoint as plain environment, the master
  # credentials as its only secrets, the role passwords read by itself ---
  assert {
    condition = {
      for e in jsondecode(aws_ecs_task_definition.db_bootstrap.container_definitions)[0].environment : e.name => e.value
      } == {
      AWS_REGION                = "us-east-1"
      HEALDESK_KMS_KEY_ID       = "arn:aws:kms:us-east-1:865780386982:key/11111111-2222-3333-4444-555555555555"
      HEALDESK_PARAMETER_PREFIX = "/healdesk/production"
      PGDATABASE                = "healdesk"
      PGHOST                    = "healdesk-production.abcdefghijkl.us-east-1.rds.amazonaws.com"
      PGPORT                    = "5432"
      PGSSLMODE                 = "verify-full"
      PGSSLROOTCERT             = "/etc/ssl/rds/us-east-1-bundle.pem"
    }
    error_message = "db-bootstrap's plain environment must name the RDS endpoint, the parameter prefix and the key its init-secrets step writes with."
  }

  assert {
    condition = (
      jsondecode(aws_ecs_task_definition.db_bootstrap.container_definitions)[0].secrets == [
        { name = "PGPASSWORD", valueFrom = "arn:aws:secretsmanager:us-east-1:865780386982:secret:rds!db-0000-AbCdEf:password::" },
        { name = "PGUSER", valueFrom = "arn:aws:secretsmanager:us-east-1:865780386982:secret:rds!db-0000-AbCdEf:username::" },
      ] &&
      jsondecode(aws_ecs_task_definition.db_bootstrap.container_definitions)[0].name == "db-admin" &&
      aws_ecs_task_definition.db_bootstrap.task_role_arn == aws_iam_role.db_admin_task.arn
    )
    error_message = "db-bootstrap's only secrets are the RDS master secret's two keys; the role passwords are no longer ECS secrets."
  }

  # --- names never given to a task ---
  assert {
    condition = alltrue(flatten([
      for name in ["HEALDESK_LOCAL_KEK", "HEALDESK_DIRECT_BOOKING_ENABLED", "HEALDESK_PHASE_TWO_ATTRIBUTION", "BETTER_AUTH_SECRETS", "APP_PASSWORD", "MIGRATOR_PASSWORD"] : [
        for definition in [aws_ecs_task_definition.web.container_definitions, aws_ecs_task_definition.worker.container_definitions, aws_ecs_task_definition.destroy_due.container_definitions, aws_ecs_task_definition.patient_export.container_definitions, aws_ecs_task_definition.ops_script["erase-person"].container_definitions, aws_ecs_task_definition.ops_script["amend-contact"].container_definitions, aws_ecs_task_definition.migrate.container_definitions, aws_ecs_task_definition.db_bootstrap.container_definitions] :
        !strcontains(definition, "\"${name}\"")
      ]
    ])) && !strcontains(aws_ecs_task_definition.web.container_definitions, "MIGRATION_DATABASE_URL") && !strcontains(aws_ecs_task_definition.worker.container_definitions, "MIGRATION_DATABASE_URL") && !strcontains(aws_ecs_task_definition.destroy_due.container_definitions, "MIGRATION_DATABASE_URL")
    error_message = "A never-set variable appears in a task definition."
  }

  assert {
    condition     = aws_ecs_task_definition.web.runtime_platform[0].cpu_architecture == "ARM64" && aws_ecs_task_definition.web.cpu == "256" && aws_ecs_task_definition.web.memory == "1024"
    error_message = "Web must be 0.25 vCPU / 1 GB on ARM64."
  }

  # Every task definition declares the one architecture the images are built for.
  assert {
    condition = alltrue([
      for d in concat(
        [aws_ecs_task_definition.web, aws_ecs_task_definition.worker, aws_ecs_task_definition.destroy_due, aws_ecs_task_definition.patient_export, aws_ecs_task_definition.migrate, aws_ecs_task_definition.db_bootstrap],
        values(aws_ecs_task_definition.ops_script),
      ) : d.runtime_platform[0].cpu_architecture == "ARM64"
    ])
    error_message = "Every task definition must declare task_cpu_architecture: deploy-app.yml builds one set of images for all of them."
  }

  # --- services: web only; the worker shares its task ---
  assert {
    condition = (
      aws_ecs_service.web.desired_count == 0 &&
      !aws_ecs_service.web.enable_execute_command &&
      aws_ecs_service.web.deployment_circuit_breaker[0].enable && aws_ecs_service.web.deployment_circuit_breaker[0].rollback &&
      aws_ecs_service.web.tags["DesiredCount"] == "1" &&
      length(aws_ecs_service.worker) == 0 && length(aws_cloudwatch_metric_alarm.worker_running) == 0
    )
    error_message = "The web service starts at 0 tasks, with the circuit breaker on, ECS Exec off and its DesiredCount tag; a shared worker has no service and no alarm of its own."
  }

  assert {
    condition     = one(aws_ecs_service.web.load_balancer).container_name == "tls-proxy" && one(aws_ecs_service.web.load_balancer).container_port == 8443
    error_message = "The web service registers the sidecar's 8443."
  }

  # --- voice: off in the lean default, so nothing of it runs or is paid for;
  # the deploy role still names its service, because the workflow reads all
  # three services in one call to learn which exist ---
  assert {
    condition = (
      length(aws_ecs_task_definition.voice) == 0 && length(aws_ecs_service.voice) == 0 &&
      length(aws_lb_target_group.voice) == 0 && length(aws_lb_listener_rule.voice) == 0 &&
      length(aws_cloudwatch_metric_alarm.voice_running) == 0 &&
      output.voice_websocket_url == null && output.voice_service == null &&
      contains(one([for st in data.aws_iam_policy_document.github_deploy.statement : st if st.sid == "RollOurServices"]).resources, "arn:aws:ecs:us-east-1:865780386982:service/healdesk-production/healdesk-production-voice") &&
      contains(keys(aws_cloudwatch_log_group.app), "voice")
    )
    error_message = "With enable_voice off there is no voice task definition, service, target group, rule, alarm or output; the deploy role still names the voice service, and its log group exists."
  }

  # --- load balancer and TLS ---
  assert {
    condition = (
      aws_lb_target_group.web.protocol == "HTTPS" && aws_lb_target_group.web.port == 8443 &&
      aws_lb_target_group.web.health_check[0].path == "/api/health?probe=liveness" &&
      aws_lb_target_group.web.health_check[0].matcher == "200" &&
      aws_lb_target_group.web.health_check[0].protocol == "HTTPS"
    )
    error_message = "With alb_to_task_tls the target group is HTTPS:8443 with the liveness check."
  }

  assert {
    condition = (
      aws_lb_listener.https.ssl_policy == "ELBSecurityPolicy-TLS13-1-2-Res-PQ-2025-09" &&
      aws_lb_listener.https.certificate_arn == aws_acm_certificate_validation.app.certificate_arn &&
      aws_lb_listener.https.default_action[0].type == "fixed-response" &&
      aws_lb_listener.https.default_action[0].fixed_response[0].status_code == "404" &&
      aws_lb_listener.http.default_action[0].redirect[0].protocol == "HTTPS" &&
      aws_lb_listener.http.default_action[0].redirect[0].status_code == "HTTP_301"
    )
    error_message = "HTTPS uses the TLS 1.3/1.2 PQ policy and the validated certificate, and answers 404 to any host it does not know; HTTP redirects."
  }

  assert {
    condition     = aws_lb.main.drop_invalid_header_fields && aws_lb.main.enable_deletion_protection && aws_lb.main.idle_timeout == 120 && !aws_lb.main.internal
    error_message = "The ALB settings differ from contract section 1."
  }

  # --- the two hostnames: certificate, DNS ---
  assert {
    condition = (
      aws_acm_certificate.app.domain_name == "app.healdesk.io" &&
      aws_acm_certificate.app.subject_alternative_names == toset(["app-internal.healdesk.io"]) &&
      aws_acm_certificate_validation.app.timeouts.create == "30m"
    )
    error_message = "One certificate names both origins, and its validation gives up after 30 minutes."
  }

  assert {
    condition = (
      toset(keys(cloudflare_dns_record.acm_validation)) == toset(["app.healdesk.io", "app-internal.healdesk.io"]) &&
      alltrue([for r in cloudflare_dns_record.acm_validation : !r.proxied]) &&
      cloudflare_dns_record.acm_validation["app-internal.healdesk.io"].name == "_b1.app-internal.healdesk.io" &&
      cloudflare_dns_record.acm_validation["app-internal.healdesk.io"].content == "_b2.acm-validations.aws"
    )
    error_message = "Each name on the certificate gets its validation record, DNS-only and without trailing dots."
  }

  assert {
    condition = (
      cloudflare_dns_record.app.name == "app.healdesk.io" && !cloudflare_dns_record.app.proxied &&
      cloudflare_dns_record.app.type == "CNAME" && cloudflare_dns_record.app.content == aws_lb.main.dns_name &&
      cloudflare_dns_record.internal.name == "app-internal.healdesk.io" && !cloudflare_dns_record.internal.proxied &&
      cloudflare_dns_record.internal.type == "CNAME" && cloudflare_dns_record.internal.content == aws_lb.main.dns_name
    )
    error_message = "Both origins are DNS-only CNAMEs to the load balancer."
  }

  # --- listener rules: signed routes on the internal host only ---
  assert {
    condition = local.signed_paths == [
      "/api/provision",
      "/api/billing/events",
      "/api/ops",
      "/api/agreements",
      "/api/agreements/*/pdf",
      "/api/reviews/verify",
      "/api/checkout/intents",
      "/api/checkout/intents/session",
    ]
    error_message = "The signed routes differ from the ones enumerated from apps/web and apps/app; change both the code survey in locals.tf and this list."
  }

  assert {
    condition = (
      length(aws_lb_listener_rule.internal_signed) == 3 &&
      toset(flatten([for r in aws_lb_listener_rule.internal_signed : [for c in r.condition : tolist(c.path_pattern[0].values) if length(c.path_pattern) > 0]])) == toset(local.signed_paths) &&
      alltrue([for r in aws_lb_listener_rule.internal_signed : r.action[0].type == "forward" && r.action[0].target_group_arn == aws_lb_target_group.web.arn]) &&
      alltrue([for r in aws_lb_listener_rule.internal_signed : toset(flatten([for c in r.condition : tolist(c.host_header[0].values) if length(c.host_header) > 0])) == toset(["app-internal.healdesk.io"])])
    )
    error_message = "Every signed path is forwarded on the internal host, and only there."
  }

  assert {
    condition = (
      aws_lb_listener_rule.internal_nothing_else.action[0].type == "fixed-response" &&
      aws_lb_listener_rule.internal_nothing_else.action[0].fixed_response[0].status_code == "404" &&
      toset(flatten([for c in aws_lb_listener_rule.internal_nothing_else.condition : tolist(c.host_header[0].values) if length(c.host_header) > 0])) == toset(["app-internal.healdesk.io"]) &&
      length(flatten([for c in aws_lb_listener_rule.internal_nothing_else.condition : c.path_pattern])) == 0
    )
    error_message = "The internal host answers 404 to anything that is not a signed route."
  }

  assert {
    condition = (
      length(aws_lb_listener_rule.public_refuses_signed) == 3 &&
      toset(flatten([for r in aws_lb_listener_rule.public_refuses_signed : [for c in r.condition : tolist(c.path_pattern[0].values) if length(c.path_pattern) > 0]])) == toset(local.signed_paths) &&
      alltrue([for r in aws_lb_listener_rule.public_refuses_signed : r.action[0].type == "fixed-response" && r.action[0].fixed_response[0].status_code == "404"]) &&
      alltrue([for r in aws_lb_listener_rule.public_refuses_signed : toset(flatten([for c in r.condition : tolist(c.host_header[0].values) if length(c.host_header) > 0])) == toset(["app.healdesk.io"])])
    )
    error_message = "The public host answers a fixed 404 to every signed path."
  }

  assert {
    condition = (
      aws_lb_listener_rule.public.action[0].type == "forward" &&
      aws_lb_listener_rule.public.action[0].target_group_arn == aws_lb_target_group.web.arn &&
      toset(flatten([for c in aws_lb_listener_rule.public.condition : tolist(c.host_header[0].values) if length(c.host_header) > 0])) == toset(["app.healdesk.io"])
    )
    error_message = "The public host forwards everything else to the web tier."
  }

  # Lower numbers win: the signed paths are decided before either host's
  # catch-all, and each rule stays within ALB's limits (three values a
  # condition, five a rule).
  assert {
    condition = (
      max([for r in aws_lb_listener_rule.internal_signed : r.priority]...) < aws_lb_listener_rule.internal_nothing_else.priority &&
      max([for r in aws_lb_listener_rule.public_refuses_signed : r.priority]...) < aws_lb_listener_rule.public.priority &&
      alltrue([
        for r in concat(aws_lb_listener_rule.internal_signed, aws_lb_listener_rule.public_refuses_signed) :
        alltrue([for c in r.condition : length(flatten([c.host_header[*].values, c.path_pattern[*].values])) <= 3]) &&
        length(flatten([for c in r.condition : flatten([c.host_header[*].values, c.path_pattern[*].values])])) <= 5
      ])
    )
    error_message = "The listener rules are in the wrong order or over ALB's per-rule limits."
  }

  # --- WAF: off in the lean default (the owner's choice of 13 October 2026) ---
  assert {
    condition     = length(aws_wafv2_web_acl.main) == 0 && length(aws_wafv2_web_acl_association.alb) == 0
    error_message = "enable_waf is false by default: no web ACL and no association."
  }

  # --- egress: the NAT instance, no NAT gateway ---
  assert {
    condition = (
      length(aws_nat_gateway.main) == 0 && length(aws_eip.nat) == 0 &&
      length(aws_instance.nat) == 1 &&
      aws_instance.nat[0].instance_type == "t4g.nano" &&
      !aws_instance.nat[0].source_dest_check &&
      aws_instance.nat[0].associate_public_ip_address &&
      aws_instance.nat[0].metadata_options[0].http_tokens == "required" &&
      aws_instance.nat[0].credit_specification[0].cpu_credits == "standard" &&
      aws_instance.nat[0].root_block_device[0].encrypted
    )
    error_message = "The lean egress is one t4g.nano NAT instance with its own public address: forwarding on, IMDSv2 only, capped credits and an encrypted disk."
  }

  assert {
    condition = alltrue([
      for rt in aws_route_table.private : one(rt.route).network_interface_id == aws_instance.nat[0].primary_network_interface_id && one(rt.route).nat_gateway_id == null
    ])
    error_message = "Both private route tables must send 0.0.0.0/0 to the NAT instance's interface."
  }

  # The instance takes only HTTPS from the tasks and sends only HTTPS out.
  assert {
    condition = (
      aws_vpc_security_group_ingress_rule.nat_from_tasks[0].from_port == 443 &&
      aws_vpc_security_group_ingress_rule.nat_from_tasks[0].to_port == 443 &&
      aws_vpc_security_group_ingress_rule.nat_from_tasks[0].referenced_security_group_id == aws_security_group.tasks.id &&
      aws_vpc_security_group_egress_rule.nat_https[0].from_port == 443 &&
      aws_vpc_security_group_egress_rule.nat_https[0].to_port == 443
    )
    error_message = "The NAT instance's security group admits 443 from the tasks only and sends 443 only."
  }

  assert {
    condition = (
      strcontains(aws_instance.nat[0].user_data, "ip saddr $${vpc_cidr} tcp dport 443 ct state new accept") &&
      strcontains(aws_instance.nat[0].user_data, "vpc_cidr=\"10.40.0.0/16\"") &&
      strcontains(aws_instance.nat[0].user_data, "policy drop") &&
      length(aws_cloudwatch_metric_alarm.nat_instance_status) == 1
    )
    error_message = "The NAT instance's own firewall forwards new connections to 443 from the VPC and drops the rest, and its status checks are alarmed."
  }

  # --- database ---
  assert {
    condition     = aws_cloudwatch_metric_alarm.rds_freeable_memory.threshold == 134217728
    error_message = "On a db.t4g.micro the freeable-memory alarm fires below 128 MiB, an eighth of the instance."
  }

  assert {
    condition = (
      aws_db_instance.main.engine_version == "17.11" && aws_db_instance.main.instance_class == "db.t4g.micro" &&
      aws_db_instance.main.allocated_storage == 20 && aws_db_instance.main.storage_type == "gp3" &&
      aws_db_instance.main.storage_encrypted && aws_db_instance.main.kms_key_id == aws_kms_key.main.arn &&
      !aws_db_instance.main.multi_az && !aws_db_instance.main.publicly_accessible &&
      aws_db_instance.main.backup_retention_period == 35 && aws_db_instance.main.skip_final_snapshot &&
      !aws_db_instance.main.delete_automated_backups && aws_db_instance.main.deletion_protection &&
      aws_db_instance.main.copy_tags_to_snapshot && aws_db_instance.main.manage_master_user_password &&
      aws_db_instance.main.master_user_secret_kms_key_id == aws_kms_key.main.arn &&
      aws_db_instance.main.username == "healdesk_admin" && aws_db_instance.main.db_name == "healdesk" &&
      aws_db_instance.main.ca_cert_identifier == "rds-ca-rsa2048-g1" && aws_db_instance.main.auto_minor_version_upgrade &&
      aws_db_instance.main.enabled_cloudwatch_logs_exports == toset(["postgresql"]) &&
      aws_db_instance.main.database_insights_mode == "standard" && aws_db_instance.main.performance_insights_enabled &&
      aws_db_instance.main.performance_insights_kms_key_id == aws_kms_key.main.arn
    )
    error_message = "The RDS instance differs from contract section 1."
  }

  assert {
    condition = {
      for p in aws_db_parameter_group.main.parameter : p.name => p.value
      } == {
      "rds.force_ssl"            = "1"
      "ssl_min_protocol_version" = "TLSv1.2"
      "password_encryption"      = "scram-sha-256"
      "log_error_verbosity"      = "terse"
      "log_statement"            = "none"
      "log_min_error_statement"  = "panic"
    } && aws_db_parameter_group.main.family == "postgres17"
    error_message = "The parameter group must force TLS, use SCRAM and keep statement text out of the engine log (log_min_error_statement = panic)."
  }

  # --- parameters: created as __unset__ through the write-only argument, so
  # no value is in the state or the plan ---
  assert {
    condition = (
      local.unset_placeholder == "__unset__" &&
      length(aws_ssm_parameter.internal) == 6 && length(aws_ssm_parameter.external) == 12 &&
      alltrue([
        for p in concat(values(aws_ssm_parameter.internal), values(aws_ssm_parameter.external)) :
        p.type == "SecureString" && p.key_id == aws_kms_key.main.arn && p.tier == "Standard" &&
        p.value_wo == null && p.value_wo_version == 1
      ])
    )
    error_message = "Every parameter is a SecureString under our key, written once as __unset__ through value_wo and never through value."
  }

  assert {
    condition = toset([for p in aws_ssm_parameter.internal : p.name]) == toset([
      "/healdesk/production/db/APP_PASSWORD",
      "/healdesk/production/db/MIGRATOR_PASSWORD",
      "/healdesk/production/app/BETTER_AUTH_SECRET",
      "/healdesk/production/app/HEALDESK_IDENTIFIER_REF_KEY",
      "/healdesk/production/app/DATABASE_URL",
      "/healdesk/production/migrator/MIGRATION_DATABASE_URL",
    ])
    error_message = "The six internal parameters the db-bootstrap task fills are at the wrong paths."
  }

  assert {
    condition = (
      output.parameters_to_fill == sort([for name in [
        "ANTHROPIC_API_KEY", "GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET", "HEALDESK_PROVISION_SECRET",
        "HEALDESK_RETELL_LLM_SECRET", "HEALDESK_VOICE_TOOLS_SECRET", "HEALDESK_VOICE_WEBHOOK_SECRET", "META_APP_SECRET",
        "META_VERIFY_TOKEN", "RESEND_API_KEY", "STRIPE_CONNECT_WEBHOOK_SECRET", "STRIPE_SECRET_KEY",
      ] : "/healdesk/production/app/${name}"]) &&
      length(output.internal_parameters) == 6 &&
      !contains(output.parameters_to_fill, "/healdesk/production/ci/CLOUDFLARE_API_TOKEN")
    )
    error_message = "parameters_to_fill lists the twelve external keys (and never the CI token, which Terraform does not manage)."
  }

  assert {
    condition     = output.internal_url == "https://app-internal.healdesk.io" && output.app_url == "https://app.healdesk.io"
    error_message = "The outputs name both origins."
  }

  # --- IAM: the execution role reads only the paths task definitions name ---
  assert {
    condition = toset(one([for st in data.aws_iam_policy_document.ecs_execution.statement : st if st.sid == "ReadTheTasksParameters"]).resources) == toset([
      "arn:aws:ssm:us-east-1:865780386982:parameter/healdesk/production/app/*",
      "arn:aws:ssm:us-east-1:865780386982:parameter/healdesk/production/migrator/*",
    ])
    error_message = "The execution role may read app/ and migrator/ only: never db/ and never ci/ (the Cloudflare token)."
  }

  assert {
    condition = (
      toset(one([for st in data.aws_iam_policy_document.ecs_execution.statement : st if st.sid == "DecryptThroughSsmAndSecretsManager"]).actions) == toset(["kms:Decrypt"]) &&
      toset(flatten([for c in one([for st in data.aws_iam_policy_document.ecs_execution.statement : st if st.sid == "DecryptThroughSsmAndSecretsManager"]).condition : c.values if c.variable == "kms:ViaService"])) == toset(["ssm.us-east-1.amazonaws.com", "secretsmanager.us-east-1.amazonaws.com"])
    )
    error_message = "The execution role decrypts only through SSM and Secrets Manager."
  }

  # --- IAM: the db-bootstrap task's role ---
  assert {
    condition = (
      toset(one([for st in data.aws_iam_policy_document.db_admin_task.statement : st if st.sid == "GenerateAndReadTheInternalSecrets"]).actions) == toset(["ssm:GetParameter", "ssm:PutParameter"]) &&
      toset(one([for st in data.aws_iam_policy_document.db_admin_task.statement : st if st.sid == "GenerateAndReadTheInternalSecrets"]).resources) == toset([
        "arn:aws:ssm:us-east-1:865780386982:parameter/healdesk/production/db/APP_PASSWORD",
        "arn:aws:ssm:us-east-1:865780386982:parameter/healdesk/production/db/MIGRATOR_PASSWORD",
        "arn:aws:ssm:us-east-1:865780386982:parameter/healdesk/production/app/BETTER_AUTH_SECRET",
        "arn:aws:ssm:us-east-1:865780386982:parameter/healdesk/production/app/HEALDESK_IDENTIFIER_REF_KEY",
        "arn:aws:ssm:us-east-1:865780386982:parameter/healdesk/production/app/DATABASE_URL",
        "arn:aws:ssm:us-east-1:865780386982:parameter/healdesk/production/migrator/MIGRATION_DATABASE_URL",
      ]) &&
      length(data.aws_iam_policy_document.db_admin_task.statement) == 2
    )
    error_message = "The db-bootstrap task may get and put exactly the six internal parameters, and nothing else."
  }

  assert {
    condition = (
      toset(one([for st in data.aws_iam_policy_document.db_admin_task.statement : st if st.sid == "UseTheKeyThroughSsmForThemOnly"]).actions) == toset(["kms:Encrypt", "kms:GenerateDataKey", "kms:Decrypt"]) &&
      toset(flatten([for c in one([for st in data.aws_iam_policy_document.db_admin_task.statement : st if st.sid == "UseTheKeyThroughSsmForThemOnly"]).condition : c.values if c.variable == "kms:ViaService"])) == toset(["ssm.us-east-1.amazonaws.com"]) &&
      length(flatten([for c in one([for st in data.aws_iam_policy_document.db_admin_task.statement : st if st.sid == "UseTheKeyThroughSsmForThemOnly"]).condition : c.values if c.variable == "kms:EncryptionContext:PARAMETER_ARN"])) == 6
    )
    error_message = "The db-bootstrap task uses the key through SSM only, for the six parameters' own encryption context."
  }

  # --- IAM: the app's task role, lock labels on (the default) ---
  assert {
    condition = (
      toset([for st in data.aws_iam_policy_document.app_task.statement : st.sid]) == toset(["CredentialVault", "SendThroughThePhiConfigurationSet", "ReadThePhiConfigurationSet"]) &&
      toset(one([for st in data.aws_iam_policy_document.app_task.statement : st if st.sid == "CredentialVault"]).actions) == toset(["kms:GenerateDataKey", "kms:Decrypt", "kms:Encrypt"]) &&
      length([for c in one([for st in data.aws_iam_policy_document.app_task.statement : st if st.sid == "CredentialVault"]).condition : c if c.test == "Null" && c.variable == "kms:ViaService" && contains(c.values, "true")]) == 1 &&
      length([for c in one([for st in data.aws_iam_policy_document.app_task.statement : st if st.sid == "CredentialVault"]).condition : c if c.test == "ForAllValues:StringEquals" && c.variable == "kms:EncryptionContextKeys" && toset(c.values) == toset(["healdesk:clinic", "healdesk:login"])]) == 1 &&
      toset([for c in one([for st in data.aws_iam_policy_document.app_task.statement : st if st.sid == "CredentialVault"]).condition : c.variable if c.test == "Null" && contains(c.values, "false")]) == toset(["kms:EncryptionContext:healdesk:clinic", "kms:EncryptionContext:healdesk:login"])
    )
    error_message = "With lock labels on, the app's KMS calls need both labels, no other context key, and no AWS service in between; besides them the role may only send through the PHI configuration set and read it (SES on, the transcript bucket off)."
  }

  # --- IAM: the deploy role trusts main, run by the owner ---
  assert {
    condition = (
      toset([for c in one(data.aws_iam_policy_document.github_deploy_assume.statement).condition : "${c.test} ${c.variable} ${join(",", sort(tolist(c.values)))}"]) == toset([
        "StringEquals token.actions.githubusercontent.com:aud sts.amazonaws.com",
        "StringEquals token.actions.githubusercontent.com:sub repo:liamariavisoiu-ai98@262780224/healdesk.io@1326499636:ref:refs/heads/main",
        "StringEquals token.actions.githubusercontent.com:ref refs/heads/main",
        "StringEquals token.actions.githubusercontent.com:actor_id 262780224",
      ]) &&
      !strcontains(jsonencode(data.aws_iam_policy_document.github_deploy_assume.statement), "environment:") &&
      toset(one(data.aws_iam_policy_document.github_deploy_assume.statement).actions) == toset(["sts:AssumeRoleWithWebIdentity"]) &&
      aws_iam_role.github_deploy.max_session_duration == 7200 &&
      aws_iam_role.github_deploy.name == "healdesk-production-github-deploy"
    )
    error_message = "The deploy role must trust exactly: aud, the main-branch subject, ref main and the owner's actor id; no environment."
  }

  # --- logs, key, registry, trail, monitoring ---
  assert {
    condition = alltrue([
      for g in concat(values(aws_cloudwatch_log_group.app), [aws_cloudwatch_log_group.rds_postgresql]) :
      g.retention_in_days == 0 && g.kms_key_id == aws_kms_key.main.arn
    ]) && aws_cloudwatch_log_group.rds_postgresql.name == "/aws/rds/instance/healdesk-production/postgresql"
    error_message = "Every log group uses our key and never expires."
  }

  assert {
    condition     = aws_kms_key.main.enable_key_rotation && !aws_kms_key.main.multi_region && aws_kms_alias.main.name == "alias/healdesk-production"
    error_message = "One rotating, single-region key aliased alias/healdesk-production."
  }

  assert {
    condition     = toset([for r in aws_ecr_repository.this : r.name]) == toset(["healdesk/app", "healdesk/db-admin", "healdesk/tls-proxy"]) && alltrue([for r in aws_ecr_repository.this : r.image_tag_mutability == "IMMUTABLE"])
    error_message = "The three immutable repositories under healdesk/."
  }

  assert {
    condition = (
      aws_cloudtrail.main.is_multi_region_trail && aws_cloudtrail.main.enable_log_file_validation &&
      aws_cloudtrail.main.kms_key_id == aws_kms_key.main.arn &&
      aws_cloudtrail.main.event_selector[0].read_write_type == "All" &&
      toset(flatten([for d in aws_cloudtrail.main.event_selector[0].data_resource : d.values])) == toset(["arn:aws:s3:::healdesk-production-exports-865780386982/"])
    )
    error_message = "One multi-region, validated, KMS-encrypted trail of read and write events; with no transcript bucket, the export bucket's objects are its only data events."
  }

  # --- the export bucket and the patient-export task ---
  assert {
    condition = (
      aws_s3_bucket.exports.bucket == "healdesk-production-exports-865780386982" &&
      one(aws_s3_bucket_server_side_encryption_configuration.exports.rule).apply_server_side_encryption_by_default[0].sse_algorithm == "aws:kms" &&
      one(aws_s3_bucket_server_side_encryption_configuration.exports.rule).apply_server_side_encryption_by_default[0].kms_master_key_id == aws_kms_key.main.arn &&
      one(aws_s3_bucket_server_side_encryption_configuration.exports.rule).bucket_key_enabled &&
      aws_s3_bucket_public_access_block.exports.block_public_acls && aws_s3_bucket_public_access_block.exports.block_public_policy &&
      aws_s3_bucket_public_access_block.exports.ignore_public_acls && aws_s3_bucket_public_access_block.exports.restrict_public_buckets &&
      one(aws_s3_bucket_ownership_controls.exports.rule).object_ownership == "BucketOwnerEnforced" &&
      one(aws_s3_bucket_lifecycle_configuration.exports.rule).expiration[0].days == 1 &&
      toset([for st in data.aws_iam_policy_document.exports_bucket.statement : st.sid]) == toset(["DenyAnythingWithoutTls", "DenyUploadsNotUnderKms"]) &&
      alltrue([for st in data.aws_iam_policy_document.exports_bucket.statement : st.effect == "Deny"])
    )
    error_message = "The export bucket is SSE-KMS under our key with bucket keys, private, owner-enforced, TLS only, KMS-only uploads, and keeps an object one day (24 to 48 hours, to S3's next midnight)."
  }

  assert {
    condition = (
      toset([for st in data.aws_iam_policy_document.export_task.statement : st.sid]) == toset(["PutReturnBundles", "S3UsesTheKeyForExports"]) &&
      toset(one([for st in data.aws_iam_policy_document.export_task.statement : st if st.sid == "PutReturnBundles"]).actions) == toset(["s3:PutObject", "s3:AbortMultipartUpload"]) &&
      toset(one([for st in data.aws_iam_policy_document.export_task.statement : st if st.sid == "PutReturnBundles"]).resources) == toset(["arn:aws:s3:::healdesk-production-exports-865780386982/clinic-*.json"]) &&
      toset(flatten([for c in one([for st in data.aws_iam_policy_document.export_task.statement : st if st.sid == "S3UsesTheKeyForExports"]).condition : c.values if c.variable == "kms:ViaService"])) == toset(["s3.us-east-1.amazonaws.com"]) &&
      toset(flatten([for c in one([for st in data.aws_iam_policy_document.export_task.statement : st if st.sid == "S3UsesTheKeyForExports"]).condition : c.values if c.variable == "kms:EncryptionContext:aws:s3:arn"])) == toset(["arn:aws:s3:::healdesk-production-exports-865780386982"]) &&
      !strcontains(jsonencode(data.aws_iam_policy_document.app_task.statement), "exports")
    )
    error_message = "The export task's role may put clinic bundles in the export bucket, with the key only through S3 for that bucket, and nothing else; the app task role cannot touch the bucket."
  }

  assert {
    condition = (
      jsondecode(aws_ecs_task_definition.patient_export.container_definitions)[0].command == ["node", "--import", "tsx", "scripts/patient-export.ts"] &&
      jsondecode(aws_ecs_task_definition.patient_export.container_definitions)[0].workingDirectory == "/repo/apps/app" &&
      jsondecode(aws_ecs_task_definition.patient_export.container_definitions)[0].secrets == [
        { name = "DATABASE_URL", valueFrom = "arn:aws:ssm:us-east-1:865780386982:parameter/healdesk/production/app/DATABASE_URL" },
      ] &&
      {
        for e in jsondecode(aws_ecs_task_definition.patient_export.container_definitions)[0].environment : e.name => e.value
        } == {
        AWS_REGION             = "us-east-1"
        HEALDESK_EXPORT_BUCKET = "healdesk-production-exports-865780386982"
        NODE_ENV               = "production"
        NODE_EXTRA_CA_CERTS    = "/etc/ssl/rds/us-east-1-bundle.pem"
      } &&
      jsondecode(aws_ecs_task_definition.patient_export.container_definitions)[0].logConfiguration.options["awslogs-group"] == "/healdesk/production/patient-export" &&
      aws_ecs_task_definition.patient_export.family == "healdesk-production-patient-export" &&
      aws_ecs_task_definition.patient_export.task_role_arn == aws_iam_role.export_task.arn &&
      aws_ecs_task_definition.patient_export.execution_role_arn == aws_iam_role.ecs_execution.arn
    )
    error_message = "patient-export runs scripts/patient-export.ts with the runtime URL as its only secret, the export bucket named, and the export task's role."
  }

  assert {
    condition = (
      contains(one([for st in data.aws_iam_policy_document.github_deploy.statement : st if st.sid == "RegisterOurTaskDefinitions"]).resources, "arn:aws:ecs:us-east-1:865780386982:task-definition/healdesk-production-patient-export:*") &&
      contains(one([for st in data.aws_iam_policy_document.github_deploy.statement : st if st.sid == "PassOnlyTheTaskRoles"]).resources, aws_iam_role.export_task.arn) &&
      !anytrue([for st in data.aws_iam_policy_document.github_deploy.statement : strcontains(jsonencode(st.resources), "patient-export") if contains(st.actions, "ecs:RunTask")])
    )
    error_message = "The deploy role registers patient-export revisions and may pass the export task's role, but may never run one."
  }

  # --- the patient-rights operator scripts: ids only, no task role ---
  assert {
    condition = (
      toset(keys(aws_ecs_task_definition.ops_script)) == toset(["erase-person", "amend-contact", "reapply-erasures"]) &&
      jsondecode(aws_ecs_task_definition.ops_script["reapply-erasures"].container_definitions)[0].command == ["node", "--import", "tsx", "scripts/reapply-erasures.ts"] &&
      [for e in jsondecode(aws_ecs_task_definition.ops_script["reapply-erasures"].container_definitions)[0].secrets : e.name] == ["DATABASE_URL", "HEALDESK_IDENTIFIER_REF_KEY"] &&
      jsondecode(aws_ecs_task_definition.ops_script["erase-person"].container_definitions)[0].command == ["node", "--import", "tsx", "scripts/ops-erase-person.ts"] &&
      jsondecode(aws_ecs_task_definition.ops_script["amend-contact"].container_definitions)[0].command == ["node", "--import", "tsx", "scripts/ops-amend-contact.ts"] &&
      [for e in jsondecode(aws_ecs_task_definition.ops_script["erase-person"].container_definitions)[0].secrets : e.name] == ["DATABASE_URL", "HEALDESK_IDENTIFIER_REF_KEY"] &&
      [for e in jsondecode(aws_ecs_task_definition.ops_script["amend-contact"].container_definitions)[0].secrets : e.name] == ["DATABASE_URL"] &&
      alltrue([for k, t in aws_ecs_task_definition.ops_script : t.task_role_arn == null && t.family == "healdesk-production-${k}"]) &&
      alltrue([for k, t in aws_ecs_task_definition.ops_script : {
        for e in jsondecode(t.container_definitions)[0].environment : e.name => e.value
      } == { NODE_ENV = "production", NODE_EXTRA_CA_CERTS = "/etc/ssl/rds/us-east-1-bundle.pem" }]) &&
      jsondecode(aws_ecs_task_definition.ops_script["erase-person"].container_definitions)[0].logConfiguration.options["awslogs-group"] == "/healdesk/production/erase-person"
    )
    error_message = "erase-person and amend-contact run their scripts with the runtime URL (and, for erasure, the identifier key) as their only secrets, in production mode, with no task role."
  }

  assert {
    condition = (
      alltrue([for f in ["erase-person", "amend-contact", "reapply-erasures"] : contains(one([for st in data.aws_iam_policy_document.github_deploy.statement : st if st.sid == "RegisterOurTaskDefinitions"]).resources, "arn:aws:ecs:us-east-1:865780386982:task-definition/healdesk-production-${f}:*")]) &&
      !anytrue([for st in data.aws_iam_policy_document.github_deploy.statement : strcontains(jsonencode(st.resources), "erase-person") || strcontains(jsonencode(st.resources), "amend-contact") || strcontains(jsonencode(st.resources), "reapply-erasures") if contains(st.actions, "ecs:RunTask")])
    )
    error_message = "The deploy role registers the operator scripts' revisions but may never run one."
  }

  assert {
    condition     = toset([for r in aws_config_config_rule.managed : r.source[0].source_identifier]) == toset(["RDS_STORAGE_ENCRYPTED", "S3_BUCKET_SSL_REQUESTS_ONLY", "CLOUD_TRAIL_ENCRYPTION_ENABLED", "CLOUDWATCH_LOG_GROUP_ENCRYPTED"])
    error_message = "The four managed Config rules."
  }

  assert {
    condition     = length(aws_guardduty_detector.main) == 1 && aws_sns_topic.alarms.name == "healdesk-production-alarms" && aws_budgets_budget.monthly.limit_amount == "250"
    error_message = "GuardDuty on, the alarm topic named per the contract, the budget at 250."
  }

  assert {
    condition = (
      aws_cloudwatch_metric_alarm.rds_idle_in_transaction.threshold == 300 &&
      aws_cloudwatch_metric_alarm.rds_idle_in_transaction.comparison_operator == "GreaterThanThreshold" &&
      aws_cloudwatch_metric_alarm.rds_idle_in_transaction.treat_missing_data == "notBreaching" &&
      one(aws_cloudwatch_metric_alarm.rds_idle_in_transaction.metric_query).expression == "DB_PERF_INSIGHTS('RDS', 'db-ABCDEFGHIJKLMNOPQRSTUVWXY1', 'db.state.idle_in_transaction_max_time.max')" &&
      one(aws_cloudwatch_metric_alarm.rds_idle_in_transaction.metric_query).period == 60
    )
    error_message = "The idle-in-transaction alarm reads Performance Insights' counter for this instance and fires past five minutes."
  }

  # --- SES on for the transcript email; the transcript bucket stays off ---
  assert {
    condition = (
      length(aws_s3_bucket.transcripts) == 0 && output.transcript_bucket == null &&
      length(aws_sesv2_configuration_set.phi) == 1 &&
      one(aws_sesv2_configuration_set.phi[0].delivery_options).tls_policy == "REQUIRE" &&
      length(aws_sesv2_email_identity.main) == 1 &&
      output.ses_configuration_set == "healdesk-production-phi"
    )
    error_message = "SES is on (a TLS-required configuration set and the domain identity) for the emailed transcripts, and no transcript bucket exists: transcripts are never stored."
  }

  # SES's events reach the app: from this configuration set only, signed (v2),
  # over HTTPS to the public host, and the web task knows which topic to trust.
  assert {
    condition = (
      length(aws_sns_topic.ses_events) == 1 &&
      aws_sns_topic.ses_events[0].name == "healdesk-production-ses-events" &&
      aws_sns_topic.ses_events[0].signature_version == 2 &&
      one(data.aws_iam_policy_document.ses_events[0].statement).actions == toset(["sns:Publish"]) &&
      toset(flatten([for c in one(data.aws_iam_policy_document.ses_events[0].statement).condition : c.values if c.variable == "aws:SourceArn"])) == toset(["arn:aws:ses:us-east-1:865780386982:configuration-set/healdesk-production-phi"]) &&
      toset(flatten([for c in one(data.aws_iam_policy_document.ses_events[0].statement).condition : c.values if c.variable == "aws:SourceAccount"])) == toset(["865780386982"]) &&
      toset(one(aws_sesv2_configuration_set_event_destination.phi_events[0].event_destination).matching_event_types) == toset(["DELIVERY", "BOUNCE", "COMPLAINT", "REJECT", "RENDERING_FAILURE", "DELIVERY_DELAY"]) &&
      aws_sns_topic_subscription.ses_events_app[0].protocol == "https" &&
      aws_sns_topic_subscription.ses_events_app[0].endpoint == "https://app.healdesk.io/api/webhooks/ses" &&
      !aws_sns_topic_subscription.ses_events_app[0].raw_message_delivery &&
      strcontains(aws_ecs_task_definition.web.container_definitions, "HEALDESK_SES_EVENTS_TOPIC_ARN") &&
      !strcontains(aws_ecs_task_definition.worker.container_definitions, "HEALDESK_SES_EVENTS_TOPIC_ARN")
    )
    error_message = "SES's events go to a signed (v2) SNS topic only this configuration set may publish to, subscribed over HTTPS at the app's /api/webhooks/ses, and the web task is told the topic's ARN."
  }

  assert {
    condition     = !strcontains(aws_ecs_task_definition.web.container_definitions, "HEALDESK_TRANSCRIPT_ARCHIVE") && !strcontains(aws_ecs_task_definition.worker.container_definitions, "HEALDESK_TRANSCRIPT_ARCHIVE")
    error_message = "No archive copy of a transcript unless the owner names a mailbox and states it is under a BAA."
  }

  assert {
    condition     = aws_iam_role.app_task.name == "healdesk-production-app-task" && aws_ecs_cluster.main.name == "healdesk-production"
    error_message = "Fixed names from the contract."
  }
}

# ---------------------------------------------------------------------------
# Switches
# ---------------------------------------------------------------------------

run "lock_labels_off" {
  command = plan

  variables {
    kms_require_lock_labels = false
  }

  assert {
    condition = (
      length([for c in one([for st in data.aws_iam_policy_document.app_task.statement : st if st.sid == "CredentialVault"]).condition : c if c.test == "Null" && contains(c.values, "false")]) == 0 &&
      length([for c in one([for st in data.aws_iam_policy_document.app_task.statement : st if st.sid == "CredentialVault"]).condition : c if c.test == "Null" && c.variable == "kms:ViaService"]) == 1 &&
      length([for c in one([for st in data.aws_iam_policy_document.app_task.statement : st if st.sid == "CredentialVault"]).condition : c if c.test == "ForAllValues:StringEquals" && c.variable == "kms:EncryptionContextKeys"]) == 1
    )
    error_message = "With lock labels off the labels are no longer required, but no AWS service's context and no call through a service is allowed either."
  }

  assert {
    condition     = !strcontains(aws_ecs_task_definition.web.container_definitions, "LOCK_LABELS") && !strcontains(aws_ecs_task_definition.worker.container_definitions, "LOCK_LABELS")
    error_message = "The switch shapes IAM only; no task gets an environment variable for it."
  }
}

run "transcript_bucket_and_ses_on" {
  command = plan

  variables {
    enable_transcript_bucket = true
    enable_ses               = true
  }

  assert {
    condition = (
      aws_s3_bucket.transcripts[0].bucket == "healdesk-production-transcripts-865780386982" &&
      one(aws_s3_bucket_server_side_encryption_configuration.transcripts[0].rule).apply_server_side_encryption_by_default[0].sse_algorithm == "aws:kms" &&
      one(aws_s3_bucket_server_side_encryption_configuration.transcripts[0].rule).apply_server_side_encryption_by_default[0].kms_master_key_id == aws_kms_key.main.arn &&
      one(aws_s3_bucket_server_side_encryption_configuration.transcripts[0].rule).bucket_key_enabled &&
      aws_s3_bucket_versioning.transcripts[0].versioning_configuration[0].status == "Enabled" &&
      aws_s3_bucket_public_access_block.transcripts[0].block_public_acls && aws_s3_bucket_public_access_block.transcripts[0].block_public_policy &&
      aws_s3_bucket_public_access_block.transcripts[0].ignore_public_acls && aws_s3_bucket_public_access_block.transcripts[0].restrict_public_buckets &&
      one(aws_s3_bucket_ownership_controls.transcripts[0].rule).object_ownership == "BucketOwnerEnforced"
    )
    error_message = "The transcript bucket is SSE-KMS under our key with bucket keys, versioned, private and owner-enforced."
  }

  assert {
    condition = (
      one([for r in aws_s3_bucket_lifecycle_configuration.transcripts[0].rule : r if r.id == "expire-at-the-longest-clinic-retention"]).expiration[0].days == 90 &&
      one([for r in aws_s3_bucket_lifecycle_configuration.transcripts[0].rule : r if r.id == "deleted-means-gone"]).noncurrent_version_expiration[0].noncurrent_days <= 35 &&
      one([for r in aws_s3_bucket_lifecycle_configuration.transcripts[0].rule : r if r.id == "deleted-means-gone"]).expiration[0].expired_object_delete_marker
    )
    error_message = "Objects expire at the longest clinic retention, and a deleted version is gone within 35 days."
  }

  assert {
    condition = (
      toset([for st in data.aws_iam_policy_document.transcripts_bucket[0].statement : st.sid]) == toset(["DenyAnythingWithoutTls", "DenyUploadsNotUnderKms"]) &&
      alltrue([for st in data.aws_iam_policy_document.transcripts_bucket[0].statement : st.effect == "Deny"])
    )
    error_message = "The bucket policy refuses anything without TLS and any upload not under KMS."
  }

  assert {
    condition = (
      toset([for st in data.aws_iam_policy_document.app_task.statement : st.sid]) == toset([
        "CredentialVault", "S3UsesTheKeyForTranscripts", "TranscriptObjects",
        "SendThroughThePhiConfigurationSet", "ReadThePhiConfigurationSet",
      ]) &&
      toset(flatten([for c in one([for st in data.aws_iam_policy_document.app_task.statement : st if st.sid == "S3UsesTheKeyForTranscripts"]).condition : c.values if c.variable == "kms:ViaService"])) == toset(["s3.us-east-1.amazonaws.com"]) &&
      toset(flatten([for c in one([for st in data.aws_iam_policy_document.app_task.statement : st if st.sid == "S3UsesTheKeyForTranscripts"]).condition : c.values if c.variable == "kms:EncryptionContext:aws:s3:arn"])) == toset(["arn:aws:s3:::healdesk-production-transcripts-865780386982"]) &&
      toset(one([for st in data.aws_iam_policy_document.app_task.statement : st if st.sid == "TranscriptObjects"]).resources) == toset(["arn:aws:s3:::healdesk-production-transcripts-865780386982/*"]) &&
      toset(one([for st in data.aws_iam_policy_document.app_task.statement : st if st.sid == "SendThroughThePhiConfigurationSet"]).resources) == toset([
        "arn:aws:ses:us-east-1:865780386982:identity/healdesk.io",
        "arn:aws:ses:us-east-1:865780386982:configuration-set/healdesk-production-phi",
      ]) &&
      toset(one([for st in data.aws_iam_policy_document.app_task.statement : st if st.sid == "ReadThePhiConfigurationSet"]).actions) == toset(["ses:GetConfigurationSet"])
    )
    error_message = "With both on, the task role gains S3 through KMS for the bucket's own context, the bucket's objects, and SES through the TLS-only set (including GetConfigurationSet), and nothing more."
  }

  assert {
    condition     = toset(flatten([for d in aws_cloudtrail.main.event_selector[0].data_resource : d.values])) == toset(["arn:aws:s3:::healdesk-production-exports-865780386982/", "arn:aws:s3:::healdesk-production-transcripts-865780386982/"])
    error_message = "Every export and transcript object read and write is a CloudTrail data event."
  }

  assert {
    condition = (
      aws_sesv2_configuration_set.phi[0].configuration_set_name == "healdesk-production-phi" &&
      aws_sesv2_configuration_set.phi[0].delivery_options[0].tls_policy == "REQUIRE" &&
      aws_sesv2_email_identity.main[0].email_identity == "healdesk.io" &&
      aws_sesv2_email_identity.main[0].configuration_set_name == "healdesk-production-phi" &&
      length(cloudflare_dns_record.ses_dkim) == 3 &&
      alltrue([for r in cloudflare_dns_record.ses_dkim : !r.proxied && r.type == "CNAME" && endswith(r.name, "._domainkey.healdesk.io") && endswith(r.content, ".dkim.amazonses.com")])
    )
    error_message = "SES sends through a configuration set that requires TLS, with Easy DKIM's three DNS-only records."
  }

  assert {
    condition = alltrue([
      for definition in [aws_ecs_task_definition.web.container_definitions, aws_ecs_task_definition.worker.container_definitions] :
      contains([for e in jsondecode(definition)[0].environment : "${e.name}=${e.value}"], "HEALDESK_SES_CONFIGURATION_SET=healdesk-production-phi") &&
      contains([for e in jsondecode(definition)[0].environment : "${e.name}=${e.value}"], "HEALDESK_EMAIL_TRANSPORT=resend")
    ])
    error_message = "Web and worker learn the configuration set's name, and the transport stays the owner's decision (resend)."
  }

  assert {
    condition     = output.transcript_bucket == "healdesk-production-transcripts-865780386982" && output.ses_configuration_set == "healdesk-production-phi"
    error_message = "The outputs name the bucket and the configuration set while they exist."
  }
}

# The shape first built, every lean switch turned back: the worker as its own
# service with its alarm, NAT gateways, the WAF, X86_64 and the larger sizes.
run "separate_worker_nat_gateway_and_waf" {
  command = plan

  variables {
    worker_placement      = "separate"
    nat_mode              = "gateway"
    nat_gateways          = 2
    enable_waf            = true
    task_cpu_architecture = "X86_64"
    web_cpu               = 512
    web_memory            = 1024
    db_instance_class     = "db.t4g.small"
  }

  assert {
    condition     = toset([for c in jsondecode(aws_ecs_task_definition.web.container_definitions) : c.name]) == toset(["app", "tls-proxy"])
    error_message = "With worker_placement separate the web task runs only the app and the sidecar."
  }

  assert {
    condition = (
      length(aws_ecs_service.worker) == 1 &&
      aws_ecs_service.worker[0].desired_count == 0 &&
      !aws_ecs_service.worker[0].enable_execute_command &&
      aws_ecs_service.worker[0].deployment_circuit_breaker[0].enable && aws_ecs_service.worker[0].deployment_circuit_breaker[0].rollback &&
      aws_ecs_service.worker[0].tags["DesiredCount"] == "1" &&
      aws_ecs_service.worker[0].task_definition == aws_ecs_task_definition.worker.arn &&
      length(aws_cloudwatch_metric_alarm.worker_running) == 1
    )
    error_message = "A separate worker is its own service at 0 tasks, circuit breaker on, ECS Exec off, with its DesiredCount tag and its below-desired alarm."
  }

  assert {
    condition     = aws_ecs_task_definition.web.runtime_platform[0].cpu_architecture == "X86_64" && aws_ecs_task_definition.web.cpu == "512" && aws_ecs_task_definition.web.memory == "1024"
    error_message = "Web follows task_cpu_architecture, web_cpu and web_memory."
  }

  assert {
    condition = (
      length(aws_nat_gateway.main) == 2 && length(aws_eip.nat) == 2 &&
      length(aws_instance.nat) == 0 && length(aws_security_group.nat) == 0 && length(aws_cloudwatch_metric_alarm.nat_instance_status) == 0 &&
      alltrue([for rt in aws_route_table.private : one(rt.route).nat_gateway_id != null && one(rt.route).network_interface_id == null])
    )
    error_message = "nat_mode gateway builds nat_gateways gateways, routes each private subnet to one, and no NAT instance."
  }

  assert {
    condition = (
      length(aws_wafv2_web_acl.main[0].rule) == 1 &&
      one(aws_wafv2_web_acl.main[0].rule).action[0].block[0].custom_response[0].response_code == 429 &&
      one(aws_wafv2_web_acl.main[0].rule).statement[0].rate_based_statement[0].limit == 2000 &&
      length(one(aws_wafv2_web_acl.main[0].rule).statement[0].managed_rule_group_statement) == 0 &&
      length(aws_wafv2_web_acl_association.alb) == 1
    )
    error_message = "With enable_waf the web ACL has one rate-based rule answering 429, no managed groups, and is attached to the load balancer."
  }

  assert {
    condition     = aws_db_instance.main.instance_class == "db.t4g.small" && aws_cloudwatch_metric_alarm.rds_freeable_memory.threshold == 268435456
    error_message = "On a db.t4g.small the freeable-memory alarm stays at 256 MiB."
  }
}

# The Retell voice endpoint switched on, with two tasks. Its target group gets
# an ARN of its own so the rules can be told apart from the web group's.
run "voice_on" {
  command = plan

  variables {
    enable_voice  = true
    voice_desired = 2
  }

  override_resource {
    target          = aws_lb_target_group.voice
    override_during = plan
    values = {
      arn        = "arn:aws:elasticloadbalancing:us-east-1:865780386982:targetgroup/healdesk-production-voice-tls/fedcba9876543210"
      arn_suffix = "targetgroup/healdesk-production-voice-tls/fedcba9876543210"
    }
  }

  # --- the task: the voice process as "app", then the sidecar ---
  assert {
    condition     = [for c in jsondecode(aws_ecs_task_definition.voice[0].container_definitions) : c.name] == ["app", "tls-proxy"]
    error_message = "The voice task runs the voice process, named app, and the tls-proxy sidecar, nothing else."
  }

  assert {
    condition = (
      one([for c in jsondecode(aws_ecs_task_definition.voice[0].container_definitions) : c if c.name == "app"]).command == ["node", "--import", "tsx", "src/voice/server.ts"] &&
      one([for c in jsondecode(aws_ecs_task_definition.voice[0].container_definitions) : c if c.name == "app"]).workingDirectory == "/repo/apps/app" &&
      one([for c in jsondecode(aws_ecs_task_definition.voice[0].container_definitions) : c if c.name == "app"]).stopTimeout == 120 &&
      one([for c in jsondecode(aws_ecs_task_definition.voice[0].container_definitions) : c if c.name == "app"]).linuxParameters.initProcessEnabled &&
      one([for c in jsondecode(aws_ecs_task_definition.voice[0].container_definitions) : c if c.name == "app"]).essential &&
      length(one([for c in jsondecode(aws_ecs_task_definition.voice[0].container_definitions) : c if c.name == "app"]).portMappings) == 0 &&
      one([for c in jsondecode(aws_ecs_task_definition.voice[0].container_definitions) : c if c.name == "app"]).logConfiguration.options["awslogs-group"] == "/healdesk/production/voice"
    )
    error_message = "The voice process runs node --import tsx src/voice/server.ts in /repo/apps/app under ECS's init, with stopTimeout 120, no port of its own behind the sidecar, and its own log group."
  }

  assert {
    condition = (
      strcontains(join(" ", one([for c in jsondecode(aws_ecs_task_definition.voice[0].container_definitions) : c if c.name == "app"]).healthCheck.command), "http://127.0.0.1:3001/health'") &&
      one([for c in jsondecode(aws_ecs_task_definition.voice[0].container_definitions) : c if c.name == "app"]).healthCheck.startPeriod == 60 &&
      contains(one([for c in jsondecode(aws_ecs_task_definition.voice[0].container_definitions) : c if c.name == "tls-proxy"]).healthCheck.command, "https://127.0.0.1:8443/health") &&
      !strcontains(jsonencode(one([for c in jsondecode(aws_ecs_task_definition.voice[0].container_definitions) : c if c.name == "tls-proxy"]).healthCheck), "/api/health")
    )
    error_message = "The voice process and its sidecar are checked on the process's own /health, never the web tier's liveness path, which it answers 404."
  }

  # The sidecar is the web task's in everything but its health check.
  assert {
    condition = (
      merge(one([for c in jsondecode(aws_ecs_task_definition.voice[0].container_definitions) : c if c.name == "tls-proxy"]), { healthCheck = null }) ==
      merge(one([for c in jsondecode(aws_ecs_task_definition.web.container_definitions) : c if c.name == "tls-proxy"]), { healthCheck = null })
    )
    error_message = "The voice task's sidecar must be the web task's (image, port 8443, keep-alive, waiting for a healthy app, logs), but for its health check."
  }

  assert {
    condition = (
      {
        for e in one([for c in jsondecode(aws_ecs_task_definition.voice[0].container_definitions) : c if c.name == "app"]).environment : e.name => e.value
        } == merge({
          for e in one([for c in jsondecode(aws_ecs_task_definition.web.container_definitions) : c if c.name == "app"]).environment : e.name => e.value
          if !contains(["KEEP_ALIVE_TIMEOUT", "HEALDESK_SES_EVENTS_TOPIC_ARN"], e.name)
      }, { PORT = "3001", HOSTNAME = "0.0.0.0" })
    )
    error_message = "The voice process gets the web tier's plain environment, on PORT 3001 and HOSTNAME 0.0.0.0, without the web tier's keep-alive and SNS topic."
  }

  assert {
    condition = (
      one([for c in jsondecode(aws_ecs_task_definition.voice[0].container_definitions) : c if c.name == "app"]).secrets ==
      one([for c in jsondecode(aws_ecs_task_definition.web.container_definitions) : c if c.name == "app"]).secrets &&
      contains(one([for c in jsondecode(aws_ecs_task_definition.voice[0].container_definitions) : c if c.name == "app"]).secrets, {
        name      = "HEALDESK_RETELL_LLM_SECRET"
        valueFrom = "arn:aws:ssm:us-east-1:865780386982:parameter/healdesk/production/app/HEALDESK_RETELL_LLM_SECRET"
      })
    )
    error_message = "The voice process gets the web tier's secrets, HEALDESK_RETELL_LLM_SECRET among them, from its own parameter."
  }

  assert {
    condition = alltrue([
      for name in ["MIGRATION_DATABASE_URL", "HEALDESK_LOCAL_KEK", "HEALDESK_DIRECT_BOOKING_ENABLED", "HEALDESK_PHASE_TWO_ATTRIBUTION", "BETTER_AUTH_SECRETS", "APP_PASSWORD", "MIGRATOR_PASSWORD"] :
      !strcontains(aws_ecs_task_definition.voice[0].container_definitions, "\"${name}\"")
    ])
    error_message = "A never-set variable appears in the voice task definition."
  }

  assert {
    condition = (
      aws_ecs_task_definition.voice[0].family == "healdesk-production-voice" &&
      aws_ecs_task_definition.voice[0].cpu == "256" && aws_ecs_task_definition.voice[0].memory == "1024" &&
      aws_ecs_task_definition.voice[0].runtime_platform[0].cpu_architecture == "ARM64" &&
      aws_ecs_task_definition.voice[0].task_role_arn == aws_iam_role.app_task.arn &&
      aws_ecs_task_definition.voice[0].execution_role_arn == aws_iam_role.ecs_execution.arn
    )
    error_message = "The voice task is healdesk-production-voice, 0.25 vCPU and 1 GB on ARM64, with the app's task role and the execution role."
  }

  # --- the load balancer: its own group, drained for an hour, and one rule ---
  assert {
    condition = (
      aws_lb_target_group.voice[0].name == "healdesk-production-voice-tls" &&
      aws_lb_target_group.voice[0].protocol == "HTTPS" && aws_lb_target_group.voice[0].port == 8443 &&
      aws_lb_target_group.voice[0].protocol_version == "HTTP1" && aws_lb_target_group.voice[0].target_type == "ip" &&
      tostring(aws_lb_target_group.voice[0].deregistration_delay) == "3600" &&
      aws_lb_target_group.voice[0].health_check[0].path == "/health" &&
      aws_lb_target_group.voice[0].health_check[0].matcher == "200" &&
      aws_lb_target_group.voice[0].health_check[0].protocol == "HTTPS"
    )
    error_message = "The voice group is HTTPS:8443 over HTTP/1.1 to task IPs, health-checked on /health, and drains for 3600 s so a deploy cuts no call."
  }

  assert {
    condition = (
      aws_lb_listener_rule.voice[0].action[0].type == "forward" &&
      aws_lb_listener_rule.voice[0].action[0].target_group_arn == aws_lb_target_group.voice[0].arn &&
      aws_lb_target_group.voice[0].arn != aws_lb_target_group.web.arn &&
      toset(flatten([for c in aws_lb_listener_rule.voice[0].condition : tolist(c.host_header[0].values) if length(c.host_header) > 0])) == toset(["app.healdesk.io"]) &&
      toset(flatten([for c in aws_lb_listener_rule.voice[0].condition : tolist(c.path_pattern[0].values) if length(c.path_pattern) > 0])) == toset(["/llm-websocket/*"]) &&
      aws_lb_listener_rule.public.action[0].target_group_arn == aws_lb_target_group.web.arn
    )
    error_message = "/llm-websocket/* on the public host, and only there, goes to the voice group; everything else on it still goes to the web tier."
  }

  assert {
    condition = (
      aws_lb_listener_rule.voice[0].priority > max([for r in aws_lb_listener_rule.public_refuses_signed : r.priority]...) &&
      aws_lb_listener_rule.voice[0].priority < aws_lb_listener_rule.public.priority &&
      aws_lb_listener_rule.voice[0].priority > aws_lb_listener_rule.internal_nothing_else.priority
    )
    error_message = "The voice rule is decided after the public host's refusals of the signed paths and before its catch-all."
  }

  # --- the service ---
  assert {
    condition = (
      aws_ecs_service.voice[0].name == "healdesk-production-voice" &&
      aws_ecs_service.voice[0].desired_count == 0 &&
      aws_ecs_service.voice[0].tags["DesiredCount"] == "2" &&
      !aws_ecs_service.voice[0].enable_execute_command &&
      aws_ecs_service.voice[0].deployment_circuit_breaker[0].enable && aws_ecs_service.voice[0].deployment_circuit_breaker[0].rollback &&
      aws_ecs_service.voice[0].deployment_minimum_healthy_percent == 100 && aws_ecs_service.voice[0].deployment_maximum_percent == 200 &&
      aws_ecs_service.voice[0].task_definition == aws_ecs_task_definition.voice[0].arn &&
      one(aws_ecs_service.voice[0].load_balancer).target_group_arn == aws_lb_target_group.voice[0].arn &&
      one(aws_ecs_service.voice[0].load_balancer).container_name == "tls-proxy" &&
      one(aws_ecs_service.voice[0].load_balancer).container_port == 8443 &&
      !one(aws_ecs_service.voice[0].network_configuration).assign_public_ip &&
      aws_ecs_service.voice[0].timeouts.delete == "65m"
    )
    error_message = "The voice service starts at 0 tasks with its DesiredCount tag from voice_desired, circuit breaker on, ECS Exec off, behind the sidecar's 8443 in its own group, and waits out its drain when deleted."
  }

  # --- the deploy role may register the family and roll the service, never run it ---
  assert {
    condition = (
      contains(one([for st in data.aws_iam_policy_document.github_deploy.statement : st if st.sid == "RegisterOurTaskDefinitions"]).resources, "arn:aws:ecs:us-east-1:865780386982:task-definition/healdesk-production-voice:*") &&
      contains(one([for st in data.aws_iam_policy_document.github_deploy.statement : st if st.sid == "RollOurServices"]).resources, "arn:aws:ecs:us-east-1:865780386982:service/healdesk-production/healdesk-production-voice") &&
      contains(one([for st in data.aws_iam_policy_document.github_deploy.statement : st if st.sid == "TagOnlyWhileCreating"]).resources, "arn:aws:ecs:us-east-1:865780386982:task-definition/healdesk-production-voice:*") &&
      length(one([for st in data.aws_iam_policy_document.github_deploy.statement : st if st.sid == "RollOurServices"]).resources) == 3 &&
      !anytrue([for st in data.aws_iam_policy_document.github_deploy.statement : strcontains(jsonencode(st.resources), "voice") if contains(st.actions, "ecs:RunTask")])
    )
    error_message = "The deploy role registers voice revisions and updates the voice service (and only web, worker and voice), but never runs a voice task."
  }

  # --- alarm and outputs ---
  assert {
    condition = (
      length(aws_cloudwatch_metric_alarm.voice_running) == 1 &&
      aws_cloudwatch_metric_alarm.voice_running[0].alarm_name == "healdesk-production-voice-below-desired" &&
      aws_cloudwatch_metric_alarm.voice_running[0].metric_name == "HealthyHostCount" &&
      aws_cloudwatch_metric_alarm.voice_running[0].threshold == 2 &&
      aws_cloudwatch_metric_alarm.voice_running[0].comparison_operator == "LessThanThreshold" &&
      aws_cloudwatch_metric_alarm.voice_running[0].treat_missing_data == "breaching" &&
      aws_cloudwatch_metric_alarm.voice_running[0].dimensions["TargetGroup"] == "targetgroup/healdesk-production-voice-tls/fedcba9876543210"
    )
    error_message = "voice-below-desired fires when the voice group has fewer healthy targets than voice_desired, or none report."
  }

  assert {
    condition = (
      output.voice_websocket_url == "wss://app.healdesk.io/llm-websocket/<HEALDESK_RETELL_LLM_SECRET>/<clinic id>" &&
      output.voice_service == "healdesk-production-voice" &&
      !strcontains(output.voice_websocket_url, "__unset__")
    )
    error_message = "The outputs give Retell's URL with the secret and the clinic id as placeholders, and the service's name."
  }
}

# Voice without the encrypted hop, under the longest environment name: no
# sidecar, the process's own 3001 mapped, and a group name that still fits.
run "voice_on_plain_http_longest_environment" {
  command = plan

  variables {
    enable_voice    = true
    alb_to_task_tls = false
    environment     = "productionab"
  }

  assert {
    condition = (
      [for c in jsondecode(aws_ecs_task_definition.voice[0].container_definitions) : c.name] == ["app"] &&
      jsondecode(aws_ecs_task_definition.voice[0].container_definitions)[0].portMappings[0].containerPort == 3001 &&
      aws_lb_target_group.voice[0].protocol == "HTTP" && aws_lb_target_group.voice[0].port == 3001 &&
      aws_lb_target_group.voice[0].health_check[0].protocol == "HTTP" &&
      one(aws_ecs_service.voice[0].load_balancer).container_name == "app" &&
      one(aws_ecs_service.voice[0].load_balancer).container_port == 3001 &&
      aws_lb_target_group.voice[0].name == "healdesk-productionab-voice-http" &&
      length(aws_lb_target_group.voice[0].name) <= 32
    )
    error_message = "Without alb_to_task_tls the voice task has no sidecar and its group is HTTP:3001 on the process; the group's name fits AWS's 32 characters at the longest environment."
  }
}

run "refuses_a_voice_size_fargate_does_not_offer_and_a_fifth_task" {
  command = plan

  variables {
    voice_cpu     = 256
    voice_memory  = 4096
    voice_desired = 5
  }

  expect_failures = [var.voice_memory, var.voice_desired]
}

run "refuses_a_web_size_fargate_does_not_offer" {
  command = plan

  variables {
    web_cpu    = 256
    web_memory = 4096
  }

  expect_failures = [var.web_memory]
}

run "refuses_another_worker_placement" {
  command = plan

  variables {
    worker_placement = "both"
  }

  expect_failures = [var.worker_placement]
}

run "plain_http_to_tasks" {
  command = plan

  variables {
    alb_to_task_tls  = false
    alb_idle_timeout = 300
  }

  assert {
    condition     = [for c in jsondecode(aws_ecs_task_definition.web.container_definitions) : c.name] == ["app", "worker"]
    error_message = "Without alb_to_task_tls there is no sidecar: the app first, then the shared worker."
  }

  assert {
    condition     = jsondecode(aws_ecs_task_definition.web.container_definitions)[0].portMappings[0].containerPort == 3001
    error_message = "Without the sidecar the app's 3001 is mapped."
  }

  assert {
    condition     = aws_lb_target_group.web.protocol == "HTTP" && aws_lb_target_group.web.port == 3001 && one(aws_ecs_service.web.load_balancer).container_name == "app" && one(aws_ecs_service.web.load_balancer).container_port == 3001
    error_message = "Without alb_to_task_tls the target group is HTTP:3001 on the app container."
  }

  assert {
    condition     = jsondecode(aws_ecs_task_definition.web.container_definitions)[0].environment[index([for e in jsondecode(aws_ecs_task_definition.web.container_definitions)[0].environment : e.name], "KEEP_ALIVE_TIMEOUT")].value == "305000"
    error_message = "KEEP_ALIVE_TIMEOUT follows alb_idle_timeout."
  }
}

run "public_ids_ops_email_and_app_environment" {
  command = plan

  variables {
    meta_app_id              = "1234567890"
    stripe_connect_client_id = "ca_Test123"
    healdesk_ops_email       = "ops@example.com"
    alb_idle_timeout         = 300
    app_environment = {
      HEALDESK_SUPPORT_PHONE    = "+15555550100"
      HEALDESK_CALL_BOOKING_URL = "https://example.com/book"
    }
  }

  assert {
    condition = alltrue([
      for name in ["META_APP_ID", "STRIPE_CONNECT_CLIENT_ID", "HEALDESK_OPS_EMAIL", "HEALDESK_SUPPORT_PHONE", "HEALDESK_CALL_BOOKING_URL"] :
      contains([for e in one([for c in jsondecode(aws_ecs_task_definition.web.container_definitions) : c if c.name == "app"]).environment : e.name], name)
    ])
    error_message = "Filled public ids and app_environment reach the web tier."
  }

  assert {
    condition = (
      contains([for e in jsondecode(aws_ecs_task_definition.worker.container_definitions)[0].environment : e.name], "STRIPE_CONNECT_CLIENT_ID") &&
      contains([for e in jsondecode(aws_ecs_task_definition.worker.container_definitions)[0].environment : e.name], "HEALDESK_OPS_EMAIL") &&
      contains([for e in jsondecode(aws_ecs_task_definition.worker.container_definitions)[0].environment : e.name], "HEALDESK_SUPPORT_PHONE") &&
      !contains([for e in jsondecode(aws_ecs_task_definition.worker.container_definitions)[0].environment : e.name], "META_APP_ID")
    )
    error_message = "The worker gets the Connect client id, the ops address and app_environment, not the Meta ids."
  }

  assert {
    condition     = one([for c in jsondecode(aws_ecs_task_definition.web.container_definitions) : c if c.name == "tls-proxy"]).environment == [{ name = "TLS_PROXY_KEEPALIVE_SECONDS", value = "310" }]
    error_message = "The sidecar's keep-alive follows alb_idle_timeout."
  }
}

run "guardduty_can_be_left_to_an_imported_detector" {
  command = plan

  variables {
    enable_guardduty = false
  }

  assert {
    condition     = length(aws_guardduty_detector.main) == 0
    error_message = "enable_guardduty = false creates no detector."
  }
}

# ---------------------------------------------------------------------------
# Refusals
# ---------------------------------------------------------------------------

run "refuses_another_region" {
  command = plan
  variables {
    region = "us-west-2"
  }
  expect_failures = [var.region]
}

run "refuses_a_long_environment_name" {
  command = plan
  variables {
    environment = "productionabc"
  }
  expect_failures = [var.environment]
}

run "refuses_one_origin_for_both" {
  command = plan
  variables {
    internal_hostname = "app.healdesk.io"
  }
  expect_failures = [var.internal_hostname]
}

run "refuses_an_internal_host_outside_healdesk_io" {
  command = plan
  variables {
    internal_hostname = "app-internal.example.com"
  }
  expect_failures = [var.internal_hostname]
}

run "refuses_an_environment_subject" {
  command = plan
  variables {
    github_oidc_subjects = ["repo:liamariavisoiu-ai98@262780224/healdesk.io@1326499636:environment:production"]
  }
  expect_failures = [var.github_oidc_subjects]
}

run "refuses_a_branch_subject" {
  command = plan
  variables {
    github_oidc_subjects = ["repo:liamariavisoiu-ai98@262780224/healdesk.io@1326499636:ref:refs/heads/feature"]
  }
  expect_failures = [var.github_oidc_subjects]
}

run "refuses_a_wildcard_subject" {
  command = plan
  variables {
    github_oidc_subjects = ["repo:liamariavisoiu-ai98@262780224/healdesk.io@1326499636:*:ref:refs/heads/main"]
  }
  expect_failures = [var.github_oidc_subjects]
}

run "refuses_an_actor_name" {
  command = plan
  variables {
    github_actor_id = "liamariavisoiu-ai98"
  }
  expect_failures = [var.github_actor_id]
}

run "refuses_the_booking_switch" {
  command = plan
  variables {
    app_environment = { HEALDESK_DIRECT_BOOKING_ENABLED = "true" }
  }
  expect_failures = [var.app_environment]
}

run "refuses_the_phase_two_switch" {
  command = plan
  variables {
    app_environment = { HEALDESK_PHASE_TWO_ATTRIBUTION = "true" }
  }
  expect_failures = [var.app_environment]
}

run "refuses_a_secret_as_plain_environment" {
  command = plan
  variables {
    app_environment = { STRIPE_SECRET_KEY = "sk_test_x" }
  }
  expect_failures = [var.app_environment]
}

run "refuses_overriding_the_stack" {
  command = plan
  variables {
    app_environment = { HEALDESK_KMS_PROVIDER = "local" }
  }
  expect_failures = [var.app_environment]
}

run "refuses_a_blank_or_placeholder_setting" {
  command = plan
  variables {
    app_environment = { HEALDESK_SUPPORT_PHONE = " ", HEALDESK_CALL_BOOKING_URL = "__unset__" }
  }
  expect_failures = [var.app_environment]
}

run "refuses_a_short_transcript_retention" {
  command = plan
  variables {
    transcript_retention_days = 3
  }
  expect_failures = [var.transcript_retention_days]
}

run "refuses_the_missing_personal_values" {
  command = plan
  variables {
    cloudflare_zone_id   = ""
    alarm_email          = ""
    healdesk_admin_email = ""
  }
  expect_failures = [var.cloudflare_zone_id, var.alarm_email, var.healdesk_admin_email]
}

run "transcript_archive_needs_the_baa_statement" {
  command = plan

  variables {
    transcript_archive_to = "transcripts@healdesk.io"
  }

  expect_failures = [var.transcript_archive_to]
}

run "transcript_archive_with_the_baa_statement" {
  command = plan

  variables {
    transcript_archive_to         = "transcripts@healdesk.io"
    transcript_archive_baa_signed = true
  }

  assert {
    condition = (
      strcontains(aws_ecs_task_definition.web.container_definitions, "transcripts@healdesk.io") &&
      strcontains(aws_ecs_task_definition.worker.container_definitions, "transcripts@healdesk.io") &&
      strcontains(aws_ecs_task_definition.worker.container_definitions, "HEALDESK_TRANSCRIPT_ARCHIVE_BAA")
    )
    error_message = "With a mailbox and the owner's BAA statement, both tasks that send transcripts get the archive address and the statement."
  }
}
