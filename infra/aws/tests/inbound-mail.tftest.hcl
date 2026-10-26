# Inbound support mail on SES (ses-inbound.tf; ops automation lane P7g),
# against mocked providers like stack.tftest.hcl, whose mocks are copied here
# (a mock provider belongs to its file). Every run is a plan:
#
#   - off (production.tfvars' value) creates none of it and changes no task's
#     environment, no policy and no DNS record;
#   - on, it creates exactly the resources named, with the bucket refusing
#     anything without TLS, a one-day lifecycle, SES's write scoped to the one
#     rule, the task role's rights scoped to the mail/ prefix, the key grant
#     scoped to the rule, the MX on the subdomain only, and the topic's
#     subscription only as a second step;
#   - with a rule set that is already active named, nothing is activated.

mock_provider "aws" {
  override_during = plan

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

  mock_resource "aws_ses_receipt_rule_set" {
    defaults = {
      arn = "arn:aws:ses:us-east-1:865780386982:receipt-rule-set/healdesk-production-inbound"
    }
  }

  mock_resource "aws_ses_receipt_rule" {
    defaults = {
      arn = "arn:aws:ses:us-east-1:865780386982:receipt-rule-set/healdesk-production-inbound:receipt-rule/healdesk-production-support-mail"
    }
  }

  mock_resource "aws_ses_active_receipt_rule_set" {
    defaults = {
      arn = "arn:aws:ses:us-east-1:865780386982:receipt-rule-set/healdesk-production-inbound"
    }
  }

  override_resource {
    target = aws_sns_topic.inbound_mail
    values = {
      arn = "arn:aws:sns:us-east-1:865780386982:healdesk-production-inbound-mail"
    }
  }

  mock_data "aws_iam_policy_document" {
    defaults = {
      json = "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Action\":\"sts:AssumeRole\",\"Principal\":{\"Service\":\"ecs-tasks.amazonaws.com\"}}]}"
    }
  }
}

mock_provider "cloudflare" {
  override_during = plan
}


variables {
  cloudflare_zone_id   = "0123456789abcdef0123456789abcdef"
  alarm_email          = "alarms@example.com"
  healdesk_admin_email = "operator@example.com"
}

run "inbound_mail_off" {
  command = plan

  variables {
    enable_inbound_mail = false
  }

  assert {
    condition = (
      length(aws_s3_bucket.inbound_mail) == 0 && length(aws_sns_topic.inbound_mail) == 0 &&
      length(aws_sns_topic_subscription.inbound_mail_app) == 0 && length(aws_ses_receipt_rule.support_mail) == 0 &&
      length(aws_ses_receipt_rule_set.inbound) == 0 && length(aws_ses_active_receipt_rule_set.inbound) == 0 &&
      length(cloudflare_dns_record.inbound_mx) == 0 && length(aws_s3_bucket_policy.inbound_mail) == 0 &&
      length(aws_s3_bucket_lifecycle_configuration.inbound_mail) == 0
    )
    error_message = "With enable_inbound_mail off, none of the inbound mail resources may exist."
  }

  assert {
    condition = alltrue([
      for st in data.aws_iam_policy_document.app_task.statement : !contains(["InboundMailObjects", "InboundMailList", "S3UsesTheKeyForInboundMail"], st.sid)
    ]) && alltrue([for st in data.aws_iam_policy_document.kms.statement : st.sid != "SesEncryptsInboundSupportMail"])
    error_message = "Off, neither the task role nor the key policy may name the inbound bucket."
  }

  assert {
    condition = alltrue([
      for c in jsondecode(aws_ecs_task_definition.web.container_definitions) : alltrue([
        for e in c.environment : !startswith(e.name, "HEALDESK_INBOUND_MAIL_")
      ])
      ]) && alltrue([
      for e in jsondecode(aws_ecs_task_definition.worker.container_definitions)[0].environment : !startswith(e.name, "HEALDESK_INBOUND_MAIL_")
    ])
    error_message = "Off, no task carries HEALDESK_INBOUND_MAIL_BUCKET or HEALDESK_INBOUND_MAIL_TOPIC_ARN."
  }

  assert {
    condition     = toset(flatten([for d in aws_cloudtrail.main.event_selector[0].data_resource : d.values])) == toset(["arn:aws:s3:::healdesk-production-exports-865780386982/"])
    error_message = "Off, CloudTrail's data events are unchanged."
  }

  assert {
    condition     = output.inbound_mail == null
    error_message = "Off, the inbound_mail output is null."
  }
}

