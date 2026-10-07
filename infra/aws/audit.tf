# The BAA's audit and log obligations (§4.2(b), §4.2(c)): CloudTrail on and
# kept, encrypted with our key and validated; S3 data events for the
# transcript bucket; every log group encrypted and never expiring.

resource "aws_s3_bucket" "trail" {
  bucket = "${var.name}-cloudtrail-${var.account_id}"

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_s3_bucket_ownership_controls" "trail" {
  bucket = aws_s3_bucket.trail.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_public_access_block" "trail" {
  bucket                  = aws_s3_bucket.trail.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "trail" {
  bucket = aws_s3_bucket.trail.id

  versioning_configuration {
    status = "Enabled"
  }
}

data "aws_iam_policy_document" "trail_bucket" {
  statement {
    sid       = "CloudTrailAclCheck"
    actions   = ["s3:GetBucketAcl"]
    resources = [aws_s3_bucket.trail.arn]

    principals {
      type        = "Service"
      identifiers = ["cloudtrail.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceArn"
      values   = ["arn:aws:cloudtrail:${var.region}:${var.account_id}:trail/${var.name}"]
    }
  }

  statement {
    sid       = "CloudTrailWrite"
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.trail.arn}/AWSLogs/${var.account_id}/*"]

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
      values   = ["arn:aws:cloudtrail:${var.region}:${var.account_id}:trail/${var.name}"]
    }
  }

  statement {
    sid       = "DenyInsecureTransport"
    effect    = "Deny"
    actions   = ["s3:*"]
    resources = [aws_s3_bucket.trail.arn, "${aws_s3_bucket.trail.arn}/*"]

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

resource "aws_s3_bucket_policy" "trail" {
  bucket = aws_s3_bucket.trail.id
  policy = data.aws_iam_policy_document.trail_bucket.json

  depends_on = [aws_s3_bucket_public_access_block.trail]
}

# Every region, so activity outside us-east-1 (where nothing of ours runs)
# still shows up. KMS calls are management events and are all recorded.
resource "aws_cloudtrail" "main" {
  name                          = var.name
  s3_bucket_name                = aws_s3_bucket.trail.id
  kms_key_id                    = aws_kms_key.main.arn
  is_multi_region_trail         = true
  include_global_service_events = true
  enable_log_file_validation    = true

  advanced_event_selector {
    name = "Management events"

    field_selector {
      field  = "eventCategory"
      equals = ["Management"]
    }
  }

  advanced_event_selector {
    name = "Transcript object reads and writes"

    field_selector {
      field  = "eventCategory"
      equals = ["Data"]
    }

    field_selector {
      field  = "resources.type"
      equals = ["AWS::S3::Object"]
    }

    field_selector {
      field       = "resources.ARN"
      starts_with = ["${aws_s3_bucket.transcripts.arn}/"]
    }
  }

  depends_on = [aws_s3_bucket_policy.trail]
}

# stdout of the tasks, from the allowlisting, scrubbing logger (lib/log.ts).
# 0 is CloudWatch's "Never expire".
resource "aws_cloudwatch_log_group" "tasks" {
  for_each = toset(["web", "worker", "admin"])

  name              = "${local.log_group_prefix}/${each.key}"
  kms_key_id        = aws_kms_key.main.arn
  retention_in_days = 0
}
