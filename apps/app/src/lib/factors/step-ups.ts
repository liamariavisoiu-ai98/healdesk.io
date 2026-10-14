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
 *
 * Only a passkey steps a session up (plan Part D3). The authenticator app and
 * the backup codes can let a new device add its own passkey and nothing
 * more, so a row whose factor is anything but a passkey is never recorded
 * here and never counts as live, should one ever reach the table some other
 * way: step_ups.factor_id references user_factors, which holds both kinds.
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
  /**
   * When it lapses if nothing touches it again: 15 minutes after the last
   * activity or the 8-hour limit, whichever comes first. Absolute, on the
   * database's clock, like `checkedAt`; the browser counts down from the
   * difference of the two, never from a figure a cached page could replay.
   */
  expiresAt: Date;
  /** The database's now() for the statement that read it. */
  checkedAt: Date;
  /** Whether the 8-hour limit is the one that applies, which activity cannot extend. */
  capped: boolean;
};

const IDLE = sql`${STEP_UP_IDLE_MS} * interval '1 millisecond'`;
const MAX = sql`${STEP_UP_MAX_MS} * interval '1 millisecond'`;

const returning = {
  id: stepUps.id,
  factorId: stepUps.factorId,
  deviceLabel: stepUps.deviceLabel,
  createdAt: stepUps.createdAt,
  lastActivityAt: stepUps.lastActivityAt,
  // In an UPDATE's RETURNING the columns are the new row, so after a touch
  // these are measured from the activity just recorded.
  expiresAt:
    sql<Date>`least(${stepUps.lastActivityAt} + ${IDLE}, ${stepUps.createdAt} + ${MAX})`.mapWith(
      stepUps.createdAt,
    ),
  checkedAt: sql<Date>`now()`.mapWith(stepUps.createdAt),
  capped:
    sql<boolean>`${stepUps.createdAt} + ${MAX} <= ${stepUps.lastActivityAt} + ${IDLE}`.mapWith(
      Boolean,
    ),
};

/**
 * Record that this session just proved a passkey. Starts both clocks.
 *
 * Refuses a factor that is not one of this sign-in's unrevoked passkeys: an
 * authenticator code is not a step-up, whoever asks.
 */
export async function recordStepUp(
  db: Queryable,
  input: { sessionTokenHash: Buffer; userId: string; factorId: string; deviceLabel: string },
): Promise<LiveStepUp> {
  const [passkey] = await db
    .select({ id: userFactors.id })
    .from(userFactors)
    .where(
      and(
        eq(userFactors.id, input.factorId),
        eq(userFactors.userId, input.userId),
        eq(userFactors.kind, "passkey"),
        isNull(userFactors.revokedAt),
      ),
    )
    .limit(1);
  if (!passkey) throw new Error("Only one of this sign-in's passkeys can step a session up.");
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

/** The SQL condition for "still live", on the database's clock, and made with a passkey. */
function liveCondition() {
  return and(
    isNull(stepUps.revokedAt),
    gt(stepUps.lastActivityAt, sql`now() - ${IDLE}`),
    gt(stepUps.createdAt, sql`now() - ${MAX}`),
    sql`exists (select 1 from ${userFactors} f where f.id = ${stepUps.factorId} and f.kind = 'passkey' and f.revoked_at is null)`,
  );
}

/**
 * This session's live step-up, the most recent if there are several, or null.
 *
 * With `touch`, the same statement moves `last_activity_at` to now, and only
 * if the row is still live when the UPDATE takes its lock: a step-up that
 * lapsed, or whose passkey was removed, a moment ago is not revived by a
 * request that read it first. The 8-hour CHECK on the table is the backstop
 * if this condition is ever loosened. It never moves activity back: two
 * requests touching at once each see now() as their transaction began, and
 * the one that began first may update second, which the table's trigger
 * would refuse as activity moving backwards (and the request would fail).
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
    .set({ lastActivityAt: sql`greatest(${stepUps.lastActivityAt}, now())` })
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
