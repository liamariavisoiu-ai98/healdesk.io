import { DAY_KEYS } from "./allow-list";
import { emphasisePlaces, mark, neutraliseValue, plainText } from "./markup";
import type { AlertWording } from "./types";
import { URGENCY, type Urgency } from "./urgency";
import { CLOSED_WORDS, closedWord, scopeToEvent } from "./words";

/**
 * The one substitution the email and the Slack copy share (./types.ts has
 * the syntax). Plain text in, plain text out: each renderer escapes for its
 * own medium afterwards. Never prints `undefined`, `null` or a raw `{key}`:
 * a missing value drops its optional clause or prints its key's fallback.
 *
 * One pass: the wording is read once, left to right, and a value is inserted
 * as it is, never read again, so a name that contains `{promisedOn}` or `[`
 * prints those characters and expands nothing.
 */

export type WordingValues = Readonly<Record<string, string | number>>;

/** What a missing value reads as outside an optional clause. */
export const FALLBACKS: Readonly<Record<string, string>> = {
  clinicName: "this clinic",
  business: "a clinic",
  meter: "allowance",
  section: "booking settings",
  recommendation: "no suggestion",
  decision: "none yet",
  percent: "most",
  promisedOn: "the day we promised",
  windowStart: "the start of this billing period",
  code: "one of the vendors in our chain",
  kind: "an email",
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const ISO_DATE = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?(?:Z|[+-]\d{2}:\d{2}))?$/;

/** A day as "22 Oct", in UTC: never a time. */
export function formatDay(iso: string): string {
  const at = new Date(/^\d{4}-\d{2}-\d{2}$/.test(iso) ? `${iso}T12:00:00Z` : iso);
  if (Number.isNaN(at.getTime())) return iso;
  return `${at.getUTCDate()} ${MONTHS[at.getUTCMonth()]}`;
}

/** Whether a field holds a date or an instant, by the payload allowlist's naming rule. */
export function isDateKey(key: string): boolean {
  return DAY_KEYS.has(key) || /(At|On)$/.test(key) || key === "windowEnd";
}

/** One value as a reader should see it: a day as "22 Oct", a closed word in plain English, a count with commas. */
export function formatValue(key: string, value: string | number | boolean): string {
  if (key === "percent" && typeof value === "number") return `${value}%`;
  if (typeof value === "number") return value.toLocaleString("en-US");
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (isDateKey(key) && ISO_DATE.test(value)) return formatDay(value);
  // A closed field prints only its words: a value off its list prints nothing.
  return closedWord(key, value) ?? (Object.hasOwn(CLOSED_WORDS, key) ? "" : value);
}

/** "day" → "days", "closed day" → "closed days", "try" → "tries". */
export function plural(noun: string): string {
  if (/[^aeiou]y$/.test(noun)) return `${noun.slice(0, -1)}ies`;
  if (/(s|x|ch|sh)$/.test(noun)) return `${noun}es`;
  return `${noun}s`;
}

const PLACEHOLDER = /\{([A-Za-z][A-Za-z0-9]*)(?::([a-z][a-z -]*))?\}/g;
/** `[ … ]`, or `[?key=a|b: … ]`, kept only when key's value is one of a, b. Never nested. */
const CLAUSE = /\[(?:\?([A-Za-z][A-Za-z0-9]*)=([a-z0-9_|]+):\s?)?([^[\]]*)\]/g;

/** Every key a text names, in a placeholder or a clause's condition, in order. For the lint test. */
export function placeholdersOf(text: string): string[] {
  const keys: string[] = [];
  for (const m of text.matchAll(CLAUSE)) if (m[1]) keys.push(m[1]);
  for (const m of text.matchAll(PLACEHOLDER)) keys.push(m[1]!);
  return keys;
}

/** The placeholders a text names outside any clause. */
export function requiredPlaceholdersOf(text: string): string[] {
  return [...text.replace(CLAUSE, "").matchAll(PLACEHOLDER)].map((m) => m[1]!);
}

/** A text with its clauses' conditions and brackets taken away: what a reader may see. For the lint test. */
export function clauseText(text: string): string {
  return text.replace(CLAUSE, (_whole, _key, _values, inner: string) => inner);
}

function present(values: WordingValues, key: string): boolean {
  const value = values[key];
  return typeof value === "number" ? Number.isFinite(value) : typeof value === "string" && value.length > 0;
}

/** Where a sentence starts: the beginning, or after a full stop, a question or exclamation mark, or a colon. */
function startsSentence(before: string): boolean {
  return /(^|[.!?:]\s+|\n)$/.test(plainText(before));
}

/**
 * How a marked fill emphasises what it fills in (lane N4): `values` bolds
 * every filled value; a day is highlighted whenever the fill is marked.
 * Without marks a fill is plain text, as before.
 */
