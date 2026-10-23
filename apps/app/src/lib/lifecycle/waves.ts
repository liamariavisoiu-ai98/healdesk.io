import type { LifecycleDecision, LifecycleStage } from "@/db/schema";
import { addBusinessDays } from "@/lib/incidents/reporting-rules";
import type { OpsEvent } from "@/lib/ops/notify";

import { recommend, STALE_AFTER_DAYS, type Recommendation } from "./recommend";
import { remainingDays, wholeDays } from "./stage";

/**
 * The ops waves (design E2, step 4): when the lifecycle watch tells ops about
 * a clinic, and whether it is an escalation. Pure: the facts and the ledger
 * are read by lib/lifecycle/watch.ts, and the clock is the caller's.
 *
 * Routine waves go to Slack alone; an escalation goes to Slack with a siren
 * and to the ops address too (owner decision D5: the ops email is for
 * escalations). None of them goes to the clinic: the six spec reminders stay
 * the setup-reminders job's, unchanged (D4), and the watch only records them.
 *
 * Only the wave of the band a clinic is in now fires, never the ones it
 * passed while the job was off, so switching the job on never floods the
 * channel; and each fires once, by its key in the ledger. The day-22, 27 and
 * 30 waves carry the window's last day in their key, so an extension that
 * moves the window re-arms them; days 7 and 15 do not, so it does not repeat
 * them. A waiting-on-us or partly-live wave carries the moment its stage
 * began, so each stay in the stage has its own.
 *
 * A snooze mutes the routine, Slack-only waves until it ends, recorded as
 * skipped so they never fire late. It never mutes an escalation, and never
 * touches the clinic's own reminders. Deciding to let a setup close records
 * the day-27 and day-30 waves as skipped.
 */

/** The lifecycle watch's alerts. Each is an OPS_EVENTS name (lib/ops/notify.ts). */
export const LIFECYCLE_EVENTS = [
  "lifecycle_no_progress",
  "lifecycle_closing_soon",
  "lifecycle_decision_due",
  "lifecycle_waiting_on_us",
  "lifecycle_waiting_on_us_long",
  "lifecycle_channel_waiting",
  "lifecycle_reminder_undelivered",
  "lifecycle_reminders_unanswered",
  "lifecycle_closing_waiting_on_us",
] as const satisfies readonly OpsEvent[];
export type LifecycleEvent = (typeof LIFECYCLE_EVENTS)[number];

/** The escalations: Slack opens them with a siren, and the ops address gets them too. */
export const LIFECYCLE_ESCALATIONS: ReadonlySet<string> = new Set<LifecycleEvent>([
  "lifecycle_decision_due",
  "lifecycle_waiting_on_us_long",
  "lifecycle_reminder_undelivered",
  "lifecycle_reminders_unanswered",
  "lifecycle_closing_waiting_on_us",
]);

/** A clinic reminder in the ledger, oldest first, with its outcome. */
export type ClinicWave = {
  wave: string;
  noticeId: string;
  /** Numbered reminders (setup_reminder:<n>) only take part in "two in a row". */
  numbered: boolean;
  sentAt: Date | null;
  queuedAt: Date;
  /** The clinic's stage when the watch recorded it. */
  stage: LifecycleStage;
  outcome: WaveOutcome;
};

/** Only reminders queued this recently can raise an undelivered escalation. */
export const UNDELIVERED_LOOKBACK_DAYS = 14;

function undelivered(w: ClinicWave): boolean {
  return w.outcome === "bounced" || w.outcome === "failed";
}

/**
 * The clinic's current failures: reminders that did not arrive since the
 * last one that did, queued within the last UNDELIVERED_LOOKBACK_DAYS. A
 * later delivered reminder means the address works again, and an old bounce
 * stops counting, so the alert, the console and the recommendation all read
 * this one list and agree. Whatever the clinic's stage was when each was
 * recorded: a bounce counts the same after the stage moves.
 */
export function currentFailures(waves: readonly ClinicWave[], now: Date): ClinicWave[] {
  let last = -1;
  waves.forEach((w, i) => {
    if (w.outcome === "delivered") last = i;
  });
  const cutoff = now.getTime() - UNDELIVERED_LOOKBACK_DAYS * 86_400_000;
  return waves.slice(last + 1).filter((w) => undelivered(w) && w.queuedAt.getTime() >= cutoff);
}

export type WaveOutcome = "delivered" | "sent" | "pending" | "bounced" | "failed" | "skipped";

