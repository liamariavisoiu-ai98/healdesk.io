# `terraform test` against a mocked AWS provider: no credentials, no calls to
# AWS. It evaluates the whole stack, every count, index and output included,
# for each phase of README.md's first deploy, and holds the rules a later
# edit could break without validate noticing.
#
#   terraform -chdir=infra/aws init -backend=false && terraform -chdir=infra/aws test

mock_provider "aws" {
  mock_data "aws_availability_zones" {
    defaults = {
      names = ["us-east-1a", "us-east-1b", "us-east-1c"]
    }
  }

  mock_data "aws_caller_identity" {
    defaults = {
      account_id = "865780386982"
    }
  }

  mock_data "aws_iam_policy_document" {
    defaults = {
      json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}"
    }
  }

  mock_resource "aws_kms_key" {
    defaults = {
      arn    = "arn:aws:kms:us-east-1:865780386982:key/00000000-0000-0000-0000-000000000000"
      key_id = "00000000-0000-0000-0000-000000000000"
    }
  }

  mock_resource "aws_secretsmanager_secret" {
    defaults = {
      arn = "arn:aws:secretsmanager:us-east-1:865780386982:secret:healdesk-apps-app/mock-AbCdEf"
    }
  }

  mock_resource "aws_db_instance" {
    defaults = {
      address = "healdesk-apps-app.mock.us-east-1.rds.amazonaws.com"
      port    = 5432
      master_user_secret = [{
        secret_arn    = "arn:aws:secretsmanager:us-east-1:865780386982:secret:rds!db-mock-AbCdEf"
        kms_key_id    = "00000000-0000-0000-0000-000000000000"
        secret_status = "active"
      }]
    }
  }

  mock_resource "aws_sesv2_email_identity" {
    defaults = {
      arn = "arn:aws:ses:us-east-1:865780386982:identity/healdesk.io"
    }
  }

  mock_resource "aws_ecr_repository" {
    defaults = {
      repository_url = "865780386982.dkr.ecr.us-east-1.amazonaws.com/healdesk/apps-app"
    }
  }

  mock_resource "aws_cloudwatch_log_group" {
    defaults = {
      arn = "arn:aws:logs:us-east-1:865780386982:log-group:/healdesk/apps-app/mock"
    }
  }

  # The schema checks ARNs; the mock's random strings are not ARNs.
  mock_resource "aws_iam_role" {
    defaults = {
      arn = "arn:aws:iam::865780386982:role/mock"
    }
  }

  mock_resource "aws_iam_service_linked_role" {
    defaults = {
      arn = "arn:aws:iam::865780386982:role/aws-service-role/config.amazonaws.com/AWSServiceRoleForConfig"
    }
  }

  mock_resource "aws_s3_bucket" {
    defaults = {
      arn = "arn:aws:s3:::healdesk-apps-app-mock"
    }
  }

  mock_resource "aws_sesv2_configuration_set" {
    defaults = {
      arn = "arn:aws:ses:us-east-1:865780386982:configuration-set/healdesk-phi"
    }
  }

  mock_resource "aws_acm_certificate" {
    defaults = {
      arn = "arn:aws:acm:us-east-1:865780386982:certificate/mock"
    }
  }

  mock_resource "aws_acm_certificate_validation" {
    defaults = {
      certificate_arn = "arn:aws:acm:us-east-1:865780386982:certificate/mock"
    }
  }

  mock_resource "aws_lb" {
    defaults = {
      arn      = "arn:aws:elasticloadbalancing:us-east-1:865780386982:loadbalancer/app/healdesk-apps-app/mock"
      dns_name = "healdesk-apps-app-mock.us-east-1.elb.amazonaws.com"
    }
  }

  mock_resource "aws_lb_target_group" {
    defaults = {
      arn = "arn:aws:elasticloadbalancing:us-east-1:865780386982:targetgroup/healdesk-apps-app-web/mock"
    }
  }

  mock_resource "aws_lb_listener" {
    defaults = {
      arn = "arn:aws:elasticloadbalancing:us-east-1:865780386982:listener/app/healdesk-apps-app/mock/mock"
    }
  }

  mock_resource "aws_ecs_cluster" {
    defaults = {
      arn = "arn:aws:ecs:us-east-1:865780386982:cluster/healdesk-apps-app"
      id  = "arn:aws:ecs:us-east-1:865780386982:cluster/healdesk-apps-app"
    }
  }

  mock_resource "aws_ecs_task_definition" {
    defaults = {
      arn = "arn:aws:ecs:us-east-1:865780386982:task-definition/mock:1"
    }
  }
}

# Its own ARN, so a test can tell the migrator's secret from the runtime one.
override_resource {
  target = aws_secretsmanager_secret.admin
  values = {
    arn = "arn:aws:secretsmanager:us-east-1:865780386982:secret:healdesk-apps-app/admin-XyZabc"
  }
}

