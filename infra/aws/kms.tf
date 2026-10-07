# One customer-managed key for everything (owner, 5 October 2026): sealed
# clinic credentials, RDS storage, the transcript bucket, log groups, the
# trail and the secrets.
#
# The key policy delegates to IAM through the account's own statement and
# names the task role nowhere (docs/design/google-calendar-2026-10-05.md §5):
# KMS allows a call that either the key policy or an IAM policy allows, so a
# key-policy grant to the role would make the conditions in iam.tf moot. The
# service principals below are the services that encrypt under their own
# names; RDS and Secrets Manager use grants made by whoever creates them.

data "aws_caller_identity" "current" {}

locals {
  log_group_prefix = "/healdesk/apps-app"
}

data "aws_iam_policy_document" "kms" {
  statement {
    sid       = "AccountDelegatesToIam"
    actions   = ["kms:*"]
    resources = ["*"]

    principals {
      type        = "AWS"
      identifiers = ["arn:aws:iam::${var.account_id}:root"]
    }
  }

  statement {
    sid = "CloudWatchLogsForOurLogGroups"
    actions = [
      "kms:Encrypt",
      "kms:Decrypt",
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
      values   = ["arn:aws:logs:${var.region}:${var.account_id}:log-group:${local.log_group_prefix}/*"]
    }
  }

  statement {
    sid       = "CloudTrailEncryptsItsLogs"
    actions   = ["kms:GenerateDataKey*"]
    resources = ["*"]

    principals {
      type        = "Service"
      identifiers = ["cloudtrail.amazonaws.com"]
    }

    condition {
      test     = "StringLike"
      variable = "kms:EncryptionContext:aws:cloudtrail:arn"
      values   = ["arn:aws:cloudtrail:*:${var.account_id}:trail/*"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceArn"
      values   = ["arn:aws:cloudtrail:${var.region}:${var.account_id}:trail/${var.name}"]
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
  }
}

resource "aws_kms_key" "main" {
  description             = "healdesk apps/app: sealed credentials, RDS, transcripts, logs, trail, secrets"
  key_usage               = "ENCRYPT_DECRYPT"
  multi_region            = false
  enable_key_rotation     = true
  deletion_window_in_days = 30
  policy                  = data.aws_iam_policy_document.kms.json
}

# For people and the console. The app takes the full key ARN and refuses an
# alias (lib/crypto/kms.ts).
resource "aws_kms_alias" "main" {
  name          = "alias/${var.name}"
  target_key_id = aws_kms_key.main.key_id
}