export type WaveFacts = {
  stage: LifecycleStage;
  stageSince: Date;
  now: Date;
  /** The window's day (0 to 30) and last day (an ISO date), or null without a window. */
  windowDay: number | null;
  lastDay: string | null;
  stepsLeft: number;
  channelsWaiting: number;
  answeredAScreen: boolean;
  lastProgressAt: Date | null;
  decision: LifecycleDecision;
  snoozedUntil: Date | null;
  clinicWaves: readonly ClinicWave[];
  /** Ops waves already in the ledger, as `${wave}|${target}`. */
  recorded: ReadonlySet<string>;
};

export type WaveFields = Record<string, string | number>;

export type DueWave = {
  wave: string;
  event: LifecycleEvent;
  escalated: boolean;
  fields: WaveFields;
  /** Recorded, not raised: muted by a snooze, or stopped by the decision to let it close. */
  skip: "snoozed" | "let_close" | null;
  /** For an undelivered reminder: the notice, so an address alert already raised can carry it. */
  noticeId?: string;
  noticeSentAt?: Date | null;
};

const HOUR_MS = 3_600_000;

/** The facts behind the recommendation, from the same inputs the waves read. */
export function recommendationFor(f: WaveFacts): Recommendation {
  const waitingDays = f.stage === "waiting_on_us" ? wholeDays(f.stageSince, f.now) : 0;
  return recommend({
    stage: f.stage,
    stepsLeft: f.stepsLeft + f.channelsWaiting,
    remainingDays: f.windowDay === null ? null : remainingDays(f.windowDay),
    noProgressDays: f.lastProgressAt ? wholeDays(f.lastProgressAt, f.now) : null,
    waitingOnUsDays: waitingDays,
    waitingOnUsBusinessDays:
      f.stage === "waiting_on_us" ? businessDaysBetween(f.stageSince, f.now) : 0,
    partlyLiveDays: f.stage === "partly_live" ? wholeDays(f.stageSince, f.now) : 0,
    undeliveredCount: currentFailures(f.clinicWaves, f.now).length,
    answeredAScreen: f.answeredAScreen,
    decision: f.decision,
  });
}

/** Whole business days from `from` to `to` (addBusinessDays' weekdays, in UTC). */
export function businessDaysBetween(from: Date, to: Date): number {
  let days = 0;
  while (days < 60 && addBusinessDays(from, days + 1).getTime() <= to.getTime()) days += 1;
  return days;
}

/** Whether a setup is stalled (owner decision D7): two steps or more owed, or no setup screen answered. */
export function isStalled(f: {
  stepsLeft: number;
  channelsWaiting: number;
  answeredAScreen: boolean;
}): boolean {
  return f.stepsLeft + f.channelsWaiting >= 2 || !f.answeredAScreen;
}

function isStale(f: WaveFacts): boolean {
  return f.lastProgressAt === null || wholeDays(f.lastProgressAt, f.now) >= STALE_AFTER_DAYS;
}

