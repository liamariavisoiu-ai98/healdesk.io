# The NAT instance (nat_mode = "instance", the lean default): one t4g.nano in
# the first public subnet that forwards the private subnets' HTTPS to the
# internet and nothing else. About $7 a month with its address, against about
# $37 for a NAT gateway, for the same job at this product's traffic.
#
# What crosses it is the app's own TLS, so it carries patient data only as
# ciphertext it cannot open, exactly as a NAT gateway does. It differs from
# the gateway in being an instance we look after:
#
#   - nothing reaches it but 443 from the tasks' security group; it has no
#     key pair, no instance role (so no SSM agent can be used on it) and
#     IMDSv2 only, and its own firewall (templates/nat-instance.sh.tftpl)
#     forwards only new connections to port 443 from the VPC;
#   - security updates install daily (dnf-automatic); a new kernel, or a new
#     Amazon Linux image, arrives when the instance is replaced, which the
#     quarterly review does by bumping nat_instance_generation (README, "The
#     NAT instance");
#   - EC2's automatic recovery restarts it on new hardware, with the same
#     addresses, if its host fails, and the status alarm emails the owner;
#   - like a single NAT gateway, it lives in one AZ: losing that AZ cuts
#     egress until it is replaced (nat_mode = "gateway" with nat_gateways = 2
#     is the answer to that, at about ten times the price).
#
# It launches with its own public address rather than an Elastic IP, so its
# first boot can fetch its two packages before anything else is attached.
# The address costs the same as an Elastic IP and changes only if the
# instance is stopped and started, which nothing here relies on.

data "aws_ssm_parameter" "nat_ami" {
  count = var.nat_mode == "instance" ? 1 : 0

  # Amazon's own pointer to the newest minimal AL2023 image for arm64. Read at
  # plan time; the instance ignores later changes of it (see lifecycle below),
  # so a new image never replaces the instance behind the owner's back.
  name = "/aws/service/ami-amazon-linux-latest/al2023-ami-minimal-kernel-default-arm64"
}

resource "aws_security_group" "nat" {
  count = var.nat_mode == "instance" ? 1 : 0

  name        = "${local.name}-nat"
  description = "NAT instance: HTTPS in from the ECS tasks only; HTTPS out"
  vpc_id      = aws_vpc.main.id

  tags = {
    Name = "${local.name}-nat"
  }
}

resource "aws_vpc_security_group_ingress_rule" "nat_from_tasks" {
  count = var.nat_mode == "instance" ? 1 : 0

  security_group_id            = aws_security_group.nat[0].id
  description                  = "HTTPS from the ECS tasks, to be forwarded"
  ip_protocol                  = "tcp"
  from_port                    = 443
  to_port                      = 443
  referenced_security_group_id = aws_security_group.tasks.id
}

resource "aws_vpc_security_group_egress_rule" "nat_https" {
  count = var.nat_mode == "instance" ? 1 : 0

  security_group_id = aws_security_group.nat[0].id
  description       = "HTTPS out: the forwarded connections and the instance's own package updates"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_instance" "nat" {
  count = var.nat_mode == "instance" ? 1 : 0

  ami                         = nonsensitive(data.aws_ssm_parameter.nat_ami[0].value)
  instance_type               = var.nat_instance_type
  subnet_id                   = aws_subnet.public[0].id
  vpc_security_group_ids      = [aws_security_group.nat[0].id]
  associate_public_ip_address = true

  # A NAT forwards packets addressed to other hosts, which EC2 drops unless
  # this check is off.
  source_dest_check = false

  # A change to the script, or to nat_instance_generation, replaces the
  # instance (and so picks up the newest image): that is how it is patched.
  user_data = templatefile("${path.module}/templates/nat-instance.sh.tftpl", {
    vpc_cidr   = var.vpc_cidr
    generation = var.nat_instance_generation
  })
  user_data_replace_on_change = true

  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
  }

  # Standard credits: a long burst is slowed to the baseline rather than
  # billed as surplus credits.
  credit_specification {
    cpu_credits = "standard"
  }

  maintenance_options {
    auto_recovery = "default"
  }

  # The disk holds the operating system and nothing of ours, so AWS's default
  # EBS key is enough; it is still encrypted.
  root_block_device {
    encrypted             = true
    volume_type           = "gp3"
    delete_on_termination = true
  }

  tags = {
    Name = "${local.name}-nat"
  }

  lifecycle {
    ignore_changes = [ami]
  }

  #checkov:skip=CKV_AWS_126:Detailed monitoring costs more than the instance; the status-check alarm (alarms.tf) reads the basic one-minute status metric.
  #checkov:skip=CKV2_AWS_41:No instance role on purpose: the instance calls no AWS API, and a role would let an agent on it be reached.
  #checkov:skip=CKV_AWS_88:A NAT needs a public address; it accepts no connection on it (security group and nftables).
  #checkov:skip=CKV_AWS_189:The root volume holds the operating system and no data of ours; it is encrypted with AWS's default EBS key.
}

# EC2 publishes the status checks once a minute without detailed monitoring.
# A failed system check starts automatic recovery on its own; this tells the
# owner, because egress is down until it finishes.
resource "aws_cloudwatch_metric_alarm" "nat_instance_status" {
  count = var.nat_mode == "instance" ? 1 : 0

  alarm_name          = "${local.name}-nat-instance-status"
  alarm_description   = "The NAT instance failed its EC2 status checks for three minutes: the tasks cannot reach Stripe, Google, Anthropic or AWS's APIs until it recovers."
  namespace           = "AWS/EC2"
  metric_name         = "StatusCheckFailed"
  dimensions          = { InstanceId = aws_instance.nat[0].id }
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 3
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "breaching"
  alarm_actions       = local.alarm_actions
  ok_actions          = local.alarm_actions
}
