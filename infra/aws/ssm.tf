# Secrets live in SSM Parameter Store as SecureString parameters under
# /healdesk/<environment>/, encrypted with our key, and reach the containers
# only through the task definitions' `secrets` (resolved by ECS at task start,
# so a changed value takes a new deployment). Never in `environment`, never in
# run-task overrides: CloudTrail records both.
#
# Terraform creates every parameter and never holds a value. Each is created
# holding the literal "__unset__", through the provider's write-only argument
# (value_wo): written once at creation, never stored in the state or a plan,
# never read back. The plain `value` argument would not do: the provider reads
# a SecureString back with decryption on every refresh and stores it in the
# state, so `value` with ignore_changes would copy every pasted or generated
# secret into the state at the next plan. The image's entrypoint unsets any
# variable whose value is exactly "__unset__", so until a real value is
# written the app sees it as unset and the feature stays off.
#
# Who writes the real values:
#   - internal: the db-bootstrap task's init-secrets, inside AWS, before it
#     provisions the roles. It generates each one still "__unset__" (keeping
#     any already set, because rotating a database password without
#     re-provisioning the role would lock everything out) and composes both
#     database URLs from the RDS endpoint. Its task role may write these ten
#     and nothing else (iam.tf);
#   - external: the owner, in AWS CloudShell, with
#     infra/aws/scripts/put-external-secrets.sh (the parameters_to_fill
#     output lists them). Several stay "__unset__" on purpose until the vendor
#     chain is complete (META_*, ANTHROPIC_API_KEY, and
#     HEALDESK_RETELL_LLM_SECRET and HEALDESK_RETELL_API_KEY until
#     enable_voice is turned on).
#
# Three things follow from the write-only form, and each is pinned below:
#   - an in-place change to any other argument makes the provider put the
#     value it holds again, which is nothing, and AWS refuses an empty value.
#     So description, key, tier and type are ignored once a parameter exists;
#     change one by hand in the console, or by recreating the parameter on
#     purpose;
#   - raising value_wo_version writes "__unset__" over the live value. Never
#     for an internal parameter once the database is provisioned;
#   - destroying a parameter destroys its live value (for
#     HEALDESK_IDENTIFIER_REF_KEY, every stored identifier reference), hence
#     prevent_destroy.
#
# One parameter is deliberately not here: /healdesk/<environment>/ci/
# CLOUDFLARE_API_TOKEN, which infra.yml reads before Terraform runs, so it has
# to exist before the first plan. The owner creates it with the same script.
# No role this module creates can read it (iam.tf).

locals {
  unset_placeholder = "__unset__"

  # Generated inside AWS by the db-bootstrap task. Name => path under the
  # prefix; the name is also the variable a task receives it as.
  internal_parameter_paths = {
    APP_PASSWORD                = "db/APP_PASSWORD"
    MIGRATOR_PASSWORD           = "db/MIGRATOR_PASSWORD"
    BETTER_AUTH_SECRET          = "app/BETTER_AUTH_SECRET"
    HEALDESK_IDENTIFIER_REF_KEY = "app/HEALDESK_IDENTIFIER_REF_KEY"
    DATABASE_URL                = "app/DATABASE_URL"
    MIGRATION_DATABASE_URL      = "migrator/MIGRATION_DATABASE_URL"
    READONLY_PASSWORD           = "db/READONLY_PASSWORD"
    READONLY_DATABASE_URL       = "readonly/READONLY_DATABASE_URL"
    WRITER_PASSWORD             = "db/WRITER_PASSWORD"
    WRITER_DATABASE_URL         = "writer/WRITER_DATABASE_URL"
  }

  internal_parameter_descriptions = {
    APP_PASSWORD                = "Password of the healdesk_app runtime role (inside DATABASE_URL). Generated once by the db-bootstrap task, which sets the role's password from it."
    MIGRATOR_PASSWORD           = "Password of the healdesk_migrator role that owns the tables (inside MIGRATION_DATABASE_URL). Generated once by the db-bootstrap task, which sets the role's password from it."
    BETTER_AUTH_SECRET          = "Signs sessions and email stop links. Generated once by the db-bootstrap task. Rotating it signs every clinic out."
    HEALDESK_IDENTIFIER_REF_KEY = "Keys the identifier references stored instead of phone numbers. Generated once by the db-bootstrap task. Never rotate it without a re-key plan."
    DATABASE_URL                = "Runtime connection for web and worker, as healdesk_app (no BYPASSRLS, owns nothing), TLS verified. Composed by the db-bootstrap task from the RDS endpoint."
    MIGRATION_DATABASE_URL      = "Migrations and the queue install only, as healdesk_migrator. Composed by the db-bootstrap task; given to the migrate task and nothing else."
    READONLY_PASSWORD           = "Password of the healdesk_readonly role (inside READONLY_DATABASE_URL). Generated once by the db-bootstrap task, which sets the role's password from it."
    READONLY_DATABASE_URL       = "The db-query task only, as healdesk_readonly: SELECT on the tables in apps/app/scripts/readonly-tables.ts, no BYPASSRLS, read-only sessions. Composed by the db-bootstrap task; under readonly/, not app/, so no web, worker or voice task is ever given it."
    WRITER_PASSWORD             = "Password of the healdesk_writer role (inside WRITER_DATABASE_URL). Generated once by the db-bootstrap task, which sets the role's password from it."
    WRITER_DATABASE_URL         = "The db-apply task only, as healdesk_writer: SELECT on the read-only list and INSERT and UPDATE on WRITABLE_TABLES in apps/app/scripts/readonly-tables.ts, no DELETE, no BYPASSRLS. Composed by the db-bootstrap task; under writer/, not app/, so no web, worker or voice task is ever given it."
  }

  # Pasted by the owner. All of them live under app/ and reach the web tier
  # and the voice endpoint; the worker gets the few it reads (locals.tf).
  # HEALDESK_RETELL_LLM_SECRET is the path segment that admits Retell's
  # WebSocket (src/voice/server.ts): the same value goes into every clinic's
  # Retell agent URL, and while it is unset every call is refused.
  # HEALDESK_RETELL_API_KEY is the BAA Retell workspace's API key, the one with
  # the webhook badge: it signs Retell's call-ended webhook to
  # /api/webhooks/retell/<clinic id> and lets the worker read a call back (the
  # backstop, lib/voice/backstop.ts); the worker keeps each AYA number's
  # fallback on the clinic's direct line with it, and the voice endpoint reads
  # that fallback back when the database is down
  # (lib/voice/retell-fallback-sync.ts, lib/voice/fallback-line.ts).
  # SLACK_WEBHOOK_URL is the Slack Incoming Webhook ops alerts are posted
  # to (lib/ops/slack.ts, owner decision D1 of 23 October 2026), by the
  # worker's sweep. It is the SAME address as apps/web's SLACK_WEBHOOK_URL on
  # Vercel (the owner's #alerts channel, 23 October 2026), stored in both
  # places, so a leak means changing it in both. Each side tags its posts
  # ([app], [web]). While it is unset, Slack is off and alerts are emailed only.
  external_parameter_names = [
    "HEALDESK_PROVISION_SECRET",
    "STRIPE_SECRET_KEY",
    "STRIPE_CONNECT_WEBHOOK_SECRET",
    "RESEND_API_KEY",
    "META_APP_SECRET",
    "META_VERIFY_TOKEN",
    "ANTHROPIC_API_KEY",
    "HEALDESK_RETELL_LLM_SECRET",
    "HEALDESK_RETELL_API_KEY",
    "GOOGLE_OAUTH_CLIENT_ID",
    "GOOGLE_OAUTH_CLIENT_SECRET",
    "SLACK_WEBHOOK_URL",
  ]

  parameter_paths = merge(
    local.internal_parameter_paths,
    { for name in local.external_parameter_names : name => "app/${name}" },
  )

  # Full names and ARNs are written out rather than read from the resources,
  # so the policies and task definitions that name them are exact and do not
  # wait on the parameters.
  parameter_names = { for name, path in local.parameter_paths : name => "${local.param_prefix}/${path}" }
  parameter_arns  = { for name, full in local.parameter_names : name => "arn:aws:ssm:${var.region}:${local.account_id}:parameter${full}" }
}

