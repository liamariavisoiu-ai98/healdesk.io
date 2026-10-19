import { createHash } from "node:crypto";

import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { and, count, eq, gt, isNull, sql } from "drizzle-orm";

import { unsafeDb, type Queryable } from "@/db";
import {
  userFactors,
  webauthnChallenges,
  type PasskeyEnrolBasis,
  type WebauthnChallengePurpose,
} from "@/db/schema";
import { recordSecurityEvent } from "@/lib/audit";
import { describeError, log } from "@/lib/log";
import { notifyDeviceChange } from "@/lib/notices/device-changes";
import { publicOrigin } from "@/lib/public-url";

import {
  activeFactors,
  anyClinicMayHoldPatientData,
  neverHadPasskey,
  passkeyEnrolDecision,
} from "./authority";
import { validateDeviceLabel } from "./device";
import { isUniqueViolationOn } from "./errors";
import { spendDeviceRecovery } from "./recovery";
import { endStepUps, findLiveStepUp, recordStepUp, type LiveStepUp } from "./step-ups";
import { actorLabelFor, checkSecondFactorCode, type RequestMeta } from "./totp";

/**
 * Passkeys, one per device, for the clinic's one shared sign-in (plan Part
 * D3). Our own ceremony around @simplewebauthn/server rather than Better
 * Auth's passkey plugin: the plugin's verify endpoints start a session, which
 * would be a second way in beside the single-use link, and do not require
 * user verification. Here a passkey never signs anyone in. It proves, on top
 * of a session a link started, that someone who can unlock this device is
 * present, and that proof (a step-up, step-ups.ts) is what patient pages ask
 * for.
 *
 * - **User verification is required** in the options and in verification, and
 *   checked again on the result: Face ID, Touch ID, the screen lock or a
 *   key's PIN, never a bare tap.
 * - **The relying party is `publicOrigin()`**, BETTER_AUTH_URL: its host is
 *   the RP ID and its origin the only one accepted.
 * - **Challenges are single-use**, consumed by a conditional UPDATE before the
 *   response is verified, bound to the session that asked, and good for five
 *   minutes.
 * - **The signature counter only moves forward**: the library refuses a
 *   regression, this file refuses it again on the verified result, the UPDATE
 *   that stores the new counter is conditional on it, and a trigger refuses a
 *   decrease. A cloned authenticator shows up as a counter going backwards.
 * - **A revoked passkey is refused**, and removing one ends its step-ups and
 *   the sessions that stepped up with it.
 *
 * Nothing here logs or stores a raw WebAuthn response; only the credential id,
 * public key, counter, transports and backup flag are kept.
 */

const RP_NAME = "healdesk";
/** How long the browser waits for the person; scanning the cross-device QR takes a while. */
const CEREMONY_TIMEOUT_MS = 2 * 60 * 1000;
/** Matches the CHECK on webauthn_challenges. */
const CHALLENGE_TTL_MS = 5 * 60 * 1000;
/** Unexpired, unspent challenges one sign-in may hold before minting stops. */
const MAX_OPEN_CHALLENGES = 20;
/**
 * ES256, EdDSA and RS256, pinned. The library's default adds ML-DSA-44 when
 * the runtime supports it, and a passkey made that way on one Node version
 * would be unverifiable after a move to one without it.
 */
const SUPPORTED_ALGORITHMS = [-7, -8, -257];
const CHALLENGE_SHAPE = /^[A-Za-z0-9_-]{16,128}$/;

/** The session a ceremony belongs to: its sign-in and SHA-256 of its Better Auth token. */
export type SessionBinding = { userId: string; sessionTokenHash: Buffer };

function relyingParty(): { rpID: string; origin: string } {
  const url = new URL(publicOrigin());
  return { rpID: url.hostname, origin: url.origin };
}

/**
 * The WebAuthn user handle: opaque, stable per sign-in, and not our user id,
 * which an authenticator's sync service has no need to learn. Every passkey of
 * one sign-in shares it, as the spec intends.
 */
function userHandle(userId: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(
    createHash("sha256").update(`healdesk.webauthn.user.v1|${userId}`).digest(),
  );
}

type ActivePasskey = { id: string; credentialId: string; transports: string[] | null };

