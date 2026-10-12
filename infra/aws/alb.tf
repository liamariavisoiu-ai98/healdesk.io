# The front door of both origins. It has to be internet-facing: browsers,
# Stripe, Meta and apps/web on Vercel (which has no fixed egress addresses)
# all call it, so nothing can be allowlisted. The signed routes authenticate
# with HMAC and the webhooks with their vendors' signatures; the host split
# below keeps each origin to its own job on top of that.
#
# No access logs: the log bucket for an ALB cannot use a KMS key (only S3's
# own keys), and URLs carry no PHI (one-time tokens are opaque path segments).
# Recorded as a deliberate choice in the build report.

resource "aws_security_group" "alb" {
  name        = "${local.name}-alb"
  description = "Load balancer: HTTPS and HTTP (redirect only) from anywhere, to the web tasks only"
  vpc_id      = aws_vpc.main.id

  tags = {
    Name = "${local.name}-alb"
  }
}

resource "aws_vpc_security_group_ingress_rule" "alb_https" {
  security_group_id = aws_security_group.alb.id
  description       = "HTTPS from the internet"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_vpc_security_group_ingress_rule" "alb_http" {
  security_group_id = aws_security_group.alb.id
  description       = "HTTP from the internet, answered only with a redirect to HTTPS"
  ip_protocol       = "tcp"
  from_port         = 80
  to_port           = 80
  cidr_ipv4         = "0.0.0.0/0"

  #checkov:skip=CKV_AWS_260:Port 80 exists only to 301 to HTTPS (the listener has no other action); browsers that type the bare host need it, and HSTS keeps them on HTTPS afterwards.
}

resource "aws_vpc_security_group_egress_rule" "alb_to_web" {
  security_group_id            = aws_security_group.alb.id
  description                  = "To the web tasks' target port, for traffic and health checks"
  ip_protocol                  = "tcp"
  from_port                    = local.web_target_port
  to_port                      = local.web_target_port
  referenced_security_group_id = aws_security_group.tasks.id
}

resource "aws_lb" "main" {
  name               = local.name
  internal           = false
  load_balancer_type = "application"
  ip_address_type    = "ipv4"
  security_groups    = [aws_security_group.alb.id]
  subnets            = aws_subnet.public[*].id

  # Requests whose header names are not valid HTTP are dropped rather than
  # passed to the app.
  drop_invalid_header_fields = true
  enable_deletion_protection = true
  idle_timeout               = var.alb_idle_timeout

  # Append the client's address to X-Forwarded-For (the default, explicit
  # because the app reads the entry the load balancer appended, not the first,
  # which the browser controls).
  xff_header_processing_mode = "append"

  # The web ACL only rate-limits. If WAF itself is impaired, keep serving
  # rather than turn away patients and webhooks.
  enable_waf_fail_open = true

  #checkov:skip=CKV_AWS_91:Access logs need an S3 bucket that cannot use our KMS key (ALB delivery supports SSE-S3 only); URLs are kept free of PHI and the decision is recorded.
  #checkov:skip=CKV2_AWS_76:The web ACL deliberately has no AWS managed rule groups (waf.tf): the app is Node, not Java, and managed body rules would block relayed Stripe events. It rate-limits only.
}

# Targets are task IPs (Fargate). With alb_to_task_tls the load balancer
# speaks HTTPS to the tls-proxy sidecar on 8443; the ALB does not validate a
# target's certificate, so the sidecar's self-signed one is enough to encrypt
# the hop. The protocol is in the name so that flipping the variable creates
# the new group before the old one is destroyed.
resource "aws_lb_target_group" "web" {
  name             = "${local.name}-web-${lower(local.web_target_protocol)}"
  vpc_id           = aws_vpc.main.id
  target_type      = "ip"
  protocol         = local.web_target_protocol
  protocol_version = "HTTP1"
  port             = local.web_target_port

  # ECS waits this long for in-flight requests to finish before stopping a
  # replaced task. Stripe and Meta calls finish well within it.
  deregistration_delay = 60

  # Liveness only: the plain /api/health reads the database and answers 503
  # while a critical email is late, and routing on that would pull every task
  # out of service at once (src/app/api/health/route.ts).
  health_check {
    enabled             = true
    protocol            = local.web_target_protocol
    port                = "traffic-port"
    path                = "/api/health?probe=liveness"
    matcher             = "200"
    interval            = 15
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.main.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type = "redirect"

    redirect {
      protocol    = "HTTPS"
      port        = "443"
      status_code = "HTTP_301"
    }
  }
}

