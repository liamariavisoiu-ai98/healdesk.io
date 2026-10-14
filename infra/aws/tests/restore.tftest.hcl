# `terraform test` against the same mocked providers as stack.tftest.hcl (the
# blocks below are a copy of its first ones: a mock cannot be shared between
# test files without moving it to a mock directory), with one difference:
# this file applies, in a state of its own, so a later plan can be read
# against it. Keep the two copies of the mocks in step.

mock_provider "aws" {
  override_during = apply

  override_data {
    target = data.aws_caller_identity.current
    values = {
      account_id = "865780386982"
    }
  }

  override_resource {
    target = aws_kms_key.main
    values = {
      arn    = "arn:aws:kms:us-east-1:865780386982:key/11111111-2222-3333-4444-555555555555"
      key_id = "11111111-2222-3333-4444-555555555555"
    }
  }

  override_resource {
    target = aws_acm_certificate.app
    values = {
      arn = "arn:aws:acm:us-east-1:865780386982:certificate/66666666-7777-8888-9999-000000000000"
      domain_validation_options = [
        {
          domain_name           = "app.healdesk.io"
          resource_record_name  = "_a1.app.healdesk.io."
          resource_record_type  = "CNAME"
          resource_record_value = "_a2.acm-validations.aws."
        },
        {
          domain_name           = "app-internal.healdesk.io"
          resource_record_name  = "_b1.app-internal.healdesk.io."
          resource_record_type  = "CNAME"
          resource_record_value = "_b2.acm-validations.aws."
        },
      ]
    }
  }

  # The NAT instance's interface and the tasks' security group, so the route
  # tables and the instance's ingress rule can be checked against them.
  override_resource {
    target = aws_instance.nat
    values = {
      primary_network_interface_id = "eni-0bbbbbbbbbbbbbbbb"
    }
  }

  override_resource {
    target = aws_security_group.tasks
    values = {
      id = "sg-0aaaaaaaaaaaaaaaa"
    }
  }

  override_resource {
    target = aws_db_instance.main
    values = {
      address     = "healdesk-production.abcdefghijkl.us-east-1.rds.amazonaws.com"
      resource_id = "db-ABCDEFGHIJKLMNOPQRSTUVWXY1"
      master_user_secret = [
        {
          kms_key_id    = "arn:aws:kms:us-east-1:865780386982:key/11111111-2222-3333-4444-555555555555"
          secret_arn    = "arn:aws:secretsmanager:us-east-1:865780386982:secret:rds!db-0000-AbCdEf"
          secret_status = "active"
        },
      ]
    }
  }

  override_resource {
    target = aws_sesv2_email_identity.main
    values = {
      arn = "arn:aws:ses:us-east-1:865780386982:identity/healdesk.io"
      # A nested block is overridden as one object, not a list of them.
      dkim_signing_attributes = {
        current_signing_key_length    = "RSA_2048_BIT"
        last_key_generation_timestamp = "2026-10-08T00:00:00Z"
        signing_attributes_origin     = "AWS_SES"
        status                        = "PENDING"
        tokens                        = ["tokenone", "tokentwo", "tokenthree"]
      }
    }
  }

  # The provider still validates planned values (ARNs, policy JSON), so the
  # generated strings are replaced by well-formed ones per type.
  mock_resource "aws_lb" {
    defaults = {
      arn        = "arn:aws:elasticloadbalancing:us-east-1:865780386982:loadbalancer/app/healdesk-production/0123456789abcdef"
      arn_suffix = "app/healdesk-production/0123456789abcdef"
      dns_name   = "healdesk-production-1234567890.us-east-1.elb.amazonaws.com"
    }
  }

  mock_resource "aws_lb_target_group" {
    defaults = {
      arn        = "arn:aws:elasticloadbalancing:us-east-1:865780386982:targetgroup/healdesk-production-web-https/0123456789abcdef"
      arn_suffix = "targetgroup/healdesk-production-web-https/0123456789abcdef"
    }
  }

  mock_resource "aws_lb_listener" {
    defaults = {
      arn = "arn:aws:elasticloadbalancing:us-east-1:865780386982:listener/app/healdesk-production/0123456789abcdef/0123456789abcdef"
    }
  }

  mock_resource "aws_iam_role" {
    defaults = {
      arn = "arn:aws:iam::865780386982:role/healdesk-production-mock"
    }
  }

  mock_resource "aws_sns_topic" {
    defaults = {
      arn = "arn:aws:sns:us-east-1:865780386982:healdesk-production-alarms"
    }
  }

  mock_resource "aws_ecs_cluster" {
    defaults = {
      arn = "arn:aws:ecs:us-east-1:865780386982:cluster/healdesk-production"
      id  = "arn:aws:ecs:us-east-1:865780386982:cluster/healdesk-production"
    }
  }

  mock_resource "aws_ecs_task_definition" {
    defaults = {
      arn = "arn:aws:ecs:us-east-1:865780386982:task-definition/healdesk-production-mock:1"
    }
  }

  mock_resource "aws_ssm_parameter" {
    defaults = {
      arn = "arn:aws:ssm:us-east-1:865780386982:parameter/healdesk/production/mock"
    }
  }

  mock_resource "aws_cloudwatch_log_group" {
    defaults = {
      arn = "arn:aws:logs:us-east-1:865780386982:log-group:/healdesk/production/mock"
    }
  }

  mock_resource "aws_ecr_repository" {
    defaults = {
      arn            = "arn:aws:ecr:us-east-1:865780386982:repository/healdesk/mock"
      repository_url = "865780386982.dkr.ecr.us-east-1.amazonaws.com/healdesk/mock"
    }
  }

  mock_resource "aws_s3_bucket" {
    defaults = {
      arn = "arn:aws:s3:::healdesk-production-mock-865780386982"
    }
  }

  # NAT gateways' ids, so the gateway-mode run can see the routes use them.
  mock_resource "aws_nat_gateway" {
    defaults = {
      id = "nat-0cccccccccccccccc"
    }
  }

  mock_resource "aws_wafv2_web_acl" {
    defaults = {
      arn = "arn:aws:wafv2:us-east-1:865780386982:regional/webacl/healdesk-production/00000000-0000-0000-0000-000000000000"
    }
  }

  mock_resource "aws_sesv2_configuration_set" {
    defaults = {
      arn = "arn:aws:ses:us-east-1:865780386982:configuration-set/healdesk-production-phi"
    }
  }

  mock_data "aws_iam_policy_document" {
    defaults = {
      json = "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Action\":\"sts:AssumeRole\",\"Principal\":{\"Service\":\"ecs-tasks.amazonaws.com\"}}]}"
    }
  }
}

