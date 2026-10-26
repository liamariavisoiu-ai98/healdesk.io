# What the owner and the workflows need after an apply (contract section 6).
# None of these is a secret. The ones naming something standby removes are
# null while the host is in standby.

output "standby" {
  description = "Whether this apply left the host in standby (variables.tf): no database, load balancer, NAT or service."
  value       = var.standby
}

output "alb_dns_name" {
  description = "The load balancer's DNS name; both origins are DNS-only CNAMEs to it. Null in standby."
  value       = one(aws_lb.main[*].dns_name)
}

output "app_url" {
  description = "Public origin of the product: BETTER_AUTH_URL on this host. Never HEALDESK_APP_URL anywhere."
  value       = local.app_url
}

output "internal_url" {
  description = "The origin apps/web calls with signed requests: HEALDESK_APP_URL on Vercel (and on this host's tasks). It answers only the signed routes and must never reach a browser."
  value       = local.internal_url
}

output "github_deploy_role_arn" {
  description = "Role for deploy-app.yml. deploy-app.yml derives it from AWS_TERRAFORM_ROLE_ARN's account when the AWS_DEPLOY_ROLE_ARN variable is unset, so the variable is optional."
  value       = aws_iam_role.github_deploy.arn
}

output "ecr_repository_urls" {
  description = "Repository URLs by image (app, db-admin, tls-proxy)."
  value       = { for name, repo in aws_ecr_repository.this : name => repo.repository_url }
}

output "rds_endpoint" {
  description = "Host name of the RDS instance (port 5432). Connect by this name: verify-full checks it against the certificate. Null in standby; the same name when the instance comes back, since it keeps its identifier."
  value       = local.db_address
}

output "rds_master_secret_arn" {
  description = "Secrets Manager ARN of the RDS-managed master credentials, rotated every 7 days and used only by the db-bootstrap task. Null in standby; a new secret when the instance comes back."
  value       = local.db_master_secret_arn
}

output "kms_key_arn" {
  description = "The customer-managed key: HEALDESK_KMS_KEY_ID on the web, worker and voice tasks. Never replaced."
  value       = aws_kms_key.main.arn
}

output "alarm_topic_arn" {
  description = "SNS topic every alarm notifies; its email subscription must be confirmed once."
  value       = aws_sns_topic.alarms.arn
}

output "parameters_to_fill" {
  description = "SSM parameters created as __unset__ that the owner pastes real values into with infra/aws/scripts/put-external-secrets.sh, followed by a deploy with restart_only."
  value       = sort([for name in local.external_parameter_names : local.parameter_names[name]])
}

output "internal_parameters" {
  description = "SSM parameters created as __unset__ that the db-bootstrap task fills inside AWS (generated passwords and keys, and the two database URLs). Never paste, edit or regenerate them by hand."
  value       = sort([for name in keys(local.internal_parameter_paths) : local.parameter_names[name]])
}

output "transcript_bucket" {
  description = "The transcript bucket's name, while enable_transcript_bucket is on; null otherwise."
  value       = var.enable_transcript_bucket ? local.transcript_bucket : null
}

output "export_bucket" {
  description = "Where the patient-export task puts a leaving clinic's return bundle (exports.tf); run-task.sh prints the object's key."
  value       = local.export_bucket
}

output "voice_websocket_url" {
  description = "The custom LLM WebSocket URL for each clinic's Retell agent, while enable_voice is on; null otherwise. Fill in the two placeholders: the value pasted as app/HEALDESK_RETELL_LLM_SECRET and the clinic's id. Retell appends the call id. The secret itself is never in this output: Terraform does not hold it."
  value       = var.enable_voice && !var.standby ? "wss://${var.app_domain}/llm-websocket/<HEALDESK_RETELL_LLM_SECRET>/<clinic id>" : null
}

output "voice_service" {
  description = "The voice endpoint's ECS service, while enable_voice is on and the host is not in standby; null otherwise. deploy-app.yml rolls it with web and worker."
  value       = one(aws_ecs_service.voice[*].name)
}

output "ses_configuration_set" {
  description = "The SES configuration set that requires TLS (HEALDESK_SES_CONFIGURATION_SET), while enable_ses is on; null otherwise."
  value       = var.enable_ses ? local.ses_configuration_set_name : null
}

output "inbound_mail" {
  description = "Inbound support mail, while enable_inbound_mail is on; null otherwise: the address the owner's mailbox forwards to, the bucket, the topic and the receipt rule set the rule is in."
  value = var.enable_inbound_mail ? {
    forward_to = local.inbound_recipient
    bucket     = local.inbound_bucket
    topic_arn  = aws_sns_topic.inbound_mail[0].arn
    rule_set   = local.inbound_rule_set
  } : null
}
