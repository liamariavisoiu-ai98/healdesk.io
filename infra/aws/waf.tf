# One web ACL with one rule: a per-IP rate limit, the "rate-limited by the
# host" the health route and the docs rely on. Over the limit, AWS WAF answers
# 429 rather than its default 403, because apps/web's relay retries only 401,
# 429 and 5xx: any other 4xx from this host makes it acknowledge a Stripe event
# to Stripe and drop it, leaving a paid customer without an account.
#
# No AWS managed rule groups. The Core rule set blocks request bodies over
# 8 KB, and relayed Stripe events (up to 1 MB) and checkout intents (up to
# 256 kB) are larger than that.
#
# Sampled requests are off: a sample keeps full request headers, which here
# include session cookies and webhook bearer secrets.

resource "aws_wafv2_web_acl" "main" {
  count = var.enable_waf ? 1 : 0

  name        = local.name
  description = "Per-IP rate limit for ${var.app_domain}, answers 429"
  scope       = "REGIONAL"

  default_action {
    allow {}
  }

  custom_response_body {
    key          = "rate-limited"
    content_type = "TEXT_PLAIN"
    content      = "Too many requests. Please try again in a minute."
  }

  rule {
    name     = "rate-limit-per-ip"
    priority = 1

    action {
      block {
        custom_response {
          response_code            = 429
          custom_response_body_key = "rate-limited"

          response_header {
            name  = "Retry-After"
            value = "60"
          }
        }
      }
    }

    statement {
      rate_based_statement {
        limit                 = var.waf_rate_limit
        aggregate_key_type    = "IP"
        evaluation_window_sec = 300
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${local.name}-rate-limit-per-ip"
      sampled_requests_enabled   = false
    }
  }

  visibility_config {
    cloudwatch_metrics_enabled = true
    metric_name                = local.name
    sampled_requests_enabled   = false
  }

  #checkov:skip=CKV2_AWS_31:WAF logs would record full request headers (session cookies, webhook bearer secrets) and URIs; the ACL only rate-limits, and its CloudWatch metrics show what it blocks.
  #checkov:skip=CKV_AWS_192:The Log4j check wants the KnownBadInputs managed group; managed groups are excluded by design (the app is Node, and managed body rules would block relayed Stripe events).
}

resource "aws_wafv2_web_acl_association" "alb" {
  count = var.enable_waf ? 1 : 0

  resource_arn = aws_lb.main.arn
  web_acl_arn  = aws_wafv2_web_acl.main[0].arn
}
