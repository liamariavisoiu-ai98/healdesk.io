# syntax=docker/dockerfile:1.7
# =============================================================================
# db-admin: fills the host's internal secrets in Parameter Store, then creates
# healdesk's two database roles on RDS as the RDS master user. Run as the
# one-off ECS task healdesk-production-db-bootstrap, before the first migration
# (infra/aws/README.md has the order); entrypoint.sh describes both steps.
#
#   docker build -f infra/aws/images/db-admin/Dockerfile -t healdesk-db-admin .   (from the repo root)
#
# The app image has no psql, and the master user is not a superuser, so this
# is a Postgres client image carrying the one script it runs: the RDS-safe
# apps/app/scripts/provision-roles.sql, copied at build time so the roles are
# always provisioned by the same file CI provisions its database with.
#
# Connection: libpq's own variables, read by psql itself: PGHOST, PGPORT,
# PGDATABASE, PGUSER and PGPASSWORD (the master credentials, as ECS secrets
# from the RDS-managed secret), with PGSSLMODE=verify-full and PGSSLROOTCERT
# defaulted below. The role passwords and the other internal values are made
# and read inside the task, through Parameter Store. Nothing is passed as an
# argument, so nothing secret is in the task definition's command or in a
# run-task override, both of which CloudTrail records, and nothing secret is
# in any layer.
# =============================================================================

# postgres 17.11 on Alpine 3.24 (the multi-architecture index, 17 September
# 2026): the client matches RDS's major version. Pinned so a rebuild cannot
# change what runs against the production database without a diff here.
FROM postgres:18-alpine@sha256:77f585114c32fbca283dc835b0596f4e52b51b4c6662d7810b2f4084f60a1873

# The AWS CLI v2 for init-secrets, from Alpine's own package: AWS publishes no
# build for musl. Held to the 2.34 line this image was tested with (2.34.63
# on 8 October 2026); a newer line fails the build until it is checked and
# the pin is raised. The pin stops at the minor version because Alpine drops a
# superseded build from its index, and an exact pin would then fail every
# deploy, which builds this image, the day Alpine ships a fix; that is also
# why hadolint's DL3018, which wants exact pins, is ignored here. python3 is
# what the CLI runs on, and scram-verifier.py uses it too.
#
# The two directories are made before ADD and COPY fill them, because
# BuildKit gives any directory it creates for a --chmod file that file's
# mode, and a 0644 directory is closed to everyone but root.
# hadolint ignore=DL3018
RUN apk add --no-cache 'aws-cli~2.34' 'python3~3.14' \
 && mkdir -p /etc/ssl/rds /opt/healdesk

# The Amazon RDS root CAs for us-east-1, the same file and digest as the app
# image (apps/app/Dockerfile explains both); verify-full needs them to check
# the instance's certificate. --chmod because ADD writes a URL's file 0600 and
# root-owned, and the script runs as the postgres user.
# checkov:skip=CKV_DOCKER_4:ADD fetches the bundle by URL against a pinned --checksum, so a changed file fails the build; COPY cannot fetch.
ADD --checksum=sha256:b1711d12bae51838581281e23b6cb97b1074016873b4dafc80ed14002462dd77 --chmod=0644 \
    https://truststore.pki.rds.amazonaws.com/us-east-1/us-east-1-bundle.pem /etc/ssl/rds/us-east-1-bundle.pem

COPY --chmod=0644 apps/app/scripts/provision-roles.sql /opt/healdesk/provision-roles.sql
COPY --chmod=0644 infra/aws/images/db-admin/scram-verifier.py /opt/healdesk/scram-verifier.py
COPY --chmod=0755 infra/aws/images/db-admin/entrypoint.sh /usr/local/bin/db-admin-entrypoint

# verify-full checks the certificate chain AND that it names PGHOST, so PGHOST
# must be the instance's own endpoint, not a CNAME. libpq's default, prefer,
# would accept any certificate and fall back to plaintext. A connect timeout,
# because libpq's default is to wait forever on an unreachable host. No pager
# for the AWS CLI, and no bytecode files written beside the scripts.
ENV PGSSLMODE=verify-full \
    PGSSLROOTCERT=/etc/ssl/rds/us-east-1-bundle.pem \
    PGCONNECT_TIMEOUT=15 \
    PGAPPNAME=healdesk-db-admin \
    AWS_PAGER="" \
    PYTHONDONTWRITEBYTECODE=1

# The base image's user, not root: this image never runs a server.
# checkov:skip=CKV_DOCKER_2:A one-off task that runs to completion; there is nothing to probe, and ECS ignores an image HEALTHCHECK anyway.
USER postgres
ENTRYPOINT ["/usr/local/bin/db-admin-entrypoint"]
