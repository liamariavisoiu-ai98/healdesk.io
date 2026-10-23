data "aws_caller_identity" "current" {}

locals {
  # Every name is generic: healdesk-<environment>-<role>. No clinic, patient or
  # slug ever goes into a name, a tag or a log-stream prefix.
  name       = "healdesk-${var.environment}"
  account_id = data.aws_caller_identity.current.account_id
  azs        = ["${var.region}a", "${var.region}b"]

  # Two origins on one load balancer and one certificate. The public one is
  # BETTER_AUTH_URL: browsers, Stripe, Meta and Google, and every link a clinic
  # is mailed. The internal one is HEALDESK_APP_URL: apps/web's signed server
  # calls and nothing else (alb.tf). apps/app refuses to mail a link to
  # HEALDESK_APP_URL (lib/email/lint.ts), which is why the two must differ.
  app_url      = "https://${var.app_domain}"
  internal_url = "https://${var.internal_hostname}"

  param_prefix = "/healdesk/${var.environment}"
  log_prefix   = "/healdesk/${var.environment}"

  # Production keeps the repository names the deploy workflow derives
  # (healdesk/app, healdesk/db-admin, healdesk/tls-proxy); a staging state
  # gets its own namespace instead of colliding with them.
  ecr_namespace = var.environment == "production" ? "healdesk" : "healdesk-${var.environment}"

  # The image tag Terraform's own task definition revisions point at. Nothing
  # ever pushes it. The services are created at desired 0, and the deploy
  # workflow registers a new revision with the git SHA tag (from the family's
  # latest revision, so Terraform's environment changes carry over) before any
  # task runs. Terraform's revisions stay ACTIVE all the same, so two things
  # can still select one: a manual rollback by revision number (choose the
  # revision by its image instead, as the README says), and the circuit
  # breaker after a failed first deploy, when this placeholder is the only
  # completed deployment to return to (deploy-app.yml sets the service back to
  # 0 tasks instead).
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

  # --- The signed routes: every apps/app path apps/web calls on
  # HEALDESK_APP_URL, each authenticated by an HMAC over the body with
  # HEALDESK_PROVISION_SECRET (all POST). Read from the code, both ends:
  #
  #   /api/provision                 apps/web webhooks/stripe (first invoice.paid),
  #                                  checkout (development path); apps/app api/provision
  #   /api/billing/events            apps/web webhooks/stripe relay; apps/app api/billing/events
  #   /api/ops                       apps/web lib/admin/ops-client.ts (and /welcome's
  #                                  welcomeHandoff); apps/app api/ops
  #   /api/reviews/verify            apps/web api/reviews; apps/app api/reviews/verify
  #
  # Since 14 October 2026 signing, the agreement's PDF and Pay run on apps/web
  # alone (docs/design/checkout-records-on-vercel-2026-10-14.md), so
  # /api/agreements, /api/agreements/<id>/pdf, /api/checkout/intents and
  # /api/checkout/intents/session are gone from both ends.
  #
  # alb.tf serves them only on the internal host and answers 404 for them on
  # the public one. A new signed route has to be added here, or apps/web's
  # calls to it get the internal host's 404.
  signed_paths = [
    "/api/provision",
    "/api/billing/events",
    "/api/ops",
    "/api/reviews/verify",
  ]

  # --- Plain environment (contract section 3). Never a secret here: task
  # definitions are readable through DescribeTaskDefinition, and the request
  # that registers one is recorded by CloudTrail. Optional values that are
  # empty are left out entirely rather than set to "", so the app sees them
  # as unset.
  app_environment_common = merge(
    var.app_environment,
    {
      NODE_ENV                 = "production"
      BETTER_AUTH_URL          = local.app_url
      HEALDESK_APP_URL         = local.internal_url
      HEALDESK_KMS_PROVIDER    = "aws-kms"
      HEALDESK_KMS_KEY_ID      = aws_kms_key.main.arn
      AWS_REGION               = var.region
      HEALDESK_EMAIL_TRANSPORT = "resend"
      HEALDESK_EMAIL_FROM      = var.healdesk_email_from
      HEALDESK_ADMIN_EMAIL     = var.healdesk_admin_email
      NODE_EXTRA_CA_CERTS      = local.rds_ca_bundle
    },
    { for k, v in { HEALDESK_OPS_EMAIL = var.healdesk_ops_email } : k => v if v != "" },
    # The ops console's public origin, which an ops alert's email and Slack
    # copy link to, under /admin/ only (lib/email/lint.ts; owner decision D3,
    # 23 October 2026). Not a secret. Empty turns those links off.
    { for k, v in { HEALDESK_CONSOLE_ORIGIN = var.console_origin } : k => v if v != "" },
    var.enable_ses ? { HEALDESK_SES_CONFIGURATION_SET = local.ses_configuration_set_name } : {},
  )

  web_environment = merge(
    local.app_environment_common,
    {
      PORT               = "3001"
      HOSTNAME           = "0.0.0.0"
      KEEP_ALIVE_TIMEOUT = tostring(local.keep_alive_timeout_ms)
    },
    # Only the web tier answers SNS (app/api/webhooks/ses).
    var.enable_ses ? { HEALDESK_SES_EVENTS_TOPIC_ARN = aws_sns_topic.ses_events[0].arn } : {},
    # Tells /admin/map that the voice endpoint exists (lib/ops/key-presence.ts).
    # HEALDESK_RETELL_LLM_SECRET cannot: the web tier gets every app/*
    # parameter, so it reads as present the moment it is pasted, with the voice
    # service, its target group and its listener rule still switched off.
    var.enable_voice ? { HEALDESK_VOICE_ENABLED = "1" } : {},
    # And whether it answers real patients or only the demo clinic. The voice
    # task and the worker (below) carry the same switch and act on it.
    var.voice_real_calls ? { HEALDESK_VOICE_REAL_CALLS = "1" } : {},
    # The owner's provisioning switch. The web task runs retryVoiceAgent from
    # the ops API (lib/ops/voice-agent-ops.ts), under the same guard a
    # scheduled run has, so without it there a retry would answer "switched
    # off" while the worker bought numbers.
    var.voice_provision_enabled ? { HEALDESK_VOICE_PROVISION_ENABLED = "1" } : {},
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
  # And HEALDESK_VOICE_REAL_CALLS: the worker answers no call, but it runs the
  # backstop for a call the voice task never recorded (lib/voice/backstop.ts),
  # which reads the voice line's own switch (lib/voice/test-calls.ts). Without
  # it here, once real calls are on, the backstop would stay in test mode and
  # drop every real clinic's lost call. Both placements get it: the shared
  # "worker" container and the worker task are the same container (ecs.tf).
  worker_environment = merge(
    local.app_environment_common,
    { for k, v in { STRIPE_CONNECT_CLIENT_ID = var.stripe_connect_client_id } : k => v if v != "" },
    var.voice_real_calls ? { HEALDESK_VOICE_REAL_CALLS = "1" } : {},
    # And HEALDESK_VOICE_PROVISION_ENABLED (voice_provision_enabled): the
    # hourly sweep that queues each paid clinic's Retell agent and number, and
    # the voice-provision job that buys it, run here (lib/voice/
    # provision-job.ts, workers/index.ts), in either placement. The voice task
    # runs neither.
    var.voice_provision_enabled ? { HEALDESK_VOICE_PROVISION_ENABLED = "1" } : {},
  )

  # The voice endpoint (enable_voice, src/voice/server.ts): the common
  # environment and the address the sidecar proxies to. Nothing web-only: it
  # answers no SNS, Meta or Stripe Connect callback, takes no card, and reads
  # no KEEP_ALIVE_TIMEOUT (it is a plain Node server, not Next). A choice of
  # model (HEALDESK_VOICE_MODEL) is app_environment's, like any other public
  # setting. HEALDESK_VOICE_REAL_CALLS (voice_real_calls) is the one switch
  # that lets it answer a real patient; without it, only the made-up demo
  # clinic's calls are answered (src/lib/voice/test-calls.ts).
  voice_environment = merge(
    local.app_environment_common,
    {
      PORT     = "3001"
      HOSTNAME = "0.0.0.0"
    },
    var.voice_real_calls ? { HEALDESK_VOICE_REAL_CALLS = "1" } : {},
  )

  # Every name the stack sets on any task from its own variables. A literal,
  # because var.app_environment is checked against it and so cannot be part of
  # what it is computed from; the task definitions' preconditions check that
  # the environment they are given sets nothing outside this list.
  stack_environment_names = [
    "AWS_REGION",
    "BETTER_AUTH_URL",
    "HEALDESK_ADMIN_EMAIL",
    "HEALDESK_APP_URL",
    "HEALDESK_CONSOLE_ORIGIN",
    "HEALDESK_EMAIL_FROM",
    "HEALDESK_EMAIL_TRANSPORT",
    "HEALDESK_EXPORT_BUCKET",
    "HEALDESK_KMS_KEY_ID",
    "HEALDESK_KMS_PROVIDER",
    "HEALDESK_OPS_EMAIL",
    "HEALDESK_SES_CONFIGURATION_SET",
    "HEALDESK_SES_EVENTS_TOPIC_ARN",
    "HEALDESK_VOICE_ENABLED",
    "HEALDESK_VOICE_PROVISION_ENABLED",
    "HEALDESK_VOICE_REAL_CALLS",
    "HOSTNAME",
    "KEEP_ALIVE_TIMEOUT",
    "META_APP_ID",
    "META_LOGIN_CONFIG_ID",
    "META_WHATSAPP_CONFIG_ID",
    "NODE_ENV",
    "NODE_EXTRA_CA_CERTS",
    "NPM_CONFIG_CACHE",
    "NPM_CONFIG_UPDATE_NOTIFIER",
    "PORT",
    "STRIPE_CONNECT_CLIENT_ID",
  ]

  # --- Secrets, injected by ECS from SSM at task start (contract section 3).
  # The web tier and the voice endpoint get every app/* parameter; the worker
  # gets the ones its code reads; the migrate task gets only the migrator URL;
  # the db-bootstrap task reads its own through its task role (ecs.tf).
  app_secret_arns = {
    for name, path in local.parameter_paths : name => local.parameter_arns[name] if startswith(path, "app/")
  }

  web_secret_names = sort(keys(local.app_secret_arns))

  # The voice process runs the web tier's conversation code (the shared
  # assistant and its model, the post-call ingest, the booking alert, the
  # emailed transcript), so it gets the web tier's set rather than a list
  # traced call by call; HEALDESK_RETELL_LLM_SECRET, which guards its socket,
  # is one of them.
  voice_secret_names = local.web_secret_names

  # Traced from src/workers/index.ts: the database, session signing (email
  # stop links), identifier references, provisioning's signature, mail,
  # Stripe, Google for the calendar watch, sync and connection health, and
  # Retell's key for the voice call backstop, which reads a call back, and for
  # the hourly fallback-number sync (lib/voice/retell-fallback-sync.ts), and
  # the Slack webhook ops alerts are posted through (lib/ops/slack.ts).
  worker_secret_names = [
    "BETTER_AUTH_SECRET",
    "DATABASE_URL",
    "GOOGLE_OAUTH_CLIENT_ID",
    "GOOGLE_OAUTH_CLIENT_SECRET",
    "HEALDESK_IDENTIFIER_REF_KEY",
    "HEALDESK_PROVISION_SECRET",
    "HEALDESK_RETELL_API_KEY",
    "RESEND_API_KEY",
    "SLACK_OPS_WEBHOOK_URL",
    "STRIPE_SECRET_KEY",
  ]

  # Every name that holds a secret, wherever it is injected. None of them may
  # ever be plain environment.
  secret_environment_names = sort(keys(local.parameter_paths))

  # Never given to the web or worker tasks, as environment or as a secret
  # (contract section 3); the task definitions refuse to plan if one appears.
  # The migrator URL belongs to the migrate task alone; the local KEK is
  # development-only; the two switches are owner- and counsel-gated;
  # BETTER_AUTH_SECRETS would silently take precedence over BETTER_AUTH_SECRET.
  # (HEALDESK_APP_URL used to be here; it is now the internal origin, which is
  # exactly what lib/email/lint.ts must refuse in a mailed link.)
  never_on_app_tasks = [
    "MIGRATION_DATABASE_URL",
    "READONLY_DATABASE_URL",
    "WRITER_DATABASE_URL",
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