export type FillMarks = { values: boolean; neutral?: boolean };

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** One value, or its fallback; capitalised when it opens a sentence; marked when the fill is. */
function valueText(
  key: string,
  noun: string | undefined,
  values: WordingValues,
  before: string,
  marks?: FillMarks,
): string {
  let out: string;
  if (!present(values, key)) {
    out = noun ? `some ${plural(noun)}` : (FALLBACKS[key] ?? "an unrecorded value");
  } else {
    const value = values[key]!;
    if (noun) {
      const n = typeof value === "number" ? value : Number(value);
      // A zero reads as words, never "0 days" or "0 steps" (lane N4 review):
      // a day count of 0 is "less than a day", any other "no <things>".
      if (n === 0) out = noun === "day" ? "less than a day" : `no ${plural(noun)}`;
      else out = `${formatValue(key, value)} ${n === 1 ? noun : plural(noun)}`;
    } else out = formatValue(key, value);
  }
  // A value never brings emphasis of its own (a clinic called "**Glow**").
  out = neutraliseValue(out);
  out = startsSentence(before) ? capitalise(out) : out;
  if (!marks || !present(values, key)) return out;
  if (DAY_KEYS.has(key)) out = mark("highlight", out);
  // In a step, a value is fenced off so a name like "Care tab Clinic" is
  // never taken for a console place (./markup.ts emphasisePlaces).
  if (marks.neutral) out = mark("value", out);
  return marks.values ? mark("bold", out) : out;
}

/** Placeholders in a piece of wording with no clauses, appended to `out` in one pass. */
function substituteInto(out: string, text: string, values: WordingValues, marks?: FillMarks): string {
  let last = 0;
  for (const m of text.matchAll(PLACEHOLDER)) {
    out += text.slice(last, m.index);
    out += valueText(m[1]!, m[2], values, out, marks);
    last = m.index! + m[0].length;
  }
  return out + text.slice(last);
}

function clauseKept(values: WordingValues, inner: string, key?: string, allowed?: string): boolean {
  if (key !== undefined) {
    const value = values[key];
    if (typeof value !== "string" || !(allowed ?? "").split("|").includes(value)) return false;
  }
  return [...inner.matchAll(PLACEHOLDER)].every((m) => present(values, m[1]!));
}

/** Fill one text in one pass: clauses kept or dropped, every placeholder filled; tidy what a dropped clause leaves. */
export function fill(text: string, values: WordingValues, marks?: FillMarks): string {
  let out = "";
  let last = 0;
  for (const m of text.matchAll(CLAUSE)) {
    out = substituteInto(out, text.slice(last, m.index), values, marks);
    if (clauseKept(values, m[3]!, m[1], m[2])) {
      // A conditional clause is a sentence of its own: it follows the last with a space.
      if (m[1] && /[.!?:]$/.test(out)) out += " ";
      out = substituteInto(out, m[3]!, values, marks);
    }
    last = m.index! + m[0].length;
  }
  out = substituteInto(out, text.slice(last), values, marks);
  return out
    .replace(/[ \t]{2,}/g, " ")
    .replace(/ +([.,;:)])/g, "$1")
    .replace(/\( +/g, "(")
    .trim();
}

export type FilledWording = {
  title: string;
  whatHappened: string;
  whyItMatters: string;
  steps: string[];
};

/** A whole wording, filled. Steps that fill to nothing are dropped. */
export function fillWording(wording: AlertWording, raw: WordingValues): FilledWording {
  // `code` and `status` print only as this event's words (./words.ts).
  const values = scopeToEvent(raw, wording.event);
  return {
    title: fill(wording.title, values),
    whatHappened: fill(wording.whatHappened, values),
    whyItMatters: fill(wording.whyItMatters, values),
    steps: wording.steps.map((step) => fill(step, values)).filter((step) => step.length > 0),
  };
}

/** The numbered steps as lines: "1. Open …". */
export function numberedSteps(steps: readonly string[]): string[] {
  return steps.map((step, index) => `${index + 1}. ${step}`);
}

/** The keys a wording prints in its sentences (placeholders, not conditions): left out of the facts. */
export function printedKeys(wording: AlertWording): Set<string> {
  // With a headline of its own, the first sentence of what happened is not
  // printed (the headline says it): its values go to the facts instead.
  const happened = wording.headline
    ? [wording.headline, splitFirstSentence(wording.whatHappened)[1]]
    : [wording.whatHappened];
  const texts = [...happened, wording.whyItMatters, ...wording.steps];
  return new Set(texts.flatMap((t) => [...t.matchAll(PLACEHOLDER)].map((m) => m[1]!)));
}

/**
 * A wording's text split after its first sentence, outside any clause: the
 * part a headline replaces, and the rest. Read on the template, so a
 * clause's own full stop never splits it.
 */
