"""
Turn a role password into the psql line that hands provision-roles.sql its
SCRAM-SHA-256 verifier instead of the password itself.

    python3 scram-verifier.py app_password < password-file >> roles.psql

prints  \\set app_password 'SCRAM-SHA-256$4096:<salt>$<StoredKey>:<ServerKey>'

PostgreSQL stores a password that is already in this form exactly as given
(it is what it would compute itself, with a salt of its own), so the role
signs in with the password while the server never sees it. That matters for
one log line: a failed ALTER ROLE ... PASSWORD is logged with its statement,
into the RDS log group that never expires. The verifier can only be attacked
offline, and these passwords are 48 random letters and digits.

The password comes on stdin and the line goes to stdout, so neither is ever
on a command line. The format and the 4096 iterations are PostgreSQL's own
(src/common/scram-common.c, scram_iterations); SASLprep leaves printable
ASCII unchanged, so anything else is refused rather than guessed at.
"""

import base64
import hashlib
import hmac
import re
import secrets
import sys

ITERATIONS = 4096
SALT_BYTES = 16


def verifier(password: bytes) -> str:
    salt = secrets.token_bytes(SALT_BYTES)
    salted = hashlib.pbkdf2_hmac("sha256", password, salt, ITERATIONS)
    client_key = hmac.new(salted, b"Client Key", hashlib.sha256).digest()
    stored_key = hashlib.sha256(client_key).digest()
    server_key = hmac.new(salted, b"Server Key", hashlib.sha256).digest()

    def b64(raw: bytes) -> str:
        return base64.b64encode(raw).decode("ascii")

    return f"SCRAM-SHA-256${ITERATIONS}:{b64(salt)}${b64(stored_key)}:{b64(server_key)}"


def main() -> int:
    if len(sys.argv) != 2 or not re.fullmatch(r"[a-z_]+", sys.argv[1]):
        print("usage: scram-verifier.py VARIABLE < password", file=sys.stderr)
        return 64
    password = sys.stdin.buffer.read()
    if not password or any(byte < 0x21 or byte > 0x7E for byte in password):
        print("scram-verifier: the password must be printable ASCII with no spaces", file=sys.stderr)
        return 65
    # Single quotes around the value: base64, "$" and ":" are all literal
    # inside them for psql, and the verifier holds no quote or backslash.
    sys.stdout.write(f"\\set {sys.argv[1]} '{verifier(password)}'\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
