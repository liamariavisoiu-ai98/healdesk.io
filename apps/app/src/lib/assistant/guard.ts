import { findClinicalContent, messageLanguage } from "@healdesk/catalog";

import type { AssistantFacts } from "./facts";

/**
 * The deterministic checks around the model on a call or a web chat
 * (CLAUDE.md, "Guardrails": enforced in code around the model, never left to
 * a prompt).
 *
 * Inbound, before the model: a card number is cut out of what the person
 * said, so it reaches neither the model nor the transcript email, and they
 * are told why (cardNumberIn). One read out across turns is cut where the
 * transcript is assembled (cutCardNumbersAcrossTurns).
 *
 * Outbound, after the model, a reply is refused when it:
 *   - says anything on the never-say list (the clinic's own and the defaults);
 *   - names a dollar amount that is not one of the clinic's configured prices
 *     or deposits, written or said in words (amountsIn): an off-menu price
 *     becomes the offer of a consultation;
 *   - asks for card or bank details;
 *   - calls the practice or healdesk "HIPAA compliant";
 *   - says anything clinical: the catalog's findClinicalContent, the default
 *     screen (safety, risks, dosing, candidacy, a diagnosis or a symptom,
 *     recovery, medication, a condition, a guarantee), the post-model half of
 *     the guardrail the Meta front door has had since September. Not Meta's
 *     everyday skin and hair conditions: a call and a web chat are covered
 *     by the clinic's agreement, and a med spa's menu is made of them. The
 *     clinic's own service names are read past, because they were screened
 *     for its specialty when they were saved (a vet's "Senior diagnostics"
 *     is a service, not a diagnosis), and so are its address and the
 *     questions its booking requirements ask. The everyday words the screen
 *     would misread are read past as well ("parking is free and safe",
 *     "bring a list of any medications", "Unit 4"). And, beside the screen,
 *     the plain words a model uses to give clinical advice without the
 *     vocabulary (PLAIN_CLINICAL): aftercare and side effects called normal,
 *     outcome claims, triage, and a dose given as a bare number. A clinical
 *     reply becomes the offer of a consultation;
 *   - is written in a language the screens do not read (messageLanguage):
 *     English and Spanish are screened, any other is not sent;
 *   - claims to be a person, or not to be an AI ("I'm a real person", "I'm
 *     not a bot", "you're talking to Sarah at the front desk", "soy una
 *     persona real"), in any reply on any channel (claimsToBeHuman): the
 *     opening line says an AI assistant is answering, and nothing after it
 *     may say otherwise;
 *   - says a booking is made, or that the assistant is making one ("you're
 *     booked", "confirmed for Tuesday", "I'll book you in"), on a turn where
 *     the tool layer wrote no booking (ReplyTurn, confirmsBooking). The
 *     model never words a booking: when the tool layer books, its own fixed
 *     line is said instead of the model's reply (turn.ts, booking-tools.ts),
 *     so a model's reply that says a booking is made is always refused;
 *   - promises contact after the conversation: the assistant texting,
 *     calling, emailing, reminding or following up, or any text or reminder
 *     at all (promisesOutbound). v1 is inbound only; the team getting back
 *     to someone within a day is the one promise, and it passes;
 *   - says the team has been told or alerted, when no alert is queued for
 *     the turn (claimsAlert, ReplyTurn.alertQueued);
 *   - speaks of another patient, or compares the practice with another
 *     (mentionsOtherParty).
 * A refused reply is replaced by a fixed line; nothing of it is sent.
 *
 * The limit of the never-say list: its entries are the clinic's own words,
 * matched as written, from the start of a word, case and accents aside,
 * excused only where they fall wholly inside the clinic's own name or
 * address and never when they name it themselves (neverSayIn). The stock
 * entries (the defaults and the ones clinics most often add) are matched in
 * Spanish too, through a fixed map (NEVER_SAY_SPANISH); a clinic's own entry
 * with no mapping is matched as written only, so a Spanish reply that says
 * it in Spanish is not refused for it, and the clinical screen, which reads
 * Spanish, is what catches a Spanish promise of safety or results. No entry
 * may stop the assistant saying it is an AI assistant, or pointing to 911
 * (NEVER_SAY_PROTECTED).
 *
 * Spanish is read by every rule above, with its own patterns beside the
 * English ones (21 October 2026: the measured gaps, each now a test in
 * tests/assistant.test.ts, "the guard in Spanish"), and a refused reply in
 * Spanish is replaced by the same fixed line in Spanish (guardedLine).
 */

export type GuardRefusal =
  | "never_say"
  | "price"
  | "payment_details"
  | "hipaa_claim"
  | "clinical"
  | "language"
  | "booking_confirmation"
  | "human_claim"
  | "outbound_promise"
  | "alert_claim"
  | "other_party"
  | "empty";

export type GuardVerdict = { ok: true } | { ok: false; reason: GuardRefusal };

/**
 * What the tool layer did on the turn the reply answers. A reply may say a
 * booking is made only on a turn where the tool layer wrote one (CLAUDE.md:
 * bookings are written only by the fixed tool layer, and the slot is held
 * before anything confirming is said). turn.ts passes the model's own words
 * with bookingWritten false on every turn: the tool layer's booked line
 * (booking-tools.ts) replaces them rather than passing through here.
 *
 * alertQueued: an alert to the clinic's team is already queued for this
 * turn. turn.ts never says so, because the guard runs before any adapter
 * queues one (web-chat.ts, retell.ts raise the alert after the reply is
 * chosen), so a model's "I've told the team" is always refused; the urgent
 * reply's own line is the catalog's, held to facts.urgentAlertsReady.
 */
export type ReplyTurn = { bookingWritten?: boolean; alertQueued?: boolean };

function normalise(text: string): string {
  return text
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[‐‑‒–—]/g, "-")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

/** Every amount a reply may name: the configured prices and deposits. */
function allowedAmounts(facts: Pick<AssistantFacts, "services" | "quotedAmountsUsd">): Set<number> {
  const amounts = new Set<number>();
  for (const s of facts.services) {
    for (const v of [s.priceFromUsd, s.priceToUsd, s.depositUsd]) {
      if (typeof v === "number" && Number.isFinite(v)) amounts.add(Math.round(v * 100));
    }
  }
  // A demo's pitch: healdesk's own catalog prices, each exactly (demo-facts.ts).
  for (const v of facts.quotedAmountsUsd ?? []) {
    if (Number.isFinite(v)) amounts.add(Math.round(v * 100));
  }
  return amounts;
}

const DOLLARS = /\$\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?(\s?k\b)?/gi;
const SPOKEN_DOLLARS = /\b(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?\s?(?:dollars|usd|bucks|d[oó]lares)(?![\p{L}])/giu;

// -----------------------------------------------------------------------------
// Amounts said in words
// -----------------------------------------------------------------------------
//
// The voice prompt asks for numbers the way a person says them aloud
// (prompt.ts), so a price on a call is as likely to be "two hundred dollars"
// or "a hundred and fifty" as "$200". Each form below is a price the guard
// reads, and checks against the menu like any other:
//
//   - number words before "dollars" or "bucks", with any "and fifty cents"
//     after ("two hundred dollars", "a hundred and fifty dollars", "one
//     fifty dollars", "twelve dollars and fifty cents");
//   - a number with "hundred" or "thousand" in it, with no currency word,
//     where it ends a clause or runs on into one ("the consultation is a
//     hundred and fifty", "two hundred, or three with the deposit"), and not
//     where a noun follows ("a hundred reviews", "two hundred clients"), a
//     room or a suite leads ("suite two hundred"), or it is a time of the
//     twenty-four hour clock ("we close at seventeen hundred");
//   - a number, in digits or words, said by the unit ("twelve a unit", "12
//     per unit", "six hundred a syringe");
//   - Spanish number words, read the same ways (spanishAmounts): before
//     "dólares", by the unit, and with "cien", "-cientos" or "mil" in them
//     ("cuesta ciento cincuenta", "son doscientos").
//
// A bare number with none of these ("it's fifty") is not read: it is as often
// a count or a time as a price, and the prompt asks for prices as listed.

const ONES: Readonly<Record<string, number>> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18, nineteen: 19,
};
const TENS: Readonly<Record<string, number>> = {
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};
/** One number word, whole: the longest spellings first, so "fourteen" is never read as "four". */
const NUMBER_WORD = `(?:${[...Object.keys(ONES), ...Object.keys(TENS), "hundred", "thousand", "and", "a"]
  .sort((a, b) => b.length - a.length)
  .join("|")})(?![\\p{L}])`;
/** A run of number words, hyphens or spaces between: "one hundred and fifty", "twenty-five". */
const NUMBER_RUN = `${NUMBER_WORD}(?:[\\s-]+${NUMBER_WORD})*`;

/**
 * A run of number words as a number: "one hundred and fifty" → 150, "a
 * thousand" → 1000, "twenty-five" → 25. Said the way prices are said aloud,
 * with the hundred left out, too: "one fifty" → 150, "two ninety-nine" →
 * 299, "twelve fifty" → 1250. Null when the words are not one number ("one
 * five", "ninety and a hundred"). "A" counts only as the first word, before
 * "hundred" or "thousand".
 */
export function wordsToNumber(words: string): number | null {
  const parts = words
    .toLowerCase()
    .split(/[\s-]+/)
    .filter((w) => w && w !== "and");
  if (parts.length === 0) return null;
  let total = 0; // the thousands
  let hundreds = 0; // the hundreds of the group being read
  let small: number | null = null; // below a hundred, being read
  let last: "unit" | "teen" | "tens" | "magnitude" | null = null;
  let elided = false;
  let seen = false;
  for (const [i, part] of parts.entries()) {
    if (part === "a") {
      const next = parts[i + 1];
      if (i !== 0 || (next !== "hundred" && next !== "thousand")) return null;
      small = 1;
      last = "unit";
      continue;
    }
    if (part in ONES || part in TENS) {
      const value = (ONES[part] ?? TENS[part])!;
      const kind = part in TENS ? "tens" : value >= 10 ? "teen" : "unit";
      seen = true;
      if (small === null) {
        small = value;
      } else if (last === "tens" && kind === "unit" && value > 0) {
        small += value; // "twenty five"
      } else if (kind !== "unit" && hundreds === 0 && total === 0 && !elided && last !== "magnitude") {
        // "one fifty", "two ninety-nine", "twelve fifty": the hundred left out.
        hundreds = small * 100;
        small = value;
        elided = true;
      } else {
        return null;
      }
      last = kind;
      continue;
    }
    if (part === "hundred") {
      if (elided || hundreds !== 0) return null;
      hundreds = (small ?? 1) * 100;
      small = null;
      last = "magnitude";
      seen = true;
      continue;
    }
    if (part === "thousand") {
      if (elided) return null;
      total += (hundreds + (small ?? 0) || 1) * 1000;
      hundreds = 0;
      small = null;
      last = "magnitude";
      seen = true;
      continue;
    }
    return null;
  }
  return seen ? total + hundreds + (small ?? 0) : null;
}

/** A run read as a number, or, failing that, without a leading "a" or "and" ("a fifty dollar deposit"). */
function runValue(run: string): number | null {
  return wordsToNumber(run) ?? wordsToNumber(run.replace(/^\s*(?:a|and)[\s-]+/i, ""));
}

const WORD_DOLLARS = new RegExp(
  `(?<![\\p{L}])(${NUMBER_RUN})\\s+(?:dollars?|bucks)(?![\\p{L}])(?:\\s+and\\s+(${NUMBER_RUN})\\s+cents?(?![\\p{L}]))?`,
  "giu",
);
const PER_UNIT = new RegExp(
  `(?<![$\\d.,\\p{L}])(\\d{1,3}(?:,\\d{3})+|\\d+(?:\\.\\d{1,2})?|${NUMBER_RUN})\\s+(?:a|an|per|each|every)\\s+(?:units?|syringes?|vials?|ml|areas?)(?![\\p{L}])`,
  "giu",
);
const MAGNITUDE_RUN = new RegExp(`(?<![\\p{L}])${NUMBER_RUN}`, "giu");
/** What may follow a number said as a price with no currency word: the end of a clause, or a word that runs on. */
const PRICE_ENDS = /^(?:\s*$|\s*[.,;:!?)\]—–]|\s+-\s|\s+(?:for|per|a|an|each|every|to|and|or|with|plus|including|depending|if|but|so|up|total|altogether)(?![\p{L}]))/iu;
/** What leads a number that is a place, not a price. */
const PLACE_LEADS = /(?:\b(?:room|suite|ste|unit|apt|apartment|floor|level|building|bldg|number|no\.?|highway|route|interstate|exit)|#)\s*$/i;
/** A time word before a number: an hour of the twenty-four hour clock said as "seventeen hundred". */
const TIME_LEADS = /\b(?:at|until|till|til|by|after|before|around|from|between|and)\s+$/i;
const PRICE_AT = /\b(?:priced|starts?|starting|comes? in|runs?|costs?|charged|billed|is|it['’]s|that['’]s)\s+at\s+$/i;
const CLOCK_HUNDRED =
  /^(?:(?:oh|zero)[\s-]+(?:one|two|three|four|five|six|seven|eight|nine)|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty(?:[\s-]+(?:one|two|three))?)[\s-]+hundred$/i;
/** A word before a year said aloud ("since two thousand ten", "back in nineteen ninety"). */
const YEAR_LEADS = /\b(?:since|in|year|back in|until|till|founded|opened|established)\s+$/i;

/** The run without a trailing "and" or "a", which belong to what follows ("a hundred and Lip filler"). */
function trimRun(run: string): string {
  return run.replace(/(?:[\s-]+(?:and|a))+$/i, "");
}

/** Every amount said in English number words, in cents, in the order they come. */
function wordAmounts(text: string): number[] {
  const found: { at: number; cents: number }[] = [];
  const taken: [number, number][] = [];
  for (const m of text.matchAll(WORD_DOLLARS)) {
    const dollars = runValue(m[1]!);
    if (dollars === null) continue;
    const cents = m[2] ? (wordsToNumber(m[2]) ?? 0) : 0;
    found.push({ at: m.index!, cents: dollars * 100 + (cents < 100 ? cents : 0) });
    taken.push([m.index!, m.index! + m[0].length]);
  }
  for (const m of text.matchAll(PER_UNIT)) {
    if (taken.some(([a, b]) => m.index! >= a && m.index! < b)) continue;
    const said = m[1]!;
    const value = /^\d/.test(said) ? Number(said.replace(/,/g, "")) : runValue(trimRun(said));
    if (value === null || !Number.isFinite(value)) continue;
    found.push({ at: m.index!, cents: Math.round(value * 100) });
    taken.push([m.index!, m.index! + m[0].length]);
  }
  for (const m of text.matchAll(MAGNITUDE_RUN)) {
    const run = trimRun(m[0]);
    if (!/hundred|thousand/i.test(run)) continue;
    const start = m.index!;
    const end = start + run.length;
    if (taken.some(([a, b]) => start < b && end > a)) continue;
    const before = text.slice(0, start);
    const after = text.slice(end);
    if (!PRICE_ENDS.test(after) || PLACE_LEADS.test(before)) continue;
    if (CLOCK_HUNDRED.test(run.trim()) && TIME_LEADS.test(before) && !PRICE_AT.test(before)) continue;
    const value = runValue(run);
    if (value === null) continue;
    if (value > 1900 && value < 2100 && YEAR_LEADS.test(before)) continue;
    found.push({ at: start, cents: value * 100 });
  }
  return found.sort((a, b) => a.at - b.at).map((f) => f.cents);
}

const ES_VALUES: Readonly<Record<string, number>> = {
  cero: 0, un: 1, uno: 1, una: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8,
  nueve: 9, diez: 10, once: 11, doce: 12, trece: 13, catorce: 14, quince: 15, "dieciséis": 16,
  dieciseis: 16, diecisiete: 17, dieciocho: 18, diecinueve: 19, veinte: 20, veintiuno: 21,
  "veintiún": 21, veintiun: 21, veintiuna: 21, "veintidós": 22, veintidos: 22, "veintitrés": 23,
  veintitres: 23, veinticuatro: 24, veinticinco: 25, "veintiséis": 26, veintiseis: 26,
  veintisiete: 27, veintiocho: 28, veintinueve: 29, treinta: 30, cuarenta: 40, cincuenta: 50,
  sesenta: 60, setenta: 70, ochenta: 80, noventa: 90, cien: 100, ciento: 100, doscientos: 200,
  doscientas: 200, trescientos: 300, trescientas: 300, cuatrocientos: 400, cuatrocientas: 400,
  quinientos: 500, quinientas: 500, seiscientos: 600, seiscientas: 600, setecientos: 700,
  setecientas: 700, ochocientos: 800, ochocientas: 800, novecientos: 900, novecientas: 900,
};
const ES_WORD = `(?:${[...Object.keys(ES_VALUES), "mil", "y"].sort((a, b) => b.length - a.length).join("|")})(?![\\p{L}])`;
const ES_DOLLARS = new RegExp(`(?<![\\p{L}])(${ES_WORD}(?:\\s+${ES_WORD})*)\\s+d[oó]lar(?:es)?(?![\\p{L}])`, "giu");

/** Spanish number words as a number: "ciento cincuenta" → 150, "mil doscientos" → 1200. */
function spanishToNumber(words: string): number | null {
  let total = 0;
  let current = 0;
  let seen = false;
  for (const part of words.toLowerCase().split(/\s+/)) {
    if (!part || part === "y") continue;
    if (part === "mil") {
      total += (current || 1) * 1000;
      current = 0;
      seen = true;
      continue;
    }
    const value = ES_VALUES[part];
    if (value === undefined) return null;
    current += value;
    seen = true;
  }
  return seen ? total + current : null;
}

const ES_RUN = new RegExp(`(?<![\\p{L}])${ES_WORD}(?:\\s+${ES_WORD})*`, "giu");
const ES_PER_UNIT = new RegExp(
  `(?<![$\\d.,\\p{L}])(\\d+(?:[.,]\\d{1,2})?|${ES_WORD}(?:\\s+${ES_WORD})*)\\s+(?:por|cada|la|el)\\s+(?:unidad|jeringa|vial|ml|[áa]rea|zona)(?![\\p{L}])`,
  "giu",
);
/** A Spanish number with "cien", "-cientos" or "mil" in it: one said as a price with no currency word. */
const ES_MAGNITUDE = /(?:cien(?:to)?|ient[oa]s|mil)(?![\p{L}])/iu;
/** What may follow such a number as a price: the end of a clause, or a word that runs on ("doscientos por sesión"). */
const ES_PRICE_ENDS =
  /^(?:\s*$|\s*[.,;:!?)\]—–]|\s+-\s|\s+(?:por|o|a|hasta|m[áa]s|con|cada|seg[uú]n|dependiendo|en total|si|pero|y|al)(?![\p{L}]))/iu;
