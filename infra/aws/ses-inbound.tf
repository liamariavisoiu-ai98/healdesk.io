# Inbound support mail on SES (ops automation Phase 7, lane P7g; design E5
# §2.1; owner decision D13): a clinic's email to hello@healdesk.io becomes a
# support case without anyone retyping it. Off (enable_inbound_mail = false)
# until the owner has read the plan: every resource here is counted on it.
#
# The path, one hop per resource below:
#
#   the owner's mailbox (outside this stack) auto-forwards to
#   hello@<inbound_mail_domain>, a subdomain whose MX points at SES receiving
#   (the root domain's MX is untouched, so hello@healdesk.io keeps working as
#   it does today) -> one receipt rule, TLS required and spam/virus scan on,
#   whose one action writes the raw message to the inbound bucket and then
#   publishes a notice to the inbound topic -> SNS posts the notice to
#   apps/app's /api/webhooks/inbound-mail, which checks SNS's signature,
#   reads the object, reduces the message in memory to facts from fixed lists
#   (lib/support/inbound) and deletes the object in the same request.
#
# Under the AWS BAA end to end (SES, S3, SNS, KMS): a clinic's mail may carry
# a patient's details despite every warning. Nothing of the message is kept:
# no body, no subject, no display name, no attachment name. The bucket holds a
# message for as long as the handler takes, and at most a day (its lifecycle,
# the backstop for a handler that failed; the hourly support-inbound-sweep job
# takes what a failed handler left).
#
# Encryption: the bucket's default encryption is SSE-KMS under the project's
# key with S3 Bucket Keys, as the export bucket; SES writes without naming an
# encryption, so the default applies, and the key policy lets SES use the
# key only for this receipt rule (kms.tf). The S3 action's own kms_key_arn is
# NOT used: it makes SES encrypt client-side with the S3 encryption client's
# envelope, which only the Java and Ruby SDKs decrypt; server-side encryption
# keeps the object encrypted at rest under the same key and lets the app read
# it with a plain GetObject. The topic is encrypted with the same key too,
# since SES's notice names the sender and the subject.
#
# One active receipt rule set per region. SES keeps exactly one active, so
# activating ours would silently deactivate any other. Hence
# inbound_mail_rule_set_name: empty (the default), this stack creates its own
# set and activates it; set to the name of a set that is already active (the
# owner checks in CloudShell: aws ses describe-active-receipt-rule-set), the
# rule is added to that set and nothing is activated or deactivated.
#
# The subscription is like SES events' (ses.tf): SNS checks the endpoint when
# it subscribes, and the app answers only once its task carries
# HEALDESK_INBOUND_MAIL_TOPIC_ARN, which a deploy after the first apply gives
# it. So subscribe_inbound_mail is a second step, after that deploy. Until
# then (and whenever a notice is lost) the hourly sweep reads the bucket.

locals {
  inbound_on = var.enable_inbound_mail

  inbound_bucket       = "${local.name}-inbound-mail-${local.account_id}"
  inbound_bucket_arn   = "arn:aws:s3:::${local.inbound_bucket}"
  inbound_prefix       = "mail/"
  inbound_topic_name   = "${local.name}-inbound-mail"
  inbound_endpoint     = "${local.app_url}/api/webhooks/inbound-mail"
  inbound_recipient    = "hello@${var.inbound_mail_domain}"
  inbound_rule_name    = "${local.name}-support-mail"
  inbound_own_rule_set = var.inbound_mail_rule_set_name == ""
  inbound_rule_set     = local.inbound_own_rule_set ? "${local.name}-inbound" : var.inbound_mail_rule_set_name
  inbound_rule_arn     = "arn:aws:ses:${var.region}:${local.account_id}:receipt-rule-set/${local.inbound_rule_set}:receipt-rule/${local.inbound_rule_name}"
  inbound_mx_host      = "inbound-smtp.${var.region}.amazonaws.com"
}

# ---------------------------------------------------------------------------
# DNS: the subdomain's MX, and nothing on the root domain
# ---------------------------------------------------------------------------

resource "cloudflare_dns_record" "inbound_mx" {
  count = local.inbound_on ? 1 : 0

  zone_id  = var.cloudflare_zone_id
  name     = var.inbound_mail_domain
  type     = "MX"
  content  = local.inbound_mx_host
  priority = 10
  ttl      = 300
  proxied  = false
  comment  = "infra/aws: support mail to SES receiving. Root MX untouched."
}

# ---------------------------------------------------------------------------
# The bucket: one message at a time, a day at most
# ---------------------------------------------------------------------------

resource "aws_s3_bucket" "inbound_mail" {
  count = local.inbound_on ? 1 : 0

  bucket = local.inbound_bucket
  # A message is never a record: the handler deletes it at once and the
  # lifecycle within a day. Switching the feature off must not fail on a
  # message still waiting there.
  force_destroy = true

  #checkov:skip=CKV_AWS_18:Server access logs would copy object keys into another bucket; every object read and write is a CloudTrail data event (cloudtrail.tf).
  #checkov:skip=CKV_AWS_144:Cross-region replication would copy clinics' mail outside us-east-1, the only region designated in the BAA record.
  #checkov:skip=CKV2_AWS_62:SES publishes its own notice to the inbound topic with each message; an S3 event notification would be a second one.
  #checkov:skip=CKV_AWS_21:Versioning would keep a deleted message as a previous version; the handler's delete must be final.
  #checkov:skip=CKV2_AWS_61:The lifecycle configuration is aws_s3_bucket_lifecycle_configuration.inbound_mail (one day).
}

