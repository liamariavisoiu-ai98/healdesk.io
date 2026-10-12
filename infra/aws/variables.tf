# ---------------------------------------------------------------------------
# Where and what
# ---------------------------------------------------------------------------

variable "environment" {
  description = "Environment name, used in every resource name (healdesk-<environment>-...) and parameter path (/healdesk/<environment>/...). A staging copy is a second state with environment = \"staging\"."
  type        = string
  default     = "production"

  validation {
    # The longest name built from it, the target group's
    # healdesk-<environment>-web-https, must fit AWS's 32 characters.
    condition     = can(regex("^[a-z][a-z0-9]{1,11}$", var.environment))
    error_message = "environment must be 2-12 lowercase letters or digits, starting with a letter (the target group name allows no more)."
  }
}

variable "region" {
  description = "AWS region. Pinned: the BAA record designates us-east-1, the app refuses a KMS key in any other region, and the clinic agreement promises US infrastructure."
  type        = string
  default     = "us-east-1"

  validation {
    condition     = var.region == "us-east-1"
    error_message = "region must be us-east-1, the region designated in docs/policies/aws-hipaa-account.md."
  }
}

variable "app_domain" {
  description = "Public host of the product: browsers, Stripe, Meta and Google reach it. It becomes BETTER_AUTH_URL, which is effectively permanent: it is the passkey relying-party id, the origin of every mailed link and the registered Stripe Connect, Meta and Google redirect host. It never serves the signed apps/web routes (alb.tf)."
  type        = string
  default     = "app.healdesk.io"

  validation {
    # The /welcome hand-off reads a cookie apps/web sets on the parent domain,
    # so the product host must sit under healdesk.io.
    condition     = can(regex("^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\\.healdesk\\.io$", var.app_domain))
    error_message = "app_domain must be a lowercase subdomain of healdesk.io (the welcome cookie is set on the shared parent domain)."
  }
}

variable "internal_hostname" {
  description = "The origin apps/web calls with signed server-to-server requests: HEALDESK_APP_URL, on Vercel and on apps/app's own tasks. It must differ from app_domain, because apps/app refuses to mail any link to HEALDESK_APP_URL (lib/email/lint.ts), and it answers only the signed routes (alb.tf). Same certificate, same load balancer, DNS-only CNAME."
  type        = string
  default     = "app-internal.healdesk.io"

  validation {
    condition     = can(regex("^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\\.healdesk\\.io$", var.internal_hostname)) && var.internal_hostname != var.app_domain
    error_message = "internal_hostname must be a lowercase subdomain of healdesk.io other than app_domain: apps/app refuses every email link to HEALDESK_APP_URL, so one origin for both would refuse every portal email."
  }
}

variable "cloudflare_zone_id" {
  description = "Zone id of healdesk.io in Cloudflare (dashboard, healdesk.io, Overview, API: 32 hex characters). Not a secret, but kept out of git with the other account-specific values: infra.yml passes it as TF_VAR_cloudflare_zone_id from a GitHub repository variable."
  type        = string

  validation {
    condition     = can(regex("^[0-9a-f]{32}$", var.cloudflare_zone_id))
    error_message = "cloudflare_zone_id must be the 32-character hex zone id of healdesk.io, passed as TF_VAR_cloudflare_zone_id."
  }
}

# ---------------------------------------------------------------------------
# Network
# ---------------------------------------------------------------------------

variable "vpc_cidr" {
  description = "CIDR of the VPC. Public and private /24s for the two availability zones are carved out of it."
  type        = string
  default     = "10.40.0.0/16"

  validation {
    condition     = can(cidrnetmask(var.vpc_cidr)) && tonumber(split("/", var.vpc_cidr)[1]) <= 20
    error_message = "vpc_cidr must be an IPv4 CIDR of /20 or larger."
  }
}

variable "nat_gateways" {
  description = "NAT gateways for the private subnets' internet egress (Stripe, Meta, Anthropic, Resend, Google). 1 is the lean default; 2 puts one in each AZ so losing an AZ does not cut egress."
  type        = number
  default     = 1

  validation {
    condition     = contains([1, 2], var.nat_gateways)
    error_message = "nat_gateways must be 1 or 2."
  }
}

