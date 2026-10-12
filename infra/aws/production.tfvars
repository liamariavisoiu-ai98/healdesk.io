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

# Network: one NAT gateway (2 for resilience), no VPC endpoints, no flow logs.
nat_gateways     = 1
vpc_endpoints    = false
enable_flow_logs = false

# Load balancer and tasks. The load balancer to task hop stays encrypted.
alb_to_task_tls    = true
alb_idle_timeout   = 120
enable_waf         = true
waf_rate_limit     = 2000
container_insights = false
web_desired        = 1
worker_desired     = 1

# Database.
postgres_version     = "17.11"
db_instance_class    = "db.t4g.small"
db_allocated_storage = 20
db_multi_az          = false

# Public ids for the web tier. Empty keeps the matching feature off; fill them
# in when the Meta app and Stripe Connect are configured for this host.
meta_app_id              = ""
meta_login_config_id     = ""
meta_whatsapp_config_id  = ""
stripe_connect_client_id = ""

# The credential vault's key: the app's own calls must carry both lock labels.
kms_require_lock_labels = true

# Built but off until code uses them (storage.tf, ses.tf).
enable_transcript_bucket  = false
transcript_retention_days = 90
enable_ses                = false

# Monitoring and cost.
enable_guardduty   = true
monthly_budget_usd = 250

# Who may deploy: GitHub's immutable OIDC subject for this repository's main
# branch, exactly as the bootstrap stack's Terraform role, and the one GitHub
# user whose runs may assume the role.
github_oidc_subjects = [
  "repo:liamariavisoiu-ai98@262780224/healdesk.io@1326499636:ref:refs/heads/main",
]
github_actor_id = "262780224"
