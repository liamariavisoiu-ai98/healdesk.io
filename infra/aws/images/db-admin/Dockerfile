# syntax=docker/dockerfile:1.7
# =============================================================================
# db-admin — creates healdesk's two database roles on RDS, once, as the RDS
# master user. Run as the one-off ECS task healdesk-production-db-bootstrap,
# before the first migration (infra/aws/README.md has the order).
#
#   docker build -f infra/aws/images/db-admin/Dockerfile -t healdesk-db-admin .   (from the repo root)
#
# The app image has no psql, and the master user is not a superuser, so this
# is a Postgres client image carrying the one script it runs: the RDS-safe
# apps/app/scripts/provision-roles.sql, copied at build time so the roles are
# always provisioned by the same file CI provisions its database with.
#
# Connection: libpq's own variables, read by psql itself — PGHOST, PGPORT,
# PGDATABASE, PGUSER and PGPASSWORD (the master credentials, as ECS secrets
# from the RDS-managed secret), with PGSSLMODE=verify-full and PGSSLROOTCERT
# defaulted below. The two role passwords arrive as APP_PASSWORD and
# MIGRATOR_PASSWORD. Nothing is passed as an argument, so nothing secret is
# in the task definition's command or in a run-task override, both of which
# CloudTrail records.
# =============================================================================

# postgres 17.11 on Alpine 3.24 (the multi-architecture index, 17 September
# 2026): the client matches RDS's major version. Pinned so a rebuild cannot
# change what runs against the production database without a diff here.
FROM postgres:17-alpine@sha256:b0f9560a2de083e2cc7382e75f808c7381a32852a7ec49117deedb300e552b24

# The Amazon RDS root CAs for us-east-1, the same file and digest as the app
# image (apps/app/Dockerfile explains both); verify-full needs them to check
# the instance's certificate. --chmod because ADD writes a URL's file 0600 and
# root-owned, and the script runs as the postgres user. The directories come
# first because BuildKit gives any directory it creates for a --chmod file
# that file's mode, and a 0644 directory is closed to everyone but root.
RUN mkdir -p /etc/ssl/rds /opt/healdesk
ADD --checksum=sha256:b1711d12bae51838581281e23b6cb97b1074016873b4dafc80ed14002462dd77 --chmod=0644 \
    https://truststore.pki.rds.amazonaws.com/us-east-1/us-east-1-bundle.pem /etc/ssl/rds/us-east-1-bundle.pem

COPY --chmod=0644 apps/app/scripts/provision-roles.sql /opt/healdesk/provision-roles.sql
COPY --chmod=0755 infra/aws/images/db-admin/entrypoint.sh /usr/local/bin/db-admin-entrypoint

# verify-full checks the certificate chain AND that it names PGHOST, so PGHOST
# must be the instance's own endpoint, not a CNAME. libpq's default, prefer,
# would accept any certificate and fall back to plaintext. A connect timeout,
# because libpq's default is to wait forever on an unreachable host.
ENV PGSSLMODE=verify-full \
    PGSSLROOTCERT=/etc/ssl/rds/us-east-1-bundle.pem \
    PGCONNECT_TIMEOUT=15 \
    PGAPPNAME=healdesk-db-admin

# The base image's user, not root: this image never runs a server.
USER postgres
ENTRYPOINT ["/usr/local/bin/db-admin-entrypoint"]
