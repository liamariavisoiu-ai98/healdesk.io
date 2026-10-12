import {
  createHmac,
  randomBytes,
  randomInt,
  timingSafeEqual,
  createHash,
} from "node:crypto";

import { and, eq, lt, sql } from "drizzle-orm";

import { unsafeDb } from "@/db";
import { adminTotp } from "@/db/schema";
import { open, seal } from "@/lib/crypto/envelope";
import { FIXED_LOCK_LABELS } from "@/lib/crypto/kms";
import { env } from "@/lib/env";
import { log } from "@/lib/log";

/**
 * The administrator's second factor: the secret, the arithmetic, and the one
 * counter that makes a code single-use.
 *
 * ## Why this file exists
 *
 * healdesk.io/admin has one login and no user store. HEALDESK_ADMIN_EMAIL is
 * the username and HEALDESK_ADMIN_PASSWORD_HASH is a scrypt hash of the
 * password — both of which live in the same deployment configuration, readable
 * by anything that can read either. A second factor whose secret also lived
 * there would not be a second factor; it would be the same secret in a second
 * variable. So the secret is durable, sealed, and kept behind the database's
 * own refusals (see drizzle/0026_admin_totp.sql), and this module is the only
 * place in the codebase where it exists in the clear.
 *
 * That last property is the design, not a side effect. `verifyCode` and
 * `enrolAdminTotp` open and seal the envelope inside this file; nothing they
 * return contains the secret, and there is no exported function that hands it
 * out. A reader auditing "where could the TOTP secret leak" has exactly one
 * file to read.
 *
 * ## Why enrolment is two calls and not one
 *
 * The obvious design generates a secret, stores it enrolled, and shows the QR.
 * It has a failure that is silent until the worst moment: if the scan does not
 * happen — a mistyped manual entry, a closed tab, the wrong authenticator
 * profile — the account now REQUIRES a code nobody can produce, and the person
 * finds out at the next sign-in. Enrolling a factor you have not proved you can
 * use is the same mistake as deploying a backup you have never restored.
 *
 * So `proposeAdminTotp` generates a secret and stores NOTHING; the caller shows
 * it; `enrolAdminTotp` takes the proposal back with a code derived from it, and
 * only a correct code writes the row. The proposal carries the secret and its
 * own HMAC, keyed on a subkey of HEALDESK_PROVISION_SECRET, so there is no
 * pending state on this side to expire, clean up, or race — and no window in
 * which a half-enrolment exists in the database.
 *
 * ⚠️ A proposal CONTAINS the enrolment secret. It is exactly as sensitive as
 * the QR code it accompanies and must be handled the same way: held by the
 * caller for the length of one enrolment, never logged, never persisted.
 *
 * ## Why the secret is generated here and not by the caller
 *
 * apps/web could have generated it and passed it in. Then the quality of the
 * second factor would depend on a randomness decision made in the marketing
 * site, and this module could only check its length — 20 bytes of a fixed
 * pattern is the same length as 20 bytes of entropy. Generation belongs with
 * the code that knows what the value is for.
 *
 * ## What is deliberately not here
 *
 * No disenrolment, no secret rotation, no "reset the second factor". The
 * application has no DELETE on the table and cannot update the secret column,
 * so such a function could not work even if it were written — which is the
 * point. Removing this factor takes the migrator role and a human.
 */

// -----------------------------------------------------------------------------
// The algorithm, pinned
// -----------------------------------------------------------------------------

/**
 * RFC 6238 with the parameters every authenticator app assumes by default.
 *
 * SHA-1 is correct here and is not a lapse. TOTP's security rests on the
 * secret's 160 bits and the six-digit truncation, not on collision resistance,
 * and HMAC-SHA-1 has no known weakness relevant to a 30-second one-time code.
 * SHA-256 would be defensible cryptographically and worse in practice: Google
 * Authenticator ignores the `algorithm` parameter in an otpauth URI and derives
 * with SHA-1 regardless, so the enrolment would appear to succeed, the QR would
 * scan, and every subsequent code would be wrong — with no way to tell that
 * from a mistyped code.
 */
const DIGITS = 6;
const PERIOD_SECONDS = 30;
const ALGORITHM = "sha1";

/**
 * 20 bytes, the SHA-1 block-matched size RFC 4226 calls for and the size every
 * authenticator handles without complaint. 32 would not be stronger in any way
 * that matters: HMAC-SHA-1 keys longer than 64 bytes are hashed down, and the
 * code is six digits either way.
 */
