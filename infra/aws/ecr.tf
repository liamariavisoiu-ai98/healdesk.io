# The three images the deploy workflow builds, each tagged with the git SHA:
# the app (web, worker and migrate all run it), the db-admin image for the
# one-off role bootstrap, and the tls-proxy sidecar. Tags are immutable, so a
# SHA always names the same bytes and a deploy can be traced back to a commit.
# Images hold no PHI and no secrets.

resource "aws_ecr_repository" "this" {
  for_each = toset(["app", "db-admin", "tls-proxy"])

  name                 = "${local.ecr_namespace}/${each.key}"
  image_tag_mutability = "IMMUTABLE"
  force_delete         = false

  image_scanning_configuration {
    scan_on_push = true
  }

  encryption_configuration {
    encryption_type = "KMS"
    kms_key         = aws_kms_key.main.arn
  }
}

# Keep the last 30 images of each repository: enough to roll back weeks of
# deploys, without paying to store every build forever.
resource "aws_ecr_lifecycle_policy" "this" {
  for_each = aws_ecr_repository.this

  repository = each.value.name
  policy = jsonencode({
    rules = [
      {
        rulePriority = 1
        description  = "Keep the last 30 images"
        selection = {
          tagStatus   = "any"
          countType   = "imageCountMoreThan"
          countNumber = 30
        }
        action = {
          type = "expire"
        }
      },
    ]
  })
}
