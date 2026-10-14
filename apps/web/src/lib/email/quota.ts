import { after } from "next/server";

import { relayEmailQuota } from "@/lib/admin/ops-client";

/**
 * Resend's daily count, as this site's sends see it, handed to apps/app
 * (Annex X2).
 *
 * The free plan sends 100 emails a day across the whole account, both apps,
 * and past that every email fails until midnight UTC: apps/app's sign-in
 * links and urgent alerts included. Resend reports the day's count on every
 * response in `x-resend-daily-quota`. apps/app records what its own sends see
 * and alarms at 70 (apps/app/src/lib/email/quota.ts), but a day on which this
 * site did the sending, nurture and setup links and acknowledgements, never
 * reached that alarm. So each observation here goes to apps/app's
 * `emailQuota` op, which keeps the day's highest and alerts once.
 *
 * Not every observation: per instance, the first of each UTC day, every one
 * at or past the alarm, and otherwise one each time the count has grown by
 * ten, which keeps the digest's count close and the calls few. After the
 * response where Next allows it (`after`), so no email and no visitor waits
 * on apps/app, which may be in standby. Never throws, and does nothing on a
 * deployment that cannot reach apps/app.
 */

/** apps/app's alarm (QUOTA_ALARM_AT); every observation from here on is reported. */
export const QUOTA_ALARM_AT = 70;
/** Below the alarm, how much the count grows between reports. */
export const QUOTA_REPORT_STEP = 10;

let last: { day: string; used: number } | null = null;

/** Whether this observation is one apps/app should hear, given the last this instance reported. */
export function shouldReportQuota(
  used: number,
  at: Date,
  previous: { day: string; used: number } | null,
): boolean {
  const day = at.toISOString().slice(0, 10);
  if (!previous || previous.day !== day) return true;
  if (used >= QUOTA_ALARM_AT) return used > previous.used;
  return used >= previous.used + QUOTA_REPORT_STEP;
}

/** Resend's header as a count, or null when it is absent or not one. */
export function quotaFromHeader(value: string | null): number | null {
  if (value === null || !/^\d{1,7}$/.test(value.trim())) return null;
  return Number(value.trim());
}

export function noteDailyQuota(used: number, at: Date = new Date()): void {
  if (!process.env.HEALDESK_PROVISION_SECRET || !process.env.HEALDESK_APP_URL) return;
  if (!shouldReportQuota(used, at, last)) return;
  last = { day: at.toISOString().slice(0, 10), used };
  const report = async () => {
    const result = await relayEmailQuota(used, at).catch(() => null);
    if (!result?.ok)
      console.warn("[healdesk] the daily email count did not reach apps/app", { used });
  };
  try {
    after(report);
  } catch {
    // Outside a request (a script, a test): report now, without waiting.
    void report();
  }
}

/** Tests only: a fresh instance. */
export function __resetQuotaReportsForTests(): void {
  last = null;
}
