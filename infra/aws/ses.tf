# SES, for mail classed may-carry-phi: built, and off (enable_ses = false).
# v1 mail goes over Resend (HEALDESK_EMAIL_TRANSPORT=resend) and none of it
# may carry PHI. Turned on, this is what lib/reporting/deliver.ts needs to
# send through SES:
#
#   - a configuration set whose delivery policy is REQUIRE, so SES never falls
#     back to cleartext for a server that will not negotiate TLS. The app
#     reads the set back and refuses to send unless the policy is REQUIRE;
#   - the domain identity, with Easy DKIM's three records in Cloudflare (DNS
#     only), beside Resend's own selector;
#   - HEALDESK_SES_CONFIGURATION_SET on the web and worker tasks (locals.tf)
#     and the task role's SendEmail and GetConfigurationSet on these two and
#     nothing else (iam.tf).
#
# It does not switch HEALDESK_EMAIL_TRANSPORT, which stays the owner's
# decision, and the account still leaves SES's sandbox only through a support
# request.

locals {
  ses_configuration_set_name = "${local.name}-phi"
  ses_configuration_set_arn  = "arn:aws:ses:${var.region}:${local.account_id}:configuration-set/${local.ses_configuration_set_name}"
  ses_identity_arn           = "arn:aws:ses:${var.region}:${local.account_id}:identity/${var.ses_domain}"

  # Easy DKIM always hands back three tokens, known once the identity exists.
  ses_dkim_tokens = var.enable_ses ? try(aws_sesv2_email_identity.main[0].dkim_signing_attributes[0].tokens, []) : []
}

resource "aws_sesv2_configuration_set" "phi" {
  count = var.enable_ses ? 1 : 0

  configuration_set_name = local.ses_configuration_set_name

  delivery_options {
    tls_policy = "REQUIRE"
  }

  reputation_options {
    reputation_metrics_enabled = true
  }

  sending_options {
    sending_enabled = true
  }
}

resource "aws_sesv2_email_identity" "main" {
  count = var.enable_ses ? 1 : 0

  email_identity         = var.ses_domain
  configuration_set_name = aws_sesv2_configuration_set.phi[0].configuration_set_name

  dkim_signing_attributes {
    next_signing_key_length = "RSA_2048_BIT"
  }
}

resource "cloudflare_dns_record" "ses_dkim" {
  count = var.enable_ses ? 3 : 0

  zone_id = var.cloudflare_zone_id
  name    = "${try(local.ses_dkim_tokens[count.index], "")}._domainkey.${var.ses_domain}"
  type    = "CNAME"
  content = "${try(local.ses_dkim_tokens[count.index], "")}.dkim.amazonses.com"
  ttl     = 300
  proxied = false
  comment = "Terraform infra/aws: SES Easy DKIM for ${var.ses_domain}. DNS only."

  lifecycle {
    precondition {
      condition     = length(local.ses_dkim_tokens) == 3
      error_message = "SES did not return the three Easy DKIM tokens for ${var.ses_domain}."
    }
  }
}
