import {
  createHash,
  createHmac,
  randomBytes,
  randomInt,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";

import { and, eq, isNull, lt, sql } from "drizzle-orm";

import { unsafeDb, type Queryable } from "@/db";
import { user } from "@/db/auth-schema";
import { userBackupCodes, userFactors } from "@/db/schema";
import { recordSecurityEvent } from "@/lib/audit";
import { open, seal, type CredentialIdentity } from "@/lib/crypto/envelope";
import { env } from "@/lib/env";
import { log } from "@/lib/log";
import { notifyDeviceChange } from "@/lib/notices/device-changes";

import { backupEnrolAllowed } from "./authority";
import { isUniqueViolationOn } from "./errors";
import { clearWrongCodes, LOCKOUT_MS, lockedUntil, recordWrongCode } from "./lockout";
import { findLiveStepUp } from "./step-ups";

/**
 * The authenticator-app backup (plan Part D3): an RFC 6238 secret and ten
 * backup codes. Its one power is to let a new device add its passkey when no
 * device with a passkey is at hand; patient pages open only after a passkey
 * step-up, never on a code.
 *
 * The arithmetic is node:crypto and nothing else, tested against the RFC's
 * own vectors. The secret is sealed with envelope.ts, bound to its row, and
 * exists in the clear only inside this file and in the QR code shown once at
 * enrolment. A code is spent by one conditional UPDATE of `last_step`, and
 * wrong codes are counted in the database (lockout.ts).
 *
 * The enrolment and backup-code screens are M3's, at the end of setup; the
 * functions they call are here. In production, sealing needs the KMS
 * production-build fix (CLAUDE.md): until then enrolment throws there rather
 * than fall back to a key in an environment variable.
 */

// -----------------------------------------------------------------------------
// The algorithm (RFC 4226 and RFC 6238)
// -----------------------------------------------------------------------------

export type TotpAlgorithm = "sha1" | "sha256" | "sha512";

/**
 * What every authenticator app assumes: SHA-1, six digits, thirty seconds.
 * SHA-1 is not a lapse here; HMAC-SHA-1 has no weakness that matters to a
 * thirty-second code, and Google Authenticator ignores an otpauth URI's
 * `algorithm` and derives with SHA-1 regardless, so anything else would scan
 * and then never match (lib/ops/admin-totp.ts makes the same choice).
 */
export const TOTP_DIGITS = 6;
export const TOTP_PERIOD_SECONDS = 30;
/** One step either side: a phone a little out of time still works, and a spent step stays spent. */
export const TOTP_DRIFT_STEPS = 1;
/** 160 bits, the size RFC 4226 recommends for HMAC-SHA-1. */
const SECRET_BYTES = 20;

/** HOTP (RFC 4226 §5.3): HMAC the 8-byte counter, truncate dynamically, keep `digits`. */
export function hotp(
  key: Buffer,
  counter: number,
  options: { digits?: number; algorithm?: TotpAlgorithm } = {},
): string {
  const digits = options.digits ?? TOTP_DIGITS;
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac(options.algorithm ?? "sha1", key)
    .update(message)
    .digest();
  // readUInt8/readUInt32BE rather than indexing: bounds-checked, and the
  // offset is masked to 0-15, inside even a 20-byte digest.
  const offset = digest.readUInt8(digest.length - 1) & 0x0f;
  const binary = digest.readUInt32BE(offset) & 0x7fff_ffff;
  return String(binary % 10 ** digits).padStart(digits, "0");
}

/** RFC 6238's T: whole periods since the Unix epoch. */
export function totpStep(at: Date): number {
  return Math.floor(at.getTime() / 1000 / TOTP_PERIOD_SECONDS);
}

/** The code for `at` (RFC 6238 with T0 = 0). */
export function totpAt(
  key: Buffer,
  at: Date,
  options: { digits?: number; algorithm?: TotpAlgorithm } = {},
): string {
  return hotp(key, totpStep(at), options);
}

/**
 * Which step in the drift window produced `code`, or null. Every candidate is
 * derived and compared in constant time, with no early exit, so the timing
 * does not say which neighbour matched.
 */
export function matchTotpStep(key: Buffer, code: string, step: number): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  let matched: number | null = null;
  for (let offset = -TOTP_DRIFT_STEPS; offset <= TOTP_DRIFT_STEPS; offset += 1) {
    const candidate = step + offset;
    if (candidate < 0) continue;
    if (constantTimeEqual(hotp(key, candidate), code)) matched = candidate;
  }
  return matched;
}

