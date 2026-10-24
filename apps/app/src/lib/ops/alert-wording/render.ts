import { DAY_KEYS } from "./allow-list";
import type { AlertWording } from "./types";

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
};

/** Words a closed value reads as. Anything not here prints as it is. */
const WORDS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  meter: { voice_minutes: "voice minutes", chat_conversations: "chat conversations" },
  section: {
    hours: "weekly opening hours",
    closures: "closed days",
    location_hours: "opening hours at one of its locations",
    providers: "list of named providers",
    provider_services: "services each provider offers",
  },
  recommendation: {
    extend: "extend the setup window",
    offer_call: "offer a five-minute call",
    let_close: "let it close",
    wait: "wait a few more days",
    phone_the_clinic: "phone the clinic",
  },
  decision: {
    none: "none yet",
    extension_offered: "an extension was offered",
    let_close: "let it close",
    extended: "the window was extended",
  },
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
  return WORDS[key]?.[value] ?? value;
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
  return /(^|[.!?:]\s+|\n)$/.test(before);
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** One value, or its fallback; capitalised when it opens a sentence. */
function valueText(key: string, noun: string | undefined, values: WordingValues, before: string): string {
  let out: string;
  if (!present(values, key)) {
    out = noun ? `some ${plural(noun)}` : (FALLBACKS[key] ?? "an unrecorded value");
  } else {
    const value = values[key]!;
    if (noun) {
      const n = typeof value === "number" ? value : Number(value);
      out = `${formatValue(key, value)} ${n === 1 ? noun : plural(noun)}`;
    } else out = formatValue(key, value);
  }
  return startsSentence(before) ? capitalise(out) : out;
}

/** Placeholders in a piece of wording with no clauses, appended to `out` in one pass. */
function substituteInto(out: string, text: string, values: WordingValues): string {
  let last = 0;
  for (const m of text.matchAll(PLACEHOLDER)) {
    out += text.slice(last, m.index);
    out += valueText(m[1]!, m[2], values, out);
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
export function fill(text: string, values: WordingValues): string {
  let out = "";
  let last = 0;
  for (const m of text.matchAll(CLAUSE)) {
    out = substituteInto(out, text.slice(last, m.index), values);
    if (clauseKept(values, m[3]!, m[1], m[2])) {
      // A conditional clause is a sentence of its own: it follows the last with a space.
      if (m[1] && /[.!?:]$/.test(out)) out += " ";
      out = substituteInto(out, m[3]!, values);
    }
    last = m.index! + m[0].length;
  }
  out = substituteInto(out, text.slice(last), values);
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
export function fillWording(wording: AlertWording, values: WordingValues): FilledWording {
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
  const texts = [wording.whatHappened, wording.whyItMatters, ...wording.steps];
  return new Set(texts.flatMap((t) => [...t.matchAll(PLACEHOLDER)].map((m) => m[1]!)));
}
