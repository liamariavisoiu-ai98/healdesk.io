# ---------------------------------------------------------------------------
# ECS roles. The execution role is used by the ECS agent before a container
# starts (pull the image, open the log stream, fetch the secrets); its
# credentials never reach application code. The task roles are what the code
# itself can do: the app may use the credential vault's key, the db-admin task
# may do nothing at all, and the migrate task has no task role.
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

  statement {
    sid       = "ReadOurParameters"
    actions   = ["ssm:GetParameters"]
    resources = ["arn:aws:ssm:${var.region}:${local.account_id}:parameter${local.param_prefix}/*"]
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

# The app's task role: exactly the three calls the credential vault makes
# (lib/crypto/kms.ts), on this key only. The app passes no encryption context,
# and every AWS service that uses the same key always passes one, so the Null
# condition keeps this role from decrypting anything RDS, SSM, CloudWatch Logs
# or CloudTrail encrypted under it.
resource "aws_iam_role" "app_task" {
  name               = "${local.name}-app-task"
  description        = "Web and worker code: the credential vault's KMS calls only"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

data "aws_iam_policy_document" "app_task" {
  statement {
    sid       = "CredentialVault"
    actions   = ["kms:GenerateDataKey", "kms:Decrypt", "kms:Encrypt"]
    resources = [aws_kms_key.main.arn]

    condition {
      test     = "Null"
      variable = "kms:EncryptionContextKeys"
      values   = ["true"]
    }
  }
}

resource "aws_iam_role_policy" "app_task" {
  name   = "credential-vault"
  role   = aws_iam_role.app_task.id
  policy = data.aws_iam_policy_document.app_task.json
}

# The db-bootstrap task's role holds no permissions: psql talks only to the
# database, and its credentials arrive through the execution role's secrets.
# A role of its own, rather than none, keeps the task from ever being given
# the app's by mistake.
resource "aws_iam_role" "db_admin_task" {
  name               = "${local.name}-db-admin-task"
  description        = "db-bootstrap task: no AWS permissions"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

# ---------------------------------------------------------------------------
# The deploy role for .github/workflows/deploy-app.yml, assumed over GitHub
# OIDC (the provider is created by the bootstrap stack). Trusted for one
# environment: a job in the production environment of this repository, in
# either capitalisation GitHub may put in the token. It can push
# the three images, register and read task definitions, update the two
# services, run the two one-off tasks on this cluster and watch them, and pass
# exactly the roles those tasks use. Nothing else: no secrets, no KMS, no RDS,
# no IAM beyond PassRole, and never ECS Exec.
# ---------------------------------------------------------------------------

data "aws_iam_policy_document" "github_deploy_assume" {
  statement {
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
  }

  #checkov:skip=CKV_AWS_358:False positive. The subject is GitHub's immutable form (repo:owner@id/repo@id:environment:production), compared exactly; checkov's owner/repo pattern predates that form and cannot parse the "@id" parts.
}

resource "aws_iam_role" "github_deploy" {
  name                 = "${local.name}-github-deploy"
  description          = "GitHub Actions deploy-app.yml: push images, register task definitions, roll the services"
  assume_role_policy   = data.aws_iam_policy_document.github_deploy_assume.json
  max_session_duration = 3600
}

locals {
  task_families = {
    web          = "${local.name}-web"
    worker       = "${local.name}-worker"
    migrate      = "${local.name}-migrate"
    db_bootstrap = "${local.name}-db-bootstrap"
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
  # case AWS checks it for that read too.
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