function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
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
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31] ?? "";
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31] ?? "";
  return out;
}

/** The bytes, or null when the string is not unpadded base32 of a usable length. */
export function base32Decode(value: string): Buffer | null {
  if (!/^[A-Z2-7]{16,}$/.test(value)) return null;
  let bits = 0;
  let acc = 0;
  const out: number[] = [];
  for (const character of value) {
    acc = (acc << 5) | BASE32_ALPHABET.indexOf(character);
    bits += 5;
    if (bits >= 8) {
      out.push((acc >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/**
 * The otpauth URI an authenticator app scans. The label is encoded as a path
 * segment, not a query value, so a space never turns into a literal "+".
 */
export function totpEnrolmentUri(secret: string, accountName: string): string {
  const issuer = "healdesk";
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: "SHA1",
    digits: String(TOTP_DIGITS),
    period: String(TOTP_PERIOD_SECONDS),
  });
  return `otpauth://totp/${encodeURIComponent(`${issuer}:${accountName}`)}?${params.toString()}`;
}

// -----------------------------------------------------------------------------
// Enrolment: propose (stores nothing), then enrol with a code from it
// -----------------------------------------------------------------------------

/**
 * Long enough to install an authenticator app, short enough that a proposal
 * left in a tab is not a standing offer.
 */
const PROPOSAL_TTL_MS = 15 * 60 * 1000;
const PROPOSAL_DOMAIN = "healdesk.portal-totp.enrolment.v1";

/**
 * Proposals are signed with a subkey of BETTER_AUTH_SECRET, never the secret
 * itself, so this message can never be mistaken for a cookie Better Auth
 * signed, or the other way round.
 */
function proposalKey(): Buffer {
  const secret = env.betterAuthSecret();
  if (!secret) {
    throw new Error("BETTER_AUTH_SECRET is not set, so an enrolment proposal cannot be signed.");
  }
  return createHmac("sha256", secret).update(PROPOSAL_DOMAIN).digest();
}

export type TotpProposal = {
  /** base32, for typing in by hand. Shown once, never stored or logged. */
  secret: string;
  /** The QR code's payload. Contains the secret. */
  otpauthUri: string;
  /** Opaque, and what `enrolTotp` takes back. Contains the secret: one enrolment only. */
  proposal: string;
  expiresInMs: number;
};

/**
 * A candidate secret for this sign-in, signed and stored nowhere. Nothing is
 * written until a code from it comes back, so an enrolment abandoned halfway
 * (a closed tab, a mistyped secret) leaves no factor the clinic cannot use.
 */
export function proposeTotp(account: { userId: string; email: string }): TotpProposal {
  const secret = base32Encode(randomBytes(SECRET_BYTES));
  const body = Buffer.from(
    JSON.stringify({ u: account.userId, s: secret, t: Date.now() }),
    "utf8",
  ).toString("base64url");
  return {
    secret,
    otpauthUri: totpEnrolmentUri(secret, account.email),
    proposal: `${body}.${createHmac("sha256", proposalKey()).update(body).digest("base64url")}`,
    expiresInMs: PROPOSAL_TTL_MS,
  };
}

/** The secret a proposal carries, if it is ours, this sign-in's and fresh. */
function openProposal(proposal: unknown, userId: string): string | null {
  if (typeof proposal !== "string" || proposal.length > 1024) return null;
  const dot = proposal.indexOf(".");
  if (dot <= 0) return null;
  const body = proposal.slice(0, dot);
  const received = Buffer.from(proposal.slice(dot + 1), "utf8");
  const expected = Buffer.from(
    createHmac("sha256", proposalKey()).update(body).digest("base64url"),
    "utf8",
  );
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  const { u, s, t } = (parsed ?? {}) as { u?: unknown; s?: unknown; t?: unknown };
  if (u !== userId || typeof s !== "string" || typeof t !== "number") return null;
  const age = Date.now() - t;
  if (age < 0 || age > PROPOSAL_TTL_MS) return null;
  return base32Decode(s) ? s : null;
}

/**
 * The AAD for a sealed secret: this sign-in and this row. A ciphertext
 * copied into another row, or another sign-in's, fails to open.
 */
function secretIdentity(userId: string, factorId: string): CredentialIdentity {
  return { clinicId: `user:${userId}`, credentialId: `user_factors:${factorId}` };
}

export type RequestMeta = { ipAddress?: string | null; userAgent?: string | null };

export type EnrolTotpResult =
  | { ok: true; factorId: string; backupCodes: string[] }
  | {
      ok: false;
      reason: "needs_step_up" | "proposal_expired" | "code_incorrect" | "already_enrolled";
    };

/**
 * Enrol the proposed secret if a code from it is right, with a fresh set of
 * backup codes, returned exactly once.
 *
 * Allowed under a passkey step-up on this session, or while the sign-in has
 * no factor and none of its clinics is live (authority.ts). The step the code
 * came from is recorded as spent, so the code that enrolled cannot then add a
 * device. A sign-in has at most one active secret (a partial unique index):
 * replacing it is "Someone left"'s reset, under step-up, in M3.
 */
export async function enrolTotp(input: {
  userId: string;
  sessionTokenHash: Buffer;
  proposal: string;
  code: string;
  request?: RequestMeta;
  at?: Date;
}): Promise<EnrolTotpResult> {
  if (!(await backupEnrolAllowed(input.userId, input.sessionTokenHash))) {
    return { ok: false, reason: "needs_step_up" };
  }
  const secret = openProposal(input.proposal, input.userId);
  const key = secret ? base32Decode(secret) : null;
  if (!secret || !key) return { ok: false, reason: "proposal_expired" };
  const step = matchTotpStep(key, normaliseCode(input.code), totpStep(input.at ?? new Date()));
  if (step === null) return { ok: false, reason: "code_incorrect" };

  const factorId = randomUUID();
  const sealed = await seal(secret, secretIdentity(input.userId, factorId));
  const codes = newBackupCodeSet();
  try {
    await unsafeDb.transaction(async (tx) => {
      await tx.insert(userFactors).values({
        id: factorId,
        userId: input.userId,
        kind: "totp",
        secretSealed: sealed,
        lastStep: step,
      });
      await replaceBackupCodes(tx, input.userId, codes);
      const actorLabel = await actorLabelFor(tx, input.userId);
      await recordSecurityEvent(tx, {
        event: "totp_enrolled",
        actorLabel,
        userId: input.userId,
        ipAddress: input.request?.ipAddress ?? null,
        userAgent: input.request?.userAgent ?? null,
        metadata: { factorId },
      });
      await recordSecurityEvent(tx, {
        event: "backup_codes_generated",
        actorLabel,
        userId: input.userId,
        ipAddress: input.request?.ipAddress ?? null,
        userAgent: input.request?.userAgent ?? null,
        metadata: { count: codes.length, source: "totp_enrolment" },
      });
    });
  } catch (error) {
    if (isUniqueViolationOn(error, ["user_factors_one_totp_idx"])) {
      return { ok: false, reason: "already_enrolled" };
    }
    throw error;
  }
  return { ok: true, factorId, backupCodes: codes };
}

// -----------------------------------------------------------------------------
// Backup codes
// -----------------------------------------------------------------------------

/**
 * Ten codes, ten characters of a 30-symbol alphabet each (49 bits): no I, L,
 * O, U, 0 or 1, because they are written on paper and read back under stress.
 */
const BACKUP_ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ";
export const BACKUP_CODE_COUNT = 10;
const BACKUP_CODE_LENGTH = 10;

function newBackupCode(): string {
  let code = "";
  for (let i = 0; i < BACKUP_CODE_LENGTH; i += 1) {
    // randomInt is rejection-sampled, so the alphabet stays uniform.
    code += BACKUP_ALPHABET[randomInt(BACKUP_ALPHABET.length)] ?? "";
  }
  return `${code.slice(0, 5)}-${code.slice(5)}`;
}

function newBackupCodeSet(): string[] {
  const codes = new Set<string>();
  while (codes.size < BACKUP_CODE_COUNT) codes.add(newBackupCode());
  return [...codes];
}

/** A code as typed: case, spaces and dashes do not matter. */
export function normaliseBackupCode(raw: string): string {
  return raw.toUpperCase().replace(/[^0-9A-Z]/g, "");
}

/**
 * SHA-256 of the normalised code. Not a slow hash, deliberately: these are 49
 * random bits, not a person's choice, so there is no dictionary to slow down,
 * and a plain digest lets the spend be one conditional UPDATE instead of a
 * read, a hash and a write that two submissions could race.
 */
export function hashBackupCode(raw: string): Buffer {
  return createHash("sha256").update(normaliseBackupCode(raw), "utf8").digest();
}

/** Revoke the unspent codes of the old set and store the new one's digests. */
async function replaceBackupCodes(
  db: Queryable,
  userId: string,
  codes: readonly string[],
): Promise<void> {
  await db
    .update(userBackupCodes)
    .set({ revokedAt: sql`now()` })
    .where(
      and(
        eq(userBackupCodes.userId, userId),
        isNull(userBackupCodes.usedAt),
        isNull(userBackupCodes.revokedAt),
      ),
    );
  await db
    .insert(userBackupCodes)
    .values(codes.map((code) => ({ userId, codeHash: hashBackupCode(code) })));
}

export type RegenerateResult =
  { ok: true; backupCodes: string[] } | { ok: false; reason: "needs_step_up" };

/**
 * A new set of ten, shown once; the old set's unspent codes stop working in
 * the same transaction. Needs a passkey step-up on this session, because a
 * backup code can add a device.
 */
export async function regenerateBackupCodes(input: {
  userId: string;
  sessionTokenHash: Buffer;
  request?: RequestMeta;
}): Promise<RegenerateResult> {
  const codes = newBackupCodeSet();
  const done = await unsafeDb.transaction(async (tx) => {
    const stepUp = await findLiveStepUp(
      tx,
      { sessionTokenHash: input.sessionTokenHash, userId: input.userId },
      { touch: true },
    );
    if (!stepUp) return false;
    await replaceBackupCodes(tx, input.userId, codes);
    await recordSecurityEvent(tx, {
      event: "backup_codes_generated",
      actorLabel: await actorLabelFor(tx, input.userId),
      userId: input.userId,
      ipAddress: input.request?.ipAddress ?? null,
      userAgent: input.request?.userAgent ?? null,
      metadata: { count: codes.length, viaFactorId: stepUp.factorId },
    });
    return true;
  });
  return done ? { ok: true, backupCodes: codes } : { ok: false, reason: "needs_step_up" };
}

// -----------------------------------------------------------------------------
// Checking a typed code
// -----------------------------------------------------------------------------

export type CodeCheck =
  | { ok: true; method: "totp" | "backup_code" }
  | { ok: false; reason: "locked"; lockedUntil: Date }
  | { ok: false; reason: "incorrect" };

/** Spaces and dashes out; what is left decides whether it is a TOTP code or a backup code. */
function normaliseCode(raw: unknown): string {
  return typeof raw === "string" ? raw.replace(/[\s-]/g, "").slice(0, 64) : "";
}

/**
 * Check a code from the authenticator app or the backup list, and spend it.
 *
 * Refused unread while the sign-in is locked. Every other failure (a wrong
 * code, a spent one, a sign-in with no backup at all) counts towards the
 * lock, and says only "incorrect": a caller guessing learns nothing from the
 * difference. The fifth in fifteen minutes locks code entry for fifteen
 * minutes, records a security event and asks for the O3 email. A right code
 * clears the count.
 */
export async function checkSecondFactorCode(
  userId: string,
  raw: unknown,
  request?: RequestMeta,
  at: Date = new Date(),
): Promise<CodeCheck> {
  const locked = await lockedUntil(userId);
  if (locked) return { ok: false, reason: "locked", lockedUntil: locked };

  const code = normaliseCode(raw);
  let method: "totp" | "backup_code" | null = null;
  if (/^\d{6}$/.test(code)) {
    if (await spendTotpCode(userId, code, at)) method = "totp";
  } else if (normaliseBackupCode(code).length === BACKUP_CODE_LENGTH) {
    if (await spendBackupCode(userId, code)) method = "backup_code";
  }

  if (method) {
    await clearWrongCodes(userId);
    return { ok: true, method };
  }

  const counted = await recordWrongCode(userId);
  if (counted.justLocked && counted.lockedUntil) {
    await recordSecurityEvent(unsafeDb, {
      event: "factor_locked_out",
      actorLabel: await actorLabelFor(unsafeDb, userId),
      userId,
      ipAddress: request?.ipAddress ?? null,
      userAgent: request?.userAgent ?? null,
      // Minutes, not the lock's end: an ISO date reads as a phone number to
      // assertNoPhi, and the event's own time says when it began.
      metadata: { lockedForMinutes: LOCKOUT_MS / 60_000 },
    });
    await notifyDeviceChange({ userId, kind: "locked" });
    return { ok: false, reason: "locked", lockedUntil: counted.lockedUntil };
  }
  return { ok: false, reason: "incorrect" };
}

/**
 * Check a six-digit code against the sign-in's secret and spend its step: a
 * conditional UPDATE that only a step above `last_step` passes, so a code is
 * good once, and two submissions of one code cannot both win.
 */
async function spendTotpCode(userId: string, code: string, at: Date): Promise<boolean> {
  const [row] = await unsafeDb
    .select({ id: userFactors.id, sealed: userFactors.secretSealed })
    .from(userFactors)
    .where(
      and(
        eq(userFactors.userId, userId),
        eq(userFactors.kind, "totp"),
        isNull(userFactors.revokedAt),
      ),
    )
    .limit(1);
  if (!row?.sealed) return false;

  let secret: string;
  try {
    secret = await open(row.sealed, secretIdentity(userId, row.id));
  } catch (error) {
    // The row or the key changed under us. Never the ciphertext or the error's
    // cause, which carries the underlying crypto error.
    log.error("totp secret could not be opened", {
      error: error instanceof Error ? error.name : "unknown error",
    });
    return false;
  }
  const key = base32Decode(secret);
  if (!key) return false;
  const step = matchTotpStep(key, code, totpStep(at));
  if (step === null) return false;

  const spent = await unsafeDb
    .update(userFactors)
    .set({ lastStep: step, lastUsedAt: sql`now()` })
    .where(
      and(
        eq(userFactors.id, row.id),
        isNull(userFactors.revokedAt),
        lt(userFactors.lastStep, step),
      ),
    )
    .returning({ id: userFactors.id });
  return spent.length > 0;
}

/** Spend one backup code: one conditional UPDATE, so a code works once however it is raced. */
async function spendBackupCode(userId: string, code: string): Promise<boolean> {
  const spent = await unsafeDb
    .update(userBackupCodes)
    .set({ usedAt: sql`now()` })
    .where(
      and(
        eq(userBackupCodes.userId, userId),
        eq(userBackupCodes.codeHash, hashBackupCode(code)),
        isNull(userBackupCodes.usedAt),
        isNull(userBackupCodes.revokedAt),
      ),
    )
    .returning({ id: userBackupCodes.id });
  return spent.length > 0;
}

// -----------------------------------------------------------------------------

/** The sign-in's address, the actor label every identity-plane event carries. */
export async function actorLabelFor(db: Queryable, userId: string): Promise<string> {
  const [row] = await db
    .select({ email: user.email })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1);
  return row?.email ?? userId;
}