run "inbound_mail_on" {
  command = plan

  variables {
    enable_inbound_mail = true
  }

  # --- exactly these resources, once each; no subscription before the second step ---
  assert {
    condition = (
      length(aws_s3_bucket.inbound_mail) == 1 && length(aws_s3_bucket_ownership_controls.inbound_mail) == 1 &&
      length(aws_s3_bucket_public_access_block.inbound_mail) == 1 && length(aws_s3_bucket_server_side_encryption_configuration.inbound_mail) == 1 &&
      length(aws_s3_bucket_lifecycle_configuration.inbound_mail) == 1 && length(aws_s3_bucket_policy.inbound_mail) == 1 &&
      length(aws_sns_topic.inbound_mail) == 1 && length(aws_sns_topic_policy.inbound_mail) == 1 &&
      length(aws_ses_receipt_rule_set.inbound) == 1 && length(aws_ses_active_receipt_rule_set.inbound) == 1 &&
      length(aws_ses_receipt_rule.support_mail) == 1 && length(cloudflare_dns_record.inbound_mx) == 1 &&
      length(aws_sns_topic_subscription.inbound_mail_app) == 0
    )
    error_message = "On, the inbound resources exist once each, and the subscription waits for subscribe_inbound_mail."
  }

  # --- DNS: one MX, on the subdomain, DNS only; the root domain gets nothing ---
  assert {
    condition = (
      cloudflare_dns_record.inbound_mx[0].name == "in.healdesk.io" && cloudflare_dns_record.inbound_mx[0].type == "MX" &&
      cloudflare_dns_record.inbound_mx[0].content == "inbound-smtp.us-east-1.amazonaws.com" &&
      cloudflare_dns_record.inbound_mx[0].priority == 10 && !cloudflare_dns_record.inbound_mx[0].proxied &&
      length(cloudflare_dns_record.inbound_mx[0].comment) <= 100
    )
    error_message = "The MX must be in.healdesk.io -> inbound-smtp.us-east-1.amazonaws.com, priority 10, DNS only, with a comment Cloudflare accepts."
  }

  # --- the rule: hello@ on the subdomain only, TLS required, scanned, S3 then the topic ---
  assert {
    condition = (
      aws_ses_receipt_rule.support_mail[0].recipients == toset(["hello@in.healdesk.io"]) &&
      aws_ses_receipt_rule.support_mail[0].tls_policy == "Require" && aws_ses_receipt_rule.support_mail[0].scan_enabled &&
      aws_ses_receipt_rule.support_mail[0].enabled &&
      length(aws_ses_receipt_rule.support_mail[0].s3_action) == 1 &&
      one(aws_ses_receipt_rule.support_mail[0].s3_action).bucket_name == "healdesk-production-inbound-mail-865780386982" &&
      one(aws_ses_receipt_rule.support_mail[0].s3_action).object_key_prefix == "mail/" &&
      one(aws_ses_receipt_rule.support_mail[0].s3_action).topic_arn == "arn:aws:sns:us-east-1:865780386982:healdesk-production-inbound-mail" &&
      try(one(aws_ses_receipt_rule.support_mail[0].s3_action).kms_key_arn, null) == null &&
      length(aws_ses_receipt_rule.support_mail[0].sns_action) == 0 && length(aws_ses_receipt_rule.support_mail[0].lambda_action) == 0 &&
      aws_ses_active_receipt_rule_set.inbound[0].rule_set_name == "healdesk-production-inbound"
    )
    error_message = "The receipt rule takes hello@in.healdesk.io only, requires TLS, scans, and writes to the bucket's mail/ prefix with the topic told; no SNS action carrying the message."
  }

  # --- the bucket: our key, no public access, TLS only, a day at most ---
  assert {
    condition = (
      one(aws_s3_bucket_server_side_encryption_configuration.inbound_mail[0].rule).apply_server_side_encryption_by_default[0].sse_algorithm == "aws:kms" &&
      one(aws_s3_bucket_server_side_encryption_configuration.inbound_mail[0].rule).apply_server_side_encryption_by_default[0].kms_master_key_id == "arn:aws:kms:us-east-1:865780386982:key/11111111-2222-3333-4444-555555555555" &&
      one(aws_s3_bucket_server_side_encryption_configuration.inbound_mail[0].rule).bucket_key_enabled &&
      aws_s3_bucket_public_access_block.inbound_mail[0].block_public_acls && aws_s3_bucket_public_access_block.inbound_mail[0].block_public_policy &&
      aws_s3_bucket_public_access_block.inbound_mail[0].ignore_public_acls && aws_s3_bucket_public_access_block.inbound_mail[0].restrict_public_buckets
    )
    error_message = "The inbound bucket is SSE-KMS under the project's key with Bucket Keys, and blocks every kind of public access."
  }

  assert {
    condition = (
      length(aws_s3_bucket_lifecycle_configuration.inbound_mail[0].rule) == 1 &&
      one(aws_s3_bucket_lifecycle_configuration.inbound_mail[0].rule).status == "Enabled" &&
      one(one(aws_s3_bucket_lifecycle_configuration.inbound_mail[0].rule).expiration).days == 1 &&
      one(one(aws_s3_bucket_lifecycle_configuration.inbound_mail[0].rule).abort_incomplete_multipart_upload).days_after_initiation == 1
    )
    error_message = "The inbound bucket's lifecycle expires every object after one day."
  }

  assert {
    condition = (
      one([for st in data.aws_iam_policy_document.inbound_mail_bucket[0].statement : st if st.sid == "DenyAnythingWithoutTls"]).effect == "Deny" &&
      toset(one([for st in data.aws_iam_policy_document.inbound_mail_bucket[0].statement : st if st.sid == "DenyAnythingWithoutTls"]).actions) == toset(["s3:*"]) &&
      one(one([for st in data.aws_iam_policy_document.inbound_mail_bucket[0].statement : st if st.sid == "DenyAnythingWithoutTls"]).condition).variable == "aws:SecureTransport" &&
      one(one([for st in data.aws_iam_policy_document.inbound_mail_bucket[0].statement : st if st.sid == "DenyAnythingWithoutTls"]).condition).values == tolist(["false"])
    )
    error_message = "The inbound bucket denies every request made without TLS."
  }

  assert {
    condition = (
      toset(one([for st in data.aws_iam_policy_document.inbound_mail_bucket[0].statement : st if st.sid == "SesWritesThisRulesMail"]).actions) == toset(["s3:PutObject"]) &&
      one([for st in data.aws_iam_policy_document.inbound_mail_bucket[0].statement : st if st.sid == "SesWritesThisRulesMail"]).resources == toset(["arn:aws:s3:::healdesk-production-inbound-mail-865780386982/mail/*"]) &&
      toset(flatten([for c in one([for st in data.aws_iam_policy_document.inbound_mail_bucket[0].statement : st if st.sid == "SesWritesThisRulesMail"]).condition : c.values if c.variable == "aws:SourceArn"])) == toset(["arn:aws:ses:us-east-1:865780386982:receipt-rule-set/healdesk-production-inbound:receipt-rule/healdesk-production-support-mail"]) &&
      toset(flatten([for c in one([for st in data.aws_iam_policy_document.inbound_mail_bucket[0].statement : st if st.sid == "SesWritesThisRulesMail"]).condition : c.values if c.variable == "aws:SourceAccount"])) == toset(["865780386982"])
    )
    error_message = "SES may write to the inbound bucket only under mail/, for this account's one receipt rule."
  }

  # --- the topic: encrypted under our key; SES publishes for this rule only ---
  assert {
    condition = (
      aws_sns_topic.inbound_mail[0].kms_master_key_id == "arn:aws:kms:us-east-1:865780386982:key/11111111-2222-3333-4444-555555555555" &&
      aws_sns_topic.inbound_mail[0].signature_version == 2 &&
      toset(flatten([for c in one(data.aws_iam_policy_document.inbound_mail_topic[0].statement).condition : c.values if c.variable == "aws:SourceArn"])) == toset(["arn:aws:ses:us-east-1:865780386982:receipt-rule-set/healdesk-production-inbound:receipt-rule/healdesk-production-support-mail"])
    )
    error_message = "The inbound topic is encrypted under the project's key, signs with version 2, and takes SES's notices for the one rule only."
  }

  # --- the key: SES may use it for this rule and nothing else ---
  assert {
    condition = (
      toset(one([for st in data.aws_iam_policy_document.kms.statement : st if st.sid == "SesEncryptsInboundSupportMail"]).actions) == toset(["kms:GenerateDataKey*", "kms:Decrypt"]) &&
      toset(flatten([for p in one([for st in data.aws_iam_policy_document.kms.statement : st if st.sid == "SesEncryptsInboundSupportMail"]).principals : p.identifiers])) == toset(["ses.amazonaws.com"]) &&
      toset(flatten([for c in one([for st in data.aws_iam_policy_document.kms.statement : st if st.sid == "SesEncryptsInboundSupportMail"]).condition : c.values if c.variable == "aws:SourceArn"])) == toset(["arn:aws:ses:us-east-1:865780386982:receipt-rule-set/healdesk-production-inbound:receipt-rule/healdesk-production-support-mail"])
    )
    error_message = "The key policy lets SES generate data keys and decrypt for the one receipt rule only."
  }

  # --- the task role: read, list and delete under mail/ only, never write ---
  assert {
    condition = (
      toset(one([for st in data.aws_iam_policy_document.app_task.statement : st if st.sid == "InboundMailObjects"]).actions) == toset(["s3:GetObject", "s3:DeleteObject"]) &&
      one([for st in data.aws_iam_policy_document.app_task.statement : st if st.sid == "InboundMailObjects"]).resources == toset(["arn:aws:s3:::healdesk-production-inbound-mail-865780386982/mail/*"]) &&
      toset(one([for st in data.aws_iam_policy_document.app_task.statement : st if st.sid == "InboundMailList"]).actions) == toset(["s3:ListBucket"]) &&
      one([for st in data.aws_iam_policy_document.app_task.statement : st if st.sid == "InboundMailList"]).resources == toset(["arn:aws:s3:::healdesk-production-inbound-mail-865780386982"]) &&
      toset(flatten([for c in one([for st in data.aws_iam_policy_document.app_task.statement : st if st.sid == "InboundMailList"]).condition : c.values if c.variable == "s3:prefix"])) == toset(["mail/", "mail/*"]) &&
      toset(one([for st in data.aws_iam_policy_document.app_task.statement : st if st.sid == "S3UsesTheKeyForInboundMail"]).actions) == toset(["kms:Decrypt"]) &&
      toset(flatten([for c in one([for st in data.aws_iam_policy_document.app_task.statement : st if st.sid == "S3UsesTheKeyForInboundMail"]).condition : c.values if c.variable == "kms:ViaService"])) == toset(["s3.us-east-1.amazonaws.com"]) &&
      toset(flatten([for c in one([for st in data.aws_iam_policy_document.app_task.statement : st if st.sid == "S3UsesTheKeyForInboundMail"]).condition : c.values if c.variable == "kms:EncryptionContext:aws:s3:arn"])) == toset(["arn:aws:s3:::healdesk-production-inbound-mail-865780386982"]) &&
      alltrue([for st in data.aws_iam_policy_document.app_task.statement : !contains(st.actions, "s3:PutObject") || !anytrue([for r in st.resources : strcontains(r, "inbound-mail")])])
    )
    error_message = "The task role may get, delete and list (under mail/) the inbound bucket's objects and decrypt them through S3 only, and never write there."
  }

  # --- the environment: bucket on web and worker, topic on web only; voice untouched ---
  assert {
    condition = (
      { for e in one([for c in jsondecode(aws_ecs_task_definition.web.container_definitions) : c if c.name == "app"]).environment : e.name => e.value if startswith(e.name, "HEALDESK_INBOUND_MAIL_") } == {
        HEALDESK_INBOUND_MAIL_BUCKET    = "healdesk-production-inbound-mail-865780386982"
        HEALDESK_INBOUND_MAIL_TOPIC_ARN = "arn:aws:sns:us-east-1:865780386982:healdesk-production-inbound-mail"
      } &&
      { for e in jsondecode(aws_ecs_task_definition.worker.container_definitions)[0].environment : e.name => e.value if startswith(e.name, "HEALDESK_INBOUND_MAIL_") } == {
        HEALDESK_INBOUND_MAIL_BUCKET = "healdesk-production-inbound-mail-865780386982"
      }
    )
    error_message = "The web app gets the inbound bucket and topic, the worker the bucket only."
  }

  assert {
    condition     = toset(flatten([for d in aws_cloudtrail.main.event_selector[0].data_resource : d.values])) == toset(["arn:aws:s3:::healdesk-production-exports-865780386982/", "arn:aws:s3:::healdesk-production-inbound-mail-865780386982/"])
    error_message = "Every object read and delete in the inbound bucket is a CloudTrail data event."
  }

  assert {
    condition     = output.inbound_mail.forward_to == "hello@in.healdesk.io" && output.inbound_mail.rule_set == "healdesk-production-inbound"
    error_message = "The output names the forwarding address and the rule set."
  }
}

