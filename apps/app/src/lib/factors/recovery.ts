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
 *      spends nothing. The POST starts a session for the sign-in and claims
 *      the row for that session in one conditional UPDATE: once, unexpired,
 *      unrevoked. A claim that loses ends the session it started.
 *   3. **Use** (lib/factors/passkeys.ts, basis `recovery`). That session, and
 *      no other, may add one passkey. The row is spent in the transaction
 *      that stores the passkey, by a conditional UPDATE, so of two
 *      registrations exactly one is added. O3 then tells the address a
 *      device was added this way.
 *
 * The window, DEVICE_RECOVERY_TTL_HOURS from issue, covers the claim and the
 * use, on the database's clock, and a CHECK keeps it from being longer.
 * Every step writes a security_events row with ids only. The token is
 * returned once, into one email, and only its SHA-256 is stored.
 *
 * Identity plane (drizzle/0092): a passkey belongs to the sign-in, not to a
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

export type DeviceRecoveryProblem = "unknown" | "used" | "expired" | "ended";

export type DeviceRecoveryLookup =
  | { ok: true; recoveryId: string; userId: string; emailMasked: string; landing: string }
  | { ok: false; reason: DeviceRecoveryProblem };

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
      revokedAt: deviceRecoveries.revokedAt,
      expired: sql<boolean>`${deviceRecoveries.expiresAt} <= now()`,
    })
    .from(deviceRecoveries)
    .innerJoin(user, eq(user.id, deviceRecoveries.userId))
    .where(eq(deviceRecoveries.tokenHash, hash))
    .limit(1);
  if (!row) return { ok: false, reason: "unknown" };
  if (row.claimedAt) return { ok: false, reason: "used" };
  if (row.revokedAt) return { ok: false, reason: "ended" };
  if (row.expired) return { ok: false, reason: "expired" };
  return {
    ok: true,
    recoveryId: row.id,
    userId: row.userId,
    emailMasked: maskEmail(row.email),
    landing: row.landing,
  };
}

export type DeviceRecoveryClaim =
  | { ok: true; recoveryId: string; userId: string; landing: string }
  | { ok: false; reason: DeviceRecoveryProblem };

/**
 * Spend the link for the session it just started (`sessionId`, Better Auth's
 * row): one conditional UPDATE, so of two submissions exactly one claims it,
 * and the claim names the session by SHA-256 of its token, read from the
 * session row in the same statement, which must be this sign-in's. The page
 * ends the session it started when this loses.
 */
export async function claimDeviceRecovery(input: {
  token: unknown;
  sessionId: string;
  request?: RecoveryTrace;
}): Promise<DeviceRecoveryClaim> {
  const hash = hashIfWellFormed(input.token);
  if (!hash) return { ok: false, reason: "unknown" };
  const [row] = await unsafeDb
    .update(deviceRecoveries)
    .set({
      claimedAt: sql`now()`,
      sessionTokenHash: sql`(select sha256(convert_to(s.token, 'UTF8')) from "session" s where s.id = ${input.sessionId} and s.user_id = ${deviceRecoveries.userId})`,
    })
    .where(
      and(
        eq(deviceRecoveries.tokenHash, hash),
        isNull(deviceRecoveries.claimedAt),
        isNull(deviceRecoveries.revokedAt),
        gt(deviceRecoveries.expiresAt, sql`now()`),
        sql`exists (select 1 from "session" s where s.id = ${input.sessionId} and s.user_id = ${deviceRecoveries.userId})`,
      ),
    )
    .returning({
      id: deviceRecoveries.id,
      userId: deviceRecoveries.userId,
      landing: deviceRecoveries.landing,
    });
  const trace = {
    ipAddress: input.request?.ipAddress ?? null,
    userAgent: input.request?.userAgent ?? null,
  };
  if (row) {
    await recordSecurityEvent(unsafeDb, {
      event: "device_recovery_claimed",
      actorLabel: await actorLabelFor(unsafeDb, row.userId),
      userId: row.userId,
      ...trace,
      metadata: { recoveryId: row.id },
    });
    return { ok: true, recoveryId: row.id, userId: row.userId, landing: row.landing };
  }

  // Lost the race, or never could have won: say which, and record it
  // against the sign-in the link was for, when it was one.
  const state = await lookUpDeviceRecovery(input.token);
  const reason: DeviceRecoveryProblem = state.ok ? "used" : state.reason;
  const [known] = await unsafeDb
    .select({ id: deviceRecoveries.id, userId: deviceRecoveries.userId })
    .from(deviceRecoveries)
    .where(eq(deviceRecoveries.tokenHash, hash))
    .limit(1);
  if (known) {
    await recordSecurityEvent(unsafeDb, {
      event: "device_recovery_refused",
      actorLabel: await actorLabelFor(unsafeDb, known.userId),
      userId: known.userId,
      ...trace,
      metadata: { recoveryId: known.id, code: reason },
    }).catch((error) =>
      log.error("device recovery refusal not recorded", { error: describeError(error) }),
    );
  }
  return { ok: false, reason };
}

