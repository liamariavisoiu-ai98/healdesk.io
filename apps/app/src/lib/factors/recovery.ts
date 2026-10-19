import { createHash } from "node:crypto";

import { and, desc, eq, gt, isNotNull, isNull, sql } from "drizzle-orm";

import { unsafeDb, type Queryable } from "@/db";
import { session, user } from "@/db/auth-schema";
import { deviceRecoveries } from "@/db/schema";
import { recordSecurityEvent } from "@/lib/audit";
import { describeError, log } from "@/lib/log";
import { maskEmail } from "@/lib/sign-in/links";

import type { SessionBinding } from "./passkeys";
import type { DeviceRecoveryRevokeReason } from "./recovery-terms";
import { endStepUps } from "./step-ups";

/**
 * The human route for a clinic that has lost every device (plan Part D3,
 * "Lost every device: the human route: a call to the published number,
 * operator TOTP, the same business day, and a link sent only to the
 * clinic's address").
 *
 * After go-live a sign-in link alone never adds a device (authority.ts). A
 * clinic whose every passkey is gone (a lost phone, a wiped laptop, "Someone
 * left" with every device ticked) and which has no authenticator code to
 * offer could otherwise never open Conversations or Bookings again. So:
 *
 *   1. **Issue** (recovery-issue.ts, for the ops operation
 *      issueDeviceRecovery). The operator has
 *      called the practice back on its published number and entered a fresh
 *      code from the operator's own authenticator, both checked on apps/web
 *      before the signed request is sent (apps/web lib/admin/
 *      device-recovery.ts). This mints one row and its link, revoking any
 *      link still open for the sign-in, and emails the link to the clinic's
 *      address on file, as stored, and nowhere else.
 *   2. **Claim** (/recover/<token>). A GET only looks, so a mail scanner
 *      spends nothing. The POST claims the row in one conditional UPDATE
 *      (once, unexpired, unrevoked, its address still the sign-in's) before
 *      any session exists, so a losing claim signs nobody in and sends no
 *      cookie; the winner then starts a session and binds the row to it.
 *   3. **Use** (lib/factors/passkeys.ts, basis `recovery`). That session, and
 *      no other, may add one passkey. The row is spent in the transaction
 *      that stores the passkey, by a conditional UPDATE, so of two
 *      registrations exactly one is added. O3 then tells the address a
 *      device was added this way.
 *
 * The window, DEVICE_RECOVERY_TTL_HOURS from issue, covers the claim and the
 * use, on the database's clock: the database dates the row on INSERT and a
 * CHECK keeps the window from being longer (drizzle/0094). A link is bound
 * to the address it was mailed to: none is issued while a change of that
 * address is open, starting or applying one ends it, and it neither claims
 * nor adds a device once its address is not the sign-in's or a change of it
 * is open, so O3 never goes to an address on its way out.
 * Every step writes a security_events row with ids only. The token is
 * returned once, into one email, and only its SHA-256 is stored.
 *
 * Identity plane (drizzle/0094): a passkey belongs to the sign-in, not to a
 * clinic. "For that clinic" is the clinic's one sign-in: the row is bound to
 * its user and lands on that clinic's Protect page, and another sign-in's
 * session can do nothing with it. Business contact data; no patient.
 */

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** The browser behind a request, as a trace for the events (the portal's RequestMeta). */
export type RecoveryTrace = { ipAddress?: string | null; userAgent?: string | null };

/** SHA-256 of a link's token: the only form in which a row refers to it. */
export function hashRecoveryToken(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

function hashIfWellFormed(token: unknown): Buffer | null {
  return typeof token === "string" && TOKEN_PATTERN.test(token) ? hashRecoveryToken(token) : null;
}

/**
 * The sign-in's address, the label every identity-plane event carries
 * (totp.ts's actorLabelFor, read here so this file imports no other factor
 * module: authority.ts reads this one).
 */
async function actorLabelFor(db: Queryable, userId: string): Promise<string> {
  const [row] = await db
    .select({ email: user.email })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1);
  return row?.email ?? userId;
}

/** The advisory lock every change of a sign-in's factors takes (passkeys.ts). */
export async function lockFactors(db: Queryable, userId: string): Promise<void> {
  await db.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`user_factors:${userId}`}, 0))`,
  );
}

// -----------------------------------------------------------------------------
// 2. Claim
// -----------------------------------------------------------------------------

/**
 * Why a link does nothing: never ours, already used, past its window, ended
 * by healdesk or a newer link, `moved` (the address it was mailed to is no
 * longer the sign-in's, or a change of that address is under way), or
 * `unfinished`: claimed, but no session came of it, so it is spent and a
 * new link is needed. A claim is made once, for every role (drizzle/0094),
 * so it is never given back.
 */
export type DeviceRecoveryProblem =
  "unknown" | "used" | "expired" | "ended" | "moved" | "unfinished";

export type DeviceRecoveryLookup =
  | { ok: true; recoveryId: string; userId: string; emailMasked: string; landing: string }
  | { ok: false; reason: DeviceRecoveryProblem };

/**
 * The link's address is still the sign-in's, and no change of it is open:
 * the condition every claim and every use of a link repeats (drizzle/0094).
 */
const ADDRESS_STILL_ITS = sql`(${deviceRecoveries.addressHash} = app_address_hash(${deviceRecoveries.userId}) and not app_sign_in_address_change_open(${deviceRecoveries.userId}))`;

/** What a link would do, without using it: the GET that renders "Continue". */
export async function lookUpDeviceRecovery(token: unknown): Promise<DeviceRecoveryLookup> {
  const hash = hashIfWellFormed(token);
  if (!hash) return { ok: false, reason: "unknown" };
  const [row] = await unsafeDb
    .select({
      id: deviceRecoveries.id,
      userId: deviceRecoveries.userId,
      email: user.email,
      landing: deviceRecoveries.landing,
      claimedAt: deviceRecoveries.claimedAt,
      bound: sql<boolean>`${deviceRecoveries.sessionTokenHash} is not null`,
      revokedAt: deviceRecoveries.revokedAt,
      expired: sql<boolean>`${deviceRecoveries.expiresAt} <= now()`,
      addressStillIts: sql<boolean>`${ADDRESS_STILL_ITS}`,
    })
    .from(deviceRecoveries)
    .innerJoin(user, eq(user.id, deviceRecoveries.userId))
    .where(eq(deviceRecoveries.tokenHash, hash))
    .limit(1);
  if (!row) return { ok: false, reason: "unknown" };
  if (row.revokedAt) return { ok: false, reason: "ended" };
  if (row.claimedAt) return { ok: false, reason: row.bound ? "used" : "unfinished" };
  if (row.expired) return { ok: false, reason: "expired" };
  if (!row.addressStillIts) return { ok: false, reason: "moved" };
  return {
    ok: true,
    recoveryId: row.id,
    userId: row.userId,
    emailMasked: maskEmail(row.email),
    landing: row.landing,
  };
}

/** One refusal row per link in this long, so a spent link presented again and again cannot flood the log. */
export const REFUSAL_RECORD_EVERY_MS = 10 * 60 * 1000;

/**
 * Record a link presented and refused (used, ended, expired, moved), against
 * the sign-in it was for: a spent or ended link presented again is the case
 * most likely to mean it leaked. At most one row per link every ten
 * minutes, decided under a per-link advisory lock so concurrent refusals
 * write one. A token that is none of ours names no sign-in, so nothing is
 * recorded for it. Never throws.
 */
export async function recordRecoveryRefusal(input: {
  token: unknown;
  reason: DeviceRecoveryProblem;
  request?: RecoveryTrace;
}): Promise<void> {
  const hash = hashIfWellFormed(input.token);
  if (!hash) return;
  try {
    const [known] = await unsafeDb
      .select({ id: deviceRecoveries.id, userId: deviceRecoveries.userId })
      .from(deviceRecoveries)
      .where(eq(deviceRecoveries.tokenHash, hash))
      .limit(1);
    if (!known) return;
    await unsafeDb.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`device_recovery_refused:${known.id}`}, 0))`,
      );
      const recent = await tx.execute(
        sql`select 1 from security_events
             where event = 'device_recovery_refused'
               and metadata->>'recoveryId' = ${known.id}
               and occurred_at > now() - ${REFUSAL_RECORD_EVERY_MS} * interval '1 millisecond'
             limit 1`,
      );
      if (recent.rows.length > 0) return;
      await recordSecurityEvent(tx, {
        event: "device_recovery_refused",
        actorLabel: await actorLabelFor(tx, known.userId),
        userId: known.userId,
        ipAddress: input.request?.ipAddress ?? null,
        userAgent: input.request?.userAgent ?? null,
        metadata: { recoveryId: known.id, code: input.reason },
      });
    });
  } catch (error) {
    log.error("device recovery refusal not recorded", { error: describeError(error) });
  }
}

