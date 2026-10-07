#!/usr/bin/env python3
"""
Write apps/app's two Secrets Manager secrets, runtime and admin.

    python3 infra/aws/scripts/put-secrets.py --env-file ~/healdesk-private/apps-app.env

Run by the owner, signed in to the AWS account (`aws sso login`), after the
first `terraform apply`. It prints key names and where each value came from,
never a value, and passes values to the AWS CLI through a private temporary
file rather than the command line, where `ps` would show them.

Where each value comes from:

  generated   once, here, then kept on every later run: APP_PASSWORD,
              MIGRATOR_PASSWORD, BETTER_AUTH_SECRET, HEALDESK_IDENTIFIER_REF_KEY
  built       DATABASE_URL and MIGRATION_DATABASE_URL, from those passwords
              and the database endpoint Terraform reports
  env file    everything else: the vendors' keys, and HEALDESK_PROVISION_SECRET,
              which must equal apps/web's own on Vercel (both sides sign and
              check the same HMAC)
  kept        a value already in the secret stays unless the env file names it

The env file is KEY=VALUE lines. Keep it outside the repository. A key the
secrets do not hold is refused, so a typo cannot pass silently. An optional
key left out is written as "", which lib/env.ts reads as unset.

Changing APP_PASSWORD or MIGRATOR_PASSWORD (by naming them in the env file)
means running `scripts/run-task.sh db-admin` again before anything connects.
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import secrets
import subprocess
import sys
import tempfile
from pathlib import Path

TF_DIR = Path(__file__).resolve().parent.parent

GENERATED = {
    "APP_PASSWORD": lambda: secrets.token_hex(32),
    "MIGRATOR_PASSWORD": lambda: secrets.token_hex(32),
    "BETTER_AUTH_SECRET": lambda: base64.b64encode(secrets.token_bytes(32)).decode(),
    "HEALDESK_IDENTIFIER_REF_KEY": lambda: base64.b64encode(secrets.token_bytes(32)).decode(),
}

# Read through required() in lib/env.ts: the app will not start without them.
REQUIRED = {
    "DATABASE_URL",
    "BETTER_AUTH_SECRET",
    "HEALDESK_PROVISION_SECRET",
    "HEALDESK_IDENTIFIER_REF_KEY",
    "MIGRATION_DATABASE_URL",
    "APP_PASSWORD",
    "MIGRATOR_PASSWORD",
}


def run(args: list[str], *, check: bool = True) -> subprocess.CompletedProcess[str]:
    return subprocess.run(args, capture_output=True, text=True, check=check)


def terraform_outputs() -> dict:
    result = run(["terraform", f"-chdir={TF_DIR}", "output", "-json"])
    return {k: v["value"] for k, v in json.loads(result.stdout).items()}


def read_env_file(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    for number, raw in enumerate(path.read_text().splitlines(), start=1):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if "=" not in line:
            sys.exit(f"{path}:{number}: expected KEY=VALUE")
        key, value = line.split("=", 1)
        key, value = key.strip(), value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "'\"":
            value = value[1:-1]
        values[key] = value
    return values


def current_secret(arn: str) -> dict[str, str]:
    result = run(
        ["aws", "secretsmanager", "get-secret-value", "--secret-id", arn,
         "--query", "SecretString", "--output", "text"],
        check=False,
    )
    if result.returncode != 0:
        if "ResourceNotFoundException" in result.stderr:
            return {}
        sys.exit(f"could not read {arn}: {result.stderr.strip().splitlines()[-1]}")
    return json.loads(result.stdout)


def put_secret(arn: str, value: dict[str, str]) -> None:
    with tempfile.TemporaryDirectory() as private_dir:
        os.chmod(private_dir, 0o700)
        path = Path(private_dir) / "secret.json"
        path.write_text(json.dumps(value))
        os.chmod(path, 0o600)
        run(["aws", "secretsmanager", "put-secret-value", "--secret-id", arn,
             "--secret-string", f"file://{path}"])


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--env-file", type=Path, required=True)
    args = parser.parse_args()

    outputs = terraform_outputs()
    runtime_keys: list[str] = outputs["runtime_secret_keys"]
    admin_keys: list[str] = outputs["admin_secret_keys"]
    known = set(runtime_keys) | set(admin_keys)

    from_file = read_env_file(args.env_file)
    unknown = sorted(set(from_file) - known)
    if unknown:
        sys.exit(f"refusing keys the secrets do not hold: {', '.join(unknown)}")
    built_here = {"DATABASE_URL", "MIGRATION_DATABASE_URL"} & set(from_file)
    if built_here:
        sys.exit(f"{', '.join(sorted(built_here))} are built from the passwords; leave them out")

    existing = {**current_secret(outputs["runtime_secret_arn"]),
                **current_secret(outputs["admin_secret_arn"])}

    values: dict[str, str] = {}
    source: dict[str, str] = {}
    for key in sorted(known):
        if key in from_file:
            values[key], source[key] = from_file[key], "env file"
        elif existing.get(key):
            values[key], source[key] = existing[key], "kept"
        elif key in GENERATED:
            values[key], source[key] = GENERATED[key](), "generated"
        else:
            values[key], source[key] = "", "empty"

    host, db = outputs["db_endpoint"], outputs["db_name"]
    for key, role, password in [
        ("DATABASE_URL", "healdesk_app", values["APP_PASSWORD"]),
        ("MIGRATION_DATABASE_URL", "healdesk_migrator", values["MIGRATOR_PASSWORD"]),
    ]:
        values[key] = f"postgres://{role}:{password}@{host}:5432/{db}?sslmode=verify-full"
        source[key] = "built"

    missing = sorted(k for k in REQUIRED if not values.get(k))
    if missing:
        sys.exit(f"required and empty: {', '.join(missing)}. Add them to {args.env_file}.")

    put_secret(outputs["runtime_secret_arn"], {k: values[k] for k in runtime_keys})
    put_secret(outputs["admin_secret_arn"], {k: values[k] for k in admin_keys})

    for key in sorted(known):
        print(f"  {key:34} {source[key]}")
    if any(source[k] in ("generated", "env file") for k in ("APP_PASSWORD", "MIGRATOR_PASSWORD")):
        print("\nThe database passwords are new: run scripts/run-task.sh db-admin before anything connects.")
    if not values.get("ANTHROPIC_API_KEY"):
        print("\nANTHROPIC_API_KEY is empty: the assistant cannot answer until it is set.")


if __name__ == "__main__":
    main()