resource "aws_s3_bucket_ownership_controls" "inbound_mail" {
  count = local.inbound_on ? 1 : 0

  bucket = aws_s3_bucket.inbound_mail[0].id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_public_access_block" "inbound_mail" {
  count = local.inbound_on ? 1 : 0

  bucket                  = aws_s3_bucket.inbound_mail[0].id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "inbound_mail" {
  count = local.inbound_on ? 1 : 0

  bucket = aws_s3_bucket.inbound_mail[0].id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.main.arn
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "inbound_mail" {
  count = local.inbound_on ? 1 : 0

  bucket = aws_s3_bucket.inbound_mail[0].id

  rule {
    id     = "a-message-nobody-read-goes-anyway"
    status = "Enabled"

    filter {}

    expiration {
      days = 1
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 1
    }
  }
}

data "aws_iam_policy_document" "inbound_mail_bucket" {
  count = local.inbound_on ? 1 : 0

  # The Config rule s3-bucket-ssl-requests-only checks every bucket for this.
  statement {
    sid       = "DenyAnythingWithoutTls"
    effect    = "Deny"
    actions   = ["s3:*"]
    resources = [local.inbound_bucket_arn, "${local.inbound_bucket_arn}/*"]

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }

  statement {
    sid       = "DenyUploadsNotUnderKms"
    effect    = "Deny"
    actions   = ["s3:PutObject"]
    resources = ["${local.inbound_bucket_arn}/*"]

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    condition {
      test     = "StringNotEqualsIfExists"
      variable = "s3:x-amz-server-side-encryption"
      values   = ["aws:kms"]
    }
  }

  # SES writes here for this account's one receipt rule, under the prefix.
  statement {
    sid       = "SesWritesThisRulesMail"
    actions   = ["s3:PutObject"]
    resources = ["${local.inbound_bucket_arn}/${local.inbound_prefix}*"]

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
      test     = "StringEquals"
      variable = "aws:SourceArn"
      values   = [local.inbound_rule_arn]
    }
  }
}

resource "aws_s3_bucket_policy" "inbound_mail" {
  count = local.inbound_on ? 1 : 0

  bucket = aws_s3_bucket.inbound_mail[0].id
  policy = data.aws_iam_policy_document.inbound_mail_bucket[0].json

  depends_on = [aws_s3_bucket_public_access_block.inbound_mail]
}

# ---------------------------------------------------------------------------
# The topic SES tells the app on
# ---------------------------------------------------------------------------

resource "aws_sns_topic" "inbound_mail" {
  count = local.inbound_on ? 1 : 0

  name              = local.inbound_topic_name
  signature_version = 2
  kms_master_key_id = aws_kms_key.main.arn
}

data "aws_iam_policy_document" "inbound_mail_topic" {
  count = local.inbound_on ? 1 : 0

  statement {
    sid       = "SesPublishesThisRulesNotices"
    actions   = ["sns:Publish"]
    resources = [aws_sns_topic.inbound_mail[0].arn]

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
      values   = [local.inbound_rule_arn]
    }
  }
}

resource "aws_sns_topic_policy" "inbound_mail" {
  count = local.inbound_on ? 1 : 0

  arn    = aws_sns_topic.inbound_mail[0].arn
  policy = data.aws_iam_policy_document.inbound_mail_topic[0].json
}

resource "aws_sns_topic_subscription" "inbound_mail_app" {
  # Only once the app answers with the topic it trusts (see the header):
  # standby removes the public host it posts to, and this with it.
  count = local.inbound_on && var.subscribe_inbound_mail && !var.standby ? 1 : 0

  topic_arn              = aws_sns_topic.inbound_mail[0].arn
  protocol               = "https"
  endpoint               = local.inbound_endpoint
  endpoint_auto_confirms = false
  raw_message_delivery   = false

  # As ses_events_app: twelve tries over about three quarters of an hour (SNS
  # refuses a policy whose retries add up to more than an hour). A notice
  # SNS gives up on is not lost: the hourly sweep reads the bucket.
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

# ---------------------------------------------------------------------------
# The receipt rule
# ---------------------------------------------------------------------------

resource "aws_ses_receipt_rule_set" "inbound" {
  count = local.inbound_on && local.inbound_own_rule_set ? 1 : 0

  rule_set_name = local.inbound_rule_set
}

# Only for a set this stack created: an existing active set stays active
# and is never replaced (see the header).
resource "aws_ses_active_receipt_rule_set" "inbound" {
  count = local.inbound_on && local.inbound_own_rule_set ? 1 : 0

  rule_set_name = aws_ses_receipt_rule_set.inbound[0].rule_set_name
}

resource "aws_ses_receipt_rule" "support_mail" {
  count = local.inbound_on ? 1 : 0

  name          = local.inbound_rule_name
  rule_set_name = local.inbound_own_rule_set ? aws_ses_receipt_rule_set.inbound[0].rule_set_name : var.inbound_mail_rule_set_name
  recipients    = [local.inbound_recipient]
  enabled       = true
  scan_enabled  = true
  tls_policy    = "Require"

  s3_action {
    position          = 1
    bucket_name       = aws_s3_bucket.inbound_mail[0].bucket
    object_key_prefix = local.inbound_prefix
    topic_arn         = aws_sns_topic.inbound_mail[0].arn
  }

  # SES checks it may write and publish when the rule is created.
  depends_on = [
    aws_s3_bucket_policy.inbound_mail,
    aws_s3_bucket_server_side_encryption_configuration.inbound_mail,
    aws_sns_topic_policy.inbound_mail,
  ]

  lifecycle {
    precondition {
      condition     = var.enable_ses
      error_message = "enable_inbound_mail needs enable_ses: SES receives only for a domain it has verified, and healdesk.io's identity (ses.tf) covers the inbound subdomain."
    }
  }
}