const SECRET_BYTES = 20;

/**
 * How far either side of the server's clock a code is accepted.
 *
 * One step, so a code is good for at most 90 seconds and typically 60. A phone
 * whose clock has drifted by a minute is a real support problem; a window wide
 * enough to swallow it is also a window wide enough for an attacker relaying a
 * phished code at leisure. One step is the usual compromise and it is bounded
 * by something better than trust: an accepted step is spent, so widening the
 * window never makes a code reusable, only findable for longer.
 */
const DRIFT_STEPS = 1;

/** Codes are six digits. Anything else is not a code, and is refused unread. */
const CODE_SHAPED = /^\d{6}$/;

// -----------------------------------------------------------------------------
// The row
// -----------------------------------------------------------------------------

/**
 * There is one row and its primary key is the constant 1, pinned by a CHECK.
 *
 * Every statement in this file still names it. Under a `WHERE id = 1` an
 * unexpected second row could only ever be ignored; without one, an UPDATE with
 * no predicate would silently write to whatever rows existed, and the day the
 * singleton constraint is dropped by somebody adding a second operator is the
 * day that difference matters.
 */
const ROW_ID = 1;

/**
 * The AAD that binds this ciphertext to this row.
 *
 * `buildAad` takes a clinic and a credential because it was written for
 * per-clinic credentials, where its job is to stop a ciphertext being copied
 * from one clinic's row into another's. There is one row here and nowhere to
 * copy to, so the identity is a constant — which is honest rather than lazy:
 * it still differs from every provider_connections AAD, so a credential
 * ciphertext moved into this table fails to open rather than decrypting into
 * something this code would treat as a TOTP secret.
 */
const SECRET_IDENTITY = {
  clinicId: "healdesk-admin",
  credentialId: "admin_totp:1",
} as const;

/**
 * The lock label the secret's data key is wrapped under: ops / admin-code.
 * Constant like the identity, since the operator is no clinic and has no
 * client number; on AWS it is what CloudTrail shows against every unseal of
 * the operator's second factor. A secret enrolled before labels opens without
 * one (envelope.ts), and stays as it is: nothing here can re-seal it.
 */
const SECRET_LABEL = FIXED_LOCK_LABELS.adminCode;

// -----------------------------------------------------------------------------
// Recovery codes
// -----------------------------------------------------------------------------

/**
 * Ten codes, each ten characters of a 30-symbol alphabet: 49 bits apiece.
 *
 * They are the only way back in if the authenticator is lost, and there is no
 * colleague to ask and no support desk to call — so there have to be enough of
 * them to survive being partly mislaid, and each has to be strong enough to
 * stand alone as a full credential, because that is what it is.
 *
 * The alphabet excludes I, L, O, U and 0/1: these get written on paper and read
 * back by a person under stress, and a factor that fails because a 1 was read as
 * an I fails at exactly the moment it was kept for.
 */
const RECOVERY_ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ";
const RECOVERY_CODE_COUNT = 10;
const RECOVERY_CODE_LENGTH = 10;

// -----------------------------------------------------------------------------
// Enrolment proposals
// -----------------------------------------------------------------------------

/**
 * A proposal older than this is refused.
 *
 * Long enough to install an authenticator app you did not already have; short
 * enough that a proposal left in a scrollback or a browser session is not a
 * standing offer to enrol somebody else's phone.
 */
const PROPOSAL_TTL_MS = 15 * 60_000;

const PROPOSAL_DOMAIN = "healdesk.admin-totp.enrolment.v1";

/**
 * The proposal is signed with a SUBKEY of the provisioning secret, never with
 * the secret itself.
 *
 * The same key already authenticates every request to /api/ops, /api/provision
 * and the agreement PDF route. Using it directly for a second, differently
 * shaped message is how two protocols end up able to forge each other's
 * messages; one HMAC of a domain string costs nothing and makes that structural
 * rather than a thing to be careful about.
 */
function proposalKey(): Buffer {
  const secret = env.provisionSecret();
  if (!secret) {
    // Not a warn-and-continue: an empty key is a forgeable proposal, and a
    // forgeable proposal is an attacker-chosen second factor.
    throw new Error(
      "HEALDESK_PROVISION_SECRET is not set, so an enrolment proposal cannot be signed.",
    );
  }
  return createHmac("sha256", secret).update(PROPOSAL_DOMAIN).digest();
}

