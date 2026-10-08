#!/bin/sh
# tls-proxy entrypoint: make a fresh key and self-signed certificate, render
# the nginx configuration beside them, and hand the process to nginx.
#
# Everything nginx writes lives in one runtime directory under /dev/shm, a
# memory filesystem in every Docker and Fargate container. The private key
# never reaches a disk and never outlives the container, and the root
# filesystem can be mounted read-only. If /dev/shm cannot be written, the
# directory falls back to /tmp, on the task's own ephemeral storage (which
# Fargate encrypts), rather than leaving the web task without its TLS hop.
set -eu
umask 077

# How long an idle connection from the load balancer stays open. It has to
# outlast the balancer's idle timeout (alb_idle_timeout, 120 s by default), so
# if that is raised, set this in the task definition to match.
keepalive="${TLS_PROXY_KEEPALIVE_SECONDS:-130}"
case "$keepalive" in
  *[!0-9]*)
    echo "tls-proxy: TLS_PROXY_KEEPALIVE_SECONDS must be a whole number of seconds" >&2
    exit 1
    ;;
esac

run_dir=/dev/shm/tls-proxy
if ! mkdir -p "$run_dir" 2>/dev/null; then
  run_dir="${TMPDIR:-/tmp}/tls-proxy"
  mkdir -p "$run_dir"
  echo "tls-proxy: /dev/shm is not writable; the key is in $run_dir on the container's storage" >&2
fi
chmod 700 "$run_dir"

# A new key at every start. The load balancer encrypts the hop but does not
# validate the certificate, so its name and its 30-day validity do not matter
# to the connection: what matters is that the key is never shared or stored.
# RSA rather than ECDSA because every TLS client the balancer might use for
# targets accepts it.
if ! out=$(openssl req -x509 -newkey rsa:2048 -noenc -sha256 -days 30 \
  -subj "/CN=healdesk-tls-proxy" \
  -addext "subjectAltName=DNS:localhost,IP:127.0.0.1" \
  -keyout "$run_dir/tls.key" -out "$run_dir/tls.crt" 2>&1); then
  echo "$out" >&2
  echo "tls-proxy: could not create the key and certificate" >&2
  exit 1
fi

sed -e "s#__RUN_DIR__#$run_dir#g" -e "s#__KEEPALIVE_SECONDS__#$keepalive#g" \
  /etc/nginx/tls-proxy.conf.template >"$run_dir/nginx.conf"

fingerprint=$(openssl x509 -in "$run_dir/tls.crt" -noout -fingerprint -sha256 | cut -d= -f2)
echo "tls-proxy: TLS on 8443 to 127.0.0.1:3001, new certificate $fingerprint" >&2

# -e: report startup errors on stderr before the configuration is read.
exec nginx -e stderr -c "$run_dir/nginx.conf" "$@"
