import {
  DEMO_CALL_VARIABLE,
  NEVER_SAY_DEFAULTS,
  resolveBookingRequirements,
  type DemoCallClinic,
  type DemoCallContext,
} from "@healdesk/catalog";

import type { AssistantFacts, AssistantService } from "@/lib/assistant/facts";
import { defaultChatGreeting, defaultPhoneGreeting } from "@/lib/setup/greetings";

/**
 * A personalised demo call's facts (owner, 24 October 2026: "the demo AYAs
 * and the client AYA should be THE SAME, only difference should be the
 * start"). The demo runs on the same session, prompt, guard and screens as a
 * clinic's call (lib/voice/retell.ts, demo mode); only its facts come from
 * here, built from the clinic's published website as the demo read it
 * (@healdesk/catalog, DemoCallContext), rather than from the database.
 *
 * Pure: no database, no clock, no network. Business data in, business data
 * out: nothing here is a patient's.
 *
 * What differs from a clinic's facts, and why:
 *   - clinicId is `demo:<slug>`, never a UUID, so nothing that keys on a
 *     clinic id can mistake it for a clinic's row;
 *   - every number is null (published, AYA, urgent-help, direct line,
 *     referral): a demo call is never put through anywhere, and the urgent
 *     reply gives 9-1-1 alone;
 *   - prices are parsed from the website's free text conservatively
 *     (demoPrice): anything not plainly one of the menu's four kinds has no
 *     price, which the prompt turns into an offer of a consultation, and the
 *     guard then refuses any figure the model makes up, as on any call;
 *   - the never-say list is the built-in defaults only (the clinic has
 *     written none of its own);
 *   - it answers in English and Spanish, warm, with the default greeting.
 */

/** The zone a US address's state is in, where the state is wholly (or, by population, overwhelmingly) in one. */
const STATE_ZONES: Readonly<Record<string, string>> = (() => {
  const zones: Record<string, string> = {};
  const put = (zone: string, states: string) => {
    for (const s of states.split(" ")) zones[s] = zone;
  };
  put("America/New_York", "CT DE DC FL GA IN MA MD ME MI NC NH NJ NY OH PA RI SC VA VT WV");
  put("America/Chicago", "AL AR IA IL KS LA MN MO MS ND NE OK TX WI");
  put("America/Denver", "CO MT NM UT WY");
  put("America/Phoenix", "AZ");
  put("America/Los_Angeles", "CA NV OR WA");
  put("America/Anchorage", "AK");
  put("Pacific/Honolulu", "HI");
  return zones;
})();

/** The default zone, for an address that names no state, or one split between zones (TN, KY, SD, ID). */
export const DEMO_TIME_ZONE = "America/New_York";

/**
 * The practice's zone from the state and ZIP code at the end of its address
 * ("..., Austin, TX 78701"); DEMO_TIME_ZONE when it names neither, or a state
 * split between zones. Read from what the address says, never guessed from a
 * city's name.
 */
export function demoTimeZone(address: string | null): string {
  if (!address) return DEMO_TIME_ZONE;
  const all = [...address.matchAll(/\b([A-Z]{2})\s+\d{5}(?:-\d{4})?\b/g)];
  const last = all.at(-1);
  return (last && STATE_ZONES[last[1]!]) || DEMO_TIME_ZONE;
}

export type DemoPrice = Pick<AssistantService, "priceFromUsd" | "priceToUsd" | "priceKind" | "unit">;

const NO_PRICE: DemoPrice = { priceFromUsd: null, priceToUsd: null, priceKind: null, unit: null };

const NUMBER = String.raw`(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?`;

/** Dollar amounts as written: "$450", "$1,200", "$12.50". Only with a dollar sign, and never "$2k". */
const AMOUNT = new RegExp(String.raw`\$\s?${NUMBER}(?![\dk])`, "gi");

/** A range, as the whole price: "$500-$700", "$500 – 700", "from $500 to $700". */
const RANGE = new RegExp(String.raw`^(?:from\s+)?\$\s?${NUMBER}\s*(?:-|–|—|to)\s*\$?\s?${NUMBER}(?:\s*usd)?$`, "i");

/** Words that make a figure something other than the menu's own price: an offer, a member price, a condition, an estimate. */
const NOT_A_LIST_PRICE =
  /%|\b(?:off|save|savings|discount|discounted|special|specials|promo|promotion|sale|deal|offer|member|members|membership|package|packages|bundle|was|now|reg|regular|financing|finance|month|monthly|mo|deposit|credit|gift|free|complimentary|varies|vary|call|consult|consultation|quote|estimate|approx|approximately|about|around|est|up to|max|maximum|min|minimum|additional|tax)\b/i;