/**
 * End the session a losing claim started, before its cookie is ever sent
 * back: a link that could not be claimed signs nobody in. Better Auth reads
 * the session row on every request, so a deleted row is a signed-out
 * browser; a session this new has no step-up to end.
 */
export async function abandonSession(sessionId: string): Promise<void> {
  await unsafeDb.delete(session).where(eq(session.id, sessionId));
}

// -----------------------------------------------------------------------------
// 3. Use, and the end
// -----------------------------------------------------------------------------

/**
 * The link this session claimed, if it may still add its one device: claimed
 * by this session of this sign-in, unspent, unrevoked, inside its window.
 */
export async function liveDeviceRecovery(
  db: Queryable,
  session: SessionBinding,
): Promise<{ id: string; expiresAt: Date } | null> {
  const [row] = await db
    .select({ id: deviceRecoveries.id, expiresAt: deviceRecoveries.expiresAt })
    .from(deviceRecoveries)
    .where(
      and(
        eq(deviceRecoveries.userId, session.userId),
        eq(deviceRecoveries.sessionTokenHash, session.sessionTokenHash),
        isNotNull(deviceRecoveries.claimedAt),
        isNull(deviceRecoveries.usedAt),
        isNull(deviceRecoveries.revokedAt),
        gt(deviceRecoveries.expiresAt, sql`now()`),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * Spend this session's link on `factorId`, the passkey just stored in the
 * same transaction. One conditional UPDATE: null when there is nothing left
 * to spend, and the caller then rolls the passkey back.
 */
export async function spendDeviceRecovery(
  db: Queryable,
  session: SessionBinding,
  factorId: string,
): Promise<string | null> {
  const [row] = await db
    .update(deviceRecoveries)
    .set({ usedAt: sql`now()`, factorId })
    .where(
      and(
        eq(deviceRecoveries.userId, session.userId),
        eq(deviceRecoveries.sessionTokenHash, session.sessionTokenHash),
        isNotNull(deviceRecoveries.claimedAt),
        isNull(deviceRecoveries.usedAt),
        isNull(deviceRecoveries.revokedAt),
        gt(deviceRecoveries.expiresAt, sql`now()`),
      ),
    )
    .returning({ id: deviceRecoveries.id });
  return row?.id ?? null;
}

/** End every link of the sign-in not yet used, claimed or not. Returns their ids. */
export async function revokeOpenDeviceRecoveries(
  db: Queryable,
  userId: string,
  reason: DeviceRecoveryRevokeReason,
): Promise<string[]> {
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
    .returning({ id: deviceRecoveries.id });
  return rows.map((r) => r.id);
}

/**
 * The operator ends the clinic's open link unused (the ops operation
 * endDeviceRecovery): the clinic replied that nobody there asked for it. It
 * only takes access away, so it needs no fresh code, like stopping an
 * address change.
 */
export async function endDeviceRecovery(input: {
  userId: string;
  clinicId: string;
  operatorLabel: string;
  request?: RecoveryTrace;
}): Promise<{ status: "ended" | "none" }> {
  const ended = await unsafeDb.transaction(async (tx) => {
    await lockFactors(tx, input.userId);
    const ids = await revokeOpenDeviceRecoveries(tx, input.userId, "operator_ended");
    if (ids.length > 0) {
      await recordSecurityEvent(tx, {
        event: "device_recovery_revoked",
        actorLabel: input.operatorLabel,
        userId: input.userId,
        ipAddress: input.request?.ipAddress ?? null,
        userAgent: input.request?.userAgent ?? null,
        metadata: { recoveryIds: ids, reason: "operator_ended", clinicId: input.clinicId },
      });
    }
    return ids.length;
  });
  return { status: ended > 0 ? "ended" : "none" };
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
