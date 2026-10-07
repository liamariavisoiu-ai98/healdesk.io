# syntax=docker/dockerfile:1.7
# =============================================================================
# apps/app — the PHI side of the product, as one image with two commands.
#
#   docker build -f apps/app/Dockerfile -t healdesk-app .        (from the repo root)
#   docker run -p 3001:3001 --env-file apps/app/.env.production healdesk-app
#   docker run --env-file ... healdesk-app npm run worker -w @healdesk/app
#
# The web server is Next's standalone output (next.config.ts sets
# `output: "standalone"`), which bundles exactly the node_modules the server
# needs. The worker (src/workers/index.ts) is a plain Node process run with
# tsx, so the image also keeps the workspace's installed dependencies. One
# image, two entrypoints, is deliberate: the two must always ship the same
# schema, the same catalog and the same connectors, and two images drift.
#
# What the image does NOT contain: .env files, the drizzle migrations runner
# as a startup step (migrations run once, as healdesk_migrator, from a CI job
# or an operator's shell — never from the app role at boot), or a health
# check that depends on the database (see src/app/api/health/route.ts).
# =============================================================================

FROM node:22-bookworm-slim AS base
ENV NODE_ENV=production
WORKDIR /repo

# --- deps: the whole workspace, so `npm ci` resolves every internal package ---
FROM base AS deps
ENV NODE_ENV=development
COPY package.json package-lock.json turbo.json ./
COPY apps/app/package.json apps/app/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/catalog/package.json packages/catalog/package.json
COPY packages/connectors/package.json packages/connectors/package.json
COPY packages/leadgen/package.json packages/leadgen/package.json
RUN npm ci --no-audit --no-fund

# --- build: next build for apps/app only ---
FROM deps AS build
COPY . .
# `next build` collects route configuration by importing every route module,
# and lib/env.ts throws in production when these are unset. They are build
# placeholders only: ENV in this stage does not reach the runtime stage, and
# nothing here connects anywhere. The real values are injected by the host
# at run time (task definition, Fly secrets, an env file — never the image).
ENV DATABASE_URL=postgres://build:build@localhost:5432/build \
    BETTER_AUTH_SECRET=build-placeholder-not-a-secret-0000 \
    BETTER_AUTH_URL=http://localhost:3001 \
    HEALDESK_PROVISION_SECRET=build-placeholder
# The deps stage set NODE_ENV=development so `npm ci` would install dev
# dependencies, and this stage inherits it. `next build` must not: under
# development it prerenders with React's development build and fails on
# "/_global-error" (reading 'useContext' of null), and lib/env.ts would not
# check the variables above either.
ENV NODE_ENV=production
# Turbo would try to build apps/web too; call the app's own build script.
RUN npm run build -w @healdesk/app

# --- runtime ---
FROM base AS runtime
ENV PORT=3001 \
    HOSTNAME=0.0.0.0 \
    NEXT_TELEMETRY_DISABLED=1

# Run as an unprivileged user. The image has no shell-level secrets, but a
# container that runs as root is the first thing every scanner flags.
RUN groupadd --system healdesk && useradd --system --gid healdesk --home /repo healdesk

# The standalone server, laid out exactly as Next expects for a monorepo:
# /repo/apps/app/server.js with its own pruned node_modules beside it.
COPY --from=build --chown=healdesk:healdesk /repo/apps/app/.next/standalone ./
COPY --from=build --chown=healdesk:healdesk /repo/apps/app/.next/static ./apps/app/.next/static

# The worker needs the full workspace install (tsx, pg-boss, the packages).
COPY --from=build --chown=healdesk:healdesk /repo/node_modules ./node_modules
COPY --from=build --chown=healdesk:healdesk /repo/package.json ./package.json
COPY --from=build --chown=healdesk:healdesk /repo/apps/app/package.json ./apps/app/package.json
COPY --from=build --chown=healdesk:healdesk /repo/apps/app/src ./apps/app/src
COPY --from=build --chown=healdesk:healdesk /repo/apps/app/tsconfig.json ./apps/app/tsconfig.json
COPY --from=build --chown=healdesk:healdesk /repo/apps/app/drizzle ./apps/app/drizzle
COPY --from=build --chown=healdesk:healdesk /repo/apps/app/drizzle.config.ts ./apps/app/drizzle.config.ts
COPY --from=build --chown=healdesk:healdesk /repo/apps/app/scripts ./apps/app/scripts
COPY --from=build --chown=healdesk:healdesk /repo/packages ./packages

# Amazon RDS's certificate authorities. Node trusts only the public roots it
# ships with, and production verifies the database's certificate
# (src/db/index.ts sets rejectUnauthorized), so without this bundle every
# connection to RDS fails. NODE_EXTRA_CA_CERTS adds it to the defaults for the
# server, the worker and the one-off tasks alike. The file sits in /repo
# itself: with --chmod, a directory ADD creates gets the file's mode too, and
# a 644 directory cannot be entered, which Node reports only as a warning.
ADD --chown=healdesk:healdesk --chmod=644 https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem /repo/rds-global-bundle.pem
ENV NODE_EXTRA_CA_CERTS=/repo/rds-global-bundle.pem

USER healdesk
EXPOSE 3001

# Liveness only. Readiness is the `db` field in the body — alarm on it, do
# not route on it (the route explains why).
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3001/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "apps/app/server.js"]
