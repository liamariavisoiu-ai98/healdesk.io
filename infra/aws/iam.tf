# ---------------------------------------------------------------------------
# ECS roles. The execution role is used by the ECS agent before a container
# starts (pull the image, open the log stream, fetch the secrets); its
# credentials never reach application code. The task roles are what the code
# itself can do: the app may use the credential vault's key (and, when they
# exist, the transcript bucket and SES), the db-admin task may generate and
# read the six internal secrets and nothing else, and the migrate task has no
# task role.
# ---------------------------------------------------------------------------

data "aws_iam_policy_document" "ecs_tasks_assume" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }

    # Only ECS acting for this account, so no other account's tasks can be
    # handed these roles (the confused-deputy guard AWS recommends).
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [local.account_id]
    }

    condition {
      test     = "ArnLike"
      variable = "aws:SourceArn"
      values   = ["arn:aws:ecs:${var.region}:${local.account_id}:*"]
    }
  }
}

resource "aws_iam_role" "ecs_execution" {
  name               = "${local.name}-ecs-execution"
  description        = "ECS agent: pull images, write logs, inject secrets at task start"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

data "aws_iam_policy_document" "ecs_execution" {
  statement {
    sid       = "EcrAuthorizationToken"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }

  # Only our three repositories. If GuardDuty Runtime Monitoring with agent
  # management is ever enabled for Fargate, its sidecar is pulled from an AWS
  # repository with this role, and this statement must grow to allow it.
  statement {
    sid = "PullOurImages"
    actions = [
      "ecr:BatchCheckLayerAvailability",
      "ecr:GetDownloadUrlForLayer",
      "ecr:BatchGetImage",
    ]
    resources = [for repo in aws_ecr_repository.this : repo.arn]
  }

  statement {
    sid       = "WriteOurLogStreams"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = [for group in aws_cloudwatch_log_group.app : "${group.arn}:*"]
  }

  # Only the two paths a task definition names: app/ (web and worker) and
  # migrator/ (the migrate task). Not db/, which the db-bootstrap task reads
  # through its own role, and never ci/, where the Cloudflare token infra.yml
  # uses lives: a task definition that names either, whoever registers it,
  # fails to start.
  statement {
    sid     = "ReadTheTasksParameters"
    actions = ["ssm:GetParameters"]
    resources = [
      "arn:aws:ssm:${var.region}:${local.account_id}:parameter${local.param_prefix}/app/*",
      "arn:aws:ssm:${var.region}:${local.account_id}:parameter${local.param_prefix}/migrator/*",
    ]
  }

  # The RDS-managed master secret, and no other secret. Only the db-bootstrap
  # task definition references it.
  statement {
    sid       = "ReadRdsMasterSecret"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [aws_db_instance.main.master_user_secret[0].secret_arn]
  }

  # Decrypt only when SSM or Secrets Manager calls KMS for this role, never
  # directly. ECR decrypts image layers through its own grant.
  statement {
    sid       = "DecryptThroughSsmAndSecretsManager"
    actions   = ["kms:Decrypt"]
    resources = [aws_kms_key.main.arn]

    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values = [
        "ssm.${var.region}.amazonaws.com",
        "secretsmanager.${var.region}.amazonaws.com",
      ]
    }
  }
}

resource "aws_iam_role_policy" "ecs_execution" {
  name   = "pull-log-inject"
  role   = aws_iam_role.ecs_execution.id
  policy = data.aws_iam_policy_document.ecs_execution.json
}