/**
 * A claim that no session came of: the session could not be started, or
 * could not be named because the link was ended in between. The link stays
 * spent (a claim is made once), any session started for it is deleted, and
 * the row is recorded, so the operator sees why the clinic needs another.
 * Never throws.
 */
export async function recordUnfinishedClaim(input: {
  recoveryId: string;
  userId: string;
  code: "session_failed" | "ended_meanwhile";
  /** The session started for the claim, if one was, which is deleted. */
  sessionId?: string;
  request?: RecoveryTrace;
}): Promise<void> {
  try {
    await unsafeDb.transaction(async (tx) => {
      if (input.sessionId) {
        await tx
          .delete(session)
          .where(and(eq(session.id, input.sessionId), eq(session.userId, input.userId)));
      }
      await recordSecurityEvent(tx, {
        event: "device_recovery_unfinished",
        actorLabel: await actorLabelFor(tx, input.userId),
        userId: input.userId,
        ipAddress: input.request?.ipAddress ?? null,
        userAgent: input.request?.userAgent ?? null,
        metadata: {
          recoveryId: input.recoveryId,
          code: input.code,
          sessionEnded: input.sessionId !== undefined,
        },
      });
    });
  } catch (error) {
    log.error("device recovery: unfinished claim not recorded", { error: describeError(error) });
  }
}

