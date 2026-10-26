import {
  catalogPricesCents,
  findClinicalContent,
  lintSupportTone,
  SUPPORT_AGREEMENT_WORDS,
  SUPPORT_CLAIM_RULES,
  SUPPORT_NAME_ALLOW,
  SUPPORT_PACKAGE_NAMES,
  SUPPORT_PORTAL_WORDS,
  SUPPORT_PROMISE_RULES,
  SUPPORT_REPLY_LIMITS,
  SUPPORT_SIGN_OFF,
  type AgreementKind,
} from "@healdesk/catalog";

import { screenText } from "../screen";

/**
 * The eight checks every support reply passes (ops automation design E5 §6;
 * lane P7b): after each draft the model writes, and again, less the first,
 * on the text the owner approves and sends (lane P7c). Deterministic and
 * pure: no model, no database, no clock, no environment.
 *
 *   1. facts         every date, day, time, dollar amount, percent, count,
 *                    package name, phone number and link in the reply is in
 *                    a fact the model says it used, and every such fact's
 *                    value is in what a tool returned in this run. Draft
 *                    only: Send never calls the model, so there is no run to
 *                    hold the facts to.
 *   2. screen        the chat's screen (lib/support/screen.ts) hides nothing
 *                    in the reply: no stranger's number or address, no
 *                    treatment name.
 *   3. names         no capitalised word that is not a product, a vendor the
 *                    clinic connects to, a carrier, a place in the portal, a
 *                    day, a month, a sentence's first word, the practice's
 *                    own name or a word the caller allows. The reply names
 *                    no person.
 *   4. clinical      the catalog's clinical screen finds nothing.
 *   5. promises      no refund, credit, free service, waiver, guarantee,
 *                    go-live date or response time, unless a billing fact
 *                    records that refund, credit or waiver.
 *   6. claims        never "HIPAA compliant", "revenue", "recovered" or
 *                    "collected" (but "deposits collected"); no dollar amount
 *                    the catalog cannot price; the agreement named only as
 *                    the one the practice signed.
 *   7. shape         at most six sentences and 900 characters, one question,
 *                    one link and only to the portal; no markdown; the tone
 *                    lint (lintSupportTone: no exclamation mark, no emoji, no
 *                    banned phrase).
 *   8. other_clinics no uuid but this practice's, no case ref but this
 *                    case's, and no other practice's name.
 *
 * A result never carries the text: each names its check and a fixed
 * sentence, and where a check can point, the spans of the sentences it
 * failed on, as character offsets.
 */

export const CHECK_IDS = [
  "facts",
  "screen",
  "names",
  "clinical",
  "promises",
  "claims",
  "shape",
  "other_clinics",
] as const;
export type CheckId = (typeof CHECK_IDS)[number];

/**
 * The ninth check, run only on a draft written from a clinic's email (lane
 * P7h; owner, 26 October 2026): the reply quotes no run of EMAIL_RUN_WORDS
 * words from the email the model was shown. The email is held in memory for
 * this run only, so Send cannot run it: it is a draft-only check, like
 * `facts`. A draft from an email also has two of the eight tightened: `facts`
 * takes a fact's field only as a label its tool printed, and `names` reads a
 * sentence's first word too when the email used it as a name.
 */
export const EMAIL_CHECK_ID = "email_words" as const;
export type AnyCheckId = CheckId | typeof EMAIL_CHECK_ID;
/** The longest run of words a reply may share with the email it answers. */
export const EMAIL_RUN_WORDS = 5;

