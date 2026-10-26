# =============================================================================
# tls-proxy: the encrypted hop between the load balancer and apps/app, as a
# sidecar in the web task.
#
#   docker build -t healdesk-tls-proxy infra/aws/images/tls-proxy
#   docker run --network container:<app container> healdesk-tls-proxy
#
# Clinics' BAA promises that patient data is encrypted wherever healdesk
# controls both ends, and healdesk controls both the load balancer and the
# task. Next's standalone server speaks plain HTTP, so this container
# terminates TLS on 8443 and hands each request to the app on 127.0.0.1:3001,
# a hop that never leaves the task's own network namespace. The target group
# is HTTPS:8443. The load balancer does not validate target certificates, so a
# self-signed one is enough to encrypt the hop.
#
# The key and certificate are made fresh by the entrypoint at every start, in
# the task's own /tmp, and are never part of the image: there is nothing in a
# layer, the registry or a backup to leak, and nothing to rotate.
# =============================================================================

FROM nginx:1.31.0-alpine@sha256:2f07d83bf561b506400dc183b1b2003803e39efbd22451f848adaba14d28c7c7

# The entrypoint needs openssl to make the certificate; the base image ships
# without it. Not pinned to a package version (hadolint's DL3018): Alpine
# drops superseded versions from its repository, so a pin would stop
# building, and the base is already pinned by digest.
# hadolint ignore=DL3018
RUN apk add --no-cache openssl

COPY nginx.conf.template /etc/nginx/tls-proxy.conf.template
COPY --chmod=0755 entrypoint.sh /usr/local/bin/tls-proxy-entrypoint
COPY --chmod=0755 healthcheck.sh /usr/local/bin/tls-proxy-healthcheck

# nginx runs unprivileged: 8443 needs no capability, and everything it writes
# (pid file, temp paths, key, certificate, rendered config) is in the runtime
# directory the entrypoint makes under /tmp. The root filesystem can be
# read-only once /tmp is a writable volume (see the entrypoint).
USER nginx
EXPOSE 8443

# ECS ignores a health check baked into an image; the task definition has to
# declare one. This is the same command, for docker run and for reference.
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD ["/usr/local/bin/tls-proxy-healthcheck"]

# The base image's STOPSIGNAL (SIGQUIT) is kept: nginx finishes the requests
# in flight before it exits, within the task's stop timeout.
ENTRYPOINT ["/usr/local/bin/tls-proxy-entrypoint"]
