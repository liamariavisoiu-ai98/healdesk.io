import { findClinicalContent, messageLanguage } from "@healdesk/catalog";

import type { AssistantFacts } from "./facts";

/**
 * The deterministic checks around the model on a call or a web chat
 * (CLAUDE.md, "Guardrails": enforced in code around the model, never left to
 * a prompt).
 *
 * Inbound, before the model: a card number is cut out of what the person
 * said, so it reaches neither the model nor the transcript email, and they
 * are told why (cardNumberIn).
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
 *     the tool layer wrote no booking (ReplyTurn, confirmsBooking): the
 *     brain has no booking tools yet, so it takes a request and the team
 *     confirms it, and a reply saying otherwise becomes that line.
 * A refused reply is replaced by a fixed line; nothing of it is sent.
 *
 * The limit of the never-say list: its entries are the clinic's own words, in
 * English, and they are matched as written, from the start of a word,
 * excused only where they fall wholly inside the clinic's own name or
 * address and never when they name it themselves (neverSayIn). A Spanish
 * reply is refused when it contains an entry's English text, and not when it
 * says the same thing in Spanish; the clinical screen, which reads Spanish,
 * is what catches a Spanish promise of safety or results. No entry may stop
 * the assistant saying it is an AI assistant, or pointing to 911
 * (NEVER_SAY_PROTECTED).
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
  | "empty";

export type GuardVerdict = { ok: true } | { ok: false; reason: GuardRefusal };

/**
 * What the tool layer did on the turn the reply answers. A reply may say a
 * booking is made only on a turn where the tool layer wrote one (CLAUDE.md:
 * bookings are written only by the fixed tool layer, and the slot is held
 * before anything confirming is said). The brain has no booking tools yet
 * (turn.ts), so no turn writes one, and every confirmation is refused.
 */
export type ReplyTurn = { bookingWritten?: boolean };

function normalise(text: string): string {
  return text
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[‐‑‒–—]/g, "-")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

