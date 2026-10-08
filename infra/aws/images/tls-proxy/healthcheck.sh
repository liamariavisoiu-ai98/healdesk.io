#!/bin/sh
# The app's liveness probe, asked through this container's own TLS port, so a
# pass means nginx is serving TLS and reaching the app behind it. --insecure
# because the certificate is self-signed by design (see the entrypoint).
# Exit 1 for any failure: Docker reserves 2, and ECS reads non-zero as
# unhealthy.
curl --silent --fail --insecure --max-time 4 --output /dev/null \
  "https://127.0.0.1:8443/api/health?probe=liveness" || exit 1
