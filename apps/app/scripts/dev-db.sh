#!/usr/bin/env bash
#
# Local Postgres for development and the isolation tests.
#
# Creates the two roles the security model depends on — a migrator that owns the
# tables and a runtime role that can neither bypass RLS nor own anything — so
# local development exercises the same privilege split as production. Running
# everything as one superuser locally would make every isolation test pass for
# the wrong reason.
#
#   npm run db:up      start the container, provision roles, migrate
#   npm run db:reset   drop and rebuild from scratch
#   npm run db:down    stop and remove the container
#
# Prints the connection strings to export. Nothing here touches a real database.

set -euo pipefail

CONTAINER=healdesk-dev-pg
PORT=${HEALDESK_DB_PORT:-55432}
DB=healdesk_dev
MIGRATOR_PASSWORD=${MIGRATOR_PASSWORD:-devmigrator}
APP_PASSWORD=${APP_PASSWORD:-devapp}
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

migrator_url() { echo "postgres://healdesk_migrator:${MIGRATOR_PASSWORD}@localhost:${PORT}/${DB}"; }
app_url()      { echo "postgres://healdesk_app:${APP_PASSWORD}@localhost:${PORT}/${DB}"; }

start_container() {
  if docker ps -a --format '{{.Names}}' | grep -qx "$CONTAINER"; then
    docker start "$CONTAINER" >/dev/null
  else
    docker run -d --name "$CONTAINER" \
      -e POSTGRES_PASSWORD=postgres \
      -e POSTGRES_DB="$DB" \
      -p "${PORT}:5432" \
      postgres:17-alpine >/dev/null
  fi

  printf 'waiting for postgres'
  for _ in $(seq 1 60); do
    if docker exec "$CONTAINER" pg_isready -U postgres >/dev/null 2>&1; then
      echo " ready"
      return 0
    fi
    printf '.'
    sleep 1
  done
  echo " timed out" >&2
  exit 1
}

provision() {
  docker cp "${HERE}/provision-roles.sql" "${CONTAINER}:/tmp/provision-roles.sql" >/dev/null
  docker exec "$CONTAINER" psql -q -U postgres -d "$DB" \
    -v migrator_password="$MIGRATOR_PASSWORD" \
    -v app_password="$APP_PASSWORD" \
    -f /tmp/provision-roles.sql >/dev/null
  echo "roles provisioned"
}

migrate() {
  MIGRATION_DATABASE_URL="$(migrator_url)" npx drizzle-kit migrate
}

print_env() {
  cat <<EOF

Export these to run the app and the isolation tests:

  export DATABASE_URL="$(app_url)"
  export MIGRATION_DATABASE_URL="$(migrator_url)"
  export TEST_APP_URL="$(app_url)"
  export TEST_MIGRATOR_URL="$(migrator_url)"

EOF
}

case "${1:-up}" in
  up)
    start_container
    provision
    migrate
    print_env
    ;;
  reset)
    start_container
    docker exec "$CONTAINER" psql -q -U postgres \
      -c "drop database if exists ${DB} with (force);" \
      -c "create database ${DB};" >/dev/null
    provision
    migrate
    echo "database reset"
    print_env
    ;;
  down)
    docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
    echo "stopped"
    ;;
  *)
    echo "usage: dev-db.sh [up|reset|down]" >&2
    exit 1
    ;;
esac
