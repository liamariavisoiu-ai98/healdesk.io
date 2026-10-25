import {
  DEMO_CALL_VARIABLE,
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
 * session (retell.ts) from Aya's own scripted lines, never from the model's
 * say-so alone:
 *   intro     who they are, their role, then the choice: hear more, or a
 *             role-play;
 *   roleplay  from the reply that says the role-play opener ("Ring ring!",
 *             DEMO_ROLEPLAY_START): they play a patient, Aya is the clinic's
 *             front desk;
 *   pitch     from the reply that steps out of it ("how was that?",
 *             DEMO_ROLEPLAY_END): the pitch and the discovery questions.
 * Each stage has its own note (demoStageNote), so no stage's instructions
 * are repeated into another: repeating the opening's instructions deep into
 * a role-play is what made Aya seem to forget the caller's name (owner,
 * 24 October 2026).
 */
export type DemoStage = "intro" | "roleplay" | "pitch";

/** The words that start and end the role-play, as said in Aya's own replies. */
export const DEMO_ROLEPLAY_START = /\bring[\s,!.-]*ring\b/i;
export const DEMO_ROLEPLAY_END = /\bhow was that\b/i;
/**
 * The questions that open the talk after the role-play, which also start it
 * when they skip the role-play or ask about price first: what they are
 * after, or how many calls they get.
 */
export const DEMO_PITCH_START = /\bhow many calls\b|\bwhat made you\b/i;

/**
 * The stage after a reply: moved on only by the scripted line that opens the
 * next one. A role-play may be skipped (straight to the pitch's first
 * question) or run again from the pitch ("Ring ring!" once more).
 */
export function nextDemoStage(stage: DemoStage, reply: string): DemoStage {
  if (stage !== "roleplay" && DEMO_ROLEPLAY_START.test(reply)) return "roleplay";
  if (stage === "roleplay" && DEMO_ROLEPLAY_END.test(reply)) return "pitch";
  if (stage === "intro" && DEMO_PITCH_START.test(reply)) return "pitch";
  return stage;
}

/**
 * The questions a demo asks, in order: who they are and what they want from
 * the call, then, after the role-play, what they are after before anything
 * is sold (owner, 25 October 2026: "before getting into selling healdesk to
 * us she should ask questions, to understand what the caller is after").
 */
export type DemoQuestion = "role" | "choice" | "goal" | "volume" | "volumeCheck" | "missed" | "coverage" | "tiedown" | "ask";

/**
 * The pitch, in the owner's order (25 October 2026), each said once: tie to
 * their pain, the reveal, keeping their number, what is not finished yet
 * with the discount, the cost anchor, value in their terms, one package, no
 * commitment, and the refund. Tracked from Aya's own words (BEAT_WORDS), so
 * the note names the next beat and never has her say one twice.
 */
export type DemoBeat = "pain" | "reveal" | "number" | "finish" | "anchor" | "value" | "recommend" | "noStrings" | "refund";

export const DEMO_BEATS: readonly DemoBeat[] = ["pain", "reveal", "number", "finish", "anchor", "value", "recommend", "noStrings", "refund"];

/**
 * What a demo call has found out, kept by the session from Aya's own
 * questions and the caller's next words (owner's test call, 25 October 2026:
 * "she doesn't remember anything I say previously so it makes the caller
 * repeat itself"): Aya asked "how many calls do you get a day?" three times
 * after hearing "Five". Each stage's note lists what was answered, never to
 * be asked again, and says which step is next, so the note itself never
 * asks for something the caller already said. In memory for the call only,
 * like the rest of a demo call: the words of a clinic's team member about
 * their business, never a patient's.
 */
export type DemoProgress = {
  /** The question Aya's last reply asked, which the caller's next words answer. */
  asked: DemoQuestion | null;
  /** What the caller said back to each question, in their own words. */
  answers: Partial<Record<DemoQuestion, string>>;
  /** The caller's turns inside the role-play being run. */
  roleplayTurns: number;
  /** The pitch's beats already said (DemoBeat). */
  said: readonly DemoBeat[];
};

export const DEMO_START_PROGRESS: DemoProgress = { asked: null, answers: {}, roleplayTurns: 0, said: [] };