export type DeviceRecoveryClaim =
  | { ok: true; recoveryId: string; userId: string; landing: string }
  | { ok: false; reason: DeviceRecoveryProblem };

/**
 * Spend the link, before any session exists: one conditional UPDATE, so of
 * two submissions exactly one claims it, and the loser has started no
 * session and sends the browser no cookie, so it can never replace a
 * session the browser already holds. The winner then starts its session and
 * names it with bindDeviceRecovery. A refusal is recorded.
 */
export async function claimDeviceRecovery(input: {
  token: unknown;
  request?: RecoveryTrace;
}): Promise<DeviceRecoveryClaim> {
  const hash = hashIfWellFormed(input.token);
  if (!hash) return { ok: false, reason: "unknown" };
  const [row] = await unsafeDb
    .update(deviceRecoveries)
    .set({ claimedAt: sql`now()` })
    .where(
      and(
        eq(deviceRecoveries.tokenHash, hash),
        isNull(deviceRecoveries.claimedAt),
        isNull(deviceRecoveries.revokedAt),
        gt(deviceRecoveries.expiresAt, sql`now()`),
        ADDRESS_STILL_ITS,
      ),
    )
    .returning({
      id: deviceRecoveries.id,
      userId: deviceRecoveries.userId,
      landing: deviceRecoveries.landing,
    });
  if (row) {
    await recordSecurityEvent(unsafeDb, {
      event: "device_recovery_claimed",
      actorLabel: await actorLabelFor(unsafeDb, row.userId),
      userId: row.userId,
      ipAddress: input.request?.ipAddress ?? null,
      userAgent: input.request?.userAgent ?? null,
      metadata: { recoveryId: row.id },
    });
    return { ok: true, recoveryId: row.id, userId: row.userId, landing: row.landing };
  }

  // Lost the race, or never could have won: say which.
  const state = await lookUpDeviceRecovery(input.token);
  const reason: DeviceRecoveryProblem = state.ok ? "used" : state.reason;
  await recordRecoveryRefusal({ token: input.token, reason, request: input.request });
  return { ok: false, reason };
}

