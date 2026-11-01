import {
  DEMO_CALL_VARIABLE,
  shortClinicName,
  NEVER_SAY_DEFAULTS,
  resolveBookingRequirements,
  type DemoCallClinic,
  type DemoCallContext,
} from "@healdesk/catalog";

import type { AssistantFacts, AssistantService } from "@/lib/assistant/facts";
import { routingProvider } from "@/lib/assistant/guard";
import { defaultChatGreeting, defaultPhoneGreeting } from "@/lib/setup/greetings";

/**
 * A personalised demo call (owner, 1 November 2026: "Remove the sales pitch
 * completely. Aya is now only a receptionist"): the clinic's own front desk
 * from the first word to the last, built from the clinic's published website
 * as the demo read it (@healdesk/catalog, DemoCallContext), on the same
 * session, prompt, guard and screens as a clinic's patient call
 * (lib/voice/retell.ts, demo mode). Until then the call opened as healdesk's
 * Aya, asked the owner about their business, offered a role-play and sold;
 * all of that is gone.
 *
 * Pure: no database, no clock, no network. Business data in, business data
 * out: nothing here is a patient's.
 *
 * What differs from a clinic's call, and why:
 *   - clinicId is `demo:<slug>`, never a UUID, so nothing that keys on a
 *     clinic id can mistake it for a clinic's row;
 *   - no number to put a call through to: the urgent reply reads out the
 *     clinic's published number after 9-1-1 and transfers nothing;
 *   - prices are parsed from the website's free text conservatively
 *     (demoPrice): anything not plainly one of the menu's four kinds has no
 *     price, which the prompt turns into an offer of a consultation, and the
 *     guard then refuses any figure the model makes up, as on any call;
 *   - healdesk's own words are on the never-say list (demoRoleplayFacts);
 *   - nothing is booked: the booking is a request kept in memory for the
 *     call, checked in code (roleplayCheckedReply, roleplayTimeLine), against
 *     a calendar made of the clinic's published hours (demoSlots).
 */

/** The short name after the greeting (6i): the catalog's, shared with a clinic's own calls. */
export { shortClinicName };

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

/** A demo call has one stage since 1 November 2026: the clinic's front desk. The name stays from the role-play it grew out of. */
export type DemoStage = "roleplay";

/**
 * What a demo call keeps of the booking request being taken, in memory for
 * the call only: the owner, playing a patient, made it up.
 */
export type DemoProgress = {
  /** Kept for the stall (stall.ts), which holds the question it stands in for: always null now. */
  asked: null;
  /** The caller's turns so far. */
  roleplayTurns: number;
  /** The booking request so far, and where it stands (roleplayHeard, demoStateFrom). */
  rpBooking?: RoleplayBooking;
  /** The weekday the caller last named (0 Sunday to 6), read in code, for a time they give without one. */
  rpDay?: number | null;
  /** A time their latest words asked for, read in code and checked against the hours (roleplayTimeLine). */
  rpTime?: RequestedTime | null;
  /** The menu items her last reply named, in the order she said them, so "the second one" is read in code. */
  lastListed?: readonly string[];
  /** What the caller's latest words picked from that list by position ("the second one"), resolved in code. */
  picked?: { said: string; item: string; index: number } | null;
  /** "I don't understand" with nothing more, in a row: 1, 2, 3... (0 or absent once they follow). */
  confused?: number;
  /** Their latest words were a no ("No.", "I told you no"): nothing is confirmed or taken on them. */
  saidNo?: boolean;
  /** The last question she said, word for word (roleplayHeard reads a name or a number answered to it). */
  lastQuestion?: string | null;
  /** She has looked at the calendar once on this call: the day's pleasantry is said only then (calendarLead). */
  lookedUp?: boolean;
  /** The first time asked for was "already taken", with two near it offered: once a call (roleplayTimeLine). */
  takenShown?: boolean;
  /** The most words the caller has said in one turn so far: a caller who keeps it brief gets no pleasantry (calendarLead). */
  callerMaxWords?: number;
  /** How many turns the caller has taken, "which part?" included. */
  callerTurns?: number;
  /** The times the call itself offered, newest last (roleplayTimeOffer): "Monday works" picks from them, and none is offered twice. */
  offered?: readonly DemoSlot[];
  /** Every time offered so far in the call, so "whatever you have" never hears the same list again (demo call a44374c9). */
  offeredAll?: readonly DemoSlot[];
  /** The booking was confirmed aloud (demoConfirmLine): never said again unless they ask what they are booked for. */
  rpConfirmed?: boolean;
  /** The day and time it was confirmed for: a move is confirmed again only to a different one. */
  confirmedAt?: DemoSlot | null;
  /** They said they are in a hurry ("running into a meeting", "fast as possible"): brisk from then on. */
  hurried?: boolean;
  /** They showed frustration ("repeating yourself", "frustrating"): one apology at most, and no "Glad that works!" to sarcasm. */
  frustrated?: boolean;
  /** A doctor they named who is not on the practice's list ("Dr. Smith"), this turn only. */
  unknownDoctor?: string | null;
  /** Their latest words asked what they are booked for ("what time was that?"): the booking may be said again. */
  askedBooking?: boolean;
  /** Their latest words show frustration, or sarcasm after it ("convenient."): this turn only. */
  frustratedNow?: boolean;
  /** She has apologised in this call: an apology on its own is never said again (a44374c9: three in a row). */
  apologised?: boolean;
  /** The offered time their latest words picked (slotPicked): it stands over a day or time her state gives. */
  pickedSlot?: DemoSlot | null;
};

/** A time on a weekday, 0 Sunday to 6, in minutes after midnight. */
export type DemoSlot = { day: number; minutes: number };

export const DEMO_START_PROGRESS: DemoProgress = { asked: null, roleplayTurns: 0 };

/** Her structured state with a reply (turn.ts, ModelAnswer.state): the booking details given so far. */
export type DemoStateUpdate = { booking: RoleplayBooking | null };

/** The state update in an answer's details; null when the answer carried none. */
export function demoStateFrom(raw: unknown): DemoStateUpdate | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  return { booking: bookingFrom((raw as { booking?: unknown }).booking) };
}

/** The progress with the caller's latest words read in code: a confusion, a no, a pick from a list, the booking. */
export function withDemoAnswer(progress: DemoProgress, _stage: DemoStage, words: string): DemoProgress {
  const lost = isConfused(words);
  return {
    ...progress,
    // "Which part?" is not a turn of its own.
    roleplayTurns: lost ? progress.roleplayTurns : progress.roleplayTurns + 1,
    confused: lost ? (progress.confused ?? 0) + 1 : 0,
    picked: pickedFrom(words, progress.lastListed ?? []),
    saidNo: SAID_NO.test(words.trim()),
    callerMaxWords: Math.max(progress.callerMaxWords ?? 0, words.trim().split(/\s+/).filter(Boolean).length),
    callerTurns: (progress.callerTurns ?? 0) + 1,
    hurried: progress.hurried === true || HURRIED.test(words),
    frustrated: progress.frustrated === true || FRUSTRATED.test(words),
    frustratedNow: FRUSTRATED.test(words) || (progress.frustrated === true && SARCASM.test(words)),
    unknownDoctor: null,
    askedBooking: ASKED_BOOKING.test(words),
    ...roleplayHeard(progress, words),
  };
}

