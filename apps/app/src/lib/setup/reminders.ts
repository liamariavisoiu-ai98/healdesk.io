import { SETUP_REMINDER_EVERY_DAYS, SETUP_WINDOW_DAYS } from "@healdesk/catalog";

import { clinicLocalDate } from "@/lib/clinic/closures";
import { setupLastDay, setupWindowStart } from "@/lib/clinic/setup-window";
import { DAYTIME_FROM_HOUR, DAYTIME_UNTIL_HOUR } from "@/lib/email/outbox";
import { describeError, log } from "@/lib/log";
import { enqueuePlanNotice } from "@/lib/notices/plan-notices";
import { listClinics } from "@/lib/ops/clinics";
import { publicOriginProblem, publicUrl } from "@/lib/public-url";
import { JOB_SETUP_REMINDERS, runJob, type JobOutcome } from "@/lib/scheduler/jobs";
import { withTenant, type TenantTx } from "@/lib/tenant";

import { channelNextStep, isClinicAction } from "./channels";
import { emailCallUrl, helpContacts } from "./help";
import { stepsLeft, wizardFinished } from "./screens";
import { readSetupState } from "./state";

/**
 * The setup reminders (O7; the owner's cadence of 6 October 2026): while none
 * of a clinic's channels is answering, one email every five days, six in all,
 * on days 5, 10, 15, 20, 25 and 30 of its 30-day setup window, each naming
 * every channel's single outstanding action and, for phone, the five-minute
 * call. The moment a channel is live, nothing more is queued.
 *
 * The job runs hourly from the tick, behind its switch (seeded off). For each
 * clinic it queues at most the latest reminder that is due, once (the outbox
 * dedupes on `setup_reminder:<n>`), and only while it is daytime at the
 * clinic, so the minute sender delivers it at once instead of holding it until
 * morning, when a channel may have gone live overnight. A reminder whose day
 * was missed while the job was off is not sent late: the next one is.
 *
 * A clinic with nothing it can do (setup finished, every channel still being
 * prepared on our side) is not reminded: the reminder names an action, and
 * there is none to name.
 *
 * The days count back from the deadline, not forward from the purchase: day
 * 30 is the window's last day on the clinic's calendar (setupLastDay), so the
 * sixth reminder, "Today is the last day", always goes on the day the account
 * closes at the end of, whatever zone the deadline was first set in and
 * however ops has moved it. The welcome email's backstop is not here: it runs
 * from the tick whatever this job's switch says (lib/setup/welcome-email.ts).
 */

export const SETUP_REMINDER_COUNT = SETUP_WINDOW_DAYS / SETUP_REMINDER_EVERY_DAYS;

const ACTOR = { type: "service", serviceName: "setup-reminders" } as const;
const DAY_MS = 86_400_000;

/**
 * Which reminder is due on `today` for a window counted from `windowStart`
 * (both ISO dates on the clinic's calendar; the start is the last day less 30
 * days, setupWindowStart): the latest of days 5 to 30 that has arrived, or
 * null before day 5.
 */
export function dueReminderNumber(windowStart: string, today: string): number | null {
  const days = Math.round(
    (Date.parse(`${today}T12:00:00Z`) - Date.parse(`${windowStart}T12:00:00Z`)) / DAY_MS,
  );
  const n = Math.floor(days / SETUP_REMINDER_EVERY_DAYS);
  if (!Number.isFinite(n) || n < 1) return null;
  return Math.min(n, SETUP_REMINDER_COUNT);
}

/** Whether it is daytime at the clinic: the outbox's own quiet hours, 07:00 to 20:00 local. */
export function isDaytime(now: Date, timeZone: string): boolean {
  try {
    const hour =
      Number(
        new Intl.DateTimeFormat("en-US", { timeZone, hour: "2-digit", hour12: false })
          .formatToParts(now)
          .find((p) => p.type === "hour")?.value ?? "0",
      ) % 24;
    return hour >= DAYTIME_FROM_HOUR && hour < DAYTIME_UNTIL_HOUR;
  } catch {
    return true;
  }
}

export type ReminderOutcome =
  | "queued"
  | "already_queued"
  | "not_due"
  | "night"
  | "live"
  | "nothing_to_do"
  | "window_over"
  | "not_billed";

/** Queue the reminder due for one clinic now, if one is. */
export async function queueSetupReminder(clinicId: string, now: Date): Promise<ReminderOutcome> {
  return withTenant({ clinicId, actor: ACTOR }, (tx) => queueWithin(tx, now));
}

async function queueWithin(tx: TenantTx, now: Date): Promise<ReminderOutcome> {
  const state = await readSetupState(tx, { userId: null, now });
  // Locations bill on their billing clinic and are set up from it; a clinic
  // with no billing row of its own is not reminded.
  if (!state?.billing) return "not_billed";
  const { billing, clinic } = state;
  if (billing.status !== "active" && billing.status !== "provisioning") return "window_over";
  if (clinic.offboardingStartedAt || !billing.setupDeadlineAt) return "window_over";
  if (now.getTime() > billing.setupDeadlineAt.getTime()) return "window_over";
  if (billing.planStartedAt || state.channels.some((c) => c.liveAt !== null)) return "live";

  const n = dueReminderNumber(
    setupWindowStart(billing.setupDeadlineAt, clinic.timezone),
    clinicLocalDate(now, clinic.timezone),
  );
  if (n === null) return "not_due";
  if (!isDaytime(now, clinic.timezone)) return "night";

  const finished = wizardFinished(state.screens, state.progress);
  const rows = state.channels
    .filter((c) => c.liveAt === null)
    .map((c) => ({ channel: c.channel, status: channelNextStep(c, finished) }));
  if (finished && !rows.some((row) => isClinicAction(row.status))) return "nothing_to_do";

  const queued = await enqueuePlanNotice(
    tx.db,
    tx.clinicId,
    "setup_reminder",
    `setup_reminder:${n}`,
    {
      reminderCount: n,
      stepsLeftCount: stepsLeft(state.screens, state.progress),
      rows,
      closesOn: setupLastDay(billing.setupDeadlineAt, clinic.timezone),
      setupUrl: publicUrl(`/c/${clinic.slug}/setup`),
      helpPhoneE164: helpContacts().phoneE164,
      callUrl: state.channels.some((c) => c.channel === "voice") ? emailCallUrl() : null,
    },
  );
  return queued ? "queued" : "already_queued";
}

/** The hourly job: every clinic's due reminder. */
export async function runSetupRemindersJob(options: { now?: Date } = {}): Promise<JobOutcome> {
  const now = options.now ?? new Date();
  return runJob(
    JOB_SETUP_REMINDERS,
    async () => {
      if (publicOriginProblem())
        throw new Error("BETTER_AUTH_URL is not set: no reminder could link anywhere.");
      const counts: Partial<Record<ReminderOutcome | "failed", number>> = {};
      const bump = (key: keyof typeof counts) => {
        counts[key] = (counts[key] ?? 0) + 1;
      };
      for (const clinic of await listClinics()) {
        if (clinic.destroyedAt || clinic.offboardingStartedAt) continue;
        try {
          bump(await queueSetupReminder(clinic.id, now));
        } catch (error) {
          bump("failed");
          log.error("setup reminder failed", { clinicId: clinic.id, error: describeError(error) });
        }
      }
      return (
        `${counts.queued ?? 0} queued, ${counts.already_queued ?? 0} already queued, ` +
        `${counts.night ?? 0} waiting for daytime, ${counts.nothing_to_do ?? 0} with nothing to do, ` +
        `${counts.failed ?? 0} failed.`
      );
    },
    now,
  );
}
