# Production values for infra/aws (terraform plan -var-file=production.tfvars).
#
# Nothing here is a secret, and nothing here is personal. Secrets are written
# into SSM Parameter Store inside AWS: the internal ones by the db-bootstrap
# task, the external ones by the owner (the parameters_to_fill output lists
# them). The four account-specific values, alarm_email, healdesk_admin_email,
# healdesk_ops_email and cloudflare_zone_id, are not in this file either:
# infra.yml passes them as TF_VAR_* from GitHub repository variables, and a
# local run takes them from the environment the same way. A value set here
# would override the environment. The reasons behind each value are in
# variables.tf.

environment       = "production"
region            = "us-east-1"
app_domain        = "app.healdesk.io"
internal_hostname = "app-internal.healdesk.io"

healdesk_email_from = "healdesk <hello@healdesk.io>"

# Other plain, public settings for the web and worker tasks. The setup
# wizard's help lines (lib/setup/help.ts) stay hidden while these are unset;
# .env.example has the values. Set them once the support line's voicemail
# emails a notification only, with no recording or transcript.
app_environment = {
  # HEALDESK_SUPPORT_PHONE    = "<E.164 number>"
  # HEALDESK_CALL_BOOKING_URL = "<https scheduling page>"
}

# Network: the lean profile (13 October 2026). One t4g.nano NAT instance
# forwarding HTTPS only, about $7 a month against $37 for a NAT gateway
# (nat.tf); nat_mode = "gateway" goes back to the managed gateway, with
# nat_gateways of them. No VPC endpoints, no flow logs.
nat_mode          = "instance"
nat_instance_type = "t4g.nano"
nat_gateways      = 1
vpc_endpoints     = false
enable_flow_logs  = false

# Load balancer and tasks. The load balancer to task hop stays encrypted.
# The WAF is off by the owner's choice of 13 October 2026 (its rule and
# limit stay here for the day it is turned back on). One web task, on
# Graviton, a quarter vCPU and 1 GB, carries the app, the TLS sidecar and the
# worker; worker_placement = "separate" gives the worker its own service again.
alb_to_task_tls       = true
alb_idle_timeout      = 120
enable_waf            = false
waf_rate_limit        = 2000
container_insights    = false
worker_placement      = "shared"
task_cpu_architecture = "ARM64"
web_cpu               = 256
web_memory            = 1024
web_desired           = 1
worker_desired        = 1

# The Retell voice endpoint: off until HEALDESK_RETELL_LLM_SECRET is pasted,
# for a test call on the demo clinic or, with voice_real_calls, a clinic that
# has bought voice. Turned on, one task of a quarter vCPU
# and 1 GB, about $8.51 a month; voice_desired = 2 survives losing a task
# mid-call.
enable_voice  = false
voice_desired = 1
voice_cpu     = 256
voice_memory  = 1024

# Real patients' calls: off until every business associate agreement in the
# chain is signed, Retell's included. Off, the voice endpoint answers only the
# made-up demo clinic, for a test call (owner, 19 October 2026), and the
# worker's backstop records only that clinic's lost calls. On, the web, worker
# and voice tasks all carry the switch. It needs enable_voice: turning voice
# off means setting both to false in the same change.
voice_real_calls = false

# Database.
postgres_version     = "17.11"
db_instance_class    = "db.t4g.micro"
db_allocated_storage = 20
db_multi_az          = false

# Public ids for the web tier. Empty keeps the matching feature off; fill them
# in when the Meta app and Stripe Connect are configured for this host.
meta_app_id              = "1069571902539667"
meta_login_config_id     = "1119900017205430"
meta_whatsapp_config_id  = ""
stripe_connect_client_id = ""

# The credential vault's key: the app's own calls must carry both lock labels.
kms_require_lock_labels = true

# SES is on: a conversation's transcript is emailed to the clinic through it,
# never stored (the owner's decision of 13 October 2026). The transcript
# bucket stays off for the same reason (storage.tf).
enable_transcript_bucket  = false
transcript_retention_days = 90
enable_ses                = true

# SES's events reach the app (the active shape). SNS refuses to subscribe an
# endpoint that does not answer (the second apply, 14 October 2026), so
# infra.yml and host.yml override this with -var subscribe_ses_events=false
# while https://app.healdesk.io/api/health?probe=liveness does not answer ok,
# and host.yml's last apply, after its deploy, leaves it on.
subscribe_ses_events = true

# Monitoring and cost.
enable_guardduty   = true
monthly_budget_usd = 250

# Standby (README, "Standby"): the active shape is recorded here. host.yml
# switches between the two with -var on its command line (standby,
# deletion_protection, final_snapshot_identifier, restore_snapshot_identifier),
# and infra.yml follows the mode host.yml last recorded in Parameter Store, so
# this file never changes for a switch.
standby             = false
deletion_protection = true

# Who may deploy: GitHub's immutable OIDC subject for this repository's main
# branch, exactly as the bootstrap stack's Terraform role, and the one GitHub
# user whose runs may assume the role.
github_oidc_subjects = [
  "repo:liamariavisoiu-ai98@262780224/healdesk.io@1326499636:ref:refs/heads/main",
]
github_actor_id = "262780224"
