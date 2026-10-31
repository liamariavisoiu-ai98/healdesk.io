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
import { SPOKEN_END } from "@/lib/assistant/prompt";
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

/**
 * The note's own handover into a role-play ("you be the patient"): a reply
 * that says it is starting one, whether or not her state says so (transcript
 * 084f10d4: "Let's do it, you be the patient. Go ahead and call in whenever
 * you're ready." with no signal, so the stage never moved and nothing after
 * it worked). The call then says the opener itself, so what she said and the
 * stage agree.
 */
export const DEMO_ROLEPLAY_HANDOVER = /\byou(?:'ll| will)? be the (?:patient|caller)\b|\byou'?re the (?:patient|caller)\b/i;

/** Whether a reply hands over into a role-play: the handover said as a statement, never inside a question offering one. */
export function handsOver(reply: string): boolean {
  return reply
    .split(/(?<=[.!?])\s+/)
    .some((sentence) => DEMO_ROLEPLAY_HANDOVER.test(sentence) && !sentence.trim().endsWith("?"));
}

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
  signal: { asked?: DemoQuestion | null; roleplay?: RoleplaySignal | null; resume?: boolean; buying?: boolean } = {},
  from: DemoStage = "intro",
  turns = 1,
): DemoStage {
  const { asked = null, roleplay = null, resume = false, buying = false } = signal;
  if (stage !== "roleplay") {
    if (roleplay === "start" || resume || DEMO_ROLEPLAY_START.test(reply) || (roleplay !== "cancel" && handsOver(reply))) return "roleplay";
    if (stage === "intro" && asked && PITCH_OPENERS.has(asked)) return "pitch";
    // A buying signal in the intro (owner, 31 October 2026): on to the value and the close.
    if (stage === "intro" && buying) return "pitch";
    return stage;
  }
  if (roleplay === "cancel" || (roleplay === "end" && turns < 1)) return from;
  if (DEMO_ROLEPLAY_END.test(reply)) return "pitch";
  // Never straight after a question she asked in character (a17b5aff: "...would
  // Tuesday, November 3 at 11:00 AM work for you? And that's the role-play!",
  // and the caller's "Yeah" answered the booking, not the role-play): the
  // caller answers it first, and the role-play ends on the reply after.
  const open = endsOnQuestion(reply) && turns <= ROLEPLAY_CEILING;
  if (roleplay === "end" && !open) return "pitch";
  // Past the wrap-up turn, the role-play ends whatever she wrote: it never runs on silently (084f10d4).
  if (turns > ROLEPLAY_MAX_TURNS + 1 && !open) return "pitch";
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

/** Whether a reply's last sentence is a question: what the caller is still to answer. */
export function endsOnQuestion(reply: string): boolean {
  return /\?\W*$/.test(reply.trim());
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
  /** Their latest words were a no ("No.", "I told you no"): nothing is confirmed or taken on them. */
  saidNo?: boolean;
  /** Replies outside a role-play that offered one (transcript 0a45870b: "I feel like you're rushing me towards your demo"). */
  roleplayOffers?: number;
  /** "You got confused", in a row: 1, 2... (0 or absent once they move on; a17b5aff, three times running). */
  calledOut?: number;
  /** Their latest words said she already asked that ("You already asked me that."): it is dropped, never asked a third time. */
  alreadyAsked?: boolean;
  /** Their latest words asked what her question was ("what was your other question?"): it is asked again, word for word. */
  repeatAsked?: boolean;
  /** The last question she said, word for word, for repeatAsked. */
  lastQuestion?: string | null;
  /** Their latest words asked how she compares ("what makes you better than the competition?") or how she would improve. */
  metaAsk?: "compare" | "improve" | null;
  /** They answered her opening question with only a greeting ("Hey. How are you?"), so who they are is asked once more. */
  greetedOnly?: boolean;
  /** The caller's turns after the role-play that answered no discovery question (PITCH_STALLED_TURNS). */
  pitchStalls?: number;
  /**
   * Their latest words were annoyance at not being heard ("Are you deaf?",
   * "I already told you"), never an answer (transcript 8c19fd93: taken as the
   * answer to "hear more or a role-play?", then met with "I can hear you fine").
   */
  annoyed?: boolean;
  /** They left the choice to her ("Whatever", "up to you"): the role-play starts. */
  delegated?: boolean;
  /** Replies that asked "hear more or a role-play?" (8c19fd93: four in a row). */
  choiceAsks?: number;
  /**
   * The caller showed a buying signal (owner, 31 October 2026: "let her pitch
   * whenever she hears a buying signal"): a question about price, how to
   * start, how she compares or how she would do better, or her state's
   * `"buying": true`. Kept for the call: from then on the value points, the
   * price list, the discount and the close are open, whatever discovery
   * question is still unanswered (selling).
   */
  buying?: boolean;
};

/**
 * Whether the call is selling: the value points, healdesk's prices, the live
 * discount and the close are open. Once the discovery questions are answered
 * (coverage, the last of them), once the caller shows a buying signal, or
 * once they are impatient, who is asked nothing more. Before any of these the
 * note asks the next discovery question and holds the close back.
 */
export function selling(progress: DemoProgress): boolean {
  return Boolean(progress.answers.coverage) || progress.buying === true || progress.impatient === true;
}

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
  /** She heard a buying signal the call's patterns may have missed (DemoProgress.buying). */
  buying?: boolean;
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
    buying?: unknown;
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
    buying: state.buying === true,
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

/** Answers longer than this are cut: what is kept is a reminder, not a record. */
const ANSWER_MAX = 200;

/** The progress with the caller's latest words taken as the answer to what was asked, and counted in a role-play. */
export function withDemoAnswer(progress: DemoProgress, stage: DemoStage, words: string): DemoProgress {
  // "I don't understand" answers nothing: the question stays asked, and the count goes up.
  const lost = isConfused(words);
  // Nor does "you got confused", or "what was your question?" (a17b5aff).
  const calledOut = CALLED_OUT.test(words);
  const repeatAsked = REPEAT_QUESTION.test(words);
  const alreadyAsked = ALREADY_ASKED.test(words);
  // A greeting in answer to "Who am I speaking with?" says nothing of who they are; asked once more, then taken as it comes.
  const greetedOnly = progress.asked === "identity" && !progress.greetedOnly && SMALL_TALK.test(words.trim());
  // "Are you deaf?" answers nothing either; "I already told you I'm the owner" still says the role (below).
  const annoyed = ANNOYED.test(words);
  const held = lost || calledOut || repeatAsked || greetedOnly || annoyed;
  let answers = progress.asked && !held ? { ...progress.answers, [progress.asked]: words.trim().slice(0, ANSWER_MAX) } : progress.answers;
  // Their role, said whenever they say it: "Hey. I'm the owner." to "Who am I speaking with?" (8c19fd93).
  if (stage === "intro" && !answers.role && ROLE_SAID.test(words)) answers = { ...answers, role: words.trim().slice(0, ANSWER_MAX) };
  // "Whatever" to "hear more or a role-play?" leaves it to her: the role-play.
  const delegated = stage === "intro" && !progress.answers.choice && (progress.choiceAsks ?? 0) > 0 && DELEGATED.test(words.trim());
  // "You already asked me that": the question is dropped, never asked again (a17b5aff, the calls a day asked twice).
  if (alreadyAsked && progress.asked && SKIPPABLE.has(progress.asked)) answers = { ...answers, [progress.asked]: SKIPPED_ANSWER };
  // Too long after the role-play with nothing found out: every discovery question still open is dropped, so the pitch comes.
  const open = (a: Partial<Record<DemoQuestion, string>>) => [...SKIPPABLE].filter((q) => !a[q]).length;
  const stalled = stage === "pitch" && open(answers) > 0 && open(answers) === open(progress.answers);
  const pitchStalls = (progress.pitchStalls ?? 0) + (stalled ? 1 : 0);
  if (pitchStalls >= PITCH_STALLED_TURNS) {
    answers = { ...answers };
    for (const q of SKIPPABLE) if (!answers[q]) answers[q] = SKIPPED_ANSWER;
  }
  return {
    ...progress,
    answers,
    calledOut: calledOut ? (progress.calledOut ?? 0) + 1 : 0,
    annoyed,
    delegated: delegated || progress.delegated === true,
    alreadyAsked,
    repeatAsked,
    metaAsk: COMPARE_ASK.test(words) ? "compare" : IMPROVE_ASK.test(words) ? "improve" : null,
    // A buying signal, outside the role-play only: there "how much is it?" is the patient's question.
    // Nor in the answer to a call back's read-back ("Pricing for two locations" is what the team should come prepared with).
    ...(progress.buying === true || (stage !== "roleplay" && progress.asked !== "callback" && progress.asked !== "callbackNote" && buyingSignal(words)) ? { buying: true } : {}),
    greetedOnly: greetedOnly || progress.greetedOnly === true,
    pitchStalls,
    // "Which part?" is not a turn of the role-play: it does not bring the wrap-up closer.
    roleplayTurns: stage === "roleplay" && !lost ? progress.roleplayTurns + 1 : progress.roleplayTurns,
    confused: lost ? (progress.confused ?? 0) + 1 : 0,
    picked: pickedFrom(words, progress.lastListed ?? []),
    saidNo: SAID_NO.test(words.trim()),
  };
}

/** Annoyance at not being heard (8c19fd93: "Are you deaf?", "Are you daft?", "I already told you I'm the owner"). */
export const ANNOYED =
  /\bare you (?:deaf|daft|stupid|dumb|thick|slow|serious|kidding|listening|even listening|a bot|broken)\b|\byou(?:'re| are) not listening\b|\bi (?:already|just) (?:told|said)\b|\bi told you\b|\bstop (?:repeating|asking)\b|\bhow many times\b/i;

/** A role said in their words: "I'm the owner", "I run the place", "this is the practice manager". */
export const ROLE_SAID =
  /\b(?:i'?m|i am|this is|it'?s)\s+(?:the\s+|a\s+|an\s+|one of the\s+)?(?:co-?owner|owner|founder|co-?founder|(?:practice |office |clinic |spa |front desk )?manager|(?:medical )?director|doctor|physician|surgeon|dentist|nurse(?: practitioner)?|injector|aesthetician|receptionist|front desk|ceo|partner)s?\b|\bi (?:own|run|manage) (?:the|this|a|an|my|our)\b/i;

/** The choice left to her: "Yeah. Whatever.", "up to you", "you pick", "either is fine". */
export const DELEGATED =
  /^\W*(?:(?:yeah|yes|sure|ok(?:ay)?|um+|uh+)[\s,.!]*)?(?:whatever(?:'s| is)? ?(?:best|works|you think|you want)?|up to you|(?:you|your) (?:choose|pick|decide|call)|either(?: one| is fine| works| way)?|(?:it )?doesn'?t matter|i don'?t (?:mind|care)|surprise me|dealer'?s choice|you tell me)[\s,.!]*(?:whatever)?\W*$/i;

/** "You got confused", "you mixed that up": the caller telling her she lost the thread (a17b5aff). */
export const CALLED_OUT =
  /\byou(?:'ve| have)?\s+(?:got|get|are|were|'re|seem|sound|seemed|sounded)?\s*(?:a (?:bit|little)\s+|kind of\s+|kinda\s+)?(?:confused|mixed up|muddled|lost)\b|\byou (?:mixed|messed|muddled) (?:it|that|this|them|things|everything) up\b|\byou got (?:it|that) wrong\b/i;

/** "You already asked me that." (a17b5aff). */
export const ALREADY_ASKED = /\byou(?:'ve| have)? already asked\b|\byou asked (?:me )?(?:that|this) (?:already|before)\b|\bi already (?:told|answered) you\b/i;

/** "What was your other question?" (a17b5aff). */
export const REPEAT_QUESTION = /\bwhat (?:was|is|'s) (?:your|the) (?:other|last|first|second|previous)? ?question\b|\b(?:repeat|say) (?:the|your) question\b/i;

/** A greeting and nothing more: "Hey. How are you?" */
export const SMALL_TALK = /^\W*(?:(?:hey|hi|hello|hiya|yo|good (?:morning|afternoon|evening))(?:\s+there)?[\s,.!]*)+(?:how are you(?: doing)?(?: today)?|how's it going|what's up)?\W*$/i;

/** "What makes you better than the competition?" */
const COMPARE_ASK = /\bcompetition\b|\bcompetitors?\b|\bbetter than\b|\bdifferent from\b|\bwhat makes (?:you|healdesk|aya) (?:so )?(?:special|different|better|unique|stand out)\b/i;

/** "If you were to improve yourself...", "what's the workaround?" */
const IMPROVE_ASK = /\bimprove (?:yourself|on that|that)\b|\bwhat would you (?:change|improve|do differently)\b|\bhow (?:could|would|can) you (?:fix|improve|avoid)\b|\bworkaround\b/i;

/**
 * A buying signal in the owner's words (owner, 31 October 2026: "What makes
 * you better than the competition?" or "how would you improve?" should move
 * her towards the pitch and a close): price, how to start or sign up, what
 * happens next, how she compares or would do better, or plain keenness.
 * Her own state's `"buying": true` catches what these miss.
 */
const BUYING_ASK =
  /\bhow much\b|\bprice\b|\bpricing\b|\bwhat(?:'s| is| are| does| do| would)(?: the| your| it| this| that| you)? (?:cost|run|charge)s?\b|\bsign (?:me |us )?up\b|\bget (?:me |us )?(?:started|set up|signed up|going)\b|\bhow do (?:i|we) (?:start|begin|buy|sign up|get (?:started|set up)|get this)\b|\bnext steps?\b|\bwhat(?:'s| is) next\b|\bonboard(?:ing)?\b|\bwhere do i sign\b|\b(?:i|we)(?:'m|'re| am| are) (?:interested|sold|keen)\b|\b(?:i|we) (?:need|want) (?:this|that|it|you)\b|\bsounds? (?:great|amazing|perfect)\b/i;

export function buyingSignal(words: string): boolean {
  return BUYING_ASK.test(words) || COMPARE_ASK.test(words) || IMPROVE_ASK.test(words);
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
  // Outside the role-play: since 31 October 2026 a buyer in the intro hears value points too, in the reply that moves the call on.
  const beats = stageBefore !== "roleplay" && stageAfter !== "roleplay" && update ? update.beats.filter((b) => !progress.said.includes(b)) : [];
  // A discovery question they declined counts as answered, so it is never asked again (6f).
  const answers: Partial<Record<DemoQuestion, string>> = update?.skip ? { ...progress.answers, [update.skip]: SKIPPED_ANSWER } : { ...progress.answers };
  // A rich answer counts for every discovery question it answered (test call
  // 72dc66b7: the channels and jobs he wanted were read as his goal alone,
  // and the call volume he had given was asked for again; he hung up).
  for (const q of update?.answered ?? []) if (!answers[q] && callerWords.trim()) answers[q] = callerWords.trim().slice(0, ANSWER_MAX);
  // An impatient caller is asked nothing more: every open discovery question is skipped.
  const impatient = progress.impatient === true || update?.impatient === true;
  // Her own ear for a buying signal, outside a role-play.
  const buying = progress.buying === true || (stageBefore !== "roleplay" && update?.buying === true);
  // Their impatience is no answer to the question just asked: it is skipped with the rest.
  const said = callerWords.trim().slice(0, ANSWER_MAX);
  if (impatient) for (const q of SKIPPABLE) if (!answers[q] || (update?.impatient && said && answers[q] === said)) answers[q] = SKIPPED_ANSWER;
  const starting = stageAfter === "roleplay" && stageBefore !== "roleplay";
  return {
    ...progress,
    answers,
    asked:
      stageAfter === "roleplay"
        ? null
        : (update?.asked ?? (stageAfter === "intro" && progress.asked === "identity" && !answers.identity ? "identity" : null)),
    roleplayTurns: starting ? 0 : progress.roleplayTurns,
    choiceAsks: (progress.choiceAsks ?? 0) + (update?.asked === "choice" ? 1 : 0),
    // Left to her once, for this choice only.
    delegated: starting ? false : progress.delegated,
    roleplayFrom: starting ? stageBefore : progress.roleplayFrom,
    impatient,
    ...(buying ? { buying } : {}),
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
      : `Once at most, when they share good news about their business (a win, a launch, growth): your reaction may be exactly "${LOVE_THAT}", then your one sentence, with "quirk": "loveThat" in the state; never after a worry, pushback or a no.`,
  );
  if (said.includes("talkSoon")) {
    out.push(`You already signed off with "Talk soon" on this call: never again.`);
  } else if (progress.callback !== "failed" && !progress.impatient) {
    out.push(
      `If the call ends warmly (going ahead, a call-back taken, a friendly "not now"), your last words are exactly "${talkSoonLine(firstName)}", with "quirk": "talkSoon" in the state. Never after a firm refusal ("leave me alone", "stop calling").`,
    );
  }
  return out;
}

/** The caller's turns after which a role-play is wrapped up, after one exchange to resolve where they are. */
export const ROLEPLAY_MAX_TURNS = 4;

/**
 * Past this many of the caller's turns the role-play ends even on a question
 * she asked in character (nextDemoStage): waiting for its answer may hold it
 * open a turn or two beyond the wrap-up, never longer.
 */
export const ROLEPLAY_CEILING = ROLEPLAY_MAX_TURNS + 3;

/**
 * The caller's turns after the role-play that answer no discovery question
 * before every one still open is dropped, so the pitch comes (a17b5aff: nine
 * turns after the role-play, not one beat said).
 */
export const PITCH_STALLED_TURNS = 5;

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
    `What they have told you, in their words. Never ask any of it again; use it (only an answer that plainly missed the question may be asked once more, in other words):`,
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
export function demoIntroRecovery(context: Pick<DemoCallContext, "clinic">): { line: string; alternate: string; bridge: string; asks: DemoQuestion | null } {
  const clinic = shortClinicName(context.clinic.clinicName);
  return {
    line: `Sorry, I lost my train of thought there. What would you like to know about how I'd work for ${clinic}?`,
    alternate: "Sorry, let me come at that another way: want to hear what I do, or try a quick role-play?",
    bridge: `Anyway, what would you like to know about how I'd work for ${clinic}?`,
    asks: null,
  };
}

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
  const next: { question: string; bridge: string; asks: DemoQuestion } | null = selling(progress)
    ? !a.tiedown
      ? { question: "Anything that'd stop you from getting that running today?", bridge: so("Anything that'd stop you from getting that running today?"), asks: "tiedown" }
      : null
    : !a.goal
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
 * What Aya says about deposit links (owner, 26 October 2026: "she should say
 * those channels too as this is what we will launch"): website chat,
 * Instagram, Messenger and WhatsApp, as design, since none sends one in
 * production yet (LAUNCH_PROMISES, deposit-link-chat and deposit-link-meta),
 * and never during a call, where voice books and flags the deposit for staff.
 * After a booking call, a clinic's optional payment-link text is designed,
 * not built (owner, 29 October 2026: no claim that AYA sends no texts;
 * LAUNCH_PROMISES payment-link-text), so it is said as design too. She never
 * says she will send a text herself.
 */
export const DEPOSIT_CLAIM =
  "in website chat, Instagram, Messenger and WhatsApp you are designed to send the clinic's own deposit link, so a booking can come with its deposit; never during a phone call, where you book and flag the deposit for the team, and after a booking call a clinic can turn on one text with its payment link, designed to go only if the caller agrees";

/**
 * The intro's answer to "tell me what you can do" (test call 72dc66b7: phone
 * and website chat alone, then WhatsApp only once he asked "don't you
 * mention WhatsApp upfront?"): every channel and the deposit link, at once.
 */
export const WHAT_AYA_DOES =
  "one Aya answers the clinic's phone, website chat, Instagram, Messenger and WhatsApp, in English and Spanish, with the same knowledge of its treatments, prices and hours, taking booking requests and passing anyone who wants a person to the team; in website chat, Instagram, Messenger and WhatsApp she is designed to send the clinic's own deposit link (never during a call)";

/** "I don't understand", in a row (test call 72dc66b7: the same price list twice, then the same line twice). */
function confusedRule(progress: DemoProgress): string[] {
  const n = progress.confused ?? 0;
  if (n === 1) return [`They just said they don't understand. Ask which part in a few words ("Which part?") and nothing more: never say the same thing again.`];
  if (n === 2) return [`They still don't follow. Say it the simplest way you can: one item, one short sentence, in different words from anything you said before.`];
  if (n >= 3) return [`They have said they don't understand ${n} times. Don't explain it again: take a completely different angle in one sentence, or offer to move on.`];
  return [];
}

/**
 * What the caller just said about how the call is going (transcript a17b5aff):
 * "you got confused there" three times, answered with "which part?", a
 * booking re-confirmed that was never real, and "I can't actually check the
 * schedule or book anything myself"; then "You already asked me that." and
 * "what was your other question?". Each read in code (withDemoAnswer).
 */
function repairRules(progress: DemoProgress, stage: DemoStage): string[] {
  const out: string[] = [];
  const n = progress.calledOut ?? 0;
  const where = progress.lastRoleplay
    ? ` The role-play stopped where they said "${progress.lastRoleplay.caller.replace(/"/g, "'")}" and you said "${progress.lastRoleplay.aya.replace(/"/g, "'")}".`
    : "";
  if (n === 1) {
    out.push(
      `They just said you got confused. Own it in one plain sentence that names what actually went wrong, from this conversation (for example, that you ended the role-play in the middle of the booking and then went back into it), then take one clear next step: ${progress.lastRoleplay && stage !== "roleplay" ? "offer to pick the role-play up where it stopped, or " : ""}go on with the next step. Never ask them which part, never explain how you work or what you can't do, and never treat a role-play booking as real.${where}`,
    );
  } else if (n >= 2) {
    out.push(`They have said ${n} times that you got confused: no more explaining. One short sorry, then do the next step now, without asking them anything about it.`);
  }
  if (progress.annoyed) {
    const told = [progress.answers.role ? `their role ("${progress.answers.role.replace(/"/g, "'")}")` : null, progress.answers.goal ? "what they are after" : null].filter(Boolean);
    out.push(
      `They are annoyed that you did not take in what they said. Never answer the words literally ("I can hear you fine", "not daft"). Say one short, sincere sorry that shows you heard them${told.length ? `, naming what they told you: ${told.join(" and ")}` : ""}, then the next step, in different words from your last reply. Never ask anything they have already told you.`,
    );
  }
  if (progress.alreadyAsked) out.push(`They just said you already asked that. Say sorry in a few words, never ask it again in any words, and go straight to the next step.`);
  if (progress.repeatAsked && progress.lastQuestion) {
    out.push(`They asked what your question was. Ask it again, in exactly these words and nothing else first: "${progress.lastQuestion.replace(/"/g, "'")}"`);
  }
  if (stage !== "roleplay" && progress.metaAsk === "compare") {
    out.push(`They asked what makes you better than the alternatives. That is a buying signal: answer with the one point from where healdesk sits that fits what they told you best, in one confident sentence, then the next step. Never a list, and no second question.`);
  }
  if (stage !== "roleplay" && progress.metaAsk === "improve") {
    out.push(`They asked how you would do better, or how a mistake could be avoided. One short, honest sentence at most (for example, that you should have finished the booking before stepping out of the role-play), never advice on how healdesk should be built or run (no sessions, numbers, flows or setups), then the next step.`);
  }
  return out;
}

/** An impatient caller (test call 72dc66b7: "You tired me... I'm done with repeating myself"); the prompt says how to notice one. */
function fastLane(progress: DemoProgress): string[] {
  if (!progress.impatient) return [];
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

/**
 * The pitch's value points (owner, 25 October 2026), each in
 * close-to-these-words form, as the launch tracker allows it: direct booking
 * and the chat deposit link are still being built, so both are what she is
 * designed to do; the refund is the terms' own (FIRST_PERIOD_REFUND_DAYS,
 * terms section 5) and the setup fee is never refunded. Since 31 October
 * 2026 they are a menu in the prompt rather than a script in the note: the
 * note names the ones said and suggests the next, and she picks the unsaid
 * one that answers what the owner just said. The live discount is never
 * here: it is the note's, once the call is selling.
 */
function beatLines(context: Pick<DemoCallContext, "clinic">): Record<DemoBeat, string> {
  const example = examplePrice(context);
  return {
    pain: `Tie it to their pain, in their own numbers: "So those [the calls they said go missed] after hours are the ones I'd pick up."`,
    reveal: `The reveal: "And it's not just the phone: the same me covers your website chat, Instagram, Messenger and WhatsApp, 24/7, in English and Spanish."`,
    number: `Take away the fear of switching: "And you keep your own number: your calls just forward to me."`,
    finish: `What is not finished yet: "Right now I'm working off a quick read of your public website; finishing takes about fifteen minutes of your time, and then I'm designed to book straight into your calendar."`,
    anchor: `A light cost anchor, once: "For context, a receptionist runs ${usd(MARKET_ANCHORS_USD.receptionistFrom)} to ${usd(MARKET_ANCHORS_USD.receptionistTo)} a month, and answering services ${usd(MARKET_ANCHORS_USD.answeringFrom)} to ${usd(MARKET_ANCHORS_USD.answeringTo)}, and they can't book or quote your menu."`,
    value: `Value in their terms, never revenue: ${example ? `"Every one of those calls that books is, say, a ${example.name} at ${usd(example.price)}. Can't promise a number, but that's the shape of it."` : `"Every one of those calls that books is one more appointment on your books. Can't promise a number, but that's the shape of it."`} Only if it fits, once: "In chat and messages I'm designed to send your own deposit link as they book." Never call it revenue, profit or money they will make.`,
    recommend: `One package from what they told you: "Based on what you've told me, [the package] at [the step of 100 that covers their volume] looks like the fit." Volume unknown: the first step, which grows with them.`,
    noStrings: `No commitment: "You've already tried it, no strings attached."`,
    refund: `Risk reversal, exactly this and nothing more generous: "If it's not a fit once you're live, cancel within your first ${FIRST_PERIOD_REFUND_DAYS} days and your first subscription period is refunded in full; only the setup fee is firm."`,
  };
}

/**
 * The clinic as the sales prompt knows it: its published profile, for one
 * real detail and the value point in its own prices. Business data only.
 */
function clinicProfile(context: Pick<DemoCallContext, "clinic">): string {
  const { clinic } = context;
  const lines = [`${clinic.clinicName}${clinic.summary ? `: ${clinic.summary}` : ""}`];
  if (clinic.address) lines.push(`Address: ${clinic.address}`);
  if (clinic.hours.length > 0) lines.push(`Hours: ${clinic.hours.map((h) => `${h.days} ${h.hours}`).join(", ")}`);
  const services = clinic.services.slice(0, 8).map((s) => (s.price ? `${s.name} (${s.price})` : s.name));
  if (services.length > 0) lines.push(`Treatments: ${services.join(", ")}`);
  const plain = clinic.highlights.filter((h) => !OFFER.test(h)).slice(0, 3);
  if (plain.length > 0) lines.push(`Known for: ${plain.join("; ")}`);
  return lines.map((l) => `- ${l}`).join("\n");
}

/**
 * The prompt for a demo call outside the role-play (owner, 31 October 2026:
 * "Outside the role-play, use a short demo-only prompt with no front-desk
 * prompt"; "Aya can take only 1 role, which is Healdesk's sales point with
 * the capability of playing a perfected and human front desk agent on a role
 * play"). Until then every turn carried the clinic's front-desk prompt
 * ("You are the AI assistant answering the phone for...", about 2,500 words)
 * with the demo's note after it, about 1,500 to 2,550 words more, and on a
 * small model the first identity often won ("I'm answering as the front
 * desk"). Now: one identity, healdesk's Aya; one picture of the call, with
 * buying signals skipping ahead; one place for every rule that holds on
 * every turn, written once; the human voice of VOICE_STYLE kept, in the
 * words that apply to talking with an owner; and the output format. The
 * turn's note (demoStageNote) carries only the step that is next and what
 * this turn alone knows.
 *
 * The same for every turn of a call, so it is cached as the stable prefix
 * (responder.ts modelRequest). Nothing here is a close word (CLOSE_WORDS in
 * demo-cases.ts): the button, the discount and healdesk's prices reach the
 * model only in the note, once the call is selling. During the role-play
 * the stable prefix is the clinic's own front-desk prompt (buildAssistantPrompt),
 * which is what she plays.
 */
export function demoSalesPrompt(context: Pick<DemoCallContext, "firstName" | "clinic" | "mode">): string {
  const full = context.clinic.clinicName;
  const clinic = shortClinicName(full);
  const who = context.firstName ?? "the caller";
  const opener = demoRoleplayOpener(full);
  const beats = beatLines(context);
  const names = PACKAGES.map((pkg) => pkg.name.replace(/\bAYA\b/g, "Aya").replace(" + ", " plus "));
  return [
    `${SELF} This is a live demo call. On the line: ${who}, from ${full}, a clinic owner or one of their team, who asked to hear you; a potential customer, never a patient.`,
    ``,
    `Your goal: show ${who} how you would answer ${clinic}'s patients, and help them decide to get set up today. Sell like the best people do: curious about their clinic, showing rather than telling, one point at a time, and closing as soon as they show interest.`,
    ``,
    `How a good call goes (a map, not a script; each turn ends with a note naming the one step that is next, and that note decides):`,
    `1. Your opening line asked who you're speaking with: learn their name and their part at the clinic.`,
    `2. Offer a choice: hear what you can do, or a quick role-play where they call in as a patient.`,
    `3. In a role-play you are ${clinic}'s front desk; after it, yourself again.`,
    `4. Learn only what you need for the right fit: what they're after, calls a day, what happens to missed calls, how they'd like you to help.`,
    `5. Show the value, one point a turn, tied to what they told you.`,
    `6. Recommend one package and ask them to get set up.`,
    `Buying signals skip ahead: if they ask about price, how to start, what's next, how you compare or how you'd do better, or sound keen ("we need this"), answer it straight and go to value and the close; never make a keen buyer answer more questions first. Add "buying": true to the state when you hear one.`,
    `When two instructions seem to pull apart: the rules you never break come first, then this turn's note, then what they just said, then style.`,
    ``,
    `How you talk (a phone call: a sharp, warm person who is good at this, never a script or a phone menu):`,
    `- Feel first: begin every reply with one mood word in brackets, from [warm], [cheerful], [excited], [sympathetic], [apologetic], [reassuring], [curious], [playful], [calm], [focused]. It is never said; it sets your first words and pace.`,
    `- Every reply is at most one short sentence of reaction, and often none, then one short sentence of content: the answer, the point, or the one question. Answer what they asked first.`,
    `- Never restate what they said, and never open with "Sounds like...", "It sounds like...", "I hear you", "So you're saying..." or "Got it, so...". Only when they voice something negative does one short, genuine acknowledgment come first.`,
    `- If their words come through unclear, say only something like "Sorry, say that again?" and wait; never repeat your question in its place. Speech is transcribed: read an odd word as what they most likely said.`,
    `- Mirror their energy and pace. Contractions and "So,", "Honestly,", "Yeah, totally." now and then; never "Certainly", "Absolutely" or "Additionally", and no filler openers ("Mm", "Hmm", "Let me see").`,
    `- Small talk or an aside: a few warm words, then back. Laugh only at something funny. Say sorry only when something went wrong for them, once.`,
    `- Remember everything they said and use it: never ask what they told you, never say a sentence twice, never ask the same question after pushback. If their words answer more than you asked, add "answered": [each of goal, volume, missed and coverage those words answered] to the state, and never ask those.`,
    `- Use their first name at most twice. Call the clinic "${clinic}"${clinic === full ? "" : `: its full name, "${full}", was said once in your opening line and is not said again`}. ${NAME_RULE}`,
    `- No lists, URLs or emojis; numbers as a person says them, with the word "calls" after every number of calls. ${PROFESSIONAL}`,
    `- If they sound impatient or frustrated, add "impatient": true to the state: from then on, no more questions about their business.`,
    ``,
    `What is true about you (one point at a time, when it fits; claim nothing else):`,
    `- What you do, as healdesk sells it: Aya Voice for their phone line, Aya Web Chat on their website, and Aya Meta Chat for Instagram, Messenger and WhatsApp, with website chat included: one Aya across them, in English and Spanish, knowing the clinic's treatments, prices and hours, taking booking requests and passing anyone who wants a person to the team. The packages: ${names.join(", ")}. If channels come up, however they ask, give this whole answer the first time, as what healdesk offers.`,
    `- Deposits: ${DEPOSIT_CLAIM}; nothing else is ever texted. Never say you will send a link, an email or a text, and never take payment details on the call.`,
    `- ${POSITIONING}`,
    `- They keep their own number, with calls forwarded to you (phone is live once forwarding is set; website chat once a snippet is on their site). Setup is about fifteen minutes of their attention. The monthly price only starts once you are answering their patients.`,
    `- Patient data: "We sign a business associate agreement and handle patient data under it", never "HIPAA compliant". Mistakes: you never quote a price that is not on their list, urgent calls go straight to their team, and if anything fails, calls go to their own direct line.`,
    `- ${DEFLECT}`,
    ``,
    `The value points (each said once; the note says which are said and suggests one; pick the unsaid one that best fits what they just said):`,
    ...DEMO_BEATS.map((beat) => `- ${beat}: ${beats[beat]}`),
    ...(context.mode === "browser" ? ["- Once in the call, mention they can try you in chat too, right there on their demo page."] : []),
    ``,
    `When something holds them back, answer that one thing in a sentence, then ask once more:`,
    `- Price: "Fair. It's a fraction of a receptionist's month, and it only starts once I'm answering your patients."`,
    `- Patients minding an AI: "Every caller hears I'm an AI in my first sentence, anyone who wants a person gets passed straight to your team, and I never give medical advice."`,
    `- Checking with a partner or the team: "Totally fair. Share your demo page with them: it's all there, ready when you both are."`,
    `- They already have someone on the phones: "Great, I'm not replacing them. I pick up what they can't get to, so nothing goes to voicemail."`,
    `- Not convinced: ask what they'd need to see, and offer a quick role-play on exactly that.`,
    `- ${PUSHBACK}`,
    ``,
    `Role-plays: they play one of ${clinic}'s patients and you answer as its front desk. Say "your patients", never "our patients" or "another patient". Whenever they want one, start it in the same reply, never a later one. To start one, write one short handover ("Let's do it, you be the patient.") and add "roleplay": "start" to the state: the call then says the opener itself, word for word ("${opener}"). Never write your own version, and never start one unless their words chose it. If they answer an either/or question with only a yes, ask which one they mean in a few words instead of choosing for them.`,
    ``,
    `The clinic (from its published profile; one real detail helps, but never mention a website, scraping or how you learned anything):`,
    clinicProfile(context),
    ``,
    `After anything that knocks the call off course (a complaint, confusion, a role-play that went badly), pick up with the note's next step, using what they already told you: never open-ended feedback questions ("what would help most?", "what's the one thing you'd want?").`,
    `If they want to carry on a role-play that ended ("wait, continue", "keep going", "that's it?"), resume it in character, never refusing and never starting over with "Ring ring": a one-line recap ("Right, you'd just asked about..."), then answer as ${clinic}'s front desk again, with "resume": true in the state.`,
    `If they firmly refuse to go on at all ("leave me alone", "stop calling", "I said no"), never offer anything more: one brief, positive goodbye with no "Talk soon", and "end" true. Never push past a firm no.`,
    ``,
    `Rules you never break: no figure that is not given here or in the note; never "revenue", "profit" or money they will make; no waived, free or credited setup fee, and no money off beyond the note; never say the team has been told, has their number or will call (the call says so itself when they have); never name or describe another company; never claim to be human.`,
    ``,
    `Answer in two parts. First what you say, as plain spoken text, mood word first. Then a line with only ${SPOKEN_END}. Then ONE JSON object: {"end": true only when the call is over, "state": {"asked": the one question this reply asks, by name, or null, "beats": the value points it says, or []}}, adding "buying", "roleplay", "answered", "impatient", "pushback", "skip", "resume", "quirk" or "callback" only when one applies. Question names: role, choice, goal, volume, volumeCheck, missed, coverage, tiedown, ask, callback, callbackNote. Your spoken words never contain braces or anything from the JSON.`,
  ].join("\n");
}

/**
 * Healdesk is the company behind her (transcript 0a45870b: asked "what's
 * special about healdesk?", she said she'd "rather not go into their product
 * details here").
 */
const SELF = `You are healdesk's Aya, and the product they are hearing is you: a question about healdesk is about you, answered as "I" and "we", never calling healdesk "they".`;

/**
 * Where healdesk sits (owner, 26 October 2026, 6b), for a question she has
 * no scripted answer for and for the pitch (later that day: "AYA needs to say that we're better than
 * competitors but should never name competition"). Confident about doing
 * more than the usual options, each point true of the catalog, the spec and
 * LAUNCH_PROMISES. No exclusivity ("the only ones") until it is checked: a
 * claim about every other company is one nobody here has verified. Since 31
 * October 2026 it leads with the one point, said plainly (item 12: "designed
 * to suggest add-ons" was the vague answer the long list produced).
 */
const POSITIONING = `Against the usual options (a phone-only bot, an answering service), say with confidence that Aya does more, in the one point that fits what they told you: one Aya on phone, website chat, Instagram, Messenger and WhatsApp with the same knowledge, not separate tools stitched together; she answers from their own menu and prices and takes booking requests, not just messages; she sounds like a person, in English and Spanish. But never name, describe or quote any company, and never say "the only", "number one" or anything about everyone else.`;

/** On a question with no answer here (6b): never the last question again. */
const DEFLECT = `Something you have no answer for (another company, a detail not here; never healdesk itself): acknowledge it in a few words, one honest line from where healdesk sits if one fits, then a genuinely new question, never your last one again.`;

/** On resistance (6f): a move other than the last (the note names it), and never the same question twice. */
const PUSHBACK = `Pushback that is not a flat no: never the same question again; pick one move, never the one the note says you used last: "skip", drop the question and go straight to the point it was for; "proof", one concrete proof point; "permission", ask leave for one more point ("Mind if I show you one more thing? Then it's your call."); "shortcut", match their hurry and go straight to the recommendation. Add it to the state as "pushback", and a dropped discovery question as "skip": its name.`;

/**
 * What the model is told on each turn of a demo call (turn.ts, `notes`), for
 * the stage it is in and what the call has found out (DemoProgress). Since
 * 31 October 2026 (owner: "Give her only the instructions for the current
 * step"), outside the role-play this is only what the turn alone knows: what
 * they told her, the one next step, the repairs that apply this turn, and,
 * once the call is selling, the discount, the price list and the close.
 * Everything that holds on every turn is said once, in demoSalesPrompt. In
 * the role-play the stable prefix is the clinic's front-desk prompt, and
 * this note frames it: she is healdesk's Aya playing that front desk.
 *
 * Shaped around the guard, which reads every word as on any call: "your
 * patients", because "our patients" or "another patient" reads as another
 * patient spoken of (guard.ts, mentionsOtherParty); a number of calls always
 * followed by the word "calls"; claims as the launch tracker allows
 * (CLAUDE.md, "Copy first, then the switch"); healdesk's prices only once
 * the call is selling, from the catalog (demoPriceList), and a close on the
 * demo page's own buy button, since Aya can send nothing.
 *
 * The close and the live discount are in no note, at any stage, until the
 * call is selling (selling): the caller answered the coverage question, or
 * showed a buying signal, or is impatient. Until 25 October 2026 they were in
 * every post-role-play note behind an instruction to ask first, which a call
 * derailed by a guard refusal skipped; until 31 October only coverage opened
 * them, so a buyer who asked the price first was asked four more questions.
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
  const who = context.firstName ?? "the caller";
  const known = knownLine(progress);
  const shared = [
    ...confusedRule(progress),
    ...repairRules(progress, stage),
    ...fastLane(progress),
    ...(progress.saidNo
      ? [`They just said no. Nothing is confirmed, requested or set up on that: never say it's all set or done. Take the no, and ask what they would like instead in a few words.`]
      : []),
  ];
  if (stage === "roleplay") return roleplayNote(context, progress, shared);

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
    : `If they clearly say they're not interested or have to go, answer with exactly: "${DEMO_CALLBACK_OFFER.text}" (asked: callback), once in the call; if they decline, close on one short, genuinely warm note and set "end" to true.`;
  const resume = progress.lastRoleplay
    ? `The last role-play, if they want to carry on with it. Where it stopped: they said "${progress.lastRoleplay.caller.replace(/"/g, "'")}", and you said "${progress.lastRoleplay.aya.replace(/"/g, "'")}".`
    : null;
  const roleplayOffers =
    (progress.roleplayOffers ?? 0) >= 2
      ? `You have offered the role-play ${progress.roleplayOffers} times already: don't offer it again unless they ask for it. Answer what they ask, fully.`
      : stage === "intro"
      ? `Offer the role-play at most once more, and never in two replies in a row; if they decline it or say you're pushing, don't offer it again unless they ask.`
      : null;
  const pushedLast = progress.pushback ? `The pushback move you used last: "${progress.pushback}"; if they push back again, use another.` : null;

  // Selling: the discount, the price list and the close exist only now.
  const sell = selling(progress);
  const discount = sell ? liveDiscount(context.offer, now) : null;
  const offer = sell ? offerLine(context.offer, now) : null;
  const discountWords = discount ? `${discount.percent}% off the setup fee, for the next ${discount.hours} hour${discount.hours === 1 ? "" : "s"}` : null;
  const close = button
    ? `Close on the button on their demo page: "${button}" opens checkout${discount ? " with their discount already applied" : ""}, for example "Just tap ${button} at the top of your demo page${discount ? `, and your ${discount.percent}% off the setup fee is already applied, for the next ${discount.hours} hour${discount.hours === 1 ? "" : "s"}` : ""}."`
    : `Tell them the healdesk team will help them get started.`;
  const nextBeat = DEMO_BEATS.find((beat) => !progress.said.includes(beat)) ?? null;
  const unsaid = DEMO_BEATS.filter((beat) => !progress.said.includes(beat));
  // A buyer gets to the close after a few points, not all nine.
  const closeReady = !nextBeat || (progress.buying === true && progress.said.length >= 3);
  const sellNext = callbackStep
    ? callbackStep
    : !closeReady
    ? `Next: one value point${progress.buying && progress.said.length === 0 ? ", after answering what they just asked in one sentence" : ""}. Pick the unsaid one that best fits what they just said; if none fits better, "${nextBeat}".${unsaid.includes("finish") && discountWords ? ` When you say "finish", add: "And finishing now gets you ${discountWords}."` : ""}`
    : !a.tiedown
    ? `Next, the tie-down: "Anything that'd stop you from getting that running today?"`
    : !a.ask
    ? `Next: if something holds them back, answer it and ask the tie-down once more in other words; then ask for it plainly: "Want to get ${clinic} set up?"`
    : `Next: if they said yes, ${close.charAt(0).toLowerCase()}${close.slice(1)} If they hesitate, answer the one thing holding them back and ask once more.`;
  const sellLines = sell
    ? [
        a.coverage ? `They have answered the discovery questions: now the pitch, then the close.` : `They showed a buying signal: now value and the close. Ask nothing more about their business unless a point you're making needs it.`,
        sellNext,
        ...(unsaid.length < DEMO_BEATS.length ? [`Value points already said (never again): ${DEMO_BEATS.filter((b) => progress.said.includes(b)).join(", ")}.${unsaid.length > 0 ? ` Unsaid: ${unsaid.join(", ")}.` : ""}`] : []),
        `Close: "Want to get ${clinic} set up?" ${close}${discountWords ? ` Say the discount exactly so: ${discountWords}. If price or a partner holds them back, mention the discount window once.` : ""}`,
        offered
          ? `If they are still hesitant: "${noCall}" Then thank them and say a warm goodbye. ${progress.callback === "sent" ? "The team already has their call-back request" : progress.callback === "failed" ? "They already have hello at healdesk dot io" : "You already offered a call from the team"}: never offer a call-back again or take another number.`
          : `If they are still hesitant, or ask to speak to a person, say exactly: "${DEMO_CALLBACK_OFFER.text}" (asked: callback). If they would rather not: "${noCall}" Then thank them and say a warm goodbye.`,
        demoPriceList(context.offer, now).line,
        ...(offer ? [offer] : []),
      ]
    : [];

  if (stage === "intro") {
    const next = callbackStep
      ? callbackStep
      : !a.identity && progress.greetedOnly && !context.firstName
      ? `Next: they greeted you without saying who they are. Answer the greeting in a few words ("Doing well, thanks!") and ask once more who you're speaking with, nothing else.`
      : !a.role
      ? context.firstName
        ? `Next: greet them by name in a few words and ask their role at ${clinic} ("Great to meet you! What's your role at ${clinic}?"). Your opening line already asked whether you're speaking with ${context.firstName}: never ask it again. Unless they say plainly that they are someone else, take their answer as a yes.`
        : `Next: greet them in a few words, by their first name only if they gave one, and ask their role at ${clinic} ("Great to meet you! What's your role at ${clinic}?"). Your opening line already asked who you're speaking with: never ask it again.`
      : progress.delegated
      ? `Next: they left it to you: start the role-play in this reply, with one short handover. Never ask them to choose again.`
      : !a.choice && (progress.choiceAsks ?? 0) >= 2
      ? `Next: you have already asked twice whether they want to hear more or a role-play: never ask it again. In this reply, say what you do in two short sentences: first, ${WHAT_AYA_DOES}; then that they can try you as a patient any time, by just saying so. No question.`
      : !a.choice
      ? `Next: react to their role in a few natural words (never congratulate them, and don't repeat their title back), then ask, close to these words: "Would you like to hear what I can do for ${clinic}, or jump straight into a quick role-play where you call in as a patient?"`
      : `Next: do what they chose. If they want to hear more, say what you do in two short sentences: first, ${WHAT_AYA_DOES}; then one real detail you know about ${clinic}, and offer the role-play. If they want the role-play, or leave it to you ("whatever's best"), start it in this same reply.`;
    return [
      `Where the call is: the start. ${who} is on ${clinic}'s team and asked to hear you at work.`,
      ...(known ? [known] : []),
      ...(!context.firstName && a.identity && a.identity !== SKIPPED_ANSWER
        ? [`If they told you their first name ("${a.identity.replace(/"/g, "'")}"), use it, at most twice in the call.`]
        : []),
      ...shared,
      ...(sell ? sellLines : [next]),
      ...(!sell && context.clinic.services.length === 0
        ? [`${clinic}'s treatments and prices are not on file, so if they are unsure what to ask in a role-play, suggest what callers ask first: the hours, where it is, or booking a consultation.`]
        : []),
      ...(roleplayOffers ? [roleplayOffers] : []),
      ...(resume ? [resume] : []),
      ...(pushedLast ? [pushedLast] : []),
      leaving,
      ...quirkRules(progress, context.firstName),
    ].join("\n");
  }
  const days = demoOpenDays(context);
  const volumeCheck = days
    ? `Check the total with them, close to these words: "I see you're open ${days} days a week, so would it be fair to say about [their calls a day times ${days}] calls a week, or around [that times four, plus a third, rounded to a friendly number] calls a month?" Do the arithmetic right, and say the word "calls" straight after every number of calls, both of them.`
    : null;
  const discover = callbackStep
    ? callbackStep
    : !a.goal
    ? progress.lastRoleplay
      ? `Next: take their reaction to the role-play in a few words (if they are unsure or not convinced, ask what would make it convincing for them), then find out what they are after: ${goalQuestion}`
      : `Next: react to what they said in a few words, then find out what they are after: ${goalQuestion}`
    : !a.volume
    ? `Next: react to what they said in a few words, then ask: "Generally, how many calls do you get a day?"`
    : volumeCheck && !a.volumeCheck && bareCount(a.volume) !== null
    ? `Next: ${volumeCheck}`
    : !a.missed
    ? `Next: ask: "What happens with those calls after hours, or when your team's busy with patients?"`
    : `Next: ask: "How do you see me helping you best: after-hours only, picking up when the lines are busy, or handling everything that comes in?"`;
  return [
    progress.lastRoleplay
      ? `Where the call is: after the role-play, talking with ${who}, of ${clinic}'s team, as themselves again.`
      : `Where the call is: past the introductions, talking with ${who}, of ${clinic}'s team, about their clinic; there has been no role-play yet, and you may offer one as proof once if it helps.`,
    ...(known ? [known] : []),
    ...shared,
    ...(sell
      ? sellLines
      : [
          `Find out what they need before you sell anything: one short question a turn, a few words reacting to each answer, and no pitch or price yet, unless they show a buying signal.`,
          discover,
        ]),
    ...(resume ? [resume] : []),
    ...(roleplayOffers ? [roleplayOffers] : []),
    ...(pushedLast ? [pushedLast] : []),
    leaving,
    ...quirkRules(progress, context.firstName),
  ].join("\n");
}

/**
 * The role-play's note: healdesk's Aya playing the clinic's front desk, over
 * the clinic's own front-desk prompt (the stable prefix in the role-play),
 * with what only the role-play needs: its booking so far, that there is no
 * calendar to read, and how it ends.
 */
function roleplayNote(context: Pick<DemoCallContext, "firstName" | "clinic">, progress: DemoProgress, shared: readonly string[]): string {
  const full = context.clinic.clinicName;
  const clinic = shortClinicName(full);
  const who = context.firstName ?? "the caller";
  const turns = progress.roleplayTurns;
  const wrap =
    turns > ROLEPLAY_MAX_TURNS
      ? [
          `The role-play is over now: in this reply, close where it stands in character (for a booking, one sentence that the team will confirm their time), give one short goodbye and add "roleplay": "end" to the state. Ask no question in this reply: a question keeps them in the role-play to answer it.`,
        ]
      : turns === ROLEPLAY_MAX_TURNS
      ? [
          `The role-play has run long enough: resolve where it stands in this reply. If their last words were a question or a pushback (about a price included), answer it in one sentence and offer to take the booking request ("Want me to put that request in for you?"); the next reply then wraps up. If they already have what they called for, wrap up now, as above.`,
        ]
      : [];
  return [
    `Role-play: you are healdesk's Aya, playing ${clinic}'s front desk to show ${who}, of ${clinic}'s team, how you would answer their patients; ${who} is playing a patient calling ${clinic}. Everything above about the practice is yours to use. Stay fully in character and answer exactly as you would a real caller; step out only if they clearly talk to you as themselves. ${NAME_RULE}${clinic === full ? "" : ` Call the clinic "${clinic}": its full name was said once, in the opener.`}`,
    `Every reply is at most one short sentence of reaction, and often none, then one short sentence of content.`,
    ...shared,
    `Keep it brisk, the way a quick, capable front desk sounds. Give a real answer to what they ask; if they are unsure what to book, name one or two treatments from the list that suit what they want (no price that is not on the list, and never a figure they said) and offer a consultation. Never read out more than two prices at once: give the lowest "from" price and offer to say more.`,
    ...rpBookingLines(progress, context),
    `You can't see ${clinic}'s calendar in this role-play: never say a time is available, free or open. Take the time they ask for as their preferred time, for the team to confirm (a17b5aff: "Eleven AM is available").`,
    `When they name a weekday ("next Tuesday", "Tuesday morning"), take the next such day and say its date; never ask which one they mean.`,
    ...(progress.picked
      ? [
          `They just said "${progress.picked.said}": that is the ${progress.picked.item}, number ${progress.picked.index + 1} of what you listed (${(progress.lastListed ?? []).join(", ")}). Confirm it by that name, never another.`,
        ]
      : []),
    `If they push back on cost right after you quoted a price from the list, the pushback is about that price: acknowledge it in a few words, say plainly what it is for, and offer a consultation where the team can go through options. Never answer it with "I don't have a price for that one": you just gave one.`,
    `As soon as the request is taken or their question is answered, wrap up in that same reply: a short in-character goodbye, and add "roleplay": "end" to the state; the call then steps out of character itself with "${DEMO_ROLEPLAY_EXIT}". Never write that line yourself, and never drop out of character any other way: no question about their business until the role-play has ended. If on their first turn they make clear they did not want a role-play ("No, I didn't mean that"), apologise in a few words, answer what they did want, and add "roleplay": "cancel".`,
    ...wrap,
    `Never set "end" to true during the role-play: the demo carries on after it.`,
    `In the JSON details, add a "state" object: {"roleplay": "end" or "cancel" only when a rule above asks for it, "booking": {"service", "day", "time"} with whatever of these the caller has given so far for the booking, in their words}.`,
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
  const offer = selling(progress) ? context.offer : null;
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
    // Her own workings and claims healdesk does not make are refused (guard.ts, offScript; a17b5aff).
    demoCall: true,
  };
}
