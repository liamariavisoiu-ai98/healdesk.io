import { SETUP_REMINDER_EVERY_DAYS } from "@healdesk/catalog";
import { and, eq, sql } from "drizzle-orm";

import { billingNotices } from "@/db/schema";
import { clinicLocalDate } from "@/lib/clinic/closures";
import { setupWindowStart } from "@/lib/clinic/setup-window";
import { dueReminderNumber, isDaytime, SETUP_REMINDER_COUNT } from "@/lib/setup/reminders";
import { readSetupState } from "@/lib/setup/state";
import type { TenantTx } from "@/lib/tenant";

/**
 * "Send reminder now" (design E2, "Manual buttons"; ops automation lane
 * P6f): the NEXT of the six spec reminders, sooner. It never adds one. It is
 * sent through the reminders' own sender (lib/setup/reminders.ts
 * queueSetupReminderNow), by the real clock, under the same outbox dedupe
 * key `setup_reminder:<n>`, so the hourly job finds it already queued on its
 * own day and the clinic still gets six at most.
 *
 * Which reminder: the one due today if it was never queued (the hourly job
 * was off, or it is night), else the first not yet queued after it.
 * Refused when:
 *   - it would be the sixth: it says "Today is the last day", true only on
 *     the window's last day, so the job alone sends it;
 *   - it is not daytime at the clinic: the outbox would hold it until the
 *     morning, perhaps after the window closed;
 *   - a numbered reminder was queued in the last five days: no bursts, at
 *     most one every five days, the spec's own spacing;
 *   - a channel is live, the window is over, or the clinic is not billed.
 */

const DAY_MS = 86_400_000;
const REMINDER_KEY = /^setup_reminder:([1-6])$/;

/** No two numbered reminders within this many days of each other. */
export const PULL_REST_DAYS = SETUP_REMINDER_EVERY_DAYS;

export type ReminderBlock = "not_billed" | "window_over" | "live" | "last_reminder" | "night" | "recently_sent";

export type ReminderPlan =
  | {
      ok: true;
      reminderNumber: number;
      /** The day the reminder is otherwise due, on the clinic's calendar. */
      normallyDueOn: string;
      /** Reminders already queued, 0 to 5. */
      sentSoFar: number;
    }
  | { ok: false; reason: ReminderBlock; reminderNumber?: number };

function addDays(localDate: string, days: number): string {
  const [year, month, day] = localDate.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

/** Which reminder "Send reminder now" would send now, inside the clinic's tenant, or why none. */
export async function reminderPlanIn(tx: TenantTx, now: Date): Promise<ReminderPlan> {
  const state = await readSetupState(tx, { userId: null, now });
  if (!state?.billing) return { ok: false, reason: "not_billed" };
  const { billing, clinic } = state;
  if (billing.status !== "active" && billing.status !== "provisioning") return { ok: false, reason: "window_over" };
  if (clinic.offboardingStartedAt || !billing.setupDeadlineAt) return { ok: false, reason: "window_over" };
  if (now.getTime() > billing.setupDeadlineAt.getTime()) return { ok: false, reason: "window_over" };
  if (billing.planStartedAt || state.channels.some((c) => c.liveAt !== null)) return { ok: false, reason: "live" };

  const queued = new Map<number, Date>();
  const rows = await tx.db
    .select({ key: billingNotices.dedupeKey, createdAt: billingNotices.createdAt })
    .from(billingNotices)
    .where(
      and(
        eq(billingNotices.clinicId, tx.clinicId),
        eq(billingNotices.kind, "setup_reminder"),
        sql`starts_with(${billingNotices.dedupeKey}, 'setup_reminder:')`,
      ),
    );
  for (const { key, createdAt } of rows) {
    const m = REMINDER_KEY.exec(key);
    if (m) queued.set(Number(m[1]), createdAt);
  }
  const windowStart = setupWindowStart(billing.setupDeadlineAt, clinic.timezone);
  const due = dueReminderNumber(windowStart, clinicLocalDate(now, clinic.timezone));
  let next = due ?? 1;
  while (queued.has(next) && next <= SETUP_REMINDER_COUNT) next += 1;
  if (next >= SETUP_REMINDER_COUNT) return { ok: false, reason: "last_reminder" };
  const latest = Math.max(0, ...[...queued.values()].map((d) => d.getTime()));
  if (latest > 0 && now.getTime() - latest < PULL_REST_DAYS * DAY_MS) {
    return { ok: false, reason: "recently_sent", reminderNumber: next };
  }
  if (!isDaytime(now, clinic.timezone)) return { ok: false, reason: "night", reminderNumber: next };
  return {
    ok: true,
    reminderNumber: next,
    normallyDueOn: addDays(windowStart, next * SETUP_REMINDER_EVERY_DAYS),
    sentSoFar: queued.size,
  };
}
