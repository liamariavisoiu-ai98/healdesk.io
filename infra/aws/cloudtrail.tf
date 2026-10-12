# One multi-region trail of every management event, reads included, so every
# KMS Decrypt and GenerateDataKey is recorded: the code's audit story relies on
# "every unwrap is a CloudTrail event" (lib/crypto/kms.ts), and the account
# record asks for every KMS operation. Log files are validated (digest files)
# and encrypted with our key, and kept indefinitely: no lifecycle rule ever
# expires them (AWS addendum section 4.2(c)).

locals {
  trail_name   = local.name
  trail_arn    = "arn:aws:cloudtrail:${var.region}:${local.account_id}:trail/${local.trail_name}"
  trail_bucket = "${local.name}-cloudtrail-${local.account_id}"
}

resource "aws_s3_bucket" "cloudtrail" {
  bucket        = local.trail_bucket
  force_destroy = false

  #checkov:skip=CKV_AWS_18:This is the audit-log bucket itself; access logging it would need another bucket, and every API call on it is already a CloudTrail event.
  #checkov:skip=CKV_AWS_144:Cross-region replication would copy the trail outside us-east-1, the only region designated in the BAA record.
  #checkov:skip=CKV2_AWS_62:No consumer for object notifications; the trail is read on demand.
  #checkov:skip=CKV2_AWS_61:Trail objects never expire (addendum 4.2(c)); a lifecycle configuration is deliberately absent.
}

resource "aws_s3_bucket_ownership_controls" "cloudtrail" {
  bucket = aws_s3_bucket.cloudtrail.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_public_access_block" "cloudtrail" {
  bucket                  = aws_s3_bucket.cloudtrail.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "cloudtrail" {
  bucket = aws_s3_bucket.cloudtrail.id

  versioning_configuration {
    status = "Enabled"
  }
}

# Default encryption with our key, and no S3 Bucket Key: CloudTrail writes
# with the trail's key itself, and a Bucket Key would also require granting
# CloudTrail kms:Decrypt.
resource "aws_s3_bucket_server_side_encryption_configuration" "cloudtrail" {
  bucket = aws_s3_bucket.cloudtrail.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.main.arn
    }
    bucket_key_enabled = false
  }
}

data "aws_iam_policy_document" "cloudtrail_bucket" {
  statement {
    sid       = "CloudTrailChecksTheBucketAcl"
    actions   = ["s3:GetBucketAcl"]
    resources = [aws_s3_bucket.cloudtrail.arn]

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

  statement {
    sid       = "CloudTrailWritesThisTrail"
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.cloudtrail.arn}/AWSLogs/${local.account_id}/*"]

    principals {
      type        = "Service"
      identifiers = ["cloudtrail.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "s3:x-amz-acl"
      values   = ["bucket-owner-full-control"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceArn"
      values   = [local.trail_arn]
    }
  }

  # The Config rule s3-bucket-ssl-requests-only checks every bucket for this.
  statement {
    sid       = "DenyAnythingWithoutTls"
    effect    = "Deny"
    actions   = ["s3:*"]
    resources = [aws_s3_bucket.cloudtrail.arn, "${aws_s3_bucket.cloudtrail.arn}/*"]

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
}

resource "aws_s3_bucket_policy" "cloudtrail" {
  bucket = aws_s3_bucket.cloudtrail.id
  policy = data.aws_iam_policy_document.cloudtrail_bucket.json

  depends_on = [aws_s3_bucket_public_access_block.cloudtrail]
}

resource "aws_cloudtrail" "main" {
  name                          = local.trail_name
  s3_bucket_name                = aws_s3_bucket.cloudtrail.id
  is_multi_region_trail         = true
  include_global_service_events = true
  enable_log_file_validation    = true
  enable_logging                = true
  kms_key_id                    = aws_kms_key.main.arn

  # Management events, read and write, with KMS events NOT excluded (no
  # exclude_management_event_sources). Every read and write of an object in
  # the export bucket (exports.tf), and in the transcript bucket when it is on
  # (storage.tf), is a data event too: who opened which object, and when.
  event_selector {
    read_write_type           = "All"
    include_management_events = true

    dynamic "data_resource" {
      for_each = concat([local.export_bucket_arn], var.enable_transcript_bucket ? [local.transcript_bucket_arn] : [])

      content {
        type   = "AWS::S3::Object"
        values = ["${data_resource.value}/"]
      }
    }
  }

  # CloudTrail checks the bucket policy when the trail is created.
  depends_on = [
    aws_s3_bucket_policy.cloudtrail,
    aws_s3_bucket_server_side_encryption_configuration.cloudtrail,
  ]

  #checkov:skip=CKV_AWS_252:No SNS notification per log file; nothing consumes it. Alarms are on metrics, and the trail is read on demand.
  #checkov:skip=CKV2_AWS_10:A CloudWatch Logs copy of the trail is optional in the compliance map and not in this build; the trail is kept in S3 indefinitely.
}
