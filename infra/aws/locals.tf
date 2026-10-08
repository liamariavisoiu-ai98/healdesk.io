data "aws_caller_identity" "current" {}

locals {
  # Every name is generic: healdesk-<environment>-<role>. No clinic, patient or
  # slug ever goes into a name, a tag or a log-stream prefix.
  name       = "healdesk-${var.environment}"
  account_id = data.aws_caller_identity.current.account_id
  azs        = ["${var.region}a", "${var.region}b"]
  app_url    = "https://${var.app_domain}"

  param_prefix = "/healdesk/${var.environment}"
  log_prefix   = "/healdesk/${var.environment}"

  # Production keeps the repository names the deploy workflow derives
  # (healdesk/app, healdesk/db-admin, healdesk/tls-proxy); a staging state
  # gets its own namespace instead of colliding with them.
  ecr_namespace = var.environment == "production" ? "healdesk" : "healdesk-${var.environment}"

  # The image tag Terraform's own task definition revisions point at. Nothing
  # pushes it and nothing pulls it: the services are created at desired 0, and
  # the deploy workflow registers a new revision with the git SHA tag (from the
  # family's latest revision, so Terraform's environment changes carry over)
  # before any task runs.
  placeholder_image_tag = "terraform-placeholder"

  # The Amazon RDS us-east-1 CA bundle, baked into the app image (and the
  # db-admin image) at this path. Node's own trust store lacks the RDS roots.
  rds_ca_bundle = "/etc/ssl/rds/us-east-1-bundle.pem"

  db_name     = "healdesk"
  db_port     = 5432
  db_username = "healdesk_admin"

  # The load balancer forwards to the sidecar's TLS port when the hop is
  # encrypted, otherwise straight to Next.
  web_target_container = var.alb_to_task_tls ? "tls-proxy" : "app"
  web_target_port      = var.alb_to_task_tls ? 8443 : 3001
  web_target_protocol  = var.alb_to_task_tls ? "HTTPS" : "HTTP"

  # Above the load balancer's idle timeout, in milliseconds (see the variable).
  keep_alive_timeout_ms = (var.alb_idle_timeout + 5) * 1000

  # --- Plain environment (contract section 3). Never a secret here: task
  # definitions are readable through DescribeTaskDefinition, and the request
  # that registers one is recorded by CloudTrail. Optional values that are
  # empty are left out entirely rather than set to "", so the app sees them
  # as unset. HEALDESK_APP_URL is never set on this host: on apps/app it is a
  # deny-list for email links and would refuse every portal link.
  app_environment_common = merge(
    {
      NODE_ENV                 = "production"
      BETTER_AUTH_URL          = local.app_url
      HEALDESK_KMS_PROVIDER    = "aws-kms"
      HEALDESK_KMS_KEY_ID      = aws_kms_key.main.arn
      AWS_REGION               = var.region
      HEALDESK_EMAIL_TRANSPORT = "resend"
      HEALDESK_EMAIL_FROM      = var.healdesk_email_from
      HEALDESK_ADMIN_EMAIL     = var.healdesk_admin_email
      NODE_EXTRA_CA_CERTS      = local.rds_ca_bundle
    },
    { for k, v in { HEALDESK_OPS_EMAIL = var.healdesk_ops_email } : k => v if v != "" },
  )

  web_environment = merge(
    local.app_environment_common,
    {
      PORT               = "3001"
      HOSTNAME           = "0.0.0.0"
      KEEP_ALIVE_TIMEOUT = tostring(local.keep_alive_timeout_ms)
    },
    {
      for k, v in {
        META_APP_ID              = var.meta_app_id
        META_LOGIN_CONFIG_ID     = var.meta_login_config_id
        META_WHATSAPP_CONFIG_ID  = var.meta_whatsapp_config_id
        STRIPE_CONNECT_CLIENT_ID = var.stripe_connect_client_id
      } : k => v if v != ""
    },
  )

  # The worker reads STRIPE_CONNECT_CLIENT_ID too: billing-reconcile's
  # offboarding calls disconnectStripeConnect, which cannot revoke a
  # connected account's access without it (lib/billing/connect.ts).
  worker_environment = merge(
    local.app_environment_common,
    { for k, v in { STRIPE_CONNECT_CLIENT_ID = var.stripe_connect_client_id } : k => v if v != "" },
  )

  # --- Secrets, injected by ECS from SSM at task start (contract section 3).
  # The web tier gets every app/* parameter; the worker gets the six the
  # contract names; the migrate task gets only the migrator URL.
  app_secret_arns = merge(
    {
      DATABASE_URL                = aws_ssm_parameter.database_url.arn
      BETTER_AUTH_SECRET          = aws_ssm_parameter.better_auth_secret.arn
      HEALDESK_IDENTIFIER_REF_KEY = aws_ssm_parameter.identifier_ref_key.arn
    },
    { for name, p in aws_ssm_parameter.external : name => p.arn },
  )

  web_secret_names = sort(keys(local.app_secret_arns))

  worker_secret_names = [
    "BETTER_AUTH_SECRET",
    "DATABASE_URL",
    "HEALDESK_IDENTIFIER_REF_KEY",
    "HEALDESK_PROVISION_SECRET",
    "RESEND_API_KEY",
    "STRIPE_SECRET_KEY",
  ]

  # Never given to the web or worker tasks, as environment or as a secret
  # (contract section 3); the task definitions refuse to plan if one appears.
  # HEALDESK_APP_URL would block every portal email; the migrator URL belongs
  # to the migrate task alone; the local KEK is development-only; the two
  # switches are owner- and counsel-gated; BETTER_AUTH_SECRETS would silently
  # take precedence over BETTER_AUTH_SECRET.
  never_on_app_tasks = [
    "HEALDESK_APP_URL",
    "MIGRATION_DATABASE_URL",
    "HEALDESK_LOCAL_KEK",
    "HEALDESK_DIRECT_BOOKING_ENABLED",
    "HEALDESK_PHASE_TWO_ATTRIBUTION",
    "BETTER_AUTH_SECRETS",
  ]

  # Shared by every container: the awslogs driver in non-blocking mode with a
  # 25 MB buffer. Blocking mode would stall the app's stdout, and with it
  # patient traffic, whenever CloudWatch Logs is slow to accept; the audit
  # trail that must not be lost lives in the database, not in these logs.
  log_driver_options = {
    awslogs-region  = var.region
    mode            = "non-blocking"
    max-buffer-size = "25m"
  }
}
