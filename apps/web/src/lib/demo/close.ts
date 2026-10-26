import { PACKAGES, type Package, type Plan, planFor } from "@healdesk/catalog";

import { type SetupOffer, setupDueUsd } from "@/lib/checkout/review";

import type { WeekSchedule } from "./opening-hours";

import { estimate, type RoiInputs, suggestedSteps, WEEKS_PER_MONTH } from "./roi";

/**
 * The personalised demo's close: which version of it a demo shows, the one
 * package it recommends, and the setup figures beside every way in.
 *
 * ## Two closes, split by demo
 *
 * `control` is the page as it was on 26 October 2026; `close` is the redesign
 * (the close card after a conversation, the coverage modes, the offer in
 * dollars). The split is a hash of the slug, so one demo always shows the
 * same close to everyone who opens it, its owner and their partner alike,
 * and the conversion of each is read per demo (lib/demo/events.ts):
 * demo viewed → "Activate my AYA" pressed → paid (the row's `claimed`).
 * `DEMO_CLOSE_SPLIT` forces one for every demo: `close`, `control`, or
 * `split` (the default).
 *
 * ## One package, at this clinic's steps
 *
 * The catalog's own "Recommended" package, priced at the steps the clinic's
 * volume suggests (lib/demo/roi.ts `suggestedSteps`), not the catalog's
 * floor: a "from $140" no clinic would buy is not a price. The owner moves
 * the inputs on the page and the price, the estimate and the plan the button
 * opens checkout on all move with them.
 *
 * ## The setup figures are the server's
 *
 * The share and its end come from the demo row (`demoSetupCredit`,
 * `demoOfferEndsAt`); the dollars are `setupDueUsd`, the figure the Stripe
 * coupon takes off. Nothing here decides an offer: /api/checkout does.
 */

export type CloseVariant = "close" | "control";