variable "vpc_endpoints" {
  description = "Create VPC endpoints (S3 gateway; ECR, CloudWatch Logs, SSM, Secrets Manager and KMS interface endpoints) so AWS API traffic stays off the NAT gateway. Off in the lean default: about $73 a month for the interface endpoints in two AZs. NAT is still needed for the vendor APIs."
  type        = bool
  default     = false
}

variable "enable_flow_logs" {
  description = "Send VPC flow logs to a KMS-encrypted, never-expiring CloudWatch log group. Off by default for cost; flow logs carry addresses and ports, never payloads."
  type        = bool
  default     = false
}

# ---------------------------------------------------------------------------
# Load balancer, WAF and tasks
# ---------------------------------------------------------------------------

variable "alb_to_task_tls" {
  description = "Encrypt the load balancer to task hop. The clinic agreement (BAA 1.2.1 and 1.3.0) promises encryption wherever healdesk controls both ends, which includes this hop, and 1.3.0 makes it a release gate: leave it on. True runs the tls-proxy sidecar and an HTTPS:8443 target group; false is a plain HTTP:3001 target group and no sidecar."
  type        = bool
  default     = true
}

variable "alb_idle_timeout" {
  description = "Load balancer idle timeout in seconds. The web tier's KEEP_ALIVE_TIMEOUT is derived from it (5 seconds longer), because a server that closes an idle connection before the load balancer does causes intermittent 502s."
  type        = number
  default     = 120

  validation {
    condition     = var.alb_idle_timeout >= 1 && var.alb_idle_timeout <= 4000
    error_message = "alb_idle_timeout must be between 1 and 4000 seconds."
  }
}

variable "enable_waf" {
  description = "Attach a WAF web ACL to the load balancer with one per-IP rate-based rule and nothing else. It is the host-side rate limit the health route and the docs rely on."
  type        = bool
  default     = true
}

variable "waf_rate_limit" {
  description = "Requests per source IP per 5 minutes before the WAF answers 429. Server-to-server callers (apps/web on Vercel, Stripe, Meta) share source IPs, so keep this well above their combined bursts."
  type        = number
  default     = 2000

  validation {
    condition     = var.waf_rate_limit >= 10 && var.waf_rate_limit <= 2000000000
    error_message = "waf_rate_limit must be between 10 and 2,000,000,000."
  }
}

variable "container_insights" {
  description = "Turn on ECS Container Insights for the cluster (extra CloudWatch cost). Its log group is pre-created with our KMS key and no expiry, so AWS never creates one without them."
  type        = bool
  default     = false
}

variable "web_desired" {
  description = "Intended number of web tasks. Terraform creates the service at 0 and the deploy workflow sets the real count after the first good migration, so nothing crash-loops before an image exists; this value is the alarm's floor for healthy web tasks. More than one multiplies the in-memory rate limits (runtime map, 8.4)."
  type        = number
  default     = 1

  validation {
    condition     = var.web_desired >= 1 && var.web_desired <= 10
    error_message = "web_desired must be between 1 and 10."
  }
}

variable "worker_desired" {
  description = "Intended number of worker tasks, for documentation and the workflow's first scale-up. One worker owns the clock; more are safe but unnecessary."
  type        = number
  default     = 1

  validation {
    condition     = var.worker_desired >= 1 && var.worker_desired <= 3
    error_message = "worker_desired must be between 1 and 3."
  }
}

variable "enable_voice" {
  description = "Reserved for the Retell voice endpoint, a long-lived WebSocket process that is not built yet. Must stay false; see the placeholder at the end of ecs.tf for what it will need."
  type        = bool
  default     = false

  validation {
    condition     = var.enable_voice == false
    error_message = "The voice endpoint is not built. Leave enable_voice false and read the placeholder in ecs.tf."
  }
}

# ---------------------------------------------------------------------------
# Database
# ---------------------------------------------------------------------------

