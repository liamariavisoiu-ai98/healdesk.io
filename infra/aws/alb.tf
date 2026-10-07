# The load balancer terminates TLS for both hostnames and forwards to the web
# tier. A request for any other host, the balancer's own DNS name included,
# gets a 404 and never reaches the app.
#
# The certificate is validated by DNS, and the DNS is Cloudflare's, so its
# records go in by hand. Until var.certificate_dns_ready is set, nothing waits
# on the certificate and there is no HTTPS listener: the first apply finishes
# and prints the records to add (README.md, steps 3 and 4).

resource "aws_acm_certificate" "app" {
  domain_name               = var.public_hostname
  subject_alternative_names = [var.internal_hostname]
  validation_method         = "DNS"

  lifecycle {
    create_before_destroy = true

    precondition {
      condition     = var.public_hostname != var.internal_hostname
      error_message = "HEALDESK_APP_URL and BETTER_AUTH_URL must be different origins (lib/email/lint.ts)."
    }
  }
}

resource "aws_acm_certificate_validation" "app" {
  count           = var.certificate_dns_ready ? 1 : 0
  certificate_arn = aws_acm_certificate.app.arn

  timeouts {
    create = "2h"
  }
}

resource "aws_lb" "app" {
  name                       = var.name
  load_balancer_type         = "application"
  internal                   = false
  subnets                    = aws_subnet.public[*].id
  security_groups            = [aws_security_group.alb.id]
  drop_invalid_header_fields = true
  enable_deletion_protection = true

  # Long enough for a streamed reply. The Retell voice endpoint, once it
  # exists, gets its own target group and may need this raised.
  idle_timeout = 120
}

resource "aws_lb_target_group" "web" {
  name                 = "${var.name}-web"
  port                 = 3001
  protocol             = "HTTP"
  target_type          = "ip"
  vpc_id               = aws_vpc.main.id
  deregistration_delay = 30

  # The liveness probe answers 200 whenever the process is up. The plain
  # /api/health answers 503 while a critical email is late, which is the
  # uptime alarm's business, not a reason to replace a task
  # (src/app/api/health/route.ts).
  health_check {
    path                = "/api/health?probe=liveness"
    matcher             = "200"
    interval            = 15
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }
}

resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.app.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type = "redirect"

    redirect {
      port        = "443"
      protocol    = "HTTPS"
      status_code = "HTTP_301"
    }
  }
}

resource "aws_lb_listener" "https" {
  count             = var.certificate_dns_ready ? 1 : 0
  load_balancer_arn = aws_lb.app.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = aws_acm_certificate_validation.app[0].certificate_arn

  default_action {
    type = "fixed-response"

    fixed_response {
      content_type = "text/plain"
      message_body = "Not found"
      status_code  = "404"
    }
  }
}

resource "aws_lb_listener_rule" "web" {
  count        = var.certificate_dns_ready ? 1 : 0
  listener_arn = aws_lb_listener.https[0].arn
  priority     = 10

  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.web.arn
  }

  condition {
    host_header {
      values = [var.public_hostname, var.internal_hostname]
    }
  }
}
