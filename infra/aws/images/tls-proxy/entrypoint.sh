#!/bin/sh
# tls-proxy entrypoint: make a fresh key and self-signed certificate, render
# the nginx configuration beside them, and hand the process to nginx.
#
# Everything nginx writes (key, certificate, configuration, pid file, temp
# paths) lives in one runtime directory, /tmp/tls-proxy. /tmp is writable in
# every container Fargate runs with a writable root filesystem, which is how
# the task definition runs this one; it is the task's ephemeral storage, which
# Fargate encrypts, and it never outlives the task. Nothing is assumed of
# /dev/shm, whose size and presence on Fargate are not documented.
#
# A read-only root filesystem needs a writable volume at /tmp, or one named by
# TLS_PROXY_RUN_DIR. Failing both, the entrypoint tries /dev/shm before giving
# up, and says which directory it used.
set -eu
umask 077

# How long an idle connection from the load balancer stays open. It has to
# outlast the balancer's idle timeout, so the task definition passes it,
# derived from the same variable (ecs.tf: alb_idle_timeout + 10). 130 is the
# default for a plain `docker run`, and suits the balancer's 120.
keepalive="${TLS_PROXY_KEEPALIVE_SECONDS:-130}"
case "$keepalive" in
  '' | *[!0-9]* | 0*)
    echo "tls-proxy: TLS_PROXY_KEEPALIVE_SECONDS must be a whole number of seconds above 0 (it is '$keepalive')" >&2
    exit 1
    ;;
esac

# The directory is written into nginx's configuration, so it may hold only
# the characters of a plain absolute path.
case "${TLS_PROXY_RUN_DIR:-/}" in
  /*[!A-Za-z0-9/._-]* | [!/]*)
    echo "tls-proxy: TLS_PROXY_RUN_DIR must be an absolute path of letters, digits and / . _ - (it is '$TLS_PROXY_RUN_DIR')" >&2
    exit 1
    ;;
esac

# The first candidate this user can create, own and write into. A directory
# made by anyone else is passed over rather than trusted with the key.
uid=$(id -u)
run_dir=""
for candidate in ${TLS_PROXY_RUN_DIR:+"$TLS_PROXY_RUN_DIR"} /tmp/tls-proxy /dev/shm/tls-proxy; do
  if mkdir -p "$candidate" 2>/dev/null &&
    [ "$(stat -c %u "$candidate")" = "$uid" ] &&
    chmod 700 "$candidate" 2>/dev/null &&
    touch "$candidate/.probe" 2>/dev/null; then
    rm -f "$candidate/.probe"
    run_dir=$candidate
    break
  fi
  echo "tls-proxy: cannot use $candidate (not writable, or made by another user); trying the next place" >&2
done
if [ -z "$run_dir" ]; then
  echo "tls-proxy: nowhere to write the key and certificate: give the container a writable /tmp (or set TLS_PROXY_RUN_DIR to a writable volume)" >&2
  exit 1
fi

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
echo "tls-proxy: TLS on 8443 to 127.0.0.1:3001, keep-alive ${keepalive}s, files in $run_dir, new certificate $fingerprint" >&2

# -e: report startup errors on stderr before the configuration is read.
exec nginx -e stderr -c "$run_dir/nginx.conf" "$@"