export type AdminTotpProposal = {
  /**
   * The base32 secret, for manual entry. ⚠️ Show it, do not store it.
   */
  secret: string;
  /** The QR payload. Contains the secret; treat it identically. */
  otpauthUri: string;
  /**
   * Opaque, and the only thing `enrolAdminTotp` will accept. ⚠️ It contains the
   * secret. Hold it for the length of one enrolment and nowhere else.
   */
  proposal: string;
  /** Milliseconds from now until the proposal stops being accepted. */
  expiresInMs: number;
};

/**
 * Mint a candidate secret. Stores nothing.
 *
 * Nothing is written until a code derived from this secret comes back, so a
 * proposal that is never confirmed leaves no trace at all — no pending row to
 * expire, no cleanup job, and no state for a second proposal to race against.
 */
export function proposeAdminTotp(accountLabel: string): AdminTotpProposal {
  const secretBytes = randomBytes(SECRET_BYTES);
  const secret = base32Encode(secretBytes);

  const issuer = "healdesk";
  const label = `${issuer}:${accountLabel}`;
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: "SHA1",
    digits: String(DIGITS),
    period: String(PERIOD_SECONDS),
  });

  const body = Buffer.from(
    JSON.stringify({ s: secret, t: Date.now() }),
    "utf8",
  ).toString("base64url");

  return {
    secret,
    // encodeURIComponent, not URLSearchParams, for the label: the path segment
    // of an otpauth URI is not a query string, and a "+" written for a space
    // there is a literal plus in every authenticator that reads it.
    otpauthUri: `otpauth://totp/${encodeURIComponent(label)}?${params.toString()}`,
    proposal: `${body}.${createHmac("sha256", proposalKey()).update(body).digest("base64url")}`,
    expiresInMs: PROPOSAL_TTL_MS,
  };
}

/** The secret a proposal carries, or null if it is not one of ours any more. */
function openProposal(proposal: string): string | null {
  const dot = proposal.indexOf(".");
  if (dot <= 0 || dot === proposal.length - 1) return null;

  const body = proposal.slice(0, dot);
  const received = Buffer.from(proposal.slice(dot + 1), "utf8");
  const expected = Buffer.from(
    createHmac("sha256", proposalKey()).update(body).digest("base64url"),
    "utf8",
  );

  // Length first: timingSafeEqual throws on a mismatch, which would itself leak
  // that the lengths differ.
  if (received.length !== expected.length) return null;
  if (!timingSafeEqual(received, expected)) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }

  if (typeof parsed !== "object" || parsed === null) return null;
  const { s, t } = parsed as { s?: unknown; t?: unknown };
  if (typeof s !== "string" || typeof t !== "number") return null;

  // Both directions. A proposal timestamped in the future is as much a sign of
  // something wrong as a stale one, and the MAC does not make it true.
  const age = Date.now() - t;
  if (age < 0 || age > PROPOSAL_TTL_MS) return null;

  return isBase32(s) ? s : null;
}

// -----------------------------------------------------------------------------
// State
// -----------------------------------------------------------------------------

export type AdminTotpState = {
  enrolled: boolean;
  /** ISO 8601, or null when nothing is enrolled. */
  enrolledAt: string | null;
  /** How many are left. Never the codes, and never their digests. */
  recoveryCodesRemaining: number;
};

/**
 * What the sign-in surface needs to know, and nothing else.
 *
 * The secret column is not in this projection, and that is the point rather
 * than an economy: this function's result crosses an application boundary on
 * its way to a browser-facing page, so it must not be able to carry the secret
 * even if somebody later spreads the row into the response. Verification reads
 * the secret separately, in this file, and returns a boolean.
 */
export async function getAdminTotpState(): Promise<AdminTotpState> {
  const [row] = await unsafeDb
    .select({
      enrolledAt: adminTotp.enrolledAt,
      remaining: sql<number>`cardinality(${adminTotp.recoveryCodeHashes})`,
    })
    .from(adminTotp)
    .where(eq(adminTotp.id, ROW_ID))
    .limit(1);

  if (!row) {
    return { enrolled: false, enrolledAt: null, recoveryCodesRemaining: 0 };
  }

  return {
    enrolled: true,
    enrolledAt: row.enrolledAt.toISOString(),
    // `cardinality` is int4 and arrives as a number, but a driver that ever
    // hands it back as a string would produce "10" in a field the caller
    // compares against 0 — which is truthy, and would report codes remaining
    // when there are none.
    recoveryCodesRemaining: Number(row.remaining),
  };
}