async function activePasskeys(db: Queryable, userId: string): Promise<ActivePasskey[]> {
  const rows = await db
    .select({
      id: userFactors.id,
      credentialId: userFactors.credentialId,
      transports: userFactors.transports,
    })
    .from(userFactors)
    .where(
      and(
        eq(userFactors.userId, userId),
        eq(userFactors.kind, "passkey"),
        isNull(userFactors.revokedAt),
      ),
    );
  return rows.flatMap((r) =>
    r.credentialId ? [{ id: r.id, credentialId: r.credentialId, transports: r.transports }] : [],
  );
}

/** Store a challenge, unless the sign-in already holds too many open ones. */
async function storeChallenge(input: {
  session: SessionBinding;
  purpose: WebauthnChallengePurpose;
  challenge: string;
  enrolBasis: PasskeyEnrolBasis | null;
}): Promise<boolean> {
  const [open] = await unsafeDb
    .select({ n: count() })
    .from(webauthnChallenges)
    .where(
      and(
        eq(webauthnChallenges.userId, input.session.userId),
        isNull(webauthnChallenges.usedAt),
        gt(webauthnChallenges.expiresAt, sql`now()`),
      ),
    );
  if (Number(open?.n ?? 0) >= MAX_OPEN_CHALLENGES) return false;
  await unsafeDb.insert(webauthnChallenges).values({
    userId: input.session.userId,
    sessionTokenHash: input.session.sessionTokenHash,
    purpose: input.purpose,
    challenge: input.challenge,
    enrolBasis: input.enrolBasis,
    expiresAt: sql`now() + ${CHALLENGE_TTL_MS} * interval '1 millisecond'`,
  });
  return true;
}

/**
 * The challenge a response says it answers, read from its clientDataJSON only
 * to find our row. The library parses it again and compares it for real.
 */
function challengeOf(response: { response: { clientDataJSON: string } }): string | null {
  const encoded = response.response.clientDataJSON;
  if (encoded.length > 8192) return null;
  try {
    const parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as {
      challenge?: unknown;
    };
    return typeof parsed.challenge === "string" && CHALLENGE_SHAPE.test(parsed.challenge)
      ? parsed.challenge
      : null;
  } catch {
    return null;
  }
}

/**
 * Spend the challenge: one conditional UPDATE, so of two submissions of one
 * response exactly one goes on to verification, and a challenge from another
 * session, another sign-in or another purpose, or one past its five minutes,
 * matches nothing.
 */
async function consumeChallenge(input: {
  session: SessionBinding;
  purpose: WebauthnChallengePurpose;
  challenge: string;
}): Promise<{ enrolBasis: PasskeyEnrolBasis | null } | null> {
  const [row] = await unsafeDb
    .update(webauthnChallenges)
    .set({ usedAt: sql`now()` })
    .where(
      and(
        eq(webauthnChallenges.challenge, input.challenge),
        eq(webauthnChallenges.userId, input.session.userId),
        eq(webauthnChallenges.sessionTokenHash, input.session.sessionTokenHash),
        eq(webauthnChallenges.purpose, input.purpose),
        isNull(webauthnChallenges.usedAt),
        gt(webauthnChallenges.expiresAt, sql`now()`),
      ),
    )
    .returning({ enrolBasis: webauthnChallenges.enrolBasis });
  return row ?? null;
}

/** The fields a ceremony needs, checked for type before anything reads them. */
function isResponseShaped(value: unknown, fields: readonly string[]): boolean {
  if (typeof value !== "object" || value === null) return false;
  const v = value as { id?: unknown; rawId?: unknown; type?: unknown; response?: unknown };
  if (typeof v.id !== "string" || typeof v.rawId !== "string" || v.type !== "public-key") {
    return false;
  }
  if (v.id.length > 2048 || typeof v.response !== "object" || v.response === null) return false;
  const inner = v.response as Record<string, unknown>;
  return fields.every((f) => typeof inner[f] === "string");
}

class Refused extends Error {
  constructor(readonly reason: "needs_step_up" | "counter") {
    super(reason);
  }
}

// -----------------------------------------------------------------------------
// Adding a device
// -----------------------------------------------------------------------------

export type RegistrationStart =
  | { ok: true; options: PublicKeyCredentialCreationOptionsJSON; basis: PasskeyEnrolBasis }
  | {
      ok: false;
      /**
       * `needs_step_up`: another device's passkey (or a code) unlocks it.
       * `no_device`: the sign-in has no passkey to step up with, so only a
       * code from the backup or the human route can.
       */
      reason: "needs_step_up" | "no_device" | "code_incorrect" | "code_locked" | "too_many_attempts";
    };

