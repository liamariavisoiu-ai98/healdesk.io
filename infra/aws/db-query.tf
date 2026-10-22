# The role for .github/workflows/db-query.yml: run the db-query task and nothing
# else (docs/design/db-access-2026-10-22.md). A query is a file in the repo, run
# as healdesk_readonly, which can SELECT only the tables in
# apps/app/scripts/readonly-tables.ts; its output stays in the task's own log
# group and is never printed by the workflow (this repository is public).
#
# It is a role of its own, not the deploy role, because the deploy role's trust
# deliberately names no GitHub environment (iam.tf) and this workflow must: the
# environment's required reviewer is the approval, one click by the owner for
# each run. AWS still decides who may assume it, the same four ways as the
# deploy role: the audience, the subject (the same repository, but its
# db-query environment), the branch and the actor. The approval is therefore
# one more lock on top of those, never the only one; a setting on GitHub
# cannot widen what this role can do, only the policy below can.
#
# RunTask takes overrides that IAM cannot see, so anything this role may run it
# may run with another command. That is why the one family it may run is the
# one whose only secret is the read-only URL: the worst a changed command can
# do is read what that role can read. Never add the migrate or any other family
# here (the migrator's URL would make it arbitrary SQL as the table owner).

locals {
  db_query_oidc_subjects = [
    for subject in var.github_oidc_subjects : replace(subject, ":ref:refs/heads/main", ":environment:db-query")
  ]
  db_query_task_definitions = "${local.task_definition_arn_prefix}/${local.task_families.db_query}:*"
}

data "aws_iam_policy_document" "github_db_query_assume" {
  statement {
    sid     = "GitHubMainBranchDbQueryEnvironmentRunByTheOwnerOnly"
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
      values   = local.db_query_oidc_subjects
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

resource "aws_iam_role" "github_db_query" {
  name                 = "${local.name}-github-db-query"
  description          = "GitHub Actions db-query.yml on main, approved by the owner: run the read-only db-query task"
  assume_role_policy   = data.aws_iam_policy_document.github_db_query_assume.json
  max_session_duration = 3600
}

data "aws_iam_policy_document" "github_db_query" {
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
    sid       = "RunTheDbQueryTaskOnThisCluster"
    actions   = ["ecs:RunTask"]
    resources = [local.db_query_task_definitions]

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

resource "aws_iam_role_policy" "github_db_query" {
  name   = "run-db-query"
  role   = aws_iam_role.github_db_query.id
  policy = data.aws_iam_policy_document.github_db_query.json
}

output "github_db_query_role_arn" {
  description = "The role db-query.yml assumes. Not a secret."
  value       = aws_iam_role.github_db_query.arn
}
