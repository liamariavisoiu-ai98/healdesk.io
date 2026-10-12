# The export bucket: where a leaving clinic's return bundle lands, because a
# Fargate task's disk goes with the task. docs/handover.md ("Retention and
# offboarding", step 2) has the operator produce the bundle; on this host that
# is the one-off patient-export task (ecs.tf), run with
# infra/aws/scripts/run-task.sh patient-export, which writes one object here
# and nothing else anywhere. The operator downloads it in CloudShell, hands it
# over by the route the handover names, deletes it, and records the handover.
#
# The bundle is PHI and the agreement's destruction clock covers every copy,
# so the bucket keeps nothing for long and keeps no history:
#
#   - SSE-KMS under our key with S3 Bucket Keys (S3 asks KMS with the
#     bucket's ARN as the encryption context), and a policy refusing any
#     upload that names another kind of encryption;
#   - TLS only, no public access of any kind, objects owned by the bucket;
#   - NOT versioned: the operator's delete after the handover is final, and an
#     object nobody deletes is gone after export_retention_days anyway, well
#     inside the thirty days the 1.3.0 agreement gives the export;
#   - every object read and write is a CloudTrail data event (cloudtrail.tf):
#     who downloaded which clinic's bundle, and when.
#
# Object keys name the clinic id and a time, never a patient. Only the export
# task's role may write here; reading is for administrators, through the key
# policy's delegation to IAM. prevent_destroy keeps a plan from deleting the
# bucket.

locals {
  export_bucket          = "${local.name}-exports-${local.account_id}"
  export_bucket_arn      = "arn:aws:s3:::${local.export_bucket}"
  export_retention_days  = 7
  export_task_family     = "${local.name}-patient-export"
  export_task_role_name  = "${local.name}-export-task"
  export_object_key_glob = "${local.export_bucket_arn}/clinic-*.json"
}

resource "aws_s3_bucket" "exports" {
  bucket        = local.export_bucket
  force_destroy = false

  lifecycle {
    prevent_destroy = true
  }

  #checkov:skip=CKV_AWS_18:Server access logs would need another bucket and would copy object keys; every object read and write is already a CloudTrail data event (cloudtrail.tf).
  #checkov:skip=CKV_AWS_144:Cross-region replication would copy patient bundles outside us-east-1, the only region designated in the BAA record.
  #checkov:skip=CKV2_AWS_62:No consumer for object notifications; the operator reads the one object a run wrote.
  #checkov:skip=CKV_AWS_21:Versioning would keep a deleted bundle as a previous version; the operator's delete after the handover must be final, and nothing here is a system of record (the database is).
}

resource "aws_s3_bucket_ownership_controls" "exports" {
  bucket = aws_s3_bucket.exports.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_public_access_block" "exports" {
  bucket                  = aws_s3_bucket.exports.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "exports" {
  bucket = aws_s3_bucket.exports.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.main.arn
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "exports" {
  bucket = aws_s3_bucket.exports.id

  rule {
    id     = "a-bundle-nobody-deleted-goes-anyway"
    status = "Enabled"

    filter {}

    expiration {
      days = local.export_retention_days
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 1
    }
  }
}

data "aws_iam_policy_document" "exports_bucket" {
  # The Config rule s3-bucket-ssl-requests-only checks every bucket for this.
  statement {
    sid       = "DenyAnythingWithoutTls"
    effect    = "Deny"
    actions   = ["s3:*"]
    resources = [local.export_bucket_arn, "${local.export_bucket_arn}/*"]

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

  # An upload naming another kind of encryption would bypass the key and its
  # audit trail.
  statement {
    sid       = "DenyUploadsNotUnderKms"
    effect    = "Deny"
    actions   = ["s3:PutObject"]
    resources = ["${local.export_bucket_arn}/*"]

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

resource "aws_s3_bucket_policy" "exports" {
  bucket = aws_s3_bucket.exports.id
  policy = data.aws_iam_policy_document.exports_bucket.json

  depends_on = [aws_s3_bucket_public_access_block.exports]
}

# ---------------------------------------------------------------------------
# The export task's role: write one kind of object here, and nothing else.
# ---------------------------------------------------------------------------
# The bundle is read from the database with the runtime role's URL (an ECS
# secret, through the execution role); nothing in it is sealed, so this role
# has no use of the key beyond S3's, and no read of the bucket: the task
# writes its bundle and stops. It is not the app task role, so the web tier
# and the worker cannot write here, and this task cannot open a clinic's
# credentials.
resource "aws_iam_role" "export_task" {
  name               = local.export_task_role_name
  description        = "The one-off patient-export task: put a clinic's return bundle into the export bucket, nothing else"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

data "aws_iam_policy_document" "export_task" {
  statement {
    sid       = "PutReturnBundles"
    actions   = ["s3:PutObject", "s3:AbortMultipartUpload"]
    resources = [local.export_object_key_glob]
  }

  # S3 asking KMS with this role's permissions. With Bucket Keys on, S3's
  # context is the bucket's ARN. Decrypt is what a multipart upload needs to
  # finish; without s3:GetObject it reads nothing.
  statement {
    sid       = "S3UsesTheKeyForExports"
    actions   = ["kms:GenerateDataKey", "kms:Decrypt"]
    resources = [aws_kms_key.main.arn]

    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["s3.${var.region}.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "kms:EncryptionContext:aws:s3:arn"
      values   = [local.export_bucket_arn]
    }
  }
}

resource "aws_iam_role_policy" "export_task" {
  name   = "put-return-bundles"
  role   = aws_iam_role.export_task.id
  policy = data.aws_iam_policy_document.export_task.json
}
