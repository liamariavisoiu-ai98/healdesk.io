import { and, eq, gte, isNull, sql } from "drizzle-orm";

import { unsafeDb, type Queryable } from "@/db";
import { emailDailyQuota } from "@/db/schema";
import { describeError, log } from "@/lib/log";
import { notifyOps } from "@/lib/ops/notify";

/**
 * Resend's daily count, and the alarm on it (Annex X2).
 *
 * The free plan sends 100 emails a day across the whole account, both apps,
 * and past that every email fails until midnight UTC: sign-in links and urgent
 * alerts included. Resend reports the day's count on every response in
 * `x-resend-daily-quota`, so the count is whatever the last response said, and
 * the highest value seen in a UTC day is that day's count. It is kept in
 * email_daily_quota rather than in memory, because the web tier, the worker
 * and the voice process each see only their own responses, and because the
 * 07:00 ops digest (I2) runs in a different process from the sends it reports.
 *
 * At 70, notifyOps fires once for the day: the row's alerted_at is claimed by
 * one conditional UPDATE, so two processes crossing 70 together alert once.
 */

/** Where the alarm fires. */
export const QUOTA_ALARM_AT = 70;
/** Where the free plan stops sending. */
export const FREE_PLAN_DAILY_LIMIT = 100;

/** Resend's quota day: the UTC calendar day. */
export function quotaDay(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/**
 * Record one observation of the header. Never throws: a send that succeeded
 * must not be reported as failed because its bookkeeping did.
 */
export async function recordDailyQuota(used: number, at: Date = new Date()): Promise<void> {
  if (!Number.isInteger(used) || used < 0) return;
  const day = quotaDay(at);
  try {
    await unsafeDb
      .insert(emailDailyQuota)
      .values({ day, used, observedAt: at })
      .onConflictDoUpdate({
        target: emailDailyQuota.day,
        set: { used: sql`greatest(${emailDailyQuota.used}, excluded.used)`, observedAt: at },
      });
    if (used < QUOTA_ALARM_AT) return;
    const claimed = await unsafeDb
      .update(emailDailyQuota)
      .set({ alertedAt: at })
      .where(
        and(
          eq(emailDailyQuota.day, day),
          isNull(emailDailyQuota.alertedAt),
          gte(emailDailyQuota.used, QUOTA_ALARM_AT),
        ),
      )
      .returning({ day: emailDailyQuota.day });
    if (claimed.length > 0) {
      await notifyOps("daily_email_count_70", { count: used, windowStart: day });
    }
  } catch (error) {
    log.warn("email quota not recorded", { error: describeError(error) });
  }
}

/**
 * Resend refused a send for the day's quota (daily_quota_exceeded): stamp
 * the UTC day, once, so urgentAlertLive stops promising an alert until the
 * quota resets at midnight. The refusal itself is the evidence, never the
 * count: the free plan's 100 is shared with apps/web's mail, and a paid
 * plan's limit is higher. Never throws, like recordDailyQuota.
 */
export async function recordQuotaExhausted(at: Date = new Date()): Promise<void> {
  try {
    await unsafeDb
      .insert(emailDailyQuota)
      .values({ day: quotaDay(at), used: 0, observedAt: at, exhaustedAt: at })
      .onConflictDoUpdate({
        target: emailDailyQuota.day,
        set: { exhaustedAt: sql`coalesce(${emailDailyQuota.exhaustedAt}, excluded.exhausted_at)` },
      });
  } catch (error) {
    log.warn("email quota refusal not recorded", { error: describeError(error) });
  }
}

/**
 * Whether Resend has refused a send for the quota this UTC day. In a
 * transaction, pass it: the read is the caller's to wrap.
 */
export async function quotaExhausted(db: Queryable = unsafeDb, at: Date = new Date()): Promise<boolean> {
  const [row] = await db
    .select({ exhaustedAt: emailDailyQuota.exhaustedAt })
    .from(emailDailyQuota)
    .where(eq(emailDailyQuota.day, quotaDay(at)))
    .limit(1);
  return Boolean(row?.exhaustedAt);
}

/** The day's count as last reported, or null when no response reported one. For the ops digest. */
export async function dailyEmailCount(day: string): Promise<number | null> {
  const [row] = await unsafeDb
    .select({ used: emailDailyQuota.used })
    .from(emailDailyQuota)
    .where(eq(emailDailyQuota.day, day))
    .limit(1);
  return row?.used ?? null;
}
