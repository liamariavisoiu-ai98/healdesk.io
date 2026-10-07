# The transcript bucket. No transcript object exists yet; the bucket is made
# now so the trail, the task role and the key's S3 statement are in place
# before one does. Keys carry no patient identifier.

resource "aws_s3_bucket" "transcripts" {
  bucket = "${var.name}-transcripts-${var.account_id}"

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_s3_bucket_ownership_controls" "transcripts" {
  bucket = aws_s3_bucket.transcripts.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_public_access_block" "transcripts" {
  bucket                  = aws_s3_bucket.transcripts.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "transcripts" {
  bucket = aws_s3_bucket.transcripts.id

  versioning_configuration {
    status = "Enabled"
  }
}

# Bucket keys on: S3 then asks KMS with the bucket's ARN as context, which is
# what the task role's S3 statement names (iam.tf).
resource "aws_s3_bucket_server_side_encryption_configuration" "transcripts" {
  bucket = aws_s3_bucket.transcripts.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.main.arn
    }
    bucket_key_enabled = true
  }
}

# Retention is per clinic (clinics.retention_media_days) and enforced by the
# app deleting objects, which a single bucket rule cannot express. What this
# rule guarantees is that a delete is a delete: with versioning on, the
# previous version would otherwise outlive the clinic's retention forever.
resource "aws_s3_bucket_lifecycle_configuration" "transcripts" {
  bucket = aws_s3_bucket.transcripts.id

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

data "aws_iam_policy_document" "transcripts" {
  statement {
    sid       = "DenyInsecureTransport"
    effect    = "Deny"
    actions   = ["s3:*"]
    resources = [aws_s3_bucket.transcripts.arn, "${aws_s3_bucket.transcripts.arn}/*"]

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

resource "aws_s3_bucket_policy" "transcripts" {
  bucket = aws_s3_bucket.transcripts.id
  policy = data.aws_iam_policy_document.transcripts.json

  depends_on = [aws_s3_bucket_public_access_block.transcripts]
}