/**
 * Name the session the winning claim started (`sessionId`, Better Auth's
 * row), by SHA-256 of its token read from the row in the same statement,
 * which must be this sign-in's. Once only, and only while the link is still
 * unspent and unrevoked: false when the operator ended it in between, and
 * the page then deletes that session (recordUnfinishedClaim).
 */
export async function bindDeviceRecovery(input: {
  recoveryId: string;
  sessionId: string;
}): Promise<boolean> {
  const bound = await unsafeDb
    .update(deviceRecoveries)
    .set({
      sessionTokenHash: sql`(select sha256(convert_to(s.token, 'UTF8')) from "session" s where s.id = ${input.sessionId} and s.user_id = ${deviceRecoveries.userId})`,
    })
    .where(
      and(
        eq(deviceRecoveries.id, input.recoveryId),
        isNotNull(deviceRecoveries.claimedAt),
        isNull(deviceRecoveries.sessionTokenHash),
        isNull(deviceRecoveries.usedAt),
        isNull(deviceRecoveries.revokedAt),
        sql`exists (select 1 from "session" s where s.id = ${input.sessionId} and s.user_id = ${deviceRecoveries.userId})`,
      ),
    )
    .returning({ id: deviceRecoveries.id });
  return bound.length > 0;
}

// -----------------------------------------------------------------------------
// 3. Use, and the end
// -----------------------------------------------------------------------------

/** A claimed link that this session of this sign-in may still spend, on the database's clock. */
function spendable(binding: SessionBinding) {
  return and(
    eq(deviceRecoveries.userId, binding.userId),
    eq(deviceRecoveries.sessionTokenHash, binding.sessionTokenHash),
    isNotNull(deviceRecoveries.claimedAt),
    isNull(deviceRecoveries.usedAt),
    isNull(deviceRecoveries.revokedAt),
    gt(deviceRecoveries.expiresAt, sql`now()`),
    ADDRESS_STILL_ITS,
  );
}

/**
 * The link this session claimed, if it may still add its one device: claimed
 * by this session of this sign-in, unspent, unrevoked, inside its window,
 * and still bound to the sign-in's address with no change of it open.
 */
export async function liveDeviceRecovery(
  db: Queryable,
  binding: SessionBinding,
): Promise<{ id: string; expiresAt: Date } | null> {
  const [row] = await db
    .select({ id: deviceRecoveries.id, expiresAt: deviceRecoveries.expiresAt })
    .from(deviceRecoveries)
    .where(spendable(binding))
    .limit(1);
  return row ?? null;
}

/**
 * Spend this session's link on `factorId`, the passkey just stored in the
 * same transaction. One conditional UPDATE, with every condition of
 * liveDeviceRecovery: null when there is nothing left to spend, and the
 * caller then rolls the passkey back. The address the link was mailed to is
 * the sign-in's still, so the O3 that follows goes to that address.
 */
export async function spendDeviceRecovery(
  db: Queryable,
  binding: SessionBinding,
  factorId: string,
): Promise<string | null> {
  const [row] = await db
    .update(deviceRecoveries)
    .set({ usedAt: sql`now()`, factorId })
    .where(spendable(binding))
    .returning({ id: deviceRecoveries.id });
  return row?.id ?? null;
}

export type RevokedRecoveries = {
  ids: string[];
  /** Sessions a claimed link had started, now ended. */
  browsersSignedOut: number;
};

/**
 * End every link of the sign-in not yet used, claimed or not, in the
 * caller's transaction. A claimed link takes the session it started with
 * it, and that session's step-ups: ending the link signs that browser out,
 * so a link ended because nobody at the clinic asked for it leaves nobody
 * signed in by it. Better Auth reads the session row on every request, and
 * the sign-out hook in lib/auth.ts does not see a direct delete, hence the
 * step-ups here.
 */
