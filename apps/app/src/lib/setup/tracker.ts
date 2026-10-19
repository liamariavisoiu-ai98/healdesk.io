import {
  ASSISTANT_LANGUAGE_NAMES,
  audienceFor,
  isScreenedLanguage,
} from "@healdesk/catalog";

import type { CalendarConnectionView } from "@/lib/connections/google-calendar";
import { casesNotAskable } from "@/lib/engine/practice/cases";
import { whatToFix } from "@/lib/engine/practice/sections";
import { NO_PRACTICE_STATE, practicePassed, type PracticeState } from "@/lib/engine/practice/state";
import type { GoLiveSummary } from "@/lib/onboarding/go-live";
import { formatReplyBy } from "@/lib/reply-by";

import type { SetupState } from "./state";

/**
 * The build tracker on the clinic's page (plan Part E, "Tracker stages and
 * when each is done"; spec, "Stage 3"): what has happened to the clinic's
 * AYA so far, in order, each stage with its done-rule read from the data,
 * never from a screen the clinic clicked through. Talk to your AYA unlocks
 * when every stage that blocks is done, and until then its button names
 * what is left.
 *
 * The last two stages are the engine's (M4), read from the practice
 * questions (lib/engine/practice): "Assistant built" once the answers are set
 * up and a run has built AYA from them, "Practice questions passed" once the
 * latest run passed with nothing changed since; while a run is in review, the
 * date our team will be done by ("Being checked by our team; ready by
 * Tuesday 7 October", the next business day), and after a failure on the
 * clinic's own data, the section to fix and a count, never the service. The
 * calendar stage reads the connection (the calendar session's
 * getCalendarConnection) and never blocks: without a connected calendar,
 * bookings arrive as requests.
 *
 * Talk to your AYA is the preview at /c/[slug]/preview (lib/preview/talk.ts),
 * which reads this tracker on every message: Home links to it once
 * `previewUnlocked`, and it closes again while anything blocks it.
 */

/**
 * Whether Talk to your AYA exists (/c/[slug]/preview, lib/preview/talk.ts).
 * O8 tells a clinic it can talk to AYA, so it was held until there was
 * somewhere to talk to her; now there is, the hourly sweep sends it to every
 * clinic whose tracker is complete and has not had it
 * (lib/engine/practice/job.ts), and a pass sends it as it completes one.
 */
export const TALK_TO_AYA_BUILT = true;

export type StageId =
  | "agreement"
  | "payment"
  | "website"
  | "answers"
  | "calendar"
  | "built"
  | "practice_questions"
  | "go_live";

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

export function buildTracker(
  state: SetupState,
  calendar: CalendarConnectionView,
  practice: PracticeState = NO_PRACTICE_STATE,
  goLive?: GoLiveSummary,
): Tracker {
  const stages = blockingStages(state, practice);
  stages.splice(4, 0, calendarStage(calendar));
  // Home passes where go-live stands (lib/onboarding/go-live.ts), so the
  // clinic reads why it has not gone live yet, from what go-live itself
  // asks. It never blocks Talk to your AYA, which comes before it.
  if (goLive) stages.push(goLiveStage(goLive));
  const left = stages.filter((s) => s.blocks && s.state !== "done").map((s) => s.label);
  return { stages, left, previewUnlocked: left.length === 0 };
}

/** "Going live": done once the clinic is in production, otherwise the one thing go-live says. */
function goLiveStage(goLive: GoLiveSummary): Stage {
  return {
    id: "go_live",
    label: "Going live",
    state: goLive.production ? "done" : "not_done",
    detail: goLive.line,
    blocks: false,
  };
}

/**
 * The labels of the blocking stages not done: what stands between the
 * clinic and Talk to your AYA. The calendar never blocks, so it is not read.
 */
export function stagesLeft(state: SetupState, practice: PracticeState): string[] {
  return blockingStages(state, practice)
    .filter((s) => s.blocks && s.state !== "done")
    .map((s) => s.label);
}

function blockingStages(state: SetupState, practice: PracticeState): Stage[] {
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

  const built = missing.length === 0 && practice.latest !== null;
  stages.push({
    id: "built",
    label: "Assistant built",
    state: built ? "done" : "not_done",
    detail: built
      ? "AYA is built from your answers, with your prices, your hours and what she must never say."
      : missing.length > 0
        ? "We build AYA from your answers once they're set up."
        : "We're building AYA from your answers.",
    blocks: true,
  });

  stages.push(practiceStage(missing.length === 0 ? practice : NO_PRACTICE_STATE, state));

  return stages;
}

/**
 * What a pass says. While some cases cannot be asked (casesNotAskable: the
 * booking and the deposit booking, until AYA has booking tools), it names
 * the ones that were, and says the booking ones wait: a pass of the cases
 * asked is not a pass of every case, and the spec's is every case. In the
 * practice's own words for the people it serves (audienceFor).
 */
export function practicePassedDetail(state: Pick<SetupState, "clinic" | "settings">): string {
  if (casesNotAskable().length === 0) {
    return "AYA answered her practice questions about your practice, and got them right.";
  }
  const one = audienceFor(state.clinic.specialty) === "clients" ? "client" : "patient";
  const second = (state.settings?.languages ?? []).find((l) => l !== "en" && isScreenedLanguage(l));
  const asked = [
    "the line she opens with",
    "a price on your menu",
    "one that isn't",
    "a clinical question",
    `an urgent message from a ${one}`,
    `an off-topic ${one}`,
    "a question your answers don't cover",
    ...(second ? [`a conversation in ${ASSISTANT_LANGUAGE_NAMES[second]}`] : []),
  ];
  return `AYA passed the practice questions she can be asked: ${asked.slice(0, -1).join(", ")} and ${asked[asked.length - 1]}. The ones about booking and deposits wait for her booking tools.`;
}

/** "Practice questions passed", from the latest run and whether anything changed since. */
function practiceStage(practice: PracticeState, state: Pick<SetupState, "clinic" | "settings">): Stage {
  const stage = { id: "practice_questions" as const, label: "Practice questions passed", blocks: true };
  const latest = practice.latest;
  if (practicePassed(practice)) {
    return {
      ...stage,
      state: "done",
      detail: latest?.overridden
        ? "Our team checked AYA's answers with you and approved them."
        : practicePassedDetail(state),
    };
  }
  if (practice.pending) {
    return {
      ...stage,
      state: "not_done",
      detail:
        latest === null
          ? "AYA is answering her practice questions about your practice."
          : "AYA is answering her practice questions again, with your latest change.",
    };
  }
  if (latest?.status === "in_review") {
    return {
      ...stage,
      state: "not_done",
      detail: latest.reviewDueOn
        ? `Being checked by our team; ready by ${formatReplyBy(latest.reviewDueOn)}.`
        : "Being checked by our team.",
    };
  }
  if (latest?.status === "failed") {
    return {
      ...stage,
      state: "not_done",
      detail: latest.failedSection
        ? `One thing to fix: ${whatToFix(latest.failedSection, latest.failedCount ?? 1)}. Fix it there and she answers them again.`
        : "Our team is putting right one of her answers on our side, and she answers them again after.",
    };
  }
  if (latest?.status === "error") {
    return { ...stage, state: "not_done", detail: "Her practice questions couldn't finish, so she answers them again shortly." };
  }
  return {
    ...stage,
    state: "not_done",
    detail: "AYA answers practice questions about your practice before anyone else talks to her.",
  };
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