/** What each check holds, in one fixed sentence: shown to the operator, logged, never the reply's words. */
export const CHECK_RULES: Readonly<Record<AnyCheckId, string>> = {
  email_words: `The reply quotes no run of ${EMAIL_RUN_WORDS} or more words from the practice's email.`,
  facts:
    "Every date, day, time, amount, percent, count, package name, phone number and link in the reply comes from a fact the tools returned.",
  screen: "The reply carries no stranger's phone number or email address and no treatment name.",
  names:
    "The reply names no person: every capitalised word is a product, a place in the portal, a day, a month or the practice's own name.",
  clinical: "The reply gives no clinical content or advice.",
  promises:
    "The reply promises no refund, credit, free service, waiver, guarantee, go-live date or response time that the billing record does not show.",
  claims:
    'The reply never says "HIPAA compliant", "revenue", "recovered" or "collected", quotes only prices the catalog has, and names the agreement the practice signed.',
  shape:
    "The reply is at most six sentences and 900 characters, asks at most one question, has at most one link and only to the portal, and has no markdown, exclamation mark, emoji or banned phrase.",
  other_clinics: "The reply carries no id, case reference or name that belongs to another practice or case.",
};

/** A fact the model says its reply relies on: which tool, which field, and the value as the tool gave it. */
export type FactsUsed = { tool: string; field: string; value: string };

/** What one tool returned in the run, as the model read it. */
export type ToolResult = { tool: string; text: string };

export type Span = { start: number; end: number };

export type CheckResult = { id: AnyCheckId; ok: boolean; rule: string; spans?: Span[] };

export type ReplyChecks = { ok: boolean; results: CheckResult[] };

export type ReplyCheckInput = {
  text: string;
  /** The practice's name: its words may stand capitalised. */
  clinicName: string;
  /** What the model says it used (check 1, and check 5's billing facts). */
  facts: readonly FactsUsed[];
  /** What the tools returned in this run (check 1). */
  toolResults?: readonly ToolResult[];
  /** More capitalised words that may stand (check 3). */
  allowNames?: readonly string[];
  /** This case's ref, bare ("7F3KQ") or printed ("HD-7F3KQ"). */
  ownCaseRef: string;
  /** "draft" runs all eight; "send" skips check 1, since Send never calls the model. */
  mode: "draft" | "send";
  /** Numbers the reply may carry (check 2): the practice's own, healdesk's line, AYA's number once the steps were read. */
  allowNumbers?: readonly (string | null | undefined)[];
  /** The practice's own service names, hidden like the catalog's treatment words (check 2). */
  serviceNames?: readonly string[];
  /** The practice's own id: the one uuid a reply may carry (check 8). */
  clinicId?: string | null;
  /** Other practices' names, none of which may appear (check 8). */
  otherClinicNames?: readonly string[];
  /** The agreement the practice signed; null or absent is the business associate agreement (check 6). */
  agreementKind?: AgreementKind | null;
  /** The portal's public origin, the one place a link may go (check 7). Absent, no link passes. */
  portalOrigin?: string | null;
  /**
   * The email the model was shown, in memory only (lane P7h): present, the
   * `email_words` check runs after the eight. Never stored, never returned.
   */
  emailText?: string | null;
};

// -----------------------------------------------------------------------------
// Text helpers
// -----------------------------------------------------------------------------

