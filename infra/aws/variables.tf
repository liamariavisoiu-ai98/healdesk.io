variable "account_id" {
  description = "The AWS account designated under the AWS BAA."
  type        = string
  default     = "865780386982"
}

variable "region" {
  description = "The designated region. apps/app's KMS client refuses any other while KMS holds the key."
  type        = string
  default     = "us-east-1"

  validation {
    condition     = var.region == "us-east-1"
    error_message = "The BAA record and lib/crypto/kms.ts both fix the region at us-east-1."
  }
}

variable "name" {
  description = "Prefix for resource names. Never a clinic or a patient."
  type        = string
  default     = "healdesk-apps-app"
}

variable "public_hostname" {
  description = "The public origin clinics use: BETTER_AUTH_URL, every mailed link, the portal."
  type        = string
  default     = "app.healdesk.io"
}

variable "internal_hostname" {
  description = <<-EOT
    The origin apps/web calls with signed requests: HEALDESK_APP_URL on Vercel.
    It must differ from public_hostname, because apps/app's email lint refuses
    any link to HEALDESK_APP_URL (lib/email/lint.ts).
  EOT
  type        = string
  default     = "app-internal.healdesk.io"
}

variable "certificate_dns_ready" {
  description = <<-EOT
    Set once the certificate's validation CNAMEs are in Cloudflare (output
    certificate_validation_records). Until then there is no HTTPS listener and
    nothing waits on the certificate.
  EOT
  type        = bool
  default     = false
}

variable "vpc_cidr" {
  type    = string
  default = "10.40.0.0/16"
}

variable "cpu_architecture" {
  description = "ARM64 builds natively on Apple silicon and costs less on Fargate."
  type        = string
  default     = "ARM64"

  validation {
    condition     = contains(["ARM64", "X86_64"], var.cpu_architecture)
    error_message = "ARM64 or X86_64."
  }
}

variable "image_tag" {
  description = "The apps/app image tag in ECR, as scripts/push-image.sh pushes it: the commit's short SHA."
  type        = string
  default     = "unset"
}

variable "web_desired_count" {
  description = "0 until the image is pushed and the secrets are written; ECS cannot start a task before both."
  type        = number
  default     = 0
}

variable "worker_desired_count" {
  description = "0 until the roles, migrations and queue are installed. One is enough; pg-boss allows more."
  type        = number
  default     = 0
}

variable "web_cpu" {
  type    = number
  default = 512
}

variable "web_memory" {
  type    = number
  default = 1024
}

variable "worker_cpu" {
  type    = number
  default = 512
}

variable "worker_memory" {
  type    = number
  default = 1024
}

variable "db_instance_class" {
  type    = string
  default = "db.t4g.small"
}

variable "db_engine_version" {
  description = "Major version only; RDS picks the minor and auto minor upgrades keep it current. CI runs 17."
  type        = string
  default     = "17"
}

variable "db_allocated_storage" {
  type    = number
  default = 20
}

variable "db_max_allocated_storage" {
  type    = number
  default = 100
}

variable "db_multi_az" {
  type    = bool
  default = false
}

variable "db_backup_retention_days" {
  description = "Automated backups and point-in-time restore. The launch plan requires 35 days, which is also RDS's maximum."
  type        = number
  default     = 35

  validation {
    condition     = var.db_backup_retention_days == 35
    error_message = "The launch plan requires 35 days of database backups."
  }
}

variable "kms_require_lock_labels" {
  description = <<-EOT
    The task role's lock-label rule (docs/design/google-calendar-2026-10-05.md §5): the
    app's own KMS calls must carry healdesk:clinic and healdesk:login. On since the calendar
    build's C6b (4693a4e, "Lock every sealed credential's data key to its clinic and login")
    reached main, which every image from then on carries. Turn it off only to deploy an older
    image, which seals and opens without the labels and would be refused.
  EOT
  type        = bool
  default     = true
}

variable "ses_domain" {
  description = "The SES sending domain for mail classed may-carry-phi. None is sent yet; today's mail goes over Resend."
  type        = string
  default     = "healdesk.io"
}

variable "enable_aws_config" {
  description = "AWS Config and the four rules docs/handover.md lists for the HIPAA account."
  type        = bool
  default     = true
}

variable "app_environment" {
  description = <<-EOT
    Plain, non-secret settings added to the web and worker tasks, such as HEALDESK_ADMIN_EMAIL,
    HEALDESK_OPS_EMAIL or HEALDESK_EMAIL_FROM. Never HEALDESK_DIRECT_BOOKING_ENABLED or
    HEALDESK_PHASE_TWO_ATTRIBUTION: those wait for counsel and the owner, not for this stack.
  EOT
  type        = map(string)
  default     = {}

  validation {
    condition = length(setintersection(keys(var.app_environment), [
      "HEALDESK_DIRECT_BOOKING_ENABLED",
      "HEALDESK_PHASE_TWO_ATTRIBUTION",
    ])) == 0
    error_message = "The direct-booking and phase-two switches are not set from infrastructure."
  }
}
