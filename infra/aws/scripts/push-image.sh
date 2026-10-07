#!/usr/bin/env bash
# Build apps/app's image for Fargate and push it to ECR, tagged with the
# commit's SHA. Tags are immutable, so a tag always means one commit.
#
#   infra/aws/scripts/push-image.sh
#   terraform -chdir=infra/aws apply -var image_tag=<the tag it prints>
#
# Refuses a working tree with changes: the build context is the whole repo
# (apps/app/Dockerfile copies it), so an uncommitted file would ship in an
# image whose tag names a commit that does not contain it. Run it from a
# clean worktree.
set -euo pipefail

root="$(git rev-parse --show-toplevel)"
tf_dir="$(cd "$(dirname "$0")/.." && pwd)"

if [[ -n "$(git -C "$root" status --porcelain)" ]]; then
  echo "refusing: the working tree has changes; push from a clean checkout of the commit to ship" >&2
  exit 1
fi

tag="$(git -C "$root" rev-parse --short=12 HEAD)"
repo="$(terraform -chdir="$tf_dir" output -raw ecr_repository_url)"
arch="$(terraform -chdir="$tf_dir" output -raw cpu_architecture)"
case "$arch" in
  ARM64) platform="linux/arm64" ;;
  X86_64) platform="linux/amd64" ;;
  *) echo "unknown cpu_architecture: $arch" >&2; exit 1 ;;
esac

aws ecr get-login-password --region us-east-1 |
  docker login --username AWS --password-stdin "${repo%%/*}"

docker buildx build \
  --platform "$platform" \
  --file "$root/apps/app/Dockerfile" \
  --tag "$repo:$tag" \
  --push \
  "$root"

echo
echo "pushed $repo:$tag"
echo "next: terraform -chdir=infra/aws apply -var image_tag=$tag"
