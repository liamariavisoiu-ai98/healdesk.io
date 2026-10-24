import { setupLastDay } from "@/lib/clinic/setup-window";
import type { Recommendation } from "@/lib/lifecycle/recommend";

import { readLifecycleViews } from "../lifecycle-ops";

import type { InboxRow, InboxSource } from "./types";

/**
 * "Needs a decision" (design E2, owner decision D7; lane A4): every clinic
 * the lifecycle view says owes a decision (`decisionOwed`, the day-22
 * alert's own rule): a stalled setup in its window's last eight days with
 * nothing decided, or a clinic waiting on us a business day or more. One row
 * per clinic, with the watch's recommendation in plain words, due on the
 * window's last day, red once three days or fewer remain. The button opens
 * the clinic's Setup page at its Setup window card, where the decision, the
 * snooze and the extension are.
 */

/** Three days or fewer left turns the row red: the account closes at the end of the last one. */
export const DECISION_URGENT_DAYS = 3;

export function decisionHref(clinicId: string): string {
  return `/admin/clinics/${clinicId.toLowerCase()}/setup#setup-window`;
}

/** The recommendation as the end of a sentence: "extend the window by 7 days". */
export function recommendationWords(advice: Pick<Recommendation, "action" | "days">): string {
  switch (advice.action) {
    case "extend":
      return advice.days === null ? "extend the window" : `extend the window by ${days(advice.days)}`;
    case "offer_call":
      return "offer the clinic a setup call";
    case "let_close":
      return "let the account close";
    case "phone_the_clinic":
      return "phone the clinic";
    case "wait":
      return "wait";
  }
}

function days(n: number): string {
  return `${n} ${n === 1 ? "day" : "days"}`;
}

export function decisionSentence(view: {
  stage: string;
  remainingDays: number | null;
  snoozedUntil: Date | null;
  recommendation: Pick<Recommendation, "action" | "days">;
}, now: Date): string {
  const advice = recommendationWords(view.recommendation);
  // A snooze mutes the routine alerts only (D5, D7): the decision stays owed, and the row says so.
  const snoozed = view.snoozedUntil && view.snoozedUntil.getTime() > now.getTime() ? "; routine alerts are snoozed" : "";
  if (view.stage === "waiting_on_us") {
    return `The clinic has been waiting on us for over a business day; recommended: ${advice}${snoozed}.`;
  }
  const left =
    view.remainingDays === null
      ? "Setup has stalled"
      : view.remainingDays === 0
        ? "Setup has stalled and the window closes today"
        : `Setup has stalled with ${days(view.remainingDays)} left`;
  return `${left}; recommended: ${advice}${snoozed}.`;
}

export const decisionsSource: InboxSource = {
  name: "the setup decisions",
  async read(ctx) {
    const rows: InboxRow[] = [];
    const { views, failed } = await readLifecycleViews({
      actor: ctx.actor,
      request: ctx.request,
      now: ctx.now,
      partial: true,
    });
    for (const { clinic, view, ignored } of views) {
      // An internal test account (the ignore list) owes nothing.
      if (ignored || !view.decisionOwed) continue;
      // Waiting on us, the work owed is ours: the button opens the window, it does not ask the clinic to decide.
      const label = view.stage === "waiting_on_us" ? "Open setup window" : "Decide";
      rows.push({
        id: `decision:${clinic.id}`,
        kind: "decision",
        count: 1,
        sentence: decisionSentence(view, ctx.now),
        clinic: { id: clinic.id, name: clinic.name },
        button: { label, kind: "link", href: decisionHref(clinic.id) },
        tone:
          view.remainingDays !== null && view.remainingDays <= DECISION_URGENT_DAYS ? "bad" : "warn",
        dueAt: view.deadlineAt ? setupLastDay(view.deadlineAt, clinic.timezone) : null,
      });
    }
    return { rows, partial: failed > 0 ? `${failed} clinic(s) could not be read.` : undefined };
  },
};
