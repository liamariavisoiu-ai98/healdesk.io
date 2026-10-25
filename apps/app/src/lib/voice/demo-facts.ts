import {
  DEMO_CALL_VARIABLE,
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
  if (!offer || offer.endsAt <= now) return null;
  const hoursLeft = Math.max(1, Math.round((offer.endsAt - now) / 3_600_000));
  // "hours left", not "more hours": with a word between the number and the
  // unit, the guard's own dose-like-figure pattern (guard.ts, PLAIN_CLINICAL)
  // reads "about 10 more hours" as a figure it cannot place and refuses the
  // whole sentence as clinical. "about 10 hours left" keeps the unit right
  // after the number, which that pattern already knows to leave alone.
  return `A real, live discount applies right now: ${offer.percentOfSetupFee}% off healdesk's setup fee, with about ${hoursLeft} hour${hoursLeft === 1 ? "" : "s"} left on it, already applied at checkout. Say that percentage, that rough window and the discounted setup fees given here, and never a different number or a different amount of time.`;
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
/** The pitch's first question, which also starts it when they skip the role-play or ask about price first. */
export const DEMO_PITCH_START = /\bhow many calls\b/i;

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
 * the stage it is in. Shaped around the guard, which reads every word as on
 * any call: "your patients", because "our patients" or "another patient"
 * reads as another patient spoken of (guard.ts, mentionsOtherParty); nothing
 * about how the facts were learnt, which a clinic's own Aya never says
 * either; a number of calls always followed by the word "calls", which the
 * guard's dose-like-figure pattern leaves alone; claims as the launch
 * tracker allows (CLAUDE.md, "Copy first, then the switch": what Aya is
 * built to do, deposit links only in chat); healdesk's prices only in the
 * pitch, from the catalog (demoPriceList), and a close on the demo page's own
 * buy button, since Aya can send nothing.
 */
export function demoStageNote(
  context: Pick<DemoCallContext, "firstName" | "clinic" | "offer" | "buyButton" | "mode">,
  stage: DemoStage,
  now: number,
): string {
  const clinic = context.clinic.clinicName;
  const who = context.firstName ?? "the caller";
  const opener = demoRoleplayOpener(clinic);
  if (stage === "intro") {
    return [
      `This call is a live demo for ${who}, who is on ${clinic}'s team and asked to hear you at work. ${NAME_RULE} You opened by saying who you are and asking who you are speaking with.`,
      `Go one step at a time, one short question a turn, and skip any step they have already answered:`,
      `1. Once they confirm who they are, greet them warmly by name and ask their role at ${clinic} ("Great to meet you, ${context.firstName ?? "there"}! What's your role at ${clinic}?").`,
      `2. Once they say, react to it in a few words, then say, close to these words: "Awesome, look, I'll keep this super brief. Would you like to hear what I can do for ${clinic} and how that helps your team, or jump straight into a quick role-play to see how I handle a live patient call?"`,
      `3. If they want to hear more: in two or three short spoken sentences, say you answer ${clinic}'s calls in English and Spanish whenever the front desk can't get to the phone, know its treatments, prices, hours and policies, take booking requests, handle urgent calls safely and pass anyone who wants a person to the team; name one or two real details you know about ${clinic} (never mention a website, scraping or how you learned anything); then offer the role-play.`,
      `4. When they want the role-play, start it by saying exactly: "${opener}" Then they play one of your patients and you answer as ${clinic}'s front desk. Say "your patients", never "our patients" or "another patient".${context.clinic.services.length === 0 ? ` ${clinic}'s treatments and prices are not on file, so if they are unsure what to ask, suggest what callers ask first: the hours, where it is, or booking a consultation.` : ""}`,
      `If they would rather skip the role-play, or ask about price or getting started, move on to the pitch by asking: "Generally, how many calls do you get a day?"`,
      PROFESSIONAL,
    ].join("\n");
  }
  if (stage === "roleplay") {
    return [
      `The role-play is on: ${who}, of ${clinic}'s team, is playing a patient calling ${clinic}, and you are Aya at its front desk. ${NAME_RULE} Stay fully in character and answer exactly as you would a real caller; step out only if they clearly talk to you as themselves. Keep in mind everything said earlier, their name included.`,
      `As soon as the patient has what they called for (a booking request taken, or their questions answered), wrap the role-play up yourself in the same reply: one short in-character goodbye, then step out of character with exactly: "Ok, how was that? Haha!" That is the one laugh you are asked to say.`,
      `Never set "end" to true during the role-play: the demo carries on after it.`,
    ].join("\n");
  }
  const days = demoOpenDays(context);
  const offer = offerLine(context.offer, now);
  const prices = demoPriceList(context.offer, now).line;
  const example = examplePrice(context);
  const button = context.buyButton?.replace(/\bAYA\b/g, "Aya") ?? null;
  const close = button
    ? `Close on the button on their demo page: "${button}" opens checkout${offer ? " with their discount already applied" : ""}, for example "Just tap ${button} at the top of your demo page${offer ? ` and your ${context.offer!.percentOfSetupFee}% is already applied` : ""}."`
    : `Tell them the healdesk team will help them get started.`;
  const volume = days
    ? `When they give a number, say, close to these words: "I see you're open ${days} days a week, so would it be fair to say about [their number times ${days}] calls a week, or around [that times four, plus a third, rounded to a friendly number] calls a month?"`
    : `When they give a number, ask how many days a week they are open, then check the total with them, close to these words: "So would it be fair to say about [calls a day times days open] calls a week, or around [that times four, plus a third, rounded to a friendly number] calls a month?"`;
  return [
    `The role-play is over: you are talking with ${who}, of ${clinic}'s team, as themselves again. ${NAME_RULE} Keep in mind everything said earlier, their name included.`,
    `Go one step at a time, one short question a turn, and react to what they say before moving on:`,
    `1. Take their reaction to the role-play warmly, then make the point, close to these words: "I'm built to do that 24/7, on the phone and in your website chat, Instagram, Messenger and WhatsApp: taking bookings, sending your own deposit link in chat, and answering patient questions automatically." Deposit links go only in website chat or social messages, never on a call and never by text message.${context.mode === "browser" ? " Mention once that they can try you in chat too, right there on their demo page." : ""}`,
    `2. Ask: "Generally, how many calls do you get a day?"`,
    `3. ${volume} Do the arithmetic right, and always say the word "calls" straight after a number of calls ("about 100 calls a week").`,
    `4. Ask: "What happens with after-hours calls, or when your team's busy with patients?"`,
    `5. Ask: "How do you see me helping you best: after-hours calls only, taking over when the lines are busy, or handling all your incoming calls?"`,
    `6. Recommend the one package that fits what they told you (Aya Voice, Aya Web Chat, Aya Meta Chat, Voice plus Web Chat, or Voice plus Meta Chat) and the step that covers their volume, in a sentence that ties it to their own words ("so the after-hours calls stop going to voicemail").${example ? ` If it helps, put a value on it in ${clinic}'s own terms: each of those calls that becomes a booking is, say, a ${example.name} on their books at ${usd(example.price)}. Never call it revenue, profit or money they will make, and never promise a number of bookings.` : ""}`,
    `7. Then ask for it plainly, once: "Want to get ${clinic} set up?" ${close} If they hesitate, ask what is holding them back, answer that one thing, and ask once more; if they are still not ready, thank them warmly, mention the discount window once if there is one, and say goodbye. Never say you will send a link, an email or a text, and never take payment details on the call.`,
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
  return { ...facts, quotedAmountsUsd: demoPriceList(context.offer, now).amounts };
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
