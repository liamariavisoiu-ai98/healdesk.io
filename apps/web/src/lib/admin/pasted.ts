/**
 * An admin setting as it was meant, from the value as it was pasted.
 *
 * Every admin value reaches Vercel by hand, and the only tools that make two of
 * them write them for `apps/web/.env.local`, not for Vercel's form:
 * `scripts/set-admin-password.ts` writes
 * `HEALDESK_ADMIN_PASSWORD_HASH="scrypt\$16384\$8\$1\$…\$…"`, quoted and with
 * every `$` escaped, because dotenv-expand reads a bare `$16384` as a variable
 * and leaves nothing of the hash. Copied from that file into Vercel, the value
 * keeps its quotes and backslashes; Vercel hands it to the app exactly as
 * typed, the hash splits into six fields that each end in a backslash, and the
 * sign-in page says "Not configured." to an owner whose every variable is set
 * (14 October 2026, the first sign-in after the second factor moved here).
 *
 * So the three ways a hand-carried value arrives are undone here, and nothing
 * else is: surrounding whitespace, the whole `NAME=value` line pasted as the
 * value, and one pair of matching quotes; then the `\$` escape. None of them can
 * turn a wrong value into a right one. A scrypt hash, an email address and a
 * base32 secret contain no quote, no backslash and no `NAME=`, so each check
 * after this one is exactly as strict as before; a value that was never
 * escaped or quoted comes out unchanged.
 *
 * No imports, on purpose: `scripts/set-admin-totp.ts` loads `totp.ts`, which
 * reads through this, under plain tsx.
 */
export function unwrapPasted(name: string, raw: string): string {
  let value = raw.trim();
  if (value.startsWith(`${name}=`)) value = value.slice(name.length + 1).trim();
  const first = value[0];
  if (value.length >= 2 && (first === '"' || first === "'") && value.endsWith(first)) {
    value = value.slice(1, -1).trim();
  }
  return value.replace(/\\\$/g, "$");
}

/** `process.env[name]`, unwrapped; undefined when the variable is not set. */
export function pastedSetting(name: string): string | undefined {
  const raw = process.env[name];
  return raw === undefined ? undefined : unwrapPasted(name, raw);
}
