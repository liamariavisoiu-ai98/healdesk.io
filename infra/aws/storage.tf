# The transcript bucket: built, and off (enable_transcript_bucket = false),
# because no code writes transcripts to S3 yet; the working transcript lives
# in the database. Turned on, it is what docs/handover.md lists for S3 and
# what the design record's statement 2 expects (iam.tf):
#
#   - SSE-KMS under our key with S3 Bucket Keys, so S3 asks KMS with the
#     bucket's ARN as the encryption context (the task role's KMS statement
#     for S3 names exactly that), and a policy refusing any upload that names
#     another kind of encryption;
#   - TLS only, no public access of any kind, objects owned by the bucket;
#   - versioned, and a delete is a delete: a previous version expires a week
#     after it stops being current, well inside the 35 days the clinic
#     agreement allows any copy of deleted data;
#   - every object expires at transcript_retention_days, the longest a clinic
#     can keep transcripts; a clinic that keeps them shorter has the app
#     delete them (clinics.retention_media_days);
#   - every object read and write is a CloudTrail data event (cloudtrail.tf).
#
# Object keys must never carry a patient identifier. prevent_destroy keeps a
# plan from deleting the bucket, including by switching the flag back off.

locals {
  transcript_bucket     = "${local.name}-transcripts-${local.account_id}"
  transcript_bucket_arn = "arn:aws:s3:::${local.transcript_bucket}"
}

resource "aws_s3_bucket" "transcripts" {
  count = var.enable_transcript_bucket ? 1 : 0

  bucket        = local.transcript_bucket
  force_destroy = false

  lifecycle {
    prevent_destroy = true
  }

  #checkov:skip=CKV_AWS_18:Server access logs would need another bucket and would copy object keys; every object read and write is already a CloudTrail data event (cloudtrail.tf).
  #checkov:skip=CKV_AWS_144:Cross-region replication would copy transcripts outside us-east-1, the only region designated in the BAA record.
  #checkov:skip=CKV2_AWS_62:No consumer for object notifications; the app writes and reads its own objects.
}

resource "aws_s3_bucket_ownership_controls" "transcripts" {
  count = var.enable_transcript_bucket ? 1 : 0

  bucket = aws_s3_bucket.transcripts[0].id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_public_access_block" "transcripts" {
  count = var.enable_transcript_bucket ? 1 : 0

  bucket                  = aws_s3_bucket.transcripts[0].id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "transcripts" {
  count = var.enable_transcript_bucket ? 1 : 0

  bucket = aws_s3_bucket.transcripts[0].id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "transcripts" {
  count = var.enable_transcript_bucket ? 1 : 0

  bucket = aws_s3_bucket.transcripts[0].id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.main.arn
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "transcripts" {
  count = var.enable_transcript_bucket ? 1 : 0

  bucket = aws_s3_bucket.transcripts[0].id

  # Current objects go at the longest retention a clinic can choose.
  rule {
    id     = "expire-at-the-longest-clinic-retention"
    status = "Enabled"

    filter {}

    expiration {
      days = var.transcript_retention_days
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 1
    }
  }

  # A deleted or expired object's previous version goes a week later, and the
  # delete marker left with nothing behind it goes too.
  rule {
    id     = "deleted-means-gone"
    status = "Enabled"

    filter {}

    noncurrent_version_expiration {
      noncurrent_days = 7
    }

    expiration {
      expired_object_delete_marker = true
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 1
    }
  }

  depends_on = [aws_s3_bucket_versioning.transcripts]
}

data "aws_iam_policy_document" "transcripts_bucket" {
  count = var.enable_transcript_bucket ? 1 : 0

  # The Config rule s3-bucket-ssl-requests-only checks every bucket for this.
  statement {
    sid       = "DenyAnythingWithoutTls"
    effect    = "Deny"
    actions   = ["s3:*"]
    resources = [local.transcript_bucket_arn, "${local.transcript_bucket_arn}/*"]

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

  # An upload that names no encryption gets the bucket's default (our key).
  # One that names another kind (S3-managed keys, customer-provided keys)
  # would bypass the key and its audit trail, so it is refused.
  statement {
    sid       = "DenyUploadsNotUnderKms"
    effect    = "Deny"
    actions   = ["s3:PutObject"]
    resources = ["${local.transcript_bucket_arn}/*"]

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
}

resource "aws_s3_bucket_policy" "transcripts" {
  count = var.enable_transcript_bucket ? 1 : 0

  bucket = aws_s3_bucket.transcripts[0].id
  policy = data.aws_iam_policy_document.transcripts_bucket[0].json

  depends_on = [aws_s3_bucket_public_access_block.transcripts]
}
