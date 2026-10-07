# What a person needs after an apply, and what the scripts read. Nothing
# here is a secret.

output "certificate_validation_records" {
  description = "CNAMEs to add in Cloudflare (DNS only, not proxied) before the certificate can issue."
  value = [
    for o in aws_acm_certificate.app.domain_validation_options : {
      name  = o.resource_record_name
      type  = o.resource_record_type
      value = o.resource_record_value
    }
  ]
}

output "app_dns_records" {
  description = "CNAMEs to add in Cloudflare (DNS only, not proxied) once the load balancer exists."
  value = [
    for host in [var.public_hostname, var.internal_hostname] : {
      name  = host
      type  = "CNAME"
      value = aws_lb.app.dns_name
    }
  ]
}

output "ses_dkim_records" {
  description = "Easy DKIM CNAMEs for the SES domain, beside Resend's own selector."
  # Empty until SES has generated the tokens; an apply never fails on it.
  value = [
    for token in try(aws_sesv2_email_identity.main.dkim_signing_attributes[0].tokens, []) : {
      name  = "${token}._domainkey.${var.ses_domain}"
      type  = "CNAME"
      value = "${token}.dkim.amazonses.com"
    }
  ]
}

output "public_url" {
  description = "BETTER_AUTH_URL: the origin of every clinic-facing link."
  value       = "https://${var.public_hostname}"
}

output "internal_url" {
  description = "Set as HEALDESK_APP_URL on apps/web's Vercel project. Never shown to a browser."
  value       = "https://${var.internal_hostname}"
}

output "ecr_repository_url" {
  value = aws_ecr_repository.app.repository_url
}

output "cpu_architecture" {
  description = "What scripts/push-image.sh builds for."
  value       = var.cpu_architecture
}

output "kms_key_arn" {
  description = "HEALDESK_KMS_KEY_ID: the full ARN, which the app requires."
  value       = aws_kms_key.main.arn
}

output "db_endpoint" {
  value = aws_db_instance.main.address
}

output "db_name" {
  value = aws_db_instance.main.db_name
}

output "runtime_secret_arn" {
  value = aws_secretsmanager_secret.runtime.arn
}

output "runtime_secret_keys" {
  value = local.runtime_secret_keys
}

output "admin_secret_arn" {
  value = aws_secretsmanager_secret.admin.arn
}

output "admin_secret_keys" {
  value = local.admin_secret_keys
}

output "cluster_name" {
  value = aws_ecs_cluster.main.name
}

output "one_off_tasks" {
  description = "Task definition families for scripts/run-task.sh."
  value = {
    db-admin      = aws_ecs_task_definition.db_admin.family
    migrate       = aws_ecs_task_definition.migrate.family
    queue-install = aws_ecs_task_definition.queue_install.family
  }
}

output "task_network" {
  description = "Where scripts/run-task.sh places a one-off task."
  value = {
    subnets         = aws_subnet.private[*].id
    security_groups = [aws_security_group.admin.id]
  }
}

output "admin_log_group" {
  value = aws_cloudwatch_log_group.tasks["admin"].name
}