/** How Aya's scripted questions read, in her own replies (demoStageNote words each one). */
const QUESTION_WORDS: readonly (readonly [DemoQuestion, RegExp])[] = [
  ["role", /\b(?:what'?s|what is) your role\b|\bwhat do you do (?:at|there)\b/i],
  ["choice", /\bor jump straight into\b|\bquick role-?play\b/i],
  ["goal", /\bwhat made you\b|\bwhat (?:are|were) you hoping\b|\bbiggest (?:headache|challenge|problem)\b|\bwhat would make (?:it|this|that) convincing\b/i],
  ["volume", /\bhow many calls\b/i],
  ["volumeCheck", /\bfair to say\b/i],
  ["missed", /\bwhat happens (?:to|with)\b/i],
  ["coverage", /\bhow do you see me helping\b|\bafter[- ]hours(?: calls)? only\b/i],
  ["tiedown", /\bstop you from\b/i],
  ["ask", /\bset up\?|\bget (?:started|going)\?/i],
];

/** How each pitch beat reads in Aya's own replies (demoStageNote words each one). */
const BEAT_WORDS: Readonly<Record<DemoBeat, RegExp>> = {
  pain: /\bthe ones I'?d be picking up\b|\bthose are the ones\b/i,
  reveal: /\bhaven'?t seen on this call\b|\bevery way a patient\b|\bbilingual\b/i,
  number: /\bkeep your (?:own )?number\b/i,
  finish: /\bquick read of your\b|\bpart of what I can do\b/i,
  anchor: /\breceptionist\b|\banswering services?\b/i,
  value: /\bon your books\b/i,
  recommend: /\blooks like the (?:right )?fit\b/i,
  noStrings: /\bno strings\b/i,
  refund: /\brefund/i,
};

/** The beats a reply says. */
export function demoBeatsSaid(reply: string): DemoBeat[] {
  return DEMO_BEATS.filter((beat) => BEAT_WORDS[beat].test(reply));
}

/** Answers longer than this are cut: what is kept is a reminder, not a record. */
const ANSWER_MAX = 200;

/** The scripted question a reply asks, the last one it asks; null when it asks none, or asks no question at all. */
export function demoQuestionAsked(reply: string): DemoQuestion | null {
  if (!reply.includes("?")) return null;
  let found: DemoQuestion | null = null;
  let at = -1;
  for (const [question, words] of QUESTION_WORDS) {
    const m = words.exec(reply);
    if (m && m.index > at) {
      found = question;
      at = m.index;
    }
  }
  return found;
}

/** The progress with the caller's latest words taken as the answer to what was asked, and counted in a role-play. */
export function withDemoAnswer(progress: DemoProgress, stage: DemoStage, words: string): DemoProgress {
  const answers = progress.asked ? { ...progress.answers, [progress.asked]: words.trim().slice(0, ANSWER_MAX) } : progress.answers;
  return { ...progress, answers, roleplayTurns: stage === "roleplay" ? progress.roleplayTurns + 1 : progress.roleplayTurns };
}

/** The progress once a reply is said: what it asked, and a fresh count for a role-play it starts. */
export function afterDemoReply(progress: DemoProgress, stageBefore: DemoStage, stageAfter: DemoStage, reply: string): DemoProgress {
  const beats = stageBefore === "pitch" && stageAfter === "pitch" ? demoBeatsSaid(reply).filter((b) => !progress.said.includes(b)) : [];
  return {
    ...progress,
    asked: stageAfter === "roleplay" ? null : demoQuestionAsked(reply),
    roleplayTurns: stageAfter === "roleplay" && stageBefore !== "roleplay" ? 0 : progress.roleplayTurns,
    said: beats.length > 0 ? [...progress.said, ...beats] : progress.said,
  };
}

/** The caller's turns after which a role-play is wrapped up in the next reply, whatever is left. */
export const ROLEPLAY_MAX_TURNS = 4;

const ANSWER_LABELS: Readonly<Record<DemoQuestion, string>> = {
  role: "their role",
  choice: "hear more or a role-play",
  goal: "what they are after",
  volume: "calls a day",
  volumeCheck: "the weekly and monthly calls you checked",
  missed: "what happens to after-hours and busy calls now",
  coverage: "how they want you to help",
  tiedown: "when you asked what would stop them getting it running today",
  ask: "when you asked them to get set up",
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
 * What the model is told on each turn of a demo call (turn.ts, `notes`), for
 * the stage it is in and what the call has found out (DemoProgress). Shaped
 * around the guard, which reads every word as on any call: "your patients",
 * because "our patients" or "another patient" reads as another patient
 * spoken of (guard.ts, mentionsOtherParty); nothing about how the facts were
 * learnt, which a clinic's own Aya never says either; a number of calls
 * always followed by the word "calls", which the guard's dose-like-figure
 * pattern leaves alone; claims as the launch tracker allows (CLAUDE.md,
 * "Copy first, then the switch": what Aya is built to do, deposit links only
 * in chat); healdesk's prices only after the role-play, from the catalog
 * (demoPriceList), and a close on the demo page's own buy button, since Aya
 * can send nothing.
 *
 * The note says which step is next, from what was answered, rather than
 * listing every step for the model to keep track of: a list read afresh each
 * turn, after the conversation, had Aya ask its second step again after it
 * was answered (owner's test call, 25 October 2026).
 */
export function demoStageNote(
  context: Pick<DemoCallContext, "firstName" | "clinic" | "offer" | "buyButton" | "mode">,
  stage: DemoStage,
  now: number,
  progress: DemoProgress = DEMO_START_PROGRESS,
): string {
  const clinic = context.clinic.clinicName;
  const who = context.firstName ?? "the caller";
  const opener = demoRoleplayOpener(clinic);
  const known = knownLine(progress);
  const a = progress.answers;
  const goalQuestion = `"What made you want to look at an AI assistant for ${clinic}?"`;
  if (stage === "intro") {
    const next = !a.role
      ? `Next: once they confirm who they are, greet them by name in a few words and ask their role at ${clinic} ("Great to meet you! What's your role at ${clinic}?").`
      : !a.choice
      ? `Next: react to their role in a few natural words (never congratulate them, and don't repeat their title back), then ask, close to these words: "Would you like to hear what I can do for ${clinic}, or jump straight into a quick role-play where you call in as a patient?"`
      : `Next: do what they chose. If they want to hear more, say in two or three short spoken sentences that you answer ${clinic}'s calls in English and Spanish whenever the front desk can't get to the phone, know its treatments, prices, hours and policies, take booking requests, handle urgent calls safely and pass anyone who wants a person to the team; name one real detail you know about ${clinic} (never mention a website, scraping or how you learned anything); then offer the role-play. If they want the role-play, or leave it to you ("whatever's best"), start it in this same reply: one short handover ("Let's do it, you be the patient.") and then exactly: "${opener}"`;
    return [
      `This call is a live demo for ${who}, who is on ${clinic}'s team and asked to hear you at work. ${NAME_RULE} You opened by saying who you are and asking who you are speaking with.`,
      ...(known ? [known] : []),
      next,
      `Whenever they want the role-play, start it in the same reply, never a later one, with exactly: "${opener}" Then they play one of your patients and you answer as ${clinic}'s front desk. Say "your patients", never "our patients" or "another patient".${context.clinic.services.length === 0 ? ` ${clinic}'s treatments and prices are not on file, so if they are unsure what to ask, suggest what callers ask first: the hours, where it is, or booking a consultation.` : ""}`,
      `If they would rather skip the role-play, or ask about price or getting started, find out what they need first, by asking: ${goalQuestion}`,
      `One short question a turn. ${PROFESSIONAL}`,
    ].join("\n");
  }
  if (stage === "roleplay") {
    return [
      `The role-play is on: ${who}, of ${clinic}'s team, is playing a patient calling ${clinic}, and you are Aya at its front desk. ${NAME_RULE} Stay fully in character and answer exactly as you would a real caller; step out only if they clearly talk to you as themselves.`,
      `Keep it brisk, the way a quick, capable front desk sounds: one or two short sentences a turn. Give a real answer to what they ask; if they are unsure what to book, name one or two treatments from the list that suit what they want (no price that is not on the list, and never a figure they said) and offer a consultation. To take a booking request, ask only for the treatment and a preferred day and time, then say in one sentence that the team will confirm the time. Ask for nothing else, and never ask "anything else?".`,
      `As soon as the request is taken or their question is answered, wrap up in that same reply: a short in-character goodbye, then step out of character with exactly: "And that's the role-play! So, how was that?"`,
      ...(progress.roleplayTurns >= ROLEPLAY_MAX_TURNS ? [`The role-play has run long enough: wrap it up in this reply, as above.`] : []),
      `Never set "end" to true during the role-play: the demo carries on after it.`,
    ].join("\n");
  }
  const days = demoOpenDays(context);
  const offer = offerLine(context.offer, now);
  const discount = liveDiscount(context.offer, now);
  const prices = demoPriceList(context.offer, now).line;
  const example = examplePrice(context);
  const button = context.buyButton?.replace(/\bAYA\b/g, "Aya") ?? null;
  const discountWords = discount ? `${discount.percent}% off the setup fee, for the next ${discount.hours} hour${discount.hours === 1 ? "" : "s"}` : null;
  const close = button
    ? `Close on the button on their demo page: "${button}" opens checkout${discount ? " with their discount already applied" : ""}, for example "Just tap ${button} at the top of your demo page${discount ? `, and your ${discount.percent}% off the setup fee is already applied, for the next ${discount.hours} hour${discount.hours === 1 ? "" : "s"}` : ""}."`
    : `Tell them the healdesk team will help them get started.`;
  const volumeCheck = days
    ? `Check the total with them, close to these words: "I see you're open ${days} days a week, so would it be fair to say about [their calls a day times ${days}] calls a week, or around [that times four, plus a third, rounded to a friendly number] calls a month?" Do the arithmetic right, and always say the word "calls" straight after a number of calls.`
    : null;
  // The owner's pitch (25 October 2026), each beat in close-to-these-words
  // form, as the launch tracker allows it (CLAUDE.md, "Copy first, then the
  // switch"): direct booking and the chat deposit link are still being
  // built, so both are what she is designed to do; the refund is the terms'
  // own (FIRST_PERIOD_REFUND_DAYS, terms section 5) and the setup fee is
  // never refunded; the discount is the live one checkout applies, never a
  // fixed figure.
  const beatLines: Record<DemoBeat, string> = {
    pain: `Tie it to their pain, in their own numbers and words: "So those [the calls they said go missed, as a number a month if they gave one] that go to voicemail after hours, those are the ones I'd be picking up."`,
    reveal: `The reveal: "Here's what you haven't seen on this call: I answer 24/7, bilingual, English and Spanish, and it's not just the phone. The same me is built to cover your website chat, Instagram, Messenger and WhatsApp. One assistant, every way a patient reaches you."`,
    number: `Take away the fear of switching: "And you keep your own number: your calls just forward to me, nothing to switch."`,
    finish: `What is not finished yet${discount ? ", and the discount, together" : ""}: "Right now I'm working off a quick read of your public website, so you're only seeing part of what I can do. Finishing it takes about fifteen minutes of your time: we connect your calendar and your real menu, and from then on I work from your actual systems and I'm designed to book straight into your calendar, not just take a request."${discountWords ? ` Then: "And there's a real discount on finishing it right now: ${discountWords}."` : ""}`,
    anchor: `A light cost anchor, once: "For context, a full-time receptionist runs ${usd(MARKET_ANCHORS_USD.receptionistFrom)} to ${usd(MARKET_ANCHORS_USD.receptionistTo)} a month loaded, and most answering services are ${usd(MARKET_ANCHORS_USD.answeringFrom)} to ${usd(MARKET_ANCHORS_USD.answeringTo)} and still can't book or quote your menu."`,
    value: `Value in their terms, never revenue: ${example ? `"Every one of those calls that turns into a booking is, say, a ${example.name} on your books at ${usd(example.price)}. Can't promise you a number, but that's the shape of it."` : `"Every one of those calls that turns into a booking is one more appointment on your books. Can't promise you a number, but that's the shape of it."`} Once: "And in your website chat and messages I'm designed to send your own deposit link while they book, which helps with no-shows." Never call it revenue, profit or money they will make.`,
    recommend: `Recommend one package from what they told you: "Based on what you've told me, [Aya Voice, Aya Web Chat, Aya Meta Chat, Voice plus Web Chat, or Voice plus Meta Chat] at [the step of 100 that covers their volume] looks like the fit." Quote its price from the list below only if they ask or it helps.`,
    noStrings: `No commitment: "You've already tried it, no strings attached."`,
    refund: `Risk reversal, exactly this and nothing more generous: "And if it's not a fit once you're live, cancel within your first ${FIRST_PERIOD_REFUND_DAYS} days and your first subscription period is refunded in full. The setup fee is the only part that's firm, since that's your setup getting built and checked."`,
  };
  const nextBeat = DEMO_BEATS.find((beat) => !progress.said.includes(beat)) ?? null;
  const pitch = [
    `The pitch, in this order, one or two short beats a turn, reacting to anything they say before going on, each beat said once:`,
    ...DEMO_BEATS.map((beat, i) => `${i + 1}. ${beatLines[beat]}${progress.said.includes(beat) ? " (said: never again)" : ""}`),
    ...(context.mode === "browser" ? ["Mention once that they can try you in chat too, right there on their demo page."] : []),
  ].join("\n");
  const discovered = Boolean(a.goal && a.volume && (!volumeCheck || a.volumeCheck) && a.missed && a.coverage);
  const next = !a.goal
    ? `Next: take their reaction to the role-play in a few words (if they are unsure or not convinced, ask what would make it convincing for them), then find out what they are after: ${goalQuestion}`
    : !a.volume
    ? `Next: react to what they said in a few words, then ask: "Generally, how many calls do you get a day?"`
    : volumeCheck && !a.volumeCheck
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
    ? `Next: if something holds them back, answer that one thing in a sentence and ask the tie-down once more in other words; then ask for it plainly: "Want to get ${clinic} set up?"`
    : `Next: if they said yes, ${close.charAt(0).toLowerCase()}${close.slice(1)} If they hesitate, ask what is holding them back, answer that one thing and ask once more.`;
  return [
    `The role-play is over: you are talking with ${who}, of ${clinic}'s team, as themselves again. ${NAME_RULE}`,
    ...(known ? [known] : []),
    `Find out what they need before you sell anything: one short question a turn, a few words reacting to each answer before the next, and no pitch until the questions are answered. If they ask about price, what you do or how to start before then, answer that briefly and come back to the next question. If they want the package now, skip the rest of the questions and go to the pitch.`,
    next,
    ...(discovered || nextBeat !== DEMO_BEATS[0] ? [pitch] : []),
    `Close: "Want to get ${clinic} set up?" ${close}${discountWords ? ` Say the discount exactly so: ${discountWords}.` : ""}`,
    `If they are still hesitant, or ask to speak to a person: "No problem at all. Whenever you're ready, ${button ? `${button} is right there on your demo page` : "the healdesk team can get you started"}, and you can reach the team at hello at healdesk dot io if you'd like to talk it through."${discountWords ? " Mention the discount window once." : ""} Then thank them and say a warm goodbye. Never offer a call-back, never take a phone number for one, and never say the team has been told or will call: nothing on this call reaches them.`,
    `Never say you will send a link, an email or a text, and never take payment details on the call. Deposit links go only in website chat or social messages, never on a call and never by text message.`,
    `True answers to the usual doubts, in a sentence each: patients minding an AI (you say you are an AI in your first line, and anyone who wants a person gets passed to the team); patient data ("We sign a business associate agreement and handle patient data under it", never "HIPAA compliant"); setup (about fifteen minutes of their attention; phone goes live once they set up call forwarding on their own line, so they keep their number; website chat once a snippet is on their site); mistakes (you never diagnose or quote a price that is not on their list, urgent calls go straight to their team, and if anything fails, calls go to their own direct line); cost (the monthly price only starts once you are answering their patients).`,
    prices,
    ...(offer ? [offer] : []),
    `If they want to try another role-play, start it the same way: "${opener}"`,
    PROFESSIONAL,
  ].join("\n");
}

/**
 * The facts for a demo's pitch stage: its facts with healdesk's own prices
 * the guard may let through (demoPriceList). Only in the pitch: in the intro
 * and the role-play a made-up treatment price that happened to match one of
 * healdesk's would otherwise pass.
 */
export function demoPitchFacts(facts: AssistantFacts, context: Pick<DemoCallContext, "offer">, now: number): AssistantFacts {
  return { ...facts, quotedAmountsUsd: [...demoPriceList(context.offer, now).amounts, ...Object.values(MARKET_ANCHORS_USD)] };
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