# TLS 1.3 and 1.2 only, with post-quantum key exchange: the policy AWS now
# recommends. A listener created through the API otherwise defaults to
# ELBSecurityPolicy-2016-08, which still allows TLS 1.0. The certificate (both
# names, dns.tf) is taken from the validation resource, so the listener waits
# until ACM has issued it.
#
# Anything the rules below do not claim gets a 404 from the load balancer
# itself and never reaches the app: an unknown Host, the balancer's own DNS
# name, a bare IP.
resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.main.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-Res-PQ-2025-09"
  certificate_arn   = aws_acm_certificate_validation.app.certificate_arn

  default_action {
    type = "fixed-response"

    fixed_response {
      content_type = "text/plain"
      message_body = "Not found"
      status_code  = "404"
    }
  }
}

# One host, two jobs, decided here by Host header and path (locals.tf lists the
# signed paths and where each is called from):
#
#   internal host  the signed routes only, forwarded; anything else 404. It is
#                  HEALDESK_APP_URL, which must never reach a browser, so a
#                  request for any other path there is a mistake or a probe.
#   public host    everything except the signed routes, which get a 404, so
#                  apps/web's server-to-server endpoints are not exposed on the
#                  origin every browser and webhook uses.
#
# A signed path on the internal host is always forwarded and never refused
# here: apps/web's relay retries only 401, 429 and 5xx and drops any other
# 4xx, so a 404 from this balancer would make it acknowledge a Stripe event and
# lose it. The WAF's limit answers 429 for the same reason (waf.tf).
#
# A rule takes at most three paths, so each list is split into rules of
# three, in order. Rules match the path after the balancer normalises the URI,
# and are case-sensitive, as Next's routes are.
locals {
  signed_path_groups = chunklist(local.signed_paths, 3)

  not_found = {
    content_type = "text/plain"
    message_body = "Not found"
    status_code  = "404"
  }
}

resource "aws_lb_listener_rule" "internal_signed" {
  count = length(local.signed_path_groups)

  listener_arn = aws_lb_listener.https.arn
  priority     = 100 + count.index

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.web.arn
  }

  condition {
    host_header {
      values = [var.internal_hostname]
    }
  }

  condition {
    path_pattern {
      values = local.signed_path_groups[count.index]
    }
  }
}

resource "aws_lb_listener_rule" "internal_nothing_else" {
  listener_arn = aws_lb_listener.https.arn
  priority     = 200

  action {
    type = "fixed-response"

    fixed_response {
      content_type = local.not_found.content_type
      message_body = local.not_found.message_body
      status_code  = local.not_found.status_code
    }
  }

  condition {
    host_header {
      values = [var.internal_hostname]
    }
  }
}

resource "aws_lb_listener_rule" "public_refuses_signed" {
  count = length(local.signed_path_groups)

  listener_arn = aws_lb_listener.https.arn
  priority     = 300 + count.index

  action {
    type = "fixed-response"

    fixed_response {
      content_type = local.not_found.content_type
      message_body = local.not_found.message_body
      status_code  = local.not_found.status_code
    }
  }

  condition {
    host_header {
      values = [var.app_domain]
    }
  }

  condition {
    path_pattern {
      values = local.signed_path_groups[count.index]
    }
  }
}

resource "aws_lb_listener_rule" "public" {
  listener_arn = aws_lb_listener.https.arn
  priority     = 400

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.web.arn
  }

  condition {
    host_header {
      values = [var.app_domain]
    }
  }
}