export async function revokeOpenDeviceRecoveries(
  db: Queryable,
  userId: string,
  reason: DeviceRecoveryRevokeReason,
): Promise<RevokedRecoveries> {
  const rows = await db
    .update(deviceRecoveries)
    .set({ revokedAt: sql`now()`, revokedReason: reason })
    .where(
      and(
        eq(deviceRecoveries.userId, userId),
        isNull(deviceRecoveries.usedAt),
        isNull(deviceRecoveries.revokedAt),
      ),
    )
    .returning({ id: deviceRecoveries.id, sessionTokenHash: deviceRecoveries.sessionTokenHash });
  let browsersSignedOut = 0;
  for (const row of rows) {
    if (!row.sessionTokenHash) continue;
    const ended = await db
      .delete(session)
      .where(
        and(
          eq(session.userId, userId),
          sql`sha256(convert_to(${session.token}, 'UTF8')) = ${row.sessionTokenHash}`,
        ),
      )
      .returning({ id: session.id });
    browsersSignedOut += ended.length;
    await endStepUps({ sessionTokenHash: row.sessionTokenHash }, db);
  }
  return { ids: rows.map((r) => r.id), browsersSignedOut };
}

export type EndDeviceRecoveryOutcome =
  | {
      status: "ended";
      /** Whether a browser had used the link, and was signed out with it. */
      browsersSignedOut: number;
    }
  | { status: "none" };

/**
 * The operator ends the clinic's open link unused (the ops operation
 * endDeviceRecovery): the clinic said nobody there asked for it. A browser
 * that had already used the link is signed out with it. It only takes
 * access away, so it needs no fresh code, like stopping an address change.
 */
export async function endDeviceRecovery(input: {
  userId: string;
  clinicId: string;
  operatorLabel: string;
  request?: RecoveryTrace;
}): Promise<EndDeviceRecoveryOutcome> {
  return unsafeDb.transaction(async (tx): Promise<EndDeviceRecoveryOutcome> => {
    await lockFactors(tx, input.userId);
    const revoked = await revokeOpenDeviceRecoveries(tx, input.userId, "operator_ended");
    if (revoked.ids.length === 0) return { status: "none" };
    await recordSecurityEvent(tx, {
      event: "device_recovery_revoked",
      actorLabel: input.operatorLabel,
      userId: input.userId,
      ipAddress: input.request?.ipAddress ?? null,
      userAgent: input.request?.userAgent ?? null,
      metadata: {
        recoveryIds: revoked.ids,
        reason: "operator_ended",
        clinicId: input.clinicId,
        browsersSignedOut: revoked.browsersSignedOut,
      },
    });
    return { status: "ended", browsersSignedOut: revoked.browsersSignedOut };
  });
}

// -----------------------------------------------------------------------------
// The console's view
// -----------------------------------------------------------------------------

export type DeviceRecoveryState = "open" | "claimed" | "used" | "expired" | "ended";

export type DeviceRecoveryView = {
  id: string;
  state: DeviceRecoveryState;
  issuedBy: string;
  createdAt: Date;
  expiresAt: Date;
  claimedAt: Date | null;
  usedAt: Date | null;
  revokedAt: Date | null;
  revokedReason: DeviceRecoveryRevokeReason | null;
};

/** The sign-in's links, newest first, each with where it stands on the database's clock. */
export async function listDeviceRecoveries(
  userId: string,
  limit = 10,
): Promise<DeviceRecoveryView[]> {
  const rows = await unsafeDb
    .select({
      id: deviceRecoveries.id,
      issuedBy: deviceRecoveries.issuedBy,
      createdAt: deviceRecoveries.createdAt,
      expiresAt: deviceRecoveries.expiresAt,
      claimedAt: deviceRecoveries.claimedAt,
      usedAt: deviceRecoveries.usedAt,
      revokedAt: deviceRecoveries.revokedAt,
      revokedReason: deviceRecoveries.revokedReason,
      expired: sql<boolean>`${deviceRecoveries.expiresAt} <= now()`,
    })
    .from(deviceRecoveries)
    .where(eq(deviceRecoveries.userId, userId))
    .orderBy(desc(deviceRecoveries.createdAt))
    .limit(Math.max(1, Math.min(limit, 50)));
  return rows.map(({ expired, ...r }) => ({
    ...r,
    state: r.usedAt
      ? "used"
      : r.revokedAt
        ? "ended"
        : expired
          ? "expired"
          : r.claimedAt
            ? "claimed"
            : "open",
  }));
}