/**
 * Options for adding this device's passkey, once this session may (authority.ts):
 * the sign-in's first passkey before go-live, a live step-up on this session,
 * this session's claim on the human route's link, the paying browser's first
 * enrolment, or `code`, from the authenticator app or the backup list, which
 * is checked and spent here, before the browser makes a credential, so a
 * wrong code never leaves an orphaned passkey on the device. The basis is
 * stored with the challenge and checked again when the passkey comes back.
 *
 * authenticatorAttachment is left unset, so the browser offers "Use a phone or
 * tablet" (the cross-device QR flow) beside this device's own unlock; the
 * passkeys the sign-in already has are excluded, so one device is not added
 * twice.
 */
export async function startPasskeyRegistration(input: {
  session: SessionBinding;
  code?: string | null;
  request?: RequestMeta;
  /** This is the browser that paid, within its window (lib/sign-in/paying-browser.ts). */
  payingBrowser?: boolean;
}): Promise<RegistrationStart> {
  const { userId, sessionTokenHash } = input.session;
  const decision = await passkeyEnrolDecision(userId, sessionTokenHash, unsafeDb, {
    payingBrowser: input.payingBrowser === true,
  });
  let basis: PasskeyEnrolBasis;
  if (decision.allowed) {
    basis = decision.basis;
  } else if (input.code) {
    const checked = await checkSecondFactorCode(userId, input.code, input.request);
    if (!checked.ok) {
      return { ok: false, reason: checked.reason === "locked" ? "code_locked" : "code_incorrect" };
    }
    basis = "code";
  } else {
    return { ok: false, reason: decision.hasPasskey ? "needs_step_up" : "no_device" };
  }

  const { rpID } = relyingParty();
  const email = await actorLabelFor(unsafeDb, userId);
  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID,
    userName: email,
    userDisplayName: email,
    userID: userHandle(userId),
    timeout: CEREMONY_TIMEOUT_MS,
    attestationType: "none",
    excludeCredentials: (await activePasskeys(unsafeDb, userId)).map((p) => ({
      id: p.credentialId,
      transports: p.transports ?? undefined,
    })),
    authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
    supportedAlgorithmIDs: SUPPORTED_ALGORITHMS,
  });
  const stored = await storeChallenge({
    session: input.session,
    purpose: "register",
    challenge: options.challenge,
    enrolBasis: basis,
  });
  if (!stored) return { ok: false, reason: "too_many_attempts" };
  return { ok: true, options, basis };
}

export type RegistrationFinish =
  | { ok: true; factorId: string; deviceLabel: string; stepUp: LiveStepUp }
  | {
      ok: false;
      reason:
        "label_invalid" | "challenge" | "not_verified" | "needs_step_up" | "already_registered";
    };

/**
 * Store the device's passkey under the name the person gave it, and step this
 * session up with it at once: making it took the same unlock a step-up does.
 *
 * Under a per-sign-in advisory lock, the basis the challenge was issued on is
 * checked again: "first passkey" holds only while there is still none and
 * nothing is live (two browsers racing cannot both add a "first"), a step-up
 * must still be live, the paying browser's first enrolment holds only while
 * the sign-in has never had a passkey and this is still that browser, and
 * the human route's link is spent on this passkey in the same transaction,
 * once. A code was spent when the options were issued; the single-use,
 * session-bound challenge carries it.
 */
