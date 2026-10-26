# One customer-managed, single-region, symmetric key: the credential vault's
# key-encryption key (HEALDESK_KMS_KEY_ID) and the key behind RDS storage, the
# RDS master secret, Performance Insights, the SSM parameters, ECR, every log
# group and the CloudTrail trail.
#
# Never replace it. The app sends this exact ARN as the KeyId on every Decrypt
# (lib/crypto/kms.ts), so a credential sealed under it cannot be opened under
# any other key, and rewrap() cannot bridge two keys. Automatic rotation keeps
# the ARN and the old key material, which is why it is the only rotation used.
# prevent_destroy makes any plan that would replace or delete it fail.

resource "aws_kms_key" "main" {
  description              = "${local.name}: credential vault, RDS, SSM, ECR, logs and CloudTrail"
  key_usage                = "ENCRYPT_DECRYPT"
  customer_master_key_spec = "SYMMETRIC_DEFAULT"
  multi_region             = false
  enable_key_rotation      = true
  deletion_window_in_days  = 30
  policy                   = data.aws_iam_policy_document.kms.json

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_kms_alias" "main" {
  name          = "alias/${local.name}"
  target_key_id = aws_kms_key.main.key_id
}

# The key policy names only what IAM cannot express. Everyone else (the ECS
# roles, the Terraform role that creates RDS, SSM and ECR resources under the
# key) is authorised by IAM through the account-root statement, with
# kms:ViaService conditions where a service uses the key on a role's behalf.
# It names the app's task role in no statement of its own, and must never:
# KMS allows a call that either the key policy or an IAM policy allows, so a
# statement naming the role without the lock-label conditions (the console's
# default "key users" one, say) would make those conditions in iam.tf moot
# (docs/design/google-calendar-2026-10-05.md section 5).
data "aws_iam_policy_document" "kms" {
  statement {
    sid       = "AccountRootDelegatesToIam"
    actions   = ["kms:*"]
    resources = ["*"]

    principals {
      type        = "AWS"
      identifiers = ["arn:aws:iam::${local.account_id}:root"]
    }
  }

  # CloudWatch Logs encrypts each log group with the key itself, as a service
  # principal, and only for this account's log groups in this region.
  statement {
    sid = "CloudWatchLogsForThisAccountsLogGroups"
    actions = [
      "kms:Encrypt*",
      "kms:Decrypt*",
      "kms:ReEncrypt*",
      "kms:GenerateDataKey*",
      "kms:Describe*",
    ]
    resources = ["*"]

    principals {
      type        = "Service"
      identifiers = ["logs.${var.region}.amazonaws.com"]
    }

    condition {
      test     = "ArnLike"
      variable = "kms:EncryptionContext:aws:logs:arn"
      values   = ["arn:aws:logs:${var.region}:${local.account_id}:log-group:*"]
    }
  }

  # CloudTrail encrypts log and digest files for this trail only. The trail
  # bucket deliberately has no S3 Bucket Key, which would also require
  # granting CloudTrail kms:Decrypt.
  statement {
    sid       = "CloudTrailEncryptsThisTrail"
    actions   = ["kms:GenerateDataKey*"]
    resources = ["*"]

    principals {
      type        = "Service"
      identifiers = ["cloudtrail.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceArn"
      values   = [local.trail_arn]
    }

    condition {
      test     = "StringLike"
      variable = "kms:EncryptionContext:aws:cloudtrail:arn"
      values   = ["arn:aws:cloudtrail:*:${local.account_id}:trail/*"]
    }
  }

  statement {
    sid       = "CloudTrailDescribesTheKey"
    actions   = ["kms:DescribeKey"]
    resources = ["*"]

    principals {
      type        = "Service"
      identifiers = ["cloudtrail.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceArn"
      values   = [local.trail_arn]
    }
  }

  # Inbound support mail (ses-inbound.tf), while enable_inbound_mail is on:
  # SES encrypts the message it writes to the inbound bucket (the bucket's
  # default SSE-KMS, which S3 asks the key for on SES's behalf) and the
  # notice it publishes to the encrypted inbound topic, both for the one
  # receipt rule and nothing else. Decrypt is what AWS documents SES needs
  # beside GenerateDataKey for a server-side encrypted bucket. SES reads
  # nothing back: no grant here lets SES or anyone outside this account open
  # a message.
  dynamic "statement" {
    for_each = var.enable_inbound_mail ? [1] : []

    content {
      sid       = "SesEncryptsInboundSupportMail"
      actions   = ["kms:GenerateDataKey*", "kms:Decrypt"]
      resources = ["*"]

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

  #checkov:skip=CKV_AWS_109:This is a key policy, where "*" as the resource means this key and nothing else; kms:* for the account root is AWS's default statement that hands control to IAM, so no principal gains anything an IAM policy does not grant.
  #checkov:skip=CKV_AWS_111:Same reason: a key policy's "*" resource is the key itself, and the root statement only delegates to IAM.
  #checkov:skip=CKV_AWS_356:Same reason: in a key policy the resource is written "*", which AWS defines as the key the policy is attached to (its ARN does not exist until the key does).
}