/** "from $200", "starting at $200", "$200+", "$200 and up". */
const FROM = /\b(?:from|starting(?:\s+at)?|starts\s+at|as\s+low\s+as|and\s+up)\b|\+/i;
const FROM_ALL = new RegExp(FROM.source, "gi");

/** A per-unit price: "$12/unit", "$12 per unit", "$600 a syringe". The unit is one of these plain words. */
const PER_UNIT = /(?:\/\s*|\bper\s+|\ba\s+|\beach\s+)(units?|syringes?|vials?|areas?|ml|cc|pulses?|lines?|grafts?|zones?)\b/i;

/** "per session", "a treatment", "each visit": the price of the service itself, which the menu calls exact. */
const PER_VISIT = /(?:\/\s*|\bper\s+|\ba\s+|\beach\s+)(?:sessions?|treatments?|visits?|appointments?)\b/gi;

/** Words a price may carry without meaning anything the menu cannot say. */
const FILLER = /\b(?:usd|only|just|at|price|is|the)\b/gi;

function dollars(whole: string, cents: string | undefined): number {
  return Number(whole.replace(/,/g, "")) + (cents ? Number(cents.padEnd(2, "0")) / 100 : 0);
}

function plausible(amount: number): boolean {
  return Number.isFinite(amount) && amount > 0 && amount <= 100_000;
}

function singular(unit: string): string {
  const lower = unit.toLowerCase();
  if (lower === "ml" || lower === "cc") return lower;
  return lower.endsWith("s") ? lower.slice(0, -1) : lower;
}

/**
 * A service's price from the website's free text, as the menu states prices
 * (catalog SERVICE_PRICE_KINDS, stored as lib/setup/prices.ts stores them):
 *
 *   "$450", "$150 per session"   exact 450, 150
 *   "from $200", "$200+"         from 200
 *   "$500-$700", "$500 to $700"  range 500 to 700
 *   "$12/unit", "from $12 per unit", "$600 a syringe"
 *                                per_unit 12 a unit, 600 a syringe
 *
 * Anything else has no price: no dollar sign, more figures than the kind
 * explains ("$450 for 3 areas"), an offer or a member price, "varies",
 * "call", "up to", a monthly figure, or words the menu cannot say ("$450
 * with Dr. Lee"). A demo that offers a consultation is better than one that
 * quotes a price the clinic does not charge: the guard checks every figure
 * said against what this returns.
 */
export function demoPrice(raw: string | null): DemoPrice {
  if (!raw) return NO_PRICE;
  const text = raw.replace(/\s+/g, " ").trim();
  if (!text || text.length > 80 || NOT_A_LIST_PRICE.test(text)) return NO_PRICE;

  const range = RANGE.exec(text);
  if (range) {
    const from = dollars(range[1]!, range[2]);
    const to = dollars(range[3]!, range[4]);
    return plausible(from) && plausible(to) && to > from ? { priceFromUsd: from, priceToUsd: to, priceKind: "range", unit: null } : NO_PRICE;
  }

  const amounts = [...text.matchAll(AMOUNT)];
  if (amounts.length !== 1) return NO_PRICE;
  const amount = dollars(amounts[0]![1]!, amounts[0]![2]);
  if (!plausible(amount)) return NO_PRICE;
  let rest = text.replace(AMOUNT, " ");
  // Any other figure beside the price is a condition the menu cannot carry.
  if (/\d/.test(rest)) return NO_PRICE;
  const perUnit = PER_UNIT.exec(rest);
  if (perUnit) rest = rest.replace(PER_UNIT, " ");
  const from = FROM.test(rest);
  rest = rest.replace(FROM_ALL, " ").replace(PER_VISIT, " ").replace(FILLER, " ").replace(/[^\p{L}]+/gu, " ").trim();
  if (rest) return NO_PRICE;
  if (perUnit) return { priceFromUsd: amount, priceToUsd: null, priceKind: "per_unit", unit: singular(perUnit[1]!) };
  if (from) return { priceFromUsd: amount, priceToUsd: null, priceKind: "from", unit: null };
  return { priceFromUsd: amount, priceToUsd: amount, priceKind: "exact", unit: null };
}