export function splitFirstSentence(template: string): [string, string] {
  let depth = 0;
  for (let i = 0; i < template.length; i += 1) {
    const ch = template[i]!;
    if (ch === "[") depth += 1;
    else if (ch === "]") depth -= 1;
    else if (depth === 0 && /[.!?]/.test(ch) && (i + 1 === template.length || /[\s[]/.test(template[i + 1]!))) {
      return [template.slice(0, i + 1), template.slice(i + 1).trimStart()];
    }
  }
  return [template, ""];
}

/**
 * An alert laid out to be read in three seconds (lane N4; owner, 24 October
 * 2026): how urgent it is, one headline, the one thing to do first, and the
 * rest below. Every text is marked (./markup.ts): parse it for HTML, plain
 * text or Slack. Step 1 is `doFirst` and appears nowhere else; `then` is
 * steps 2 onwards.
 */
export type AlertLayout = {
  urgency: Urgency;
  /** The subject's words, plain. */
  title: string;
  headline: string;
  /** True when the wording has no headline yet: the title with the clinic's name. */
  headlineIsFallback: boolean;
  doFirst: string | null;
  /** What happened after the headline's own sentence (all of it under a fallback headline). */
  detail: string;
  whyItMatters: string;
  then: string[];
};

/** The layout of one alert, from its wording and its allow-listed values. */
export function layoutAlert(wording: AlertWording, raw: WordingValues): AlertLayout {
  const values = scopeToEvent(raw, wording.event);
  const urgency = wording.event ? URGENCY[wording.event] : "today";
  const bold: FillMarks = { values: true };
  const plain: FillMarks = { values: false };
  const fallback = !wording.headline;
  // A long clinic name never pushes the headline past one line: it is cut to
  // what the rest of the line leaves (at most HEADLINE_NAME_MAX, at least
  // HEADLINE_NAME_MIN characters). The body and the facts keep the full name.
  const build = (name: string | null) => {
    const v = name === null ? values : { ...values, clinicName: name };
    return fallback ? fallbackHeadline(wording.title, v, bold) : fill(wording.headline!, v, bold);
  };
  let headline = build(null);
  const fullName = typeof values.clinicName === "string" ? values.clinicName : null;
  if (fullName && plainText(headline).length > HEADLINE_MAX) {
    const rest = plainText(headline).length - fullName.length * (plainText(headline).split(fullName).length - 1);
    const budget = Math.max(HEADLINE_NAME_MIN, Math.min(HEADLINE_NAME_MAX, HEADLINE_MAX - rest));
    headline = build(shortName(fullName, budget));
  }
  let detail: string;
  if (fallback) {
    // The first sentence's values bold, the rest plain: the eye lands on who and what.
    const [first, rest] = splitFirstSentence(wording.whatHappened);
    detail = [fill(first, values, bold), fill(rest, values, plain)].filter(Boolean).join(" ");
  } else {
    detail = fill(splitFirstSentence(wording.whatHappened)[1], values, plain);
  }
  const steps = wording.steps
    .map((step) => fill(step, values, { values: false, neutral: true }))
    .filter((step) => step.length > 0)
    .map(emphasisePlaces);
  return {
    urgency,
    title: fill(wording.title, values),
    headline,
    headlineIsFallback: fallback,
    doFirst: steps[0] ?? null,
    detail,
    whyItMatters: fill(wording.whyItMatters, values, plain),
    then: steps.slice(1),
  };
}

/**
 * The headline a wording without one gets: the title with the clinic's name
 * (lane N4 review). "A clinic's Google Calendar stopped working" for Glow
 * reads "Glow's Google Calendar stopped working", not "Glow: A clinic's …";
 * any other title reads "Glow: <title>"; with no clinic, the title once.
 */
function fallbackHeadline(title: string, values: WordingValues, marks: FillMarks): string {
  if (typeof values.clinicName !== "string" || !values.clinicName) return fill(title, values);
  const possessive = /^A clinic's (.+)$/.exec(title);
  if (possessive) return fill(`{clinicName}'s ${possessive[1]}`, values, marks);
  const subject = /^A clinic (.+)$/.exec(title);
  if (subject) return fill(`{clinicName} ${subject[1]}`, values, marks);
  return fill(`{clinicName}: ${title}`, values, marks);
}

/** A headline's longest line, and the most and least of a clinic's name it prints (lane N4 review). */
export const HEADLINE_MAX = 90;
export const HEADLINE_NAME_MAX = 40;
export const HEADLINE_NAME_MIN = 16;

/** A name cut to `max` characters at a word, with an ellipsis; a shorter one unchanged. */
export function shortName(name: string, max = HEADLINE_NAME_MAX): string {
  if (name.length <= max) return name;
  const cut = name.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > 10 ? cut.slice(0, space) : cut).replace(/[\s,.;:-]+$/, "")}…`;
}
