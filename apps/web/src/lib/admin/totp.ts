/**
 * The operator's second factor: an RFC 6238 code checked here, on Vercel,
 * against a secret held in a Vercel environment variable.
 *
 * ## Why it lives here now (owner, 14 October 2026)
 *
 * Until 14 October the secret, its last-used step and ten recovery-code digests
 * lived in apps/app's database (`admin_totp`), and this app asked for a verdict
 * over the signed ops API before it would issue a session. That made the
 * operator console impossible to sign into while the AWS host was off, which
 * is most of the time before launch and exactly the time an outage needs the
 * console most. The owner chose to move the factor onto Vercel: sign-in now
 * makes no call to apps/app at all, and apps/web still has no database client
 * of any kind.
 *
 * What that costs, stated rather than discovered later: both factors are now
 * configuration in one Vercel project (`HEALDESK_ADMIN_PASSWORD_HASH` and
 * `HEALDESK_ADMIN_TOTP_SECRET`), so somebody who can read that project's
 * Sensitive variables holds a verifier for the password and the code
 * generator itself. The Vercel account, behind its own second factor, is
 * therefore the thing guarding the console, and it is listed as production
 * access in docs/policies/access-control.md for that reason.
 *
 * ## The one verifier in this app
 *
 * This file and nothing else in apps/web derives a code. apps/app keeps its
 * own TOTP for clinic portal sign-ins (`apps/app/src/lib/factors/totp.ts`),
 * which is a different credential for different people in a different app;
 * the arithmetic below was copied from it because apps/web cannot import
 * apps/app, and the two are pinned to the same RFC vectors by their tests
 * rather than by sharing code. If a second verifier ever appears beside this
 * one in apps/web, delete it rather than keeping the two in step.
 *
 * ## What is node:crypto and what is ours
 *
 * HMAC-SHA-1, the dynamic truncation and the base32 alphabet are the RFCs'.
 * The parts that are decisions are: one step of drift either side, every
 * candidate derived with no early exit, a constant-time compare, and the
 * replay ledger at the bottom, whose limits are written out beside it.
 *
 * No `next/*` import, on purpose: `scripts/set-admin-totp.ts` runs this under
 * plain tsx to make the secret it then asks the authenticator to prove.
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import { pastedSetting } from "./pasted";

/**
 * What every authenticator app assumes: SHA-1, six digits, thirty seconds.
 * SHA-1 is not a lapse. HMAC-SHA-1 has no weakness that matters to a
 * thirty-second code, and Google Authenticator ignores an otpauth URI's
 * `algorithm` and derives with SHA-1 regardless, so anything else would scan
 * and then never match.
 */
export const TOTP_DIGITS = 6;
export const TOTP_PERIOD_SECONDS = 30;

/**
 * One step either side of now, so a phone a few seconds out still works. A
 * code is therefore acceptable for at most three steps, ninety seconds, and
 * the replay ledger below has to cover that whole window.
 */
export const TOTP_DRIFT_STEPS = 1;

/** 160 bits, the size RFC 4226 recommends for HMAC-SHA-1. */
export const TOTP_SECRET_BYTES = 20;

/** 20 bytes is exactly 32 base32 characters, so there is never any padding. */
export const TOTP_SECRET_LENGTH = 32;

/** The variable, named once so the route's sentence and the script agree. */
export const TOTP_SECRET_VARIABLE = "HEALDESK_ADMIN_TOTP_SECRET";

const CODE_SHAPE = /^[0-9]{6}$/;

// -----------------------------------------------------------------------------
// The algorithm (RFC 4226 and RFC 6238)
// -----------------------------------------------------------------------------

/**
 * HOTP (RFC 4226 §5.3): HMAC-SHA-1 over the 8-byte big-endian counter, dynamic
 * truncation, then the low `digits` decimal digits. `digits` is a parameter
 * only so the RFC's own eight-digit vectors can be checked exactly.
 */
