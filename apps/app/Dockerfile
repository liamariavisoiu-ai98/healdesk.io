# syntax=docker/dockerfile:1.7
# =============================================================================
# apps/app — the PHI side of the product, as one image with several commands.
#
#   docker build -f apps/app/Dockerfile -t healdesk-app .        (from the repo root)
#   docker run -p 3001:3001 --env-file apps/app/.env.production healdesk-app
#   docker run --env-file ... -w /repo/apps/app healdesk-app node --import tsx src/workers/index.ts
#   docker run --env-file ... healdesk-app sh -c "npm run db:migrate -w @healdesk/app && npm run queue:install -w @healdesk/app"
#
# The web server is Next's standalone output (next.config.ts sets
# `output: "standalone"`), which bundles exactly the node_modules the server
# needs. The worker (src/workers/index.ts) is a plain Node process run with
# tsx, so the image also keeps the workspace's installed dependencies. One
# image, several commands, is deliberate: web, worker and migrations must
# always ship the same schema, the same catalog and the same connectors, and
# separate images drift. The worker runs as `node --import tsx` rather than
# `npm run worker`, so node is the only process and gets ECS's SIGTERM itself
# instead of through npm, sh and tsx's 30 ms relay.
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
# Next's native compiler is an optional dependency, one package per platform,
# and npm drops an optional dependency it fails to download, saying so only in
# its debug log. `next build` then stops with "Turbopack is not supported on
# this platform", and every rebuild repeats it from the cached layer. So the
# step fails here instead, where a retry fixes it, and a layer without the
# compiler is never cached.
RUN npm ci --no-audit --no-fund \
 && node -e "require.resolve('@next/swc-linux-' + process.arch + '-gnu/package.json')"

# --- build: next build for apps/app only ---
FROM deps AS build
COPY . .
# `next build` collects route configuration by importing every route module,
# and lib/env.ts throws in production when these are unset. They are build
# placeholders only: ENV in this stage does not reach the runtime stage, and
# nothing here connects anywhere. The real values are injected by the host
# at run time (task definition, Fly secrets, an env file — never the image).
# The URL needs no sslmode: lib/env.ts's production TLS check stands aside
# while NEXT_PHASE says the process is `next build`.
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

# npm keeps its cache and debug logs under $HOME, which is /repo and belongs to
# root, so `npm run` as the healdesk user (the migrate task, the operator
# scripts) kept neither; and on every run it asks the npm registry whether a
# newer npm exists, a call out of the VPC that nothing here needs. The task
# definitions set the same two values.
ENV NPM_CONFIG_CACHE=/tmp/npm-cache \
    NPM_CONFIG_UPDATE_NOTIFIER=false

# Run as an unprivileged user. The image has no shell-level secrets, but a
# container that runs as root is the first thing every scanner flags.
RUN groupadd --system healdesk && useradd --system --gid healdesk --home /repo healdesk

# The Amazon RDS root CAs for us-east-1 (RSA2048 G1, RSA4096 G1, ECC384 G1).
# Node's bundled roots do not include them, and every database URL in
# production asks for sslmode=verify-full (src/lib/env.ts refuses anything
# less), so without this file no connection to RDS could be made. The URLs
# name it with sslrootcert=, which pg reads into the connection's CA list,
# and NODE_EXTRA_CA_CERTS adds it to Node's own store as well, for a URL
# that leaves sslrootcert out. Downloaded at build time against a pinned
# digest, so a changed file fails the build instead of shipping:
# sha256 b1711d12…dd77 is the bundle as served on 7 October 2026
# (Last-Modified 11 September 2024). If AWS reissues it, download it once,
# check the certificates, and update the digest. ADD writes a URL's file
# 0600 and root-owned, which the healdesk user could not read; hence --chmod.
# The directory is made first because BuildKit gives any directory it creates
# for a --chmod file that same mode, and nobody but root can enter a 0644 one.
RUN mkdir -p /etc/ssl/rds
# checkov:skip=CKV_DOCKER_4:ADD fetches the bundle by URL against a pinned --checksum, so a changed file fails the build; COPY cannot fetch.
ADD --checksum=sha256:b1711d12bae51838581281e23b6cb97b1074016873b4dafc80ed14002462dd77 --chmod=0644 \
    https://truststore.pki.rds.amazonaws.com/us-east-1/us-east-1-bundle.pem /etc/ssl/rds/us-east-1-bundle.pem
ENV NODE_EXTRA_CA_CERTS=/etc/ssl/rds/us-east-1-bundle.pem

# The entrypoint turns the host's "__unset__" placeholders into unset
# variables, then execs the command (see the script). Root-owned and not
# writable by the app user, like the bundle above.
COPY --chmod=0755 apps/app/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

# The standalone server, laid out exactly as Next expects for a monorepo:
# /repo/apps/app/server.js with its own pruned node_modules beside it.
COPY --from=build --chown=healdesk:healdesk /repo/apps/app/.next/standalone ./
COPY --from=build --chown=healdesk:healdesk /repo/apps/app/.next/static ./apps/app/.next/static

# The worker needs the full workspace install (tsx, pg-boss, the packages).
COPY --from=build --chown=healdesk:healdesk /repo/node_modules ./node_modules
# npm installs better-auth under apps/app/node_modules, not the root one
# (package-lock.json: "apps/app/node_modules/better-auth"). The standalone
# output carries only the copy Next traced for the web server, so the worker,
# which imports lib/auth through the portal and billing code, died on
# "Cannot find module 'better-auth'" at start (task definition :9, 21 October
# 2026) and, being essential, took its task down three times until the circuit
# breaker rolled the deploy back.
COPY --from=build --chown=healdesk:healdesk /repo/apps/app/node_modules ./apps/app/node_modules
COPY --from=build --chown=healdesk:healdesk /repo/package.json ./package.json
COPY --from=build --chown=healdesk:healdesk /repo/apps/app/package.json ./apps/app/package.json
COPY --from=build --chown=healdesk:healdesk /repo/apps/app/src ./apps/app/src
# apps/app/tsconfig.json extends ../../tsconfig.base.json. Without the base
# file tsx drops the whole config, `@/` paths included, and the worker, the
# queue install and every tsx script died with "Cannot find module '@/…'".
COPY --from=build --chown=healdesk:healdesk /repo/tsconfig.base.json ./tsconfig.base.json
COPY --from=build --chown=healdesk:healdesk /repo/apps/app/tsconfig.json ./apps/app/tsconfig.json
COPY --from=build --chown=healdesk:healdesk /repo/apps/app/drizzle ./apps/app/drizzle
COPY --from=build --chown=healdesk:healdesk /repo/apps/app/drizzle.config.ts ./apps/app/drizzle.config.ts
COPY --from=build --chown=healdesk:healdesk /repo/apps/app/scripts ./apps/app/scripts
COPY --from=build --chown=healdesk:healdesk /repo/packages ./packages

USER healdesk
EXPOSE 3001

# Liveness only, for `docker run` and compose: ?probe=liveness answers 200
# whenever the server is up and touches nothing, where the plain path reads
# the database and answers 503 while a critical email is late (the route
# explains why). ECS ignores an image HEALTHCHECK, so the task definition
# declares its own, on the same path, for the web container only; the
# worker serves no HTTP and must not inherit this.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3001/api/health?probe=liveness').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "apps/app/server.js"]
