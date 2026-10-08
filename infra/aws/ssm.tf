# Secrets live in SSM Parameter Store as SecureString parameters under
# /healdesk/<environment>/, encrypted with our key, and reach the containers
# only through the task definitions' `secrets` (resolved by ECS at task start,
# so a changed value takes a new deployment). Never in `environment`, never in
# run-task overrides: CloudTrail records both.
#
# Internal values are generated here, so they also sit in Terraform state,
# which is why the state bucket is private and KMS-encrypted. Passwords are
# alphanumeric, so they are safe inside a URL as they are; they are still
# passed through urlencode() in case the character set is ever widened.

resource "random_password" "db_app" {
  length  = 40
  special = false
}

resource "random_password" "db_migrator" {
  length  = 40
  special = false
}

resource "random_password" "better_auth_secret" {
  length  = 64
  special = false
}

# Never rotated without a re-key plan: every stored identifier reference was
# made under it (lib/env.ts), so a new value would orphan every conversation
# and count every call again. prevent_destroy stops a plan that would replace
# it, for example after an edit to these arguments.
resource "random_password" "identifier_ref_key" {
  length  = 64
  special = false

  lifecycle {
    prevent_destroy = true
  }
}

locals {
  # verify-full checks the certificate chain and the host name; sslrootcert
  # points at the RDS bundle in the image. Both pg-boss and drizzle-kit take
  # TLS only from the URL, so it is the one place TLS is decided.
  database_url_options = "sslmode=verify-full&sslrootcert=${local.rds_ca_bundle}"
  database_host        = "${aws_db_instance.main.address}:${local.db_port}"
}

resource "aws_ssm_parameter" "db_app_password" {
  name        = "${local.param_prefix}/db/APP_PASSWORD"
  description = "Password of the healdesk_app runtime role. Read by the db-bootstrap task; also inside DATABASE_URL."
  type        = "SecureString"
  key_id      = aws_kms_key.main.arn
  tier        = "Standard"
  value       = random_password.db_app.result
}

resource "aws_ssm_parameter" "db_migrator_password" {
  name        = "${local.param_prefix}/db/MIGRATOR_PASSWORD"
  description = "Password of the healdesk_migrator role that owns the tables. Read by the db-bootstrap task; also inside MIGRATION_DATABASE_URL."
  type        = "SecureString"
  key_id      = aws_kms_key.main.arn
  tier        = "Standard"
  value       = random_password.db_migrator.result
}

resource "aws_ssm_parameter" "better_auth_secret" {
  name        = "${local.param_prefix}/app/BETTER_AUTH_SECRET"
  description = "Signs sessions and email stop links. Rotating it signs every clinic out."
  type        = "SecureString"
  key_id      = aws_kms_key.main.arn
  tier        = "Standard"
  value       = random_password.better_auth_secret.result
}

resource "aws_ssm_parameter" "identifier_ref_key" {
  name        = "${local.param_prefix}/app/HEALDESK_IDENTIFIER_REF_KEY"
  description = "Keys the identifier references stored instead of phone numbers. Never rotate without a re-key plan."
  type        = "SecureString"
  key_id      = aws_kms_key.main.arn
  tier        = "Standard"
  value       = random_password.identifier_ref_key.result
}

resource "aws_ssm_parameter" "database_url" {
  name        = "${local.param_prefix}/app/DATABASE_URL"
  description = "Runtime connection for web and worker, as healdesk_app (no BYPASSRLS, owns nothing), TLS verified."
  type        = "SecureString"
  key_id      = aws_kms_key.main.arn
  tier        = "Standard"
  value       = "postgresql://healdesk_app:${urlencode(random_password.db_app.result)}@${local.database_host}/${local.db_name}?${local.database_url_options}"
}

resource "aws_ssm_parameter" "migration_database_url" {
  name        = "${local.param_prefix}/migrator/MIGRATION_DATABASE_URL"
  description = "Migrations and queue install only, as healdesk_migrator. Given to the migrate task and nothing else."
  type        = "SecureString"
  key_id      = aws_kms_key.main.arn
  tier        = "Standard"
  value       = "postgresql://healdesk_migrator:${urlencode(random_password.db_migrator.result)}@${local.database_host}/${local.db_name}?${local.database_url_options}"
}

# External values: created as the literal "__unset__" and filled in by the
# owner in the console (the parameters_to_fill output lists them). Terraform
# never reads them back into a plan: ignore_changes on the value. The image's
# entrypoint unsets any variable whose value is exactly "__unset__", so until a
# value is pasted the app sees it as unset and the feature stays off instead of
# failing on a placeholder. Several stay unset on purpose until the vendor
# chain is complete (META_*, ANTHROPIC_API_KEY, the voice secrets).
resource "aws_ssm_parameter" "external" {
  for_each = toset([
    "HEALDESK_PROVISION_SECRET",
    "STRIPE_SECRET_KEY",
    "STRIPE_CONNECT_WEBHOOK_SECRET",
    "RESEND_API_KEY",
    "META_APP_SECRET",
    "META_VERIFY_TOKEN",
    "ANTHROPIC_API_KEY",
    "HEALDESK_VOICE_WEBHOOK_SECRET",
    "HEALDESK_VOICE_TOOLS_SECRET",
  ])

  name        = "${local.param_prefix}/app/${each.key}"
  description = "Pasted by the owner in the console; created as __unset__, which the image's entrypoint treats as unset."
  type        = "SecureString"
  key_id      = aws_kms_key.main.arn
  tier        = "Standard"
  value       = "__unset__"

  lifecycle {
    ignore_changes = [value]
  }
}
