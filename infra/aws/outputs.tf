# What the owner and the workflows need after an apply (contract section 6).
# None of these is a secret.

output "alb_dns_name" {
  description = "The load balancer's DNS name; app.healdesk.io is a DNS-only CNAME to it."
  value       = aws_lb.main.dns_name
}

output "app_url" {
  description = "Public origin of the product: BETTER_AUTH_URL on this host, and the value for HEALDESK_APP_URL on Vercel."
  value       = local.app_url
}

output "github_deploy_role_arn" {
  description = "Role for deploy-app.yml; set it as the GitHub variable AWS_DEPLOY_ROLE_ARN."
  value       = aws_iam_role.github_deploy.arn
}

output "ecr_repository_urls" {
  description = "Repository URLs by image (app, db-admin, tls-proxy)."
  value       = { for name, repo in aws_ecr_repository.this : name => repo.repository_url }
}

output "rds_endpoint" {
  description = "Host name of the RDS instance (port 5432). Connect by this name: verify-full checks it against the certificate."
  value       = aws_db_instance.main.address
}

output "rds_master_secret_arn" {
  description = "Secrets Manager ARN of the RDS-managed master credentials, rotated every 7 days and used only by the db-bootstrap task."
  value       = aws_db_instance.main.master_user_secret[0].secret_arn
}

output "kms_key_arn" {
  description = "The customer-managed key: HEALDESK_KMS_KEY_ID on the web and worker tasks. Never replaced."
  value       = aws_kms_key.main.arn
}

output "alarm_topic_arn" {
  description = "SNS topic every alarm notifies; its email subscription must be confirmed once."
  value       = aws_sns_topic.alarms.arn
}

output "parameters_to_fill" {
  description = "SSM parameters created as __unset__ that the owner pastes real values into (Systems Manager, Parameter Store, Edit), followed by a deploy with restart."
  value       = sort([for p in aws_ssm_parameter.external : p.name])
}