# The app's task role. Its first statement is the credential vault's
# (lib/crypto/kms.ts): exactly GenerateDataKey, Decrypt and Encrypt on this
# key, only as calls the app makes itself (no kms:ViaService), and only with an
# encryption context of the two lock-label keys and no other. That last
# condition also holds for a call with no context at all, which an older image
# makes, but it refuses every context an AWS service puts on its own data
# under this key (SSM's PARAMETER_ARN, the logs and trail ARNs, RDS's and
# S3's), so the role cannot decrypt those even with the ciphertext in hand.
# With kms_require_lock_labels (the default), both labels must also be
# present: statement 1 of docs/design/google-calendar-2026-10-05.md section 5,
# as written there. The key policy names this role nowhere (kms.tf), so these
# conditions are the whole of what it may do with the key.
resource "aws_iam_role" "app_task" {
  name               = "${local.name}-app-task"
  description        = "Web and worker code: the credential vault's KMS calls only, plus the transcript bucket and SES when they exist"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

data "aws_iam_policy_document" "app_task" {
  statement {
    sid       = "CredentialVault"
    actions   = ["kms:GenerateDataKey", "kms:Decrypt", "kms:Encrypt"]
    resources = [aws_kms_key.main.arn]

    condition {
      test     = "Null"
      variable = "kms:ViaService"
      values   = ["true"]
    }

    condition {
      test     = "ForAllValues:StringEquals"
      variable = "kms:EncryptionContextKeys"
      values   = ["healdesk:clinic", "healdesk:login"]
    }

    dynamic "condition" {
      for_each = var.kms_require_lock_labels ? ["healdesk:clinic", "healdesk:login"] : []

      content {
        test     = "Null"
        variable = "kms:EncryptionContext:${condition.value}"
        values   = ["false"]
      }
    }
  }

  # Statement 2 of section 5: S3 asking KMS for the transcript bucket with
  # this role's permissions. With S3 Bucket Keys on (storage.tf), S3's context
  # is the bucket's ARN, not the object's.
  dynamic "statement" {
    for_each = var.enable_transcript_bucket ? [local.transcript_bucket_arn] : []

    content {
      sid       = "S3UsesTheKeyForTranscripts"
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
        values   = [statement.value]
      }
    }
  }

  dynamic "statement" {
    for_each = var.enable_transcript_bucket ? [local.transcript_bucket_arn] : []

    content {
      sid       = "TranscriptObjects"
      actions   = ["s3:PutObject", "s3:GetObject", "s3:DeleteObject"]
      resources = ["${statement.value}/*"]
    }
  }

  # SES only through the configuration set that requires TLS, as the domain
  # identity. lib/reporting/deliver.ts reads the set back and refuses to send
  # unless its policy is REQUIRE, hence GetConfigurationSet; attachments go
  # out as raw MIME.
  dynamic "statement" {
    for_each = var.enable_ses ? [1] : []

    content {
      sid       = "SendThroughThePhiConfigurationSet"
      actions   = ["ses:SendEmail", "ses:SendRawEmail"]
      resources = [local.ses_identity_arn, local.ses_configuration_set_arn]
    }
  }

  dynamic "statement" {
    for_each = var.enable_ses ? [1] : []

    content {
      sid       = "ReadThePhiConfigurationSet"
      actions   = ["ses:GetConfigurationSet"]
      resources = [local.ses_configuration_set_arn]
    }
  }
}

resource "aws_iam_role_policy" "app_task" {
  name   = "credential-vault"
  role   = aws_iam_role.app_task.id
  policy = data.aws_iam_policy_document.app_task.json
}

