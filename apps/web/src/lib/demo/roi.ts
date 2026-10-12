import type { Plan } from "@healdesk/catalog";

import type { ClinicProfile } from "./profile";

/**
 * What a package could book for one clinic in a month, for the demo buyer's
 * package step.
 *
 * ## An estimate from the clinic's own numbers, never a result we observed
 *
 * The owner asked for "we usually see clinics like yours get back $X". healdesk
 * has no clinic results yet, so that sentence would be an invented statistic,
 * the thing CLAUDE.md and AYA's own prompt both rule out. The same arithmetic
 * is honest as an estimate with its inputs on screen, which is what this is:
 *
 *   missed enquiries a week × 4.33 weeks
 *     × booking rate (the specialty's figure, lib/specialties.ts)
 *     × show rate (an assumption, stated)
 *     × the clinic's own price for one visit (from its website)
 *   = booked value a month
 *
 * "Booked value" is the one money figure v1 may claim (bookings times the
 * clinic's own prices); it is never called revenue. Only the first visit is
 * counted, so repeat treatments make the real figure larger, not smaller.
 *
 * Each package counts the enquiries it can answer: missed calls for a package
 * with the phone; unanswered messages for one with chat, half of them for a
 * single chat channel (website or Meta) and all of them for both. The owner
 * can change the three inputs that are theirs.
 */

/**
 * How often a patient comes back, where the knowledge layer states it
 * (lib/knowledge/practice.ts): the basis for "on average a Botox patient is
 * worth $Y a year". Only specialties with a stated figure are here; any other
 * shows first visits only rather than a guessed repeat rate.
 */
export const REPEAT_VISITS: Record<string, { visitsPerYear: number; patient: string; why: string }> = {
  "med-spa": {
    visitsPerYear: 3,
    patient: "Botox and filler patient",
    why: "neurotoxin brings people back every 3–4 months",
  },
};

export type RoiInputs = {
  /** One visit at the clinic's own price, in dollars. */
  priceUsd: number;
  /** Where the price came from, shown beside it ("Wrinkle Treatment, from your website"). */
  priceSource: string;
  missedCallsPerWeek: number;
  missedMessagesPerWeek: number;
  /** 0 to 1: enquiries that book, from the specialty's figure. */
  bookingRate: number;
  /** 0 to 1: bookings that turn up. */
  showRate: number;
  /** The specialty's repeat rate, when it has a stated one. */
  repeat: { visitsPerYear: number; patient: string; why: string } | null;
};

/** What one new patient is worth in a year at the clinic's price, or null without a stated repeat rate. */
export function patientValuePerYear(inputs: Pick<RoiInputs, "priceUsd" | "repeat">): number | null {
  return inputs.repeat ? inputs.priceUsd * inputs.repeat.visitsPerYear : null;
}

export const WEEKS_PER_MONTH = 4.33;
/** An assumption, and labelled as one wherever it shows. */
export const ASSUMED_SHOW_RATE = 0.85;
/** Defaults the owner is invited to change: modest, so the estimate starts low. */
export const DEFAULT_MISSED_CALLS_PER_WEEK = 8;
export const DEFAULT_MISSED_MESSAGES_PER_WEEK = 4;

/** The figure in a price string: "$425 flat fee" → 425, "from $12/unit" → 12, "complimentary" → null. */
export function priceFigure(price: string | null): number | null {
  if (!price || /complimentary|free/i.test(price)) return null;
  const m = /\$\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?/.exec(price);
  return m ? Number(m[1]!.replace(/,/g, "")) : null;
}

/**
 * The price of one typical visit: the median of the clinic's listed prices
 * for a whole treatment (per-unit and per-month prices skipped, they are not
 * one visit), or the specialty's typical figure when the site lists none.
 */
export function typicalVisit(
  profile: ClinicProfile | null,
  fallback: { valuePerBooking: number; basis: string },
): { priceUsd: number; priceSource: string } {
  const priced = (profile?.services ?? [])
    .map((s) => ({ name: s.name, price: s.price, usd: priceFigure(s.price) }))
    .filter((s): s is { name: string; price: string; usd: number } => s.usd !== null && s.usd >= 50)
    .filter((s) => !/\/\s*(unit|syringe|month|mo)\b|per (unit|syringe|month)|every \d+ months/i.test(s.price))
    .sort((a, b) => a.usd - b.usd);
  if (priced.length > 0) {
    const mid = priced[Math.floor((priced.length - 1) / 2)]!;
    return { priceUsd: mid.usd, priceSource: `${mid.name}, from your website` };
  }
  return { priceUsd: fallback.valuePerBooking, priceSource: `${fallback.basis} (typical for your specialty)` };
}

/** How much of each enquiry type a package answers. */
export function coverage(plan: Pick<Plan, "channels">): { calls: number; messages: number } {
  const chats = Number(plan.channels.web) + Number(plan.channels.meta);
  return { calls: plan.channels.voice ? 1 : 0, messages: chats === 0 ? 0 : chats === 1 ? 0.5 : 1 };
}

export type RoiEstimate = {
  /** Patients booked and seen in a month, rounded to one decimal. */
  patientsPerMonth: number;
  bookedValueUsd: number;
  /** Booked value over the package's monthly price; 0 when nothing is covered. */
  multiple: number;
  /** What one month's new patients are worth over their first year, or null without a repeat rate. */
  yearValueUsd: number | null;
};

export function estimate(plan: Pick<Plan, "channels" | "monthlyUsd">, inputs: RoiInputs): RoiEstimate {
  const { calls, messages } = coverage(plan);
  const enquiries = (inputs.missedCallsPerWeek * calls + inputs.missedMessagesPerWeek * messages) * WEEKS_PER_MONTH;
  const patients = enquiries * inputs.bookingRate * inputs.showRate;
  const value = Math.round((patients * inputs.priceUsd) / 10) * 10;
  const perPatientYear = patientValuePerYear(inputs);
  return {
    patientsPerMonth: Math.round(patients * 10) / 10,
    bookedValueUsd: value,
    multiple: plan.monthlyUsd > 0 ? Math.round((value / plan.monthlyUsd) * 10) / 10 : 0,
    yearValueUsd: perPatientYear === null ? null : Math.round((patients * perPatientYear) / 10) * 10,
  };
}