/** A service's length from the website's free text: "45 min", "60 minutes", "1 hour", "1.5 hours", "1 hr 30 min"; null otherwise. */
export function demoDuration(raw: string | null): number | null {
  if (!raw) return null;
  const text = raw.toLowerCase().replace(/\s+/g, " ").trim();
  if (!text || /[-–—+]|\bto\b|\bup\b|\bvar(?:y|ies)\b|\bor\b/.test(text)) return null;
  const hours = /(\d+(?:\.\d+)?)\s*(?:h|hr|hrs|hour|hours)(?![a-z])/.exec(text);
  const minutes = /(\d+)\s*(?:m|min|mins|minute|minutes)(?![a-z])/.exec(text);
  if (!hours && !minutes) return null;
  const total = Math.round((hours ? Number(hours[1]) * 60 : 0) + (minutes ? Number(minutes[1]) : 0));
  return total >= 5 && total <= 600 ? total : null;
}

/** A highlight that reads as an offer ("20% off your first visit", "Free consultation"), which only the promotions line may carry. */
const OFFER = /%|\$|\b(?:off|save|special|specials|offer|promo|promotion|discount|deal|complimentary|free|gift|new client|first visit)\b/i;

/** The clinic's id for a demo call: never a UUID, so no clinic's row can be read or written with it. */
export function demoClinicId(slug: string): string {
  return `demo:${slug}`;
}

function notesFor(clinic: DemoCallClinic, plain: readonly string[]): string | null {
  const parts: string[] = [];
  if (clinic.summary) parts.push(clinic.summary);
  if (plain.length > 0) parts.push(`What the practice is known for: ${plain.join("; ")}.`);
  if (clinic.providers.length > 0) {
    parts.push(`The practice's providers: ${clinic.providers.map((p) => (p.title ? `${p.name} (${p.title})` : p.name)).join("; ")}.`);
  }
  if (clinic.booking) parts.push(`How booking works: ${clinic.booking}`);
  return parts.length > 0 ? parts.join(" ") : null;
}

/**
 * Where the sealed context is on Retell's call object (the `call` of the
 * custom-LLM socket's `call_details` event, which is Retell's call object):
 * `retell_llm_dynamic_variables[DEMO_CALL_VARIABLE]`, where Retell puts the
 * dynamic variables a web call, a phone call or an inbound webhook's
 * `dynamic_variables` passed (forwarded-from.ts reads the same field for a
 * call's Diversion header). Also read, in this order, from
 * `dynamic_variables` and `metadata`, in case Retell names it otherwise on
 * one kind of call; a value that is not a string there is no context.
 */