const LETTER_OR_DIGIT = "[\\p{L}\\p{N}]";
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/giu;
const REF = /(?<![\p{L}\p{N}])HD-?([0-9A-Z]{5})(?![\p{L}\p{N}])/giu;
const LINK = /\bhttps?:\/\/[^\s<>()"']+|\bwww\.[^\s<>()"']+/giu;
const EMAIL = /[\p{L}\p{N}._%+'-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+/gu;

/** The text without the sign-off our template adds, so a pasted one costs nothing. */
function withoutSignOff(text: string): string {
  const sign = SUPPORT_SIGN_OFF.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return text.replace(new RegExp(`(?:\\n|^)\\s*(?:[-—–]+\\s*)?${sign}\\.?\\s*$`, "u"), "").trimEnd();
}

/** The sentences, as spans: ended by . ? ! or a line break; a fragment with no letter is not a sentence. */
export function sentenceSpans(text: string): Span[] {
  const spans: Span[] = [];
  let start = 0;
  const push = (end: number) => {
    const piece = text.slice(start, end);
    if (/\p{L}/u.test(piece.replace(/^\s*\d+[.)]\s*/u, ""))) {
      const lead = piece.length - piece.trimStart().length;
      spans.push({ start: start + lead, end: start + piece.trimEnd().length });
    }
    start = end;
  };
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (ch === "\n") {
      push(i);
      start = i + 1;
      continue;
    }
    if (ch === "." || ch === "?" || ch === "!" || ch === "？" || ch === "！") {
      const next = text[i + 1];
      // A full stop inside a number, a domain or "e.g." is not a sentence's end.
      if (next !== undefined && !/\s/u.test(next) && !/["'”’)]/u.test(next)) continue;
      // A numbered step's "1." starts a sentence rather than ending one.
      if (ch === "." && /(?:^|\n)\s*\d+$/u.test(text.slice(0, i))) continue;
      push(i + 1);
    }
  }
  push(text.length);
  return spans;
}

function sentenceOf(spans: readonly Span[], at: number): Span {
  return spans.find((s) => at >= s.start && at < s.end) ?? { start: at, end: at + 1 };
}

function uniqueSpans(spans: readonly Span[]): Span[] {
  const seen = new Set<string>();
  return spans
    .filter((s) => {
      const key = `${s.start}:${s.end}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => a.start - b.start);
}

function bareRef(ref: string): string {
  return ref.trim().toUpperCase().replace(/^HD-?/u, "");
}

function normal(value: string): string {
  // Commas out: "Wednesday, 28 October" and "Wednesday 28 October" are one fact.
  return value.normalize("NFC").toLowerCase().replace(/[’‘]/gu, "'").replace(/,(?=\s)/gu, "").replace(/\s+/gu, " ").trim();
}

// -----------------------------------------------------------------------------
// Check 1: the facts a reply states, as tokens
// -----------------------------------------------------------------------------

const MONTHS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
] as const;
const MONTH_SHORT: Readonly<Record<string, number>> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  sept: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"] as const;
const WEEKDAY_SHORT: Readonly<Record<string, string>> = {
  sun: "sunday",
  mon: "monday",
  tue: "tuesday",
  tues: "tuesday",
  wed: "wednesday",
  thu: "thursday",
  thur: "thursday",
  thurs: "thursday",
  fri: "friday",
  sat: "saturday",
};

const MONTH_WORD = `(?:${[...MONTHS, ...Object.keys(MONTH_SHORT)].join("|")})\\.?`;
const capital = (w: string) => w.charAt(0).toUpperCase() + w.slice(1);
const CAPITAL_WEEKDAY_WORD = `(?:${[...WEEKDAYS, ...Object.keys(WEEKDAY_SHORT)].map(capital).join("|")})\\.?`;
const CAPITAL_MONTHS = MONTHS.filter((m) => m !== "may").map(capital).join("|");

function monthOf(word: string): number {
  const w = word.toLowerCase().replace(/\.$/u, "");
  const full = MONTHS.indexOf(w as (typeof MONTHS)[number]);
  return full >= 0 ? full + 1 : (MONTH_SHORT[w] ?? 0);
}

function weekdayOf(word: string): string {
  const w = word.toLowerCase().replace(/\.$/u, "");
  return (WEEKDAYS as readonly string[]).includes(w) ? w : (WEEKDAY_SHORT[w] ?? w);
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function weekdayFor(year: number, month: number, day: number): string | null {
  const date = new Date(Date.UTC(year, month - 1, day, 12));
  if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return WEEKDAYS[date.getUTCDay()]!;
}

type Token = { key: string; start: number };

type Extractor = {
  pattern: RegExp;
  /** The tokens one match stands for. `fact` is true when reading a fact's value rather than the reply. */
  keys: (m: RegExpMatchArray, fact: boolean) => string[];
};

function centsOf(raw: string): number {
  return Math.round(Number(raw.replace(/[,\s$]/gu, "")) * 100);
}

function dayMonthKeys(day: number, month: number, year: string | undefined, fact: boolean): string[] {
  if (month < 1 || day < 1 || day > 31) return [];
  const keys = [`date:${pad(month)}-${pad(day)}`];
  if (fact) {
    keys.push(`num:${day}`, `month:${month}`);
    if (year) {
      keys.push(`num:${Number(year)}`);
      const weekday = weekdayFor(Number(year), month, day);
      if (weekday) keys.push(`day:${weekday}`);
    }
  }
  return keys;
}

/** In order: each pattern's matches are blanked before the next reads, so a date's digits are not also a count. */
const EXTRACTORS: readonly Extractor[] = [
  { pattern: LINK, keys: (m) => [`url:${normal(m[0]).replace(/[.,;:!?]+$/u, "")}`] },
  { pattern: EMAIL, keys: () => [] },
  {
    pattern: /(?<![\p{L}\p{N}])(\d{4})-(\d{2})-(\d{2})(?:T[\d:.]+Z?)?(?![\p{L}\p{N}])/gu,
    keys: (m, fact) => dayMonthKeys(Number(m[3]), Number(m[2]), m[1], fact),
  },
  // Phone-shaped: seven or more digits, as the screen reads them.
  {
    pattern: /(?<![\p{L}\p{N}])(?:\+\d{1,3}[ .-]?)?(?:\(\d{2,4}\)[ .-]?)?\d(?:[ .-]?\d){6,}(?![\p{L}\p{N}])/gu,
    keys: (m) => [`phone:${m[0].replace(/\D+/gu, "").slice(-10)}`],
  },
  {
    pattern: new RegExp(
      `(?<!${LETTER_OR_DIGIT})(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${MONTH_WORD})(?:,?\\s+(\\d{4}))?(?!${LETTER_OR_DIGIT})`,
      "giu",
    ),
    keys: (m, fact) => dayMonthKeys(Number(m[1]), monthOf(m[2]!), m[3], fact),
  },
  {
    pattern: new RegExp(
      `(?<!${LETTER_OR_DIGIT})(${MONTH_WORD})\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?(?!${LETTER_OR_DIGIT})`,
      "giu",
    ),
    keys: (m, fact) => dayMonthKeys(Number(m[2]), monthOf(m[1]!), m[3], fact),
  },
  {
    pattern: /(?<![\p{L}\p{N}])(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?(?![\p{L}\p{N}])/gu,
    keys: (m, fact) => dayMonthKeys(Number(m[2]), Number(m[1]), m[3]?.length === 4 ? m[3] : undefined, fact),
  },
  // A day name alone, capitalised as a reply writes one ("by Wednesday"): "sat" and "wed" are words too.
  {
    pattern: new RegExp(`(?<!${LETTER_OR_DIGIT})(${CAPITAL_WEEKDAY_WORD})(?!${LETTER_OR_DIGIT})`, "gu"),
    keys: (m) => [`day:${weekdayOf(m[1]!)}`],
  },
  // A month alone ("in October") is a date too; never "May", which is also a verb.
  {
    pattern: new RegExp(`(?<!${LETTER_OR_DIGIT})(${CAPITAL_MONTHS})(?!${LETTER_OR_DIGIT})`, "gu"),
    keys: (m) => [`month:${monthOf(m[1]!)}`],
  },
  {
    pattern: /(?<![\p{L}\p{N}])(\d{1,2})(?::(\d{2}))?\s?([ap])\.?m\.?(?![\p{L}\p{N}])/giu,
    keys: (m) => [`time:${Number(m[1])}:${m[2] ?? "00"}${m[3]!.toLowerCase()}m`],
  },
  {
    pattern: /(?<![\p{L}\p{N}:])(\d{1,2}):(\d{2})(?![\p{L}\p{N}:])/gu,
    keys: (m) => [`time:${Number(m[1])}:${m[2]}`],
  },
  {
    pattern: /\$\s?(\d[\d,]*(?:\.\d+)?)/gu,
    keys: (m) => [`usd:${centsOf(m[1]!)}`],
  },
  {
    pattern: /(?<![\p{L}\p{N}])(\d+(?:\.\d+)?)\s?(?:%|per\s?cent)(?![\p{L}\p{N}])/giu,
    keys: (m) => [`pct:${Number(m[1])}`],
  },
  {
    pattern: new RegExp(
      `(?<!${LETTER_OR_DIGIT})(?:${SUPPORT_PACKAGE_NAMES.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+")).join("|")})(?!${LETTER_OR_DIGIT})`,
      "giu",
    ),
    keys: (m) => [`plan:${normal(m[0])}`],
  },
  // Ordinals and counts, last: whatever number is left. A numbered step's "1." is not a count.
  {
    pattern: /(?<![\p{L}\p{N}.,])(\d[\d,]*(?:\.\d+)?)(?:st|nd|rd|th)?(?![\p{L}\p{N}]|[.,]\d)/giu,
    keys: (m) => [`num:${Number(m[1]!.replace(/,/gu, ""))}`],
  },
];

/** Every stated fact in `text`, with where it starts. Refs and uuids are check 8's, not facts. */
export function factTokens(text: string, fact = false): Token[] {
  let rest = text.normalize("NFC");
  const blank = (s: string, from: number, to: number) => s.slice(0, from) + " ".repeat(to - from) + s.slice(to);
  for (const pattern of [UUID, REF]) {
    for (const m of [...rest.matchAll(new RegExp(pattern.source, pattern.flags))]) {
      rest = blank(rest, m.index!, m.index! + m[0].length);
    }
  }
  if (!fact) {
    // A numbered step's marker.
    for (const m of [...rest.matchAll(/(?:^|\n)(\s*\d+[.)])(?=\s)/gu)]) {
      const at = m.index! + m[0].length - m[1]!.length;
      rest = blank(rest, at, at + m[1]!.length);
    }
  }
  const tokens: Token[] = [];
  for (const { pattern, keys } of EXTRACTORS) {
    for (const m of [...rest.matchAll(new RegExp(pattern.source, pattern.flags))]) {
      for (const key of keys(m, fact)) tokens.push({ key, start: m.index! });
      rest = blank(rest, m.index!, m.index! + m[0].length);
    }
  }
  return tokens;
}

function checkFacts(input: ReplyCheckInput, sentences: readonly Span[]): { ok: boolean; spans: Span[] } {
  const results = input.toolResults ?? [];
  const byTool = new Map<string, string[]>();
  for (const r of results) byTool.set(r.tool, [...(byTool.get(r.tool) ?? []), normal(r.text)]);

  // Each fact's value must be in what its tool returned in this run.
  let factsHold = true;
  const supported = new Set<string>();
  for (const fact of input.facts) {
    const value = normal(fact.value);
    const found = value.length > 0 && (byTool.get(fact.tool) ?? []).some((text) => text.includes(value));
    // A draft from an email (lane P7h): the field is stored, so it must be a
    // label the tool printed ("- Label: value"), never the model's own words.
    const field = normal(fact.field);
    const labelled = !input.emailText || (field.length > 0 && (byTool.get(fact.tool) ?? []).some((text) => text.includes(`${field}:`)));
    if (!found || !labelled) {
      factsHold = false;
      continue;
    }
    for (const token of factTokens(fact.value, true)) supported.add(token.key);
  }

  const spans: Span[] = [];
  for (const token of factTokens(input.text)) {
    if (!supported.has(token.key)) spans.push(sentenceOf(sentences, token.start));
  }
  return { ok: factsHold && spans.length === 0, spans: uniqueSpans(spans) };
}

// -----------------------------------------------------------------------------
// Check 3: names
// -----------------------------------------------------------------------------

const DAY_AND_MONTH_WORDS: readonly string[] = [
  ...WEEKDAYS,
  ...Object.keys(WEEKDAY_SHORT),
  ...MONTHS,
  ...Object.keys(MONTH_SHORT),
];

/** A word without its possessive or contraction: "AYA's" is AYA, "I'll" is I. */
function bareWord(word: string): string {
  return word.replace(/['’](?:s|ll|m|ve|d|re|t)$/iu, "").toLowerCase();
}

function nameWordsOf(value: string): string[] {
  return value
    .split(/[^\p{L}\p{N}&'’-]+/u)
    .flatMap((w) => [w, ...w.split("-")])
    .map(bareWord)
    .filter(Boolean);
}

/** Whether the word at `at` begins a sentence: the text's start, or after a line break, . ? ! : → or an opening bracket or quote. */
function startsSentence(text: string, at: number): boolean {
  const before = text.slice(0, at).replace(/[\s"'“‘(\[*_#>-]+$/u, "");
  return before.length === 0 || /[.?!:\n→]$/u.test(before) || /\n\s*$/u.test(text.slice(0, at));
}

function checkNames(input: ReplyCheckInput, text: string, sentences: readonly Span[]): { ok: boolean; spans: Span[] } {
  const allow = new Set<string>(
    [
      ...SUPPORT_NAME_ALLOW,
      ...SUPPORT_PORTAL_WORDS,
      ...DAY_AND_MONTH_WORDS,
      ...(input.allowNames ?? []),
      input.clinicName,
    ].flatMap(nameWordsOf),
  );
  // A draft from an email (lane P7h): the capitalised words the email used
  // mid-sentence (its names, most likely) are not let through at a sentence's start.
  const emailNames = new Set<string>();
  if (input.emailText) {
    for (const m of input.emailText.matchAll(/(?<![\p{L}\p{N}&'’-])\p{Lu}[\p{L}\p{N}&'’-]*/gu)) {
      if (!startsSentence(input.emailText, m.index!)) emailNames.add(bareWord(m[0].replace(/[-'’]+$/u, "")));
    }
  }
  const spans: Span[] = [];
  for (const m of text.matchAll(/(?<![\p{L}\p{N}&'’-])\p{L}[\p{L}\p{N}&'’-]*/gu)) {
    const word = m[0].replace(/[-'’]+$/u, "");
    if (!/^\p{Lu}/u.test(word)) continue;
    if (/\p{N}/u.test(word) || /^HD-[0-9A-Z]{5}$/iu.test(word)) continue; // a ref or an id: check 8's
    if (startsSentence(text, m.index!) && !emailNames.has(bareWord(word))) continue;
    const parts = nameWordsOf(word);
    const whole = bareWord(word);
    if (allow.has(whole) || (parts.length > 0 && parts.every((p) => allow.has(p) || !/^\p{L}/u.test(p)))) continue;
    spans.push(sentenceOf(sentences, m.index!));
  }
  return { ok: spans.length === 0, spans: uniqueSpans(spans) };
}

// -----------------------------------------------------------------------------
// Checks 5 and 6: promises and claims
// -----------------------------------------------------------------------------

function matchesOf(pattern: RegExp, text: string): RegExpMatchArray[] {
  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
  return [...text.matchAll(new RegExp(pattern.source, flags))];
}

function checkPromises(input: ReplyCheckInput, text: string, sentences: readonly Span[]): { ok: boolean; spans: Span[] } {
  const billing = input.facts
    .filter((f) => f.tool === "get_clinic_signals" && /^billing/u.test(f.field))
    .map((f) => normal(f.value));
  const spans: Span[] = [];
  for (const rule of SUPPORT_PROMISE_RULES) {
    for (const m of matchesOf(rule.pattern, text)) {
      const stem = rule.billingStem;
      if (stem && billing.some((value) => value.includes(stem))) continue;
      spans.push(sentenceOf(sentences, m.index!));
    }
  }
  return { ok: spans.length === 0, spans: uniqueSpans(spans) };
}

function checkClaims(input: ReplyCheckInput, text: string, sentences: readonly Span[]): { ok: boolean; spans: Span[] } {
  const spans: Span[] = [];
  for (const rule of SUPPORT_CLAIM_RULES) {
    for (const m of matchesOf(rule.pattern, text)) {
      if (rule.unlessBefore && rule.unlessBefore.test(text.slice(0, m.index!))) continue;
      spans.push(sentenceOf(sentences, m.index!));
    }
  }
  const prices = catalogPricesCents();
  for (const m of text.matchAll(/\$\s?(\d[\d,]*(?:\.\d+)?)/gu)) {
    if (!prices.has(centsOf(m[1]!))) spans.push(sentenceOf(sentences, m.index!));
  }
  const dpa = input.agreementKind === "dpa";
  for (const m of matchesOf(dpa ? SUPPORT_AGREEMENT_WORDS.baa : SUPPORT_AGREEMENT_WORDS.dpa, text)) {
    spans.push(sentenceOf(sentences, m.index!));
  }
  return { ok: spans.length === 0, spans: uniqueSpans(spans) };
}

// -----------------------------------------------------------------------------
// Check 7: shape
// -----------------------------------------------------------------------------

const MARKDOWN: readonly RegExp[] = [
  /(?:^|\n)\s{0,3}#{1,6}\s/u, // a heading
  /(?:^|\n)\s*[*+-]\s+\S/u, // a bullet
  /(?:^|\n)\s*>/u, // a quote
  /\*\*[^*\n]+\*\*|__[^_\n]+__/u, // bold
  /(?<![\p{L}\p{N}])[*_][^*_\n]+[*_](?![\p{L}\p{N}])/u, // emphasis
  /`/u, // code
  /\[[^\]\n]*\]\([^)\n]*\)/u, // a link
  /(?:^|\n)\s*\|.*\|/u, // a table
];

function originOf(url: string): string | null {
  try {
    return new URL(url.startsWith("www.") ? `https://${url}` : url).origin;
  } catch {
    return null;
  }
}

function checkShape(input: ReplyCheckInput, text: string, sentences: readonly Span[]): { ok: boolean; spans: Span[] } {
  const spans: Span[] = [];
  let ok = true;
  if (sentences.length > SUPPORT_REPLY_LIMITS.sentences) {
    ok = false;
    spans.push(...sentences.slice(SUPPORT_REPLY_LIMITS.sentences));
  }
  if (text.length > SUPPORT_REPLY_LIMITS.characters) ok = false;
  const questions = [...text.matchAll(/[?？]/gu)];
  if (questions.length > SUPPORT_REPLY_LIMITS.questions) {
    ok = false;
    for (const q of questions) spans.push(sentenceOf(sentences, q.index!));
  }
  const links = [...text.matchAll(new RegExp(LINK.source, LINK.flags))];
  const portal = input.portalOrigin ? originOf(input.portalOrigin) : null;
  if (links.length > SUPPORT_REPLY_LIMITS.links) ok = false;
  for (const link of links) {
    const origin = originOf(link[0].replace(/[.,;:!?]+$/u, ""));
    if (!portal || origin !== portal || links.length > SUPPORT_REPLY_LIMITS.links) {
      ok = false;
      spans.push(sentenceOf(sentences, link.index!));
    }
  }
  if (MARKDOWN.some((p) => p.test(text))) ok = false;
  if (lintSupportTone(text).length > 0) ok = false;
  return { ok, spans: uniqueSpans(spans) };
}

// -----------------------------------------------------------------------------
// Check 8: other clinics
// -----------------------------------------------------------------------------

function checkOtherClinics(input: ReplyCheckInput, text: string, sentences: readonly Span[]): { ok: boolean; spans: Span[] } {
  const spans: Span[] = [];
  const ownId = input.clinicId?.toLowerCase() ?? null;
  for (const m of text.matchAll(new RegExp(UUID.source, UUID.flags))) {
    if (m[0].toLowerCase() !== ownId) spans.push(sentenceOf(sentences, m.index!));
  }
  const own = bareRef(input.ownCaseRef);
  for (const m of text.matchAll(new RegExp(REF.source, REF.flags))) {
    if (m[1]!.toUpperCase() !== own) spans.push(sentenceOf(sentences, m.index!));
  }
  const ownName = normal(input.clinicName);
  const folded = normal(text);
  for (const name of input.otherClinicNames ?? []) {
    const other = normal(name);
    if (other.length < 3 || other === ownName || ownName.includes(other)) continue;
    const pattern = new RegExp(
      `(?<![\\p{L}\\p{N}])${other.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}])`,
      "u",
    );
    if (pattern.test(folded)) {
      // `folded` and `text` differ in spacing: point at the whole reply.
      spans.push({ start: 0, end: text.length });
    }
  }
  return { ok: spans.length === 0, spans: uniqueSpans(spans) };
}

// -----------------------------------------------------------------------------
// The eight, in order
// -----------------------------------------------------------------------------

/**
 * Run the checks. `ok` is true only when every check that ran passed. In
 * "send" mode check 1 is not run and not listed.
 */
export function runReplyChecks(input: ReplyCheckInput): ReplyChecks {
  const text = withoutSignOff(input.text.normalize("NFC"));
  const sentences = sentenceSpans(text);
  const results: CheckResult[] = [];
  const add = (id: AnyCheckId, outcome: { ok: boolean; spans?: Span[] }) => {
    const result: CheckResult = { id, ok: outcome.ok, rule: CHECK_RULES[id] };
    if (!outcome.ok && outcome.spans && outcome.spans.length > 0) result.spans = outcome.spans;
    results.push(result);
  };

  if (input.mode === "draft") add("facts", checkFacts({ ...input, text }, sentences));

  const screened = screenText(text, {
    numbers: input.allowNumbers ?? [],
    emails: [],
    serviceNames: input.serviceNames ?? [],
  });
  add("screen", { ok: screened.hiddenIdentifiers === 0 && screened.hiddenTreatments === 0 });
  add("names", checkNames(input, text, sentences));
  add("clinical", { ok: findClinicalContent({ reply: text }).length === 0 });
  add("promises", checkPromises(input, text, sentences));
  add("claims", checkClaims(input, text, sentences));
  add("shape", checkShape(input, text, sentences));
  add("other_clinics", checkOtherClinics(input, text, sentences));
  if (input.mode === "draft" && input.emailText) add(EMAIL_CHECK_ID, { ok: !quotesEmail(text, input.emailText) });

  // An empty reply is never a reply.
  const empty = text.trim().length === 0;
  if (empty) {
    const shape = results.find((r) => r.id === "shape")!;
    shape.ok = false;
  }
  return { ok: results.every((r) => r.ok), results };
}

/** Lower-case words of letters and digits, accents off: what a quote is compared on. */
function wordsOf(text: string): string[] {
  return (
    text
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .match(/[\p{L}\p{N}]+/gu) ?? []
  );
}

/**
 * Whether the reply quotes the email: any run of EMAIL_RUN_WORDS words in a
 * row that the email has too. Pure, in memory.
 */
export function quotesEmail(reply: string, email: string, run: number = EMAIL_RUN_WORDS): boolean {
  const theirs = wordsOf(email);
  const ours = wordsOf(reply);
  if (theirs.length < run || ours.length < run) return false;
  const seen = new Set<string>();
  for (let i = 0; i + run <= theirs.length; i += 1) seen.add(theirs.slice(i, i + run).join(" "));
  for (let i = 0; i + run <= ours.length; i += 1) if (seen.has(ours.slice(i, i + run).join(" "))) return true;
  return false;
}

/** The ids of the checks that failed, in order: what a case's needs_edit reason names. */
export function failedCheckIds(checks: ReplyChecks): AnyCheckId[] {
  return checks.results.filter((r) => !r.ok).map((r) => r.id);
}
