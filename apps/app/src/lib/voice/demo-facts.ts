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
};

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
    ...roleplayHeard(progress, words),
  };
}

/** The progress once a reply is said: the booking details her state gave, a cancel the caller just asked for standing over a stale status. */
export function afterDemoReply(progress: DemoProgress, _from: DemoStage, _to: DemoStage, update: DemoStateUpdate | null, callerWords = ""): DemoProgress {
  return {
    ...progress,
    rpBooking: update?.booking
      ? {
          ...progress.rpBooking,
          ...update.booking,
          ...(progress.rpBooking?.status === "cancelled" && CANCEL_ASK.test(callerWords) ? { status: "cancelled" as const } : {}),
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
    `In the JSON details, add a "state" object: {"booking": {"service", "day", "time", "name", "phone", "status"} with whatever of these the caller has given so far for the booking, in their words, and "status": "requested" once you have told them the request is in}.`,
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
  /** Where the request stands: put in, moved, or cancelled. */
  status?: "requested" | "rescheduled" | "cancelled";
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
function roleplayHeard(progress: DemoProgress, words: string): Pick<DemoProgress, "rpBooking" | "rpDay" | "rpTime"> {
  const booking = progress.rpBooking ?? {};
  const day = weekdayIn(words);
  const status = CANCEL_ASK.test(words) ? "cancelled" : MOVE_ASK.test(words) && booking.status !== "cancelled" && (booking.day || booking.time) ? "rescheduled" : booking.status;
  // Her last question asked for their name or their number: these words are it,
  // kept in code so a state she forgot never holds the request back.
  const asked = progress.lastQuestion ?? "";
  const said = words.trim().replace(/^(?:it'?s|my name is|my name'?s|this is|i'?m)\s+/i, "").replace(/[.!?]+$/, "");
  const name = !booking.name && /\bname\b/i.test(asked) && said && said.split(/\s+/).length <= 3 && !SAID_NO.test(words.trim()) ? said.slice(0, 60) : booking.name;
  const phone = !booking.phone && /\bnumber\b/i.test(asked) && said && !SAID_NO.test(words.trim()) ? said.slice(0, 60) : booking.phone;
  const next: RoleplayBooking = { ...booking, ...(status ? { status } : {}), ...(name ? { name } : {}), ...(phone ? { phone } : {}) };
  return {
    rpBooking: next,
    rpDay: day ?? progress.rpDay ?? null,
    rpTime: requestedTime(words),
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

const NAME_RULE = `Your name is Aya: write it exactly "Aya", never "AYA" and never spelled out.`;

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
      ? `Still needed before the request goes in: ${missing.join(", ")}. Ask for the next one only, in one short question.`
      : `You have everything${b.status === "rescheduled" ? ", with the new time" : ""}: say in one sentence that the team will confirm ${b.status === "rescheduled" ? "the new time" : "that time"} within a day, then ask if there is anything else.`,
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
    `The calendar has these free times: ${slots.join("; ")}. When they want to book, offer one or two of them; if they want another time within the hours, take it as their preferred time. Never say a time "works", is free or is open unless it is one of these, never invent another free time, and never say a time is booked, held or confirmed: you put the request in and the team confirms it within a day.`,
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
  const line = timeAnswer(context, progress, words);
  return line ? `${calendarLead(context, progress)} ${line}` : null;
}

/**
 * What she says as she looks at the calendar (owner, 1 November 2026: "she
 * should use the filler to look into it"): the first time on a call, the
 * day's pleasantry with it (RECEPTIONIST_MANNER in prompt.ts, in the clinic's
 * zone on the day the call began); after that, a short "let me look".
 */
export function calendarLead(context: Pick<DemoCallContext, "clinic" | "issuedAt">, progress: DemoProgress): string {
  // A caller who keeps it brief (two turns or more, none over five words) gets no pleasantry: she mirrors their efficiency (owner, 1 November 2026).
  if (progress.lookedUp || isBriefCaller(progress)) return "Let me take a look...";
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

function timeAnswer(context: Pick<DemoCallContext, "clinic" | "issuedAt">, progress: DemoProgress, words: string): string | null {
  const spans = openSpans(context);
  if (spans.size === 0) return null;
  const ask = progress.rpTime ?? null;
  const day = weekdayIn(words) ?? (ask ? (progress.rpDay ?? null) : null);
  const offer = (d: number, times: number[]) => (times.length === 2 ? `${nextDateOn(context, d)} at ${clock(times[0]!)} or ${clock(times[1]!)}` : times.length === 1 ? `${nextDateOn(context, d)} at ${clock(times[0]!)}` : null);
  const nextOpen = (from: number) => [1, 2, 3, 4, 5, 6, 7].map((k) => (from + k) % 7).find((d) => spans.has(d));
  if (day !== null && !spans.has(day) && (ask || AVAILABILITY_ASK.test(words) || /\b(?:book|appointment|come in)\b/i.test(words))) {
    const d = nextOpen(day);
    const times = d === undefined ? null : offer(d, twoTimes(spans.get(d)!, ask));
    return `We're closed on ${WEEKDAY_NAMES[day]}s.${times ? ` Would ${times} work instead?` : " Which other day would suit you?"}`;
  }
  if (ask?.minutes !== null && ask?.minutes !== undefined) {
    if (day === null) {
      const inside = [...spans.values()].some((span) => ask.minutes! >= span.open && ask.minutes! <= span.close - 30);
      return inside ? null : `Sorry, ${ask.said} is outside our hours. What day would suit you? I'll find you a time within them.`;
    }
    const span = spans.get(day)!;
    if (ask.minutes < span.open || ask.minutes > span.close - 30) {
      const times = offer(day, twoTimes(span, ask));
      return `We're open ${clock(span.open)} to ${clock(span.close)} on ${WEEKDAY_NAMES[day]}s, so ${ask.said} is outside our hours.${times ? ` Would ${times} work instead?` : ""}`;
    }
    // The first time they ask for, once a call, is already taken, and two near it are offered at once
    // (owner, 1 November 2026: show that she is proactive). Never a time she just offered them.
    const offered = (progress.lastQuestion ?? "").includes(clock(Math.floor(ask.minutes / 60) * 60)) || demoSlots(context).some((slot) => slot.endsWith(` at ${clock(ask.minutes!)}`));
    if (!progress.takenShown && !offered) {
      const near = nearTimes(span, ask.minutes);
      if (near.length === 2) {
        return `Ah, ${clock(Math.floor(ask.minutes / 60) * 60)} on ${nextDateOn(context, day)} is already taken, but I can do ${clock(near[0]!)} or ${clock(near[1]!)} that day. Would either of those work?`;
      }
    }
    return null;
  }
  if (!AVAILABILITY_ASK.test(words)) return null;
  if (day === null) {
    const first = demoSlots(context)[0];
    return first ? `The earliest I have is ${first}. Would that work?` : null;
  }
  const span = spans.get(day)!;
  const times = twoTimes(span, ask);
  if (times.length === 0) {
    const instead = offer(day, twoTimes(span, null));
    return `We close at ${clock(span.close)} on ${WEEKDAY_NAMES[day]}s.${instead ? ` Would ${instead} work instead?` : ""}`;
  }
  return `On ${nextDateOn(context, day)}, I have ${times.map(clock).join(" or ")}. Would ${times.length === 2 ? "either of those" : "that"} work?`;
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

/** Whether a role-play sentence must wait until the turn's booking is known (speak holds it back). */
export function roleplayHolds(sentence: string, booking: RoleplayBooking | undefined): boolean {
  return REQUEST_IN.test(sentence) || (booking?.status === "cancelled" && STILL_PENDING.test(sentence) && !/\bcancel/i.test(sentence));
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
  options: { guard?: string | null; spokenBefore?: string; endRefused?: boolean } = {},
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
    return next ? [before, `I can't confirm it myself, but I can put the request in. ${next}`].filter(Boolean).join(" ") : reply;
  }
  const sentences = reply.split(/(?<=[.!?])\s+/).filter(Boolean);
  const kept = sentences.filter(
    // A goodbye goes too while the request still needs something: the call is not over (c4093be6: "have a great day!" mid-booking).
    (s) => !(ask && REQUEST_IN.test(s)) && !(cancelled && STILL_PENDING.test(s) && !/\bcancel/i.test(s)) && !((options.endRefused || (ask && sentences.some((x) => REQUEST_IN.test(x)))) && BYE_SAID.test(s)),
  );
  if (kept.length === sentences.length) return reply;
  if (kept.length === 0) return ask ? `${cancelled ? "Sure." : "Happy to put that in."} ${ask}` : "Anything else I can help with?";
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
  return [`They asked for ${WEEKDAY_NAMES[day]} at ${ask.said}, on ${nextDateOn(context, day)}, which is within ${clinic}'s hours: take it as their preferred time for the team to confirm. Never say it is free, booked or confirmed.`];
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
  const zone = demoTimeZone(context.clinic.address);
  const open = openSpans(context);
  if (open.size === 0) return [];
  const days: { label: string; span: { open: number; close: number } }[] = [];
  for (let k = 1; k <= 10 && days.length < 2; k += 1) {
    const at = new Date(context.issuedAt + k * 86_400_000);
    const span = open.get(weekdayOf(at, zone));
    if (!span) continue;
    days.push({ label: at.toLocaleDateString("en-US", { timeZone: zone, weekday: "long", month: "long", day: "numeric" }), span });
  }
  const [first, second] = days;
  if (!first) return [];
  const round = (m: number) => Math.round(m / 60) * 60;
  const out = [`${first.label} at ${clock(round(first.span.open + 120))}`, `${first.label} at ${clock(round(first.span.close - 120))}`];
  if (second) out.push(`${second.label} at ${clock(round(second.span.open + 60))}`);
  return out;
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

