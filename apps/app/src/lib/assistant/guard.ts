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
 *     or deposits: an off-menu price becomes the offer of a consultation;
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
 *     English and Spanish are screened, any other is not sent.
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
  | "empty";

export type GuardVerdict = { ok: true } | { ok: false; reason: GuardRefusal };

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

/** The cents of each amount the reply names, "$1,200", "$99.50", "1200 dollars". */
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
  return out;
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
  return text.replace(
    /((?:\$\s?\d[\d,]*(?:\.\d{1,2})?)|\b\d[\d,]*(?:\.\d{1,2})?\s?(?:dollars|usd|bucks))\s+(?:a|an|each|every)\s+(units?|ml)\b/gi,
    "$1 per $2",
  );
}

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

export function guardAssistantReply(reply: string, facts: Pick<AssistantFacts, "neverSay"> & ScreenFacts): GuardVerdict {
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
  // The practice's own words (its menu, its people, its city) are no language either way.
  const knownTerms = [facts.clinicName, facts.address, ...facts.services.map((s) => s.name), ...(facts.providerNames ?? [])];
  if (messageLanguage(reply, { knownTerms }) === "other") return { ok: false, reason: "language" };
  if (clinicalIn(reply, facts)) return { ok: false, reason: "clinical" };
  return { ok: true };
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
 * safe way to be wrong.
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
    // Groups s to e, or only the first `digits.length` digits of group s.
    const passes = (digits: string, s: number, e: number, to: number, whole: boolean): boolean => {
      const from = groups[s]!.start;
      if (crossing) {
        if (digits.length !== 15 && digits.length !== 16) return false;
        if (!crossing.some((at) => from < at && at < to)) return false;
      } else if (whole) {
        return luhn(digits);
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
  return { text: cut, found: spans.length > 0 };
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
