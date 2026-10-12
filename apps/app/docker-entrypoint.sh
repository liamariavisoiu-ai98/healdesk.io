#!/bin/sh
# =============================================================================
# The apps/app image's entrypoint: treat "__unset__" as unset, then run the
# command (the web server by default; the worker and migrations pass their
# own).
#
# On AWS every secret reaches the container as an environment variable that
# ECS resolves from SSM Parameter Store when the task starts, and ECS refuses
# to start a task whose parameter does not exist. So Terraform creates the
# parameters only the owner can fill (Stripe, Meta, Resend, Anthropic, the
# voice secrets) holding the literal "__unset__" until someone pastes the real
# value. Passed through, a placeholder would read as configured: the Stripe
# client would send "__unset__" as its API key, and a webhook route would
# check signatures against it instead of answering 503. Every variable whose
# value is exactly "__unset__" is therefore removed here, whatever its name,
# and the app sees it as missing, which every optional feature already
# handles by staying off.
#
# Names come from awk's ENVIRON, which is the environment exactly as the
# container received it, so a value containing a newline cannot pass for a
# name. Only names the shell can hold are considered: dash drops any other
# from the environment it hands to the command, so such a variable never
# reaches the app anyway, and `unset` on one would abort this script.
#
# Prints the names it removed, so a task's log says what is still waiting to
# be filled in. It never prints a value.
# =============================================================================
set -eu

if [ "$#" -eq 0 ]; then
  echo "[healdesk] entrypoint: no command to run" >&2
  exit 64
fi

placeholders=$(awk 'BEGIN {
  for (name in ENVIRON)
    if (ENVIRON[name] == "__unset__" && name ~ /^[A-Za-z_][A-Za-z0-9_]*$/) print name
}')

removed=""
for name in $placeholders; do
  unset "$name"
  removed="$removed $name"
done

if [ -n "$removed" ]; then
  echo "[healdesk] entrypoint: not configured yet, treated as unset:$removed" >&2
fi

exec "$@"
