# AWS Config records every supported resource and checks the four rules the
# handover names; the Security Official reviews the findings each quarter
# (docs/policies/aws-hipaa-account.md, review and change control).
#
# Configuration items describe resources, never their contents, so the
# delivery bucket uses S3-managed encryption: putting it under our key would
# need a key-policy grant for Config that the key otherwise does without.
# A custom role rather than Config's service-linked role
# (AWSServiceRoleForConfig): creating that role fails if the console made it
# first, and a role of our own neither collides with it nor depends on it. A
# region holds one recorder and one delivery channel, though: if Config was
# switched on in the console first, import those two (each by its name, with
# an import block) instead of letting this apply fail on them.

locals {
  config_bucket = "${local.name}-config-${local.account_id}"
}

resource "aws_s3_bucket" "config" {
  bucket        = local.config_bucket
  force_destroy = false

  #checkov:skip=CKV_AWS_145:Config snapshots hold resource metadata, not PHI; SSE-S3 keeps the KMS key policy free of a Config grant.
  #checkov:skip=CKV_AWS_18:Access logging would need yet another bucket; every API call on this one is already a CloudTrail event.
  #checkov:skip=CKV_AWS_144:Cross-region replication would copy data outside us-east-1, the only designated region.
  #checkov:skip=CKV2_AWS_62:No consumer for object notifications.
  #checkov:skip=CKV2_AWS_61:Configuration history is kept; no expiry is wanted for compliance evidence.
}

resource "aws_s3_bucket_ownership_controls" "config" {
  bucket = aws_s3_bucket.config.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_public_access_block" "config" {
  bucket                  = aws_s3_bucket.config.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "config" {
  bucket = aws_s3_bucket.config.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "config" {
  bucket = aws_s3_bucket.config.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

data "aws_iam_policy_document" "config_bucket" {
  statement {
    sid       = "DenyAnythingWithoutTls"
    effect    = "Deny"
    actions   = ["s3:*"]
    resources = [aws_s3_bucket.config.arn, "${aws_s3_bucket.config.arn}/*"]

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

resource "aws_s3_bucket_policy" "config" {
  bucket = aws_s3_bucket.config.id
  policy = data.aws_iam_policy_document.config_bucket.json

  depends_on = [aws_s3_bucket_public_access_block.config]
}

data "aws_iam_policy_document" "config_assume" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["config.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [local.account_id]
    }
  }
}

resource "aws_iam_role" "config" {
  name               = "${local.name}-config"
  description        = "AWS Config recorder: read resource configuration, deliver to the Config bucket"
  assume_role_policy = data.aws_iam_policy_document.config_assume.json
}

resource "aws_iam_role_policy_attachment" "config_read" {
  role       = aws_iam_role.config.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWS_ConfigRole"
}

data "aws_iam_policy_document" "config_delivery" {
  statement {
    sid       = "DeliverSnapshotsAndHistory"
    actions   = ["s3:PutObject", "s3:PutObjectAcl"]
    resources = ["${aws_s3_bucket.config.arn}/AWSLogs/${local.account_id}/*"]

    condition {
      test     = "StringEquals"
      variable = "s3:x-amz-acl"
      values   = ["bucket-owner-full-control"]
    }
  }

  statement {
    sid       = "CheckTheBucket"
    actions   = ["s3:GetBucketAcl"]
    resources = [aws_s3_bucket.config.arn]
  }
}

resource "aws_iam_role_policy" "config_delivery" {
  name   = "deliver-to-config-bucket"
  role   = aws_iam_role.config.id
  policy = data.aws_iam_policy_document.config_delivery.json
}

resource "aws_config_configuration_recorder" "main" {
  name     = local.name
  role_arn = aws_iam_role.config.arn

  recording_group {
    all_supported                 = true
    include_global_resource_types = true
  }
}

resource "aws_config_delivery_channel" "main" {
  name           = local.name
  s3_bucket_name = aws_s3_bucket.config.id

  snapshot_delivery_properties {
    delivery_frequency = "TwentyFour_Hours"
  }

  depends_on = [
    aws_config_configuration_recorder.main,
    aws_s3_bucket_policy.config,
    aws_iam_role_policy.config_delivery,
  ]
}

resource "aws_config_configuration_recorder_status" "main" {
  name       = aws_config_configuration_recorder.main.name
  is_enabled = true

  depends_on = [aws_config_delivery_channel.main]
}

resource "aws_config_config_rule" "managed" {
  for_each = {
    "rds-storage-encrypted"          = "RDS_STORAGE_ENCRYPTED"
    "s3-bucket-ssl-requests-only"    = "S3_BUCKET_SSL_REQUESTS_ONLY"
    "cloud-trail-encryption-enabled" = "CLOUD_TRAIL_ENCRYPTION_ENABLED"
    "cloudwatch-log-group-encrypted" = "CLOUDWATCH_LOG_GROUP_ENCRYPTED"
  }

  name = each.key

  source {
    owner             = "AWS"
    source_identifier = each.value
  }

  depends_on = [aws_config_configuration_recorder_status.main]
}