/** What leads a Spanish number that is a place: "consultorio doscientos", "en el doscientos". */
const ES_PLACE_LEADS =
  /(?:(?<![\p{L}])(?:suite|consultorio|oficina|n[uú]mero|piso|sala|local|calle|avenida|av\.|carretera|ruta|salida|el)|n[ºo°]\.?|#)\s*$/iu;
/** A word before a year said aloud: "desde dos mil diez", "fundada en mil novecientos noventa". */
const ES_YEAR_LEADS = /(?<![\p{L}])(?:desde|en|año|del|fundad[oa]s?\s+en|abiert[oa]s?\s+en)\s+$/iu;

/** The run without a trailing "y", "un" or "una", which belong to what follows ("doscientos y la consulta"). */
function trimSpanishRun(run: string): string {
  return run.replace(/(?:\s+(?:y|un|una|uno))+$/iu, "");
}

/**
 * Every amount said in Spanish number words, in cents, in the order they
 * come: before "dólares" ("ciento cincuenta dólares"); by the unit ("doce por
 * unidad"); and with "cien", "-cientos" or "mil" in it and no currency word
 * ("cuesta ciento cincuenta", "son doscientos"), where it ends or runs on
 * into a clause, the same skips as in English: a noun after it ("doscientos
 * clientes", "mil gracias"), a place before it ("consultorio doscientos") or
 * a year ("desde dos mil diez").
 */
function spanishAmounts(text: string): number[] {
  const found: { at: number; cents: number }[] = [];
  const taken: [number, number][] = [];
  for (const m of text.matchAll(ES_DOLLARS)) {
    const value = spanishToNumber(m[1]!);
    if (value === null) continue;
    found.push({ at: m.index!, cents: value * 100 });
    taken.push([m.index!, m.index! + m[0].length]);
  }
  for (const m of text.matchAll(ES_PER_UNIT)) {
    if (taken.some(([a, b]) => m.index! >= a && m.index! < b)) continue;
    const said = m[1]!;
    const value = /^\d/.test(said) ? Number(said.replace(",", ".")) : spanishToNumber(trimSpanishRun(said));
    if (value === null || !Number.isFinite(value)) continue;
    found.push({ at: m.index!, cents: Math.round(value * 100) });
    taken.push([m.index!, m.index! + m[0].length]);
  }
  for (const m of text.matchAll(ES_RUN)) {
    const run = trimSpanishRun(m[0]);
    if (!ES_MAGNITUDE.test(run)) continue;
    const start = m.index!;
    const end = start + run.length;
    if (taken.some(([a, b]) => start < b && end > a)) continue;
    const before = text.slice(0, start);
    if (!ES_PRICE_ENDS.test(text.slice(end)) || ES_PLACE_LEADS.test(before)) continue;
    const value = spanishToNumber(run);
    if (value === null) continue;
    if (value > 1900 && value < 2100 && ES_YEAR_LEADS.test(before)) continue;
    found.push({ at: start, cents: value * 100 });
  }
  return found.sort((a, b) => a.at - b.at).map((f) => f.cents);
}

/** The cents of each amount said in words, English and Spanish: "two hundred dollars", "a hundred and fifty", "son doscientos". */
export function spokenAmountsIn(text: string): number[] {
  return [...wordAmounts(text), ...spanishAmounts(text)];
}

/**
 * The cents of each amount the reply names: written ("$1,200", "$99.50",
 * "1200 dollars") and said ("two hundred dollars", "a hundred and fifty",
 * "twelve a unit").
 */
export function amountsIn(text: string): number[] {
  const out: number[] = [];
  for (const pattern of [DOLLARS, SPOKEN_DOLLARS, CODE_DOLLARS]) {
    for (const match of text.matchAll(pattern)) {
      const whole = Number(match[1]!.replace(/,/g, ""));
      const cents = match[2] ? Number(match[2].padEnd(2, "0")) : 0;
      const thousands = match[3] ? 1000 : 1;
      out.push(Math.round((whole * thousands) * 100 + cents));
    }
  }
  // Another currency is never a price on the menu, which is in dollars.
  for (const _ of text.matchAll(OTHER_CURRENCY)) out.push(NOT_ON_ANY_MENU);
  for (let i = otherCurrencyInWords(text); i > 0; i -= 1) out.push(NOT_ON_ANY_MENU);
  return [...out, ...spokenAmountsIn(text)];
}

/** A currency code or "US$" before the number: "USD 650", "US$ 650", "USD650.00". */
const CODE_DOLLARS = /\b(?:usd|us\s?dollars?)\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?(\s?k\b)?/gi;
/** An amount in a currency other than the dollar, symbol or code either side: "€650", "650 EUR", "£200", "650 euros". */
const OTHER_CURRENCY =
  /[€£¥₹]\s?\d|\b(?:eur|gbp|aed|cad|aud|mxn|chf|jpy|inr)\s?\d|\d\s?(?:[€£¥₹]|(?:eur|gbp|aed|cad|aud|mxn|chf|jpy|inr|euros?|pesos?|libras? esterlinas?|quetzales|soles|colones|lempiras)\b)/gi;
/**
 * The same said in words, English or Spanish: "trescientos cincuenta pesos",
 * "seiscientos euros", "two hundred euros", "ciento cincuenta libras
 * esterlinas". "Libras" and "pounds" alone are also weights (a vet's "un
 * perro de cuarenta libras"), so they count as money only after a word of
 * price ("cuesta cuarenta libras", "it costs forty pounds"), digits or words.
 */
const ANY_NUMBER_RUN = `(?:${ES_WORD}|${NUMBER_WORD})(?:[\\s-]+(?:${ES_WORD}|${NUMBER_WORD}))*`;
const OTHER_CURRENCY_WORDS: readonly RegExp[] = [
  new RegExp(`(?<![\\p{L}])(${ANY_NUMBER_RUN})\\s+(?:pesos?|euros?|libras?\\s+esterlinas?|quetzales|soles|colones|lempiras)(?![\\p{L}])`, "giu"),
  new RegExp(
    `(?<![\\p{L}])(?:cuesta|cuestan|vale|valen|cobra|cobramos|cobran|costs?|priced at|charge|charges)\\s+(?:de\\s+|unas?\\s+|about\\s+|around\\s+)?(\\d[\\d,.]*|${ANY_NUMBER_RUN})\\s+(?:libras?|pounds?|quid)(?![\\p{L}])`,
    "giu",
  ),
];
/** Words a run may hold that are no number on their own: "y pesos", "a pound" name no amount. */
const CONNECTIVES = new Set(["y", "a", "and", "un", "una", "uno"]);

/** Whether the text names an amount in another currency in words (OTHER_CURRENCY_WORDS). */
function otherCurrencyInWords(text: string): number {
  let found = 0;
  for (const pattern of OTHER_CURRENCY_WORDS) {
    for (const m of text.matchAll(pattern)) {
      const run = m[1]!;
      if (/\d/.test(run) || run.toLowerCase().split(/[\s-]+/).some((w) => w && !CONNECTIVES.has(w))) found += 1;
    }
  }
  return found;
}
/** An amount no menu holds: refuses the reply whatever the clinic lists. */
const NOT_ON_ANY_MENU = -1;

/**
 * "Free" said of what the practice sells is a price of nothing: "the
 * consultation is free", "a free consultation", "complimentary", "at no
 * cost", "free of charge", "gratis": a price of $0, so it passes only where
 * the clinic lists that service at $0 (freeOffList). A sentence about parking, wifi or a drink is
 * not read ("free parking behind the building"), nor is "feel free", "free
 * time" or "if you're free on Thursday", which name no price.
 */
const FREE_PRICE: readonly RegExp[] = [
  /\b(?:consultations?|consults?|services?|treatments?|sessions?|assessments?|appointments?|visits?|deposits?|follow-ups?|touch-ups?|check-ups?|first (?:visit|session|appointment))\s+(?:is|are|'s|will be|would be)\s+(?:completely\s+|totally\s+|absolutely\s+|always\s+)?(?:free|complimentary)\b/i,
  /\b(?:free|complimentary|no-cost|no-charge)\s+(?:initial\s+|first\s+|virtual\s+|in-person\s+)?(?:consultations?|consults?|assessments?|sessions?|treatments?|appointments?|visits?|follow-ups?|touch-ups?|check-ups?)\b/i,
  /\bfree of charge\b|\bfor free\b|\bat no (?:extra |additional )?(?:cost|charge)\b|\bno charge\b|\bcosts? nothing\b|\bwon'?t cost (?:you )?(?:anything|a (?:thing|penny|cent))\b/i,
  /(?<![\p{L}])(?:gratis|gratuit[oa]s?|sin costo|sin cargo)(?![\p{L}])/iu,
  // Spanish in other words: "no tiene ningún costo", "no cuesta nada", "sin
  // ningún cargo", "de cortesía", "no le cobramos", "sin costo alguno".
  /(?<![\p{L}])(?:no\s+tiene\s+(?:ning[uú]n\s+)?(?:costo|cargo|precio)|no\s+(?:le\s+|te\s+)?(?:cuesta|costar[aá]|va\s+a\s+costar)\s+(?:nada|ni\s+un)|sin\s+(?:ning[uú]n\s+)?(?:costo|cargo|coste)(?:\s+alguno)?|de\s+cortes[ií]a|(?:no|nada)\s+(?:se\s+)?(?:le\s+|te\s+)?(?:cobra|cobramos|cobran|cobrar[aá]n?)(?:\s+nada)?|cero\s+(?:pesos|d[oó]lares)|costo\s+cero)(?![\p{L}])/iu,
];
const NOT_A_PRICE_TOPIC =
  /\b(?:park(?:ing)?|car park|garage|wi-?fi|internet|coffee|tea|water|refreshments?|snacks?|drinks?)\b|(?<![\p{L}])(?:estacionamiento|aparcamiento|parqueo|caf[eé]|té|agua|bebidas?|refrescos?|botanas?|aperitivos?)(?![\p{L}])/iu;

/**
 * What denies a "free" that follows it directly: "we don't offer free
 * consultations", "we don't currently have any free sessions", "there's no
 * free consultation", "it isn't a free consultation". The negation must be
 * followed by a verb of offering or charging, or by nothing but articles, so
 * "don't miss our free consultation" is still a price of nothing.
 */
const FREE_DENIED =
  /(?:\b(?:don'?t|do not|doesn'?t|does not|can'?t|cannot|won'?t|will not|never|no longer)\s+(?:(?:currently|really|actually|usually|normally|generally|ever|also)\s+)?(?:offer|do|have|give|provide|include|run|make|list|advertise|charge|sell)\s+(?:(?:any|a|an|the|our|such|these|those)\s+)*|\b(?:there(?:'s| is| are)|we have|we offer|with|offer)\s+no\s+|\b(?:isn'?t|aren'?t|is not|are not|not)\s+(?:(?:a|an|any|the|really|actually|currently)\s+)*)$/i;

/**
 * The same in Spanish: "no es gratis", "no ofrecemos consultas gratis", "ya
 * no tenemos la consulta gratuita", a negation at most three words before
 * the "free" in the same clause.
 */
const FREE_DENIED_ES = /(?<![\p{L}])(?:no|nunca|ya no|tampoco)\s+(?:\p{L}+\s+){0,3}$/iu;

/**
 * Whether the sentence calls something free, in this pattern's words, and
 * does not deny it: a "free" put right after a negation is the opposite of a
 * price of nothing. Every match is read, so "We don't offer free consultations
 * but the consultation is free this month" still says it.
 */
function saysFree(pattern: RegExp, sentence: string): boolean {
  const all = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
  for (const m of sentence.matchAll(all)) {
    const before = sentence.slice(0, m.index);
    if (!FREE_DENIED.test(before) && !FREE_DENIED_ES.test(before)) return true;
  }
  return false;
}

/**
 * Whether the reply calls something free that the clinic does not list at
 * $0. A sentence that says "free" passes only when it names a service the
 * clinic prices at $0 (a "Consultation" at $0 lets "a free consultation"
 * through); a $0 skin check does not make the consultation free.
 */
export function freeOffList(text: string, facts: Pick<AssistantFacts, "services">): boolean {
  const free = facts.services
    .filter((s) => s.priceFromUsd === 0 || (s.priceFromUsd == null && s.priceToUsd === 0))
    .map((s) => s.name.trim().toLowerCase())
    .filter(Boolean);
  for (const sentence of text.split(/(?<=[.!?])\s+|\n+/)) {
    if (NOT_A_PRICE_TOPIC.test(sentence) || !FREE_PRICE.some((p) => saysFree(p, sentence))) continue;
    const said = sentence.toLowerCase();
    // A service named in the singular or the plural, or by its first word ("consult" for "Consultation").
    const named = free.some((name) => said.includes(name) || (name.length > 6 && said.includes(name.slice(0, 7))));
    if (!named) return true;
  }
  return false;
}

const PAYMENT_ASK = /\b(card number|credit card|debit card|card details|cvv|cvc|security code|expir(y|ation) date|bank (account|details)|routing number)\b/i;

const CARD = "(?:card|visa|mastercard|master card|amex|american express|discover|credit card|debit card)";
/**
 * An ask for a card in other words, each one naming the card itself, so "we
 * accept Visa and Mastercard" and "the clinic sends a secure payment link"
 * pass: the number or digits on it ("the long number on the front of your
 * card", "the 16 digits on your Visa"), reading or sending it ("read me your
 * card", "send a photo of your card"), the code or the expiry on its own
 * ("the three digits on the back", "when does it expire").
 */
const CARD_ASK: readonly RegExp[] = [
  new RegExp(`\\b(?:numbers?|digits|code|name|details|info(?:rmation)?)\\b[^.?!]{0,30}\\b(?:on|of|from|off)\\s+(?:the\\s+)?(?:(?:front|back)\\s+of\\s+)?(?:your|the)\\s+${CARD}\\b`, "i"),
  new RegExp(`\\b(?:read|tell|give|send|text|share|type|enter|spell|pass)\\s+(?:me|us)?\\s*(?:out\\s+)?(?:the\\s+|your\\s+)${CARD}\\b(?!\\s+(?:to|with)\\s+(?:the\\s+)?(?:clinic|practice|team|front desk))`, "i"),
  new RegExp(`\\b(?:photo|picture|pic|image|scan|screenshot|copy)\\s+of\\s+(?:your|the)\\s+${CARD}`, "i"),
  /\b(?:16|sixteen|15|fifteen)[- ]digits?\b|\b(?:three|3|four|4)[- ]digits? (?:on the back|code|security)\b|\bexp(?:iry|iration)?\b[^.?!]{0,20}\b(?:date|month|year)\b|\bwhen does (?:it|your card|the card) expire\b/i,
];
/**
 * The same asks in Spanish: the card's number, its digits, its code or its
 * expiry, or a bank account, asked for ("dígame el número de su tarjeta",
 * "necesito su número de cuenta bancaria", "los dieciséis dígitos de su
 * tarjeta", "¿cuándo vence?"), each naming the card or the account, so
 * "aceptamos tarjeta de crédito" and "la clínica le envía un enlace de pago
 * seguro" pass. As in English (PAYMENT_ASK), the details named with a word
 * of asking or a "su"/"tu" ("your") is enough.
 */
const PAYMENT_ASK_ES =
  /(?<![\p{L}])(?:n[uú]meros?\s+de\s+(?:la\s+|su\s+|tu\s+)?(?:tarjeta|cuenta)|datos\s+(?:de\s+(?:la\s+|su\s+|tu\s+)?tarjeta|bancarios|de\s+(?:la\s+|su\s+|tu\s+)?cuenta)|cuenta\s+(?:bancaria|de\s+banco|corriente|de\s+ahorros?)|c[oó]digo\s+de\s+seguridad|cvv|cvc|fecha\s+de\s+(?:vencimiento|caducidad|expiraci[oó]n)|n[uú]mero\s+de\s+ruta|clabe(?:\s+interbancaria)?)(?![\p{L}])/iu;
const PAYMENT_ASK_ES_VERB =
  /(?<![\p{L}])(?:su|sus|tu|tus|d[ií]game|d[ií]me|deme|d[eé]me|dame|p[aá]seme|p[aá]same|l[eé]ame|l[eé]eme|env[ií]eme|m[aá]ndeme|ind[ií]queme|proporci[oó]n(?:e|eme|ar)|facil[ií]te(?:me)?|compart(?:a|ir|e)|necesito|necesitamos|necesitar[ií]a|requiero|me\s+(?:puede|podr[ií]a|puedes|podr[ií]as)\s+(?:dar|decir|pasar|leer|enviar|mandar|proporcionar))(?![\p{L}])/iu;
const CARD_ES = "(?:tarjeta(?:\\s+de\\s+(?:cr[eé]dito|d[eé]bito))?|visa|mastercard|amex|american express)";
const CARD_ASK_ES: readonly RegExp[] = [
  // The digits or the number on it: "los dieciséis dígitos de su tarjeta", "el número largo de su tarjeta".
  new RegExp(`(?<![\\p{L}])(?:n[uú]meros?|d[ií]gitos|c[oó]digo|nombre|datos)(?![\\p{L}])[^.?!]{0,30}(?<![\\p{L}])(?:de|en|del\\s+(?:frente|reverso)\\s+de)\\s+(?:la\\s+|su\\s+|tu\\s+)${CARD_ES}(?![\\p{L}])`, "iu"),
  // Reading it out or sending it: "léame su tarjeta", "mándeme una foto de su tarjeta".
  new RegExp(`(?<![\\p{L}])(?:l[eé]ame|d[ií]game|d[ií]me|deme|dame|p[aá]seme|env[ií]eme|m[aá]ndeme)\\s+(?:los\\s+datos\\s+de\\s+|el\\s+n[uú]mero\\s+de\\s+)?(?:su|tu|la)\\s+${CARD_ES}(?![\\p{L}])`, "iu"),
  new RegExp(`(?<![\\p{L}])(?:foto|fotograf[ií]a|imagen|captura|copia)\\s+de\\s+(?:su|tu|la)\\s+${CARD_ES}(?![\\p{L}])`, "iu"),
  // Its digits by count, its code, its expiry.
  /(?<![\p{L}\d])(?:16|diecis[eé]is|15|quince)\s+d[ií]gitos(?![\p{L}])|(?<![\p{L}\d])(?:tres|3|cuatro|4)\s+d[ií]gitos\s+(?:de\s+atr[aá]s|del\s+reverso|de\s+seguridad|de\s+la\s+parte\s+de\s+atr[aá]s)|(?<![\p{L}])(?:cu[aá]ndo|qu[eé]\s+fecha|en\s+qu[eé]\s+(?:mes|fecha))\s+(?:le\s+|te\s+)?(?:vence|caduca|expira)(?![\p{L}])/iu,
];
const HIPAA_CLAIM = /\bhipaa[- ]?(compliant|certified|approved)\b/i;
/**
 * "HIPAA compliant" in Spanish: "compatibles con HIPAA", "cumplimos con
 * HIPAA", "certificados por HIPAA", "en cumplimiento de la ley HIPAA". The
 * honest sentence ("firmamos un acuerdo de socio comercial y tratamos los
 * datos de pacientes conforme a él") names no HIPAA claim.
 */
const HIPAA_CLAIM_ES =
  /(?<![\p{L}])(?:compatibles?|cumplimiento|cumpl(?:e|en|imos|ir)|certificad[oa]s?|aprobad[oa]s?|avalad[oa]s?|conformes?|acorde)\s+(?:(?:total|totalmente|completamente|plenamente|100%)\s+)?(?:con|por|de|a)?\s*(?:la\s+|las\s+)?(?:normas?\s+|ley\s+|normativa\s+)?(?:de\s+)?hipaa(?![\p{L}])|(?<![\p{L}])hipaa\s+(?:certificad|aprobad|compatible|cumpl)/iu;

/**
 * A price by the unit, said the way people say it ("$12 a unit", "12 dollars
 * each unit"), rewritten the way a menu writes it ("$12 per unit"), which is
 * the one form the clinical screen's dosing pattern lets through. Only right
 * after an amount, so "how many units" is still dosing.
 */
function perUnitPrices(text: string): string {
  return text.replace(PER_UNIT_PRICE, "$1 per $2");
}
const PER_UNIT_PRICE = new RegExp(
  `((?:\\$\\s?\\d[\\d,]*(?:\\.\\d{1,2})?)|\\b\\d[\\d,]*(?:\\.\\d{1,2})?\\s?(?:dollars|usd|bucks)|(?<![\\p{L}])${NUMBER_RUN}\\s+(?:dollars?|bucks))\\s+(?:a|an|each|every)\\s+(units?|ml)(?![\\p{L}])`,
  "giu",
);

type ScreenFacts = Pick<AssistantFacts, "services"> &
  Partial<Pick<AssistantFacts, "clinicName" | "shortName" | "address" | "requirements" | "providerNames" | "businessCounts">>;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The short name the clinic chose (Settings, "What patients call you"), as
 * the screens' own words only when it is a part of its full name ("Painless
 * Laser" of "Painless Laser Studio"): words the name already excuses, never
 * new ones typed into Settings. Any other short name is read like any word
 * of a reply, so a guard refuses it rather than reading past it.
 */
export function ownShortName(facts: { clinicName?: string | null; shortName?: string | null }): string | null {
  const short = (facts.shortName ?? "").trim();
  return short && (facts.clinicName ?? "").toLowerCase().includes(short.toLowerCase()) ? short : null;
}

/**
 * The reply with the clinic's own words blanked: its name and a short name
 * that is a part of it (ownShortName), its service names,
 * its address and the questions its booking requirements ask, all screened
 * or written by the practice, not by the model.
 */
function withoutOwnWords(reply: string, facts: ScreenFacts): string {
  const own = [
    facts.clinicName ?? "",
    ownShortName(facts) ?? "",
    facts.address ?? "",
    ...facts.services.map((s) => s.name),
    ...(facts.requirements ?? []).map((f) => f.ask),
  ]
    .map((words) => words.trim())
    .filter((words) => words.length > 2)
    .sort((a, b) => b.length - a.length);
  let text = reply;
  for (const words of own) text = text.replace(new RegExp(escapeRegExp(words), "gi"), " ");
  return text;
}

/** Words that make a frequency a way of taking or applying something: a medicine, a cream, a dose. */
const PRACTICE_NOT_DOSE =
  "apply|applying|applied|take|takes|taking|use|using|put|putting|rub|dab|inject\\w*|dose|doses|dosing|dosage|medicat\\w*|medicines?|meds|creams?|ointments?|gels?|lotions?|balms?|serums?|tablets?|pills?|capsules?|drops?|sprays?|patch(?:es)?|supplements?|vitamins?|tylenol|ibuprofen|advil|aspirin|paracetamol|acetaminophen|antihistamines?|antibiotics?|steroids?|retinol|tretinoin|lidocaine";

/**
 * Everyday words the clinical screen would misread, read past before it
 * runs: an address unit ("Unit 4", "Suite 2"), safety that is not a claim
 * about a treatment ("parking is free and safe", "keep your details safe"),
 * and a medication list or an allergy asked for at intake. Each is a whole
 * phrase, so "safe for you" and "stop your medications" are still read.
 */
const EVERYDAY: RegExp[] = [
  /\b(unit|suite|ste|apt|apartment|building|bldg|floor|room)\.?\s*#?\d+[a-z]?\b/gi,
  /\b(parking|car park|the lot|garage|neighbou?rhood|area|location|building|street|lobby)( is| are)?( free and| very| completely| totally)? safe\b/gi,
  /\bfree and safe\b|\bsafe (and free )?(parking|place|spot|neighbou?rhood|area|lot|garage)\b/gi,
  /\b(keep|kept|keeps|keeping|stay|stays|be) (your |their |it |them |everything |all )?(details |information |data |card |belongings )?safe\b|\bsafe travels\b|\bsafely (stored|kept)\b/gi,
  // A goodbye: "Have a safe drive!", "Drive safe!", "stay safe in the rain".
  /\b(have a |get home |travel |drive |stay )safe(ly)?( (drive|trip|journey|flight|travels|home))?\b|\bsafe (drive|trip|journey|flight|travels)\b|\bdrive safe(ly)?\b/gi,
  // The same in Spanish: a secure payment link, data kept safe, safe parking.
  /(?<![\p{L}])(?:enlace|link|v[ií]nculo|pago|pagos|portal|sistema|plataforma|estacionamiento|lugar|zona)\s+(?:de\s+pago\s+)?(?:muy\s+)?segur[oa]s?(?![\p{L}])|(?<![\p{L}])(?:de|en)\s+(?:forma|manera)\s+segura(?![\p{L}])|(?<![\p{L}])(?:sus|tus|los|la|su)\s+(?:datos|informaci[oó]n)\s+(?:est[aá]n?|quedan?)\s+(?:segur[oa]s?|protegid[oa]s?)(?![\p{L}])/giu,
  /\b(a |the )?(list|names?) of (any |all |your |the )?(medications?|medicines|meds|allergies)\b/gi,
  /\b(any|your) allergies (we|you|I|the team) should (note|know|pass on|be aware of)\b/gi,
  // How often the practice itself does something, not a dose: "the phones are
  // answered twice a day", "we check the calendar twice a day". Read past
  // only where a verb of the practice's own work leads the frequency within
  // the clause and no medicine, cream or way of taking one is in the sentence
  // on either side of it, so "apply the cream twice a day" and "we're open
  // today, so take two tablets twice a day" are still read.
  new RegExp(
    `(?<!\\b(?:${PRACTICE_NOT_DOSE})\\b[^.?!]*)\\b(?:open|opens|closes?|closed|answer(?:s|ed)?|staffed|check(?:s|ed)?|available|operates?|respond(?:s|ed)?)\\b(?![^.?!]*\\b(?:${PRACTICE_NOT_DOSE})\\b)[^.?!,;]{0,30}?\\b(?:once|twice|\\d+ times|(?:two|three|four) times) (?:a|per) (?:day|week)\\b`,
    "gi",
  ),
  // Scheduling, not an outcome claim: "what day and time works best for
  // you?", "whichever morning works well for you". Until 23 October 2026
  // PLAIN_CLINICAL's "works best for" read this as a claim about a
  // treatment, so the most ordinary booking question was refused, and a
  // caller who said yes to the refusal's offer of a consultation was asked
  // it again and refused again, round and round (test call of that day).
  // Only after a word of time or a question about one, so "it works best
  // for you if..." is still read.
  /\b(?:day|days|time|times|date|dates|slot|slots|morning|mornings|afternoon|afternoons|evening|evenings|appointment|schedule|when|whenever|whichever|what)\b[^.?!]{0,30}?\bworks? (?:best|well|really well|great) for (?:you|me|us|your schedule)\b/gi,
  // A dose the person named, handed back with a refusal and nothing more:
  // "The 3mg figure is not something I can discuss." The whole sentence, so a
  // figure said alongside anything else ("..., but 3mg is typical") is read.
  /(?<![^.!?]*[^\s.!?][^.!?]*)\b(?:the|that|your) \d+(?:[.,]\d+)?\s?(?:mg|mcg|µg|iu|units?) (?:figure|amount|dose|dosage|number)(?: you (?:mentioned|gave|quoted|asked about))? (?:is not|isn'?t) something (?:that )?(?:i|we) (?:can|could|am able to) (?:discuss|advise on|comment on|help with|go into|speak to|talk about)(?: (?:it|this|that|further|here|in detail|with you))*(?:,? but (?:the )?(?:clinicians?|team|clinic|practice|staff|doctor|nurse|injector|provider) (?:can|could|will)(?: (?:discuss|advise|go through|talk you through|help)(?: (?:it|this|that|with you|you))*)?)?\s*(?=[.!?]|$)/gi,
];

function withoutEveryday(text: string): string {
  return EVERYDAY.reduce((out, pattern) => out.replace(pattern, " "), text);
}

/** Medicines a model might tell someone to take or put on, by name or by kind. */
const MEDICINES =
  "tylenol|ibuprofen|advil|motrin|aleve|naproxen|aspirin|paracetamol|acetaminophen|antihistamines?|benadryl|claritin|zyrtec|painkillers?|pain relievers?|prednisone|prednisolone|steroids?|hydrocortisone|cortisone|antibiotics?|neosporin|polysporin|bacitracin|mupirocin|arnica|tretinoin|retin-?a|lidocaine|numbing cream|valtrex|valacyclovir|acyclovir|tablets?|pills?|capsules?";

/**
 * Where an instruction to the person starts: the start of a sentence, or
 * words that tell them to ("you should", "just", "try to"). So "use a cream"
 * is advice and "we use a cooling gel during the laser" is not read by it.
 */
const TOLD_TO =
  "(?:^\\s*|[.!?:;]\\s+|\\b(?:you should|you can|you could|you'?ll want to|you need to|you must|just|please|try to|make sure (?:to|you)|be sure to|remember to|i'?d|i would|we'?d)\\s+)";

/** Words a reply about a treatment's aftermath is made of. */
const AFTERMATH =
  "bruis\\w*|swelling|swollen|puff(y|iness)|redness|tenderness|soreness|sore|tingling|numbness|itch\\w*|lumps?|bumps?|flaking|peeling|scabbing|irritation";

/**
 * A dose without its unit: "about 20". A count of calls, bookings, messages
 * or conversations is never a dose ("about 100 calls a week", a demo's
 * discovery question); "about 2 a day" still is. It stands aside only for a
 * demo's talk with a clinic's owner about their own calls (facts
 * `businessCounts`), where the owner's test call of 25 October 2026 had
 * "about 25 calls a week, or around 110 a month?" refused as clinical for the
 * figure the word "calls" did not follow, and heard the clinicians' line in
 * answer to "Five". A patient's call never sets it.
 */
const UNITLESS_DOSE =
  /(?<!\b(open|opens|opening|close|closes|closing|until|till|from|at|by|after|before|since|arrive|starts?|ends?|takes|lasts|wait|waits)\s)\b(about|around|roughly|approximately|typically|usually)\s\d+\b(?!\s*(%|percent|minutes?|mins?|hours?|hrs?|days?|weeks?|months?|years?|am|pm|a\.m\.|p\.m\.|o'?clock|people|patients|clients|spaces?|spots?|cars?|miles?|km|blocks?|dollars|bucks|usd|seconds?|openings?|slots?|appointments?|times?|seats?|left|available|calls?|bookings?|messages?|conversations?|-minute|-hour|:\d))/i;

/**
 * Clinical advice in plain words, which the vocabulary of the clinical
 * screen does not hold: the reviews of 14 October found each of these
 * passed. Post-model only, on a call or a web chat: a clinic's own text is
 * never screened with them. English, then Spanish.
 */
const PLAIN_CLINICAL: RegExp[] = [
  // Aftercare and side effects, called normal or told how long they last.
  new RegExp(
    `\\b(${AFTERMATH})\\b[^.?!]{0,60}\\b(is|are|it'?s)?\\s?(normal|common|expected|typical|usual|temporary|fine|go(es)? away|will fade|fades?|settles?|subsides?|resolves?|clears? up|be gone|disappears?|for a (day|few days|week)|a day or two|a couple of days|a few days|about a week|by tomorrow|overnight)\\b`,
    "i",
  ),
  new RegExp(`\\b(${AFTERMATH})\\b[^.?!]{0,30}\\b(should|will) (be gone|disappear|go|fade|clear|settle|subside)\\b`, "i"),
  /\b(ice it|apply ice|ice pack|cold compress|arnica)\b/i,
  /\btake (some |an? )?(tylenol|ibuprofen|advil|motrin|aspirin|paracetamol|acetaminophen|antihistamines?|benadryl|painkillers?)\b/i,
  /\b(avoid|no|skip|stay off|cut out|hold off on|stop taking|stop|pause)\s(alcohol|drinking|exercise|exercising|the gym|workouts?|working out|sun|sunbathing|saunas?|hot tubs?|makeup|blood thinners|fish oil|retinol|ibuprofen|aspirin|advil|motrin|aleve|naproxen|vitamin e|supplements|ginkgo)\b/i,
  /\bstop taking\b/i,
  /\b(don'?t|do not|avoid|try not to|no) (exercise|exercising|work ?out|working out|drink(ing)?( alcohol)?|lie|lay|lying|laying|bend(ing)? over|swim(ming)?|wear(ing)? makeup)\b/i,
  /\b(don'?t|do not|avoid|try not to|no) (lie|lay|lying|laying) (down|flat)\b|\b(don'?t|do not|avoid|try not to) (touch|rub|massage|press on) (it|the area|your (face|lips|skin))\b/i,
  /\b(wear|put on|apply) (your )?make-?up (again )?(after|for|until|within|the next)\b/i,
  /\bsleep (on your back|upright|elevated|on your side|with your head (up|raised|elevated))\b|\bkeep your head (up|raised|elevated)\b|\b(stay|keep|remain) upright\b|\bdrink (plenty of|lots of|a lot of) water\b/i,
  /\bwait (\w+ )?(days?|weeks?|months?) (before|after|between)\b/i,
  // Outcome claims, and how a treatment takes effect.
  /\bresults? (last|lasts|will last|should last|can last|typically last|usually last)\b|(?<!\b(cards?|vouchers?|certificates?|credits?|memberships?|packages?|offers?|promotions?|deals?|deposits?|points?|passes)\s)\blasts? (about |around |up to |roughly )?(a|one|two|three|four|six|\d+) (weeks?|months?|years?)\b/i,
  /(?<!\b(hours|price|prices|pricing|discount|promotion|promo|offer|policy|policies|change|changes|rate|rates|fee|fees|membership|deal|schedule)\s(will\s)?)\b(kicks? in|wears? off|takes? effect|starts? working)\b/i,
  /\bworks? (best|well|really well|great|wonders) (on|for)\b|\b(very|highly|really|extremely|super) effective\b|\byou'?ll (see|notice) (results|a difference)\b|\b(see|notice) (results|a difference) (in|within|after)\b/i,
  /\b(most|many) (people|patients|clients|women|men) (need|go straight back|see (results|a difference)|are back to normal|feel fine)\b|\bback to normal (the next day|in|within|after|by)\b|\bpainless\b|\bno downtime\b|\b(is |are )?approved for\b|\bneed (\d+|one|two|three|four|five|six|several|a few) (sessions|treatments|syringes?|vials?|units|rounds)\b/i,
  /\b(won'?t|doesn'?t|does not|will not|shouldn'?t) hurt\b(?! to\b)|\b(barely|hardly) hurts?\b|\bnot (very |that |too )?painful\b/i,
  /\blook (\w+ )?(years? )?younger\b|\btakes? (\w+ )?years off\b/i,
  // Triage.
  /\b(that'?s|it'?s|this is|that is|which is) (completely |totally |perfectly |quite |very )?(normal|common|expected|typical) (after|with|for|following)\b|\bnothing to worry about\b|\b(should|will) (settle|subside|go down|calm down|resolve|clear up|heal|fade|go away)( on its own| by itself)?\b/i,
  /\b(sounds|looks|seems) like (a |an )?(mild |small |minor |normal |common |bit of )?(bruise|swelling|reaction|infection|allergy|rash|lump|bump|sprain)\b|\bno need to (come in|be seen|see (a|the|your) (doctor|nurse|clinician|provider|injector))\b(?! (early|earlier|before|until|for|to|at|on|by))/i,
  // A dose without its unit: "about 20" (UNITLESS_DOSE, above), "20U", "2 syringes".
  UNITLESS_DOSE,
  /\b\d+\s?u\b(?!\.?\s?s\.)|\b\d+\s(syringes?|vials?|ccs?)\b/i,
  // A dose by weight, written with or without the space: "400mg", "5 mcg", "1000 IU".
  /\b\d+(?:[.,]\d+)?\s?(?:mg|mcg|µg|milligrams?|micrograms?|iu)\b/i,
  // A medicine taken or put on, with words between: "take 400mg ibuprofen", "apply hydrocortisone cream".
  new RegExp(`(?:\\b(?:take|taking|apply|applying)|${TOLD_TO}(?:use|put|rub|pop|try|dab))\\b[^.?!]{0,40}\\b(?:${MEDICINES})\\b`, "i"),
  new RegExp(`${TOLD_TO}(?:apply|put|rub|dab|smooth|use)\\b[^.?!]{0,30}\\b(?:creams?|ointments?|gels?|lotions?|balms?|salves?|serums?)\\b`, "i"),
  // A schedule for a medicine or a treatment: "every 6 hours", "twice a day", "three times daily".
  /\bevery (?:\d+|two|three|four|six|eight|twelve) hours\b|\b(?:once|twice|three times|four times|\d+ times) (?:a|per) day\b|\b(?:once|twice|three times) daily\b/i,
  // A treatment plan: a course said or recommended, or named as the plan.
  /\b(?:your|my|a|the|this)\s+(?:personal(?:i[sz]ed)?\s+|custom\s+)?treatment plan\s*(?::|is\b|would be\b|will be\b|should be\b|looks like\b)|\b(?:here'?s|here is|this is)\s+(?:your|a)\s+(?:suggested\s+|recommended\s+)?(?:treatment plan\b|plan\s*:)/i,
  /\b(?:i'?d|i would|we'?d|we would|i|we)\s+(?:strongly\s+|probably\s+|personally\s+)?(?:recommend|suggest|advise|prescribe)\b[^.?!]{0,50}\b(?:\d+|one|two|three|four|five|six|several|a few|a course of|a series of)\s+(?:sessions?|treatments?|rounds?|peels?|syringes?|vials?|units?|appointments? of)\b/i,
  // Not slots on offer: "two sessions open Thursday, then Friday morning".
  /\b(?:\d+|one|two|three|four|five|six|several|a few)\s+(?:sessions?|treatments?|rounds?|peels?)\b(?!\s+(?:open|available|free|left|remaining|spare)\b)[^.?!]{0,40}(?:\bthen\b|\bfollowed by\b|\bafter that\b)/i,
  // A guarantee, by the verb or the word ("we guarantee", "..., guaranteed"),
  // unless it is denied ("we can't guarantee results", "there's no guarantee",
  // "nobody can guarantee results").
  /(?<!\b(?:can'?t|cannot|can not|don'?t|do not|doesn'?t|does not|won'?t|will not|never|no|not|isn'?t|aren'?t|unable to)\s+(?:\w+\s+){0,2})(?<!\b(?:nobody|no one|nothing|none)\s+(?:\w+\s+){0,2})\bguarantee(?:s|d|ing)?\b/i,
  /\byou'?ll\s+(?:definitely|certainly|surely|absolutely|100%|totally)\s+(?:see|notice|love|get)\b/i,
  // The outcome promised in plain words, as the Spanish one below: "you're
  // going to look amazing", "you'll look stunning for the wedding", "you'll
  // love your results", "the results will be perfect" (24 October 2026: an
  // energetic call style made it likelier, and only the Spanish was caught).
  /\b(?:you(?:'re| are)?\s+(?:going to|gonna)|you(?:'ll| will))\s+(?:look|be looking|feel)\s+(?:so\s+|really\s+|absolutely\s+|just\s+|totally\s+)?(?:amazing|stunning|gorgeous|beautiful|incredible|fantastic|perfect|flawless|fabulous|radiant|great|brand new|like new|like a new person|(?:\w+\s+)?(?:years\s+)?younger|natural)\b/i,
  /\byou(?:'ll| will| are going to|'re going to|'re gonna)\s+(?:absolutely\s+|totally\s+|just\s+)?love\s+(?:the|your)\s+results?\b|\bresults?\s+(?:will|are going to)\s+be\s+(?:amazing|perfect|incredible|stunning|flawless|fantastic|great)\b/i,
  // Spanish.
  /(?<![\p{L}])(puede|pueden|debe|deben|tome|tomar|t[óo]mese) (tomar )?(un |una |el |la )?(tylenol|ibuprofeno|paracetamol|aspirina|advil|antihistam[íi]nico)/iu,
  /(?<![\p{L}])(la hinchaz[óo]n|los moretones|el moret[óo]n|los morados|el enrojecimiento|la rojez|el bulto|la inflamaci[óo]n|el dolor|las molestias)[^.?!]{0,60}(es|son|ser[áa]|ser[áa]n) (normal|normales|com[úu]n|comunes|esperad[oa]s?|temporal(es)?)/iu,
  /(?<![\p{L}])(desaparece|desaparecen|se va|se van|bajar[áa]n?|se quita|se quitan)(?![\p{L}])[^.?!]{0,30}(en|despu[ée]s de|al cabo de|dentro de) /iu,
  /(?<![\p{L}])es (normal|com[úu]n|esperado) que/iu,
  /(?<![\p{L}])(p[óo]ngase|ponga|aplique|aplicar|ponerse) (hielo|compresas? fr[íi]as?)|(?<![\p{L}])no (haga|hacer|hagas|realice) ejercicio|(?<![\p{L}])evite (el |la |los |las )?(alcohol|ejercicio|sol|maquillaje|ibuprofeno|aspirina)/iu,
  /(?<![\p{L}])(los )?resultados (duran|durar[áa]n|dura|duraran)|(?<![\p{L}])dura (unos |unas |aproximadamente |alrededor de )?(\d+|un|una|dos|tres|cuatro|seis) (meses|semanas|a[ñn]os)/iu,
  // A guarantee or a promise of the outcome, by the verb or the word ("se lo
  // aseguro", "se lo garantizo", "le garantizamos", "garantizado"), unless
  // denied ("no le puedo garantizar", "nadie puede garantizar", "no hay
  // garantía"), as the English guarantee above.
  /(?<!(?<![\p{L}])(?:no|nadie|nada|nunca|ni|sin|tampoco|jam[áa]s)\s+(?:\p{L}+\s+){0,3})(?<![\p{L}])(?:garantiz\p{L}*|garant[íi]as?|(?:se|te)\s+l[oa]s?\s+(?:aseguro|aseguramos|prometo|prometemos|juro))(?![\p{L}])/iu,
  // The outcome promised in plain words: "va a quedar perfecta", "quedará
  // como nueva", "se verá diez años más joven", "le van a encantar los
  // resultados", "resultados perfectos".
  /(?<![\p{L}])(?:(?:va|vas|van|vamos)\s+a\s+(?:quedar|verse|lucir|ver(?:te|se|la|lo))|quedar[áa]s?n?|se\s+ver[áa]n?|te\s+ver[áa]s|lucir[áa]s?n?)\s+(?:muy\s+|super\s+|s[úu]per\s+|totalmente\s+|completamente\s+|much[oa]\s+)?(?:perfect[oa]s?|como\s+nuev[oa]s?|divin[oa]s?|espectaculares?|incre[íi]bles?|precios[oa]s?|hermos[oa]s?|bell[ií]sim[oa]s?|guap[ií]sim[oa]s?|impecables?|radiantes?|(?:\p{L}+\s+)?(?:a[ñn]os\s+)?m[áa]s\s+j[oó]ven(?:es)?|rejuvenecid[oa]s?|sin\s+arrugas)(?![\p{L}])/iu,
  /(?<![\p{L}])(?:le|te|les)\s+(?:van?\s+a\s+encantar|encantar[áa]n?)\s+(?:los|el|sus|tus)\s+resultados?(?![\p{L}])|(?<![\p{L}])resultados?\s+(?:perfect[oa]s?|asegurad[oa]s?|seguros?|incre[íi]bles?|espectaculares?)(?![\p{L}])|(?<![\p{L}])(?:le|te)\s+quitar[áa]n?\s+(?:\p{L}+\s+)?a[ñn]os(?![\p{L}])/iu,
  // A dose in Spanish said by its count: "cuatro jeringas", "20 unidades", "dos viales", "20 U".
  new RegExp(
    `(?<![\\p{L}\\d])(?:\\d+(?:[.,]\\d+)?\\s*(?:jeringas?|viales?|unidades|ampollas?|cc)|(?!(?:y|un|una|uno)\\s)${ES_WORD}(?:\\s+${ES_WORD})*\\s+(?:jeringas|viales|unidades|ampollas))(?![\\p{L}])`,
    "iu",
  ),
];

/** Whether a reply says anything clinical (the default screen and PLAIN_CLINICAL; see the file header). */
export function clinicalIn(reply: string, facts: ScreenFacts): boolean {
  const text = withoutEveryday(perUnitPrices(withoutOwnWords(reply, facts)));
  if (findClinicalContent({ reply: text }).length > 0) return true;
  return PLAIN_CLINICAL.some((pattern) => !(pattern === UNITLESS_DOSE && facts.businessCounts === true) && pattern.test(text));
}

/** A never-say entry or a reply in the form the list is matched in: normalise(), then a hyphen read as a space. */
function listForm(text: string): string {
  return normalise(text).replace(/-/g, " ").replace(/\s+/g, " ");
}

/**
 * The clinic's own public words, inside which a never-say entry is excused
 * (neverSayIn): its name, and each part of its address split at commas and
 * line breaks, the street also without its number. "Painless Laser Studio"
 * must still be able to say who and where it is with the default "painless"
 * on its list, as the Meta guard's other word checks read past the same
 * words (front-door.ts, withoutOwnWords), and its request-received line must
 * keep the person's name.
 */
export function clinicOwnWords(facts: { clinicName?: string | null; shortName?: string | null; address?: string | null }): string[] {
  const words = [facts.clinicName ?? "", ownShortName(facts) ?? ""];
  for (const part of (facts.address ?? "").split(/[,\n]+/)) {
    words.push(part, part.trim().replace(/^\d+[a-z]?\s+/i, ""));
  }
  return [...new Set(words.map((w) => w.trim()).filter((w) => w !== ""))];
}

/** A whole-word pattern for one phrase in listForm(), global so every occurrence can be read. */
function wholeWords(phrase: string): RegExp {
  return new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(phrase)}(?![\\p{L}\\p{N}])`, "gu");
}

/**
 * Whether a reply contains an entry of a never-say list. Both sides are
 * normalised (case, curly quotes, dashes, a hyphen read as a space, runs of
 * whitespace, a line break among them), and an entry matches where a word
 * starts: "cure" is not in "secure", nor "AI" in "available", while
 * "painless" is still in "painlessly" and "guarantee" in "guaranteed", the
 * forms the prompt's "in any form" means.
 *
 * The clinic's own name and address (clinicOwnWords) excuse an entry only
 * where it lies wholly inside one of them: "Painless Laser Studio" on
 * "Painless Way" can say who and where it is with the default "painless" on
 * its list, and is refused for "it's painless". They are never taken out of
 * the reply before the list is read, so an entry that runs past them is
 * still found ("the best med spa in Austin" in Glow Med Spa's reply, "Laser
 * Studio is the best" in Painless Laser Studio's). An entry that itself
 * names one of those words ("cheapest in Austin", "Glow Med Spa is the
 * best", "Congress Ave") is the clinic saying it does not want them said
 * that way, and is matched as written, with nothing read past.
 *
 * One function for every channel: the Meta front door's guard calls it too
 * (lib/meta/front-door.ts, guardReply), so a phrase refused on a call is
 * refused on Instagram, Messenger and WhatsApp, and the two cannot drift
 * apart.
 */
export function neverSayIn(reply: string, list: readonly string[], ownWords: readonly string[] = []): boolean {
  const entries = withSpanishEquivalents(list);
  // The clinic's own words read the same way, so "Pain-Less Laser" still excuses itself.
  return SPELLINGS.some((form) => {
    const text = form(reply);
    return (form === asWritten || text !== reply) && neverSayInForm(text, entries, ownWords.map(form));
  });
}

/**
 * The Spanish a never-say entry is also matched in (the policy of 21 October
 * 2026): a clinic that can answer in Spanish must not have its list read
 * past because the model said the same thing in Spanish. Each entry is
 * matched as written, always; and where it is one of the stock entries below
 * (the defaults, NEVER_SAY_DEFAULTS in the catalog, and the entries clinics
 * most often add), its Spanish equivalents are matched beside it, the same
 * way: from the start of a word, case and accents aside ("sin dolor",
 * "indoloro" for "painless"; "la más barata" for "cheapest").
 *
 * A clinic's own entry with no mapping here applies as written only: "Dr.
 * Smith is the best" is not translated, and a Spanish reply that says it in
 * Spanish is not refused for it. No machine translation runs on a clinic's
 * words; the clinical screen, which reads Spanish, is still what catches a
 * Spanish promise of safety or results. Keys are in listForm (lower case, a
 * hyphen read as a space); the Spanish is written without accents, because
 * a reply is also read with its accents folded (SPELLINGS).
 */
const NEVER_SAY_SPANISH: Readonly<Record<string, readonly string[]>> = (() => {
  const guaranteed = ["resultados garantizados", "resultado garantizado", "resultados asegurados", "resultado asegurado", "garantizamos resultados", "garantizamos los resultados", "garantizamos el resultado"];
  const cheapest = ["el mas barato", "la mas barata", "los mas baratos", "las mas baratas", "el precio mas bajo", "los precios mas bajos", "mas barato que nadie", "mas barata que nadie"];
  const best = ["la mejor de la ciudad", "el mejor de la ciudad", "los mejores de la ciudad", "las mejores de la ciudad", "la mejor clinica", "el mejor consultorio", "el mejor spa", "la mejor del pueblo", "el mejor del pueblo"];
  const safe = ["completamente segur", "totalmente segur", "absolutamente segur", "100% segur", "cien por ciento segur", "cien por cien segur"];
  return {
    "guaranteed results": guaranteed,
    "results guaranteed": guaranteed,
    "guaranteed": ["garantizad", "garantizamos", "le garantizo", "te garantizo", "se lo garantizo", "se la garantizo"],
    "guarantee": ["garantiz", "garantia"],
    "risk free": ["sin riesgo", "libre de riesgo", "cero riesgo", "ningun riesgo"],
    "completely safe": safe,
    "100% safe": safe,
    "totally safe": safe,
    "no side effects": ["sin efectos secundarios", "sin efectos adversos", "sin efectos colaterales", "no tiene efectos secundarios", "no hay efectos secundarios", "ningun efecto secundario", "cero efectos secundarios"],
    "painless": ["sin dolor", "indolor", "no duele", "no le va a doler", "no te va a doler", "no le dolera", "no te dolera"],
    "pain free": ["sin dolor", "indolor", "libre de dolor"],
    "permanent results": ["resultados permanentes", "resultado permanente", "resultados para siempre", "resultados definitivos", "resultado definitivo"],
    "permanent": ["permanente", "para siempre"],
    "you're a good candidate": ["es buen candidat", "es buena candidat", "es un buen candidat", "es una buena candidat", "eres buen candidat", "eres buena candidat", "eres un buen candidat", "eres una buena candidat", "usted es candidat", "tu eres candidat"],
    "you don't need to see a doctor": ["no necesita ver a un medico", "no necesita ver al medico", "no necesita ir al medico", "no necesita ver a un doctor", "no necesita ver al doctor", "no necesita ir al doctor", "no necesitas ver a un medico", "no necesitas ir al medico", "no necesitas ver a un doctor", "no hace falta ver a un medico", "no hace falta ir al medico", "no hace falta ver a un doctor"],
    "no downtime": ["sin tiempo de recuperacion", "sin tiempo de inactividad", "sin incapacidad", "sin periodo de recuperacion"],
    "best in town": best,
    "the best in town": best,
    "best clinic in town": best,
    "cheapest": cheapest,
    "cheapest in town": cheapest,
    "lowest prices": ["los precios mas bajos", "el precio mas bajo", "los mejores precios"],
    "miracle": ["milagr"],
    "cure": ["cura", "curamos", "curar"],
    "no needles": ["sin agujas"],
  };
})();

/** The list with each stock entry's Spanish equivalents after it (NEVER_SAY_SPANISH); every entry stays as written. */
function withSpanishEquivalents(list: readonly string[]): readonly string[] {
  const out = [...list];
  for (const entry of list) {
    // An entry the clinic wrote with accents ("garantía") is read against the folded reply too.
    if (foldAccents(entry) !== entry) out.push(foldAccents(entry));
    const spanish = NEVER_SAY_SPANISH[listForm(entry).trim()];
    if (spanish) out.push(...spanish);
  }
  return out;
}

/** Single letters with a hyphen, space, dot, slash, star or underscore between, three or more: "p-a-i-n", "c u r e". */
const SPELT_OUT = /(?<![\p{L}\p{N}'’])\p{L}(?:[\s\-_.*·•/|]+\p{L}(?![\p{L}\p{N}])){2,}/gu;

/**
 * The reply as written, and the ways a word can be broken up to slip past
 * the list read back together: a word spelt out letter by letter
 * ("p-a-i-n-l-e-s-s", "p a i n l e s s", "p.a.i.n.l.e.s.s") joined, and a
 * hyphen inside a word dropped ("pain-less"). Each form is read on its own,
 * so a form can only find more, never hide an entry the reply holds as
 * written. NEVER_SAY_PROTECTED is unaffected: none of its sentences spells
 * a word out or hyphenates one.
 */
const asWritten = (text: string): string => text;
/** A spelt-out run joined; an "a" or "I" said before it stays a word of its own ("a p a i n" is "a pain"). */
function joinSpelt(run: string): string {
  const letters = run.replace(/[^\p{L}]/gu, "");
  return /^[ai]\s/i.test(run) && letters.length > 3 ? `${letters[0]} ${letters.slice(1)}` : letters;
}
const SPELLINGS: ReadonlyArray<(text: string) => string> = [
  asWritten,
  (text) => text.replace(SPELT_OUT, joinSpelt),
  (text) => normalise(text).replace(/(?<=\p{L})-(?=\p{L})/gu, ""),
  // Accents folded, so "indoloro", "más barata" and "garantía" are read with or without them.
  foldAccents,
];

/** The text with its accents and tildes taken off: "más" → "mas", "garantía" → "garantia". */
function foldAccents(text: string): string {
  return text.normalize("NFD").replace(/\p{M}+/gu, "").normalize("NFC");
}

function neverSayInForm(reply: string, list: readonly string[], ownWords: readonly string[]): boolean {
  const text = ` ${listForm(reply)} `;
  const own = [...new Set(ownWords.map((w) => listForm(w).trim()).filter(Boolean))];
  // Where the clinic's own words stand in the reply, as [start, end) spans.
  const ownSpans: Array<[number, number]> = [];
  for (const words of own) {
    for (const m of text.matchAll(wholeWords(words))) ownSpans.push([m.index, m.index + m[0].length]);
  }
  return list.some((phrase) => {
    const p = listForm(phrase).trim();
    if (p === "") return false;
    const excuses = own.some((words) => wholeWords(words).test(p)) ? [] : ownSpans;
    // Every occurrence, overlapping ones included, so one inside the name
    // cannot hide one outside it.
    const entry = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(p)}`, "gu");
    for (let m = entry.exec(text); m; m = entry.exec(text)) {
      const start = m.index;
      const end = start + m[0].length;
      if (!excuses.some(([s, e]) => s <= start && end <= e)) return true;
      entry.lastIndex = start + 1;
    }
    return false;
  });
}

/**
 * What the assistant must always be free to say, whatever a never-say list
 * holds: that it is an AI assistant and not a person, in the words the
 * opening lines (lib/compliance/disclosure.ts) and the prompts' rule for
 * when someone asks use, and that an emergency is for 911 (written "9-1-1"
 * on a call, so the voice says "nine-one-one"). The opening line
 * is the code's and goes out whatever the list holds; an answer to "are you
 * a real person?" is the model's, and an entry such as "assistant" would
 * otherwise turn it into a fixed line that does not say AI at all. Some
 * state laws want the disclosure whenever a person asks.
 */
export const NEVER_SAY_PROTECTED: readonly string[] = [
  "I'm an AI assistant, not a person.",
  "I am an AI assistant, not a human.",
  "I'm an automated assistant, not a human.",
  "I am an automated assistant, not a person.",
  "Call 911.",
  "Hang up and call 9-1-1 now.",
];

/**
 * Whether a never-say entry would stop the assistant saying one of
 * NEVER_SAY_PROTECTED: refused when the clinic saves it (validateNeverSay),
 * and left out when the list is read for a conversation, on every channel
 * (neverSayWithDefaults), for one saved before this check.
 */
export function neverSayBlocksDisclosure(entry: string): boolean {
  return NEVER_SAY_PROTECTED.some((sentence) => neverSayIn(sentence, [entry]));
}

// -----------------------------------------------------------------------------
// A booking said to be made
// -----------------------------------------------------------------------------

const BOOKED = "(?:booked(?: in)?|confirmed|scheduled|reserved|pencil(?:l)?ed in|locked in|secured|held|on hold)";
const DAY_OR_TIME =
  "(?:you\\b|(?:mon|tues|wednes|thurs|fri|satur|sun)day\\b|(?:mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)\\b|tomorrow\\b|today\\b|tonight\\b|next\\b|this\\b|the\\s+\\d|\\d|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\b)";

/**
 * A reply that says a booking exists, or that the assistant is making one:
 * "you're booked", "your booking is confirmed for Mon 3pm", "confirmed for
 * Tuesday", "I've put you down for 3pm", "I'll book you in", "you're all set
 * for Tuesday", a confirmation number; and in Spanish, "su cita está
 * confirmada", "le he reservado", "confirmada para el martes". Read on the
 * normalised reply, sentence by sentence (confirmsBooking).
 */
const CONFIRMATIONS: readonly RegExp[] = [
  new RegExp(`\\b(?:you're|you are|you've been|you have been|they're|they are)\\s+(?:now\\s+|all\\s+)?${BOOKED}\\b`),
  new RegExp(
    `\\b(?:(?:your|the|this|that)\\s+(?:appointment|booking|slot|visit|consultation|session|reservation|time)|it|that|this|everything)\\s*(?:is|'s|has been|was|have been)\\s+(?:now\\s+|all\\s+)?(?:${BOOKED}|made|all set|in the (?:diary|calendar|books?))\\b`,
  ),
  /\b(?:i've|i have|we've|we have|i|we)\s+(?:just\s+|now\s+|already\s+|gone ahead and\s+)?(?:booked|confirmed|scheduled|reserved|secured|locked in|pencil(?:l)?ed)\s+(?:you|your|it|that|this|a|an|the)\b/,
  /\b(?:i've|i have|we've|we have)\s+(?:got|put|added|pencil(?:l)?ed)\s+you\s+(?:down|in)\b/,
  /\b(?:i'll|i will|let me|we'll|we will)\s+(?:go ahead and\s+)?(?:book|reserve|schedule|lock in|pencil)\s+(?:you|that|it|this|your|a|an|the)\b/,
  new RegExp(`\\b${BOOKED}\\s+for\\s+${DAY_OR_TIME}`),
  new RegExp(`\\b(?:all set|good to go)\\s+for\\s+(?:${DAY_OR_TIME}|your)`),
  /\bconfirmation (?:number|code|email|text|message)\b/,
  // "All booked!", "all confirmed", with no subject at all.
  /(?:^|[,!.;:-]\s*|\b(?:done|great|perfect|ok|okay|right|and)\s*[,!-]?\s*)all (?:booked|confirmed|scheduled|reserved|sorted)\b/,
  // "You have an appointment Thursday at 3pm", "you've got a slot on Monday".
  new RegExp(`\\byou(?:'ve| have)(?: got)?\\s+(?:an?|your|the)\\s+(?:appointment|booking|slot|consultation|visit|reservation|session)\\s+(?:(?:on|for|at|with us on)\\s+)?${DAY_OR_TIME}`),
  /\b(?:i'm|i am|we're|we are|i've|i have|we've|we have)\s+(?:now\s+|just\s+)?(?:holding|held|put a hold on)\b/,
  /(?<![\p{L}])(?:est[áa]|queda|qued[óo]|ha quedado|ha sido|fue)\s+(?:ya\s+)?(?:confirmad[oa]|reservad[oa]|agendad[oa]|programad[oa]|apuntad[oa])(?![\p{L}])/u,
  /(?<![\p{L}])(?:le|te|lo|la)\s+(?:he|hemos)\s+(?:reservado|agendado|confirmado|apuntado|programado)(?![\p{L}])/u,
  /(?<![\p{L}])(?:confirmad[oa]|reservad[oa]|agendad[oa])\s+para\s+(?:el|la|ma[ñn]ana|hoy|las?)(?![\p{L}])/u,
  // "Su cita queda para el martes", "su cita está lista", "su cita para el
  // martes está lista", "la cita ya quedó hecha": the appointment said to
  // stand, with up to a few words between.
  /(?<![\p{L}])(?:su|tu|la|sus|tus|las)\s+(?:cita|citas|reserva|reservas|consulta|sesi[oó]n|turno|hora)(?![\p{L}])(?:(?!(?<![\p{L}])(?:no|todav[ií]a|a[uú]n|cuando|si|ser[aá])(?![\p{L}]))[^.!?]){0,40}?(?<![\p{L}])(?:ya\s+)?(?:queda|quedan|qued[oó]|quedaron|est[aá]|est[aá]n|ha\s+quedado|fue)\s+(?:ya\s+)?(?:list[oa]s?|hech[oa]s?|apartad[oa]s?|separad[oa]s?|registrad[oa]s?|guardad[oa]s?|asegurad[oa]s?|anotad[oa]s?|para\s+(?:el|la|las|ma[ñn]ana|hoy|esta|este|el\s+pr[oó]ximo))(?![\p{L}])/u,
  // The assistant saying it booked, or books now: "ya le reservé el martes",
  // "le confirmo la cita del lunes" (not "le confirmo que abrimos el lunes"),
  // "le aparté la hora", "ya le agendamos", "lo dejo agendado".
  /(?<![\p{L}])(?:le|te|lo|la|les|se\s+la|se\s+lo)\s+(?:reserv[eé]|agend[eé]|apart[eé]|separ[eé]|anot[eé]|apunt[eé]|program[eé]|confirm[eé]|registr[eé]|bloque[eé])(?![\p{L}])/u,
  /(?<![\p{L}])(?:le|te|les|se\s+la|se\s+lo)\s+(?:confirmo|reservo|agendo|aparto|separo|anoto|apunto|programo|bloqueo)(?![\p{L}])(?!\s+(?:que|si|cuando|en\s+cuanto)(?![\p{L}]))/u,
  /(?<![\p{L}])ya\s+(?:le|te|lo|la|les)\s+(?:reservamos|agendamos|apartamos|separamos|anotamos|apuntamos|programamos|confirmamos|registramos)(?![\p{L}])/u,
  /(?<![\p{L}])(?:lo|la|le|te)\s+dej[oé]\s+(?:ya\s+)?(?:agendad[oa]|reservad[oa]|apuntad[oa]|anotad[oa]|confirmad[oa]|apartad[oa])(?![\p{L}])/u,
  // "Le voy a reservar el martes", "voy a agendarle": the assistant making one, as "I'll book you in".
  /(?<![\p{L}])(?:(?:le|te|se\s+la|se\s+lo)\s+(?:voy|vamos)\s+a\s+(?:reservar|agendar|apartar|separar|anotar|apuntar|programar|bloquear)|(?:voy|vamos)\s+a\s+(?:reservar|agendar|apartar|separar|anotar|apuntar|programar|bloquear)(?:le|te|la|lo|sela|selo))(?![\p{L}])/u,
  // "Listo, ya está", "todo listo para el martes", "número de confirmación".
  /(?<![\p{L}])(?:todo\s+list[oa]|ya\s+est[aá]\s+list[oa])\s+para\s+(?:el|la|su|tu|ma[ñn]ana|hoy|las?)(?![\p{L}])|(?<![\p{L}])(?:n[uú]mero|c[oó]digo|correo|mensaje)\s+de\s+confirmaci[oó]n(?![\p{L}])/u,
];

/** Words before a confirmation that make it a condition or a time to come: "once you're booked", "until it's confirmed". */
const NOT_YET = /\b(?:once|when|until|till|after|as soon as|if|before|unless|whether)\b|(?<![\p{L}])(?:cuando|una vez|hasta que|si|antes de que|en cuanto)(?![\p{L}])/u;
/** Words right before one that put it in the future or deny it: "will be confirmed for", "isn't booked for". */
const FUTURE_OR_NOT =
  /(?:\b(?:will|'ll|would|to|can|could|should|must|may|might)\s+(?:be\s+|get\s+)?|\b(?:not|never|no longer)\s+(?:\w+\s+)?|n't\s+(?:\w+\s+)?|(?<![\p{L}])no\s+(?:\p{L}+\s+)?)$/u;

/**
 * Whether the reply says a booking is made, or that the assistant is making
 * one. A question asks ("would you like to be booked for Tuesday?"), a
 * condition or a time to come promises nothing ("once it's confirmed", "the
 * team will confirm it within a day", "it will be confirmed for you"), and a
 * denial is no confirmation ("it isn't booked for Tuesday yet").
 */
export function confirmsBooking(reply: string): boolean {
  for (const sentence of normalise(reply).split(/(?<=[.!?])\s+/)) {
    const said = sentence.trim();
    if (!said || said.endsWith("?") || said.startsWith("¿")) continue;
    for (const pattern of CONFIRMATIONS) {
      const match = pattern.exec(said);
      if (!match) continue;
      const before = said.slice(0, match.index);
      if (NOT_YET.test(before) || FUTURE_OR_NOT.test(before)) continue;
      return true;
    }
  }
  return false;
}

// -----------------------------------------------------------------------------
// Contact promised after the conversation, an alert claimed, other people
// -----------------------------------------------------------------------------

/** Words before a match that deny it: "we don't send reminders", "I can't text you". */
const DENIED = /\b(?:can'?t|cannot|can not|don'?t|do not|doesn'?t|does not|won'?t|will not|never|no|not|isn'?t|aren'?t|unable to|no longer)\s+(?:\w+\s+){0,4}$/;
/**
 * The same in Spanish, so "no le mandamos recordatorios" and "no puedo
 * compartir nada sobre otros pacientes" are denials. A "no" of courtesy
 * denies nothing: "no se preocupe ya notifiqué a la clínica" is a claim.
 */
const DENIED_ES = /(?<![\p{L}])(?:no|nunca|jam[aá]s|tampoco|ni)\s+(?:\p{L}+\s+){0,4}$/u;
/** A "no" of courtesy, read past before either denial is looked for. */
const COURTESY_NO = /(?<![\p{L}])no\s+(?:se\s+preocupe|te\s+preocupes|se\s+preocupen|dude|dudes|duden|hay\s+problema)(?![\p{L}])/gu;

/** Each sentence of the normalised reply that is not a question, with whether a pattern is said in it unless denied. */
function saidUndenied(reply: string, patterns: readonly RegExp[]): boolean {
  for (const sentence of normalise(reply).split(/(?<=[.!?])\s+/)) {
    const said = sentence.trim();
    if (!said) continue;
    for (const pattern of patterns) {
      const m = pattern.exec(said);
      if (!m) continue;
      const before = said.slice(0, m.index).replace(COURTESY_NO, " ");
      if (!DENIED.test(before) && !DENIED_ES.test(before)) return true;
    }
  }
  return false;
}

const CONTACT_VERB =
  "(?:text|txt|sms|call|ring|phone|message|email|e-mail|whatsapp|dm|remind|follow up|follow-up|check in|check back|reach out|get back|contact|send you|touch base)";
const AT_A_SET_TIME =
  "(?:tomorrow|today|tonight|later|this (?:morning|afternoon|evening|week)|next (?:week|month|\\w+day)|on (?:mon|tues|wednes|thurs|fri|satur|sun)day|(?:mon|tues|wednes|thurs|fri|satur|sun)day|in (?:an?|one|two|a few|\\d+) (?:minutes?|hours?|days?)|at \\d|before your (?:visit|appointment))";

/** A set time in Spanish: "mañana", "esta tarde", "el lunes", "en una hora", "a las tres". */
const ES_SET_TIME =
  "(?:ma[ñn]ana|hoy|esta\\s+(?:tarde|noche|semana)|m[aá]s\\s+tarde|luego|en\\s+(?:un\\s+rato|una\\s+hora|unos?\\s+\\p{L}+\\s+(?:minutos|horas|d[ií]as)|\\d+\\s+(?:minutos|horas|d[ií]as))|(?:el\\s+)?(?:lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo)|la\\s+pr[oó]xima\\s+semana|a\\s+las?\\s+\\S+|antes\\s+de\\s+su\\s+(?:cita|visita))";
/** The practice calling: "la llamamos", "le volveremos a llamar". */
const ES_WE_CALL =
  "(?<![\\p{L}])(?:le|la|lo|te|les)\\s+(?:llamamos|llamaremos|vamos\\s+a\\s+llamar|volvemos\\s+a\\s+llamar|volveremos\\s+a\\s+llamar|marcamos|marcaremos)(?![\\p{L}])";

/**
 * Contact after the conversation, promised (CLAUDE.md, "Inbound only": no
 * texts, reminders, follow-ups or call-backs, and v1 places no calls):
 *   - the assistant itself contacting the person ("I'll text you later", "I'll
 *     call you back", "let me email you", "I'll follow up next week");
 *   - the practice ("we") texting, reminding, following up or checking in,
 *     or calling back at a set time ("we'll call you back tomorrow");
 *   - a text, an SMS or a reminder, from anyone ("you'll get a reminder
 *     text", "we'll send you a reminder").
 * What the prompt has the assistant say passes: "the team will get back to
 * you within a day", "a person from our team will call you", "I'll pass
 * this on". So does a denial ("we don't send reminders").
 */
const OUTBOUND_PROMISES: readonly RegExp[] = [
  new RegExp(`\\b(?:i'll|i will|i'm going to|i am going to|i can|let me|i'd be happy to|i shall)\\s+(?:also\\s+|just\\s+|personally\\s+|quickly\\s+)?${CONTACT_VERB}\\b`),
  new RegExp(`\\b(?:we'll|we will|we're going to|we are going to|we can|we'd be happy to)\\s+(?:also\\s+|just\\s+)?(?:text|txt|sms|whatsapp|remind|follow up|follow-up|check in|check back|touch base|send you (?:an?\\s+)?(?:text|sms|reminder|message|follow-up))\\b`),
  new RegExp(`\\b(?:we'll|we will|we're going to|we are going to)\\s+(?:give you a\\s+)?(?:call|ring|phone)(?: you)?(?: back)?\\s+${AT_A_SET_TIME}`),
  /\b(?:reminder|confirmation|follow-up|follow up)\s+(?:text|sms|message|call|email)s?\b|\b(?:text|sms|email|message) (?:reminder|confirmation)s?\b/,
  /\b(?:send|sends|sending|get|gets|receive|receives|text|texts)\s+(?:you\s+)?(?:an?\s+|the\s+)?(?:quick\s+)?(?:reminder|text|sms|text message)s?\b/,
  /\b(?:text|sms|remind)\s+you\b/,
  // A text or a reminder told to be expected: "expect a text from us tomorrow".
  /\bexpect\s+(?:an?\s+|the\s+|some\s+)?(?:quick\s+)?(?:text|sms|reminder|follow-up|follow up)s?\b/,
  // Spanish. The assistant itself: "le llamo mañana", "le escribiré", "le
  // mando un mensaje de texto", "voy a llamarle", "le puedo recordar". Not the
  // present "le escribo" or "le recuerdo que", said inside the conversation.
  /(?<![\p{L}])(?:le|la|lo|te|les)\s+(?:llamo|llamar[eé]|vuelvo\s+a\s+llamar|volver[eé]\s+a\s+llamar|escribir[eé]|recordar[eé]|contacto|contactar[eé]|marco|marcar[eé]|dar[eé]\s+seguimiento)(?![\p{L}])/u,
  /(?<![\p{L}])(?:le|la|lo|te|les)\s+(?:mando|mandar[eé]|env[ií]o|enviar[eé]|mandamos|mandaremos|enviamos|enviaremos|(?:voy|vamos)\s+a\s+(?:mandar|enviar))\s+(?:un\s+|una\s+|el\s+|la\s+|su\s+)?(?:mensaje|mensajito|texto|sms|recordatorio|whatsapp|correo|e-?mail)(?![\p{L}])/u,
  /(?<![\p{L}])(?:(?:voy|vamos)\s+a|puedo|podr[ií]a|podemos|podr[ií]amos)\s+(?:volver\s+a\s+)?(?:llamarl[ea]s?|llamarte|escribirl[ea]s?|escribirte|recordarl[ea]s?|recordarte|contactarl[ea]s?|contactarte|marcarl[ea]s?|marcarte)(?![\p{L}])/u,
  /(?<![\p{L}])(?:le|la|lo|te|les)\s+(?:(?:voy|vamos)\s+a|puedo|podr[ií]a)\s+(?:volver\s+a\s+)?(?:llamar|escribir|recordar|contactar|marcar)(?![\p{L}])/u,
  // The practice: reminding, writing, following up, always; calling, at a set time ("mañana la llamamos").
  /(?<![\p{L}])(?:le|la|lo|te|les)\s+(?:recordaremos|(?:vamos)\s+a\s+recordar|escribiremos|(?:vamos)\s+a\s+escribir|daremos\s+seguimiento|damos\s+seguimiento)(?![\p{L}])/u,
  new RegExp(
    `(?<![\\p{L}])(?=(?:le|la|lo|te|les)\\s)(?:(?<=(?<![\\p{L}])${ES_SET_TIME}(?![\\p{L}])[^.!?]*)${ES_WE_CALL}|${ES_WE_CALL}(?=[^.!?]*(?<![\\p{L}])${ES_SET_TIME}(?![\\p{L}])))`,
    "u",
  ),
  // A text or a reminder, from anyone: "recibirá un recordatorio", "le llegará un mensaje de texto", "un mensaje de recordatorio".
  /(?<![\p{L}])(?:recibir[aá]n?|recibir[aá]s|le\s+llegar[aá]n?|te\s+llegar[aá]n?|les\s+llegar[aá]n?|le\s+(?:enviar|mandar)[aá]n?|te\s+(?:enviar|mandar)[aá]n?|espere|esperar)\s+(?:un\s+|una\s+|el\s+|nuestro\s+)?(?:mensaje\s+de\s+texto|mensajito|sms|recordatorio|texto|whatsapp)(?![\p{L}])|(?<![\p{L}])(?:mensajes?|sms|correos?|llamadas?|textos?)\s+(?:de\s+)?(?:recordatorio|seguimiento)(?![\p{L}])|(?<![\p{L}])recordatorios?\s+(?:por\s+)?(?:mensaje|texto|sms|correo|whatsapp)(?![\p{L}])/u,
];


export function promisesOutbound(reply: string): boolean {
  return saidUndenied(reply, OUTBOUND_PROMISES);
}

/** The practice's people in Spanish, with the article or "a" before: "a la clínica", "al equipo", "la doctora". */
const TEAM_ES =
  "(?<![\\p{L}])(?:a\\s+|al\\s+|del\\s+)?(?:(?:la|el|los|las|nuestro|nuestra|nuestros|su)\\s+)?(?:equipo|cl[ií]nica|personal|recepci[oó]n|consultorio|doctor(?:a|es)?|m[eé]dic[oa]s?|enfermer[oa]s?|especialista|encargad[oa]|gerente|due[ñn][oa]|guardia|alguien)(?![\\p{L}])";
const TEAM = "(?:the |your |our )?(?:team|clinic|practice|staff|front desk|reception|doctor|nurse|clinicians?|injector|provider|on-call|manager|owner|someone)";

/**
 * The team said to be told already: "I've told the team", "I've alerted the
 * clinic", "the team has been notified", "I've let the staff know", "I've
 * passed this on to the team". The future ("I'll let the team know", "I'll
 * pass this on") promises what the adapter does with a handoff, and passes.
 */
const ALERT_CLAIMS: readonly RegExp[] = [
  new RegExp(`\\b(?:i've|i have|we've|we have|i|i just|i've just|i have just|i've already|i have already|i've now)\\s+(?:just\\s+|already\\s+|now\\s+)?(?:told|alerted|notified|informed|messaged|emailed|paged|flagged (?:this|it|your \\w+) (?:to|with|for)|escalated (?:this|it|your \\w+) to|contacted|warned)\\s+${TEAM}\\b`),
  new RegExp(`\\b(?:i've|i have|we've|we have)\\s+(?:just\\s+|already\\s+|now\\s+)?(?:let|made)\\s+${TEAM}\\s+(?:know|aware)\\b`),
  new RegExp(`\\b(?:i've|i have|we've|we have)\\s+(?:just\\s+|already\\s+|now\\s+)?(?:passed|sent|forwarded|handed)\\s+(?:this|it|that|your (?:\\w+\\s+)?(?:message|details|request|question|concern|info(?:rmation)?))\\s+(?:on\\s+|over\\s+|along\\s+)?to\\s+${TEAM}\\b`),
  new RegExp(`\\b${TEAM}\\s+(?:has|have|'s)\\s+(?:just\\s+|already\\s+|now\\s+)?been\\s+(?:told|alerted|notified|informed|messaged|paged|made aware)\\b`),
  new RegExp(`\\b${TEAM}\\s+(?:knows|is aware|are aware|is on (?:it|their way)|is (?:now )?looking into it)\\b`),
  // Spanish: "ya notifiqué a la clínica", "le avisé al equipo", "he informado
  // a la doctora", "ya pasé su mensaje al equipo", "el equipo ya fue
  // notificado", "la clínica ya lo sabe". The future ("le avisaré al equipo")
  // and the present ("le aviso al equipo") promise the handoff, and pass.
  new RegExp(`(?<![\\p{L}])(?:(?:le|les)\\s+)?(?:notifiqu[eé]|avis[eé]|alert[eé]|inform[eé]|contact[eé]|escrib[ií]|llam[eé]|puse\\s+al\\s+tanto)\\s+(?:ya\\s+)?${TEAM_ES}`, "u"),
  new RegExp(`(?<![\\p{L}])(?:ya\\s+)?(?:(?:le|les|lo|la)\\s+)?(?:he|hemos)\\s+(?:ya\\s+)?(?:notificado|avisado|alertado|informado|contactado|escrito|llamado|puesto\\s+al\\s+tanto)\\s+(?:ya\\s+)?${TEAM_ES}`, "u"),
  new RegExp(`(?<![\\p{L}])ya\\s+(?:(?:le|les)\\s+)?(?:avisamos|notificamos|alertamos|informamos|contactamos)\\s+${TEAM_ES}`, "u"),
  new RegExp(`(?<![\\p{L}])(?:pas[eé]|envi[eé]|mand[eé]|reenvi[eé]|transmit[ií]|(?:he|hemos)\\s+(?:pasado|enviado|mandado|reenviado|transmitido))\\s+(?:su|tu|sus|tus|el|la|los|las|este|esta)\\s+(?:\\p{L}+\\s+)?(?:mensaje|solicitud|informaci[oó]n|datos|consulta|caso|pregunta|petici[oó]n|detalles)\\s+(?:\\p{L}+\\s+)?${TEAM_ES}`, "u"),
  new RegExp(`${TEAM_ES}\\s+(?:ya\\s+)?(?:fue|fueron|ha\\s+sido|han\\s+sido|est[aá]|est[aá]n)\\s+(?:ya\\s+)?(?:notificad[oa]s?|avisad[oa]s?|alertad[oa]s?|informad[oa]s?|enterad[oa]s?|al\\s+tanto)(?![\\p{L}])`, "u"),
  new RegExp(`${TEAM_ES}\\s+ya\\s+(?:lo\\s+)?(?:sabe|saben|est[aá]\\s+en\\s+camino|lo\\s+est[aá]\\s+revisando)(?![\\p{L}])`, "u"),
];

export function claimsAlert(reply: string): boolean {
  return saidUndenied(reply, ALERT_CLAIMS);
}

/**
 * Other people, the minimal rule (no names list could be complete):
 *   - another patient spoken of ("another patient, Jane, had the same",
 *     "one of our clients", "a previous customer"), unless the reply says it
 *     cannot speak of them ("I can't share anything about other patients");
 *   - a patient or client named or called something ("a client named Ana");
 *   - the practice compared with another, a comparative put against a place
 *     or a proper name ("cheaper than Glow Med Spa", "better than other
 *     clinics", "the best in town" is the never-say list's to hold). Not a
 *     comparison with a time or a figure ("better than expected", "more
 *     affordable than last year", "cheaper than $200").
 */
const OTHER_PARTY: readonly RegExp[] = [
  /\b(?:another|another of (?:our|my|the)|a previous|a former|a past|an earlier|other|one of (?:our|my|the)|some of (?:our|my|the))\s+(?:patients?|clients?|customers?)\b/,
  /\b(?:patients?|clients?|customers?)\s+(?:named|called|by the name of)\b/,
  // Spanish: "otra paciente", "uno de nuestros clientes", "una antigua clienta", "una paciente llamada Ana".
  /(?<![\p{L}])(?:otr[oa]s?|un[oa]?\s+de\s+(?:nuestr[oa]s|mis|l[oa]s)|algun[oa]s?\s+de\s+(?:nuestr[oa]s|mis|l[oa]s)|un[oa]?\s+(?:ex|antigu[oa]|anterior))\s+(?:pacientes?|clientes?|clientas?)(?![\p{L}])|(?<![\p{L}])(?:un|una)\s+(?:paciente|cliente|clienta)\s+(?:anterior|previ[oa])(?![\p{L}])/u,
  /(?<![\p{L}])(?:pacientes?|clientes?|clientas?)\s+(?:llamad[oa]s?|de\s+nombre)(?![\p{L}])/u,
];
const COMPARATIVE =
  /\b(?:cheaper|better|more affordable|less expensive|lower[- ]priced|more experienced|safer|more qualified|nicer|cleaner|faster|friendlier|more professional|superior)\s+(?:to|than)\s+(\S+(?:\s+\S+)?)/gi;
// A day, a month or a time of day is capitalised or plain, and no rival:
// "Would Monday be better than Tuesday?", "Are mornings better than other
// days?" are scheduling, and RIVAL's capital letter would otherwise read them.
const NOT_A_RIVAL = new RegExp(
  "^(?:expected|usual|average|before|ever|last|that|this|you|we|it|they|most of|anything|nothing|the (?:price|cost|list|menu|average|usual|last|first)|a (?:year|month|week)|\\$|\\d|i |what|people|waiting|paying|going|doing" +
    "|(?:mon|tues|wednes|thurs|fri|satur|sun)days?\\b|(?:january|february|march|april|may|june|july|august|september|october|november|december)\\b" +
    "|(?:today|tomorrow|tonight|mornings?|afternoons?|evenings?|weekends?|weekdays?|next|later|earlier|now)\\b|other (?:days?|times?|slots?|dates?|weeks?|months?)\\b)",
  "i",
);
const RIVAL = /^(?:other|another|any(?:one|where)? other|most (?:other )?(?:clinics|spas|places|practices)|the (?:competition|competitors?|clinic|spa|place|practice|guys|one) |competitors?|the rest|everyone else|places|clinics|spas|practices|\p{Lu})/u;

/**
 * The comparison in Spanish: "somos mejores que la clínica de al lado", "más
 * baratos que otras clínicas", "superiores a la competencia". Not "es mejor
 * que venga temprano", the impersonal "it is better that" (no subject before
 * the "es"), nor a time or a figure ("mejor que el martes", "más barato que
 * el año pasado", "más barato que $200").
 */
const COMPARATIVE_ES =
  /(?<![\p{L}])(mejor(?:es)?|m[aá]s\s+(?:barat[oa]s?|econ[oó]mic[oa]s?|accesibles?|segur[oa]s?|experimentad[oa]s?|profesionales?|limpi[oa]s?|r[aá]pid[oa]s?|calificad[oa]s?|cualificad[oa]s?|amables?|modern[oa]s?)|superiores?|menos\s+car[oa]s?)\s+(?:que|a)\s+(\S+(?:\s+\S+)?)/giu;
const IMPERSONAL_BETTER = /(?:^|[,;:¿¡]\s*|(?<![\p{L}])(?:pero|y|as[ií]\s+que|entonces|creo\s+que|quiz[aá]s?|tal\s+vez|lo\s+que)\s+)(?:es|ser[ií]a|ser[aá]|era|fue)\s+$/iu;
const NOT_A_RIVAL_ES =
  /^(?:(?:el|la|los|las|este|esta|otro|otra|otros|otras)\s+)?(?:lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bados?|domingos?|ma[ñn]anas?|tardes?|noches?|semanas?|mes(?:es)?|a[ñn]os?|d[ií]as?|horas?|horarios?|fechas?|esperado|habitual|normal|de\s+costumbre|anterior|pasad[oa]|precio|costo|promedio|enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)(?![\p{L}])|^(?:lo|antes|ayer|hoy|nunca|siempre|usted|ustedes|yo|nosotr[oa]s|eso|esto|nada|esperar|pagar|venir|\$|\d)/iu;
const RIVAL_ES =
  /^(?:otr[oa]s?|la\s+(?:cl[ií]nica|competencia|de\s+al\s+lado)|el\s+(?:consultorio|spa|de\s+al\s+lado|resto|centro)|los\s+(?:dem[aá]s|otros|consultorios|competidores)|las\s+(?:dem[aá]s|otras|cl[ií]nicas)|cualquier|cl[ií]nicas|consultorios|spas|competidores|la\s+mayor[ií]a|\p{Lu})/u;

/**
 * "Other patients often ask about parking": what people ask the practice, in
 * general, names no one and says nothing about anyone's care. Read past only
 * as a whole sentence that opens that way and goes on in a few lower-case
 * words with no digit, no apostrophe, no comma, no "and"/"but"/"so" to carry
 * an answer, and none of the clinic's service names, so a name, a figure
 * or a treatment put in it ("Other patients often ask about Botox", "...ask
 * whether Jane's filler lasted") is still read as another patient spoken of.
 */
const GENERAL_ASK =
  /^(?:[Oo]ther|[Mm]any|[Ss]ome|[Mm]ost) (?:patients|clients|customers|people) (?:often|also|usually|commonly|frequently|sometimes|typically) (?:ask|wonder|want to know) (?:about|whether|if|how|what|when|where|why) (?!(?:[a-z]+ )*?(?:and|but|so|because|which|yet|then|while|answer|answers)\b)[a-z ]{1,60}[.!]?$/;

/** The same in Spanish: "Otros pacientes suelen preguntar por el estacionamiento." */
const GENERAL_ASK_ES =
  /^(?:[Oo]tros|[Oo]tras|[Mm]uchos|[Mm]uchas|[Aa]lgunos|[Aa]lgunas) (?:pacientes|clientes|clientas|personas) (?:(?:nos )?(?:suelen|tambi[eé]n|a menudo|con frecuencia|normalmente|frecuentemente) )?(?:nos )?(?:preguntan|suelen preguntar|quieren saber) (?:por|sobre|si|c[oó]mo|qu[eé]|cu[aá]ndo|d[oó]nde|cu[aá]nto) (?!(?:[\p{Ll}]+ )*?(?:y|pero|porque|que|entonces|aunque|respuesta)(?![\p{L}]))[\p{Ll} ]{1,60}[.!]?$/u;

function withoutGeneralAsks(reply: string, services: readonly { name: string }[]): string {
  const names = services.map((s) => s.name.trim().toLowerCase()).filter((n) => n.length > 2);
  return reply
    .split(/(?<=[.!?])\s+/)
    .filter((sentence) => {
      const said = sentence.trim();
      const general = GENERAL_ASK.test(said.replace(/[‘’ʼ]/g, "'")) || GENERAL_ASK_ES.test(said);
      return !(general && !names.some((n) => said.toLowerCase().includes(n)));
    })
    .join(" ");
}

export function mentionsOtherParty(
  reply: string,
  facts: { clinicName?: string | null; services?: readonly { name: string }[] } = {},
): boolean {
  if (saidUndenied(withoutGeneralAsks(reply, facts.services ?? []), OTHER_PARTY)) return true;
  const own = (facts.clinicName ?? "").trim();
  const text = own ? reply.replace(new RegExp(escapeRegExp(own), "gi"), "us") : reply;
  for (const m of text.matchAll(COMPARATIVE)) {
    const target = m[1]!;
    if (NOT_A_RIVAL.test(target)) continue;
    if (RIVAL.test(target)) return true;
  }
  for (const m of text.matchAll(COMPARATIVE_ES)) {
    const target = m[2]!;
    if (/^mejor$/i.test(m[1]!) && IMPERSONAL_BETTER.test(text.slice(0, m.index))) continue;
    if (NOT_A_RIVAL_ES.test(target)) continue;
    if (RIVAL_ES.test(target)) return true;
  }
  return false;
}

export function guardAssistantReply(
  reply: string,
  facts: Pick<AssistantFacts, "neverSay"> & ScreenFacts & Partial<Pick<AssistantFacts, "urgentAlertsReady">>,
  turn: ReplyTurn = {},
): GuardVerdict {
  const text = normalise(reply);
  if (!text.trim()) return { ok: false, reason: "empty" };
  // English entries matched as written, in a reply in either language (see the file header).
  if (neverSayIn(reply, facts.neverSay, clinicOwnWords(facts))) return { ok: false, reason: "never_say" };
  const allowed = allowedAmounts(facts);
  for (const cents of amountsIn(reply)) {
    if (!allowed.has(cents)) return { ok: false, reason: "price" };
  }
  if (freeOffList(reply, facts)) return { ok: false, reason: "price" };
  if (PAYMENT_ASK.test(reply) && /\b(your|share|give|read|tell|provide|send|enter)\b/i.test(reply)) {
    return { ok: false, reason: "payment_details" };
  }
  if (CARD_ASK.some((pattern) => pattern.test(reply))) return { ok: false, reason: "payment_details" };
  if (PAYMENT_ASK_ES.test(reply) && PAYMENT_ASK_ES_VERB.test(reply)) return { ok: false, reason: "payment_details" };
  if (CARD_ASK_ES.some((pattern) => pattern.test(reply))) return { ok: false, reason: "payment_details" };
  if (HIPAA_CLAIM.test(reply) || HIPAA_CLAIM_ES.test(reply)) return { ok: false, reason: "hipaa_claim" };
  if (claimsToBeHuman(reply, facts)) return { ok: false, reason: "human_claim" };
  // The practice's own words (its menu, its people, its city) are no language either way.
  const knownTerms = [facts.clinicName, facts.shortName ?? undefined, facts.address, ...facts.services.map((s) => s.name), ...(facts.providerNames ?? [])];
  if (messageLanguage(reply, { knownTerms }) === "other") return { ok: false, reason: "language" };
  if (clinicalIn(reply, facts)) return { ok: false, reason: "clinical" };
  if (promisesOutbound(reply)) return { ok: false, reason: "outbound_promise" };
  // Only an alert really queued for this turn, at a clinic whose alerts reach it, may be said to be sent.
  if (!(turn.alertQueued === true && facts.urgentAlertsReady === true) && claimsAlert(reply)) {
    return { ok: false, reason: "alert_claim" };
  }
  if (mentionsOtherParty(reply, facts)) return { ok: false, reason: "other_party" };
  // Last, so a reply refused for anything above keeps that reason.
  if (turn.bookingWritten !== true && confirmsBooking(reply)) return { ok: false, reason: "booking_confirmation" };
  return { ok: true };
}

// -----------------------------------------------------------------------------
// A claim to be a person
// -----------------------------------------------------------------------------

/** Who answers at a practice, as a role the assistant could claim: "the receptionist", "a member of the team". */
const HUMAN_ROLE =
  "(?:person|human(?: being)?|receptionist|front desk|nurse|staff member|member of (?:the\\s+)?(?:staff|team)|team member)";
const ARTICLE = "(?:(?:a|an|the|your|one of the|part of the|on the|a member of(?: the)?)\\s+)?";
const REAL = "(?:real\\s+|actual\\s+|live\\s+)?";

/**
 * The assistant claiming to be a person, or not to be an AI, in its own
 * words: "I'm a real person", "I am human", "I'm the receptionist", "this is
 * a human", "a real person here", "you're talking to a real person", "I'm
 * not a bot", "I'm not an AI", "this isn't an automated system"; and in
 * Spanish, "soy una persona real", "no soy un bot", "está hablando con una
 * persona". Each needs the assistant as its subject, so an offer of a person
 * passes ("a person from our team will call you", "if you'd rather talk to
 * a real person, just ask", "our staff can help"), and so does the honest
 * answer ("I'm an AI assistant, not a real person").
 */
const HUMAN_CLAIMS: readonly RegExp[] = [
  new RegExp(`\\b(?:i['’]?m|i am)\\s+(?:(?:just|only|actually|really|definitely|totally|very much)\\s+)?${ARTICLE}${REAL}${HUMAN_ROLE}\\b(?!['’]s)`, "i"),
  new RegExp(`\\b(?:this is|you['’]ve reached)\\s+${ARTICLE}${REAL}${HUMAN_ROLE}\\b(?!['’]s)`, "i"),
  new RegExp(`\\byou(?:['’]re| are)\\s+(?:talking|speaking|chatting)\\s+(?:to|with)\\s+${ARTICLE}${REAL}${HUMAN_ROLE}\\b(?!['’]s)`, "i"),
  /\b(?:a\s+)?real (?:person|human)\s+(?:here|speaking|answering)\b/i,
  /\b(?:i['’]?m|i am)\s+not\s+(?:an?\s+)?(?:ai|a\.i\.|bot|robot|chatbot|machine|computer|automated|virtual|recording)\b/i,
  /\b(?:this|it)\s+(?:is\s+not|isn['’]t|['’]s\s+not)\s+(?:an?\s+)?(?:ai|a\.i\.|bot|robot|chatbot|machine|computer|automated|recording)\b/i,
  /\byou(?:['’]re| are)\s+not\s+(?:talking|speaking|chatting)\s+(?:to|with)\s+(?:an?\s+)?(?:ai|a\.i\.|bot|robot|chatbot|machine|computer)\b/i,
  /(?<![\p{L}])(?<!(?<![\p{L}])no\s+)soy\s+(?:una?\s+|la\s+|el\s+|de\s+la\s+|del\s+)?(?:persona(?:\s+real)?|humano|humana|ser humano|recepcionista|recepci[oó]n|enfermer[oa]|(?:parte|miembro)\s+del\s+(?:equipo|personal)|(?:del|de\s+la)\s+(?:equipo|personal|recepci[oó]n))(?![\p{L}])/iu,
  /(?<![\p{L}])(?:le|te)\s+(?:habla|atiende)\s+(?:una?\s+|la\s+|el\s+)?(?:persona(?:\s+real)?|humano|humana|recepcionista|enfermer[oa])(?![\p{L}])|(?<![\p{L}])una\s+persona\s+real\s+(?:le|te)\s+(?:habla|atiende|responde)(?![\p{L}])/iu,
  /(?<![\p{L}])no\s+soy\s+(?:una?\s+)?(?:ia|i\.a\.|inteligencia artificial|bot|robot|m[áa]quina|programa|asistente\s+(?:virtual|autom[áa]tic[oa]|de\s+ia))(?![\p{L}])/iu,
  /(?<![\p{L}])est[áa]s?\s+hablando\s+con\s+(?:una?\s+)?(?:persona(?:\s+real)?|humano|humana|recepcionista|enfermer[oa])(?![\p{L}])/iu,
];

/** A capitalised word in a name: "Sarah", "Mary-Jane", "O'Neil". */
const NAME = "(\\p{Lu}[\\p{Ll}'’-]+)";
/** Where a claim names a person who works at the practice: "Sarah at the front desk", "Sarah from the team". */
const AT_THE_PRACTICE = "(?:at|from|on|in|of|with)\\s+(?:the|our)\\s+(?:front desk|reception|team|staff|office|practice|clinic)\\b";

/** The same in Spanish: "de la recepción", "del equipo", "en la clínica". */
const ES_AT_THE_PRACTICE = "(?:de|del|en|desde)\\s+(?:la\\s+|el\\s+|nuestra\\s+|nuestro\\s+)?(?:recepci[oó]n|equipo|personal|oficina|consultorio|cl[ií]nica|front desk)";

/** The same, with a person's name in it: "I'm Sarah, a real person", "you're talking to Sarah at the front desk". */
const NAMED_CLAIMS: readonly RegExp[] = [
  new RegExp(
    `(?:\\b[Ii]['’]?m|\\b[Ii] am|\\b[Mm]y name is|\\b[Tt]his is)\\s+${NAME}(?:\\s*,\\s*|\\s+)(?:${ARTICLE}${REAL}${HUMAN_ROLE}\\b|${AT_THE_PRACTICE})`,
    "u",
  ),
  new RegExp(`\\b[Yy]ou(?:['’]re| are)\\s+(?:talking|speaking|chatting)\\s+(?:to|with)\\s+${NAME}(?=\\s*(?:[,.!?]|$)|\\s+${AT_THE_PRACTICE})`, "u"),
  new RegExp(`(?:^|[.!?]\\s+)${NAME}\\s+(?:here|speaking)\\b(?=\\s*(?:[,.!?—–-]|$|from|at|with|on))`, "u"),
  // Spanish: "Soy María, de la recepción", "me llamo Ana y soy la recepcionista", "le habla María, de la clínica".
  new RegExp(
    `(?<![\\p{L}])(?:[Ss]oy|[Mm]e llamo|[Mm]i nombre es|[Ll]e habla|[Tt]e habla|[Ll]e atiende|[Tt]e atiende)\\s+${NAME}(?:\\s*,\\s*|\\s+)(?:y\\s+soy\\s+)?(?:${ES_AT_THE_PRACTICE}|(?:una?\\s+|la\\s+|el\\s+)?(?:persona(?:\\s+real)?|humano|humana|recepcionista|enfermer[oa]|miembro\\s+del\\s+(?:equipo|personal)))(?![\\p{L}])`,
    "u",
  ),
  new RegExp(`(?:^|[.!?¡¿]\\s*|,\\s*)(?:[Ll]e|[Tt]e)\\s+habla\\s+${NAME}(?=\\s*(?:[,.!?]|$|de\\s|del\\s|desde\\s))`, "u"),
  new RegExp(`(?<![\\p{L}])[Ee]st[áa]s?\\s+hablando\\s+con\\s+${NAME}(?=\\s*(?:[,.!?]|$)|\\s+${ES_AT_THE_PRACTICE})`, "u"),
];

/** Capitalised words a claim may follow without being a person's name: the assistant's own name, days, words that open a sentence. */
const NOT_A_PERSON = new Set([
  "aya", "ai", "an", "a", "the", "your", "our", "sorry", "happy", "glad", "afraid", "here", "not",
  "just", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday", "today",
]);

/** Words before a claim that make it a question asked back or a report of one: "you asked whether I'm a real person". */
const ASKED = /\b(?:if|whether|asked|wondering|wonder)\b|(?<![\p{L}])(?:pregunt\p{L}*|saber\s+si)(?![\p{L}])/iu;

/**
 * Whether the reply has the assistant say it is a person, or not an AI
 * (HUMAN_CLAIMS, NAMED_CLAIMS). The clinic's own name, and the assistant's,
 * are never a person's ("This is Glow Clinic", "you're talking to AYA").
 * One check for every channel: the Meta front door's guard asks it too.
 */
export function claimsToBeHuman(reply: string, facts: { clinicName?: string | null } = {}): boolean {
  const text = reply.replace(/\s+/g, " ");
  const clinicFirst = (facts.clinicName ?? "").trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  for (const sentence of text.split(/(?<=[.!?])\s+/)) {
    for (const pattern of HUMAN_CLAIMS) {
      const m = pattern.exec(sentence);
      if (m && !ASKED.test(sentence.slice(0, m.index))) return true;
    }
    for (const pattern of NAMED_CLAIMS) {
      const m = pattern.exec(sentence);
      if (!m) continue;
      const name = m[1]!.toLowerCase();
      if (NOT_A_PERSON.has(name) || name === clinicFirst) continue;
      if (!ASKED.test(sentence.slice(0, m.index))) return true;
    }
  }
  return false;
}

// -----------------------------------------------------------------------------
// The clinic's greeting
// -----------------------------------------------------------------------------

/**
 * A greeting that undoes the AI line before it: one that has AYA say she is a
 * person or a member of staff ("I'm Sarah, a real person", "this is the
 * front desk", "you're talking to a real person"), or that she is not an AI.
 * An offer of a person is no claim to be one ("if you'd rather talk to a
 * real person, just ask").
 */
const UNDOES_DISCLOSURE: readonly RegExp[] = [
  /\b(?:i['’]?m|i am|this is|my name is|you['’]re (?:talking|speaking|chatting) (?:to|with)|you['’]ve reached)\s+(?:[\p{L}'’-]+,?\s+)?(?:(?:just|only|actually|really)\s+)?(?:(?:a|an|the|your|one of the|part of the|on the|a member of(?: the)?)\s+)?(?:real\s+|actual\s+|live\s+)?(?:person|human(?: being)?|receptionist|front desk|nurse|staff member|member of (?:the\s+)?(?:staff|team)|team member)\b/iu,
  /\bnot (?:an? )?(?:ai|bot|robot|machine|computer|automated)\b/i,
  /\b(?:a\s+)?real (?:person|human)\s+(?:here|speaking|answering)\b|^\W*real (?:person|human)\b/i,
];

export function undoesDisclosure(greeting: string): boolean {
  return UNDOES_DISCLOSURE.some((pattern) => pattern.test(greeting));
}

export type GreetingRefusal = GuardRefusal | "undoes_disclosure";

/**
 * The clinic's own greeting, said after the locked AI line on every call and
 * shown after it in every web chat (opening.ts): the same guard as any reply
 * (guardAssistantReply: the never-say list, a price off the menu, card
 * details, "HIPAA compliant", clinical content, a language no screen reads,
 * a booking said to be made), and nothing that undoes the AI line. Asked
 * when the clinic saves it (lib/setup/settings.ts) and again each time it
 * is said, since the menu and the never-say list can change after it was
 * saved; refused there, the default greeting is said instead.
 */
export function guardGreeting(
  greeting: string,
  facts: Pick<AssistantFacts, "neverSay"> & ScreenFacts,
): { ok: true } | { ok: false; reason: GreetingRefusal } {
  if (undoesDisclosure(greeting)) return { ok: false, reason: "undoes_disclosure" };
  return guardAssistantReply(greeting, facts);
}

/**
 * The line a refused reply becomes, in the language of the reply it
 * replaces: English, the default and byte for byte what it always was, or
 * Spanish where the refused reply was Spanish (turn.ts asks messageLanguage),
 * so a person answered in Spanish is not handed an English line.
 */
export function guardedLine(reason: GuardRefusal, clinicName: string, language: "en" | "es" = "en", spoken = false): string {
  if (spoken) return SPOKEN_GUARD_LINES[language][reason] ?? SPOKEN_GUARD_LINES[language].other;
  if (language === "es") return guardedLineEs(reason, clinicName);
  if (reason === "price") {
    return `I can't give a price for that one, but the team at ${clinicName} can go through it with you at a consultation. Would you like me to pass on a request for one?`;
  }
  if (reason === "clinical") {
    return `That's a question for the clinicians at ${clinicName}, and I can't advise on it here. They can go through it with you at a consultation. Would you like me to pass on a request for one?`;
  }
  if (reason === "payment_details") {
    return `Please don't share any card or bank details with me. The practice handles payment securely itself.`;
  }
  if (reason === "human_claim") {
    return `I'm an AI assistant, not a person. The team at ${clinicName} can help with anything I can't, and they get back to people within a day.`;
  }
  if (reason === "booking_confirmation") {
    return `I can't confirm appointments myself, but I can pass your request to the team at ${clinicName}, who confirm every booking and get back to people within a day.`;
  }
  return `I'm not able to help with that here, but I can pass your details to the team at ${clinicName}, who will get back to you within a day.`;
}

/**
 * What is said instead of a guard line the person has just heard (turn.ts):
 * a refusal said twice in a row is a loop, and the person is no closer to
 * anyone who can help. It hands over instead, and the turn raises the
 * handover (the clinic's L11 alert and Bookings' Needs you), so "the team
 * will get back to you" is a promise the clinic is told about.
 */
export function movingOnLine(clinicName: string, language: "en" | "es" = "en", spoken = false): string {
  if (spoken) {
    return language === "es"
      ? "Paso sus datos al equipo y le responderán en un día. ¿Algo más en lo que pueda ayudarle?"
      : "Let me pass your details to the team, and they'll get back to you within a day. Anything else I can help with?";
  }
  return language === "es"
    ? `Para que le atiendan bien, pasaré sus datos al equipo de ${clinicName}, que le responderá en un día. ¿Hay algo más en lo que pueda ayudarle?`
    : `Let me make sure you're looked after: I'll pass your details to the team at ${clinicName}, who will get back to you within a day. Is there anything else I can help with?`;
}

/**
 * guardedLine on a call (owner, 24 October 2026: the written lines ran to 35
 * words and named the clinic each time, which on a call sounds like a
 * menu). The same meaning and the same offer, in the words a person says;
 * the caller already knows which practice they rang. Spanish in formal
 * "usted", awaiting a native speaker's review.
 */
const SPOKEN_GUARD_LINES: Readonly<Record<"en" | "es", Partial<Record<GuardRefusal, string>> & { other: string }>> = {
  en: {
    price: "I don't have a price for that one, but the team can go through it at a consultation. Want me to request one?",
    clinical: "That one's really for the clinicians. Want me to put in a request for a consultation so they can go through it with you?",
    payment_details: "Oh, no card details with me, please. The practice handles payment securely itself.",
    human_claim: "I'm an AI assistant, not a person. The team can help with anything I can't, and they get back to people within a day.",
    booking_confirmation: "I can't confirm it myself, but I'll pass your request to the team, and they'll confirm within a day.",
    other: "That's not one I can help with, but I can pass your details to the team, and they'll get back to you within a day.",
  },
  es: {
    price: "No tengo un precio para eso, pero el equipo se lo explica en una consulta. ¿Quiere que pase una solicitud?",
    clinical: "Eso es para los especialistas de la clínica. ¿Quiere que pase una solicitud de consulta para que lo vean con usted?",
    payment_details: "Por favor, no me dé datos de tarjeta. La clínica gestiona los pagos de forma segura.",
    human_claim: "Soy un asistente de IA, no una persona. El equipo puede ayudarle con lo que yo no pueda, y responde en un día.",
    booking_confirmation: "No puedo confirmarla yo, pero paso su solicitud al equipo, que la confirma en un día.",
    other: "Con eso no puedo ayudarle aquí, pero puedo pasar sus datos al equipo, que le responderá en un día.",
  },
};

/** guardedLine in Spanish, the same lines said the same way, formal "usted". */
function guardedLineEs(reason: GuardRefusal, clinicName: string): string {
  if (reason === "price") {
    return `No puedo darle un precio para eso, pero el equipo de ${clinicName} puede revisarlo con usted en una consulta. ¿Quiere que les pase una solicitud de consulta?`;
  }
  if (reason === "clinical") {
    return `Esa es una pregunta para el equipo clínico de ${clinicName}, y no puedo aconsejarle sobre eso aquí. Pueden revisarlo con usted en una consulta. ¿Quiere que les pase una solicitud de consulta?`;
  }
  if (reason === "payment_details") {
    return `Por favor, no me dé ningún dato de pago, ni de tarjeta ni del banco. La clínica gestiona los pagos de forma segura por su cuenta.`;
  }
  if (reason === "human_claim") {
    return `Soy un asistente de IA, no una persona. El equipo de ${clinicName} puede ayudarle con lo que yo no pueda, y responde en un día.`;
  }
  if (reason === "booking_confirmation") {
    return `No puedo confirmar citas yo mismo, pero puedo pasar su solicitud al equipo de ${clinicName}, que confirma cada cita y responde en un día.`;
  }
  return `No puedo ayudarle con eso aquí, pero puedo pasar sus datos al equipo de ${clinicName}, que le responderá en un día.`;
}

// -----------------------------------------------------------------------------
// Card numbers, inbound
// -----------------------------------------------------------------------------

function luhn(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/**
 * A run of digits a card number can be written in: groups of digits with up
 * to three spaces, full stops, commas, hyphens or slashes between them, as a
 * recogniser punctuates a number read aloud ("4242, 4242, 4242, 4242.",
 * "4,242 4,242", double spaces) and as a person types one, with the expiry
 * and the security code said straight after it ("... 4242 12/28 123").
 */
const DIGIT_RUN = /\d(?:[\s.,/\-\u2010-\u2015]{0,3}\d)*/g;
const DIGIT_GROUP = /\d+/g;

/** The first digit of every major issuer's card numbers: Mastercard's 2-series, Amex, Diners and JCB, Visa, Mastercard, Discover. */
function issuerDigit(digits: string): boolean {
  return digits[0]! >= "2" && digits[0]! <= "6";
}

/**
 * Where the card numbers in `text` are, as [start, end) spans: each from the
 * first digit of a number that passes the Luhn check to the end of its run,
 * so an expiry or a security code said after the number goes with it.
 *
 * A run of 13 to 19 digits is tested whole, as it always was. Then every
 * stretch of its digit groups holding 13 to 19 digits is tested: dropping
 * groups from the front finds a number said straight after a phone number,
 * dropping them from the back finds one followed by its expiry or code. Such
 * a stretch must also start with an issuer's digit (2 to 6) and take in no
 * part of a phone number's shape; and nothing tested, whole or not, takes in
 * a slash or a date's separators (shapes). A group of 17 digits or more, a
 * number with its code typed onto it, is tested at each length from 13 to
 * 19 from its start.
 *
 * A phone number, a date, a price or a time on its own holds fewer than 13
 * digits and is never tested; a 3-3-4 phone number next to a date written
 * with slashes, hyphens or full stops, or next to another 3-3-4 phone
 * number, is never read as a card. A run of 13 to 19 digits tested whole can
 * still pass by chance, one time in ten, as it always could ("415 555 0192
 * 94110"); it is cut, and the person asked not to share card details, the
 * safe way to be wrong. Not across a comma or a full stop, though, when a
 * phone number's shape is in it: "415-555-0192, 94117" is a number and a ZIP
 * code, and cutting it would lose the number someone left to be called on.
 *
 * `crossing`, for the pass over a transcript's turns joined together
 * (cutCardNumbersAcrossTurns): only a number that spans one of these
 * offsets is returned, and only at 15 or 16 digits, the lengths of nearly
 * every card in use, with an issuer's first digit, so that the end of one
 * message and the start of the next are seldom read as one card.
 */
function cardNumberSpans(text: string, crossing?: readonly number[]): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  for (const run of text.matchAll(DIGIT_RUN)) {
    const groups = [...run[0].matchAll(DIGIT_GROUP)].map((g) => ({
      start: run.index + g.index,
      end: run.index + g.index + g[0].length,
      digits: g[0],
    }));
    if (groups.reduce((n, g) => n + g.digits.length, 0) < 13) continue;
    const { breakBefore, inPhone } = shapes(text, groups);
    // A comma or full stop inside the run: ordinary writing joins a phone
    // number to what follows it that way ("415-555-0192, 94117"), so a run
    // across one is never read as a card through a phone number's shape.
    const punctuated = /[.,]/.test(run[0]);
    // Groups s to e, or only the first `digits.length` digits of group s.
    const passes = (digits: string, s: number, e: number, to: number, whole: boolean): boolean => {
      const from = groups[s]!.start;
      if (crossing) {
        if (digits.length !== 15 && digits.length !== 16) return false;
        if (!crossing.some((at) => from < at && at < to)) return false;
      } else if (whole) {
        return luhn(digits) && !(punctuated && inPhone.slice(s, e + 1).some(Boolean));
      }
      return issuerDigit(digits) && !inPhone.slice(s, e + 1).some(Boolean) && luhn(digits);
    };
    let cutFrom: number | null = null;
    for (let s = 0; s < groups.length && cutFrom === null; s += 1) {
      const first = groups[s]!;
      let digits = "";
      for (let e = s; e < groups.length; e += 1) {
        if (e > s && breakBefore[e]) break;
        digits += groups[e]!.digits;
        if (digits.length > 19) break;
        if (digits.length >= 13 && passes(digits, s, e, groups[e]!.end, s === 0 && e === groups.length - 1)) {
          cutFrom = first.start;
          break;
        }
      }
      for (let n = 13; cutFrom === null && first.digits.length >= 17 && n <= Math.min(19, first.digits.length - 1); n += 1) {
        if (passes(first.digits.slice(0, n), s, s, first.start + n, false)) cutFrom = first.start;
      }
    }
    if (cutFrom !== null) spans.push([cutFrom, run.index + run[0].length]);
  }
  return spans;
}

/**
 * What in a run of digit groups is not part of a card. `breakBefore`: the
 * separator before the group is a slash, or one of a date's ("12-03-2026",
 * "2026.12.03"), which no card number is written across. `inPhone`: the
 * group is part of a phone number's 3-3-4 shape, after an optional 1, with
 * one and the same space, hyphen or full stop between ("415-555-0192",
 * "1 415 555 0192"), which only a run tested whole may take in, as it always
 * could; so two phone numbers side by side are never read as one card.
 */
function shapes(text: string, groups: readonly { start: number; end: number; digits: string }[]): { breakBefore: boolean[]; inPhone: boolean[] } {
  const sep = groups.map((g, i) => (i === 0 ? "" : text.slice(groups[i - 1]!.end, g.start)));
  const len = groups.map((g) => g.digits.length);
  const breakBefore = sep.map((s) => s.includes("/"));
  const inPhone = groups.map(() => false);
  for (let i = 0; i < groups.length; i += 1) {
    if (i + 2 < groups.length && sep[i + 1] === sep[i + 2] && (sep[i + 1] === "-" || sep[i + 1] === ".")) {
      const [a, b, c] = [len[i]!, len[i + 1]!, len[i + 2]!];
      if ((a <= 2 && b <= 2 && (c === 2 || c === 4)) || (a === 4 && b <= 2 && c <= 2)) breakBefore[i + 1] = breakBefore[i + 2] = true;
    }
    for (const shape of [[3, 3, 4], [1, 3, 3, 4]]) {
      if (i + shape.length > groups.length || !shape.every((n, k) => len[i + k] === n)) continue;
      const between = shape.slice(1).map((_, k) => sep[i + k + 1]);
      if ([" ", "-", "."].includes(between[0]!) && between.every((s) => s === between[0])) {
        for (let k = 0; k < shape.length; k += 1) inPhone[i + k] = true;
      }
    }
  }
  return { breakBefore, inPhone };
}

const CARD_REMOVED = "[card number removed]";

/**
 * The text with every card number cut out, and whether there was one
 * (cardNumberSpans says what is taken for one). The live path's cut: what it
 * leaves reaches the model and the transcript.
 */
export function cardNumberIn(text: string): { text: string; found: boolean } {
  const spans = cardNumberSpans(text);
  let cut = text;
  for (const [start, end] of [...spans].reverse()) cut = cut.slice(0, start) + CARD_REMOVED + cut.slice(end);
  // Then a number said in words, which a recogniser often writes as words.
  const words = spokenCardSpans(cut);
  for (const [start, end] of [...words].reverse()) cut = cut.slice(0, start) + CARD_REMOVED + cut.slice(end);
  return { text: cut, found: spans.length > 0 || words.length > 0 };
}

// -----------------------------------------------------------------------------
// Card numbers said in words
// -----------------------------------------------------------------------------
//
// A recogniser writes a number read aloud as words as often as digits: "four
// two four two, four two four two, ...", "cuatro dos cuatro dos ...", or in
// pairs, "forty-two forty-two ...", "cuarenta y dos cuarenta y dos ...". A
// run of such words, digits mixed in, with only spaces, commas, full stops or
// hyphens between, is counted in digits: a single digit word ("four", "oh",
// "cero") is one, a teen or a tens word ("twelve", "forty", "forty-two",
// "doce", "cuarenta y dos", "veintidós") two. A run of SPOKEN_CARD_DIGITS or
// more digits, two words of it at least, is cut whole, with no Luhn check: a
// recogniser mishears one word in a long run often enough that a check would
// let a real card through. A 10-digit phone number (11 with its leading "one")
// is under the line and passes; a card (13 to 19 digits) is over it. The
// cost, the safe way to be wrong: a 12-digit international number read as
// words, or two phone numbers read back to back with no word between them, is
// cut too, and the person asked not to share card details. Per message only:
// a number read in words across turns is not joined (cutCardNumbersAcrossTurns
// joins digits).

/** The fewest digits a run said in words must hold to be cut as a card. */
export const SPOKEN_CARD_DIGITS = 12;

const EN_DIGIT_WORDS = "zero|oh|one|two|three|four|five|six|seven|eight|nine";
const EN_TWO_DIGIT = "ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen";
const EN_TENS = "twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety";
const ES_DIGIT_WORDS = "cero|uno|dos|tres|cuatro|cinco|seis|siete|ocho|nueve";
const ES_TWO_DIGIT =
  "diez|once|doce|trece|catorce|quince|diecis[eé]is|diecisiete|dieciocho|diecinueve|veinte|veinti(?:uno|d[oó]s|tr[eé]s|cuatro|cinco|s[eé]is|siete|ocho|nueve)";
const ES_TENS = "treinta|cuarenta|cincuenta|sesenta|setenta|ochenta|noventa";
/**
 * One token of a run, its two-digit forms first so "forty-two" is one token
 * of two digits, not two; each closed by a word boundary, so a run ends where
 * its last token does and nothing is tried twice.
 */
const SPOKEN_TOKEN =
  `(?:(?:${EN_TENS})(?:[\\s-]+(?:one|two|three|four|five|six|seven|eight|nine))?|(?:${ES_TENS})(?:\\s+y\\s+(?:uno|dos|tres|cuatro|cinco|seis|siete|ocho|nueve))?|${EN_TWO_DIGIT}|${ES_TWO_DIGIT}|${EN_DIGIT_WORDS}|${ES_DIGIT_WORDS}|\\d+)(?![\\p{L}\\d])`;
const SPOKEN_RUN = new RegExp(`(?<![\\p{L}\\d])${SPOKEN_TOKEN}(?:[\\s,.\\-]{1,3}${SPOKEN_TOKEN})*`, "giu");
const SPOKEN_TOKEN_ONE = new RegExp(SPOKEN_TOKEN, "giu");
const ONE_DIGIT_WORD = new RegExp(`^(?:${EN_DIGIT_WORDS}|${ES_DIGIT_WORDS})$`, "iu");

/** Where the card numbers said in words are, as [start, end) spans (see above). */
function spokenCardSpans(text: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  for (const run of text.matchAll(SPOKEN_RUN)) {
    let digits = 0;
    let words = 0;
    for (const token of run[0].matchAll(SPOKEN_TOKEN_ONE)) {
      const said = token[0];
      if (/^\d+$/.test(said)) {
        digits += said.length;
        continue;
      }
      words += 1;
      digits += ONE_DIGIT_WORD.test(said) ? 1 : 2;
    }
    if (words >= 2 && digits >= SPOKEN_CARD_DIGITS) spans.push([run.index, run.index + run[0].length]);
  }
  return spans;
}

/**
 * Every card number cut from the person's turns of a transcript, one read
 * out across turns included ("my card is 4242 4242", the assistant answers,
 * "4242 4242"), which no single turn holds whole. Each person turn is cut
 * on its own as cardNumberIn cuts it; then the person's turns are read
 * joined, past whatever the assistant said between them, and each part of a
 * number found across them is cut from the turn that holds it. Run where
 * the transcript is assembled for the email (queueTranscriptEmail, before
 * it is sealed, and renderTranscriptEmail), the one place every channel's
 * turns are seen together.
 */
export function cutCardNumbersAcrossTurns<T extends { speaker: "assistant" | "person"; text: string }>(turns: readonly T[]): T[] {
  const out = turns.map((turn) => (turn.speaker === "person" ? { ...turn, text: cardNumberIn(turn.text).text } : { ...turn }));
  // The person's turns, trimmed and joined by one space, and where each sits in the join.
  const placed: { index: number; from: number; length: number; at: number }[] = [];
  let joined = "";
  out.forEach((turn, index) => {
    if (turn.speaker !== "person") return;
    const from = turn.text.length - turn.text.trimStart().length;
    const length = turn.text.trim().length;
    if (length === 0) return;
    if (joined) joined += " ";
    placed.push({ index, from, length, at: joined.length });
    joined += turn.text.slice(from, from + length);
  });
  if (placed.length < 2) return out;
  const spans = cardNumberSpans(joined, placed.slice(1).map((p) => p.at - 1));
  // Last first, so the offsets of the cuts still to make stand.
  for (const [start, end] of spans.reverse()) {
    for (const p of [...placed].reverse()) {
      // This turn's part of the number, from its first digit to its last:
      // the punctuation either side of it stays with the turn.
      const part = joined.slice(Math.max(start, p.at), Math.min(end, p.at + p.length));
      const first = part.search(/\d/);
      if (first < 0) continue;
      const last = part.search(/\d\D*$/) + 1;
      const turn = out[p.index]!;
      const local = p.from + (Math.max(start, p.at) - p.at) + first;
      turn.text = turn.text.slice(0, local) + CARD_REMOVED + turn.text.slice(local + (last - first));
    }
  }
  return out;
}