/** Every amount a reply may name: the configured prices and deposits. */
function allowedAmounts(facts: Pick<AssistantFacts, "services">): Set<number> {
  const amounts = new Set<number>();
  for (const s of facts.services) {
    for (const v of [s.priceFromUsd, s.priceToUsd, s.depositUsd]) {
      if (typeof v === "number" && Number.isFinite(v)) amounts.add(Math.round(v * 100));
    }
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
  for (const pattern of [DOLLARS, SPOKEN_DOLLARS]) {
    for (const match of text.matchAll(pattern)) {
      const whole = Number(match[1]!.replace(/,/g, ""));
      const cents = match[2] ? Number(match[2].padEnd(2, "0")) : 0;
      const thousands = match[3] ? 1000 : 1;
      out.push(Math.round((whole * thousands) * 100 + cents));
    }
  }
  return [...out, ...spokenAmountsIn(text)];
}

const PAYMENT_ASK = /\b(card number|credit card|debit card|card details|cvv|cvc|security code|expir(y|ation) date|bank (account|details)|routing number)\b/i;
const HIPAA_CLAIM = /\bhipaa[- ]?(compliant|certified|approved)\b/i;

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
  Partial<Pick<AssistantFacts, "clinicName" | "address" | "requirements" | "providerNames">>;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The reply with the clinic's own words blanked: its name, its service names,
 * its address and the questions its booking requirements ask, all screened
 * or written by the practice, not by the model.
 */
function withoutOwnWords(reply: string, facts: ScreenFacts): string {
  const own = [
    facts.clinicName ?? "",
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
  /\b(a |the )?(list|names?) of (any |all |your |the )?(medications?|medicines|meds|allergies)\b/gi,
  /\b(any|your) allergies (we|you|I|the team) should (note|know|pass on|be aware of)\b/gi,
];

function withoutEveryday(text: string): string {
  return EVERYDAY.reduce((out, pattern) => out.replace(pattern, " "), text);
}

/** Words a reply about a treatment's aftermath is made of. */
const AFTERMATH =
  "bruis\\w*|swelling|swollen|puff(y|iness)|redness|tenderness|soreness|sore|tingling|numbness|itch\\w*|lumps?|bumps?|flaking|peeling|scabbing|irritation";

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
  // A dose without its unit: "about 20", "20U", "2 syringes".
  /(?<!\b(open|opens|opening|close|closes|closing|until|till|from|at|by|after|before|since|arrive|starts?|ends?|takes|lasts|wait|waits)\s)\b(about|around|roughly|approximately|typically|usually)\s\d+\b(?!\s*(%|percent|minutes?|mins?|hours?|hrs?|days?|weeks?|months?|years?|am|pm|a\.m\.|p\.m\.|o'?clock|people|patients|clients|spaces?|spots?|cars?|miles?|km|blocks?|dollars|bucks|usd|seconds?|openings?|slots?|appointments?|times?|seats?|left|available|-minute|-hour|:\d))/i,
  /\b\d+\s?u\b(?!\.?\s?s\.)|\b\d+\s(syringes?|vials?|ccs?)\b/i,
  // Spanish.
  /(?<![\p{L}])(puede|pueden|debe|deben|tome|tomar|t[óo]mese) (tomar )?(un |una |el |la )?(tylenol|ibuprofeno|paracetamol|aspirina|advil|antihistam[íi]nico)/iu,
  /(?<![\p{L}])(la hinchaz[óo]n|los moretones|el moret[óo]n|los morados|el enrojecimiento|la rojez|el bulto|la inflamaci[óo]n|el dolor|las molestias)[^.?!]{0,60}(es|son|ser[áa]|ser[áa]n) (normal|normales|com[úu]n|comunes|esperad[oa]s?|temporal(es)?)/iu,
  /(?<![\p{L}])(desaparece|desaparecen|se va|se van|bajar[áa]n?|se quita|se quitan)(?![\p{L}])[^.?!]{0,30}(en|despu[ée]s de|al cabo de|dentro de) /iu,
  /(?<![\p{L}])es (normal|com[úu]n|esperado) que/iu,
  /(?<![\p{L}])(p[óo]ngase|ponga|aplique|aplicar|ponerse) (hielo|compresas? fr[íi]as?)|(?<![\p{L}])no (haga|hacer|hagas|realice) ejercicio|(?<![\p{L}])evite (el |la |los |las )?(alcohol|ejercicio|sol|maquillaje|ibuprofeno|aspirina)/iu,
  /(?<![\p{L}])(los )?resultados (duran|durar[áa]n|dura|duraran)|(?<![\p{L}])dura (unos |unas |aproximadamente |alrededor de )?(\d+|un|una|dos|tres|cuatro|seis) (meses|semanas|a[ñn]os)/iu,
];

/** Whether a reply says anything clinical (the default screen and PLAIN_CLINICAL; see the file header). */
export function clinicalIn(reply: string, facts: ScreenFacts): boolean {
  const text = withoutEveryday(perUnitPrices(withoutOwnWords(reply, facts)));
  if (findClinicalContent({ reply: text }).length > 0) return true;
  return PLAIN_CLINICAL.some((pattern) => pattern.test(text));
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
export function clinicOwnWords(facts: { clinicName?: string | null; address?: string | null }): string[] {
  const words = [facts.clinicName ?? ""];
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
 * when someone asks use, and that an emergency is for 911. The opening line
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

const BOOKED = "(?:booked(?: in)?|confirmed|scheduled|reserved|pencil(?:l)?ed in|locked in|secured)";
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
  /(?<![\p{L}])(?:est[áa]|queda|qued[óo]|ha quedado|ha sido|fue)\s+(?:ya\s+)?(?:confirmad[oa]|reservad[oa]|agendad[oa]|programad[oa]|apuntad[oa])(?![\p{L}])/u,
  /(?<![\p{L}])(?:le|te|lo|la)\s+(?:he|hemos)\s+(?:reservado|agendado|confirmado|apuntado|programado)(?![\p{L}])/u,
  /(?<![\p{L}])(?:confirmad[oa]|reservad[oa]|agendad[oa])\s+para\s+(?:el|la|ma[ñn]ana|hoy|las?)(?![\p{L}])/u,
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

export function guardAssistantReply(
  reply: string,
  facts: Pick<AssistantFacts, "neverSay"> & ScreenFacts,
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
  if (PAYMENT_ASK.test(reply) && /\b(your|share|give|read|tell|provide|send|enter)\b/i.test(reply)) {
    return { ok: false, reason: "payment_details" };
  }
  if (HIPAA_CLAIM.test(reply)) return { ok: false, reason: "hipaa_claim" };
  if (claimsToBeHuman(reply, facts)) return { ok: false, reason: "human_claim" };
  // The practice's own words (its menu, its people, its city) are no language either way.
  const knownTerms = [facts.clinicName, facts.address, ...facts.services.map((s) => s.name), ...(facts.providerNames ?? [])];
  if (messageLanguage(reply, { knownTerms }) === "other") return { ok: false, reason: "language" };
  if (clinicalIn(reply, facts)) return { ok: false, reason: "clinical" };
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
  /(?<![\p{L}])(?<!(?<![\p{L}])no\s+)soy\s+(?:una?\s+)?(?:persona(?:\s+real)?|humano|humana|ser humano|recepcionista|enfermer[oa]|(?:parte|miembro)\s+del\s+(?:equipo|personal))(?![\p{L}])/iu,
  /(?<![\p{L}])no\s+soy\s+(?:una?\s+)?(?:ia|i\.a\.|inteligencia artificial|bot|robot|m[áa]quina|programa|asistente\s+(?:virtual|autom[áa]tic[oa]|de\s+ia))(?![\p{L}])/iu,
  /(?<![\p{L}])est[áa]s?\s+hablando\s+con\s+(?:una?\s+)?(?:persona(?:\s+real)?|humano|humana|recepcionista|enfermer[oa])(?![\p{L}])/iu,
];

/** A capitalised word in a name: "Sarah", "Mary-Jane", "O'Neil". */
const NAME = "(\\p{Lu}[\\p{Ll}'’-]+)";
/** Where a claim names a person who works at the practice: "Sarah at the front desk", "Sarah from the team". */
const AT_THE_PRACTICE = "(?:at|from|on|in|of|with)\\s+(?:the|our)\\s+(?:front desk|reception|team|staff|office|practice|clinic)\\b";

/** The same, with a person's name in it: "I'm Sarah, a real person", "you're talking to Sarah at the front desk". */
const NAMED_CLAIMS: readonly RegExp[] = [
  new RegExp(
    `(?:\\b[Ii]['’]?m|\\b[Ii] am|\\b[Mm]y name is|\\b[Tt]his is)\\s+${NAME}(?:\\s*,\\s*|\\s+)(?:${ARTICLE}${REAL}${HUMAN_ROLE}\\b|${AT_THE_PRACTICE})`,
    "u",
  ),
  new RegExp(`\\b[Yy]ou(?:['’]re| are)\\s+(?:talking|speaking|chatting)\\s+(?:to|with)\\s+${NAME}(?=\\s*(?:[,.!?]|$)|\\s+${AT_THE_PRACTICE})`, "u"),
  new RegExp(`(?:^|[.!?]\\s+)${NAME}\\s+(?:here|speaking)\\b(?=\\s*(?:[,.!?—–-]|$|from|at|with|on))`, "u"),
];

/** Capitalised words a claim may follow without being a person's name: the assistant's own name, days, words that open a sentence. */
const NOT_A_PERSON = new Set([
  "aya", "ai", "an", "a", "the", "your", "our", "sorry", "happy", "glad", "afraid", "here", "not",
  "just", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday", "today",
]);

/** Words before a claim that make it a question asked back or a report of one: "you asked whether I'm a real person". */
const ASKED = /\b(?:if|whether|asked|wondering|wonder)\b/i;

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

/** The line a refused reply becomes. */
export function guardedLine(reason: GuardRefusal, clinicName: string): string {
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

const CARDISH = /\b(?:\d[ -]?){12,18}\d\b/g;

/**
 * The text with every card number cut out, and whether there was one. A run
 * of 13 to 19 digits, spaced or dashed, that passes the Luhn check; a phone
 * number does not pass it by design often enough to matter, and one that does
 * is only cut from the transcript.
 */
export function cardNumberIn(text: string): { text: string; found: boolean } {
  let found = false;
  const cut = text.replace(CARDISH, (match) => {
    const digits = match.replace(/[ -]/g, "");
    if (digits.length >= 13 && digits.length <= 19 && luhn(digits)) {
      found = true;
      return "[card number removed]";
    }
    return match;
  });
  return { text: cut, found };
}