variable "postgres_version" {
  description = "RDS for PostgreSQL engine version. Major 17 matches CI and local development. With automatic minor upgrades on, AWS moves the instance past this minor in a maintenance window; Terraform then shows an attempted downgrade until this is raised to the running minor (engine_version_actual), or set to \"17\" to follow AWS's minors without drift."
  type        = string
  default     = "17.11"

  validation {
    condition     = can(regex("^17(\\.[0-9]+)?$", var.postgres_version))
    error_message = "postgres_version must be 17 or 17.<minor>. Moving to another major means moving CI and local development first."
  }
}

variable "db_instance_class" {
  description = "RDS instance class. db.t4g.small (2 vCPU, 2 GiB) fits the pilot's connection budget of about 14 per process with room for the engine."
  type        = string
  default     = "db.t4g.small"

  validation {
    condition     = startswith(var.db_instance_class, "db.")
    error_message = "db_instance_class must be an RDS class such as db.t4g.small."
  }
}

variable "db_allocated_storage" {
  description = "RDS gp3 storage in GiB. The free-storage alarm fires below 10% of this."
  type        = number
  default     = 20

  validation {
    condition     = var.db_allocated_storage >= 20 && var.db_allocated_storage <= 65536
    error_message = "db_allocated_storage must be between 20 and 65536 GiB."
  }
}

variable "db_multi_az" {
  description = "Run a Multi-AZ standby. Off in the lean default: a database outage degrades to the clinic's direct line rather than stranding callers, and Multi-AZ roughly doubles the instance cost."
  type        = bool
  default     = false
}

variable "db_backup_window" {
  description = "Daily automated backup window, UTC (04:00-04:30 US Eastern in summer)."
  type        = string
  default     = "08:00-08:30"
}

variable "db_maintenance_window" {
  description = "Weekly maintenance window, UTC, after the backup window (Sunday 04:45-05:45 US Eastern in summer)."
  type        = string
  default     = "sun:08:45-sun:09:45"
}

# ---------------------------------------------------------------------------
# Application configuration (plain environment, never secrets)
# ---------------------------------------------------------------------------

variable "healdesk_email_from" {
  description = "HEALDESK_EMAIL_FROM for product mail (Annex X2 of the funnel plan)."
  type        = string
  default     = "healdesk <hello@healdesk.io>"

  validation {
    condition     = can(regex("^[ -~]+@[ -~]+$", var.healdesk_email_from))
    error_message = "healdesk_email_from must be printable ASCII containing an address, e.g. \"healdesk <hello@healdesk.io>\"."
  }
}

variable "healdesk_admin_email" {
  description = "HEALDESK_ADMIN_EMAIL: the one /admin operator, named as the actor on every ops audit row. Must equal the value on Vercel, and nothing checks that they match. A personal address, so it is kept out of git: infra.yml passes it as TF_VAR_healdesk_admin_email from a GitHub repository variable."
  type        = string

  validation {
    condition     = can(regex("^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$", var.healdesk_admin_email))
    error_message = "healdesk_admin_email must be an email address, identical to HEALDESK_ADMIN_EMAIL on Vercel, passed as TF_VAR_healdesk_admin_email."
  }
}

variable "healdesk_ops_email" {
  description = "HEALDESK_OPS_EMAIL for ops alerts and digests. Empty leaves it unset, and the app falls back to healdesk_admin_email. Never a clinic address. Kept out of git like the admin address: TF_VAR_healdesk_ops_email."
  type        = string
  default     = ""

  validation {
    condition     = var.healdesk_ops_email == "" || can(regex("^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$", var.healdesk_ops_email))
    error_message = "healdesk_ops_email must be empty or an email address."
  }
}

variable "meta_app_id" {
  description = "META_APP_ID (public). Empty leaves it unset: the Meta connect pages say the channel is not available."
  type        = string
  default     = ""

  validation {
    condition     = can(regex("^[0-9]*$", var.meta_app_id))
    error_message = "meta_app_id must be empty or digits."
  }
}

variable "meta_login_config_id" {
  description = "META_LOGIN_CONFIG_ID (public, Facebook Login for Business configuration for Messenger and Instagram). Empty leaves it unset."
  type        = string
  default     = ""

  validation {
    condition     = can(regex("^[0-9]*$", var.meta_login_config_id))
    error_message = "meta_login_config_id must be empty or digits."
  }
}

