# Two secrets, each a JSON object, created empty. Terraform never sees a
# value: scripts/put-secrets.py writes them, so the state stays secret-free.
#
# ECS refuses to start a task whose secret lacks a key it references, so the
# key lists below are the contract that script writes to. An optional
# variable is written as "", which every optional() in lib/env.ts reads as
# unset.

locals {
  # The web tier and the worker. Every one is read by apps/app (lib/env.ts,
  # lib/reporting/resend-transport.ts, lib/meta/*); the Google OAuth client
  # is the calendar connection's (lib/connections/google-oauth.ts), and lives
  # here only, never on apps/web or a Vercel project.
  runtime_secret_keys = [
    "DATABASE_URL",
    "BETTER_AUTH_SECRET",
    "HEALDESK_PROVISION_SECRET",
    "HEALDESK_IDENTIFIER_REF_KEY",
    "ANTHROPIC_API_KEY",
    "RESEND_API_KEY",
    "STRIPE_SECRET_KEY",
    "STRIPE_CONNECT_CLIENT_ID",
    "STRIPE_CONNECT_WEBHOOK_SECRET",
    "META_APP_ID",
    "META_APP_SECRET",
    "META_VERIFY_TOKEN",
    "META_LOGIN_CONFIG_ID",
    "META_WHATSAPP_CONFIG_ID",
    "HEALDESK_VOICE_WEBHOOK_SECRET",
    "HEALDESK_VOICE_TOOLS_SECRET",
    "GOOGLE_OAUTH_CLIENT_ID",
    "GOOGLE_OAUTH_CLIENT_SECRET",
  ]

  # The one-off tasks only. The runtime tasks never see the migrator's
  # credentials, which own the tables and so would pass every RLS policy.
  admin_secret_keys = [
    "MIGRATION_DATABASE_URL",
    "APP_PASSWORD",
    "MIGRATOR_PASSWORD",
  ]
}

resource "aws_secretsmanager_secret" "runtime" {
  name                    = "${var.name}/runtime"
  description             = "apps/app web tier and worker environment"
  kms_key_id              = aws_kms_key.main.arn
  recovery_window_in_days = 7
}

resource "aws_secretsmanager_secret" "admin" {
  name                    = "${var.name}/admin"
  description             = "apps/app database roles and the migrator's connection"
  kms_key_id              = aws_kms_key.main.arn
  recovery_window_in_days = 7
}