resource "aws_ssm_parameter" "internal" {
  for_each = local.internal_parameter_paths

  name        = local.parameter_names[each.key]
  description = local.internal_parameter_descriptions[each.key]
  type        = "SecureString"
  key_id      = aws_kms_key.main.arn
  tier        = "Standard"

  value_wo         = local.unset_placeholder
  value_wo_version = 1

  lifecycle {
    prevent_destroy = true
    ignore_changes  = [description, key_id, tier, type, allowed_pattern, data_type]
  }
}

resource "aws_ssm_parameter" "external" {
  for_each = toset(local.external_parameter_names)

  name        = local.parameter_names[each.key]
  description = "Pasted by the owner with infra/aws/scripts/put-external-secrets.sh. Created as __unset__, which the image's entrypoint treats as unset."
  type        = "SecureString"
  key_id      = aws_kms_key.main.arn
  tier        = "Standard"

  value_wo         = local.unset_placeholder
  value_wo_version = 1

  lifecycle {
    prevent_destroy = true
    ignore_changes  = [description, key_id, tier, type, allowed_pattern, data_type]
  }
}

# ---------------------------------------------------------------------------
# Retired parameters
# ---------------------------------------------------------------------------
#
# HEALDESK_VOICE_WEBHOOK_SECRET and HEALDESK_VOICE_TOOLS_SECRET guarded the
# Synthflow routes, which went when Retell replaced Synthflow (5 and 13
# October 2026); the owner retired the parameters on 14 October. The first
# apply created them holding only "__unset__", so deleting them loses nothing.
#
# Removing a key from external_parameter_names alone would make every plan
# fail: prevent_destroy above applies to every instance of the resource,
# including a key that left the set, and a `removed` block can name only a
# whole resource, not one of its instances. So each retired instance is moved
# to an address no resource declares. Terraform then plans to destroy it as an
# object that is no longer configured, which prevent_destroy (a setting of the
# resource it left) does not cover, while every parameter still in the set
# keeps it. The plan guard (scripts/plan-guard.sh) allows the deletion of
# aws_ssm_parameter.retired only. On a state that never had them (a new
# account, the tests) the moves do nothing. Keep these blocks: they are what
# lets an older state reach this configuration, and they cost nothing once
# applied.
moved {
  from = aws_ssm_parameter.external["HEALDESK_VOICE_WEBHOOK_SECRET"]
  to   = aws_ssm_parameter.retired["HEALDESK_VOICE_WEBHOOK_SECRET"]
}

moved {
  from = aws_ssm_parameter.external["HEALDESK_VOICE_TOOLS_SECRET"]
  to   = aws_ssm_parameter.retired["HEALDESK_VOICE_TOOLS_SECRET"]
}