/** "I'm running into a meeting", "fast as possible", "I'm in a hurry": a caller short of time (a44374c9). */
const HURRIED = /\b(?:in a (?:hurry|rush)|(?:running|heading|going) (?:in)?to (?:a |my )?(?:meeting|call|work)|(?:fast|quick|soon) as (?:possible|you can)|asap|quick(?:ly)? please|i(?:'m| am) (?:short on|pressed for) time|make it quick|don'?t have (?:much|a lot of) time)\b/i;

/** "You're repeating yourself", "frustrating", "that's really bad": a caller who is fed up (a44374c9). */
const FRUSTRATED = /\b(?:repeating yourself|you(?:'re| are) repeating|frustrat\w*|annoying|bothering|(?:that'?s|this is|it'?s) (?:really |so |quite )?(?:bad|terrible|awful|useless|ridiculous)|not convenient|a real (?:person|receptionist)|real receptionist|waste of (?:my )?time)\b/i;

/** A one-word "convenient." or "great." after a complaint: sarcasm, never agreement (a44374c9). */
const SARCASM = /^\W*(?:convenient|great|perfect|wonderful|awesome|fantastic|lovely|nice|sure)\W*$/i;

/** "What time was that again?", "When is my appointment?": a question about the booking, which may then be said again. */
const ASKED_BOOKING = /^\W*(?:what|sorry|pardon|huh|come again|say again)\W*$|\b(?:what|which|when)\b[^.?!]{0,30}\b(?:time|day|date|booked|booking|appointment)\b|\b(?:remind me|say (?:that|it) again|repeat (?:that|the time)|confirm(?:ed)?)\b|\b(?:am i|is it|is that) (?:booked|confirmed|set)\b/i;

/** The progress once a reply is said: the booking details her state gave, a cancel the caller just asked for standing over a stale status. */
export function afterDemoReply(progress: DemoProgress, _from: DemoStage, _to: DemoStage, update: DemoStateUpdate | null, callerWords = ""): DemoProgress {
  const picked = progress.pickedSlot ?? null;
  return {
    ...progress,
    rpBooking: update?.booking
      ? {
          ...progress.rpBooking,
          ...update.booking,
          ...(progress.rpBooking?.status === "cancelled" && CANCEL_ASK.test(callerWords) ? { status: "cancelled" as const } : {}),
          // The time they picked from the call's offer is the code's, whatever her state says (a44374c9).
          ...(picked ? { day: WEEKDAY_NAMES[picked.day], time: clock(picked.minutes) } : {}),
          // A status her state gives never undoes the call's own: booked, or moved and waiting to be said.
          ...(progress.rpBooking?.status === "booked" || progress.rpBooking?.status === "rescheduled"
            ? { status: update.booking.status === "cancelled" ? ("cancelled" as const) : progress.rpBooking.status }
            : {}),
        }
      : progress.rpBooking,
  };
}

/**
 * The note for a demo turn: the clinic's front desk, with what only the demo
 * needs on top of the clinic's own front-desk prompt (the stable prefix): its
 * booking so far, the calendar made of its hours, and the repairs this turn
 * needs. The receptionist's manner itself is the prompt's (prompt.ts), the
 * same for a clinic's own calls.
 */
export function demoStageNote(
  context: Pick<DemoCallContext, "clinic"> & Partial<Pick<DemoCallContext, "issuedAt">>,
  _stage: DemoStage,
  now: number,
  progress: DemoProgress = DEMO_START_PROGRESS,
): string {
  const full = context.clinic.clinicName;
  const clinic = shortClinicName(full);
  const ctx = { ...context, issuedAt: context.issuedAt ?? now };
  const provider = routingProvider(context.clinic.providers.map((p) => p.name));
  return [
    `You are Aya, ${clinic}'s AI receptionist, answering a caller. Everything above about the practice is yours to use. ${NAME_RULE}${clinic === full ? "" : ` Call the clinic "${clinic}": its full name was said once, in the opening line.`}`,
    ...confusedRule(progress),
    ...(progress.hurried
      ? [`They're in a hurry. Every reply is one short sentence with one question at most: no pleasantries, no description of the practice, no small talk, nothing they didn't ask for.`]
      : []),
    ...(progress.frustrated
      ? [
          `They're frustrated. Apologise at most once in the whole call (never if you already have), then fix what bothered them in one short sentence, or offer one concrete choice. Never repeat anything you have said, and never sum up the booking. A one-word "convenient", "great" or "perfect" after a complaint is sarcasm: never answer it with "Glad that works!".`,
        ]
      : []),
    ...(progress.pickedSlot
      ? [`They just picked ${nextDateOn(ctx, progress.pickedSlot.day)} at ${clock(progress.pickedSlot.minutes)}, from the times the call offered: that is the time, never another.`]
      : []),
    ...(progress.unknownDoctor
      ? [`They asked for ${progress.unknownDoctor}, who is not on the team. Say so in a few words and name who is (${context.clinic.providers.map((p) => p.name).slice(0, 3).join(", ") || "the team"}), before anything else; never book them with someone they did not ask for without saying so.`]
      : []),
    ...(progress.saidNo ? [`They just said no. Nothing is confirmed, requested or set up on that: never say it's all set or done. Take the no, and ask what they would like instead in a few words.`] : []),
    `Give a real answer to what they ask; if they are unsure what to book, name one or two treatments from the list that suit what they want (no price that is not on the list, and never a figure they said) and offer a consultation. Never read out more than two prices at once: give the lowest "from" price and offer to say more.`,
    `If they ask what a price per unit means, or what an area costs, say close to these words: "The price is per unit, and the total depends on the area, which ${provider ?? "the provider"} works out with you at a consultation. Want me to request one?" Never say what a unit is or how many anyone needs: the clinic's screen refuses it.`,
    `Never rank the providers or say who is best: say who does a treatment only where what you know says so, and leave the choice to them and the team.`,
    `A question about ${clinic}'s own policies (insurance, financing, parking, payment) is about the practice: answer it from what you know above, in its words; if it is not there, say you don't know and the team will confirm.`,
    `If they name a treatment that is not on the list, or a word you don't recognise (it may be misheard: "Deeps" for lips, "a painting" for an appointment), ask them to say it again or check what they meant before you answer it.`,
    ...rpBookingLines(progress, context),
    ...calendarLines(ctx, clinic),
    ...timeLines(ctx, progress, clinic),
    `When they name a weekday ("next Tuesday", "Tuesday morning"), take the next such day and say its date; never ask which one they mean.`,
    ...(progress.picked
      ? [`They just said "${progress.picked.said}": that is the ${progress.picked.item}, number ${progress.picked.index + 1} of what you listed (${(progress.lastListed ?? []).join(", ")}). Confirm it by that name, never another.`]
      : []),
    `If they push back on cost right after you quoted a price from the list, the pushback is about that price: acknowledge it in a few words, say plainly what it is for, and offer a consultation where the team can go through options. Never answer it with "I don't have a price for that one": you just gave one.`,
    `When they say goodbye, say a short, warm goodbye and set "end" to true.`,
    `In the JSON details, add a "state" object: {"booking": {"service", "day", "time", "name", "phone", "status"} with whatever of these the caller has given so far for the booking, in their words (the day as a weekday, the time as a clock time such as "4 PM"), and "status": "cancelled" or "rescheduled" only when they cancel it or move it}.`,
  ].join("\n");
}

/** Her own "Ring ring": never said as she writes it, since the call says the opener itself (c4093be6: two greetings in one reply). */
export const RING_RING = /\bring[\s,!.-]*ring\b/i;
/** Her own exit line, or the start of it, in a role-play reply. */
export const OWN_EXIT = /\band that'?s the role-?play\b/i;

/** A reply with her own exit line, and anything after it, taken out. */
export function withoutOwnExit(reply: string): string {
  return reply.replace(/\s*and that'?s the role-?play\b[^]*$/i, "").trim();
}

/**
 * A role-play booking request as far as it has got (c4093be6: the request
 * was "passed to the team" with no name or number, and a cancelled one was
 * later called pending). In memory for the call only, like the rest of a
 * demo call: what an owner playing a patient made up.
 */
export type RoleplayBooking = {
  service?: string;
  day?: string;
  time?: string;
  /** The patient's first name. */
  name?: string;
  /** The number to reach them on, in their words ("the one I'm calling from"). */
  phone?: string;
  /** Where the request stands: put in, moved, cancelled, or booked by the demo's own calendar (demoConfirmLine). */
  status?: "requested" | "rescheduled" | "cancelled" | "booked";
};

const BOOKING_STATUSES: ReadonlySet<string> = new Set(["requested", "rescheduled", "cancelled"]);

/** Role-play booking details from her state, each a short string; null when none. */
function bookingFrom(raw: unknown): RoleplayBooking | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const out: RoleplayBooking = {};
  for (const key of ["service", "day", "time", "name", "phone"] as const) {
    const value = (raw as Record<string, unknown>)[key];
    if (typeof value === "string" && value.trim()) out[key] = value.trim().slice(0, 60);
  }
  const status = (raw as Record<string, unknown>).status;
  if (typeof status === "string" && BOOKING_STATUSES.has(status)) out.status = status as RoleplayBooking["status"];
  return Object.keys(out).length > 0 ? out : null;
}

/** What the booking still needs before a request goes in, in the order she asks for it (criterion 6 of c4093be6). */
export function bookingMissing(booking: RoleplayBooking | undefined): ("treatment" | "day and time" | "first name" | "number")[] {
  const b = booking ?? {};
  return [
    ...(!b.service ? (["treatment"] as const) : []),
    ...(!b.day || !b.time ? (["day and time"] as const) : []),
    ...(!b.name ? (["first name"] as const) : []),
    ...(!b.phone ? (["number"] as const) : []),
  ];
}

/** "I need to cancel my appointment" (never "your cancellation policy"). */
const CANCEL_ASK = /\bcancel(?:l?ing|l?ed)?\b/i;
/** "Can we move that to Friday morning?" */
const MOVE_ASK = /\b(?:move|reschedule|change|switch|push)\b[^.?!]{0,30}\b(?:to|appointment|booking|request|time|day)\b/i;

/** The weekday a caller names ("Thursday afternoon", "next Tuesday"), 0 Sunday to 6; null when none. */
export function weekdayIn(words: string): number | null {
  const m = /\b(sun|mon|tues?|wed(?:nes)?|thu(?:rs?)?|fri|sat(?:ur)?)(?:day)?s?\b/i.exec(words);
  if (!m) return null;
  const at = WEEKDAYS.findIndex((w) => m[1]!.toLowerCase().startsWith(w));
  return at >= 0 ? at : null;
}

/** In a role-play, what the caller's words do to the booking in code: a cancel or a move, and the weekday they name. */
function roleplayHeard(progress: DemoProgress, words: string): Pick<DemoProgress, "rpBooking" | "rpDay" | "rpTime" | "pickedSlot"> {
  const booking = progress.rpBooking ?? {};
  const day = weekdayIn(words);
  const status = CANCEL_ASK.test(words) ? "cancelled" : MOVE_ASK.test(words) && booking.status !== "cancelled" && (booking.day || booking.time) ? "rescheduled" : booking.status;
  // Her last question asked for their name or their number: these words are it,
  // kept in code so a state she forgot never holds the request back.
  const asked = progress.lastQuestion ?? "";
  const said = words.trim().replace(/^(?:it'?s|my name is|my name'?s|this is|i'?m)\s+/i, "").replace(/[.!?]+$/, "");
  const name = !booking.name && /\bname\b/i.test(asked) && said && said.split(/\s+/).length <= 3 && !SAID_NO.test(words.trim()) ? said.slice(0, 60) : booking.name;
  const phone = !booking.phone && /\bnumber\b/i.test(asked) && said && !SAID_NO.test(words.trim()) ? said.slice(0, 60) : booking.phone;
  // "Monday works", "the second one", "5 PM", "yes": a time the call just offered, picked in code.
  const slot = slotPicked(words, progress.offered ?? []);
  const next: RoleplayBooking = {
    ...booking,
    ...(status ? { status } : {}),
    ...(name ? { name } : {}),
    ...(phone ? { phone } : {}),
    ...(slot ? { day: WEEKDAY_NAMES[slot.day], time: clock(slot.minutes) } : {}),
  };
  // A booking confirmed and then moved is booked again only once the new time is said.
  if (slot && booking.status === "booked") next.status = "rescheduled";
  return {
    rpBooking: next,
    rpDay: slot ? slot.day : (day ?? progress.rpDay ?? null),
    rpTime: slot ? null : requestedTime(words),
    pickedSlot: slot,
  };
}

/** The last question in a reply, word for word: what "what was your question?" asks for again. */
export function lastQuestionIn(reply: string): string | null {
  const questions = reply.split(/(?<=[.!?])\s+/).filter((sentence) => /\?\W*$/.test(sentence));
  return questions.at(-1)?.trim() ?? null;
}

/** A bare no to what was just asked ("No.", "No. No.", "I told you no"): never taken as a yes (084f10d4). "No, that's all, thanks" is not one. */
export const SAID_NO = /^\W*(?:(?:no+|nope|nah)[\s,.!]*)+$|^\W*i (?:told|said to) you no\b|^\W*i said no\b/i;

/** "I don't understand", "What do you mean?", "I'm confused": a caller who lost the thread and said nothing more. */
export function isConfused(words: string): boolean {
  return /^\W*(?:sorry,?\s*)?(?:i\s+(?:don'?t|do not|didn'?t)\s+(?:understand|get it|follow)|what\s+do\s+you\s+mean|what\s+does\s+(?:it|that)\s+mean|i'?m\s+(?:confused|lost)|huh|come again)\W*(?:(?:what|you)\b[^.?!]{0,30})?\W*$/i.test(
    words.trim(),
  );
}

const ORDINALS: readonly [RegExp, (n: number) => number][] = [
  [/\b(?:first|1st)\b/i, () => 0],
  [/\b(?:second|2nd)\b/i, () => 1],
  [/\b(?:third|3rd)\b/i, () => 2],
  [/\b(?:fourth|4th)\b/i, () => 3],
  [/\b(?:middle)\b/i, (n) => (n % 2 === 1 ? (n - 1) / 2 : -1)],
  [/\b(?:last)\b/i, (n) => n - 1],
];

/** The item a caller picked by position from what she just listed ("the second one"); null without a list or a position. */
export function pickedFrom(words: string, listed: readonly string[]): DemoProgress["picked"] {
  if (listed.length < 2 || !/\b(?:one|option|of those|of them)\b|^\W*the\s+\w+\W*$/i.test(words)) return null;
  for (const [pattern, at] of ORDINALS) {
    const m = pattern.exec(words);
    if (!m) continue;
    const index = at(listed.length);
    if (index < 0 || index >= listed.length) return null;
    return { said: m[0], item: listed[index]!, index };
  }
  return null;
}

/** The menu items a reply names, in the order it says them (each once). */
export function listedIn(reply: string, menu: readonly string[]): string[] {
  const hits: { at: number; name: string }[] = [];
  for (const name of menu) {
    const at = reply.toLowerCase().indexOf(name.toLowerCase());
    if (at >= 0) hits.push({ at, name });
  }
  // A name inside a longer one ("Facial" in "VIP Facial") is not its own item.
  return hits
    .filter((h) => !hits.some((o) => o !== h && o.name.length > h.name.length && o.at <= h.at && h.at < o.at + o.name.length))
    .sort((a, b) => a.at - b.at)
    .map((h) => h.name);
}

const NAME_RULE = `Your name is Aya: write it exactly "Aya", never "AYA" and never spelled out. Never say the caller's first name yourself: the call says it once, when it confirms the booking.`;

/** "I don't understand", in a row (test call 72dc66b7: the same price list twice, then the same line twice). */
function confusedRule(progress: DemoProgress): string[] {
  const n = progress.confused ?? 0;
  if (n === 1) return [`They just said they don't understand. Ask which part in a few words ("Which part?") and nothing more: never say the same thing again.`];
  if (n === 2) return [`They still don't follow. Say it the simplest way you can: one item, one short sentence, in different words from anything you said before.`];
  if (n >= 3) return [`They have said they don't understand ${n} times. Don't explain it again: take a completely different angle in one sentence, or offer to move on.`];
  return [];
}

/** The role-play's booking, as far as it has got, and the hours a time must fall in. */
function rpBookingLines(progress: DemoProgress, context: Pick<DemoCallContext, "clinic">): string[] {
  const b = progress.rpBooking ?? {};
  const hours = context.clinic.hours.map((h) => `${h.days} ${h.hours}`).join(", ");
  const hoursLine = hours
    ? `Opening hours: ${hours}.`
    : `If they ask for a time the clinic is closed, offer two times within its usual working day instead.`;
  // A cancelled request is never pending again (c4093be6: "when they confirm your Friday morning request" after the cancel).
  if (b.status === "cancelled") {
    const need = [!b.name ? "their first name" : null, !b.phone ? "the best number to reach them" : null].filter(Boolean);
    return [
      `They have asked to cancel their booking: as far as this call goes it is cancelled, and it no longer stands.`,
      need.length > 0
        ? `To pass the cancellation to the team, ask for ${need.join(", then ")}, one at a time; then say in one sentence that the team will cancel it and confirm within a day.`
        : `You have their name and number for the cancellation: the team will cancel it and confirm within a day. If they want a new time, take a new request: the treatment, then a day and time.`,
      hoursLine,
    ];
  }
  const known = [
    b.service ? `the treatment: ${b.service}` : null,
    b.day ? `the day: ${b.day}` : null,
    b.time ? `the time: ${b.time}` : null,
    b.name ? `their first name: ${b.name}` : null,
    b.phone ? `their number: ${b.phone}` : null,
  ].filter(Boolean);
  const missing = bookingMissing(b);
  return [
    known.length > 0
      ? `On file for this booking: ${known.join("; ")}. Never ask for any of it again; use it.`
      : `To take a booking request you need four things, asked one at a time: the treatment, a day and time, their first name, and the best number to reach them (the number they are calling from is fine if they say so).`,
    missing.length > 0
      ? `Still needed before it can be booked: ${missing.join(", ")}. Ask for the next one only, in one short question, and nothing else in that reply.`
      : progress.rpConfirmed === true
        ? `It is booked, and the call has told them so. Never say it again, nor any part of it (the day, the time, "your request", "the team will confirm"), unless they ask what they are booked for; then say it once, in one short sentence. Answer what they ask now, and only that.`
        : `You have everything: the call books it and tells them itself. Say nothing about it being booked, requested or confirmed.`,
    hoursLine,
  ];
}

/**
 * The role-play's calendar (owner, 31 October 2026, step 4: "Give it two or
 * three plausible demo times from the clinic's hours"): a front desk that
 * cannot offer a time was a weak showcase, and without times she made them
 * up (a17b5aff: "Eleven AM is available"). The times come from the clinic's
 * published hours, from the day after the call was issued, so they are the
 * same for the whole call; it is a role-play, so nothing is booked and the
 * guard's rule against claiming a booking holds as on any call. Hours that
 * cannot be read leave her taking a preferred time, as before.
 */
function calendarLines(context: Pick<DemoCallContext, "clinic" | "issuedAt">, clinic: string): string[] {
  const slots = demoSlots(context);
  if (slots.length === 0) {
    return [`You can't see ${clinic}'s calendar: never say a time is available, free or open. Take the time they ask for as their preferred time, for the team to confirm (a17b5aff: "Eleven AM is available").`];
  }
  return [
    `The calendar has these free times: ${slots.join("; ")}. When they want to book, offer one or two of them, never all three, and never a list you already read them; any other time they ask for within the hours is free too. When they ask about times, the call often answers itself first: never read out times it did not just say. Never say a time is booked, set, held or confirmed, and never that you can't confirm: once it has the treatment, the day and time, their first name and their number, the call books it and says so in its own words.`,
  ];
}

/** A time a caller asks for: a clock time ("nine PM"), a part of the day ("Thursday afternoon"), or both. */
export type RequestedTime = { minutes: number | null; part: "morning" | "afternoon" | "evening" | null; said: string };

const HOUR_WORDS: Readonly<Record<string, number>> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };

/** The time in a caller's words, read in code; null when they name none. "Earliest" and "anything" ask for none. */
export function requestedTime(words: string): RequestedTime | null {
  const w = words.toLowerCase();
  const clockAt = /\b(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)(?::(\d{2}))?\s*(a\.?\s?m\b\.?|p\.?\s?m\b\.?)/i.exec(w);
  const noon = /\b(noon|midday)\b/.exec(w);
  const partAt = /\b(morning|afternoon|evening|tonight|night)\b/.exec(w);
  const part = partAt ? (partAt[1] === "morning" ? "morning" : partAt[1] === "afternoon" ? "afternoon" : "evening") : null;
  let minutes: number | null = null;
  let said = partAt?.[0] ?? "";
  if (clockAt) {
    const hour = HOUR_WORDS[clockAt[1]!] ?? Number(clockAt[1]);
    if (hour >= 1 && hour <= 12) {
      minutes = ((hour % 12) + (clockAt[3]!.startsWith("p") ? 12 : 0)) * 60 + Number(clockAt[2] ?? 0);
      said = clock(minutes);
    }
  } else if (noon) {
    minutes = 12 * 60;
    said = "noon";
  }
  if (minutes === null && !part) return null;
  return { minutes, part, said };
}

/** The opening span of each weekday the hours can be read for, 0 Sunday to 6. */
function openSpans(context: Pick<DemoCallContext, "clinic">): Map<number, { open: number; close: number }> {
  const open = new Map<number, { open: number; close: number }>();
  for (const h of context.clinic.hours) {
    const span = hoursSpan(h.hours);
    if (!span) continue;
    for (const day of hoursDays(h.days)) if (!open.has(day)) open.set(day, span);
  }
  return open;
}

/** The weekday of a moment in a zone, 0 Sunday to 6. */
function weekdayOf(at: Date, zone: string): number {
  return WEEKDAYS.indexOf(at.toLocaleDateString("en-US", { timeZone: zone, weekday: "short" }).toLowerCase().slice(0, 3) as (typeof WEEKDAYS)[number]);
}

/** The next date on that weekday after the call was issued, as a person says it ("Thursday, November 5"). */
function nextDateOn(context: Pick<DemoCallContext, "clinic" | "issuedAt">, weekday: number): string {
  const zone = demoTimeZone(context.clinic.address);
  for (let k = 1; k <= 7; k += 1) {
    const at = new Date(context.issuedAt + k * 86_400_000);
    if (weekdayOf(at, zone) === weekday) return at.toLocaleDateString("en-US", { timeZone: zone, weekday: "long", month: "long", day: "numeric" });
  }
  return WEEKDAY_NAMES[weekday]!;
}

const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;

/**
 * Two free times on a day near what was asked, inside its hours, on the hour:
 * for a part of the day, within it; for a time after closing, the last two
 * before it; before opening, the first two; otherwise two hours after
 * opening and two before closing (demoSlots).
 */
function twoTimes(span: { open: number; close: number }, ask: RequestedTime | null): number[] {
  const up = (m: number) => Math.ceil(m / 60) * 60;
  const down = (m: number) => Math.floor(m / 60) * 60;
  const last = down(span.close - 60);
  const first = up(span.open);
  const pick = (from: number, to: number): number[] => {
    const a = Math.max(first, up(from));
    const b = Math.min(last, down(to));
    if (a > b) return [];
    return a === b ? [a] : [a, Math.min(b, a + 120)];
  };
  if (ask?.minutes !== null && ask?.minutes !== undefined) {
    if (ask.minutes >= span.close - 30) return [last - 60, last].filter((m) => m >= first);
    if (ask.minutes < span.open) return [first, first + 60].filter((m) => m <= last);
    // A time inside this day's hours (asked for a day that is closed): that time, and the hour after it.
    const asked = down(ask.minutes);
    return [asked, asked + 60].filter((m) => m >= first && m <= last);
  }
  if (ask?.part === "morning") return pick(span.open, 11 * 60);
  if (ask?.part === "afternoon") return pick(14 * 60, 17 * 60);
  if (ask?.part === "evening") return pick(17 * 60, span.close);
  return [up(span.open + 120), down(span.close - 120)].filter((m, i, all) => m >= first && m <= last && all.indexOf(m) === i);
}

/**
 * What the call says itself about a time in the role-play, in place of her
 * reply (demo call c4093be6: "Thursday afternoon works" with nothing
 * checked; "I'll take Thursday at nine PM, though our hours don't run that
 * late"; "What's your earliest opening?" answered "I don't have the team's
 * calendar"). A closed day or a time outside the hours is never taken, and a
 * question about free times is answered from the role-play's calendar: the
 * code owns both, so no note asks her to. Null when these words ask neither,
 * or when the hours cannot be read; she then answers as usual.
 */
export function roleplayTimeLine(context: Pick<DemoCallContext, "clinic" | "issuedAt">, progress: DemoProgress, words: string): string | null {
  return roleplayTimeOffer(context, progress, words)?.line ?? null;
}

/** A time line the call says itself, and the times it offers in it: the next turn picks from them, and none is offered twice. */
export type TimeOffer = { line: string; offered: DemoSlot[]; seen: DemoSlot[] };

/**
 * The time line with the times it offers (roleplayTimeLine), opened by her
 * look at the calendar, and by a word about a doctor they named who is not on
 * the practice's list (a44374c9: "doctor Smith" became Dr. Patel unsaid).
 */
export function roleplayTimeOffer(context: Pick<DemoCallContext, "clinic" | "issuedAt">, progress: DemoProgress, words: string): TimeOffer | null {
  const answer = timeAnswer(context, progress, words);
  if (!answer) return null;
  const doctor = unknownDoctorIn(context.clinic, words);
  return {
    line: `${doctor ? `${unknownDoctorLine(context.clinic, doctor)} ` : ""}${calendarLead(context, progress)} ${answer.line}`,
    offered: answer.offered,
    seen: [...(answer.taken ? [answer.taken] : []), ...answer.offered],
  };
}

/**
 * What she says as she looks at the calendar (owner, 1 November 2026: "she
 * should use the filler to look into it"): the first time on a call, the
 * day's pleasantry with it (RECEPTIONIST_MANNER in prompt.ts, in the clinic's
 * zone on the day the call began); after that, a short "let me look".
 */
export function calendarLead(context: Pick<DemoCallContext, "clinic" | "issuedAt">, progress: DemoProgress): string {
  // A caller who keeps it brief (two turns or more, none over five words) gets no pleasantry: she mirrors their efficiency (owner, 1 November 2026).
  // So does one in a hurry (a44374c9: "I'm running into a meeting").
  if (progress.lookedUp || isBriefCaller(progress) || progress.hurried) return "Let me take a look...";
  const day = weekdayOf(new Date(context.issuedAt), demoTimeZone(context.clinic.address));
  if (day === 1 || day === 2) return "I hope your week's off to a great start! Let me pull up our calendar...";
  if (day === 4 || day === 5) return `Happy ${WEEKDAY_NAMES[day]}! Let's get this sorted so you can head into the weekend. Let me see what we have open...`;
  return "Let me pull up our calendar...";
}

/** A caller whose every answer so far was short and transactional ("Botox." "Thursday at 3."). */
export function isBriefCaller(progress: DemoProgress): boolean {
  return (progress.callerTurns ?? 0) >= 2 && (progress.callerMaxWords ?? Infinity) <= BRIEF_WORDS;
}
const BRIEF_WORDS = 5;

/** The two free hours nearest a time on a day, inside its hours: the "already taken" alternatives. */
function nearTimes(span: { open: number; close: number }, minutes: number): number[] {
  const at = Math.floor(minutes / 60) * 60;
  const first = Math.ceil(span.open / 60) * 60;
  const last = Math.floor((span.close - 60) / 60) * 60;
  return [at - 60, at + 60, at - 120, at + 120, at + 180, at - 180].filter((m) => m >= first && m <= last).slice(0, 2).sort((a, b) => a - b);
}

function timeAnswer(context: Pick<DemoCallContext, "clinic" | "issuedAt">, progress: DemoProgress, words: string): { line: string; offered: DemoSlot[]; taken?: DemoSlot } | null {
  const spans = openSpans(context);
  if (spans.size === 0) return null;
  const said = (line: string, offered: DemoSlot[] = []) => ({ line, offered });
  const ask = progress.rpTime ?? null;
  const day = weekdayIn(words) ?? (ask ? (progress.rpDay ?? null) : null);
  const offer = (d: number, times: number[]) => (times.length === 2 ? `${nextDateOn(context, d)} at ${clock(times[0]!)} or ${clock(times[1]!)}` : times.length === 1 ? `${nextDateOn(context, d)} at ${clock(times[0]!)}` : null);
  const on = (d: number, times: number[]): DemoSlot[] => times.map((minutes) => ({ day: d, minutes }));
  const nextOpen = (from: number) => [1, 2, 3, 4, 5, 6, 7].map((k) => (from + k) % 7).find((d) => spans.has(d));
  // A cancel is the cancellation's, never a time to offer.
  if (CANCEL_ASK.test(words)) return null;
  // Booked already: "any day, whatever you have" is heard as wanting it sooner, and the earliest
  // time not yet offered is offered as a move, the booking said once with it (a44374c9).
  if (progress.rpConfirmed === true && progress.confirmedAt && !MOVE_ASK.test(words) && (ANY_TIME.test(words) || AVAILABILITY_ASK.test(words)) && !windowIn(words) && weekdayIn(words) === null) {
    const booked = progress.confirmedAt;
    const sooner = freeSlots(context, progress, { from: null, to: null }, null).find((slot) => slotOrder(context, slot) < slotOrder(context, booked));
    // The booking is said with the first offer only; a later one names just the new time (a44374c9: never the same words twice).
    const again = (progress.lastQuestion ?? "").includes("move it");
    if (!sooner) return said(again ? `That's the earliest I have. Anything else I can help with?` : `You're booked for ${slotSaid(context, booked)}, the earliest I have. Anything else I can help with?`);
    return said(
      again ? `I can also do ${slotSaid(context, sooner)}. Want me to move it to that?` : `You're booked for ${slotSaid(context, booked)}. If you'd like it sooner, I have ${slotSaid(context, sooner)}. Want me to move it?`,
      [sooner],
    );
  }
  // "After four PM next week", "before noon on Friday" (a44374c9: three times offered, two of them before four).
  const window = windowIn(words);
  if (window) return windowAnswer(context, progress, window, weekdayIn(words));
  if (day !== null && !spans.has(day) && (ask || AVAILABILITY_ASK.test(words) || ANY_TIME.test(words) || BOOK_INTENT.test(words))) {
    const d = nextOpen(day);
    const times = d === undefined ? [] : twoTimes(spans.get(d)!, ask);
    const instead = d === undefined ? null : offer(d, times);
    return said(`We're closed on ${WEEKDAY_NAMES[day]}s.${instead ? ` Would ${instead} work instead?` : " Which other day would suit you?"}`, d === undefined ? [] : on(d, times));
  }
  if (ask?.minutes !== null && ask?.minutes !== undefined) {
    if (day === null) {
      const inside = [...spans.values()].some((span) => ask.minutes! >= span.open && ask.minutes! <= span.close - 30);
      return inside ? null : said(`Sorry, ${ask.said} is outside our hours. What day would suit you? I'll find you a time within them.`);
    }
    const span = spans.get(day)!;
    if (ask.minutes < span.open || ask.minutes > span.close - 30) {
      const times = twoTimes(span, ask);
      const instead = offer(day, times);
      return said(`We're open ${clock(span.open)} to ${clock(span.close)} on ${WEEKDAY_NAMES[day]}s, so ${ask.said} is outside our hours.${instead ? ` Would ${instead} work instead?` : ""}`, on(day, times));
    }
    // The first time they ask for, once a call, is already taken, and two near it are offered at once
    // (owner, 1 November 2026: show that she is proactive). Never a time she just offered them.
    const offered = (progress.lastQuestion ?? "").includes(clock(Math.floor(ask.minutes / 60) * 60)) || demoSlots(context).some((slot) => slot.endsWith(` at ${clock(ask.minutes!)}`));
    if (!progress.takenShown && !offered) {
      const near = nearTimes(span, ask.minutes);
      if (near.length === 2) {
        return said(`Ah, ${clock(Math.floor(ask.minutes / 60) * 60)} on ${nextDateOn(context, day)} is already taken, but I can do ${clock(near[0]!)} or ${clock(near[1]!)} that day. Would either of those work?`, on(day, near));
      }
    }
    return null;
  }
  // "Thursday afternoon, please" asks for a time as surely as "do you have anything Thursday?" (a44374c9).
  // Never a day they speak of in the past ("I had Botox last Friday").
  const bookingADay = day !== null && BOOK_INTENT.test(words) && !PAST_DAY.test(words) && progress.rpConfirmed !== true;
  if (!AVAILABILITY_ASK.test(words) && !ANY_TIME.test(words) && !bookingADay) return null;
  if (day === null) {
    // The earliest time not yet offered: "whatever you have" never hears the same list again (a44374c9).
    const first = freeSlots(context, progress, { from: null, to: null }, null)[0];
    return first ? said(`The earliest I have is ${slotSaid(context, first)}. Would that work?`, [first]) : null;
  }
  const span = spans.get(day)!;
  const times = twoTimes(span, ask);
  if (times.length === 0) {
    const fallback = twoTimes(span, null);
    const instead = offer(day, fallback);
    return said(`We close at ${clock(span.close)} on ${WEEKDAY_NAMES[day]}s.${instead ? ` Would ${instead} work instead?` : ""}`, on(day, fallback));
  }
  return said(`On ${nextDateOn(context, day)}, I have ${times.map(clock).join(" or ")}. Would ${times.length === 2 ? "either of those" : "that"} work?`, on(day, times));
}

/** "Any day", "anytime", "whatever you have", "as soon as possible", "first available": no time asked, the earliest wanted. */
const ANY_TIME =
  /\b(?:any ?(?:day|time)|anytime|whenever(?: you (?:have|can))?|what ?ever (?:you(?:'ve| have| got)|is (?:free|open|available))|(?:first|earliest|soonest|next) (?:available|thing|opening|slot)|as soon as (?:possible|you can)|asap|give me (?:whatever|anything|something))\b/i;

/** A day spoken of in the past: "last Friday", "I had it done Monday". */
const PAST_DAY = /\blast\s+(?:sun|mon|tue|wed|thu|fri|sat)|\b(?:had|got|did|was|were|went)\b/i;

/** Words that ask to book something, with a day named ("I need a consult Thursday afternoon"). */
const BOOK_INTENT = /\b(?:book|appointment|consult(?:ation)?|come in|get in|schedule|see (?:dr|the doctor|someone)|need|want|looking for|available|free|open)\b/i;

/** A window of the day the caller asked for: from a time, before one, or both, in minutes; and how they said it. */
type DemoWindow = { from: number | null; to: number | null; said: string };

const CLOCK_WORDS = String.raw`(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)(?::(\d{2}))?\s*(a\.?\s?m\b\.?|p\.?\s?m\b\.?|o'?clock)?`;

/** "After four PM", "before noon", "later than 5": the window, read in code; null when they named none. */
export function windowIn(words: string): DemoWindow | null {
  const after = new RegExp(String.raw`\b(?:after|from|later than|past|any ?time after)\s+${CLOCK_WORDS}`, "i").exec(words);
  const before = new RegExp(String.raw`\b(?:before|earlier than|no later than)\s+(?:${CLOCK_WORDS}|(noon|midday))`, "i").exec(words);
  const at = (m: RegExpExecArray, i: number): number | null => {
    if (m[i + 3]) return 12 * 60;
    const raw = m[i];
    if (!raw) return null;
    const hour = HOUR_WORDS[raw.toLowerCase()] ?? Number(raw);
    if (!(hour >= 1 && hour <= 12)) return null;
    const part = (m[i + 2] ?? "").toLowerCase();
    // No AM or PM: a front desk's hours decide (1 to 7 is the afternoon, 8 to 11 the morning).
    const pm = part.startsWith("p") || (!part.startsWith("a") && (hour <= 7 || hour === 12));
    return ((hour % 12) + (pm ? 12 : 0)) * 60 + Number(m[i + 1] ?? 0);
  };
  const from = after ? at(after, 1) : null;
  const to = before ? at(before, 1) : null;
  if (from === null && to === null) return null;
  const saidAt = (m: number) => clock(m);
  return { from, to, said: from !== null && to !== null ? `between ${saidAt(from)} and ${saidAt(to)}` : from !== null ? `after ${saidAt(from)}` : `before ${saidAt(to!)}` };
}

/**
 * Free times in a window, from the day after the call was issued, on the
 * hour, inside each day's hours, never one offered before in the call; on
 * one weekday when they named it. The demo's calendar is made up (the page
 * says so): every hour inside the hours is free, but for the one shown taken.
 */
function freeSlots(context: Pick<DemoCallContext, "clinic" | "issuedAt">, progress: DemoProgress, window: { from: number | null; to: number | null }, weekday: number | null): DemoSlot[] {
  const spans = openSpans(context);
  const zone = demoTimeZone(context.clinic.address);
  // Never one offered before, shown taken, or the one they are booked for.
  const seen = [...(progress.offeredAll ?? []), ...(progress.confirmedAt ? [progress.confirmedAt] : [])];
  const out: DemoSlot[] = [];
  // The demo's own earliest time first (demoSlots), so "what's your earliest?" keeps its answer.
  for (const slot of weekday === null && window.from === null && window.to === null ? demoSlotTimes(context) : []) {
    if (!seen.some((s) => s.day === slot.day && s.minutes === slot.minutes)) out.push(slot);
  }
  for (let k = 1; k <= 14 && out.length < 6; k += 1) {
    const d = weekdayOf(new Date(context.issuedAt + k * 86_400_000), zone);
    if (weekday !== null && d !== weekday) continue;
    const span = spans.get(d);
    if (!span) continue;
    const first = Math.ceil(Math.max(span.open, window.from ?? 0) / 60) * 60;
    const last = Math.floor((Math.min(span.close, window.to ?? 24 * 60) - 60) / 60) * 60;
    for (let m = first; m <= last && out.length < 6; m += 60) {
      if (out.some((s) => s.day === d && s.minutes === m) || seen.some((s) => s.day === d && s.minutes === m)) continue;
      out.push({ day: d, minutes: m });
    }
    if (weekday !== null) break;
  }
  return out;
}

/** How far after the call a time is, in minutes, for "sooner than what they are booked for". */
function slotOrder(context: Pick<DemoCallContext, "clinic" | "issuedAt">, slot: DemoSlot): number {
  const zone = demoTimeZone(context.clinic.address);
  for (let k = 1; k <= 7; k += 1) if (weekdayOf(new Date(context.issuedAt + k * 86_400_000), zone) === slot.day) return k * 1440 + slot.minutes;
  return 8 * 1440 + slot.minutes;
}

/** A time as a person says it: "Monday, November 2 at 4 PM". */
function slotSaid(context: Pick<DemoCallContext, "clinic" | "issuedAt">, slot: DemoSlot): string {
  return `${nextDateOn(context, slot.day)} at ${clock(slot.minutes)}`;
}

/** Two times said together: "4 PM or 5 PM that day", or each with its own date. */
function twoSaid(context: Pick<DemoCallContext, "clinic" | "issuedAt">, slots: readonly DemoSlot[], sameDayAs: number | null): string {
  const [a, b] = slots;
  if (!a) return "";
  if (!b) return a.day === sameDayAs ? `${clock(a.minutes)} that day` : slotSaid(context, a);
  if (a.day === b.day) return a.day === sameDayAs ? `${clock(a.minutes)} or ${clock(b.minutes)} that day` : `${nextDateOn(context, a.day)} at ${clock(a.minutes)} or ${clock(b.minutes)}`;
  const first = a.day === sameDayAs ? `${clock(a.minutes)} that day` : slotSaid(context, a);
  return `${first} or ${slotSaid(context, b)}`;
}

/** The answer to a window ("after four PM next week"): the first time in it shown taken once a call, then two that fit. */
function windowAnswer(context: Pick<DemoCallContext, "clinic" | "issuedAt">, progress: DemoProgress, window: DemoWindow, weekday: number | null): { line: string; offered: DemoSlot[]; taken?: DemoSlot } {
  const free = freeSlots(context, progress, window, weekday);
  if (free.length === 0) {
    const fallback = freeSlots(context, progress, { from: null, to: null }, weekday).slice(0, 2);
    const instead = fallback.length > 0 ? ` Would ${twoSaid(context, fallback, null)} work instead?` : "";
    return { line: `I don't have anything ${window.said}${weekday !== null ? ` on ${WEEKDAY_NAMES[weekday]}` : ""}.${instead}`, offered: fallback };
  }
  if (!progress.takenShown && free.length >= 3) {
    const [taken, ...rest] = free;
    const two = rest.slice(0, 2);
    return { line: `Ah, ${slotSaid(context, taken!)} is already taken, but I can do ${twoSaid(context, two, taken!.day)}. Would either of those work?`, offered: two, taken: taken! };
  }
  const two = free.slice(0, 2);
  return { line: `I have ${twoSaid(context, two, null)}. Would ${two.length === 2 ? "either of those" : "that"} work?`, offered: two };
}

const YES_PICK = /^\W*(?:yes|yeah|yep|yup|sure|ok(?:ay)?|perfect|great|sounds (?:good|great)|that (?:works|one|'?s (?:fine|great|perfect))|works for me|let'?s do (?:it|that)|book (?:it|that)|do it|please do)\b/i;
const NOT_PICK = /\b(?:no|not|can'?t|cannot|don'?t|doesn'?t|won'?t|neither|other)\b/i;

/** The offered time their words pick ("Monday works", "the second one", "5 PM", "yes" to a single time); null when none. */
export function slotPicked(words: string, offered: readonly DemoSlot[]): DemoSlot | null {
  if (offered.length === 0 || NOT_PICK.test(words) || SAID_NO.test(words.trim())) return null;
  const minutes = requestedTime(words)?.minutes ?? null;
  const bare = minutes === null ? /\b(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)(?::(\d{2}))?\b/i.exec(words) : null;
  const hour = bare ? (HOUR_WORDS[bare[1]!.toLowerCase()] ?? Number(bare[1])) : null;
  const day = weekdayIn(words);
  const fits = offered.filter(
    (s) => (minutes === null || s.minutes === minutes) && (hour === null || (Math.floor(s.minutes / 60) % 12) === hour % 12) && (day === null || s.day === day),
  );
  if ((minutes !== null || hour !== null || day !== null) && fits.length === 1) return fits[0]!;
  if (/\b(?:first|earlier|former)\b/i.test(words)) return offered[0]!;
  if (offered.length === 2 && /\b(?:second|later|latter|last)\b/i.test(words)) return offered[1]!;
  if (YES_PICK.test(words) && offered.length === 1) return offered[0]!;
  return null;
}

/** A doctor they asked for by name who is not on the practice's list ("doctor Smith"); null when none or when it is one of theirs. */
export function unknownDoctorIn(clinic: Pick<DemoCallClinic, "providers">, words: string): string | null {
  const m = /\b(?:Dr\.?|[Dd]octor)\s+([A-Z][a-z]{2,})\b/.exec(words);
  if (!m) return null;
  const surname = m[1]!;
  if (WEEKDAY_NAMES.some((d) => d === surname) || /^(?:Who|Office|Appointment|Visit)$/.test(surname)) return null;
  return clinic.providers.some((p) => new RegExp(`\\b${surname}\\b`, "i").test(p.name)) ? null : `Dr. ${surname}`;
}

/** What she says of a doctor not on the list: who is, so nobody is booked with someone who isn't there. */
export function unknownDoctorLine(clinic: Pick<DemoCallClinic, "providers">, doctor: string): string {
  const names = clinic.providers.map((p) => p.name).slice(0, 3);
  if (names.length === 0) return `Just so you know, we don't have a ${doctor} here.`;
  return `Just so you know, we don't have a ${doctor} here; ${names.length === 1 ? `our physician is ${names[0]}` : `our providers are ${names.slice(0, -1).join(", ")} and ${names.at(-1)}`}.`;
}

/** A question about free times: "Do you have anything Thursday afternoon?", "What's your earliest opening?" */
const AVAILABILITY_ASK =
  /\b(?:do|does) (?:you|she|he|they|the team) have (?:anything|any(?:thing)? (?:time|times|slots?|openings?|availability|appointments?)|(?:a |any )?(?:time|slots?|openings?|availability|appointments?))\b|\bany(?:thing| times?| slots?| openings?| appointments?) (?:available|free|open)\b|\b(?:earliest|soonest|next) (?:of )?(?:opening|appointment|availability|available|slot|time)s?\b|\bwhat (?:times?|slots?|days?) (?:do you have|are (?:free|available|open))\b|\bwhen(?:'s| is) (?:your|the) (?:earliest|next)\b|\b(?:are you|is (?:she|he|the team|anyone)) (?:free|available|open) (?:on|this|next|tomorrow)\b/i;

/**
 * Her words saying the request is in, passed on or with the team (c4093be6:
 * "I'll pass your request to the team" with no name or number taken).
 */
const REQUEST_IN =
  /\b(?:i'?ll|i will|i'?ve|i have|let me)\s+(?:pass|put|send|get|note|add)\b[^.?!]*\b(?:request|that|it|this|you)\b[^.?!]*\b(?:team|through|in|down|along)\b|\b(?:the )?team (?:will|'ll) (?:confirm|be in touch|call|reach out|get back)\b|\byour request is in\b/i;

/** "...your Friday morning request" after it was cancelled: any "your ... request" that is not the cancellation. */
const STILL_PENDING = /\byour\b[^.?!]*\b(?:request|booking|appointment)\b/i;

/**
 * Her words that a booking is made, set or confirmed, or that she can't
 * confirm it (a44374c9): the call says the booking itself (demoConfirmLine),
 * once, so hers are held and checked.
 */
const BOOKED_SAID =
  /\b(?:you'?re (?:all )?(?:set|booked|confirmed|locked in)|(?:i'?ve|i have) (?:got )?you (?:booked|down|in|set|scheduled)|(?:is|are|it'?s|that'?s) (?:now )?(?:booked|confirmed|locked in|all set|scheduled)|lock(?:ed)? (?:you|it|that) in|booked (?:you|it|that)|i (?:can'?t|cannot) confirm)\b/i;

/** A sentence naming a weekday or a date and a clock time: the booking said again once it is made (a44374c9: seven times). */
const DAY_AND_TIME = /\b(?:sun|mon|tues?|wed(?:nes)?|thu(?:rs?)?|fri|sat(?:ur)?)(?:day)?\b[^.?!]*\b\d{1,2}(?::\d{2})?\s*(?:a\.?m|p\.?m)\b/i;

/** Whether a role-play sentence must wait until the turn's booking is known (speak holds it back). */
export function roleplayHolds(
  sentence: string,
  booking: RoleplayBooking | undefined,
  progress: Pick<DemoProgress, "rpConfirmed" | "askedBooking" | "frustrated" | "apologised"> = {},
): boolean {
  return (
    REQUEST_IN.test(sentence) ||
    // An apology on its own, once she has made one, waits to be taken out (a44374c9).
    (progress.apologised === true && APOLOGY_ONLY.test(sentence)) ||
    // "Glad that works!" to sarcasm waits too, so the check can take it out before it is said (a44374c9).
    (progress.frustrated === true && GLAD_IT_WORKS.test(sentence)) ||
    BOOKED_SAID.test(sentence) ||
    // A day and a time wait too: the booking may be said by the call this turn, or must not be said again.
    (progress.askedBooking !== true && DAY_AND_TIME.test(sentence)) ||
    (booking?.status === "cancelled" && STILL_PENDING.test(sentence) && !/\bcancel/i.test(sentence))
  );
}

/** A sentence that is only an apology: "I'm sorry this has been so frustrating." */
const APOLOGY_ONLY = /^\W*(?:i'?m |i am )?(?:so |really |very )?(?:sorry|apologi[sz]e)\b[^.?!]*[.!]?$/i;
/** What she says when nothing of her reply stands, never twice in a row. */
const CALM_NEXT = ["Anything else I can help with?", "Is there anything else you need?", "What else can I do for you?"] as const;
const FRUSTRATED_NEXT = ["I hear you. What would make this easier for you?", "Understood. Is there anything I can sort out for you right now?", "Got it. What would you like me to do?"] as const;

/** "Glad that works!" said to "convenient." after a complaint (a44374c9): sarcasm is never taken as agreement. */
const GLAD_IT_WORKS = /^\W*(?:(?:so )?glad|great|awesome|wonderful|perfect)\b[^.?!]{0,25}\b(?:works?|helps?|that|it)\b[^.?!]*[.!]?$/i;

/**
 * The booking said in the call's own words, once it has a treatment, a day
 * and time inside the hours, a first name and a number (owner, 1 November
 * 2026, on a44374c9: "take it to 10/10"). A demo's calendar is made up, as
 * its page says, so the booking is confirmed the way a clinic's is with its
 * calendar connected and "Auto-confirm bookings" on, the product's default:
 * not "the team will confirm within a day", which a caller heard seven times.
 * Her first name for the caller is said here, once.
 */
export function demoConfirmLine(context: Pick<DemoCallContext, "clinic" | "issuedAt">, booking: RoleplayBooking, slot: DemoSlot, moved = false): string {
  const provider = routingProvider(context.clinic.providers.map((p) => p.name));
  const menu = listedIn(booking.service ?? "", context.clinic.services.map((svc) => svc.name))[0];
  const service = (menu ?? booking.service ?? "appointment")
    .replace(/[®™]/g, "")
    .replace(/^\s*(?:a|an|the|my|your)\s+/i, "")
    .replace(/\s+(?:with|for)\s+(?:dr\.?|doctor)\b.*$/i, "")
    .trim();
  const withWhom = provider && !new RegExp(`\\b${provider.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(service) ? ` with ${provider}` : "";
  const when = `${nextDateOn(context, slot.day)} at ${clock(slot.minutes)}`;
  if (moved) return `Done! I've moved your ${service}${withWhom} to ${when}. Anything else I can help with?`;
  const name = (booking.name ?? "").trim().split(/\s+/)[0] ?? "";
  const first = name ? `, ${name.charAt(0).toUpperCase()}${name.slice(1)}` : "";
  return `You're all set${first}! Your ${service}${withWhom} is booked for ${when}. Anything else I can help with?`;
}

/** The booking's day and time when the call may confirm it: a treatment, a name, a number, and a day and time inside the hours; else null. */
export function demoBookable(context: Pick<DemoCallContext, "clinic" | "issuedAt">, booking: RoleplayBooking | undefined): DemoSlot | null {
  const b = booking ?? {};
  if (b.status === "cancelled" || !b.service || !b.name || !b.phone || !b.day || !b.time) return null;
  const day = weekdayIn(b.day);
  if (day === null) return null;
  const span = openSpans(context).get(day);
  if (!span) return null;
  const exact = requestedTime(b.time)?.minutes ?? null;
  const bare = exact === null ? /\b(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)(?::(\d{2}))?\b/i.exec(b.time) : null;
  const hour = bare ? (HOUR_WORDS[bare[1]!.toLowerCase()] ?? Number(bare[1])) : null;
  const candidates = exact !== null ? [exact] : hour !== null && hour >= 1 && hour <= 12 ? [(hour % 12) * 60, ((hour % 12) + 12) * 60].map((m) => m + Number(bare![2] ?? 0)) : [];
  const minutes = candidates.find((m) => m >= span.open && m <= span.close - 30);
  return minutes === undefined ? null : { day, minutes };
}

/** Her goodbye, which goes when the end it was for does not stand (roleplayEndAllowed). */
const BYE_SAID = /\b(?:thanks for calling|have a (?:great|good|nice|lovely) (?:day|one|weekend)|take care|good-?bye|bye(?:-bye)?|see you (?:then|soon|on))\b/i;

/** What she asks for next, in the order a front desk does. */
const NEXT_ASK: Readonly<Record<ReturnType<typeof bookingMissing>[number], string>> = {
  treatment: "Which treatment is it for?",
  "day and time": "What day and time would suit you?",
  "first name": "Can I get your first name?",
  number: "And what's the best number to reach you on?",
};

/** A reply's sentences, never cut after "Dr." or "a.m." (a44374c9: "...with Dr." and "Patel for Monday" as two). */
function splitSentences(reply: string): string[] {
  const out: string[] = [];
  for (const piece of reply.split(/(?<=[.!?])\s+/).filter(Boolean)) {
    const last = out.at(-1);
    if (last && /\b(?:Dr|Mr|Mrs|Ms|Prof|St|Ste|Rd|Ave|Blvd|vs|e\.g|i\.e|a\.m|p\.m)\.$/i.test(last)) out[out.length - 1] = `${last} ${piece}`;
    else out.push(piece);
  }
  return out;
}

/**
 * Her role-play reply once the turn's booking is known, the code's last word
 * on criterion 6 of c4093be6: no request is said to be in before the
 * treatment, a day and time, a first name and a number are on file (for a
 * cancellation, the name and the number), and a cancelled request is never
 * spoken of as pending. Sentences are only ever taken out, then the next
 * thing needed asked for. The guard's own booking line, which says the
 * request is passed on, gets the same treatment.
 */
export function roleplayCheckedReply(
  reply: string,
  booking: RoleplayBooking | undefined,
  options: {
    guard?: string | null;
    spokenBefore?: string;
    endRefused?: boolean;
    confirmed?: boolean;
    askedBooking?: boolean;
    frustrated?: boolean;
    frustratedNow?: boolean;
    apologised?: boolean;
    said?: readonly string[];
  } = {},
): string {
  const b = booking ?? {};
  const cancelled = b.status === "cancelled";
  const askFor = (m: ReturnType<typeof bookingMissing>[number]) => (m === "day and time" && b.day ? `What time on ${b.day} suits you best?` : NEXT_ASK[m]);
  const missing = cancelled ? bookingMissing(b).filter((m) => m === "first name" || m === "number") : bookingMissing(b);
  const ask = missing.length > 0 ? (cancelled && missing[0] === "first name" ? "Can I get your first name for the cancellation?" : askFor(missing[0]!)) : null;
  if (options.guard === "booking_confirmation") {
    // Her claim to book was refused: after words routing them to the provider, the consultation is offered;
    // otherwise the request is offered, and what it still needs asked for (never "for the cancellation": this is a new one).
    const before = options.spokenBefore?.trim() ?? "";
    if (/\b(?:dr\.?|doctor|consult(?:ation)?|provider)\b/i.test(before)) return `${before} Want me to put in a request for a consultation?`;
    const fresh = bookingMissing(cancelled ? {} : b);
    const next = fresh.length > 0 ? askFor(fresh[0]!) : null;
    return next ? [before, `Great, let's get that booked. ${next}`].filter(Boolean).join(" ") : reply;
  }
  // Once the booking is said, it is never said again unless they ask (a44374c9: seven times), nor "the team will confirm".
  const restated = (s: string) => options.confirmed === true && !cancelled && options.askedBooking !== true && (REQUEST_IN.test(s) || BOOKED_SAID.test(s) || DAY_AND_TIME.test(s));
  // "I can't offer a discount, but I can request your evaluation for Monday at 4 PM": the answer before "but" stays.
  const sentences = splitSentences(reply).map((s) => {
    const lead = /^(.{8,}?),\s+but\b/i.exec(s);
    return lead && restated(s) && !restated(`${lead[1]}.`) ? `${lead[1]}.` : s;
  });
  const kept = sentences.filter(
    // A goodbye goes too while the request still needs something: the call is not over (c4093be6: "have a great day!" mid-booking).
    (s) =>
      !(ask && (REQUEST_IN.test(s) || BOOKED_SAID.test(s))) &&
      !restated(s) &&
      !(options.frustrated === true && GLAD_IT_WORKS.test(s)) &&
      !(options.apologised === true && APOLOGY_ONLY.test(s)) &&
      !(cancelled && STILL_PENDING.test(s) && !/\bcancel/i.test(s)) &&
      !((options.endRefused || (ask && sentences.some((x) => REQUEST_IN.test(x)))) && BYE_SAID.test(s)),
  );
  // Nothing taken out or cut short: her words as written.
  if (kept.length === sentences.length && kept.join(" ") === splitSentences(reply).join(" ")) return reply;
  if (kept.length === 0) {
    if (ask) return `${cancelled ? "Sure." : "Great, let's get that booked."} ${ask}`;
    // Never a line she has said in the call (a44374c9): to frustration, an offer to make it easier.
    const choices = options.frustratedNow === true ? FRUSTRATED_NEXT : CALM_NEXT;
    return choices.find((line) => !(options.said ?? []).some((before) => before.includes(line))) ?? choices.at(-1)!;
  }
  if (!ask) return /\?\W*$/.test(kept.at(-1)!) || !options.endRefused ? kept.join(" ") : `${kept.join(" ")} Anything else I can help with?`;
  return /\?\W*$/.test(kept.at(-1)!) ? kept.join(" ") : `${kept.join(" ")} ${ask}`;
}

/** In the role-play, an in-hours time they asked for: she takes it as their preferred time (roleplayTimeLine says the rest). */
function timeLines(context: Pick<DemoCallContext, "clinic" | "issuedAt">, progress: DemoProgress, clinic: string): string[] {
  const ask = progress.rpTime ?? null;
  const day = progress.rpDay ?? null;
  if (ask?.minutes === null || ask?.minutes === undefined || day === null) return [];
  const span = openSpans(context).get(day);
  if (!span || ask.minutes < span.open || ask.minutes > span.close - 30) return [];
  return [`They asked for ${WEEKDAY_NAMES[day]} at ${ask.said}, on ${nextDateOn(context, day)}, which is within ${clinic}'s hours and free: take it, and ask for whatever the booking still needs. Never say it is booked yourself: the call does, once it has everything.`];
}

const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;

/** The weekdays an hours line names ("Mon-Fri", "Mon, Wed", "Saturday", "Daily"), as 0 (Sunday) to 6; empty when it names none. */
export function hoursDays(days: string): number[] {
  const d = days.toLowerCase();
  if (/\b(?:daily|every ?day|7 days|seven days)\b/.test(d)) return [0, 1, 2, 3, 4, 5, 6];
  const out = new Set<number>();
  const at = (word: string) => WEEKDAYS.findIndex((w) => word.startsWith(w));
  for (const m of d.matchAll(/([a-z]{3,9})\s*(?:-|–|—|to|through)\s*([a-z]{3,9})/g)) {
    const from = at(m[1]!);
    const to = at(m[2]!);
    if (from < 0 || to < 0) continue;
    for (let i = from; ; i = (i + 1) % 7) {
      out.add(i);
      if (i === to) break;
    }
  }
  for (const w of d.split(/[^a-z]+/)) {
    const i = w.length >= 3 ? at(w) : -1;
    if (i >= 0) out.add(i);
  }
  return [...out].sort((a, b) => a - b);
}

/** Opening and closing hours from "9am-6pm" or "9:00 AM - 6:00 PM", as minutes after midnight; null when closed or unreadable. */
export function hoursSpan(hours: string): { open: number; close: number } | null {
  const m = /(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:-|–|—|to)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i.exec(hours);
  if (!m) return null;
  const minutes = (h: string, mm: string | undefined, ap: string | undefined, fallback: "am" | "pm") => {
    let hour = Number(h) % 12;
    if ((ap ?? fallback).toLowerCase() === "pm") hour += 12;
    return hour * 60 + Number(mm ?? 0);
  };
  const open = minutes(m[1]!, m[2], m[3], "am");
  const close = minutes(m[4]!, m[5], m[6], "pm");
  return close - open >= 180 ? { open, close } : null;
}

function clock(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${h % 12 === 0 ? 12 : h % 12}${m ? `:${String(m).padStart(2, "0")}` : ""} ${h < 12 ? "AM" : "PM"}`;
}

/**
 * Three free times for the role-play: on the first open day after the call
 * was issued, two hours after opening and two hours before closing; on the
 * next open day, an hour after opening. In the clinic's own zone. Empty when
 * the hours cannot be read.
 */
export function demoSlots(context: Pick<DemoCallContext, "clinic" | "issuedAt">): string[] {
  return demoSlotTimes(context).map((slot) => slotSaid(context, slot));
}

/** The demo's three free times (demoSlots), as weekdays and minutes. */
export function demoSlotTimes(context: Pick<DemoCallContext, "clinic" | "issuedAt">): DemoSlot[] {
  const zone = demoTimeZone(context.clinic.address);
  const open = openSpans(context);
  if (open.size === 0) return [];
  const days: { day: number; span: { open: number; close: number } }[] = [];
  for (let k = 1; k <= 10 && days.length < 2; k += 1) {
    const day = weekdayOf(new Date(context.issuedAt + k * 86_400_000), zone);
    const span = open.get(day);
    if (span) days.push({ day, span });
  }
  const [first, second] = days;
  if (!first) return [];
  const round = (m: number) => Math.round(m / 60) * 60;
  const out: DemoSlot[] = [
    { day: first.day, minutes: round(first.span.open + 120) },
    { day: first.day, minutes: round(first.span.close - 120) },
  ];
  if (second) out.push({ day: second.day, minutes: round(second.span.open + 60) });
  return out;
}

/**
 * The fixed urgent reply as a demo says it (owner, 1 November 2026, on
 * a44374c9: "I have some swelling after my last procedure" heard a cold
 * "please call Miami Skin & Vein", the practice the caller was calling): a
 * word of sympathy first, and the number named as the clinical team's
 * direct line. "AI assistant", the 9-1-1 sentence and the number stay as
 * the catalog has them; a clinic's own calls keep the catalog's lines,
 * which wait on the medical director's sign-off.
 */
export function demoUrgentLine(reply: string): string {
  return reply
    .replace("I'm an AI assistant, so I can't help with anything urgent here.", "I'm so sorry you're dealing with that. I'm an AI assistant, so I can't advise on symptoms.")
    .replace(/Otherwise, please call .+? on ([^.]+)\./, "Otherwise, please call our clinical team directly on $1, so they can help.");
}

/** A published US number as E.164, or null for anything that is not ten digits (with or without the 1). */
function usNumber(raw: string | null): string | null {
  const digits = (raw ?? "").replace(/\D/g, "");
  const national = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  return national.length === 10 ? `+1${national}` : null;
}

/**
 * What healdesk's Aya may never say while she plays the clinic's front desk
 * (c4093be6: healdesk's prices, the setup discount, "Book Onboarding" and
 * hello at healdesk dot io said to the "patient"). On the clinic's
 * never-say list for the role-play, so the guard, which already owns what a
 * patient's call may hear, refuses any of it, whatever the model wrote.
 */
export const ROLEPLAY_NEVER_SAY = ["healdesk", "heal desk", "setup fee", "onboarding", "demo page", "Aya Voice", "Aya Web Chat", "Aya Meta Chat", "getting that running", "hundred minutes", "on our side"] as const;

/** A role-play reply refused outright for healdesk's words: the practice's answer to what it does not know (criterion 7 of c4093be6). */
export const ROLEPLAY_UNKNOWN_LINE = "I don't know that one, but the team can confirm it for you. Anything else I can help with?";

/** The facts for the role-play: the clinic's own, with healdesk's words on its never-say list (ROLEPLAY_NEVER_SAY), and the close's "get <clinic> set up". */
export function demoRoleplayFacts(facts: AssistantFacts): AssistantFacts {
  const short = shortClinicName(facts.clinicName);
  const setUp = [...new Set([facts.clinicName, short])].map((name) => `${name} set up`);
  return { ...facts, neverSay: [...facts.neverSay, ...ROLEPLAY_NEVER_SAY, ...setUp] };
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
    // Never put a demo call through anywhere: no published number, and no
    // transfer (retell.ts gives a demo call no urgentTransferTo). The
    // practice's own published number is the one an urgent reply reads out,
    // as a clinic's urgent-help number is on a patient's call (c4093be6: 9-1-1
    // alone, and never "call the clinic now").
    phone: null,
    assistantNumber: null,
    urgentPhone: usNumber(clinic.phone),
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
    // Her own workings and claims healdesk does not make are refused (guard.ts, offScript; a17b5aff).
    demoCall: true,
  };
}