run "inbound_mail_subscribed" {
  command = plan

  variables {
    enable_inbound_mail    = true
    subscribe_inbound_mail = true
  }

  assert {
    condition = (
      length(aws_sns_topic_subscription.inbound_mail_app) == 1 &&
      aws_sns_topic_subscription.inbound_mail_app[0].protocol == "https" &&
      aws_sns_topic_subscription.inbound_mail_app[0].endpoint == "https://app.healdesk.io/api/webhooks/inbound-mail" &&
      !aws_sns_topic_subscription.inbound_mail_app[0].raw_message_delivery
    )
    error_message = "The second step subscribes the app's public /api/webhooks/inbound-mail over HTTPS."
  }

  # SNS refuses a delivery policy whose retries add up to more than an hour
  # (the first apply, 14 October 2026): 12 tries at most 600 s apart.
  assert {
    condition = (
      jsondecode(aws_sns_topic_subscription.inbound_mail_app[0].delivery_policy).healthyRetryPolicy.numRetries <= 12 &&
      jsondecode(aws_sns_topic_subscription.inbound_mail_app[0].delivery_policy).healthyRetryPolicy.maxDelayTarget <= 600 &&
      jsondecode(aws_sns_topic_subscription.inbound_mail_app[0].delivery_policy).healthyRetryPolicy.numRetries * jsondecode(aws_sns_topic_subscription.inbound_mail_app[0].delivery_policy).healthyRetryPolicy.maxDelayTarget <= 3600 * 2
    )
    error_message = "The inbound subscription's retry policy must stay inside SNS's one-hour limit."
  }
}

