# SES, for mail classed may-carry-phi: on (enable_ses = true) since the owner's
# decision of 13 October 2026 that a conversation's transcript is emailed to
# the clinic rather than kept. Every other email goes over Resend
# (HEALDESK_EMAIL_TRANSPORT=resend), and none of it may carry PHI. This is
# what lib/reporting/deliver.ts needs to send through SES:
#
#   - a configuration set whose delivery policy is REQUIRE, so SES never falls
#     back to cleartext for a server that will not negotiate TLS. The app
#     reads the set back and refuses to send unless the policy is REQUIRE;
#   - the domain identity, with Easy DKIM's three records in Cloudflare (DNS
#     only), beside Resend's own selector;
#   - HEALDESK_SES_CONFIGURATION_SET on the web and worker tasks (locals.tf)
#     and the task role's SendEmail and GetConfigurationSet on these two and
#     nothing else (iam.tf);
#   - SES's events for the set (delivery, bounce, complaint, rejection,
#     rendering failure, delay) published to an SNS topic that posts them to
#     the app's /api/webhooks/ses, which checks SNS's signature and turns a
#     bounce into another try (lib/conversations/transcript-outbox.ts).
#
# It does not switch HEALDESK_EMAIL_TRANSPORT, which stays the owner's
# decision, and the account still leaves SES's sandbox only through a support
# request.

locals {
  ses_configuration_set_name = "${local.name}-phi"
  ses_configuration_set_arn  = "arn:aws:ses:${var.region}:${local.account_id}:configuration-set/${local.ses_configuration_set_name}"
  ses_identity_arn           = "arn:aws:ses:${var.region}:${local.account_id}:identity/${var.ses_domain}"
  ses_events_topic_name      = "${local.name}-ses-events"
  ses_events_endpoint        = "${local.app_url}/api/webhooks/ses"

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

# ---------------------------------------------------------------------------
# SES's events, to the app
# ---------------------------------------------------------------------------
#
# The transcript outbox records SES's acceptance of each transcript; what
# happens after (a delivery, or a bounce from the clinic's mail server) only
# SES knows, and it says so through these events. The app's endpoint
# (app/api/webhooks/ses) accepts a message only from this topic
# (HEALDESK_SES_EVENTS_TOPIC_ARN) and only with SNS's signature, version 2,
# checked against a certificate fetched from sns.<region>.amazonaws.com.
#
# The events carry no transcript: SES's message id, the clinic's address, the
# fixed subject and a mail server's diagnostic. That is why the topic is not
# encrypted, like the alarm topic: SES publishes to an encrypted topic only
# through a key-policy grant the contract keeps out of the main key.
#
# The subscription is HTTPS to the public host and is confirmed by the app
# when SNS posts the confirmation, and SNS refuses to make it at all while the
# endpoint does not answer. So host.yml makes it in its last apply, once its
# deploy answers on the public host; infra.yml and host.yml's first apply pass
# subscribe_ses_events = false while the liveness probe does not answer.

resource "aws_sns_topic" "ses_events" {
  count = var.enable_ses ? 1 : 0

  name              = local.ses_events_topic_name
  signature_version = 2

  #checkov:skip=CKV_AWS_26:SES events carry a message id, the clinic's address, a fixed subject and a mail server's diagnostic, never a transcript; encrypting with our key would need a key-policy grant for SES the contract keeps out of the main key.
}

data "aws_iam_policy_document" "ses_events" {
  count = var.enable_ses ? 1 : 0

  statement {
    sid       = "SesPublishesThisConfigurationSetsEvents"
    actions   = ["sns:Publish"]
    resources = [aws_sns_topic.ses_events[0].arn]

    principals {
      type        = "Service"
      identifiers = ["ses.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [local.account_id]
    }

    condition {
      test     = "ArnLike"
      variable = "aws:SourceArn"
      values   = [local.ses_configuration_set_arn]
    }
  }
}

resource "aws_sns_topic_policy" "ses_events" {
  count = var.enable_ses ? 1 : 0

  arn    = aws_sns_topic.ses_events[0].arn
  policy = data.aws_iam_policy_document.ses_events[0].json
}

resource "aws_sesv2_configuration_set_event_destination" "phi_events" {
  count = var.enable_ses ? 1 : 0

  configuration_set_name = aws_sesv2_configuration_set.phi[0].configuration_set_name
  event_destination_name = "transcript-outbox"

  event_destination {
    enabled = true
    matching_event_types = [
      "DELIVERY",
      "BOUNCE",
      "COMPLAINT",
      "REJECT",
      "RENDERING_FAILURE",
      "DELIVERY_DELAY",
    ]

    sns_destination {
      topic_arn = aws_sns_topic.ses_events[0].arn
    }
  }

  depends_on = [aws_sns_topic_policy.ses_events]
}

resource "aws_sns_topic_subscription" "ses_events_app" {
  # Only once the app answers: SNS checks the endpoint when it subscribes.
  # Standby (variables.tf) removes the public host it posts to, and this with
  # it; the topic, the event destination and SES's identity stay, so the
  # subscription host.yml makes again once the app answers is all that comes
  # back.
  count = var.enable_ses && var.subscribe_ses_events && !var.standby ? 1 : 0

  topic_arn              = aws_sns_topic.ses_events[0].arn
  protocol               = "https"
  endpoint               = local.ses_events_endpoint
  endpoint_auto_confirms = false
  raw_message_delivery   = false

  # SNS retries an HTTPS delivery the app did not answer 2xx: a deploy, a
  # restart or a database blip loses no event. Twelve tries over about
  # three quarters of an hour, then the event is dropped; SNS refuses a
  # policy whose retries add up to more than an hour (the first apply, 14
  # October 2026, failed on twenty tries). The outbox's own retries do not
  # depend on it, only the bounce does.
  delivery_policy = jsonencode({
    healthyRetryPolicy = {
      minDelayTarget     = 10
      maxDelayTarget     = 600
      numRetries         = 12
      numNoDelayRetries  = 0
      numMinDelayRetries = 2
      numMaxDelayRetries = 3
      backoffFunction    = "exponential"
    }
    throttlePolicy = {
      maxReceivesPerSecond = 10
    }
  })
}