export function hotp(key: Buffer, counter: number, digits: number = TOTP_DIGITS): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac("sha1", key).update(message).digest();
  // readUInt8/readUInt32BE rather than indexing: bounds-checked, and the
  // offset is masked to 0-15, inside a 20-byte digest.
  const offset = digest.readUInt8(digest.length - 1) & 0x0f;
  const binary = digest.readUInt32BE(offset) & 0x7fff_ffff;
  return String(binary % 10 ** digits).padStart(digits, "0");
}

/** RFC 6238's T with T0 = 0: whole thirty-second periods since the epoch. */
export function totpStep(atMs: number): number {
  return Math.floor(atMs / 1000 / TOTP_PERIOD_SECONDS);
}

/**
 * Which step in the drift window produced `code`, or null.
 *
 * All three candidates are derived and compared every time, with no early
 * exit, so the time this takes does not say whether, or which, neighbour
 * matched. The compare is `timingSafeEqual` over two six-byte buffers: the
 * shape check first is what makes the lengths equal, so it cannot throw and
 * does not need a length test that would itself be an early exit.
 *
 * If two neighbouring steps happen to produce the same six digits (one in a
 * million), the later step is returned, which is the conservative answer for
 * the replay ledger: it refuses more, never less.
 */
export function matchTotpStep(key: Buffer, code: string, step: number): number | null {
  if (!CODE_SHAPE.test(code)) return null;
  const offered = Buffer.from(code, "utf8");
  let matched: number | null = null;
  for (let offset = -TOTP_DRIFT_STEPS; offset <= TOTP_DRIFT_STEPS; offset += 1) {
    const candidate = step + offset;
    if (candidate < 0) continue;
    const expected = Buffer.from(hotp(key, candidate), "utf8");
    if (timingSafeEqual(expected, offered)) matched = candidate;
  }
  return matched;
}

// -----------------------------------------------------------------------------
// base32 (RFC 4648, unpadded): what authenticator apps read
// -----------------------------------------------------------------------------

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = ((value << 8) | byte) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31] ?? "";
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31] ?? "";
  return out;
}