// -----------------------------------------------------------------------------
// Enrolment
// -----------------------------------------------------------------------------

export type EnrolResult =
  | {
      status: "enrolled";
      /**
       * The plaintext recovery codes, returned EXACTLY once.
       *
       * Only their digests are stored, so this array is the only copy that will
       * ever exist on our side. If the caller drops it, the codes are gone —
       * which is the property that makes the stored column useless to anyone
       * who reads the table.
       */
      recoveryCodes: string[];
      enrolledAt: string;
    }
  | { status: "already_enrolled" }
  | { status: "rejected"; reason: "proposal_expired" | "code_incorrect" };

/**
 * Enrol the proposed secret, if a code proves the authenticator holds it.
 *
 * Once only. The INSERT is `ON CONFLICT DO NOTHING` on a singleton primary key,
 * so a second enrolment does not replace the first — it reports that one
 * exists. Combined with the migration's grants (no DELETE, no UPDATE of the
 * secret column) this makes the enrolled factor immovable by anything holding
 * the application's credentials: an attacker with the signing key and full
 * command of apps/web still cannot point the second factor at a phone of their
 * own.
 *
 * The code is checked against the drift window rather than the current step
 * alone: a phone thirty seconds out would otherwise fail enrolment with the
 * same message as a wrong code, and the person would have no way to tell which.
 *
 * No step is spent here. The row does not exist yet, and the code just used is
 * spent by the first verification that sees it — see the note on `markStepUsed`.
 */
export async function enrolAdminTotp(
  proposal: string,
  code: string,
): Promise<EnrolResult> {
  const secret = openProposal(proposal);
  // One answer for expired, tampered and malformed. A caller that did not
  // produce this proposal learns nothing from the difference, and the honest
  // instruction for all three is the same: start the enrolment again.
  if (!secret) return { status: "rejected", reason: "proposal_expired" };

  if (!CODE_SHAPED.test(code)) {
    return { status: "rejected", reason: "code_incorrect" };
  }

  const key = base32Decode(secret);
  if (!key || matchStep(key, code, currentStep()) === null) {
    return { status: "rejected", reason: "code_incorrect" };
  }

  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, generateRecoveryCode);
  const sealed = await seal(secret, SECRET_IDENTITY, SECRET_LABEL);
  const enrolledAt = new Date();

  const [row] = await unsafeDb
    .insert(adminTotp)
    .values({
      id: ROW_ID,
      secretCiphertext: sealed,
      enrolledAt,
      // The step just proved is NOT recorded as spent. It is worth saying out
      // loud: a code good for another twenty seconds is replayable against the
      // sign-in path in that window. It is not a hole — nothing is signed in
      // yet, the person holding the code is the person enrolling, and the
      // alternative is a first sign-in that mysteriously refuses the code the
      // authenticator is showing.
      lastUsedStep: 0,
      recoveryCodeHashes: codes.map(digestRecoveryCode),
      createdAt: enrolledAt,
    })
    .onConflictDoNothing({ target: adminTotp.id })
    .returning({ enrolledAt: adminTotp.enrolledAt });

  if (!row) return { status: "already_enrolled" };

  return {
    status: "enrolled",
    recoveryCodes: codes,
    enrolledAt: row.enrolledAt.toISOString(),
  };
}

// -----------------------------------------------------------------------------
// Verification
// -----------------------------------------------------------------------------

export type VerifyResult =
  | { ok: true; step: number }
  | {
      ok: false;
      reason: "not_enrolled" | "incorrect" | "already_used" | "unreadable";
    };

/**
 * Check one six-digit code and, if it is right, spend it.
 *
 * The order is deliberate: derive, compare, and only then write. A design that
 * recorded the attempt first would let a stranger submitting garbage advance
 * the counter past the administrator's real code.
 *
 * `already_used` is distinguished from `incorrect` because they mean different
 * things to the person at the keyboard — one says "wait for the next code", the
 * other says "check the account you are reading it from" — and because a
 * genuine `already_used` on a code the administrator has not submitted twice is
 * the signature of a relay, which is worth an audit row of its own. It
 * discloses nothing: producing it requires a correct code.
 */