export async function finishPasskeyRegistration(input: {
  session: SessionBinding;
  response: unknown;
  deviceLabel: unknown;
  request?: RequestMeta;
  /**
   * This is the browser that paid, within its window (lib/sign-in/
   * paying-browser.ts): its first passkey is the only addition that sends no
   * device email (O3), and the paying-browser basis holds only while it is.
   */
  payingBrowser?: boolean;
}): Promise<RegistrationFinish> {
  const { userId, sessionTokenHash } = input.session;
  const label = validateDeviceLabel(input.deviceLabel);
  if (!label.ok) return { ok: false, reason: "label_invalid" };
  if (!isResponseShaped(input.response, ["clientDataJSON", "attestationObject"])) {
    return { ok: false, reason: "not_verified" };
  }
  const response = input.response as RegistrationResponseJSON;
  const challenge = challengeOf(response);
  const consumed = challenge
    ? await consumeChallenge({ session: input.session, purpose: "register", challenge })
    : null;
  if (!challenge || !consumed?.enrolBasis) return { ok: false, reason: "challenge" };
  const basis = consumed.enrolBasis;

  const { rpID, origin } = relyingParty();
  let verification: Awaited<ReturnType<typeof verifyRegistrationResponse>>;
  try {
    verification = await verifyRegistrationResponse({
      response,
      expectedChallenge: challenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      requireUserPresence: true,
      requireUserVerification: true,
      supportedAlgorithmIDs: SUPPORTED_ALGORITHMS,
    });
  } catch (error) {
    log.warn("passkey registration refused", { reason: describeError(error) });
    return { ok: false, reason: "not_verified" };
  }
  if (!verification.verified || !verification.registrationInfo.userVerified) {
    return { ok: false, reason: "not_verified" };
  }
  const { credential, credentialBackedUp } = verification.registrationInfo;

  let first = false;
  let recoveryId: string | null = null;
  let result: RegistrationFinish;
  try {
    result = await unsafeDb.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`user_factors:${userId}`}, 0))`,
      );
      if (basis === "first_passkey") {
        const factors = await activeFactors(userId, tx);
        if (factors.passkeys > 0 || (await anyClinicMayHoldPatientData(userId))) {
          throw new Refused("needs_step_up");
        }
        first = true;
      } else if (basis === "step_up") {
        if (!(await findLiveStepUp(tx, { sessionTokenHash, userId }, { touch: true }))) {
          throw new Refused("needs_step_up");
        }
      } else if (basis === "paying_browser") {
        if (input.payingBrowser !== true || !(await neverHadPasskey(userId, tx))) {
          throw new Refused("needs_step_up");
        }
        first = true;
      }

      const [factor] = await tx
        .insert(userFactors)
        .values({
          userId,
          kind: "passkey",
          deviceLabel: label.label,
          credentialId: credential.id,
          publicKey: Buffer.from(credential.publicKey),
          counter: credential.counter,
          transports: credential.transports?.length ? credential.transports : null,
          backedUp: credentialBackedUp,
        })
        .returning({ id: userFactors.id });
      if (!factor) throw new Error("The passkey was not stored.");
      if (basis === "recovery") {
        // Spent on this passkey, or the passkey goes: the link adds one device.
        recoveryId = await spendDeviceRecovery(tx, input.session, factor.id);
        if (!recoveryId) throw new Refused("needs_step_up");
      }

      const stepUp = await recordStepUp(tx, {
        sessionTokenHash,
        userId,
        factorId: factor.id,
        deviceLabel: label.label,
      });
      const actorLabel = await actorLabelFor(tx, userId);
      const meta = {
        ipAddress: input.request?.ipAddress ?? null,
        userAgent: input.request?.userAgent ?? null,
      };
      await recordSecurityEvent(tx, {
        event: "passkey_added",
        actorLabel,
        userId,
        ...meta,
        metadata: {
          factorId: factor.id,
          basis,
          backedUp: credentialBackedUp,
          ...(recoveryId ? { recoveryId } : {}),
        },
      });
      if (recoveryId) {
        await recordSecurityEvent(tx, {
          event: "device_recovery_used",
          actorLabel,
          userId,
          ...meta,
          metadata: { recoveryId, factorId: factor.id },
        });
      }
      await recordSecurityEvent(tx, {
        event: "step_up_granted",
        actorLabel,
        userId,
        ...meta,
        metadata: { factorId: factor.id, stepUpId: stepUp.id, via: "registration" },
      });
      return { ok: true as const, factorId: factor.id, deviceLabel: label.label, stepUp };
    });
  } catch (error) {
    if (error instanceof Refused) return { ok: false, reason: "needs_step_up" };
    if (isUniqueViolationOn(error, ["user_factors_credential_id_idx"])) {
      return { ok: false, reason: "already_registered" };
    }
    throw error;
  }
  if (result.ok) {
    await notifyDeviceChange({
      userId,
      kind: "added",
      factorId: result.factorId,
      first,
      payingBrowser: input.payingBrowser === true,
      // The human route's addition is always told, and told as that (O3).
      ...(basis === "recovery" ? { source: "recovery" as const } : {}),
    });
  }
  return result;
}

// -----------------------------------------------------------------------------
// Stepping up
// -----------------------------------------------------------------------------

export type AuthenticationStart =
  | { ok: true; options: PublicKeyCredentialRequestOptionsJSON }
  | { ok: false; reason: "no_passkey" | "too_many_attempts" };

/**
 * Options for a step-up: any of the sign-in's passkeys, user verification
 * required. A phone's passkey works from a computer through the browser's
 * "Use a phone or tablet" QR flow.
 */
export async function startPasskeyAuthentication(input: {
  session: SessionBinding;
}): Promise<AuthenticationStart> {
  const passkeys = await activePasskeys(unsafeDb, input.session.userId);
  if (passkeys.length === 0) return { ok: false, reason: "no_passkey" };
  const options = await generateAuthenticationOptions({
    rpID: relyingParty().rpID,
    allowCredentials: passkeys.map((p) => ({
      id: p.credentialId,
      transports: p.transports ?? undefined,
    })),
    userVerification: "required",
    timeout: CEREMONY_TIMEOUT_MS,
  });
  const stored = await storeChallenge({
    session: input.session,
    purpose: "authenticate",
    challenge: options.challenge,
    enrolBasis: null,
  });
  return stored ? { ok: true, options } : { ok: false, reason: "too_many_attempts" };
}

export type AuthenticationFinish =
  | { ok: true; stepUp: LiveStepUp }
  | {
      ok: false;
      reason: "challenge" | "unknown_credential" | "revoked" | "not_verified" | "counter";
    };

/**
 * Verify a step-up assertion and record the step-up for this session.
 *
 * The credential must be one of this sign-in's passkeys and not revoked; the
 * assertion must carry user verification; and its counter must move forward
 * unless the authenticator keeps none (both zero, as synced passkeys do). The
 * counter and `last_used_at` move in the same transaction as the step-up is
 * recorded, by an UPDATE that a revoked passkey or a counter that has moved
 * on meanwhile does not match.
 */
export async function finishPasskeyAuthentication(input: {
  session: SessionBinding;
  response: unknown;
  request?: RequestMeta;
}): Promise<AuthenticationFinish> {
  const { userId, sessionTokenHash } = input.session;
  if (!isResponseShaped(input.response, ["clientDataJSON", "authenticatorData", "signature"])) {
    return { ok: false, reason: "not_verified" };
  }
  const response = input.response as AuthenticationResponseJSON;
  const challenge = challengeOf(response);
  if (
    !challenge ||
    !(await consumeChallenge({ session: input.session, purpose: "authenticate", challenge }))
  ) {
    return { ok: false, reason: "challenge" };
  }

  const [factor] = await unsafeDb
    .select({
      id: userFactors.id,
      credentialId: userFactors.credentialId,
      publicKey: userFactors.publicKey,
      counter: userFactors.counter,
      transports: userFactors.transports,
      deviceLabel: userFactors.deviceLabel,
      revokedAt: userFactors.revokedAt,
    })
    .from(userFactors)
    .where(
      and(
        eq(userFactors.credentialId, response.id),
        eq(userFactors.userId, userId),
        eq(userFactors.kind, "passkey"),
      ),
    )
    .limit(1);
  if (
    !factor?.credentialId ||
    !factor.publicKey ||
    factor.counter === null ||
    !factor.deviceLabel
  ) {
    return { ok: false, reason: "unknown_credential" };
  }
  if (factor.revokedAt) return { ok: false, reason: "revoked" };

  const { rpID, origin } = relyingParty();
  let verification: Awaited<ReturnType<typeof verifyAuthenticationResponse>>;
  try {
    verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge: challenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      credential: {
        id: factor.credentialId,
        publicKey: Uint8Array.from(factor.publicKey),
        counter: factor.counter,
        transports: factor.transports ?? undefined,
      },
      requireUserVerification: true,
    });
  } catch (error) {
    log.warn("passkey step-up refused", { reason: describeError(error) });
    return { ok: false, reason: "not_verified" };
  }
  if (!verification.verified || !verification.authenticationInfo.userVerified) {
    return { ok: false, reason: "not_verified" };
  }

  // The library's rule, held again here on the verified result: a counter
  // that does not move forward, when either side has ever counted, is a copy.
  const newCounter = verification.authenticationInfo.newCounter;
  if ((newCounter > 0 || factor.counter > 0) && newCounter <= factor.counter) {
    return { ok: false, reason: "counter" };
  }

  const deviceLabel = factor.deviceLabel;
  try {
    const stepUp = await unsafeDb.transaction(async (tx) => {
      const moved = await tx
        .update(userFactors)
        .set({ counter: newCounter, lastUsedAt: sql`now()` })
        .where(
          and(
            eq(userFactors.id, factor.id),
            isNull(userFactors.revokedAt),
            sql`(${userFactors.counter} < ${newCounter} or (${userFactors.counter} = 0 and ${newCounter} = 0))`,
          ),
        )
        .returning({ id: userFactors.id });
      if (moved.length === 0) throw new Refused("counter");

      const recorded = await recordStepUp(tx, {
        sessionTokenHash,
        userId,
        factorId: factor.id,
        deviceLabel,
      });
      await recordSecurityEvent(tx, {
        event: "step_up_granted",
        actorLabel: await actorLabelFor(tx, userId),
        userId,
        ipAddress: input.request?.ipAddress ?? null,
        userAgent: input.request?.userAgent ?? null,
        metadata: { factorId: factor.id, stepUpId: recorded.id, via: "passkey" },
      });
      return recorded;
    });
    return { ok: true, stepUp };
  } catch (error) {
    if (error instanceof Refused) return { ok: false, reason: "counter" };
    throw error;
  }
}

// -----------------------------------------------------------------------------
// Removing a device
// -----------------------------------------------------------------------------

export type RemoveResult =
  | { ok: true; sessionsEnded: number; endedThisSession: boolean }
  | { ok: false; reason: "needs_step_up" | "not_found" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Remove a device's passkey (plan Part D3, Settings → Sign-in in M3). Needs a
 * live step-up on this session. In one transaction the passkey is revoked,
 * every step-up made with it ends, and so does every session that stepped up
 * with it: a lost phone takes the sessions it vouched for with it. Those
 * sessions are deleted directly, which Better Auth reads on every request
 * (there is no cookie cache), and their other step-ups are ended here because
 * the sign-out hook in lib/auth.ts does not see a direct delete.
 */
export async function removePasskey(input: {
  session: SessionBinding;
  factorId: string;
  request?: RequestMeta;
}): Promise<RemoveResult> {
  const { userId, sessionTokenHash } = input.session;
  if (!UUID.test(input.factorId)) return { ok: false, reason: "not_found" };

  const result = await unsafeDb.transaction(async (tx): Promise<RemoveResult> => {
    const stepUp = await findLiveStepUp(tx, { sessionTokenHash, userId }, { touch: true });
    if (!stepUp) return { ok: false, reason: "needs_step_up" };

    const [revoked] = await tx
      .update(userFactors)
      .set({ revokedAt: sql`now()` })
      .where(
        and(
          eq(userFactors.id, input.factorId),
          eq(userFactors.userId, userId),
          eq(userFactors.kind, "passkey"),
          isNull(userFactors.revokedAt),
        ),
      )
      .returning({ id: userFactors.id });
    if (!revoked) return { ok: false, reason: "not_found" };

    const ended = await tx.execute<{ token_hash: Buffer }>(sql`
      delete from "session" s
       where s.user_id = ${userId}
         and sha256(convert_to(s.token, 'UTF8')) in (
               select su.session_token_hash from step_ups su where su.factor_id = ${input.factorId})
      returning sha256(convert_to(s.token, 'UTF8')) as token_hash`);
    await endStepUps({ factorId: input.factorId }, tx);
    for (const row of ended.rows) await endStepUps({ sessionTokenHash: row.token_hash }, tx);

    await recordSecurityEvent(tx, {
      event: "passkey_removed",
      actorLabel: await actorLabelFor(tx, userId),
      userId,
      ipAddress: input.request?.ipAddress ?? null,
      userAgent: input.request?.userAgent ?? null,
      metadata: {
        factorId: input.factorId,
        viaFactorId: stepUp.factorId,
        sessionsEnded: ended.rows.length,
      },
    });
    return {
      ok: true,
      sessionsEnded: ended.rows.length,
      endedThisSession: ended.rows.some((row) =>
        Buffer.from(row.token_hash).equals(sessionTokenHash),
      ),
    };
  });
  if (result.ok) await notifyDeviceChange({ userId, kind: "removed", factorId: input.factorId });
  return result;
}
