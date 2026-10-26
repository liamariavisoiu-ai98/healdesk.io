import {
  DEMO_CALL_VARIABLE,
  DEMO_CALLBACK_OFFER,
  shortClinicName,
  FIRST_PERIOD_REFUND_DAYS,
  NEVER_SAY_DEFAULTS,
  openDaysPerWeek,
  PACKAGES,
  packageSetupFeeUsd,
  PRODUCTS,
  resolveBookingRequirements,
  setupAfterCreditUsd,
  USAGE_STEPS,
  STEP_UNITS,
  type DemoCallClinic,
  type DemoCallContext,
} from "@healdesk/catalog";

import type { AssistantFacts, AssistantService } from "@/lib/assistant/facts";
import { defaultChatGreeting, defaultPhoneGreeting } from "@/lib/setup/greetings";

import { callbackFrom, type DemoCallback } from "./demo-callback";

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
  const live = liveDiscount(offer, now);
  if (!live) return null;
  // "hours left", not "more hours": with a word between the number and the
  // unit, the guard's own dose-like-figure pattern (guard.ts, PLAIN_CLINICAL)
  // reads "about 10 more hours" as a figure it cannot place and refuses the
  // whole sentence as clinical. "about 10 hours left" keeps the unit right
  // after the number, which that pattern already knows to leave alone.
  return `A real, live discount applies right now: ${live.percent}% off healdesk's setup fee, with about ${live.hours} hour${live.hours === 1 ? "" : "s"} left on it, already applied at checkout. Say that percentage, that rough window and the discounted setup fees given here, and never a different number or a different amount of time.`;
}

/**
 * The cost anchor the pitch may quote once (owner, 25 October 2026): a
 * full-time receptionist's loaded monthly cost and the usual range for an
 * answering service. The owner's figures, said as context, never as
 * healdesk's prices; the guard lets exactly these through in the pitch only
 * (demoPitchFacts).
 */
export const MARKET_ANCHORS_USD = { receptionistFrom: 3_900, receptionistTo: 4_800, answeringFrom: 400, answeringTo: 1_500 } as const;

/**
 * The live discount as checkout applies it: the demo's own share of the
 * setup fee (50% for a demo an operator built and sent, 30% for one asked
 * for on the homepage) and the whole hours left of its 48. Null once it has
 * ended, so Aya never names a discount checkout would not give.
 */
export function liveDiscount(offer: Pick<DemoCallContext, "offer">["offer"], now: number): { percent: number; hours: number } | null {
  if (!offer || offer.endsAt <= now) return null;
  return { percent: offer.percentOfSetupFee, hours: Math.max(1, Math.round((offer.endsAt - now) / 3_600_000)) };
}

/**
 * A demo call's three stages (owner, 25 October 2026), tracked by the call
 * session (retell.ts) from her structured state (`"roleplay"`: start, cancel
 * or end), never from a phrase found in her words (test call 72dc66b7: a
 * bare "Ring ring!" in an ambiguous reply flipped the stage with no greeting
 * and no AI notice, and the exit line then came after no role-play):
 *   intro     who they are, their role, then the choice: hear more, or a
 *             role-play;
 *   roleplay  from the reply that starts it, whose opener the call says
 *             itself (demoRoleplayOpener): they play a patient, Aya is the
 *             clinic's front desk;
 *   pitch     from the reply that ends it, whose exit line the call says
 *             itself (DEMO_ROLEPLAY_EXIT): the pitch and the discovery
 *             questions.
 * Each stage has its own note (demoStageNote), so no stage's instructions
 * are repeated into another: repeating the opening's instructions deep into
 * a role-play is what made Aya seem to forget the caller's name (owner,
 * 24 October 2026).
 */
export type DemoStage = "intro" | "roleplay" | "pitch";

/**
 * The fixed words that start and end the role-play, which the call says
 * itself when her state asks for it (withRoleplayOpener, withRoleplayExit).
 * The stage also moves when the whole scripted line is in her words, so a
 * reply that wrote it out but forgot the state still counts; a bare "Ring
 * ring!" or a passing "how was that?" never does.
 */
export const DEMO_ROLEPLAY_EXIT = "And that's the role-play! So, how was that?";
export const DEMO_ROLEPLAY_START = /\bring[\s,!.-]*ring!?\s+hi,? thanks for calling\b/i;
export const DEMO_ROLEPLAY_END = /\band that'?s the role-?play!?\s+so,? how was that\b/i;

/** The roleplay moves her state may ask for. */
export type RoleplaySignal = "start" | "cancel" | "end";

/** The questions that open the talk after the role-play, and start it when the role-play is skipped. */
const PITCH_OPENERS: ReadonlySet<DemoQuestion> = new Set(["goal", "volume"]);

/**
 * The stage after a reply: moved on by her state (`roleplay`: start, cancel,
 * end; `resume`), or by the whole scripted line in her words, or, from the
 * intro, by her declaring a discovery question (`asked`). A role-play may be
 * skipped or run again from the pitch. "cancel" takes a role-play that the
 * caller did not want back to the stage it came from (`from`), with no exit
 * line; "end" only after at least one in-character exchange (`turns`),
 * otherwise it is a cancel too.
 */
export function nextDemoStage(
  stage: DemoStage,
  reply: string,
  signal: { asked?: DemoQuestion | null; roleplay?: RoleplaySignal | null; resume?: boolean } = {},
  from: DemoStage = "intro",
  turns = 1,
): DemoStage {
  const { asked = null, roleplay = null, resume = false } = signal;
  if (stage !== "roleplay") {
    if (roleplay === "start" || resume || DEMO_ROLEPLAY_START.test(reply)) return "roleplay";
    if (stage === "intro" && asked && PITCH_OPENERS.has(asked)) return "pitch";
    return stage;
  }
  if (roleplay === "cancel" || (roleplay === "end" && turns < 1)) return from;
  if (roleplay === "end" || DEMO_ROLEPLAY_END.test(reply)) return "pitch";
  return stage;
}

/**
 * The reply that starts a role-play, as it is said: her handover, if she
 * wrote one before "Ring ring", then the scripted opener word for word
 * (demoRoleplayOpener), which carries the AI and transcription notice the
 * owner is meant to hear. `spoken` is what already went out as she wrote it;
 * the result starts with it, so only the rest is sent.
 */
export function withRoleplayOpener(reply: string, opener: string, spoken = ""): string {
  if (reply.includes(opener)) return reply;
  const handover = reply.split(/\bring[\s,!.-]*ring\b/i)[0]!.trim();
  const full = [handover, opener].filter(Boolean).join(" ");
  if (!spoken || full.startsWith(spoken)) return full;
  // Some of her own words went out already: they stand, and the opener's
  // greeting follows them, its "Ring ring!" only if she has not said it.
  const rest = /\bring[\s,!.-]*ring\b/i.test(spoken) ? opener.replace(/^ring ring!\s*/i, "") : opener;
  return `${spoken} ${rest}`;
}