export async function verifyAdminTotpCode(
  code: string,
  at: Date = new Date(),
): Promise<VerifyResult> {
  if (!CODE_SHAPED.test(code)) return { ok: false, reason: "incorrect" };

  const [row] = await unsafeDb
    .select({ sealed: adminTotp.secretCiphertext })
    .from(adminTotp)
    .where(eq(adminTotp.id, ROW_ID))
    .limit(1);

  if (!row) return { ok: false, reason: "not_enrolled" };

  let secret: string;
  try {
    secret = await open(row.sealed, SECRET_IDENTITY, SECRET_LABEL);
  } catch (error) {
    /**
     * A GCM tag failure means the row or the key has changed under us — a
     * restored backup taken under a different KEK, a rotated key that was never
     * re-wrapped, or tampering. Never the ciphertext, never the identity, and
     * never the error object: envelope.open()'s message is written to be safe
     * to log, but its `cause` carries the underlying crypto error.
     */
    log.error("admin totp secret could not be opened", {
      error: error instanceof Error ? error.name : "unknown error",
    });
    return { ok: false, reason: "unreadable" };
  }

  const key = base32Decode(secret);
  if (!key) {
    log.error("admin totp secret is not valid base32");
    return { ok: false, reason: "unreadable" };
  }

  const step = matchStep(key, code, currentStep(at));
  if (step === null) return { ok: false, reason: "incorrect" };

  const spent = await markStepUsed(step);
  return spent ? { ok: true, step } : { ok: false, reason: "already_used" };
}

/**
 * Record a step as spent, and say whether this call is the one that did it.
 *
 * A single conditional UPDATE, and the condition is the whole point. The read
 * then write version — "is this step used? no? use it" — passes every
 * sequential test anybody writes and loses the race in production: two
 * submissions of the same intercepted code, arriving together, both read the
 * old counter and both succeed. Under READ COMMITTED this way, the second
 * statement blocks on the row lock, re-evaluates `last_used_step < $step`
 * against the committed row, matches nothing, and returns false.
 *
 * `<` and not `<=`, so a step is spendable exactly once. The trigger in
 * drizzle/0026 refuses a decrease independently, so a future rewrite of this
 * statement cannot quietly reintroduce replay.
 */
export async function markStepUsed(step: number): Promise<boolean> {
  if (!Number.isSafeInteger(step) || step < 0) return false;

  const [row] = await unsafeDb
    .update(adminTotp)
    .set({ lastUsedStep: step })
    .where(and(eq(adminTotp.id, ROW_ID), lt(adminTotp.lastUsedStep, step)))
    .returning({ lastUsedStep: adminTotp.lastUsedStep });

  return row !== undefined;
}

// -----------------------------------------------------------------------------
// Recovery
// -----------------------------------------------------------------------------

export type BurnResult =
  | { ok: true; remaining: number }
  | { ok: false; reason: "not_enrolled" | "incorrect" };

/**
 * Spend one recovery code.
 *
 * Removing the digest IS the spend, and it happens in the same statement that
 * checks the code exists — for the same reason `markStepUsed` is conditional.
 * A read-then-write here would let one code be presented twice at once, which
 * on the surface that replaces the second factor entirely is worth more care
 * than on the one that supplements it.
 *
 * SHA-256 and not scrypt, deliberately. These codes are ours: forty-nine bits from a
 * CSPRNG, not a human's choice, so there is no dictionary to run and the work
 * factor a password hash buys would protect nothing. What it would cost is this
 * statement — a KDF cannot be computed inside the UPDATE, so checking would
 * become a read, a hash, and then a write, which is precisely the race the
 * paragraph above rejects. Single-use is worth more here than a slow compare.
 */
export async function burnRecoveryCode(code: string): Promise<BurnResult> {
  const digest = digestRecoveryCode(code);

  const [row] = await unsafeDb
    .update(adminTotp)
    .set({
      recoveryCodeHashes: sql`array_remove(${adminTotp.recoveryCodeHashes}, ${digest})`,
    })
    .where(
      and(
        eq(adminTotp.id, ROW_ID),
        sql`${digest} = ANY(${adminTotp.recoveryCodeHashes})`,
      ),
    )
    // RETURNING sees the row as this statement left it, so cardinality here is
    // what is left AFTER the spend rather than before it.
    .returning({
      remaining: sql<number>`cardinality(${adminTotp.recoveryCodeHashes})`,
    });

  if (row) return { ok: true, remaining: Number(row.remaining) };

  // Whether the row exists at all is worth separating: "no second factor is
  // enrolled" and "that code is wrong" send the operator to completely
  // different places, and neither answer helps anybody who is guessing, because
  // guessing a forty-nine-bit code is not a thing that happens.
  const state = await getAdminTotpState();
  return {
    ok: false,
    reason: state.enrolled ? "incorrect" : "not_enrolled",
  };
}