run "inbound_mail_subscription_waits_out_standby" {
  command = plan

  variables {
    enable_inbound_mail    = true
    subscribe_inbound_mail = true
    standby                = true
    deletion_protection    = false
  }

  assert {
    condition     = length(aws_sns_topic_subscription.inbound_mail_app) == 0 && length(aws_s3_bucket.inbound_mail) == 1
    error_message = "Standby removes the subscription with the host it posts to; the bucket, the topic and the rule stay."
  }
}

run "inbound_mail_into_an_existing_active_rule_set" {
  command = plan

  variables {
    enable_inbound_mail        = true
    inbound_mail_rule_set_name = "someone-elses-active-set"
  }

  assert {
    condition = (
      length(aws_ses_receipt_rule_set.inbound) == 0 && length(aws_ses_active_receipt_rule_set.inbound) == 0 &&
      aws_ses_receipt_rule.support_mail[0].rule_set_name == "someone-elses-active-set"
    )
    error_message = "With an existing set named, the rule goes into it and nothing is created or activated."
  }
}

run "inbound_mail_refuses_the_root_domain" {
  command = plan

  variables {
    enable_inbound_mail = true
    inbound_mail_domain = "healdesk.io"
  }

  expect_failures = [var.inbound_mail_domain]
}

run "inbound_mail_needs_ses" {
  command = plan

  variables {
    enable_inbound_mail = true
    enable_ses          = false
  }

  expect_failures = [aws_ses_receipt_rule.support_mail]
}
