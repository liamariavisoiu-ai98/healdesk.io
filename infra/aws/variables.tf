# ---------------------------------------------------------------------------
# Where and what
# ---------------------------------------------------------------------------

variable "environment" {
  description = "Environment name, used in every resource name (healdesk-<environment>-...) and parameter path (/healdesk/<environment>/...). A staging copy is a second state with environment = \"staging\"."
  type        = string
  default     = "production"

  validation {
    # The longest names built from it, the target groups'
    # healdesk-<environment>-web-https and healdesk-<environment>-voice-http
    # (alb.tf), must fit AWS's 32 characters: 31 and 32 at twelve.
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

variable "nat_mode" {
  description = "How the private subnets reach the internet (Stripe, Meta, Anthropic, Resend, Google, and AWS's own APIs). \"instance\", the lean default: one small EC2 instance in the first AZ that forwards HTTPS and nothing else, about $7 a month with its address against about $37 for a NAT gateway (nat.tf). \"gateway\": AWS's managed NAT gateway, nat_gateways of them. Either way the tasks keep no public address and only the app's own TLS crosses it."
  type        = string
  default     = "instance"

  validation {
    condition     = contains(["instance", "gateway"], var.nat_mode)
    error_message = "nat_mode must be \"instance\" or \"gateway\"."
  }
}

variable "nat_instance_type" {
  description = "The NAT instance's type when nat_mode is \"instance\". A t4g.nano forwards far more than this product's API traffic; its CPU credits are capped (standard mode), so a burst slows it rather than billing extra."
  type        = string
  default     = "t4g.nano"

  validation {
    condition     = can(regex("^t4g\\.(nano|micro|small)$", var.nat_instance_type))
    error_message = "nat_instance_type must be t4g.nano, t4g.micro or t4g.small: the instance runs the arm64 Amazon Linux 2023 image."
  }
}

variable "nat_instance_generation" {
  description = "Bump by one to replace the NAT instance on the next apply: the new one boots the newest Amazon Linux 2023 image and kernel (the instance otherwise ignores new images). Do it every quarter, with the access review; egress pauses for the minute or two the new instance takes to boot. README, \"The NAT instance\"."
  type        = number
  default     = 1

  validation {
    condition     = var.nat_instance_generation >= 1 && floor(var.nat_instance_generation) == var.nat_instance_generation
    error_message = "nat_instance_generation must be a whole number of at least 1."
  }
}

variable "nat_gateways" {
  description = "NAT gateways when nat_mode is \"gateway\". 1 is one AZ's; 2 puts one in each AZ so losing an AZ does not cut egress. Ignored in instance mode."
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
  description = "Attach a WAF web ACL to the load balancer with one per-IP rate-based rule and nothing else (about $6 a month). Off in the lean default, by the owner's choice of 13 October 2026: HIPAA does not require it, the app keeps its own in-memory rate limits (exact while web_desired is 1) and AWS Shield Standard stays on the load balancer. Turn it on before a second web task, or when traffic warrants a limit at the edge."
  type        = bool
  default     = false
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

variable "worker_placement" {
  description = "Where the background worker runs. \"shared\", the lean default: as a third container in every web task, beside the app and the TLS sidecar, so one Fargate task carries all three. v1's worker runs light clocks (the outbox every minute, billing, the hourly tick, the calendar watch); the long sync runs that wanted a process of their own are phase two. It is essential: if it stops, ECS replaces the whole task and the web-below-desired alarm sees it. \"separate\": its own service, healdesk-<env>-worker, as first built. Workers running side by side are safe (the clock, job locks and outbox leases are held in the database), so web_desired above 1 is fine either way."
  type        = string
  default     = "shared"

  validation {
    condition     = contains(["shared", "separate"], var.worker_placement)
    error_message = "worker_placement must be \"shared\" or \"separate\"."
  }
}

variable "task_cpu_architecture" {
  description = "The CPU architecture every task definition declares. ARM64 (Graviton), the lean default, is about 20% cheaper per vCPU-hour and per GB-hour on Fargate than X86_64. deploy-app.yml reads it from the web task definition and builds all three images for it; images of one architecture do not run on the other, so a change reaches the services with the next full deploy, never a restart."
  type        = string
  default     = "ARM64"

  validation {
    condition     = contains(["ARM64", "X86_64"], var.task_cpu_architecture)
    error_message = "task_cpu_architecture must be \"ARM64\" or \"X86_64\"."
  }
}

variable "web_cpu" {
  description = "Fargate CPU units for each web task (1024 = one vCPU). 256 is a quarter vCPU, the lean default, shared by the app, the TLS sidecar and, when worker_placement is \"shared\", the worker. Nobody has measured the product under load on it: raise it to 512 if the app's CPU sits high."
  type        = number
  default     = 256

  validation {
    condition     = contains([256, 512, 1024, 2048], var.web_cpu)
    error_message = "web_cpu must be 256, 512, 1024 or 2048."
  }
}

variable "web_memory" {
  description = "Fargate memory in MiB for each web task. 1024 holds Next, the sidecar and the worker together with room to spare; 256 CPU units allow 512 to 2048."
  type        = number
  default     = 1024

  validation {
    condition = (
      (var.web_cpu == 256 && contains([512, 1024, 2048], var.web_memory)) ||
      (var.web_cpu == 512 && var.web_memory >= 1024 && var.web_memory <= 4096 && var.web_memory % 1024 == 0) ||
      (var.web_cpu == 1024 && var.web_memory >= 2048 && var.web_memory <= 8192 && var.web_memory % 1024 == 0) ||
      (var.web_cpu == 2048 && var.web_memory >= 4096 && var.web_memory <= 16384 && var.web_memory % 1024 == 0)
    )
    error_message = "web_memory must be a size Fargate allows for web_cpu: 512, 1024 or 2048 for 256; 1024-4096 for 512; 2048-8192 for 1024; 4096-16384 for 2048 (whole GiB above 512)."
  }
}

variable "worker_desired" {
  description = "Intended number of worker tasks when worker_placement is \"separate\", for documentation and the workflow's first scale-up. One worker owns the clock; more are safe but unnecessary. Ignored when the worker shares the web task."
  type        = number
  default     = 1

  validation {
    condition     = var.worker_desired >= 1 && var.worker_desired <= 3
    error_message = "worker_desired must be between 1 and 3."
  }
}

variable "enable_voice" {
  description = "Run the Retell voice endpoint (apps/app/src/voice/server.ts): its own task definition and service, healdesk-<env>-voice, from the same image as the web tier, with its own target group and a listener rule for /llm-websocket/* on app_domain (ecs.tf, alb.tf), and its below-desired alarm. Off by default, so the lean profile pays for no voice task: turn it on with the first clinic that has bought voice, once HEALDESK_RETELL_LLM_SECRET has been pasted with put-external-secrets.sh. Turning it off again makes the apply wait while the voice tasks drain, up to an hour (the service's delete timeout is 65 minutes, inside infra.yml's 90): do it in a quiet hour."
  type        = bool
  default     = false
}

variable "voice_real_calls" {
  description = "Let the voice endpoint answer real patients' calls: sets HEALDESK_VOICE_REAL_CALLS=1 on the voice task, and on the web task for /admin/map. Off, the endpoint is in test mode (apps/app/src/lib/voice/test-calls.ts): it answers only healdesk's made-up demo clinic, and a call for any other clinic is put through to that clinic's direct line, or refused, before the assistant speaks, with nothing recorded. That is the owner's exception of 19 October 2026, which lets HEALDESK_RETELL_LLM_SECRET be pasted for a test call before the agreements are signed. Turn it on only once every business associate agreement in the chain is signed, Retell's included."
  type        = bool
  default     = false

  validation {
    condition     = !var.voice_real_calls || var.enable_voice
    error_message = "voice_real_calls needs enable_voice: without the voice endpoint there are no calls to allow."
  }
}

variable "voice_desired" {
  description = "Intended number of voice tasks while enable_voice is on. Terraform creates the service at 0 and the deploy workflow sets this count after the first good migration; it is also the alarm's floor for healthy voice tasks. A deploy drops no call either way (the old tasks drain first, alb.tf). One, the lean default, is a single point of failure: losing that task mid-call drops every call on it and leaves Retell nothing to reach until ECS replaces it. Two survive the loss of one task mid-call (only its own calls drop, and the other answers the next), at the cost of a second task."
  type        = number
  default     = 1

  validation {
    condition     = var.voice_desired >= 1 && var.voice_desired <= 4 && floor(var.voice_desired) == var.voice_desired
    error_message = "voice_desired must be a whole number from 1 to 4."
  }
}

variable "voice_cpu" {
  description = "Fargate CPU units for each voice task (1024 = one vCPU). 256 is a quarter vCPU, the lean default, shared by the voice process and the TLS sidecar: a call spends its time waiting on Retell and the model, not computing. Nobody has measured it under calls: raise it to 512 if its CPU sits high while calls run, because a starved process is heard as a pause."
  type        = number
  default     = 256

  validation {
    condition     = contains([256, 512, 1024, 2048], var.voice_cpu)
    error_message = "voice_cpu must be 256, 512, 1024 or 2048."
  }
}

variable "voice_memory" {
  description = "Fargate memory in MiB for each voice task. 1024, the lean default, holds the process, the sidecar and many calls' transcripts with room to spare (a task that runs out is killed with every call on it, so this is not where to save $1.30 a month); 256 CPU units allow 512 to 2048."
  type        = number
  default     = 1024

  validation {
    condition = (
      (var.voice_cpu == 256 && contains([512, 1024, 2048], var.voice_memory)) ||
      (var.voice_cpu == 512 && var.voice_memory >= 1024 && var.voice_memory <= 4096 && var.voice_memory % 1024 == 0) ||
      (var.voice_cpu == 1024 && var.voice_memory >= 2048 && var.voice_memory <= 8192 && var.voice_memory % 1024 == 0) ||
      (var.voice_cpu == 2048 && var.voice_memory >= 4096 && var.voice_memory <= 16384 && var.voice_memory % 1024 == 0)
    )
    error_message = "voice_memory must be a size Fargate allows for voice_cpu: 512, 1024 or 2048 for 256; 1024-4096 for 512; 2048-8192 for 1024; 4096-16384 for 2048 (whole GiB above 512)."
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
  description = "RDS instance class. db.t4g.micro (2 vCPU, 1 GiB, about $12 a month), the lean default, is the smallest RDS offers; its max_connections of roughly 100 covers the connection budget of about 14 per process (web, worker, a one-off task) with room for the engine. db.t4g.small (2 GiB, about $23) is the step up; a change is a few minutes' downtime in the maintenance window or on apply. The freeable-memory alarm scales with the class (alarms.tf)."
  type        = string
  default     = "db.t4g.micro"

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
# Standby: the host with nothing running (README, "Standby")
# ---------------------------------------------------------------------------
#
# .github/workflows/host.yml is the only thing meant to set these, with -var on
# its command line, so production.tfvars stays the record of the active
# shape. Entering standby takes two applies, because a single apply cannot
# both change an instance and destroy it; leaving it takes one, then the
# deploy, then one more for the SES subscription once the app answers:
#
#   standby, apply 1  deletion_protection = false and final_snapshot_identifier
#                     set, standby still false: RDS and the load balancer lose
#                     their deletion protection, and the database's state
#                     records the snapshot its deletion takes. Nothing is
#                     removed. The provider reads skip_final_snapshot and
#                     final_snapshot_identifier from the state when it
#                     destroys, never from the configuration, which is why
#                     they have to be applied before the destroy.
#   standby, apply 2  standby = true: everything that costs by the hour goes
#                     (rds.tf, alb.tf, nat.tf, network.tf, ecs.tf, alarms.tf,
#                     dns.tf, waf.tf, ses.tf); the key, the parameters, the
#                     images, the network, the trail, Config, GuardDuty, the
#                     buckets, SES's identity, the alarm topic and the
#                     certificate stay.
#   active            standby = false, deletion_protection back on, and
#                     restore_snapshot_identifier naming the newest standby
#                     snapshot when the database does not exist, so the
#                     database comes back as it was.

variable "standby" {
  description = "Put the host in standby: remove the RDS instance (after the final snapshot apply 1 recorded), the load balancer with its listeners, rules and target groups, the NAT instance or gateways, every ECS service, the alarms that watch them, the WAF, the SES events subscription and the two Cloudflare CNAMEs that point at the load balancer. Everything that keeps data or identity stays (README, \"Standby\"). Needs deletion_protection = false, applied first on its own. Set only by host.yml (and by infra.yml while host.yml has recorded standby)."
  type        = bool
  default     = false

  validation {
    condition     = !var.standby || !var.deletion_protection
    error_message = "standby = true needs deletion_protection = false, applied first on its own: RDS and the load balancer refuse to be deleted while protected, and one apply cannot both lift the protection and delete them. host.yml does it in two applies."
  }

  validation {
    condition     = !var.standby || var.restore_snapshot_identifier == ""
    error_message = "restore_snapshot_identifier brings the database back from a standby snapshot, so it cannot be set with standby = true."
  }
}

variable "deletion_protection" {
  description = "Deletion protection on the RDS instance and the load balancer. On in every apply but standby's: host.yml's first standby apply turns it off, with nothing else changed, so that its second can remove them. An apply with it off and standby false (a standby that failed half-way, for instance) leaves both unprotected until the next apply that turns it back on."
  type        = bool
  default     = true
}

variable "final_snapshot_identifier" {
  description = "The snapshot RDS takes when the instance is deleted: healdesk-<environment>-standby-<UTC yyyymmddhhmmss>, written into the state by host.yml's first standby apply. Empty (the default) keeps skip_final_snapshot, as the clinic agreement's 35-day backup promise wants for any other deletion. A standby snapshot is a manual snapshot and never expires: host.yml refuses standby while any clinic is in production or any agreement is in effect, so it holds synthetic data only, and it deletes the older standby snapshots once a new one is available."
  type        = string
  default     = ""

  validation {
    condition     = var.final_snapshot_identifier == "" || can(regex("^healdesk-${var.environment}-standby-[0-9]{14}$", var.final_snapshot_identifier))
    error_message = "final_snapshot_identifier must be empty or healdesk-<environment>-standby-<14 digits of UTC time>, the name host.yml gives it and searches for when it turns the host on."
  }
}

variable "restore_snapshot_identifier" {
  description = "Create the RDS instance from this standby snapshot rather than empty. host.yml sets it to the newest available healdesk-<environment>-standby-* snapshot when it turns the host on and the instance does not exist; every later apply leaves it empty. Once the instance exists any value is ignored (rds.tf, ignore_changes), because snapshot_identifier forces a new database when it changes. The roles in a restored database already have the passwords Parameter Store kept, and db-bootstrap re-asserts them; with no snapshot the database is new and empty, and db-bootstrap creates the roles with those same passwords."
  type        = string
  default     = ""

  validation {
    condition     = var.restore_snapshot_identifier == "" || can(regex("^healdesk-${var.environment}-standby-[0-9]{14}$", var.restore_snapshot_identifier))
    error_message = "restore_snapshot_identifier must be empty or a standby snapshot's name, healdesk-<environment>-standby-<14 digits>: the host comes back only from a snapshot its own standby took."
  }
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

  # The transcript archive copy went on 14 October 2026 (the owner's decision):
  # healdesk keeps no copy of a transcript, not even in a mailbox of its own.
  validation {
    condition = length(setintersection(keys(var.app_environment), [
      "HEALDESK_TRANSCRIPT_ARCHIVE_TO",
      "HEALDESK_TRANSCRIPT_ARCHIVE_BAA",
    ])) == 0
    error_message = "HEALDESK_TRANSCRIPT_ARCHIVE_TO and HEALDESK_TRANSCRIPT_ARCHIVE_BAA are gone: a transcript is emailed to the clinic and healdesk keeps no copy of it."
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
  description = "Create the SES configuration set that requires TLS, the domain identity with its DKIM records in Cloudflare, and the task role's rights to send through them (ses.tf), and set HEALDESK_SES_CONFIGURATION_SET on the web and worker tasks. On since the owner's decision of 13 October 2026 that a conversation's transcript is emailed to the clinic rather than kept: that email is classed may-carry-phi, and with the configuration set present the app sends it, and only it, through SES (lib/reporting/deliver.ts, getTransport). Everything else stays on Resend; HEALDESK_EMAIL_TRANSPORT is unchanged. The account still has to leave the SES sandbox through a support request before SES delivers to a clinic."
  type        = bool
  default     = true
}

variable "subscribe_ses_events" {
  description = "Subscribe the app's /api/webhooks/ses to the SES events topic. SNS refuses an HTTPS subscription to an endpoint that does not answer (\"Unreachable Endpoint\"), so the apply fails if this is on while the web service does not answer on the public host. production.tfvars sets it on, the active shape; infra.yml and host.yml pass -var subscribe_ses_events=false while https://<app_domain>/api/health?probe=liveness does not answer ok, and host.yml's last apply turns it on once the deploy does. Off, a transcript that bounces at the clinic's mail server is not sent again and a delivered one is not known to be delivered; every other retry still runs. Standby removes the subscription with the host it posts to."
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
