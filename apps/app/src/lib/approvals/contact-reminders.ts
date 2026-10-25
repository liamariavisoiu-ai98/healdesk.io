import { SETUP_REMINDER_EVERY_DAYS } from "@healdesk/catalog";
import { and, eq, sql } from "drizzle-orm";

import { billingNotices } from "@/db/schema";
import { clinicLocalDate } from "@/lib/clinic/closures";
import { setupWindowStart, startOfLocalDay } from "@/lib/clinic/setup-window";
import { dueReminderNumber, SETUP_REMINDER_COUNT } from "@/lib/setup/reminders";
import { readSetupState } from "@/lib/setup/state";
import type { TenantTx } from "@/lib/tenant";

/**
 * "Send reminder now" (design E2, "Manual buttons"; ops automation lane
 * P6f): the NEXT of the six spec reminders, sooner. It never adds one. The
 * reminders are deduplicated in the outbox on `setup_reminder:<n>` (lib/
 * setup/reminders.ts), so a reminder pulled forward is one the hourly job
 * then finds already queued on its own day: the clinic still gets six at
 * most, and the next one after it on its usual day.
 *
 * Driven through the existing sender, unchanged: queueSetupReminder is
 * asked as of the reminder's own day (`asOf`, noon on the clinic's calendar),
 * which is the day its rule queues that number, so the email is the
 * reminder's own, with its own wording and payload, and no second sender
 * exists. The outbox still waits for the clinic's daytime to deliver it.
 *
 * Which reminder: the one due today if it was never queued (the hourly job
 * was off, or it is night), else the first not yet queued after it. Never
 * the sixth before its day: it says "Today is the last day", which is true
 * only on the window's last day.
 */

const DAY_MS = 86_400_000;
const REMINDER_KEY = /^setup_reminder:([1-6])$/;

export type ReminderPlan =
  | {
      ok: true;
      reminderNumber: number;
      /** The day the reminder is otherwise due, on the clinic's calendar. */
      normallyDueOn: string;
      /** The instant the existing sender is asked as of: noon on that day, at the clinic. */
      asOf: Date;
      /** Reminders already queued, 0 to 5. */
      sentSoFar: number;
    }
  | { ok: false; reason: "not_billed" | "window_over" | "live" | "last_reminder" };

function addDays(localDate: string, days: number): string {
  const [year, month, day] = localDate.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

/** Noon on a clinic-local day: daytime by the reminders' own rule, and that day by its calendar. */
export function localNoon(localDate: string, timeZone: string): Date {
  return new Date(startOfLocalDay(localDate, timeZone).getTime() + DAY_MS / 2);
}

/** Which reminder "Send reminder now" would send, inside the clinic's tenant. */
export async function reminderPlanIn(tx: TenantTx, now: Date): Promise<ReminderPlan> {
  const state = await readSetupState(tx, { userId: null, now });
  if (!state?.billing) return { ok: false, reason: "not_billed" };
  const { billing, clinic } = state;
  if (billing.status !== "active" && billing.status !== "provisioning") return { ok: false, reason: "window_over" };
  if (clinic.offboardingStartedAt || !billing.setupDeadlineAt) return { ok: false, reason: "window_over" };
  if (now.getTime() > billing.setupDeadlineAt.getTime()) return { ok: false, reason: "window_over" };
  if (billing.planStartedAt || state.channels.some((c) => c.liveAt !== null)) return { ok: false, reason: "live" };

  const queued = new Set<number>();
  const rows = await tx.db
    .select({ key: billingNotices.dedupeKey })
    .from(billingNotices)
    .where(
      and(
        eq(billingNotices.clinicId, tx.clinicId),
        eq(billingNotices.kind, "setup_reminder"),
        sql`starts_with(${billingNotices.dedupeKey}, 'setup_reminder:')`,
      ),
    );
  for (const { key } of rows) {
    const m = REMINDER_KEY.exec(key);
    if (m) queued.add(Number(m[1]));
  }
  const windowStart = setupWindowStart(billing.setupDeadlineAt, clinic.timezone);
  const today = clinicLocalDate(now, clinic.timezone);
  const due = dueReminderNumber(windowStart, today);
  let next = due ?? 1;
  while (queued.has(next) && next <= SETUP_REMINDER_COUNT) next += 1;
  if (next > SETUP_REMINDER_COUNT) return { ok: false, reason: "last_reminder" };
  // The sixth says "Today is the last day": only on its own day.
  if (next === SETUP_REMINDER_COUNT && due !== SETUP_REMINDER_COUNT) return { ok: false, reason: "last_reminder" };
  const normallyDueOn = addDays(windowStart, next * SETUP_REMINDER_EVERY_DAYS);
  const asOf = localNoon(due !== null && next === due ? today : normallyDueOn, clinic.timezone);
  return { ok: true, reminderNumber: next, normallyDueOn, asOf, sentSoFar: queued.size };
}