# The db-bootstrap task's role: generate the six internal secrets that are
# still "__unset__", read the two role passwords back, and nothing else
# (ssm.tf). GetParameter and PutParameter on exactly those six ARNs; the key
# only through SSM and only for those six parameters' own encryption context,
# so the role can neither read nor write any other parameter's value. The
# master credentials still arrive through the execution role's secrets, and
# psql talks only to the database. A role of its own keeps the task from ever
# being given the app's.
resource "aws_iam_role" "db_admin_task" {
  name               = "${local.name}-db-admin-task"
  description        = "db-bootstrap task: generate and read the six internal secrets, nothing else"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

locals {
  internal_parameter_arns = [for name in sort(keys(local.internal_parameter_paths)) : local.parameter_arns[name]]
}

data "aws_iam_policy_document" "db_admin_task" {
  statement {
    sid       = "GenerateAndReadTheInternalSecrets"
    actions   = ["ssm:GetParameter", "ssm:PutParameter"]
    resources = local.internal_parameter_arns
  }

  statement {
    sid       = "UseTheKeyThroughSsmForThemOnly"
    actions   = ["kms:Encrypt", "kms:GenerateDataKey", "kms:Decrypt"]
    resources = [aws_kms_key.main.arn]

    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["ssm.${var.region}.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "kms:EncryptionContext:PARAMETER_ARN"
      values   = local.internal_parameter_arns
    }
  }
}

resource "aws_iam_role_policy" "db_admin_task" {
  name   = "generate-internal-secrets"
  role   = aws_iam_role.db_admin_task.id
  policy = data.aws_iam_policy_document.db_admin_task.json
}

# ---------------------------------------------------------------------------
# The deploy role for .github/workflows/deploy-app.yml, assumed over GitHub
# OIDC (the provider is created by the bootstrap stack). AWS, not a check in a
# workflow file a branch can edit, decides who gets it. A token is accepted
# only when every condition holds, the same four as the bootstrap stack's
# Terraform role:
#
#   - aud is sts.amazonaws.com;
#   - sub is this repository's immutable subject for main (owner and
#     repository by numeric id). A job gets a :ref: subject only when it names
#     no GitHub environment, so no environment, and none of its settings, is
#     part of this control;
#   - ref is refs/heads/main: a pushed branch, a pull request, a fork or a
#     dispatch with --ref <branch> cannot match;
#   - actor_id is the owner's numeric GitHub id.
#
# What it cannot stop is code that reaches main, or anyone acting as the
# owner. And the role is as powerful as the code it deploys: it has no direct
# read of a secret and no direct use of the key, but every task definition it
# registers and runs receives the execution role's secrets (any app/ or
# migrator/ parameter and the RDS master secret) and can carry the app's or the
# db-admin task's role, with internet egress. So the main-branch pin above is
# the control, not the shortness of this policy.
#
# It can push the three images, register and read task definitions, update
# the two services, run the two one-off tasks on this cluster and watch them,
# and pass exactly the roles those tasks use. Never ECS Exec. Sessions may
# last up to the deploy job's two hours; the workflow renews its own anyway.
# ---------------------------------------------------------------------------

data "aws_iam_policy_document" "github_deploy_assume" {
  statement {
    sid     = "GitHubMainBranchRunByTheOwnerOnly"
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = ["arn:aws:iam::${local.account_id}:oidc-provider/token.actions.githubusercontent.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:sub"
      values   = var.github_oidc_subjects
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:ref"
      values   = ["refs/heads/main"]
    }

    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:actor_id"
      values   = [var.github_actor_id]
    }
  }

  #checkov:skip=CKV_AWS_358:False positive. The subject is GitHub's immutable form (repo:owner@id/repo@id:ref:refs/heads/main), compared exactly, with the ref and the actor pinned as well; checkov's owner/repo pattern predates that form and cannot parse the "@id" parts.
}

resource "aws_iam_role" "github_deploy" {
  name                 = "${local.name}-github-deploy"
  description          = "GitHub Actions deploy-app.yml on main, run by the owner: push images, register task definitions, roll the services"
  assume_role_policy   = data.aws_iam_policy_document.github_deploy_assume.json
  max_session_duration = 7200
}

locals {
  task_families = {
    web              = "${local.name}-web"
    worker           = "${local.name}-worker"
    migrate          = "${local.name}-migrate"
    db_bootstrap     = "${local.name}-db-bootstrap"
    destroy_due      = "${local.name}-destroy-due"
    patient_export   = local.export_task_family
    erase_person     = "${local.name}-erase-person"
    amend_contact    = "${local.name}-amend-contact"
    reapply_erasures = "${local.name}-reapply-erasures"
  }

  task_definition_arn_prefix = "arn:aws:ecs:${var.region}:${local.account_id}:task-definition"
  one_off_task_definitions = [
    "${local.task_definition_arn_prefix}/${local.task_families.migrate}:*",
    "${local.task_definition_arn_prefix}/${local.task_families.db_bootstrap}:*",
  ]
  service_arns = [
    "arn:aws:ecs:${var.region}:${local.account_id}:service/${local.name}/${local.name}-web",
    "arn:aws:ecs:${var.region}:${local.account_id}:service/${local.name}/${local.name}-worker",
  ]
  cluster_tasks_arn = "arn:aws:ecs:${var.region}:${local.account_id}:task/${local.name}/*"
}

