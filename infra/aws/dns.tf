# healdesk.io's DNS is at Cloudflare. Terraform writes two records there: the
# CNAME ACM asks for to validate (and later renew) the certificate, and
# app.healdesk.io itself pointing at the load balancer.
#
# Both are DNS-only, and that is enforced here with a literal false rather
# than a variable. A proxied ("orange cloud") record makes Cloudflare terminate
# TLS, so every patient message, transcript fetch and voice socket would be
# decrypted on Cloudflare's network. Cloudflare is not in the BAA chain (its
# BAA is Enterprise-only) and not on the subprocessor register. A proxied
# validation record would also answer with Cloudflare's addresses instead of
# the CNAME target, which breaks issuance and renewal. Anyone who flips a
# record to proxied in the dashboard has it flipped back by the next apply.
#
# Cloudflare's v5 provider wants full names without the trailing dot, which
# is how they are written here.

resource "aws_acm_certificate" "app" {
  domain_name       = var.app_domain
  validation_method = "DNS"
  key_algorithm     = "RSA_2048"

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
# certificate ARN from here, so one apply creates the record, waits for
# validation and then creates the listener.
resource "aws_acm_certificate_validation" "app" {
  certificate_arn         = aws_acm_certificate.app.arn
  validation_record_fqdns = [for option in aws_acm_certificate.app.domain_validation_options : option.resource_record_name]

  depends_on = [cloudflare_dns_record.acm_validation]
}

resource "cloudflare_dns_record" "app" {
  zone_id = var.cloudflare_zone_id
  name    = var.app_domain
  type    = "CNAME"
  content = aws_lb.main.dns_name
  ttl     = 300
  proxied = false
  comment = "Terraform infra/aws. DNS only: proxying would decrypt patient traffic at Cloudflare."
}
