# SES, for mail classed may-carry-phi. None is sent yet: today's mail is
# PHI-free and goes over Resend (HEALDESK_EMAIL_TRANSPORT=resend). The domain
# identity's DKIM records go into Cloudflare by hand (outputs.tf), and the
# account leaves SES's sandbox only through a support request.

resource "aws_sesv2_configuration_set" "phi" {
  configuration_set_name = "healdesk-phi"

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
  email_identity         = var.ses_domain
  configuration_set_name = aws_sesv2_configuration_set.phi.configuration_set_name
}