/** Every wave due now and not yet in the ledger, routine and escalation alike. */
export function dueWaves(f: WaveFacts): DueWave[] {
  if (f.stage === "closed" || f.stage === "live") return [];
  const due: Omit<DueWave, "skip">[] = [];
  const owed = f.stepsLeft + f.channelsWaiting;
  const noProgress = f.lastProgressAt ? wholeDays(f.lastProgressAt, f.now) : null;
  const base: WaveFields = { stepsLeftCount: owed };
  if (noProgress !== null) base.noProgressDays = noProgress;

  if ((f.stage === "not_started" || f.stage === "in_setup") && f.windowDay !== null && f.lastDay) {
    const day = f.windowDay;
    const fields: WaveFields = { ...base, setupDays: day, remainingDays: remainingDays(day) };
    if (day >= 7 && day < 15 && isStale(f)) {
      due.push({ wave: "day_7", event: "lifecycle_no_progress", escalated: false, fields });
    } else if (day >= 15 && day < 22 && isStale(f)) {
      due.push({ wave: "day_15", event: "lifecycle_no_progress", escalated: false, fields });
    } else if (day >= 22 && day <= 30) {
      const band = day >= 30 ? "day_30" : day >= 27 ? "day_27" : "day_22";
      const stalled = isStalled(f);
      const advice = recommendationFor(f);
      due.push({
        wave: `${band}:${f.lastDay}`,
        event: stalled ? "lifecycle_decision_due" : "lifecycle_closing_soon",
        escalated: stalled,
        fields: {
          ...fields,
          decision: f.decision,
          recommendation: advice.action,
          ...(advice.days !== null ? { extendDays: advice.days } : {}),
        },
      });
    }
  }

  // A clinic waiting on us still closes at the end of its window (the
  // reconcile's close_setup): days 27 and 30 warn, escalated, under their
  // own keys, so a clinic that finished its part on day 28 is still warned.
  // A decision to let it close does not silence them: the clinic has done
  // its part since, and a closure now would be our delay.
  if (f.stage === "waiting_on_us" && f.windowDay !== null && f.lastDay && f.windowDay >= 27) {
    const band = f.windowDay >= 30 ? "wait_close_30" : "wait_close_27";
    const advice = recommendationFor(f);
    due.push({
      wave: `${band}:${f.lastDay}`,
      event: "lifecycle_closing_waiting_on_us",
      escalated: true,
      fields: {
        remainingDays: remainingDays(f.windowDay),
        waitedDays: wholeDays(f.stageSince, f.now),
        decision: f.decision,
        recommendation: advice.action,
        ...(advice.days !== null ? { extendDays: advice.days } : {}),
      },
    });
  }

  if (f.stage === "waiting_on_us") {
    const since = f.stageSince;
    const key = since.toISOString();
    const waitedHours = Math.floor((f.now.getTime() - since.getTime()) / HOUR_MS);
    const waitedDays = wholeDays(since, f.now);
    const fields: WaveFields = { waitedHours, waitedDays };
    if (f.now >= addBusinessDays(since, 2)) {
      due.push({
        wave: `wait_2bd:${key}`,
        event: "lifecycle_waiting_on_us_long",
        escalated: true,
        fields: { ...fields, recommendation: "extend", extendDays: Math.max(1, waitedDays) },
      });
    } else if (f.now >= addBusinessDays(since, 1)) {
      due.push({
        wave: `wait_1bd:${key}`,
        event: "lifecycle_waiting_on_us",
        escalated: false,
        fields,
      });
    } else if (f.now.getTime() - since.getTime() >= 4 * HOUR_MS) {
      due.push({
        wave: `wait_4h:${key}`,
        event: "lifecycle_waiting_on_us",
        escalated: false,
        fields,
      });
    }
  }

  if (f.stage === "partly_live" && f.channelsWaiting > 0) {
    const key = f.stageSince.toISOString();
    const waitedDays = wholeDays(f.stageSince, f.now);
    const fields: WaveFields = { waitedDays, channelsWaitingCount: f.channelsWaiting };
    if (waitedDays >= 14) {
      due.push({
        wave: `live_14:${key}`,
        event: "lifecycle_channel_waiting",
        escalated: false,
        fields,
      });
    } else if (waitedDays >= 7) {
      due.push({
        wave: `live_7:${key}`,
        event: "lifecycle_channel_waiting",
        escalated: false,
        fields,
      });
    }
  }

  // Escalations from the clinic's own reminders. One for its current
  // failures (currentFailures), keyed on the last delivered reminder, so it
  // is raised again only after a later one arrives and another fails.
  const lastDelivered = [...f.clinicWaves].reverse().find((w) => w.outcome === "delivered");
  const failing = currentFailures(f.clinicWaves, f.now);
  if (failing.length > 0) {
    due.push({
      wave: `undelivered:${lastDelivered?.noticeId ?? "none"}`,
      event: "lifecycle_reminder_undelivered",
      escalated: true,
      fields: { stepsLeftCount: owed },
      noticeId: failing[0]!.noticeId,
      noticeSentAt: failing[0]!.sentAt,
    });
  }
  if (f.stage === "not_started" || f.stage === "in_setup") {
    const delivered = f.clinicWaves.filter(
      (w) => w.numbered && w.outcome === "delivered" && w.sentAt,
    );
    const [first, second] = delivered.slice(-2);
    if (first && second && (f.lastProgressAt === null || f.lastProgressAt < first.sentAt!)) {
      // Once until the clinic moves: keyed on its last progress, or "never".
      due.push({
        wave: `unanswered:${f.lastProgressAt?.toISOString() ?? "never"}`,
        event: "lifecycle_reminders_unanswered",
        escalated: true,
        fields: { ...base, reminderCount: delivered.length },
      });
    }
  }

  const snoozed = f.snoozedUntil !== null && f.snoozedUntil > f.now;
  return due
    .filter((w) => !f.recorded.has(`${w.wave}|slack`))
    .map((w) => ({
      ...w,
      skip:
        f.decision === "let_close" && /^day_(27|30):/.test(w.wave)
          ? "let_close"
          : snoozed && !w.escalated
            ? "snoozed"
            : null,
    }));
}

/** The ledger targets a wave is recorded under: Slack always, and the ops address for an escalation. */
export function targetsOf(wave: Pick<DueWave, "escalated">): ("slack" | "ops_email")[] {
  return wave.escalated ? ["slack", "ops_email"] : ["slack"];
}
