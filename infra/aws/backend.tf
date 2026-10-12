# State lives in the bucket the bootstrap stack creates
# (infra/aws/bootstrap/bootstrap.yaml), encrypted with that stack's own KMS key.
# Neither is written here; both come from the stack's outputs at init:
#
#   terraform init \
#     -backend-config="bucket=healdesk-terraform-state-865780386982" \
#     -backend-config="kms_key_id=<the stack's state key ARN>"
#
# The state holds no secret value: every SSM parameter is written through the
# provider's write-only argument and never read back (ssm.tf), and the RDS
# master password lives in Secrets Manager, managed by RDS. It still maps the
# whole account, which is why that bucket is private, versioned, TLS-only and
# KMS-encrypted. A later staging copy passes its own
# -backend-config="key=healdesk/staging/terraform.tfstate".
#
# use_lockfile is S3's native locking; the DynamoDB lock table is deprecated.
terraform {
  backend "s3" {
    key          = "healdesk/production/terraform.tfstate"
    region       = "us-east-1"
    encrypt      = true
    use_lockfile = true
  }
}
