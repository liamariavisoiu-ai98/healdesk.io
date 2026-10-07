terraform {
  required_version = ">= 1.10"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.30"
    }
  }

  # Created by bootstrap/. `use_lockfile` is S3's own locking (Terraform 1.10
  # and later), so there is no DynamoDB table to keep.
  backend "s3" {
    bucket       = "healdesk-terraform-state-865780386982"
    key          = "apps-app/terraform.tfstate"
    region       = "us-east-1"
    encrypt      = true
    use_lockfile = true
  }
}

provider "aws" {
  region = var.region

  # The AWS BAA covers this one account (docs/policies/aws-hipaa-account.md);
  # a profile pointed anywhere else stops before it changes anything.
  allowed_account_ids = [var.account_id]

  # Tags land in CloudTrail and billing outside our key: ids and kinds only,
  # never a clinic or a patient.
  default_tags {
    tags = {
      Project   = "healdesk"
      ManagedBy = "terraform"
      Stack     = "apps-app"
    }
  }
}