mock_provider "cloudflare" {
  override_during = apply
}

# The four personal values infra.yml passes as TF_VAR_*, here as test values.
variables {
  cloudflare_zone_id   = "0123456789abcdef0123456789abcdef"
  alarm_email          = "alarms@example.com"
  healdesk_admin_email = "operator@example.com"
}

# The database the host came back with is the one every later apply keeps.
# host.yml names a standby snapshot only when the instance does not exist,
# and every apply after that leaves restore_snapshot_identifier empty; but
# snapshot_identifier forces a new instance when it changes, so an apply that
# named another snapshot by mistake (a re-run, a hand-typed -var) would
# replace the database with an older copy. rds.tf ignores the argument once
# the instance exists. Proving that needs a state, so this file applies
# (against the same mocks, in its own state) and then plans.

run "back_from_standby_applied" {
  command = apply

  # The instance and what it depends on (the network, the key, its groups):
  # the rest of the module needs plan-time mocks (the certificate's validation
  # records are keyed by values the provider computes), and they cannot be
  # applied.
  plan_options {
    target = [aws_db_instance.main]
  }

  variables {
    restore_snapshot_identifier = "healdesk-production-standby-20261014120000"
  }

  assert {
    condition     = aws_db_instance.main[0].snapshot_identifier == "healdesk-production-standby-20261014120000"
    error_message = "The instance is made from the standby snapshot host.yml names."
  }
}

run "a_later_apply_naming_another_snapshot_keeps_the_database" {
  command = plan

  plan_options {
    target = [aws_db_instance.main]
  }

  variables {
    restore_snapshot_identifier = "healdesk-production-standby-20261020090000"
  }

  # The planned value is the state's: without ignore_changes it would be the
  # new name, which the provider plans as a replacement.
  assert {
    condition     = aws_db_instance.main[0].snapshot_identifier == "healdesk-production-standby-20261014120000"
    error_message = "Once the instance exists, a different restore_snapshot_identifier changes nothing: no new database replaces it."
  }
}

run "a_later_apply_naming_none_keeps_the_database" {
  command = plan

  plan_options {
    target = [aws_db_instance.main]
  }

  assert {
    condition     = aws_db_instance.main[0].snapshot_identifier == "healdesk-production-standby-20261014120000"
    error_message = "The apply after the restore, which names no snapshot, leaves the restored instance as it is."
  }
}
