import { createHash } from "node:crypto";

import { and, desc, eq, gt, inArray, isNull, sql } from "drizzle-orm";

import { unsafeDb, type Queryable } from "@/db";
import { stepUps, userFactors } from "@/db/schema";

/**
 * Passkey step-ups, as rows (plan Part D2). What a page asks of them lives in
 * lib/portal/step-up.ts; this file is the store, and imports nothing from
 * Better Auth, because lib/auth.ts imports it to end a session's step-ups
 * whenever Better Auth deletes the session.
 *
 * A step-up is live while it has been active in the last 15 minutes and is
 * at most 8 hours old, its passkey is not revoked, and neither is the row.
 * Both windows are measured on the database's clock, like every other expiry
 * it enforces, so two app servers with drifting clocks agree.
 */

/** Idle limit: patient pages clear and ask again after this long untouched. */
export const STEP_UP_IDLE_MS = 15 * 60 * 1000;
/** Absolute limit, however busy the page: one passkey tap holds for a working day. */
export const STEP_UP_MAX_MS = 8 * 60 * 60 * 1000;

/**
 * SHA-256 of a Better Auth session token, the only form in which a step-up or
 * a challenge refers to a session. The token is the cookie's bearer value, so
 * the step-up tables never hold one; the digest still matches exactly one
 * session for as long as it lives.
 */
export function hashSessionToken(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

export type LiveStepUp = {
  id: string;
  factorId: string;
  deviceLabel: string;
  createdAt: Date;
  lastActivityAt: Date;
};

const returning = {
  id: stepUps.id,
  factorId: stepUps.factorId,
  deviceLabel: stepUps.deviceLabel,
  createdAt: stepUps.createdAt,
  lastActivityAt: stepUps.lastActivityAt,
};

/** Record that this session just proved a passkey. Starts both clocks. */
export async function recordStepUp(
  db: Queryable,
  input: { sessionTokenHash: Buffer; userId: string; factorId: string; deviceLabel: string },
): Promise<LiveStepUp> {
  const [row] = await db
    .insert(stepUps)
    .values({
      sessionTokenHash: input.sessionTokenHash,
      userId: input.userId,
      factorId: input.factorId,
      deviceLabel: input.deviceLabel,
    })
    .returning(returning);
  if (!row) throw new Error("The step-up was not recorded.");
  return row;
}

/** The SQL condition for "still live", on the database's clock. */
function liveCondition() {
  return and(
    isNull(stepUps.revokedAt),
    gt(stepUps.lastActivityAt, sql`now() - ${STEP_UP_IDLE_MS} * interval '1 millisecond'`),
    gt(stepUps.createdAt, sql`now() - ${STEP_UP_MAX_MS} * interval '1 millisecond'`),
    sql`exists (select 1 from ${userFactors} f where f.id = ${stepUps.factorId} and f.revoked_at is null)`,
  );
}

/**
 * This session's live step-up, the most recent if there are several, or null.
 *
 * With `touch`, the same statement moves `last_activity_at` to now, and only
 * if the row is still live when the UPDATE takes its lock: a step-up that
 * lapsed, or whose passkey was removed, a moment ago is not revived by a
 * request that read it first. The 8-hour CHECK on the table is the backstop
 * if this condition is ever loosened.
 */
export async function findLiveStepUp(
  db: Queryable,
  input: { sessionTokenHash: Buffer; userId: string },
  options: { touch: boolean },
): Promise<LiveStepUp | null> {
  const mine = and(
    eq(stepUps.sessionTokenHash, input.sessionTokenHash),
    eq(stepUps.userId, input.userId),
    liveCondition(),
  );

  if (!options.touch) {
    const [row] = await db
      .select(returning)
      .from(stepUps)
      .where(mine)
      .orderBy(desc(stepUps.createdAt))
      .limit(1);
    return row ?? null;
  }

  const latest = db
    .select({ id: stepUps.id })
    .from(stepUps)
    .where(mine)
    .orderBy(desc(stepUps.createdAt))
    .limit(1);
  const [row] = await db
    .update(stepUps)
    .set({ lastActivityAt: sql`now()` })
    .where(and(inArray(stepUps.id, latest), liveCondition()))
    .returning(returning);
  return row ?? null;
}

/** Which step-ups to end: a sign-in's, a session's, or those made with one passkey. */
export type StepUpScope = { userId: string } | { sessionTokenHash: Buffer } | { factorId: string };

/**
 * End step-ups, so the next patient page asks for a passkey again. Sign-out
 * ends the session's (lib/auth.ts), removing a device ends those made with
 * its passkey (lib/factors/passkeys.ts), and "Someone left" (M3) ends the
 * sign-in's. Returns how many it ended; a revoked row is frozen, so ending
 * twice ends nothing.
 */
export async function endStepUps(scope: StepUpScope, db: Queryable = unsafeDb): Promise<number> {
  const target =
    "userId" in scope
      ? eq(stepUps.userId, scope.userId)
      : "factorId" in scope
        ? eq(stepUps.factorId, scope.factorId)
        : eq(stepUps.sessionTokenHash, scope.sessionTokenHash);
  const rows = await db
    .update(stepUps)
    .set({ revokedAt: sql`now()` })
    .where(and(target, isNull(stepUps.revokedAt)))
    .returning({ id: stepUps.id });
  return rows.length;
}