variable "meta_whatsapp_config_id" {
  description = "META_WHATSAPP_CONFIG_ID (public, WhatsApp Embedded Signup configuration). Empty leaves it unset."
  type        = string
  default     = ""

  validation {
    condition     = can(regex("^[0-9]*$", var.meta_whatsapp_config_id))
    error_message = "meta_whatsapp_config_id must be empty or digits."
  }
}

variable "stripe_connect_client_id" {
  description = "STRIPE_CONNECT_CLIENT_ID (public, ca_...), for the same Stripe mode as STRIPE_SECRET_KEY. Empty leaves it unset and hides Connect. Set on the worker too: offboarding revokes Connect access with it."
  type        = string
  default     = ""

  validation {
    condition     = var.stripe_connect_client_id == "" || can(regex("^ca_[A-Za-z0-9]+$", var.stripe_connect_client_id))
    error_message = "stripe_connect_client_id must be empty or a Stripe Connect client id (ca_...)."
  }
}

variable "app_environment" {
  description = "Other plain, public settings for the web and worker tasks, such as HEALDESK_SUPPORT_PHONE and HEALDESK_CALL_BOOKING_URL (lib/setup/help.ts). Never a secret (task definitions are readable, and CloudTrail records every registration), never a name this stack sets from its own variables, and never HEALDESK_DIRECT_BOOKING_ENABLED or HEALDESK_PHASE_TWO_ATTRIBUTION: those wait for counsel and the owner, not for this stack."
  type        = map(string)
  default     = {}

  validation {
    condition = length(setintersection(keys(var.app_environment), [
      "HEALDESK_DIRECT_BOOKING_ENABLED",
      "HEALDESK_PHASE_TWO_ATTRIBUTION",
    ])) == 0
    error_message = "HEALDESK_DIRECT_BOOKING_ENABLED and HEALDESK_PHASE_TWO_ATTRIBUTION are never set from infrastructure: they wait for counsel and the owner."
  }

  validation {
    # optional() in lib/env.ts treats any non-empty value as set, so a blank or
    # a placeholder here would switch a feature on with nothing behind it.
    condition = alltrue([
      for name, value in var.app_environment :
      can(regex("^[A-Z][A-Z0-9_]*$", name)) && trimspace(value) != "" && value != "__unset__"
    ])
    error_message = "app_environment names must be upper-case environment variable names, and every value must be non-blank and not __unset__ (leave a setting out to keep it unset)."
  }

  validation {
    condition     = length(setintersection(keys(var.app_environment), concat(local.secret_environment_names, local.never_on_app_tasks))) == 0
    error_message = "app_environment must not carry a secret (those come from SSM Parameter Store, ssm.tf) or a name that is never set on the web and worker tasks (locals.tf, never_on_app_tasks)."
  }

  validation {
    condition     = length(setintersection(keys(var.app_environment), local.stack_environment_names)) == 0
    error_message = "app_environment must not override a name this stack sets from its own variables (locals.tf, stack_environment_names): change that variable instead."
  }
}

# ---------------------------------------------------------------------------
# Monitoring and cost
# ---------------------------------------------------------------------------

variable "alarm_email" {
  description = "Receives every alarm (through the SNS topic, confirmed once from the inbox) and the AWS Budgets alerts. Alarms carry metric names and counts, never patient data. A personal address, so it is kept out of git: infra.yml passes it as TF_VAR_alarm_email from a GitHub repository variable."
  type        = string

  validation {
    condition     = can(regex("^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$", var.alarm_email))
    error_message = "alarm_email must be an email address, passed as TF_VAR_alarm_email."
  }
}

variable "enable_guardduty" {
  description = "Run the account's GuardDuty detector (foundational threat detection over CloudTrail, VPC flow and DNS logs, which AWS reads without us storing them). Set false only if a detector made outside this module is imported or kept instead: a region holds one."
  type        = bool
  default     = true
}

variable "monthly_budget_usd" {
  description = "Monthly AWS cost budget in USD; alerts go to alarm_email at 80% and 100% of actual spend and at 100% of forecast."
  type        = number
  default     = 250

  validation {
    condition     = var.monthly_budget_usd > 0
    error_message = "monthly_budget_usd must be positive."
  }
}

# ---------------------------------------------------------------------------
# The credential vault's key
# ---------------------------------------------------------------------------

