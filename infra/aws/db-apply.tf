# The role for .github/workflows/db-apply.yml: run the db-apply task and nothing
# else (docs/design/db-access-2026-10-22.md, "The write path"). Built like
# db-query.tf, and for the same reasons; read that file's header first.
#
# Two GitHub environments may assume it, db-apply (a dry run, which always rolls
# back) and db-apply-commit (apply, which commits only the row count the dry run
# showed). The workflow picks the environment from its mode input, and the owner
# may put a required reviewer on db-apply-commit in GitHub, but AWS does not
# depend on that: the token must come from this repository, from one of those two
# environments, on main, run by the owner, and the role can start the db-apply
# family only. RunTask overrides are invisible to IAM, so that family is the one
# whose only secret is the writer URL: the worst a changed command can do is what
# healdesk_writer can do, which is INSERT and UPDATE on three tables for the one
# clinic it names. Never add another family here.

locals {
  db_apply_environments = ["db-apply", "db-apply-commit"]
  db_apply_oidc_subjects = flatten([
    for subject in var.github_oidc_subjects : [
      for environment in local.db_apply_environments : replace(subject, ":ref:refs/heads/main", ":environment:${environment}")
    ]
  ])
  db_apply_task_definitions = "${local.task_definition_arn_prefix}/${local.task_families.db_apply}:*"
}

data "aws_iam_policy_document" "github_db_apply_assume" {
  statement {
    sid     = "GitHubMainBranchDbApplyEnvironmentsRunByTheOwnerOnly"
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
      values   = local.db_apply_oidc_subjects
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

  #checkov:skip=CKV_AWS_358:False positive, as for the deploy role (iam.tf): the subject is GitHub's immutable form with "@id" parts, compared exactly, and the ref and the actor are pinned as well.
}

resource "aws_iam_role" "github_db_apply" {
  name                 = "${local.name}-github-db-apply"
  description          = "GitHub Actions db-apply.yml on main: run the db-apply task, a dry run or an apply of one reviewed change"
  assume_role_policy   = data.aws_iam_policy_document.github_db_apply_assume.json
  max_session_duration = 3600
}

data "aws_iam_policy_document" "github_db_apply" {
  # run-task.sh lends the web service's private network to the task.
  statement {
    sid       = "ReadTheWebServiceForItsNetwork"
    actions   = ["ecs:DescribeServices"]
    resources = ["arn:aws:ecs:${var.region}:${local.account_id}:service/${local.name}/${local.name}-web"]
  }

  # Neither takes a resource scope.
  statement {
    sid       = "FindTheNewestRevision"
    actions   = ["ecs:DescribeTaskDefinition", "ecs:ListTaskDefinitions"]
    resources = ["*"]
  }

  statement {
    sid       = "RunTheDbApplyTaskOnThisCluster"
    actions   = ["ecs:RunTask"]
    resources = [local.db_apply_task_definitions]

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

  statement {
    sid       = "PassOnlyTheExecutionRole"
    actions   = ["iam:PassRole"]
    resources = [aws_iam_role.ecs_execution.arn]

    condition {
      test     = "StringEquals"
      variable = "iam:PassedToService"
      values   = ["ecs-tasks.amazonaws.com"]
    }
  }

  # The workflow prints the run's one summary line (counts and ids, never a row)
  # into its own job log, so the owner and Claude see every change without an AWS
  # login. That needs this one log group, read through CloudWatch Logs only.
  statement {
    sid       = "ReadTheDbApplyLogOnly"
    actions   = ["logs:GetLogEvents", "logs:DescribeLogStreams"]
    resources = ["arn:aws:logs:${var.region}:${local.account_id}:log-group:${aws_cloudwatch_log_group.app["db-apply"].name}:*"]
  }

  statement {
    sid       = "DecryptThatLogGroupThroughCloudWatchLogsOnly"
    actions   = ["kms:Decrypt"]
    resources = [aws_kms_key.main.arn]

    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["logs.${var.region}.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "kms:EncryptionContext:aws:logs:arn"
      values   = ["arn:aws:logs:${var.region}:${local.account_id}:log-group:${aws_cloudwatch_log_group.app["db-apply"].name}"]
    }
  }

  statement {
    sid       = "NeverEcsExec"
    effect    = "Deny"
    actions   = ["ecs:RunTask"]
    resources = ["*"]

    condition {
      test     = "StringEqualsIgnoreCase"
      variable = "ecs:enable-execute-command"
      values   = ["true"]
    }
  }
}

resource "aws_iam_role_policy" "github_db_apply" {
  name   = "run-db-apply"
  role   = aws_iam_role.github_db_apply.id
  policy = data.aws_iam_policy_document.github_db_apply.json
}

output "github_db_apply_role_arn" {
  description = "The role db-apply.yml assumes. Not a secret."
  value       = aws_iam_role.github_db_apply.arn
}
