provider "aws" {
  region = var.region

  # The one account designated under the AWS Business Associate Addendum
  # (docs/policies/aws-hipaa-account.md). Credentials for any other account stop
  # the plan before anything is read or written: no other account is covered.
  allowed_account_ids = ["865780386982"]

  # No patient identifier may ever appear in a name or a tag: both land in
  # CloudTrail and billing, outside our key. Every resource carries these
  # three; the few that add a tag add a Name, a subnet tier or a service's
  # intended task count, never anything about a clinic or a patient.
  default_tags {
    tags = {
      Project     = "healdesk"
      Environment = var.environment
      ManagedBy   = "terraform"
    }
  }
}

# Authenticates from the CLOUDFLARE_API_TOKEN environment variable (a GitHub
# secret scoped to Zone:DNS:Edit on healdesk.io). Deliberately not a Terraform
# variable: variable values are written into saved plan files, and the infra
# workflow uploads its plan as an artifact.
provider "cloudflare" {}