// -----------------------------------------------------------------------------
// The arithmetic
// -----------------------------------------------------------------------------

/** RFC 6238's T: whole 30-second periods since the Unix epoch. */
function currentStep(at: Date = new Date()): number {
  return Math.floor(at.getTime() / 1000 / PERIOD_SECONDS);
}

/**
 * Which step in the drift window produced this code, or null.
 *
 * Every candidate is derived and compared, and the loop does not stop early on
 * a match: with three candidates the timing difference is measurable in
 * microseconds and reveals only WHICH of three adjacent steps matched, but the
 * cost of not leaking it is two HMACs, and a code path that returns as soon as
 * it is happy is the shape that gets copied into somewhere it matters.
 */
function matchStep(secret: Buffer, code: string, at: number): number | null {
  let matched: number | null = null;

  for (let offset = -DRIFT_STEPS; offset <= DRIFT_STEPS; offset += 1) {
    const step = at + offset;
    if (step < 0) continue;
    if (constantTimeEquals(deriveCode(secret, step), code)) matched = step;
  }

  return matched;
}

/**
 * HOTP, RFC 4226 §5.3, with the counter set to the time step.
 *
 * Read with `readUInt32BE`/`readUInt8` rather than by index: under
 * `noUncheckedIndexedAccess` every `hmac[i]` is `number | undefined`, and the
 * `!` needed to silence that is the assertion this project does not make. The
 * reads are bounds-checked at runtime and the offset is masked to 0-15, which
 * cannot exceed a 20-byte digest.
 */
function deriveCode(secret: Buffer, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));

  const digest = createHmac(ALGORITHM, secret).update(counter).digest();
  const offset = digest.readUInt8(digest.length - 1) & 0x0f;
  const truncated = digest.readUInt32BE(offset) & 0x7fff_ffff;

  return String(truncated % 10 ** DIGITS).padStart(DIGITS, "0");
}

/**
 * Compare two codes without letting the clock answer the question.
 *
 * A `===` on a six-digit string leaks, through its early exit, how many leading
 * digits were right. Six digits is a small enough space that the difference is
 * worth removing, and the removal costs one allocation.
 */
function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

// -----------------------------------------------------------------------------
// Recovery-code helpers
// -----------------------------------------------------------------------------

function generateRecoveryCode(): string {
  let code = "";
  for (let i = 0; i < RECOVERY_CODE_LENGTH; i += 1) {
    // randomInt is rejection-sampled by node, so a 30-symbol alphabet stays
    // uniform. A `randomBytes()[i] % 30` would not, and the bias would be
    // invisible in every test anyone would write for this.
    code += RECOVERY_ALPHABET[randomInt(RECOVERY_ALPHABET.length)] ?? "";
  }
  // Grouped for reading aloud and typing back. The grouping is cosmetic, and
  // normalise() removes it before anything is hashed or compared, so a code
  // typed without the dash still works.
  return `${code.slice(0, 5)}-${code.slice(5)}`;
}

/**
 * Digest the code as a person would have retyped it.
 *
 * Case and separators are stripped on BOTH sides — at enrolment and at
 * redemption — so the stored digest is of the canonical form. Without that, a
 * code written down in lower case is simply wrong, at the moment it is the only
 * way in.
 */
function digestRecoveryCode(code: string): string {
  const normalised = code.toUpperCase().replace(/[^0-9A-Z]/g, "");
  return createHash("sha256").update(normalised, "utf8").digest("hex");
}

// -----------------------------------------------------------------------------
// base32 (RFC 4648, no padding) — what authenticator apps read
// -----------------------------------------------------------------------------

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32Encode(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";

  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31] ?? "";
      bits -= 5;
    }
  }

  // The trailing partial group, left-aligned. No "=" padding: an otpauth URI
  // carries the secret in a query parameter, and a padded value round-trips
  // through some authenticators as part of the secret.
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31] ?? "";

  return out;
}

function isBase32(value: string): boolean {
  return /^[A-Z2-7]+$/.test(value) && value.length >= 16;
}

/** The bytes, or null if the string is not base32 of a plausible length. */
function base32Decode(value: string): Buffer | null {
  if (!isBase32(value)) return null;

  let bits = 0;
  let acc = 0;
  const out: number[] = [];

  for (const character of value) {
    const index = BASE32_ALPHABET.indexOf(character);
    if (index < 0) return null;
    acc = (acc << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((acc >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }

  return Buffer.from(out);
}
