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
 * English, and they are matched as written, from the start of a word, past
 * the clinic's own name and address (neverSayIn). A Spanish reply is refused
 * when it contains an entry's English text, and not when it says the same
 * thing in Spanish; the clinical screen, which reads Spanish, is what catches
 * a Spanish promise of safety or results. No entry may stop the assistant
 * saying it is an AI assistant, or pointing to 911 (NEVER_SAY_PROTECTED).
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
  Partial<Pick<AssistantFacts, "clinicName" | "address" | "requirements">>;

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
 * The clinic's own public words, which a never-say entry is read past: its
 * name, and each part of its address split at commas and line breaks, the
 * street also without its number. "Painless Laser Studio" must still be able
 * to say who and where it is with the default "painless" on its list, as the
 * Meta guard's other word checks read past the same words (front-door.ts,
 * withoutOwnWords), and its request-received line must keep the person's name.
 */
export function clinicOwnWords(facts: { clinicName?: string | null; address?: string | null }): string[] {
  const words = [facts.clinicName ?? ""];
  for (const part of (facts.address ?? "").split(/[,\n]+/)) {
    words.push(part, part.trim().replace(/^\d+[a-z]?\s+/i, ""));
  }
  return [...new Set(words.map((w) => w.trim()).filter((w) => w !== ""))];
}

/**
 * Whether a reply contains an entry of a never-say list. Both sides are
 * normalised (case, curly quotes, dashes, a hyphen read as a space, runs of
 * whitespace, a line break among them), the clinic's own name and address
 * are read past (clinicOwnWords), and an entry matches where a word starts:
 * "cure" is not in "secure", nor "AI" in "available", while "painless" is
 * still in "painlessly" and "guarantee" in "guaranteed", the forms the
 * prompt's "in any form" means. One function for every channel: the Meta
 * front door's guard calls it too (lib/meta/front-door.ts, guardReply), so
 * a phrase refused on a call is refused on Instagram, Messenger and
 * WhatsApp, and the two cannot drift apart.
 */
export function neverSayIn(reply: string, list: readonly string[], ownWords: readonly string[] = []): boolean {
  let text = ` ${listForm(reply)} `;
  for (const own of ownWords.map((w) => listForm(w).trim()).filter(Boolean).sort((a, b) => b.length - a.length)) {
    text = text.replace(new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(own)}(?![\\p{L}\\p{N}])`, "gu"), " ");
  }
  return list.some((phrase) => {
    const p = listForm(phrase).trim();
    return p !== "" && new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(p)}`, "u").test(text);
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
  if (messageLanguage(reply) === "other") return { ok: false, reason: "language" };
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
