# Four roles.
#
#   runtime execution  ECS itself, for the web tier and the worker: pull the
#                      image, write logs, read the runtime secret.
#   admin execution    ECS itself, for the one-off tasks: the same, but the
#                      admin secret and RDS's master secret instead.
#   app task           the web tier's and the worker's own AWS calls: KMS,
#                      SES and the transcript bucket, nothing else.
#   (no task role)     the one-off tasks make no AWS calls of their own.

data "aws_iam_policy_document" "ecs_tasks_assume" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [var.account_id]
    }
  }
}

# --- Execution roles -----------------------------------------------------------

resource "aws_iam_role" "runtime_execution" {
  name               = "${var.name}-runtime-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

resource "aws_iam_role" "admin_execution" {
  name               = "${var.name}-admin-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

resource "aws_iam_role_policy_attachment" "execution_managed" {
  for_each = {
    runtime = aws_iam_role.runtime_execution.name
    admin   = aws_iam_role.admin_execution.name
  }

  role       = each.value
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

data "aws_iam_policy_document" "runtime_execution" {
  statement {
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [aws_secretsmanager_secret.runtime.arn]
  }

  statement {
    actions   = ["kms:Decrypt"]
    resources = [aws_kms_key.main.arn]

    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["secretsmanager.${var.region}.amazonaws.com"]
    }
  }
}

resource "aws_iam_role_policy" "runtime_execution" {
  name   = "secrets"
  role   = aws_iam_role.runtime_execution.id
  policy = data.aws_iam_policy_document.runtime_execution.json
}

data "aws_iam_policy_document" "admin_execution" {
  statement {
    actions = ["secretsmanager:GetSecretValue"]
    resources = [
      aws_secretsmanager_secret.admin.arn,
      aws_db_instance.main.master_user_secret[0].secret_arn,
    ]
  }

  statement {
    actions   = ["kms:Decrypt"]
    resources = [aws_kms_key.main.arn]

    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["secretsmanager.${var.region}.amazonaws.com"]
    }
  }
}

resource "aws_iam_role_policy" "admin_execution" {
  name   = "secrets"
  role   = aws_iam_role.admin_execution.id
  policy = data.aws_iam_policy_document.admin_execution.json
}

# --- The app's task role ----------------------------------------------------------

resource "aws_iam_role" "app_task" {
  name               = "${var.name}-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

data "aws_iam_policy_document" "app_task" {
  # The app's own KMS calls (lib/crypto/kms.ts): the envelope's data keys.
  # With kms_require_lock_labels on, this is statement 1 of the design record
  # §5: both lock-label keys and no other in the context, and no AWS service
  # making the call. Before C6b the app sends no context, so the switch stays
  # off and only the service condition applies.
  statement {
    sid       = "AppSealsAndOpens"
    actions   = ["kms:GenerateDataKey", "kms:Decrypt", "kms:Encrypt"]
    resources = [aws_kms_key.main.arn]

    condition {
      test     = "Null"
      variable = "kms:ViaService"
      values   = ["true"]
    }

    dynamic "condition" {
      for_each = var.kms_require_lock_labels ? [1] : []
      content {
        test     = "Null"
        variable = "kms:EncryptionContext:healdesk:clinic"
        values   = ["false"]
      }
    }

    dynamic "condition" {
      for_each = var.kms_require_lock_labels ? [1] : []
      content {
        test     = "Null"
        variable = "kms:EncryptionContext:healdesk:login"
        values   = ["false"]
      }
    }

    dynamic "condition" {
      for_each = var.kms_require_lock_labels ? [1] : []
      content {
        test     = "ForAllValues:StringEquals"
        variable = "kms:EncryptionContextKeys"
        values   = ["healdesk:clinic", "healdesk:login"]
      }
    }
  }

  # Statement 2 of §5: S3 asking KMS for the transcript bucket, with the
  # bucket's ARN as context because bucket keys are on (storage.tf).
  statement {
    sid       = "S3ForTranscripts"
    actions   = ["kms:GenerateDataKey", "kms:Decrypt"]
    resources = [aws_kms_key.main.arn]

    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["s3.${var.region}.amazonaws.com"]
    }

    condition {
      test     = "StringLike"
      variable = "kms:EncryptionContext:aws:s3:arn"
      values   = [aws_s3_bucket.transcripts.arn]
    }
  }

  statement {
    sid       = "TranscriptObjects"
    actions   = ["s3:PutObject", "s3:GetObject", "s3:DeleteObject"]
    resources = ["${aws_s3_bucket.transcripts.arn}/*"]
  }

  # SES only through the configuration set that requires TLS. The transport
  # reads the set first and refuses to send unless its policy is REQUIRE
  # (lib/reporting/deliver.ts), hence GetConfigurationSet.
  statement {
    sid     = "SendThroughThePhiConfigurationSet"
    actions = ["ses:SendEmail", "ses:SendRawEmail"]
    resources = [
      aws_sesv2_email_identity.main.arn,
      aws_sesv2_configuration_set.phi.arn,
    ]
  }

  statement {
    sid       = "ReadThePhiConfigurationSet"
    actions   = ["ses:GetConfigurationSet"]
    resources = [aws_sesv2_configuration_set.phi.arn]
  }
}

resource "aws_iam_role_policy" "app_task" {
  name   = "kms-ses-s3"
  role   = aws_iam_role.app_task.id
  policy = data.aws_iam_policy_document.app_task.json
}