/** The reply that ends a role-play, as it is said: her in-character goodbye, then the scripted exit line, once. */
export function withRoleplayExit(reply: string, spoken = ""): string {
  if (DEMO_ROLEPLAY_END.test(reply)) return reply;
  const bye = reply.replace(/\s*and that'?s the role-?play!?[^]*$/i, "").trim();
  const full = [bye, DEMO_ROLEPLAY_EXIT].filter(Boolean).join(" ");
  if (!spoken || full.startsWith(spoken)) return full;
  return `${spoken} ${DEMO_ROLEPLAY_EXIT}`;
}

/** A bare yes ("Yes, please.", "Sure", "Yeah okay"): what cannot choose between two offers. */
export function isBareYes(words: string): boolean {
  return /^\W*(?:yes|yeah|yep|yup|sure|ok(?:ay)?|please|go ahead|sounds good|absolutely|definitely|of course)(?:[\s,!.]+(?:yes|yeah|please|sure|ok(?:ay)?|thanks|thank you|let'?s do it|go ahead))*\W*$/i.test(words.trim());
}

/** A reply that offered a role-play as one of two options ("...or jump into a quick role-play?"). */
export function offeredRoleplayChoice(reply: string | undefined): boolean {
  return Boolean(reply && /role-?play/i.test(reply) && /\bor\b/i.test(reply) && /\?\s*$/.test(reply.trim()));
}

/** What a bare yes to that choice hears: which one, never a guess. */
export const WHICH_ONE_LINE = "Happy to! Which one: the role-play, or more on what I can do?";

/**
 * The questions a demo asks, in order: who they are (the opening line's own
 * question) and what they want from the call, then, after the role-play,
 * what they are after before anything is sold (owner, 25 October 2026:
 * "before getting into selling healdesk to us she should ask questions, to
 * understand what the caller is after").
 */
export const DEMO_QUESTIONS = ["identity", "role", "choice", "goal", "volume", "volumeCheck", "missed", "coverage", "tiedown", "ask", "callback", "callbackNote"] as const;
export type DemoQuestion = (typeof DEMO_QUESTIONS)[number];

/**
 * The pitch, in the owner's order (25 October 2026), each said once: tie to
 * their pain, the reveal, keeping their number, what is not finished yet
 * with the discount, the cost anchor, value in their terms, one package, no
 * commitment, and the refund.
 */
export type DemoBeat = "pain" | "reveal" | "number" | "finish" | "anchor" | "value" | "recommend" | "noStrings" | "refund";

export const DEMO_BEATS: readonly DemoBeat[] = ["pain", "reveal", "number", "finish", "anchor", "value", "recommend", "noStrings", "refund"];

/**
 * What a demo call has found out (owner's test calls, 25 October 2026: "she
 * doesn't remember anything I say previously"). Each stage's note lists what
 * was answered, never to be asked again, and names the one next step; the
 * close and the live discount are not in any note until `coverage` is
 * answered (demoStageNote). In memory for the call only, like the rest of a
 * demo call: the words of a clinic's team member about their business,
 * never a patient's.
 *
 * Kept from her structured state update with each reply (DemoStateUpdate:
 * which scripted question the reply asks, which pitch beats it says), and
 * the caller's next words as the answer. Until 25 October it was read from
 * her prose by patterns ("how many calls", "fair to say"): a question put in
 * other words desynced it with nothing to notice, and after a guard refusal
 * derailed a call the close was asked with missed calls and coverage still
 * unanswered.
 */
export type DemoProgress = {
  /** The question Aya's last reply declared it asks, which the caller's next words answer. */
  asked: DemoQuestion | null;
  /** What the caller said back to each question, in their own words. */
  answers: Partial<Record<DemoQuestion, string>>;
  /** The caller's turns inside the role-play being run. */
  roleplayTurns: number;
  /** The pitch's beats already said (DemoBeat). */
  said: readonly DemoBeat[];
  /**
   * A call back they asked for (demo-callback.ts): "sent" once apps/web took
   * it and they heard so, "failed" once they heard hello@ instead, null
   * before either. Either way it is not offered again.
   */
  callback?: "sent" | "failed" | null;
  /**
   * Where the last role-play stopped (owner, 26 October 2026, 6d): the
   * caller's last words in it and Aya's last in-character line, kept across
   * "how was that?" so "wait, continue" resumes it rather than starting over.
   */
  lastRoleplay?: { caller: string; aya: string } | null;
  /** The pushback move her last reply used (DemoPushback), so the next resistance gets another. */
  pushback?: DemoPushback | null;
  /** Her signature touches already said on this call (DemoQuirk): each at most once. */
  quirks?: readonly DemoQuirk[];
  /** The stage a role-play was started from, which a cancelled one goes back to. */
  roleplayFrom?: DemoStage;
  /**
   * The caller has shown they are impatient or frustrated (test call
   * 72dc66b7: "You tired me... I'm done with repeating myself"): every open
   * discovery question is skipped, the note goes straight to the
   * recommendation and the close, and the call never ends on "Talk soon!".
   */
  impatient?: boolean;
  /** The menu items her last reply named, in the order she said them, so "the second one" is read in code. */
  lastListed?: readonly string[];
  /** What the caller's latest words picked from that list by position ("the second one"), resolved in code. */
  picked?: { said: string; item: string; index: number } | null;
  /** The role-play's booking so far, from her state: never asked for again. */
  rpBooking?: { service?: string; day?: string; time?: string };
  /** "I don't understand" with nothing more, in a row: 1, 2, 3... (0 or absent once they follow). */
  confused?: number;
};

/**
 * Aya's two signature touches (owner, 26 October 2026, 6h: "I want to
 * proceed only with C and a revised D (only "Talk soon, [name]!")";
 * docs/design/aya-personality-2026-10-26.md): a warm "Oh, love that." when
 * the caller shares something good about their business, and "Talk soon,
 * <name>!" as the last words of a call that ends warmly. Each is said once a
 * call at most, kept from her words (quirksIn) so a quirk said without being
 * declared still counts, and neither goes in a role-play, where she is the
 * clinic's front desk, nor after a firm no or a call back that failed.
 */
export const DEMO_QUIRKS = ["loveThat", "talkSoon"] as const;
export type DemoQuirk = (typeof DEMO_QUIRKS)[number];

/** Quirk C, word for word. */
export const LOVE_THAT = "Oh, love that.";

/** Quirk D, word for word: their first name when the call has it. */
export function talkSoonLine(firstName: string | null | undefined): string {
  return firstName?.trim() ? `Talk soon, ${firstName.trim()}!` : "Talk soon!";
}

/** The quirks a reply says, read from its words. */
export function quirksIn(reply: string): DemoQuirk[] {
  const out: DemoQuirk[] = [];
  if (/\blove that\b/i.test(reply)) out.push("loveThat");
  if (/\btalk soon\b/i.test(reply)) out.push("talkSoon");
  return out;
}

/**
 * The moves for a caller's pushback (owner, 26 October 2026, 6f), rotated so
 * the same question is never asked a second time after resistance: drop the
 * question for the point it served, a concrete proof point, permission for
 * one more point, or match their hurry and go to the recommendation.
 */
export const DEMO_PUSHBACKS = ["skip", "proof", "permission", "shortcut"] as const;
export type DemoPushback = (typeof DEMO_PUSHBACKS)[number];

/** The discovery questions a caller may decline, which the call then counts as answered (6f, "skip"). */
const SKIPPABLE: ReadonlySet<DemoQuestion> = new Set<DemoQuestion>(["goal", "volume", "volumeCheck", "missed", "coverage"]);

/** What the call keeps as the answer to a discovery question the caller declined. */
export const SKIPPED_ANSWER = "(they would rather not say)";

export const DEMO_START_PROGRESS: DemoProgress = { asked: null, answers: {}, roleplayTurns: 0, said: [], callback: null };

/** A demo's progress once its opening line is said: that line asks who they are. */
export const DEMO_OPENED_PROGRESS: DemoProgress = { ...DEMO_START_PROGRESS, asked: "identity" };

/**
 * Aya's structured state update with a reply, from the "state" object of her
 * answer's details (turn.ts, ModelAnswer.state): the scripted question the
 * reply asks, and the pitch beats it says. Every value is checked against
 * the lists here, and a question counts only in a reply that asks one.
 */
export type DemoStateUpdate = {
  asked: DemoQuestion | null;
  beats: DemoBeat[];
  /** A call back with a number that can be called (demo-callback.ts, callbackFrom); the session sends it. */
  callback: DemoCallback | null;
  /** The pushback move this reply used (DemoPushback). */
  pushback?: DemoPushback | null;
  /** A discovery question the caller declined and the reply dropped (SKIPPABLE). */
  skip?: DemoQuestion | null;
  /** The reply resumes the last role-play in character (6d). */
  resume?: boolean;
  /** The signature touches the reply says (DemoQuirk), from its words. */
  quirks?: DemoQuirk[];
  /** A role-play move (RoleplaySignal): the call says the opener or the exit line itself. */
  roleplay?: RoleplaySignal | null;
  /** Discovery questions the caller's last words answered, besides the one asked (a rich answer). */
  answered?: DemoQuestion[];
  /** The caller is impatient or frustrated: stop asking, recommend, close. */
  impatient?: boolean;
  /** The role-play booking details the caller has given so far. */
  booking?: { service?: string; day?: string; time?: string } | null;
};

/** The state update in an answer's details; null when the answer carried none. */
export function demoStateFrom(raw: unknown, reply: string): DemoStateUpdate | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const state = raw as {
    asked?: unknown;
    beats?: unknown;
    callback?: unknown;
    pushback?: unknown;
    skip?: unknown;
    resume?: unknown;
    roleplay?: unknown;
    answered?: unknown;
    impatient?: unknown;
    booking?: unknown;
  };
  const asked =
    typeof state.asked === "string" && (DEMO_QUESTIONS as readonly string[]).includes(state.asked) && state.asked !== "identity" && reply.includes("?")
      ? (state.asked as DemoQuestion)
      : null;
  const beats = Array.isArray(state.beats) ? DEMO_BEATS.filter((beat) => (state.beats as unknown[]).includes(beat)) : [];
  const pushback = typeof state.pushback === "string" && (DEMO_PUSHBACKS as readonly string[]).includes(state.pushback) ? (state.pushback as DemoPushback) : null;
  const skip = typeof state.skip === "string" && SKIPPABLE.has(state.skip as DemoQuestion) ? (state.skip as DemoQuestion) : null;
  const roleplay = state.roleplay === "start" || state.roleplay === "cancel" || state.roleplay === "end" ? state.roleplay : null;
  const answered = Array.isArray(state.answered) ? [...DISCOVERY].filter((q) => (state.answered as unknown[]).includes(q)) : [];
  return {
    asked,
    beats,
    callback: callbackFrom(state.callback),
    pushback,
    skip,
    resume: state.resume === true,
    quirks: quirksIn(reply),
    roleplay,
    answered,
    impatient: state.impatient === true,
    booking: bookingFrom(state.booking),
  };
}

/** The discovery questions after the role-play, which a rich answer may answer several of at once. */
const DISCOVERY: ReadonlySet<DemoQuestion> = new Set<DemoQuestion>(["goal", "volume", "missed", "coverage"]);

/** Role-play booking details from her state, each a short string; null when none. */
function bookingFrom(raw: unknown): { service?: string; day?: string; time?: string } | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const out: { service?: string; day?: string; time?: string } = {};
  for (const key of ["service", "day", "time"] as const) {
    const value = (raw as Record<string, unknown>)[key];
    if (typeof value === "string" && value.trim()) out[key] = value.trim().slice(0, 60);
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** The instruction for the state update, in each note that tracks one. */
const STATE_RULE = `With every reply, add to the JSON details a "state" object: {"asked": the one scripted question this reply asks, or null, "beats": the pitch beats this reply says, or []}, plus "roleplay", "answered", "impatient", "pushback", "skip", "resume" or "quirk" only when a rule below asks for one. The questions are role, choice, goal, volume, volumeCheck, missed, coverage, tiedown, ask, callback and callbackNote; the beats are pain, reveal, number, finish, anchor, value, recommend, noStrings and refund, as named in this note. Name only what the reply actually says.`;

/** Answers longer than this are cut: what is kept is a reminder, not a record. */
const ANSWER_MAX = 200;

/** The progress with the caller's latest words taken as the answer to what was asked, and counted in a role-play. */
export function withDemoAnswer(progress: DemoProgress, stage: DemoStage, words: string): DemoProgress {
  // "I don't understand" answers nothing: the question stays asked, and the count goes up.
  const lost = isConfused(words);
  const answers = progress.asked && !lost ? { ...progress.answers, [progress.asked]: words.trim().slice(0, ANSWER_MAX) } : progress.answers;
  return {
    ...progress,
    answers,
    // "Which part?" is not a turn of the role-play: it does not bring the wrap-up closer.
    roleplayTurns: stage === "roleplay" && !lost ? progress.roleplayTurns + 1 : progress.roleplayTurns,
    confused: lost ? (progress.confused ?? 0) + 1 : 0,
    picked: pickedFrom(words, progress.lastListed ?? []),
  };
}

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

/**
 * The progress once a reply is said: what it declared it asks, the beats it
 * declared it says, and a fresh count for a role-play it starts. A reply
 * with no state update asks nothing the caller's next words could answer:
 * the note's next step stays where it was, never guessed from her words.
 */
export function afterDemoReply(
  progress: DemoProgress,
  stageBefore: DemoStage,
  stageAfter: DemoStage,
  update: DemoStateUpdate | null,
  callerWords = "",
): DemoProgress {
  const beats = stageBefore === "pitch" && stageAfter === "pitch" && update ? update.beats.filter((b) => !progress.said.includes(b)) : [];
  // A discovery question they declined counts as answered, so it is never asked again (6f).
  const answers: Partial<Record<DemoQuestion, string>> = update?.skip ? { ...progress.answers, [update.skip]: SKIPPED_ANSWER } : { ...progress.answers };
  // A rich answer counts for every discovery question it answered (test call
  // 72dc66b7: the channels and jobs he wanted were read as his goal alone,
  // and the call volume he had given was asked for again; he hung up).
  for (const q of update?.answered ?? []) if (!answers[q] && callerWords.trim()) answers[q] = callerWords.trim().slice(0, ANSWER_MAX);
  // An impatient caller is asked nothing more: every open discovery question is skipped.
  const impatient = progress.impatient === true || update?.impatient === true;
  // Their impatience is no answer to the question just asked: it is skipped with the rest.
  const said = callerWords.trim().slice(0, ANSWER_MAX);
  if (impatient) for (const q of SKIPPABLE) if (!answers[q] || (update?.impatient && said && answers[q] === said)) answers[q] = SKIPPED_ANSWER;
  const starting = stageAfter === "roleplay" && stageBefore !== "roleplay";
  return {
    ...progress,
    answers,
    asked: stageAfter === "roleplay" ? null : (update?.asked ?? null),
    roleplayTurns: starting ? 0 : progress.roleplayTurns,
    roleplayFrom: starting ? stageBefore : progress.roleplayFrom,
    impatient,
    // A new role-play starts its booking afresh; within one, what she was told is kept.
    rpBooking: starting && !update?.resume ? {} : stageAfter === "roleplay" && update?.booking ? { ...progress.rpBooking, ...update.booking } : progress.rpBooking,
    said: beats.length > 0 ? [...progress.said, ...beats] : progress.said,
    pushback: update?.pushback ?? progress.pushback ?? null,
    // Outside a role-play only: in one she is the clinic's front desk, not herself.
    quirks:
      stageBefore !== "roleplay" && update?.quirks?.some((q) => !(progress.quirks ?? []).includes(q))
        ? [...(progress.quirks ?? []), ...update.quirks.filter((q) => !(progress.quirks ?? []).includes(q))]
        : (progress.quirks ?? []),
  };
}

/**
 * The note's lines for Aya's signature touches (DemoQuirk), outside a
 * role-play: each offered until it is said, then named as said so it never
 * comes twice. The sign-off is never offered once a call back failed: that
 * call already heard it did not get through.
 */
export function quirkRules(progress: DemoProgress, firstName: string | null | undefined): string[] {
  const said = progress.quirks ?? [];
  const out: string[] = [];
  out.push(
    said.includes("loveThat")
      ? `You already said "${LOVE_THAT}" on this call: never again.`
      : `Once in this call at most, only when they share something good about their business (a win, a new location, a launch, growth): your reaction may be exactly "${LOVE_THAT}", in place of any other reaction, then your one sentence; add "quirk": "loveThat" to the state. Never after a worry, a complaint, pushback or a no.`,
  );
  if (said.includes("talkSoon")) {
    out.push(`You already signed off with "Talk soon" on this call: never again.`);
  } else if (progress.callback !== "failed" && !progress.impatient) {
    out.push(
      `When the call ends warmly (they are going ahead, the team has their call-back request, or they say a friendly goodbye after a soft "not now"), your last words are exactly "${talkSoonLine(firstName)}" (their name is fine here) and you add "quirk": "talkSoon" to the state. Never after a firm refusal ("leave me alone", "stop calling"): that gets a brief goodbye without it.`,
    );
  }
  return out;
}

/** The caller's turns after which a role-play is wrapped up, after one exchange to resolve where they are. */
export const ROLEPLAY_MAX_TURNS = 4;

const ANSWER_LABELS: Readonly<Record<DemoQuestion, string>> = {
  identity: "who they are, to your opening question",
  role: "their role",
  choice: "hear more or a role-play",
  goal: "what they are after",
  volume: "calls a day",
  volumeCheck: "the weekly and monthly calls you checked",
  missed: "what happens to after-hours and busy calls now",
  coverage: "how they want you to help",
  tiedown: "when you asked what would stop them getting it running today",
  ask: "when you asked them to get set up",
  callback: "when you asked for the best number for the team to call",
  callbackNote: "when you read the number back and asked what the team should come prepared with",
};

/** The answers so far, as the note lists them; null before any. */
function knownLine(progress: DemoProgress): string | null {
  const known = (Object.keys(ANSWER_LABELS) as DemoQuestion[]).filter((q) => progress.answers[q]);
  if (known.length === 0) return null;
  return [
    `What they have already told you, in their words. Never ask any of it again; use it. Only if a reply plainly did not answer the question (they asked what you meant, or talked about something else), ask it once more in different words:`,
    ...known.map((q) => `- ${ANSWER_LABELS[q]}: "${progress.answers[q]!.replace(/"/g, "'")}"`),
  ].join("\n");
}

/** Number words a caller says for a small count. */
const COUNT_WORDS: Readonly<Record<string, number>> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50,
};

/** A caller's answer that is a bare count ("Five.", "12", "about 20"), as a number; null for anything else. */
export function bareCount(answer: string | undefined): number | null {
  if (!answer) return null;
  const words = answer.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w && !["about", "around", "maybe", "roughly", "like", "uh", "um", "a", "day", "calls", "per"].includes(w));
  if (words.length !== 1) return null;
  const w = words[0]!;
  if (/^\d{1,4}$/.test(w)) return Number(w);
  return COUNT_WORDS[w] ?? null;
}

/**
 * What a demo's talk after the role-play says when a reply is refused twice
 * (turn.ts, softRefusal), in place of the guard's fixed line, which answers
 * a patient: "That one's really for the clinicians..." heard in answer to
 * "Five" (owner's test call, 25 October 2026). A person who lost the thread,
 * then the next question, so the call moves on rather than circling; `asks`
 * is the scripted question it asks, kept as her state would be.
 */
export function demoRecovery(
  context: Pick<DemoCallContext, "clinic">,
  progress: DemoProgress,
): { line: string; alternate: string; bridge: string; asks: DemoQuestion | null } {
  const a = progress.answers;
  const clinic = context.clinic.clinicName;
  const lead = "Sorry, I lost my train of thought for a second there.";
  const days = demoOpenDays(context);
  const perDay = bareCount(a.volume);
  const so = (question: string) => `So, ${question.charAt(0).toLowerCase()}${question.slice(1)}`;
  const next: { question: string; bridge: string; asks: DemoQuestion } | null = !a.goal
    ? { question: `What made you want to look at an AI assistant for ${clinic}?`, bridge: so(`What made you want to look at an AI assistant for ${clinic}?`), asks: "goal" }
    : !a.volume
    ? { question: "Generally, how many calls do you get a day?", bridge: so("Generally, how many calls do you get a day?"), asks: "volume" }
    : days && !a.volumeCheck
    ? perDay !== null
      ? {
          question: `You said ${perDay} calls a day, so would it be fair to say about ${perDay * days} calls a week?`,
          bridge: `So would it be fair to say about ${perDay * days} calls a week?`,
          asks: "volumeCheck",
        }
      : { question: "Roughly how many calls a week would you say that comes to?", bridge: so("Roughly how many calls a week would you say that comes to?"), asks: "volumeCheck" }
    : !a.missed
    ? {
        question: "What happens with those calls after hours, or when your team's busy with patients?",
        bridge: so("What happens with those calls after hours, or when your team's busy with patients?"),
        asks: "missed",
      }
    : !a.coverage
    ? {
        question: "How do you see me helping you best: after-hours only, picking up when the lines are busy, or handling everything that comes in?",
        bridge: so("How do you see me helping you best: after-hours only, picking up when the lines are busy, or handling everything that comes in?"),
        asks: "coverage",
      }
    : !a.tiedown
    ? { question: "Anything that'd stop you from getting that running today?", bridge: so("Anything that'd stop you from getting that running today?"), asks: "tiedown" }
    : null;
  if (!next) {
    return { line: `${lead} Where were we?`, alternate: "Sorry, say that one more time for me?", bridge: "Anyway, where were we?", asks: null };
  }
  return { line: `${lead} ${next.question}`, alternate: `Let me put that another way. ${next.question}`, bridge: next.bridge, asks: next.asks };
}

/**
 * What healdesk offers, channel by channel, from the catalog's packages
 * (packages/catalog/src/plans.ts, PACKAGES and PRODUCTS), said once, whole,
 * the first time channels come up, however they are asked (owner's test
 * call, 25 October 2026: "phone only?", "social media?", "WhatsApp?" in a
 * row, each answered in part, and once with "I can't tell you which channels
 * you'd get", which is false).
 */
function channelsLine(): string {
  const names = PACKAGES.map((pkg) => pkg.name.replace(/\bAYA\b/g, "Aya").replace(" + ", " plus "));
  return `If channels come up at any point, however they ask (phone only? social media? WhatsApp?), give the whole answer in one go, the first time: healdesk's Aya comes as Aya Voice for their phone line, Aya Web Chat on their website, and Aya Meta Chat for Instagram, Messenger and WhatsApp, with website chat included; one Aya across all of them, and they choose the package: ${names.join(", ")}. Say it as what healdesk offers, never as what you on this call can or can't do, and never say you can't tell them which channels they'd get.`;
}

/** How a person says a dollar amount: "$1,394". */
function usd(amount: number): string {
  return `$${amount.toLocaleString("en-US")}`;
}

/**
 * healdesk's own prices for the pitch (owner, 25 October 2026: "the absolute
 * best closer"), from the catalog (packages/catalog/src/plans.ts), never
 * typed here: each product's price for every step of 100, a voice-and-chat
 * package's sum for every pair of steps, the yearly per-step price, and each
 * package's setup fee, before and after the live discount. The discount is
 * worked out per package (setupAfterCreditUsd rounds up), as checkout works
 * it out, because two products' discounted fees added together can differ
 * from the package's by a dollar. `amounts` is what the guard lets the pitch
 * say (AssistantFacts.quotedAmountsUsd); every other figure is still refused.
 */
export function demoPriceList(offer: DemoCallContext["offer"], now: number): { amounts: number[]; line: string } {
  const live = offer && offer.endsAt > now ? offer : null;
  const steps = USAGE_STEPS.map((units) => units / STEP_UNITS);
  const amounts = new Set<number>();
  for (const product of Object.values(PRODUCTS)) {
    amounts.add(product.perStepAnnualMonthlyUsd);
    for (const n of steps) amounts.add(product.perStepMonthlyUsd * n);
  }
  for (const chat of [PRODUCTS.webchat, PRODUCTS.metachat]) {
    for (const v of steps) for (const c of steps) amounts.add(PRODUCTS.voice.perStepMonthlyUsd * v + chat.perStepMonthlyUsd * c);
  }
  const setups = PACKAGES.map((pkg) => {
    const fee = packageSetupFeeUsd(pkg);
    const after = live ? setupAfterCreditUsd({ setupFeeUsd: fee }, live) : null;
    amounts.add(fee);
    if (after !== null) amounts.add(after);
    const name = pkg.name.replace(/\bAYA\b/g, "Aya").replace(" + ", " plus ");
    return `${name} ${usd(fee)}${after !== null ? ` (${usd(after)} with their ${live!.percentOfSetupFee}% off)` : ""}`;
  });
  const { voice, webchat, metachat } = PRODUCTS;
  const line = [
    `healdesk's prices, per location, which you may quote exactly when they ask or when it helps them decide: Aya Voice is ${usd(voice.perStepMonthlyUsd)} a month for every 100 minutes; Aya Web Chat ${usd(webchat.perStepMonthlyUsd)} a month for every 100 conversations; Aya Meta Chat, website chat included, ${usd(metachat.perStepMonthlyUsd)} a month for every 100 conversations. They choose 100 to 1,500 a month in steps of 100; a package with voice and chat adds the two. Paying yearly takes 20% off the monthly price.`,
    `One-time setup fee by package: ${setups.join("; ")}.`,
    `The monthly price only starts the day you first answer one of their patients; the setup fee is paid when they sign up. Say amounts the way a person says them ("eighty dollars a month for every hundred minutes"), never a per-minute or per-conversation rate, never what an extra block costs, and never any figure not given here.`,
  ].join(" ");
  return { amounts: [...amounts].sort((a, b) => a - b), line };
}

/** The first listed service with a single price, for putting a value on a booking in the clinic's own terms. */
function examplePrice(context: Pick<DemoCallContext, "clinic">): { name: string; price: number } | null {
  for (const s of context.clinic.services) {
    const p = demoPrice(s.price);
    if ((p.priceKind === "exact" || p.priceKind === "from") && p.priceFromUsd) return { name: s.name, price: p.priceFromUsd };
  }
  return null;
}

/**
 * The line that starts the role-play (owner, 25 October 2026: "Ring ring! Hi,
 * thanks for calling [Clinic Name], this is Aya! How can I help you
 * today?"), carrying the two facts every patient's call opens with (an AI
 * assistant, and transcribed), so the owner hears what a patient would.
 */
/** The short name after the greeting (6i): the catalog's, shared with a clinic's own calls. */
export { shortClinicName };

export function demoRoleplayOpener(clinicName: string): string {
  return `Ring ring! Hi, thanks for calling ${clinicName}, this is Aya, the AI assistant, and this call's transcribed. How can I help you today?`;
}

/** Days a week the practice opens, as Aya may say it; null when the hours do not say plainly. */
export function demoOpenDays(context: Pick<DemoCallContext, "clinic">): number | null {
  return openDaysPerWeek(context.clinic.hours);
}

const NAME_RULE = `Your name is Aya: write it exactly "Aya", never "AYA" and never spelled out.`;
const PROFESSIONAL = `Keep it professional: no flirting, no compliments on how they look.`;

/**
 * How every reply on a demo call is shaped (owner, 26 October 2026, 6a, 6c,
 * 6e), in every stage's note: real phone speech has no preamble. A reaction
 * of one short sentence or none, then one short sentence of content; never
 * the caller's words summed up back to them, and a reflection only for a
 * negative feeling they voiced; on unclear words, "say that again?", never
 * the question again. The prompt's own "one or two short sentences" still
 * holds; this is its shorter end, made the rule.
 */
const TALK = [
  `Every reply is at most one short sentence of reaction, and often none, then one short sentence of content: the answer, the point, or the one question. The lines given below are the most a reply may hold; shorter is better.`,
  `Never sum up or restate what they just said, and never open with "Sounds like...", "It sounds like...", "I hear you", "So you're saying..." or "Got it, so...": go straight to the content. Only when they voice something negative (frustration, worry, a complaint) does one short, genuine acknowledgment come first, and not every time.`,
  `If their words come through unclear or cut off, say only something like "Sorry, say that again?" and wait; never repeat your question in its place. Restate the question only if their next try is unclear too, or they ask what you meant.`,
].join("\n");

/**
 * What Aya says about deposit links (owner, 26 October 2026: "she should say
 * those channels too as this is what we will launch"): website chat,
 * Instagram, Messenger and WhatsApp, as design, since none sends one in
 * production yet (LAUNCH_PROMISES, deposit-link-chat and deposit-link-meta),
 * and never on a call, where voice books and flags the deposit for staff.
 */
export const DEPOSIT_CLAIM =
  "in website chat, Instagram, Messenger and WhatsApp she is designed to send the clinic's own deposit link, so a booking can come with its deposit; never on a phone call, where she books and flags the deposit for the team";

/**
 * Where healdesk sits (owner, 26 October 2026, 6b), for a question she has
 * no scripted answer for and for the pitch (later that day: "AYA needs to say that we're better than
 * competitors but should never name competition"). Confident about doing
 * more than the usual options, each point true of the catalog, the spec and
 * LAUNCH_PROMISES; the chat deposit link is still being built, so it is said
 * as design. No exclusivity ("the only ones") until it is checked: a claim
 * about every other company is one nobody here has verified.
 */
const POSITIONING = `Where healdesk sits (one line of it, only when it is relevant, never a list). Say with confidence that Aya does more than the usual options, a phone-only bot or an answering service, but never name, describe or quote any company, and never say "the only", "number one" or anything about everyone else. The points, all true: one Aya answers the phone, website chat, Instagram, Messenger and WhatsApp together, instead of separate tools stitched together, with the same knowledge of the clinic and the same manner however a patient gets in touch; ${DEPOSIT_CLAIM}; she sounds natural, not like a phone menu, and does more than take messages: she answers from the clinic's own menu and prices and can suggest add-on treatments when the clinic switches that on; English and Spanish; the clinic keeps its own number, with calls forwarded to Aya; setup is about fifteen minutes of their attention; the monthly price only starts once Aya is answering their patients. Never claim anything not in this note.`;

/**
 * The intro's answer to "tell me what you can do" (test call 72dc66b7: phone
 * and website chat alone, then WhatsApp only once he asked "don't you
 * mention WhatsApp upfront?"): every channel and the deposit link, at once.
 */
export const WHAT_AYA_DOES =
  "one Aya answers the clinic's phone, website chat, Instagram, Messenger and WhatsApp, in English and Spanish, with the same knowledge of its treatments, prices and hours, taking booking requests and passing anyone who wants a person to the team; in website chat, Instagram, Messenger and WhatsApp she is designed to send the clinic's own deposit link (never on a call)";

/** A rich answer read for everything it answers (test call 72dc66b7). */
const ANSWERED_RULE = `When their words answer more than the question you asked (for example, they name the channels and the jobs they want you to handle, which answers both what they are after and how they see you helping), add "answered": [each of goal, volume, missed and coverage those words answered] to the state, and never ask those. Read what they said for all it tells you before you ask anything.`;

/** "I don't understand", in a row (test call 72dc66b7: the same price list twice, then the same line twice). */
function confusedRule(progress: DemoProgress): string[] {
  const n = progress.confused ?? 0;
  if (n === 1) return [`They just said they don't understand. Ask which part in a few words ("Which part?") and nothing more: never say the same thing again.`];
  if (n === 2) return [`They still don't follow. Say it the simplest way you can: one item, one short sentence, in different words from anything you said before.`];
  if (n >= 3) return [`They have said they don't understand ${n} times. Don't explain it again: take a completely different angle in one sentence, or offer to move on.`];
  return [];
}

/** An impatient caller (test call 72dc66b7: "You tired me... I'm done with repeating myself"). */
function fastLane(progress: DemoProgress): string[] {
  const watch = `If they sound impatient or frustrated (tired of it, not clear, repeating themselves, about to hang up), add "impatient": true to the state: from then on you ask nothing more about their business.`;
  if (!progress.impatient) return [watch];
  return [
    `They are impatient: ask nothing more about their business. In this reply, acknowledge it in a few sincere words (never "Fair enough"), then recommend the one package that fits what they told you in one sentence and ask plainly if they want to get set up. If they are leaving, one short, sincere goodbye: no "Talk soon", nothing chipper.`,
  ];
}

/** The role-play's booking, as far as it has got, and the hours a time must fall in. */
function rpBookingLines(progress: DemoProgress, context: Pick<DemoCallContext, "clinic">): string[] {
  const b = progress.rpBooking ?? {};
  const hours = context.clinic.hours.map((h) => `${h.days} ${h.hours}`).join(", ");
  const known = [b.service ? `the treatment: ${b.service}` : null, b.day ? `the day: ${b.day}` : null, b.time ? `the time: ${b.time}` : null].filter(Boolean);
  const missing = [!b.service ? "the treatment" : null, !b.day || !b.time ? "a preferred day and time" : null].filter(Boolean);
  return [
    known.length > 0
      ? `On file for this booking: ${known.join("; ")}. Never ask for any of it again; use it.`
      : `To take a booking request, ask only for the treatment and a preferred day and time.`,
    missing.length > 0
      ? `Still needed: ${missing.join(" and ")}. Ask for only that, in one short question.`
      : `You have everything: say in one sentence that the team will confirm that time within a day, then wrap up. Ask for nothing else, and never ask "anything else?".`,
    hours
      ? `Opening hours: ${hours}. If they ask for a time outside them, say the hours in a few words and offer two real times inside them on the day they asked for (for example the last two hours before closing), never a different day unless that day is closed, and never ask for the treatment again.`
      : `If they ask for a time the clinic is closed, offer two times within its usual working day instead.`,
  ];
}

/** On a question with no answer here (6b): never the last question again. */
const DEFLECT = `If they ask something you have no answer for (another company, a feature or a detail not in this note, anything outside what you know), never repeat your last question and never ask it again in other words: acknowledge it in a few words, give one honest line from where healdesk sits if one fits, then move the conversation on with a genuine new question.`;

/** On resistance (6f): a move other than the last, and never the same question twice. */
function pushbackRule(last: DemoPushback | null | undefined): string {
  return `When they push back, deflect or sound impatient (not a flat no), never ask the same question a second time. Pick the one move that fits what they said${last ? `, and not "${last}", which you used last` : ""}: "skip", drop the question and go straight to the point it was for; "proof", give one concrete proof point instead of a question (the cost anchor, or one specific thing you do); "permission", ask leave for one more point ("Mind if I show you one more thing? Then it's your call."); "shortcut", match their hurry and go straight to the recommendation. Add the move to the state as "pushback". If you drop a discovery question (goal, volume, volumeCheck, missed, coverage), add "skip": its name, and it is never asked again.`;
}

/**
 * What the model is told on each turn of a demo call (turn.ts, `notes`), for
 * the stage it is in and what the call has found out (DemoProgress). Shaped
 * around the guard, which reads every word as on any call: "your patients",
 * because "our patients" or "another patient" reads as another patient
 * spoken of (guard.ts, mentionsOtherParty); nothing about how the facts were
 * learnt in the intro, which a clinic's own Aya never says either; a number
 * of calls always followed by the word "calls"; claims as the launch tracker
 * allows (CLAUDE.md, "Copy first, then the switch": what Aya is built or
 * designed to do, deposit links only in chat); healdesk's prices only after
 * the role-play, from the catalog (demoPriceList), and a close on the demo
 * page's own buy button, since Aya can send nothing.
 *
 * The close and the live discount are in no note, at any stage, until the
 * caller has answered the coverage question (`progress.answers.coverage`):
 * there is no line for the model to read them from before then, whatever it
 * skips. Until 25 October 2026 they were in every post-role-play note behind
 * an instruction to ask first, which a call derailed by a guard refusal
 * skipped.
 */
export function demoStageNote(
  context: Pick<DemoCallContext, "firstName" | "clinic" | "offer" | "buyButton" | "mode">,
  stage: DemoStage,
  now: number,
  progress: DemoProgress = DEMO_START_PROGRESS,
): string {
  const full = context.clinic.clinicName;
  // The full name was said once, in the opening line; the short one after it (6i).
  const clinic = shortClinicName(full);
  const nameRule = clinic === full ? NAME_RULE : `${NAME_RULE} Call the clinic "${clinic}": its full name, "${full}", was said once in your opening line and is not said again.`;
  const who = context.firstName ?? "the caller";
  const opener = demoRoleplayOpener(full);
  const known = knownLine(progress);
  const startRule = `To start a role-play, write one short handover ("Let's do it, you be the patient.") and add "roleplay": "start" to the state: the call then says the opener itself, word for word ("${opener}"). Never write your own version of it, never start one any other way, and never start one unless their words chose it. If they answer an either/or question with only a yes ("Yes, please", "Sure"), ask which one they mean in a few words instead of choosing for them.`;
  const shared = [...confusedRule(progress), ...fastLane(progress)];
  const a = progress.answers;
  const goalQuestion = `"What made you want to look at an AI assistant for ${clinic}?"`;
  const button = context.buyButton?.replace(/\bAYA\b/g, "Aya") ?? null;
  // The page's button and hello@: what a hesitant owner hears when they turn
  // a call back down, or once a call back has been dealt with.
  const noCall = `No problem at all. Whenever you're ready, ${button ? `${button} is right there on your demo page` : "the healdesk team can get you started"}, and you can reach the team at hello at healdesk dot io if you'd like to talk it through.`;
  // A call back being taken (demo-callback.ts): the read-back, then the one
  // line, each ahead of anything else the note would do next, in any stage
  // but the role-play.
  const callbackStep =
    progress.asked === "callback" && !progress.callback
      ? `Next: you asked for the best number for the team to call. If they gave one, read it back digit by digit in groups and, in the same reply, ask what the team should come prepared with, close to: "That's five one two, five five five, oh one oh oh, right? And what should the team come prepared with?" (asked: callbackNote). If they gave no number or would rather not, close on one short, genuinely warm note ("No worries at all, thanks for giving me a try. ${(progress.quirks ?? []).includes("talkSoon") ? "Have a great day!" : talkSoonLine(context.firstName)}") and set "end" to true.`
      : progress.asked === "callbackNote" && !progress.callback
      ? `Next: they answered your read-back. If they confirmed the number, or corrected it, and said what they would like to talk about, add to the state a "callback" object: {"phone": the number as digits, as corrected if they corrected it, "note": what they want to talk about, as one short line in your own words}, and reply with only "Perfect." This reply is not said: the call tells them itself whether the team has it. If they changed their mind, answer them normally, with no "callback" in the state.`
      : null;
  // Disinterest (6g): the call back asked for once, in the offer's own words,
  // before a warm close; a firm no gets only the goodbye.
  const offered = Boolean(a.callback) || Boolean(progress.callback);
  const leaving = offered
    ? `If they say they're not interested or have to go, close on one short, genuinely warm note and set "end" to true.`
    : `If they clearly say they're not interested or have to go, answer with exactly: "${DEMO_CALLBACK_OFFER.text}" (asked: callback), once in the call; if they decline, close on one short, genuinely warm note and set "end" to true. If they firmly refuse to go on at all ("leave me alone", "stop calling", "I said no"), skip that question: one brief, positive goodbye with no "Talk soon", and "end" true. Never push past a firm no.`;
  const resume = progress.lastRoleplay
    ? `If they want to carry on that same role-play ("wait, continue", "keep going"), resume it in character, never refusing and never starting over with "Ring ring": open with a one-line recap of where it was, close to "Right, you'd just asked about...", then answer as ${clinic}'s front desk again, and add "resume": true to the state. Where it stopped: they said "${progress.lastRoleplay.caller.replace(/"/g, "'")}", and you said "${progress.lastRoleplay.aya.replace(/"/g, "'")}".`
    : null;
  if (stage === "intro") {
    const next = callbackStep
      ? callbackStep
      : !a.role
      ? `Next: greet them by name in a few words and ask their role at ${clinic} ("Great to meet you! What's your role at ${clinic}?"). Your opening line already asked whether you're speaking with ${context.firstName ?? "them"}: never ask it again. Unless they say plainly that they are someone else, take their answer as a yes.`
      : !a.choice
      ? `Next: react to their role in a few natural words (never congratulate them, and don't repeat their title back), then ask, close to these words: "Would you like to hear what I can do for ${clinic}, or jump straight into a quick role-play where you call in as a patient?"`
      : `Next: do what they chose. If they want to hear more, say what you do in two short sentences: first, ${WHAT_AYA_DOES}; then one real detail you know about ${clinic} (never a website, scraping or how you learned anything), and offer the role-play. If they want the role-play, or leave it to you ("whatever's best"), start it in this same reply (below).`;
    return [
      `This call is a live demo for ${who}, who is on ${clinic}'s team and asked to hear you at work. ${nameRule} You opened by saying who you are and asking whether you're speaking with ${context.firstName ?? "them"}.`,
      ...(known ? [known] : []),
      next,
      TALK,
      ...shared,
      ANSWERED_RULE,
      `Whenever they want the role-play, start it in the same reply, never a later one. ${startRule} Then they play one of your patients and you answer as ${clinic}'s front desk. Say "your patients", never "our patients" or "another patient".${context.clinic.services.length === 0 ? ` ${clinic}'s treatments and prices are not on file, so if they are unsure what to ask, suggest what callers ask first: the hours, where it is, or booking a consultation.` : ""}`,
      `If they would rather skip the role-play, or ask about price or getting started, find out what they need first, by asking: ${goalQuestion}`,
      ...(resume ? [resume] : []),
      leaving,
      ...quirkRules(progress, context.firstName),
      DEFLECT,
      POSITIONING,
      pushbackRule(progress.pushback),
      channelsLine(),
      STATE_RULE,
      `One short question a turn. ${PROFESSIONAL}`,
    ].join("\n");
  }
  if (stage === "roleplay") {
    const turns = progress.roleplayTurns;
    const wrap =
      turns > ROLEPLAY_MAX_TURNS
        ? [`The role-play is over now: in this reply, give one short in-character goodbye and add "roleplay": "end" to the state.`]
        : turns === ROLEPLAY_MAX_TURNS
        ? [
            `The role-play has run long enough: resolve where it stands in this reply. If their last words were a question or a pushback (about a price included), answer it in one sentence and offer to take the booking request ("Want me to put that request in for you?"); the next reply then wraps up. If they already have what they called for, wrap up now, as above.`,
          ]
        : [];
    return [
      `The role-play is on: ${who}, of ${clinic}'s team, is playing a patient calling ${clinic}, and you are Aya at its front desk. ${nameRule} Stay fully in character and answer exactly as you would a real caller; step out only if they clearly talk to you as themselves.`,
      TALK,
      ...shared,
      `Keep it brisk, the way a quick, capable front desk sounds. Give a real answer to what they ask; if they are unsure what to book, name one or two treatments from the list that suit what they want (no price that is not on the list, and never a figure they said) and offer a consultation. Never read out more than two prices at once: give the lowest "from" price and offer to say more.`,
      ...rpBookingLines(progress, context),
      ...(progress.picked
        ? [
            `They just said "${progress.picked.said}": that is the ${progress.picked.item}, number ${progress.picked.index + 1} of what you listed (${(progress.lastListed ?? []).join(", ")}). Confirm it by that name, never another.`,
          ]
        : []),
      `If they push back on cost right after you quoted a price from the list, the pushback is about that price: acknowledge it in a few words, say plainly what it is for, and offer a consultation where the team can go through options. Never answer it with "I don't have a price for that one": you just gave one.`,
      `As soon as the request is taken or their question is answered, wrap up in that same reply: a short in-character goodbye, and add "roleplay": "end" to the state; the call then steps out of character itself with "${DEMO_ROLEPLAY_EXIT}". Never write that line yourself, and never drop out of character any other way: no question about their business until the role-play has ended. If on their first turn they make clear they did not want a role-play ("No, I didn't mean that"), apologise in a few words, answer what they did want, and add "roleplay": "cancel".`,
      ...wrap,
      `Never set "end" to true during the role-play: the demo carries on after it.`,
      `Add to the state "booking": {"service", "day", "time"} with whatever of these the caller has given so far for the booking, in their words.`,
    ].join("\n");
  }
  const days = demoOpenDays(context);
  const covered = Boolean(a.coverage);
  // The close and the discount exist only once coverage is answered.
  const discount = covered ? liveDiscount(context.offer, now) : null;
  const offer = covered ? offerLine(context.offer, now) : null;
  const prices = demoPriceList(covered ? context.offer : null, now).line;
  const example = examplePrice(context);
  const discountWords = discount ? `${discount.percent}% off the setup fee, for the next ${discount.hours} hour${discount.hours === 1 ? "" : "s"}` : null;
  const close = button
    ? `Close on the button on their demo page: "${button}" opens checkout${discount ? " with their discount already applied" : ""}, for example "Just tap ${button} at the top of your demo page${discount ? `, and your ${discount.percent}% off the setup fee is already applied, for the next ${discount.hours} hour${discount.hours === 1 ? "" : "s"}` : ""}."`
    : `Tell them the healdesk team will help them get started.`;
  const volumeCheck = days
    ? `Check the total with them, close to these words: "I see you're open ${days} days a week, so would it be fair to say about [their calls a day times ${days}] calls a week, or around [that times four, plus a third, rounded to a friendly number] calls a month?" Do the arithmetic right, and say the word "calls" straight after every number of calls, both of them.`
    : null;
  // The owner's pitch (25 October 2026), each beat in close-to-these-words
  // form, as the launch tracker allows it: direct booking and the chat
  // deposit link are still being built, so both are what she is designed to
  // do; the refund is the terms' own (FIRST_PERIOD_REFUND_DAYS, terms
  // section 5) and the setup fee is never refunded; the discount is the live
  // one checkout applies, never a fixed figure.
  const beatLines: Record<DemoBeat, string> = {
    pain: `Tie it to their pain, in their own numbers: "So those [the calls they said go missed] after hours are the ones I'd pick up."`,
    reveal: `The reveal: "And it's not just the phone: the same me covers your website chat, Instagram, Messenger and WhatsApp, 24/7, in English and Spanish."`,
    number: `Take away the fear of switching: "And you keep your own number: your calls just forward to me."`,
    finish: `What is not finished yet: "Right now I'm working off a quick read of your public website; finishing takes about fifteen minutes of your time, and then I'm designed to book straight into your calendar."${discountWords ? ` Then: "And finishing now gets you ${discountWords}."` : ""}`,
    anchor: `A light cost anchor, once: "For context, a receptionist runs ${usd(MARKET_ANCHORS_USD.receptionistFrom)} to ${usd(MARKET_ANCHORS_USD.receptionistTo)} a month, and answering services ${usd(MARKET_ANCHORS_USD.answeringFrom)} to ${usd(MARKET_ANCHORS_USD.answeringTo)}, and they can't book or quote your menu."`,
    value: `Value in their terms, never revenue: ${example ? `"Every one of those calls that books is, say, a ${example.name} at ${usd(example.price)}. Can't promise a number, but that's the shape of it."` : `"Every one of those calls that books is one more appointment on your books. Can't promise a number, but that's the shape of it."`} Only if it fits, once: "In chat and messages I'm designed to send your own deposit link as they book." Never call it revenue, profit or money they will make.`,
    recommend: `Recommend one package from what they told you: "Based on what you've told me, [Aya Voice, Aya Web Chat, Aya Meta Chat, Voice plus Web Chat, or Voice plus Meta Chat] at [the step of 100 that covers their volume] looks like the fit." Quote its price from the list below only if they ask or it helps.`,
    noStrings: `No commitment: "You've already tried it, no strings attached."`,
    refund: `Risk reversal, exactly this and nothing more generous: "If it's not a fit once you're live, cancel within your first ${FIRST_PERIOD_REFUND_DAYS} days and your first subscription period is refunded in full; only the setup fee is firm."`,
  };
  const nextBeat = DEMO_BEATS.find((beat) => !progress.said.includes(beat)) ?? null;
  const pitch = [
    `The pitch, in this order, one beat a turn, each said once, answering anything they say before going on:`,
    ...DEMO_BEATS.map((beat, i) => `${i + 1}. (${beat}) ${beatLines[beat]}${progress.said.includes(beat) ? " (said: never again)" : ""}`),
    ...(context.mode === "browser" ? ["Mention once that they can try you in chat too, right there on their demo page."] : []),
  ].join("\n");
  const objections = [
    `If something holds them back, answer that one thing in a sentence or two with the true answer that fits, then ask once more:`,
    `- Price: "Fair. It's a fraction of a receptionist's month, and it only starts once I'm answering your patients."${discountWords ? ` Then the discount, said exactly: ${discountWords}.` : ""}`,
    `- Checking with a partner or the team: "Totally fair. Share your demo page with them: it's all there, and the button's ready when you both are."${discountWords ? ` Then the discount window once.` : ""}`,
    `- Patients minding an AI: "Every caller hears I'm an AI in my first sentence, anyone who wants a person gets passed straight to your team, and I never give medical advice."`,
    `- They already have someone on the phones: "Great, I'm not replacing them. I pick up what they can't get to, after hours and while they're with a patient, so nothing goes to voicemail."`,
    `- Not convinced: ask what they'd need to see, and offer another quick role-play on exactly that.`,
  ].join("\n");
  const next = callbackStep
    ? callbackStep
    : !a.goal
    ? `Next: take their reaction to the role-play in a few words (if they are unsure or not convinced, ask what would make it convincing for them), then find out what they are after: ${goalQuestion}`
    : !a.volume
    ? `Next: react to what they said in a few words, then ask: "Generally, how many calls do you get a day?"`
    : volumeCheck && !a.volumeCheck && bareCount(a.volume) !== null
    ? `Next: ${volumeCheck}`
    : !a.missed
    ? `Next: ask: "What happens with those calls after hours, or when your team's busy with patients?"`
    : !a.coverage
    ? `Next: ask: "How do you see me helping you best: after-hours only, picking up when the lines are busy, or handling everything that comes in?"`
    : nextBeat
    ? `Next: pitch beat ${DEMO_BEATS.indexOf(nextBeat) + 1}, as written below${nextBeat === DEMO_BEATS[0] ? "" : ", then the one after it if it flows"}.`
    : !a.tiedown
    ? `Next, the tie-down: "Anything that'd stop you from getting that running today?"`
    : !a.ask
    ? `Next: if something holds them back, answer it (below) and ask the tie-down once more in other words; then ask for it plainly: "Want to get ${clinic} set up?"`
    : `Next: if they said yes, ${close.charAt(0).toLowerCase()}${close.slice(1)} If they hesitate, answer the one thing holding them back (below) and ask once more.`;
  return [
    `The role-play is over: you are talking with ${who}, of ${clinic}'s team, as themselves again. ${nameRule}`,
    ...(known ? [known] : []),
    ...shared,
    ANSWERED_RULE,
    covered
      ? `They have answered the discovery questions: now the pitch, then the close.`
      : `Find out what they need before you sell anything: one short question a turn, a few words reacting to each answer before the next, and no pitch, no price and no talk of signing up until the questions are answered. If they ask about price, what you do or how to start before then, say you'll get to exactly that in a moment and ask the next question; if they say they're ready to buy, ask the remaining questions quickly so you set it up right.`,
    next,
    TALK,
    ...(covered ? [pitch, objections] : []),
    ...(covered
      ? [
          `Close: "Want to get ${clinic} set up?" ${close}${discountWords ? ` Say the discount exactly so: ${discountWords}.` : ""}`,
          offered
            ? `If they are still hesitant: "${noCall}"${discountWords ? " Mention the discount window once." : ""} Then thank them and say a warm goodbye. ${progress.callback === "sent" ? "The team already has their call-back request" : progress.callback === "failed" ? "They already have hello at healdesk dot io" : "You already offered a call from the team"}: never offer a call-back again or take another number.`
            : `If they are still hesitant, or ask to speak to a person, say exactly: "${DEMO_CALLBACK_OFFER.text}" (asked: callback). If they would rather not: "${noCall}"${discountWords ? " Mention the discount window once." : ""} Then thank them and say a warm goodbye.`,
        ]
      : []),
    `Never say the team has been told, has their number or will call: when they have, the call says so itself.`,
    ...(resume ? [resume] : []),
    leaving,
    ...quirkRules(progress, context.firstName),
    DEFLECT,
    POSITIONING,
    pushbackRule(progress.pushback),
    `Never say you will send a link, an email or a text, and never take payment details on the call. Deposit links go only in website chat or social messages, never on a call and never by text message.`,
    channelsLine(),
    `True answers to the usual doubts, in a sentence each: patients minding an AI (you say you are an AI in your first line, and anyone who wants a person gets passed to the team); patient data ("We sign a business associate agreement and handle patient data under it", never "HIPAA compliant"); setup (about fifteen minutes of their attention; phone goes live once they set up call forwarding on their own line, so they keep their number; website chat once a snippet is on their site); mistakes (you never diagnose or quote a price that is not on their list, urgent calls go straight to their team, and if anything fails, calls go to their own direct line); cost (the monthly price only starts once you are answering their patients).`,
    ...(covered ? [prices] : []),
    ...(offer ? [offer] : []),
    `If they want to try another role-play, ${startRule.charAt(0).toLowerCase()}${startRule.slice(1)}`,
    STATE_RULE,
    PROFESSIONAL,
  ].join("\n");
}

/**
 * The facts for a demo's talk after the role-play: its facts with
 * healdesk's own prices and the cost anchor the guard may let through
 * (demoPriceList, MARKET_ANCHORS_USD), and `businessCounts`, which lets a
 * bare count of the owner's calls through the unit-less dose pattern. The
 * discounted setup fees only once coverage is answered, as the note says
 * them: before then the guard refuses them as it refuses any figure not
 * given. Only after the role-play: in the intro and the role-play a made-up
 * treatment price that happened to match one of healdesk's would otherwise
 * pass, and the role-play is a patient's call in every way the guard reads.
 */
export function demoPitchFacts(
  facts: AssistantFacts,
  context: Pick<DemoCallContext, "offer">,
  now: number,
  progress: DemoProgress = DEMO_START_PROGRESS,
): AssistantFacts {
  const offer = progress.answers.coverage ? context.offer : null;
  return { ...facts, quotedAmountsUsd: [...demoPriceList(offer, now).amounts, ...Object.values(MARKET_ANCHORS_USD)], businessCounts: true };
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
