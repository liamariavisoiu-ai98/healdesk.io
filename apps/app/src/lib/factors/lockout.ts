import { and, eq, gt, sql } from "drizzle-orm";

import { unsafeDb } from "@/db";
import { factorLockouts } from "@/db/schema";

/**
 * The lockout on typed second-factor codes (plan Part D3): five wrong codes,
 * from the authenticator app or the backup list, within fifteen minutes lock
 * code entry for that sign-in for fifteen minutes.
 *
 * Persisted in `factor_lockouts` rather than counted by
 * lib/connections/attempt-limit.ts, which is in-memory: a counter that a
 * deploy or a second instance resets is a counter an attacker can outwait or
 * outnumber, and these codes are what lets a new device add itself to a
 * clinic's sign-in. Counted per sign-in, not per address, because the sign-in
 * is what the codes protect and addresses are cheap.
 *
 * Every window is the database's clock. A code is checked only after
 * `lockedUntil` says the sign-in is not locked, so a lock refuses even the
 * right code until it lapses, and wrong codes during a lock are not counted
 * (they cannot extend it).
 */

export const LOCKOUT_THRESHOLD = 5;
export const LOCKOUT_MS = 15 * 60 * 1000;
/** Wrong codes further apart than this are not counted together. */
export const LOCKOUT_WINDOW_MS = 15 * 60 * 1000;

const windowExpired = sql`${factorLockouts.windowStartedAt} is null or ${factorLockouts.windowStartedAt} <= now() - ${LOCKOUT_WINDOW_MS} * interval '1 millisecond'`;

/** When the sign-in's lock lapses, or null if code entry is open. */
export async function lockedUntil(userId: string): Promise<Date | null> {
  const [row] = await unsafeDb
    .select({ lockedUntil: factorLockouts.lockedUntil })
    .from(factorLockouts)
    .where(and(eq(factorLockouts.userId, userId), gt(factorLockouts.lockedUntil, sql`now()`)))
    .limit(1);
  return row?.lockedUntil ?? null;
}

/**
 * Count one wrong code. Returns the lock's end when this code is the one that
 * locked the sign-in (`justLocked`), so the caller records the lockout once.
 *
 * Two statements, each atomic: the count is an upsert that restarts the
 * window when the last one has lapsed, and the lock is a conditional UPDATE
 * that only an unlocked row takes, so two wrong codes landing together lock
 * once. The count restarts with the lock, so the sign-in comes back with five
 * tries rather than one.
 */
export async function recordWrongCode(
  userId: string,
): Promise<{ failures: number; lockedUntil: Date | null; justLocked: boolean }> {
  const [counted] = await unsafeDb
    .insert(factorLockouts)
    .values({ userId, failures: 1, windowStartedAt: sql`now()`, updatedAt: sql`now()` })
    .onConflictDoUpdate({
      target: factorLockouts.userId,
      set: {
        failures: sql`case when ${windowExpired} then 1 else ${factorLockouts.failures} + 1 end`,
        windowStartedAt: sql`case when ${windowExpired} then now() else ${factorLockouts.windowStartedAt} end`,
        updatedAt: sql`now()`,
      },
    })
    .returning({ failures: factorLockouts.failures });
  const failures = counted?.failures ?? 1;
  if (failures < LOCKOUT_THRESHOLD) return { failures, lockedUntil: null, justLocked: false };

  const [locked] = await unsafeDb
    .update(factorLockouts)
    .set({
      lockedUntil: sql`now() + ${LOCKOUT_MS} * interval '1 millisecond'`,
      failures: 0,
      windowStartedAt: null,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(factorLockouts.userId, userId),
        sql`(${factorLockouts.lockedUntil} is null or ${factorLockouts.lockedUntil} <= now())`,
      ),
    )
    .returning({ lockedUntil: factorLockouts.lockedUntil });
  if (locked?.lockedUntil) return { failures, lockedUntil: locked.lockedUntil, justLocked: true };
  return { failures, lockedUntil: await lockedUntil(userId), justLocked: false };
}

/** A right code: forget the wrong ones before it. */
export async function clearWrongCodes(userId: string): Promise<void> {
  await unsafeDb
    .update(factorLockouts)
    .set({ failures: 0, windowStartedAt: null, updatedAt: sql`now()` })
    .where(eq(factorLockouts.userId, userId));
}
