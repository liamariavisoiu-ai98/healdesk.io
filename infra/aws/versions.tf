# Pinned to the minor lines this module was written and validated against
# (Terraform 1.16.5, hashicorp/aws 6.67, cloudflare/cloudflare 5.27,
# hashicorp/random 3.9). The exact provider builds are in .terraform.lock.hcl,
# with hashes for linux_amd64 (GitHub's runners, and Docker on an Intel Mac),
# linux_arm64 (Docker on Apple silicon) and darwin_amd64 and darwin_arm64 (a
# terraform installed on either kind of Mac), so none of them rewrites the
# file at init. To move a provider, change the constraint here and run
# `terraform init -upgrade` followed by `terraform providers lock` for those
# four platforms.
terraform {
  required_version = "~> 1.16"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.67"
    }
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.27"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.9"
    }
  }
}
