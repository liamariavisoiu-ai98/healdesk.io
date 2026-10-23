import type { clinicLifecycle } from "@/db/schema";
import { clinicLocalDate } from "@/lib/clinic/closures";
import { setupLastDay, setupWindowStart } from "@/lib/clinic/setup-window";

import { clinicWavesOf, type LedgerWave } from "./ledger";
import { DECIDE_WITHIN_DAYS, type Recommendation } from "./recommend";
import { remainingDays, windowDay } from "./stage";
import { businessDaysBetween, isStalled, recommendationFor, currentFailures } from "./waves";

/**
 * One clinic's lifecycle as the console and the digest read it: the stored
 * row, the days left in its window, whether a decision is owed, and the
 * recommendation (lib/lifecycle/recommend.ts). Pure.
 */

export type LifecycleView = {
  stage: ClinicLifecycleRow["stage"];
  stageSince: Date;
  stepsLeft: number;
  channelsWaiting: number;
  lastProgressAt: Date | null;
  deadlineAt: Date | null;
  remainingDays: number | null;
  decision: ClinicLifecycleRow["decision"];
  decidedBy: string | null;
  decidedAt: Date | null;
  snoozedUntil: Date | null;
  snoozedBy: string | null;
  undeliveredCount: number;
  decisionOwed: boolean;
  recommendation: Recommendation;
};

export type ClinicLifecycleRow = typeof clinicLifecycle.$inferSelect;

const SETUP = new Set(["not_started", "in_setup"]);
/** The stages a setup window still closes: setup itself, and waiting on us. */
const WINDOWED = new Set(["not_started", "in_setup", "waiting_on_us"]);

export function lifecycleView(
  row: ClinicLifecycleRow,
  ledger: readonly LedgerWave[],
  timeZone: string,
  now: Date,
): LifecycleView {
  const day =
    row.deadlineAt && WINDOWED.has(row.stage)
      ? windowDay(setupWindowStart(row.deadlineAt, timeZone), clinicLocalDate(now, timeZone))
      : null;
  const clinicWaves = clinicWavesOf(ledger);
  const recommendation = recommendationFor({
    stage: row.stage,
    stageSince: row.stageSince,
    now,
    windowDay: day,
    lastDay: row.deadlineAt ? setupLastDay(row.deadlineAt, timeZone) : null,
    stepsLeft: row.stepsLeft,
    channelsWaiting: row.channelsWaiting,
    answeredAScreen: row.stage !== "not_started",
    lastProgressAt: row.lastProgressAt,
    decision: row.decision,
    snoozedUntil: row.snoozedUntil,
    clinicWaves,
    recorded: new Set(),
  });
  const left = day === null ? null : remainingDays(day);
  // The day-22 alert's rule (D7): a stalled setup in its last eight days,
  // with nothing decided, or decided before this window's band escalated
  // again (more time was given or offered, and the new window stalled too);
  // or a clinic waiting on us a business day or more.
  const answeredAScreen = row.stage !== "not_started";
  const lastDay = row.deadlineAt ? setupLastDay(row.deadlineAt, timeZone) : null;
  const escalatedAgain = ledger.some(
    (w) =>
      w.target === "slack" &&
      w.escalated &&
      lastDay !== null &&
      /^day_(22|27|30):/.test(w.wave) &&
      w.wave.endsWith(`:${lastDay}`) &&
      (row.decidedAt === null || w.queuedAt > row.decidedAt),
  );
  const undecided =
    row.decision === "none" ||
    ((row.decision === "extended" || row.decision === "extension_offered") && escalatedAgain);
  const decisionOwed =
    (SETUP.has(row.stage) &&
      left !== null &&
      left <= DECIDE_WITHIN_DAYS &&
      undecided &&
      isStalled({
        stepsLeft: row.stepsLeft,
        channelsWaiting: row.channelsWaiting,
        answeredAScreen,
      })) ||
    (row.stage === "waiting_on_us" && businessDaysBetween(row.stageSince, now) >= 1);
  return {
    stage: row.stage,
    stageSince: row.stageSince,
    stepsLeft: row.stepsLeft,
    channelsWaiting: row.channelsWaiting,
    lastProgressAt: row.lastProgressAt,
    deadlineAt: row.deadlineAt,
    remainingDays: left,
    decision: row.decision,
    decidedBy: row.decidedBy,
    decidedAt: row.decidedAt,
    snoozedUntil: row.snoozedUntil,
    snoozedBy: row.snoozedBy,
    undeliveredCount: currentFailures(clinicWaves, now).length,
    decisionOwed,
    recommendation,
  };
}