variable "kms_require_lock_labels" {
  description = "Require the lock labels on the app's own KMS calls (docs/design/google-calendar-2026-10-05.md section 5): the task role may use the key directly only with both healdesk:clinic and healdesk:login in the encryption context. Every sealer sends both since the calendar build's C6b (4693a4e), which every image built from main now carries. Turn it off only to run an older image, or to open an envelope sealed without labels (aad_version 1) before resealing it; a fresh database has none. It shapes IAM alone: nothing in the app reads it."
  type        = bool
  default     = true
}

# ---------------------------------------------------------------------------
# Built but off: no code uses them yet
# ---------------------------------------------------------------------------

variable "enable_transcript_bucket" {
  description = "Create the S3 bucket for call and chat transcripts (storage.tf): SSE-KMS under our key with S3 Bucket Keys, TLS only, no public access, versioned, current objects expiring at transcript_retention_days and deleted versions gone within a week, CloudTrail data events on every object read and write, and the task role's rights on it. Off until code writes transcripts there; once on, it cannot be switched off without emptying the bucket by hand (prevent_destroy)."
  type        = bool
  default     = false
}

variable "transcript_retention_days" {
  description = "Days after which S3 expires a transcript object whatever the app has done: the longest a clinic can keep transcripts (90 by default; a clinic can only shorten it, to 30 or 7, and the app deletes those itself). Raise it only together with the product's retention promise."
  type        = number
  default     = 90

  validation {
    condition     = var.transcript_retention_days >= 7 && var.transcript_retention_days <= 3650 && floor(var.transcript_retention_days) == var.transcript_retention_days
    error_message = "transcript_retention_days must be a whole number of days from 7 to 3650."
  }
}

variable "enable_ses" {
  description = "Create the SES configuration set that requires TLS, the domain identity with its DKIM records in Cloudflare, and the task role's rights to send through them (ses.tf), and set HEALDESK_SES_CONFIGURATION_SET on the web and worker tasks. Off: v1 mail goes over Resend and none of it may carry PHI. Turning it on does not change HEALDESK_EMAIL_TRANSPORT, and the account still has to leave the SES sandbox through a support request."
  type        = bool
  default     = false
}

variable "ses_domain" {
  description = "The SES sending domain: the domain of HEALDESK_EMAIL_FROM."
  type        = string
  default     = "healdesk.io"

  validation {
    condition     = can(regex("^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$", var.ses_domain))
    error_message = "ses_domain must be a lowercase domain name such as healdesk.io."
  }
}

# ---------------------------------------------------------------------------
# Deploy pipeline
# ---------------------------------------------------------------------------

variable "github_oidc_subjects" {
  description = "The GitHub OIDC subjects allowed to assume the deploy role, compared exactly: this repository's main branch. The repository was created after 15 July 2026, so GitHub issues the immutable form with owner and repository ids; the familiar repo:owner/name form never matches. A job gets a :ref: subject only when it names no GitHub environment, so no environment, and none of its settings, is part of this trust (the bootstrap stack's Terraform role is the same)."
  type        = list(string)
  default = [
    "repo:liamariavisoiu-ai98@262780224/healdesk.io@1326499636:ref:refs/heads/main",
  ]

  validation {
    condition = length(var.github_oidc_subjects) > 0 && alltrue([
      for subject in var.github_oidc_subjects :
      startswith(subject, "repo:") && endswith(subject, ":ref:refs/heads/main") && !strcontains(subject, "*") && !strcontains(subject, "?")
    ])
    error_message = "Each github_oidc_subjects entry must be an exact repo:...:ref:refs/heads/main subject, with no wildcard and no environment: only a run of main may deploy."
  }
}

variable "github_actor_id" {
  description = "Numeric id of the one GitHub user whose runs may assume the deploy role (the token's actor_id claim): the owner, liamariavisoiu-ai98. Ids never change or move to another account, unlike user names. The bootstrap stack's GitHubActorId is the same number."
  type        = string
  default     = "262780224"

  validation {
    condition     = can(regex("^[0-9]+$", var.github_actor_id))
    error_message = "github_actor_id must be a numeric GitHub user id."
  }
}
