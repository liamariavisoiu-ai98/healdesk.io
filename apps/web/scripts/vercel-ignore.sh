#!/bin/sh
# Vercel's ignored build step (apps/web/vercel.json "ignoreCommand"): exit 0 skips
# the build, any other exit builds.
#
# A PREVIEW is skipped when nothing apps/web is built from changed since the last
# commit Vercel deployed on the branch: apps/web itself, packages/*, the lockfile
# and the root manifests. Branches that only touch apps/app, infra, docs or
# workflows (most of the ops work) otherwise store a full set of function bundles
# each, and the free plan's 10 GB of function storage filled up (26 October 2026).
#
# PRODUCTION is never skipped: a push to main may carry several commits, and a
# missed deploy of the site is worse than a stored one. Any doubt (no previous
# commit known, a shallow clone without it, git failing) builds.
if [ "${VERCEL_ENV:-}" = "production" ]; then
  exit 1
fi

previous="${VERCEL_GIT_PREVIOUS_SHA:-}"
if [ -z "$previous" ]; then
  previous="HEAD^"
fi

# git diff --quiet: 0 = no change (skip), 1 = changed (build), 128 = error (build).
if git diff --quiet "$previous" HEAD -- . ../../packages ../../package.json ../../package-lock.json ../../turbo.json ../../tsconfig.base.json; then
  echo "Nothing apps/web is built from changed since $previous: skipping this preview build."
  exit 0
fi
exit 1
