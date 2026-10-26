#!/usr/bin/env bash
# One command that does what CI does, on this machine, before anything is pushed.
#
#   bash scripts/verify-local.sh            everything (several minutes)
#   VERIFY_QUICK=1 bash scripts/verify-local.sh     types, lint and a smoke test only
#   VERIFY_APP_FILES="tests/foo.test.ts tests/bar.test.ts" bash scripts/verify-local.sh
#       the app suites you name instead of the whole apps/app suite (web is always whole)
#
# It starts a throwaway Postgres 17 container on a free port, provisions the four
# roles, migrates, applies the grants, exports the TEST_* variables the database
# suites need, runs the typecheck, lint, the drizzle schema check, the whole
# apps/web suite and the apps/app suite, prints the pass, fail and SKIP counts of
# each, and removes the container. A database suite that skips (no TEST_APP_URL)
# proves nothing about data, so a non-zero skip count is reported as a warning.
#
# Never exports DATABASE_URL: tests/setup/env.ts uses DATABASE_URL ??= TEST_APP_URL,
# and an exported migrator URL would run app code as the migrator and hide grant bugs.
# Run it from any worktree of this repository (node_modules must be installed there).

set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || exit 2

if ! docker info >/dev/null 2>&1; then
  echo "verify-local: docker is not running; the database suites cannot run." >&2
  exit 2
fi
if [ ! -d node_modules ]; then
  echo "verify-local: run 'npm ci' in $ROOT first." >&2
  exit 2
fi

NAME="hd-verify-$$"
PORT=""
for candidate in $(seq 55700 55799); do
  if ! (echo >/dev/tcp/127.0.0.1/"$candidate") >/dev/null 2>&1; then PORT="$candidate"; break; fi
done
if [ -z "$PORT" ]; then echo "verify-local: no free port between 55700 and 55799." >&2; exit 2; fi

cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT

FAILED=0
note_fail() { FAILED=1; echo "verify-local: FAILED: $1" >&2; }

echo "== starting Postgres on port $PORT ($NAME)"
docker run -d --name "$NAME" -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=healdesk_test -p "$PORT":5432 postgres:17-alpine >/dev/null || exit 2
for _ in $(seq 1 60); do
  docker exec "$NAME" pg_isready -h 127.0.0.1 -U postgres >/dev/null 2>&1 && break
  sleep 1
done
docker cp apps/app/scripts/provision-roles.sql "$NAME":/tmp/provision-roles.sql
docker exec "$NAME" psql -q "postgres://postgres:postgres@localhost:5432/healdesk_test" \
  -v migrator_password=ci -v app_password=ci -v readonly_password=ci -v writer_password=ci \
  -f /tmp/provision-roles.sql >/dev/null || { echo "verify-local: role provisioning failed" >&2; exit 2; }

export MIGRATION_DATABASE_URL="postgres://healdesk_migrator:ci@localhost:$PORT/healdesk_test?sslmode=disable"
export TEST_MIGRATOR_URL="$MIGRATION_DATABASE_URL"
export TEST_APP_URL="postgres://healdesk_app:ci@localhost:$PORT/healdesk_test?sslmode=disable"
export TEST_WRITER_URL="postgres://healdesk_writer:ci@localhost:$PORT/healdesk_test?sslmode=disable"
export BETTER_AUTH_SECRET=local-test HEALDESK_PROVISION_SECRET=local-test
unset DATABASE_URL

echo "== migrating"
(cd apps/app && npm run db:migrate >/dev/null 2>&1 && npm run db:readonly-grants >/dev/null 2>&1 && npm run db:writer-grants >/dev/null 2>&1) \
  || { echo "verify-local: migrations or grants failed" >&2; exit 2; }

echo "== typecheck"
(cd apps/app && npx tsc --noEmit) || note_fail "tsc apps/app"
(cd apps/web && npx tsc --noEmit) || note_fail "tsc apps/web"

echo "== lint"
npm run lint >/dev/null 2>&1 || note_fail "lint (run 'npm run lint' to see it)"

echo "== drizzle schema check (must say: No schema changes)"
SCHEMA_OUT="$(cd apps/app && npx drizzle-kit generate 2>&1 | tail -3)"
echo "$SCHEMA_OUT" | grep -q "No schema changes" || { echo "$SCHEMA_OUT"; note_fail "drizzle-kit generate found schema changes"; }

summarise() {
  # $1 = label, $2 = log file. Prints the vitest totals line and warns on skips.
  local line
  line="$(grep -E "^\s*Tests " "$2" | tail -1)"
  echo "$1: ${line:-no totals found}"
  if echo "$line" | grep -qE "skipped"; then
    echo "  WARNING: $1 has skipped tests; skipped database suites prove nothing about data." >&2
  fi
  if echo "$line" | grep -qE "failed"; then note_fail "$1"; fi
}

LOGDIR="$(mktemp -d)"
if [ "${VERIFY_QUICK:-}" = "1" ]; then
  echo "== quick mode: one smoke test only"
  (cd apps/app && npx vitest run tests/migration-journal.test.ts tests/readonly-tables.test.ts >"$LOGDIR/app.log" 2>&1)
  summarise "apps/app (smoke)" "$LOGDIR/app.log"
else
  echo "== apps/web (whole suite)"
  (cd apps/web && npx vitest run >"$LOGDIR/web.log" 2>&1)
  summarise "apps/web" "$LOGDIR/web.log"
  if [ -n "${VERIFY_APP_FILES:-}" ]; then
    echo "== apps/app (named files)"
    # shellcheck disable=SC2086
    (cd apps/app && npx vitest run $VERIFY_APP_FILES >"$LOGDIR/app.log" 2>&1)
  else
    echo "== apps/app (whole suite; this is the long one)"
    (cd apps/app && npx vitest run >"$LOGDIR/app.log" 2>&1)
  fi
  summarise "apps/app" "$LOGDIR/app.log"
fi

if [ "$FAILED" -ne 0 ]; then
  echo "verify-local: FAILED. Logs: $LOGDIR" >&2
  grep -hE "FAIL " "$LOGDIR"/*.log 2>/dev/null | head -20 >&2
  exit 1
fi
echo "verify-local: all checks passed. Logs: $LOGDIR"