/** FNV-1a, 32-bit: stable across processes, so a demo never changes close. */
function hash(value: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function demoVariant(slug: string, split: string | undefined = process.env.DEMO_CLOSE_SPLIT): CloseVariant {
  if (split === "close" || split === "control") return split;
  return hash(slug) % 2 === 0 ? "close" : "control";
}

/** The package a demo recommends: the catalog's own "Recommended". */
export function recommendedPackage(): Package {
  return PACKAGES.find((p) => p.highlight) ?? PACKAGES[0]!;
}

/** The demo's offer as the page shows it: its share, and when it ends (null once it has). */
export type DemoOfferTerms = { percent: number; endsAt: string | null };

export type SetupFigures = {
  /** The list setup fee. */
  listUsd: number;
  /** What the buyer pays today: the list fee once the offer has ended. */
  dueUsd: number;
  savedUsd: number;
  /** The share off while the offer holds; null once it has ended. */
  percent: number | null;
  endsAt: string | null;
};

export function setupFigures(plan: Pick<Plan, "setupFeeUsd">, terms: DemoOfferTerms, now: number = Date.now()): SetupFigures {
  const live = terms.endsAt !== null && Date.parse(terms.endsAt) > now;
  const offer: SetupOffer | null = live
    ? { kind: "demo", endsAt: terms.endsAt!, percentOfSetupFee: terms.percent }
    : null;
  const dueUsd = setupDueUsd(plan, offer);
  return {
    listUsd: plan.setupFeeUsd,
    dueUsd,
    savedUsd: plan.setupFeeUsd - dueUsd,
    percent: live ? terms.percent : null,
    endsAt: live ? terms.endsAt : null,
  };
}

export type Recommendation = {
  plan: Plan;
  /** Monthly, at the suggested steps. */
  monthlyUsd: number;
  setup: SetupFigures;
  /** Booked value a month and the rest of the estimate, from the same inputs. */
  estimate: ReturnType<typeof estimate>;
};

/** The recommended package at the steps the inputs suggest, and what it costs and could book. */
export function recommendation(inputs: RoiInputs, terms: DemoOfferTerms, now: number = Date.now()): Recommendation {
  const pkg = recommendedPackage();
  const plan = planFor(pkg.id, suggestedSteps(inputs));
  return {
    plan,
    monthlyUsd: plan.monthlyUsd,
    setup: setupFigures(plan, terms, now),
    estimate: estimate(plan, inputs),
  };
}

/** The calls and messages a month AYA would pick up, from the owner's own weekly figures. */
export function enquiriesPerMonth(inputs: Pick<RoiInputs, "missedCallsPerWeek" | "missedMessagesPerWeek">): number {
  return Math.round((inputs.missedCallsPerWeek + inputs.missedMessagesPerWeek) * WEEKS_PER_MONTH);
}

/** The three voice coverage modes (v1 spec, "Voice coverage"), overflow and after hours the default. */
export const COVERAGE_MODES = [
  { id: "after-hours", label: "After hours only" },
  { id: "overflow", label: "Overflow + after hours", note: "Default" },
  { id: "all", label: "All calls" },
] as const;

export type CoverageModeId = (typeof COVERAGE_MODES)[number]["id"];

const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

/** "9:42pm", "10am": minutes after midnight, as a clinic's sign would print them. */
export function clockLabel(minutes: number): string {
  const h = Math.floor(minutes / 60) % 24;
  const m = minutes % 60;
  const suffix = h < 12 ? "am" : "pm";
  const twelve = h % 12 === 0 ? 12 : h % 12;
  return m ? `${twelve}:${String(m).padStart(2, "0")}${suffix}` : `${twelve}${suffix}`;
}

function isOpen(schedule: WeekSchedule, day: number, minute: number): boolean {
  return (schedule.days[day] ?? []).some(([a, b]) => minute >= a && minute < b);
}

/** Open hours a week, to a tenth, from the schedule's spans. */
export function openHoursOf(schedule: WeekSchedule): number {
  const minutes = schedule.days.reduce((sum, spans) => sum + spans.reduce((s, [a, b]) => s + (b - a), 0), 0);
  return Math.round((minutes / 60) * 10) / 10;
}

export type CoverageExample = { day: number; minute: number; label: string; result: string };

/**
 * Two or three calls AYA would take, labelled "Example" on the page, never
 * presented as calls that happened: each is placed where the clinic's own
 * hours put it (an evening and a weekend morning it is closed, and in the
 * modes that cover open hours, a time it is open), and none names a
 * treatment, so no person is ever shown beside one.
 */
export function coverageExamples(schedule: WeekSchedule, mode: CoverageModeId, audience: "patients" | "clients" = "patients"): CoverageExample[] {
  const out: CoverageExample[] = [];
  const first = (days: number[], minute: number) => days.find((d) => !isOpen(schedule, d, minute));
  const evening = first([1, 3, 0, 2, 4], 21 * 60 + 42);
  if (evening !== undefined) {
    out.push({ day: evening, minute: 21 * 60 + 42, label: `${DAY_NAMES[evening]} ${clockLabel(21 * 60 + 42)} · New ${audience === "clients" ? "client" : "patient"}`, result: "Booked into your calendar" });
  }
  const weekend = first([6, 5], 10 * 60 + 5) ?? first([6, 5, 0], 7 * 60 + 12);
  if (weekend !== undefined) {
    const minute = isOpen(schedule, weekend, 10 * 60 + 5) ? 7 * 60 + 12 : 10 * 60 + 5;
    out.push({ day: weekend, minute, label: `${DAY_NAMES[weekend]} ${clockLabel(minute)} · Question answered`, result: "Consultation booked" });
  }
  if (mode !== "after-hours") {
    const day = [3, 1, 2, 0, 4, 5, 6].find((d) => (schedule.days[d] ?? []).length > 0);
    const span = day === undefined ? undefined : schedule.days[day]![0]!;
    if (day !== undefined && span) {
      const minute = Math.min(span[0] + 135, span[1] - 15);
      const why = mode === "overflow" ? "Front desk busy" : "During open hours";
      out.push({ day, minute, label: `${DAY_NAMES[day]} ${clockLabel(minute)} · ${why}`, result: "Booked into your calendar" });
    }
  }
  return out;
}
