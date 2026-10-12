import type { CalendarConnectionView } from "@/lib/connections/google-calendar";

import type { SetupState } from "./state";

/**
 * The build tracker on the clinic's page (plan Part E, "Tracker stages and
 * when each is done"; spec, "Stage 3"): what has happened to the clinic's
 * AYA so far, in order, each stage with its done-rule read from the data,
 * never from a screen the clinic clicked through. Talk to your AYA unlocks
 * when every stage that blocks is done, and until then its button names
 * what is left.
 *
 * The last two stages are the engine's (M4): nothing in this build builds an
 * assistant or runs its practice questions, so they are honestly not done,
 * and the preview stays locked. The calendar stage reads the connection
 * (the calendar session's getCalendarConnection) and never blocks: without a
 * connected calendar, bookings arrive as requests.
 */

export type StageId =
  "agreement" | "payment" | "website" | "answers" | "calendar" | "built" | "practice_questions";

export type StageState = "done" | "not_done" | "info";

export type Stage = {
  id: StageId;
  label: string;
  state: StageState;
  /** One line: what it means, or what is missing. */
  detail: string;
  /** Whether Talk to your AYA waits for it. */
  blocks: boolean;
};

export type Tracker = {
  stages: Stage[];
  /** The labels of the blocking stages not done, in order: what the locked button names. */
  left: string[];
  previewUnlocked: boolean;
};

/**
 * What "Your answers set up" needs at the spec's minimum: services with
 * prices, hours, the most-asked question. Each is the clinic's own answer,
 * not what we filled in: hours count once confirmed, and prices once the
 * services screen is saved, because the price guardrail quotes only the
 * clinic's list, and a website read (or our starting list) is not that until
 * the clinic has checked it.
 */
export function answersMissing(
  state: Pick<SetupState, "knowledge" | "clinic" | "progress">,
): string[] {
  const missing: string[] = [];
  if (!state.knowledge.services.some((s) => s.priceFromUsd !== null))
    missing.push("a service with its price");
  else if (state.progress.get("services")?.outcome !== "done")
    missing.push("a check of your prices");
  if (!state.clinic.openingHours || !state.clinic.onboarding.hours_confirmed)
    missing.push("your hours");
  if (!state.knowledge.mostAsked) missing.push("your most-asked question");
  return missing;
}

export function buildTracker(state: SetupState, calendar: CalendarConnectionView): Tracker {
  const stages: Stage[] = [];

  stages.push({
    id: "agreement",
    label: "Agreement signed",
    state: state.clinic.agreementKind ? "done" : "not_done",
    detail: state.clinic.agreementKind
      ? state.clinic.agreementKind === "dpa"
        ? "Your data protection agreement is in force."
        : "Your business associate agreement is in force."
      : "We're attaching your signed agreement.",
    blocks: true,
  });

  const paid =
    state.billing !== null &&
    (state.billing.firstPaidAt !== null || state.billing.status === "active");
  stages.push({
    id: "payment",
    label: "Payment",
    state: paid ? "done" : "not_done",
    detail: paid ? "Your setup fee is paid." : "We're confirming your payment.",
    blocks: true,
  });

  const missing = answersMissing(state);
  const read = state.clinic.siteProfile !== null;
  stages.push({
    id: "website",
    label: "Your website read",
    state: read || missing.length === 0 ? "done" : "not_done",
    detail: read
      ? `We read ${state.clinic.siteProfile!.website}.`
      : state.clinic.website
        ? missing.length === 0
          ? "We couldn't read your website, so you answered three questions instead."
          : "We couldn't read your website, so setup asks three questions instead."
        : missing.length === 0
          ? "No website, so you answered three questions instead."
          : "No website, so setup asks three questions instead.",
    blocks: true,
  });

  stages.push({
    id: "answers",
    label: "Your answers set up",
    state: missing.length === 0 ? "done" : "not_done",
    detail:
      missing.length === 0
        ? "Services with prices, your hours and your most-asked question."
        : `Still needed in setup: ${joinWords(missing)}.`,
    blocks: true,
  });

  stages.push(calendarStage(calendar));

  stages.push({
    id: "built",
    label: "Assistant built",
    state: "not_done",
    detail: "We build AYA from your answers once they're set up.",
    blocks: true,
  });

  stages.push({
    id: "practice_questions",
    label: "Practice questions passed",
    state: "not_done",
    detail: "AYA answers practice questions about your practice before anyone else talks to her.",
    blocks: true,
  });

  const left = stages.filter((s) => s.blocks && s.state !== "done").map((s) => s.label);
  return { stages, left, previewUnlocked: left.length === 0 };
}

/**
 * "Calendar connected" once a connection is healthy (active, or degraded by
 * a passing failure); otherwise what bookings do without it. Never blocks.
 */
function calendarStage(calendar: CalendarConnectionView): Stage {
  if (calendar.status === "active" || calendar.status === "degraded") {
    return {
      id: "calendar",
      label: "Calendar connected",
      state: "done",
      detail: calendar.account.email
        ? `Connected as ${calendar.account.email}.`
        : "Your Google Calendar is connected.",
      blocks: false,
    };
  }
  return {
    id: "calendar",
    label: "Calendar",
    state: "info",
    detail:
      calendar.status === "error"
        ? "Your calendar connection stopped working, so bookings arrive as requests your team confirms until you reconnect it."
        : "Bookings arrive as requests your team confirms.",
    blocks: false,
  };
}

/** "a, b and c". */
export function joinWords(items: readonly string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}
