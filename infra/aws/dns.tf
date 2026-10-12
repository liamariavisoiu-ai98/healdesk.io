# healdesk.io's DNS is at Cloudflare. Terraform writes the records there: the
# CNAMEs ACM asks for to validate (and later renew) the certificate, one per
# name on it, and the two origins pointing at the load balancer, the public
# app_domain and the internal_hostname apps/web calls (alb.tf).
#
# Every record is DNS-only, and that is enforced here with a literal false
# rather than a variable. A proxied ("orange cloud") record makes Cloudflare
# terminate TLS, so every patient message, transcript fetch, voice socket and
# signed server call would be decrypted on Cloudflare's network. Cloudflare is
# not in the BAA chain (its BAA is Enterprise-only) and not on the
# subprocessor register. A proxied validation record would also answer with
# Cloudflare's addresses instead of the CNAME target, which breaks issuance
# and renewal. Anyone who flips a record to proxied in the dashboard has it
# flipped back by the next apply.
#
# Cloudflare's v5 provider wants full names without the trailing dot, which
# is how they are written here.

# One certificate for both origins, on the one HTTPS listener. ACM cannot
# issue for the balancer's own *.elb.amazonaws.com name, which is one more
# reason the internal origin is a name of ours.
resource "aws_acm_certificate" "app" {
  domain_name               = var.app_domain
  subject_alternative_names = [var.internal_hostname]
  validation_method         = "DNS"
  key_algorithm             = "RSA_2048"

  lifecycle {
    create_before_destroy = true
  }
}

resource "cloudflare_dns_record" "acm_validation" {
  for_each = {
    for option in aws_acm_certificate.app.domain_validation_options : option.domain_name => option
  }

  zone_id = var.cloudflare_zone_id
  name    = trimsuffix(each.value.resource_record_name, ".")
  type    = each.value.resource_record_type
  content = trimsuffix(each.value.resource_record_value, ".")
  ttl     = 300
  proxied = false
  comment = "Terraform infra/aws: ACM validation for ${each.key}. Keep: renewal needs it."
}

# Waits until ACM has issued the certificate. The HTTPS listener takes its
# certificate ARN from here, so one apply creates the records, waits for
# validation and then creates the listener. Thirty minutes, not the
# provider's 75: a validation that has not finished by then is stuck (a
# missing or proxied record), and failing inside the workflow's AWS session
# leaves a clean state behind instead of an expired session and a stale lock.
resource "aws_acm_certificate_validation" "app" {
  certificate_arn         = aws_acm_certificate.app.arn
  validation_record_fqdns = [for option in aws_acm_certificate.app.domain_validation_options : option.resource_record_name]

  timeouts {
    create = "30m"
  }

  depends_on = [cloudflare_dns_record.acm_validation]
}

resource "cloudflare_dns_record" "app" {
  zone_id = var.cloudflare_zone_id
  name    = var.app_domain
  type    = "CNAME"
  content = aws_lb.main.dns_name
  ttl     = 300
  proxied = false
  comment = "Terraform infra/aws: the public origin. DNS only: proxying would decrypt patient traffic at Cloudflare."
}

resource "cloudflare_dns_record" "internal" {
  zone_id = var.cloudflare_zone_id
  name    = var.internal_hostname
  type    = "CNAME"
  content = aws_lb.main.dns_name
  ttl     = 300
  proxied = false
  comment = "Terraform infra/aws: HEALDESK_APP_URL, apps/web's signed calls only. DNS only: proxying would decrypt them at Cloudflare."
}