export function demoContextFromCall(call: unknown): string | null {
  if (!call || typeof call !== "object") return null;
  const record = call as Record<string, unknown>;
  for (const source of [record.retell_llm_dynamic_variables, record.dynamic_variables, record.metadata]) {
    if (!source || typeof source !== "object") continue;
    const value = (source as Record<string, unknown>)[DEMO_CALL_VARIABLE];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

/**
 * How much of a live discount is worth saying, and never a dollar figure:
 * the exact setup fee depends on a package nobody has chosen yet, and the
 * guard has no healdesk price to check it against (it only ever checks the
 * clinic's own menu). A plain percentage and a rounded number of hours left
 * trips no pattern the guard reads (guard.ts, amountsIn: every form it
 * catches needs a dollar sign, a currency word or a currency code).
 */
function offerLine(offer: Pick<DemoCallContext, "offer">["offer"], now: number): string | null {
  if (!offer || offer.endsAt <= now) return null;
  const hoursLeft = Math.max(1, Math.round((offer.endsAt - now) / 3_600_000));
  // "hours left", not "more hours": with a word between the number and the
  // unit, the guard's own dose-like-figure pattern (guard.ts, PLAIN_CLINICAL)
  // reads "about 10 more hours" as a figure it cannot place and refuses the
  // whole sentence as clinical. "about 10 hours left" keeps the unit right
  // after the number, which that pattern already knows to leave alone.
  return `A real, live discount applies right now: ${offer.percentOfSetupFee}% off healdesk's setup fee, with about ${hoursLeft} hour${hoursLeft === 1 ? "" : "s"} left on it. If you mention it, say only that percentage and that rough window; never a dollar amount (no package is chosen yet to price one), and never a different number or a different amount of time than given here.`;
}

/**
 * What the model is told on the first turn of a demo call (turn.ts,
 * `notes`): the one thing a demo does differently (owner, 24 October 2026).
 * The person asked for the demo and works at the clinic: AYA talks to them
 * as themselves, introduces herself with energy, says what she does for
 * their practice and shows she knows it, then lets them choose between
 * hearing more about their own clinic or jumping into a role-play where
 * they call in as one of their patients.
 *
 * Shaped around the guard, which reads every word as on any call: "your
 * patients", because "our patients" or "another patient" reads as another
 * patient spoken of (guard.ts, mentionsOtherParty); nothing about how the
 * facts were learnt, which a clinic's own AYA never says either.
 */
export function demoIntroNote(context: Pick<DemoCallContext, "firstName" | "clinic">): string {
  const clinic = context.clinic.clinicName;
  const who = context.firstName ?? "the caller";
  return [
    `This call is a live demo for ${who}, who is on ${clinic}'s team and asked to hear you at work.`,
    `Talk to them as themselves, not as a patient: answer how they are, with real warmth and energy, then introduce yourself with confidence ("I'm AYA! Great to meet you.") and say in a few short spoken sentences what you do for ${clinic} from start to finish: you answer its calls in English and Spanish whenever the front desk can't get to the phone, know its treatments, prices, hours and policies, take booking requests for the team to confirm, handle urgent calls safely, and pass anyone who wants a person on to the team.`,
    `Show you have already done your homework on ${clinic} by naming one or two real details from what you know about it (a treatment, its hours, something it is known for). Never mention a website, scraping, reading or how you learned anything.`,
    `Then give them a clear choice in one short question, for example: "Want to hear what I've learned about ${clinic}, or jump straight into a role-play where you call in as one of your patients?" Say "your patients", never "our patients" or "another patient". If they pick the role-play, start it; if they pick to hear more, keep talking about ${clinic} as yourself until they are ready to try the role-play.`,
    `Keep it professional: no flirting, no compliments on how they look.`,
  ].join(" ");
}

/**
 * What the model is told on every turn after the first (turn.ts, `notes`),
 * once the opening has already happened. Short and state-agnostic on
 * purpose: repeating the opening's instructions turn after turn, deep into
 * a role-play, is what made AYA seem to forget the caller's name and lose
 * the thread of who she was meant to be (owner, 24 October 2026) — this note
 * only ever reminds her who she is talking to and what to do next, never
 * re-describes the opening.
 */
export function demoOngoingNote(context: Pick<DemoCallContext, "firstName" | "clinic" | "offer">, now: number): string {
  const clinic = context.clinic.clinicName;
  const who = context.firstName ?? "the caller";
  const offer = offerLine(context.offer, now);
  return [
    `This is still the live demo for ${who}, of ${clinic}'s team. Keep everything said earlier in this call in mind, their name included, and use it naturally rather than asking again.`,
    `If they are currently playing a patient, stay fully in that role and answer exactly as you would a real caller to ${clinic}; only step out of it if they clearly address you directly.`,
    `Once the role-play has run its course, or any time they step out of it to talk to you directly, you may ask ${who} how it felt, answer questions about healdesk and what it would bring ${clinic}, and gently note that the team would love to have them on board.${offer ? ` ${offer}` : ""} Never quote what AYA or healdesk costs beyond that, and promise nothing about setup beyond it: the healdesk team goes through the rest with them.`,
  ].join(" ");
}

/** The facts a demo call answers from: the clinic's published profile, read as AssistantFacts. No database. */
export function demoAssistantFacts(context: Pick<DemoCallContext, "slug" | "clinic">): AssistantFacts {
  const { clinic } = context;
  const services: AssistantService[] = clinic.services.map((s) => ({
    name: s.name,
    ...demoPrice(s.price),
    durationMinutes: demoDuration(s.duration),
    depositUsd: null,
  }));
  const offers = clinic.highlights.filter((h) => OFFER.test(h));
  const plain = clinic.highlights.filter((h) => !OFFER.test(h));
  return {
    clinicId: demoClinicId(context.slug),
    clinicName: clinic.clinicName,
    specialty: clinic.specialty,
    timeZone: demoTimeZone(clinic.address),
    // Never put a demo call through anywhere: no number at all.
    phone: null,
    assistantNumber: null,
    urgentPhone: null,
    vetReferralPhone: null,
    directLine: null,
    address: clinic.address,
    hours: clinic.hours.map((h) => `${h.days}: ${h.hours}`),
    openingHours: null,
    closures: [],
    services,
    menu: services.length > 0 ? "said" : "none",
    policies: [...clinic.policies],
    quickAnswers: clinic.faqs.map((f) => ({ question: f.question, answer: f.answer })),
    promotions: offers.length > 0 ? offers.join("; ") : null,
    notes: notesFor(clinic, plain),
    escalationHours: null,
    neverSay: [...NEVER_SAY_DEFAULTS],
    requirements: resolveBookingRequirements(clinic.specialty ?? "", null),
    greeting: { phone: defaultPhoneGreeting(clinic.clinicName), chat: defaultChatGreeting() },
    tone: "warm",
    languages: ["en", "es"],
    suggestAddOns: false,
    providerNames: clinic.providers.map((p) => p.name),
    // No alert is ever raised on a demo call: the urgent reply never says the team was told.
    urgentAlertsReady: false,
  };
}