run "first_apply_waits_for_nothing" {
  assert {
    condition     = length(aws_acm_certificate_validation.app) == 0 && length(aws_lb_listener.https) == 0
    error_message = "Before certificate_dns_ready, nothing may wait on the certificate."
  }

  assert {
    condition     = length(aws_ecs_service.web) == 0
    error_message = "The web service needs the HTTPS listener's target group first."
  }

  assert {
    condition     = aws_ecs_service.worker.desired_count == 0
    error_message = "Nothing runs until the image, secrets and database exist."
  }

  # The mock cannot fill nested blocks, so this proves the outputs evaluate
  # on a first apply, not what AWS will put in them.
  assert {
    condition     = can(length(output.certificate_validation_records)) && can(length(output.ses_dkim_records))
    error_message = "The first apply must be able to print the DNS records to add."
  }
}

run "the_database_keeps_35_days_and_stays_private" {
  assert {
    condition     = aws_db_instance.main.backup_retention_period == 35
    error_message = "The launch plan requires 35 days of backups."
  }

  assert {
    condition = (
      aws_db_instance.main.storage_encrypted
      && !aws_db_instance.main.publicly_accessible
      && aws_db_instance.main.deletion_protection
      && aws_db_instance.main.manage_master_user_password
    )
    error_message = "The database must be encrypted, private, protected and keep its master password out of Terraform."
  }

  assert {
    condition     = one([for p in aws_db_parameter_group.main.parameter : p.value if p.name == "rds.force_ssl"]) == "1"
    error_message = "TLS to Postgres is forced."
  }
}

run "the_app_gets_its_origins_and_key_and_no_switches" {
  variables {
    app_environment = {
      HEALDESK_ADMIN_EMAIL  = "ops@example.com"
      HEALDESK_KMS_PROVIDER = "local"
    }
  }

  assert {
    condition = alltrue([
      for e in jsondecode(aws_ecs_task_definition.worker.container_definitions)[0].environment :
      e.value == "aws-kms" if e.name == "HEALDESK_KMS_PROVIDER"
    ])
    error_message = "The stack's KMS provider wins over app_environment."
  }

  assert {
    condition = length([
      for e in jsondecode(aws_ecs_task_definition.worker.container_definitions)[0].environment :
      e if contains(["HEALDESK_DIRECT_BOOKING_ENABLED", "HEALDESK_PHASE_TWO_ATTRIBUTION"], e.name)
    ]) == 0
    error_message = "The booking and phase-two switches are never set here."
  }

  assert {
    condition = (
      local.app_environment["BETTER_AUTH_URL"] == "https://app.healdesk.io"
      && local.app_environment["HEALDESK_APP_URL"] == "https://app-internal.healdesk.io"
      && local.app_environment["HEALDESK_KMS_KEY_ID"] == aws_kms_key.main.arn
    )
    error_message = "Public and internal origins differ, and the key is its full ARN."
  }

  assert {
    condition = (
      length([for s in jsondecode(aws_ecs_task_definition.web.container_definitions)[0].secrets : s if startswith(s.valueFrom, aws_secretsmanager_secret.admin.arn)]) == 0
      && length(jsondecode(aws_ecs_task_definition.web.container_definitions)[0].secrets) == length(local.runtime_secret_keys)
    )
    error_message = "The web tier reads every runtime key and nothing of the migrator's."
  }
}

run "after_the_certificate_records_exist" {
  variables {
    certificate_dns_ready = true
    image_tag             = "0123456789ab"
    web_desired_count     = 1
    worker_desired_count  = 1
  }

  assert {
    condition     = length(aws_lb_listener.https) == 1 && aws_ecs_service.web[0].desired_count == 1
    error_message = "With the certificate ready, HTTPS and the web tier come up."
  }

  assert {
    condition     = jsondecode(aws_ecs_task_definition.web.container_definitions)[0].image == "865780386982.dkr.ecr.us-east-1.amazonaws.com/healdesk/apps-app:0123456789ab"
    error_message = "Tasks run the pushed tag."
  }
}

run "refuses_one_origin_for_both" {
  command = plan

  variables {
    internal_hostname = "app.healdesk.io"
  }

  expect_failures = [aws_acm_certificate.app]
}

run "refuses_the_booking_switch" {
  command = plan

  variables {
    app_environment = { HEALDESK_DIRECT_BOOKING_ENABLED = "true" }
  }

  expect_failures = [var.app_environment]
}

run "refuses_backups_shorter_than_35_days" {
  command = plan

  variables {
    db_backup_retention_days = 7
  }

  expect_failures = [var.db_backup_retention_days]
}
