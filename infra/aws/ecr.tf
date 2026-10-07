# One image for the web tier, the worker and the one-off tasks
# (apps/app/Dockerfile). Tags are commit SHAs and never move. The image holds
# code and no patient data, so it stays on ECR's own encryption rather than
# our key, which would make every pull depend on the PHI key's grants.

resource "aws_ecr_repository" "app" {
  name                 = "healdesk/apps-app"
  image_tag_mutability = "IMMUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }

  encryption_configuration {
    encryption_type = "AES256"
  }
}

resource "aws_ecr_lifecycle_policy" "app" {
  repository = aws_ecr_repository.app.name

  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Keep the last 30 images"
      selection = {
        tagStatus   = "any"
        countType   = "imageCountMoreThan"
        countNumber = 30
      }
      action = { type = "expire" }
    }]
  })
}