/** The bytes, or null when the string is not unpadded upper-case base32. */
export function base32Decode(value: string): Buffer | null {
  if (!/^[A-Z2-7]+$/.test(value)) return null;
  let bits = 0;
  let acc = 0;
  const out: number[] = [];
  for (const character of value) {
    acc = ((acc << 5) | BASE32_ALPHABET.indexOf(character)) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      out.push((acc >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

// -----------------------------------------------------------------------------
// The secret
// -----------------------------------------------------------------------------

export type AdminTotpSecret =
  | { ok: true; key: Buffer }
  /**
   * `unset`: absent or blank. `malformed`: present, and not 32 base32
   * characters. Both are closed: no code is checked and nobody signs in on the
   * password alone.
   */
  | { ok: false; problem: "unset" | "malformed" };

/**
 * The operator's TOTP key, read from `HEALDESK_ADMIN_TOTP_SECRET` on every
 * call, so a replaced variable takes effect on the next request of a new
 * deployment and nothing caches the old one.
 *
 * Exactly 32 base32 characters, which is 20 bytes: what the script writes.
 * Surrounding whitespace is dropped, because `echo ... | vercel env add`
 * carries a trailing newline and that is not a different secret; case is
 * folded, because authenticator apps accept either and a lower-cased paste is
 * not a different secret either. Anything else is refused rather than
 * repaired. A secret that decodes to 15 bytes because a character was lost in
 * a paste would still generate codes, they would just never be the phone's.
 *
 * The value is never logged, never returned to a browser, and never part of a
 * message: callers get the key or the name of the problem.
 */
export function adminTotpSecret(): AdminTotpSecret {
  // Quotes or a whole NAME=value line pasted as the value are undone first
  // (lib/admin/pasted.ts); the length and alphabet checks below stay exact.
  const raw = pastedSetting(TOTP_SECRET_VARIABLE);
  if (raw === undefined || raw.length === 0) return { ok: false, problem: "unset" };
  const normalised = raw.toUpperCase();
  if (normalised.length !== TOTP_SECRET_LENGTH) return { ok: false, problem: "malformed" };
  const key = base32Decode(normalised);
  if (key === null || key.length !== TOTP_SECRET_BYTES) return { ok: false, problem: "malformed" };
  return { ok: true, key };
}

/** A fresh secret, as the script prints it: 20 random bytes, unpadded base32. */
export function generateAdminTotpSecret(): string {
  return base32Encode(randomBytes(TOTP_SECRET_BYTES));
}

/**
 * The otpauth URI an authenticator app scans, in Google's Key URI format:
 * `otpauth://totp/healdesk:<email>?secret=...&issuer=healdesk&algorithm=SHA1
 * &digits=6&period=30`.
 *
 * The address is percent-encoded as a path segment, with `@` left readable
 * because RFC 3986 allows it there and every authenticator shows the label to
 * a person. Anything else that could end the segment (`/`, `?`, `#`, a space)
 * is encoded.
 */
export function adminTotpUri(secret: string, email: string): string {
  const issuer = "healdesk";
  const account = encodeURIComponent(email.trim().toLowerCase()).replace(/%40/g, "@");
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: "SHA1",
    digits: String(TOTP_DIGITS),
    period: String(TOTP_PERIOD_SECONDS),
  });
  return `otpauth://totp/${issuer}:${account}?${params.toString()}`;
}

// -----------------------------------------------------------------------------
// Replay, without a database
// -----------------------------------------------------------------------------

/**
 * The last step accepted in THIS process, per secret.
 *
 * ## What this covers, exactly
 *
 * A code once accepted must not sign anybody in again. The honest way to
 * guarantee that is a compare-and-set on a shared store, and apps/web has
 * none: no database by design, and by the owner's decision no KV, Blob, Edge
 * Config or Sheet write either. So two partial guarantees stand in for it,
 * and neither is described as more than it is:
 *
 *   1. **This map.** One entry per secret (keyed by a fingerprint, never the
 *      secret), holding the highest step this process has accepted. A step at
 *      or below it is refused, which refuses the same code twice and also
 *      refuses an older code once a newer one has been used. The check and the
 *      write happen in one synchronous turn (`claimStep`), so two requests
 *      inside one process cannot both pass: JavaScript does not interleave
 *      them between the read and the write.
 *   2. **A signed cookie** naming the last step accepted in that browser
 *      (`lib/admin/operator.ts`, `hd_operator_step`), so the same browser
 *      cannot reuse a code on a different instance either.
 *
 * What neither covers: two different serverless instances, with no cookie
 * between them, can each accept the same code once inside its ninety-second
 * window. An attacker who watched a code go past could race the owner with it
 * on a cold instance. What stands in front of that is everything else on the
 * door: the password (scrypt, so the code alone is worth nothing), the per-IP
 * and global attempt limits in the session route, and the sign-in alert that
 * goes to the owner on every success. A cold start also empties this map,
 * which is the same gap seen from the other side.
 *
 * Bounded: one administrator means one secret, and the map never holds more
 * than `MAX_LEDGER_ENTRIES` (a replaced secret leaves its old entry behind
 * until it is pushed out).
 */
const MAX_LEDGER_ENTRIES = 4;
const ledger = new Map<string, number>();

function fingerprint(key: Buffer): string {
  return createHash("sha256").update("healdesk.admin-totp.ledger.v1").update(key).digest("hex");
}

/**
 * Spend `step` for `key` in this process: true if it was later than anything
 * accepted here before, false if it is at or below the last one. Synchronous
 * on purpose; see above.
 */
export function claimStep(key: Buffer, step: number): boolean {
  const id = fingerprint(key);
  const last = ledger.get(id);
  if (last !== undefined && step <= last) return false;
  ledger.delete(id);
  ledger.set(id, step);
  while (ledger.size > MAX_LEDGER_ENTRIES) {
    const oldest = ledger.keys().next().value;
    if (oldest === undefined) break;
    ledger.delete(oldest);
  }
  return true;
}

/** A fresh instance: nothing accepted yet. */
export function __resetStepLedgerForTests(): void {
  ledger.clear();
}
