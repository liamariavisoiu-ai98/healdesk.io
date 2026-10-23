import type { LifecycleDecision, LifecycleStage } from "@/db/schema";

/**
 * What healdesk should do about one clinic, from the facts alone (the owner's
 * request of 23 October 2026: "Claude should audit the state and propose
 * recommendations"). Pure rules over counts and days, with a reason built
 * from fixed sentences and those numbers: no model, no free text, nothing a
 * clinic typed. The same answer feeds the day-22 alert and the console's
 * lifecycle list.
 *
 * It only proposes. Days a clinic waited on us never extend its deadline by
 * themselves (owner decision D6): an extension is the operator's button.
 */

export const RECOMMENDATIONS = [
  "extend",
  "offer_call",
  "let_close",
  "wait",
  "phone_the_clinic",
] as const;
export type RecommendationAction = (typeof RECOMMENDATIONS)[number];

export type Recommendation = {
  action: RecommendationAction;
  /** Days to extend by, for `extend`; null otherwise. */
  days: number | null;
  /** One sentence from the fixed templates below. */
  reason: string;
};

export type RecommendFacts = {
  stage: LifecycleStage;
  /** Wizard steps plus channel actions the clinic still owes (owedSteps). */
  stepsLeft: number;
  /** Days left in the setup window, or null when there is no window. */
  remainingDays: number | null;
  /** Whole days since the clinic last made progress, or null when it never has. */
  noProgressDays: number | null;
  /** While waiting on us: whole calendar days and business days in that stage; else 0. */
  waitingOnUsDays: number;
  waitingOnUsBusinessDays: number;
  /** While partly live: whole days in that stage; else 0. */
  partlyLiveDays: number;
  /** Clinic reminders that bounced or failed since the last one that arrived. */
  undeliveredCount: number;
  /**
   * Whether anyone at the clinic has answered or skipped a setup screen. Not
   * a sign-in: nothing records one, so this is the nearest fact.
   */
  answeredAScreen: boolean;
  decision: LifecycleDecision;
};

/** No progress for this many days makes a setup stale. */
export const STALE_AFTER_DAYS = 5;
/** And for this many, with two steps or more left near the end, not worth extending. */
export const GIVE_UP_AFTER_DAYS = 10;
/** The window's last eight days: from day 22, the decision is owed. */
export const DECIDE_WITHIN_DAYS = 8;

function n(count: number, one: string, many: string = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

function sinceProgress(days: number | null): string {
  return days === null ? "no progress yet" : `no progress for ${n(days, "day")}`;
}

function rec(
  action: RecommendationAction,
  reason: string,
  days: number | null = null,
): Recommendation {
  return { action, days, reason };
}

export function recommend(f: RecommendFacts): Recommendation {
  if (f.stage === "closed")
    return rec("wait", "The account has ended: there is nothing to decide.");
  if (f.stage === "live") return rec("wait", "Every channel is live: there is nothing to decide.");

  if (f.undeliveredCount > 0) {
    return rec(
      "phone_the_clinic",
      `${n(f.undeliveredCount, "reminder")} to the clinic's address did not arrive, so email is not reaching them: phone the clinic.`,
    );
  }

  if (f.stage === "waiting_on_us") {
    const closing = f.remainingDays !== null && f.remainingDays <= 3;
    if (f.waitingOnUsBusinessDays >= 2 || closing) {
      const days = Math.max(1, f.waitingOnUsDays);
      return rec(
        "extend",
        closing
          ? `The clinic is waiting on us and its window closes in ${n(f.remainingDays!, "day")}: extend it by the ${n(days, "day")} it waited.`
          : `The clinic has waited on us for ${n(days, "day")}: finish our side and give those days back.`,
        days,
      );
    }
    return rec("wait", "The clinic has done its part: finish our side.");
  }

  if (f.stage === "partly_live") {
    if (f.partlyLiveDays >= 14 && f.stepsLeft > 0) {
      return rec(
        "offer_call",
        `A channel is live and ${n(f.stepsLeft, "step")} on another has waited ${n(f.partlyLiveDays, "day")}: offer a five-minute call.`,
      );
    }
    return rec("wait", "A channel is live, so the setup window no longer closes the account.");
  }

  // not_started or in_setup: the clinic owes a step.
  if (f.decision === "let_close")
    return rec("let_close", "You decided to let it close at the end of its window.");
  const stale = f.noProgressDays === null || f.noProgressDays >= STALE_AFTER_DAYS;
  const remaining = f.remainingDays;

  // Already given more time, or offered it: never propose extending again.
  if (f.decision === "extended") {
    if (stale) {
      return rec(
        "phone_the_clinic",
        `Already extended, with ${n(f.stepsLeft, "step")} left and ${sinceProgress(f.noProgressDays)}: phone the clinic.`,
      );
    }
    return rec(
      "wait",
      `Already extended; progress ${n(f.noProgressDays ?? 0, "day")} ago and ${n(f.stepsLeft, "step")} left.`,
    );
  }
  if (f.decision === "extension_offered") {
    return rec(
      stale ? "phone_the_clinic" : "wait",
      stale
        ? `More time was offered and ${sinceProgress(f.noProgressDays)}: phone the clinic to agree it.`
        : "More time was offered: extend the setup window from its Billing page once they accept.",
    );
  }

  if (remaining === null || remaining > DECIDE_WITHIN_DAYS) {
    const elapsed = remaining === null ? null : 30 - remaining;
    if (!f.answeredAScreen && elapsed !== null && elapsed >= 7) {
      return rec(
        "phone_the_clinic",
        `Nobody has answered a setup screen in ${n(elapsed, "day")}: phone the clinic.`,
      );
    }
    if (stale) {
      return rec(
        "offer_call",
        `${n(f.stepsLeft, "step")} left and ${sinceProgress(f.noProgressDays)}: offer a five-minute call.`,
      );
    }
    return rec(
      "wait",
      `Progress ${n(f.noProgressDays ?? 0, "day")} ago, ${n(f.stepsLeft, "step")} left${remaining === null ? "" : ` and ${n(remaining, "day")} to go`}.`,
    );
  }

  if (!f.answeredAScreen) {
    // Not a reason to let it close on its own: the clinic may have read
    // everything and not clicked yet.
    return rec(
      "phone_the_clinic",
      `Nobody has answered a setup screen yet and ${n(remaining, "day")} ${remaining === 1 ? "is" : "are"} left: phone the clinic.`,
    );
  }
  if (f.stepsLeft <= 1) {
    if (!stale) {
      return rec(
        "extend",
        `${n(f.stepsLeft, "step")} left and progress ${n(f.noProgressDays ?? 0, "day")} ago: 7 more days should be enough.`,
        7,
      );
    }
    return rec(
      "offer_call",
      `${n(f.stepsLeft, "step")} left and ${sinceProgress(f.noProgressDays)}: offer a five-minute call to finish it.`,
    );
  }
  if (!stale) {
    return rec(
      "extend",
      `${n(f.stepsLeft, "step")} left and progress ${n(f.noProgressDays ?? 0, "day")} ago: 14 more days matches their pace.`,
      14,
    );
  }
  if (f.noProgressDays === null || f.noProgressDays >= GIVE_UP_AFTER_DAYS) {
    return rec(
      "let_close",
      `${n(f.stepsLeft, "step")} left and ${sinceProgress(f.noProgressDays)}: let it close unless they reply.`,
    );
  }
  return rec(
    "offer_call",
    `${n(f.stepsLeft, "step")} left and ${sinceProgress(f.noProgressDays)}: offer a five-minute call.`,
  );
}