data "aws_iam_policy_document" "github_deploy" {
  statement {
    sid       = "EcrAuthorizationToken"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]
  }

  # Push, plus the two reads a push and the workflow's "is this commit already
  # built?" check (batch-get-image) make.
  statement {
    sid = "PushOurImages"
    actions = [
      "ecr:BatchCheckLayerAvailability",
      "ecr:InitiateLayerUpload",
      "ecr:UploadLayerPart",
      "ecr:CompleteLayerUpload",
      "ecr:PutImage",
      "ecr:BatchGetImage",
      "ecr:GetDownloadUrlForLayer",
    ]
    resources = [for repo in aws_ecr_repository.this : repo.arn]
  }

  statement {
    sid       = "RegisterOurTaskDefinitions"
    actions   = ["ecs:RegisterTaskDefinition"]
    resources = [for family in values(local.task_families) : "${local.task_definition_arn_prefix}/${family}:*"]
  }

  # DescribeTaskDefinition supports no resource scoping.
  statement {
    sid       = "ReadTaskDefinitions"
    actions   = ["ecs:DescribeTaskDefinition"]
    resources = ["*"]
  }

  # The workflow reads each service's DesiredCount tag (describe-services
  # --include TAGS) to size the first deploy; ListTagsForResource is granted in
  # case AWS checks it for that read too. UpdateService also covers setting a
  # service back to 0 tasks after a failed first deploy.
  statement {
    sid       = "RollOurServices"
    actions   = ["ecs:UpdateService", "ecs:DescribeServices", "ecs:ListTagsForResource"]
    resources = local.service_arns
  }

  statement {
    sid       = "RunMigrateAndDbBootstrap"
    actions   = ["ecs:RunTask"]
    resources = local.one_off_task_definitions

    condition {
      test     = "ArnEquals"
      variable = "ecs:cluster"
      values   = [aws_ecs_cluster.main.arn]
    }
  }

  statement {
    sid       = "WatchTasksOnThisCluster"
    actions   = ["ecs:DescribeTasks"]
    resources = [local.cluster_tasks_arn]

    condition {
      test     = "ArnEquals"
      variable = "ecs:cluster"
      values   = [aws_ecs_cluster.main.arn]
    }
  }

  # Registering a revision or running a task with tags needs TagResource at
  # creation; this allows it only as part of those two calls.
  statement {
    sid     = "TagOnlyWhileCreating"
    actions = ["ecs:TagResource"]
    resources = concat(
      [for family in values(local.task_families) : "${local.task_definition_arn_prefix}/${family}:*"],
      [local.cluster_tasks_arn],
    )

    condition {
      test     = "StringEquals"
      variable = "ecs:CreateAction"
      values   = ["RegisterTaskDefinition", "RunTask"]
    }
  }

  statement {
    sid     = "PassOnlyTheTaskRoles"
    actions = ["iam:PassRole"]
    resources = [
      aws_iam_role.ecs_execution.arn,
      aws_iam_role.app_task.arn,
      aws_iam_role.db_admin_task.arn,
      aws_iam_role.export_task.arn,
    ]

    condition {
      test     = "StringEquals"
      variable = "iam:PassedToService"
      values   = ["ecs-tasks.amazonaws.com"]
    }
  }

  # ECS Exec would put an interactive root shell on a container holding PHI.
  # It is off on the services, and this makes sure the pipeline cannot turn it
  # on for a service or a one-off task. The key is a string in AWS's
  # reference, hence a string comparison rather than Bool.
  statement {
    sid       = "NeverEcsExec"
    effect    = "Deny"
    actions   = ["ecs:UpdateService", "ecs:RunTask"]
    resources = ["*"]

    condition {
      test     = "StringEqualsIgnoreCase"
      variable = "ecs:enable-execute-command"
      values   = ["true"]
    }
  }
}

resource "aws_iam_role_policy" "github_deploy" {
  name   = "deploy-app"
  role   = aws_iam_role.github_deploy.id
  policy = data.aws_iam_policy_document.github_deploy.json
}
