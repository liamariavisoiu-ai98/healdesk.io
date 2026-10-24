import { DAY_KEYS } from "./allow-list";
import type { AlertWording } from "./types";

/**
 * The one substitution the email and the Slack copy share (./types.ts has
 * the syntax). Plain text in, plain text out: each renderer escapes for its
 * own medium afterwards. Never prints `undefined`, `null` or a raw `{key}`:
 * a missing value drops its optional clause or prints its key's fallback.
 */

export type WordingValues = Readonly<Record<string, string | number>>;

/** What a missing value reads as outside an optional clause. */
export const FALLBACKS: Readonly<Record<string, string>> = {
  clinicName: "the clinic",
  business: "a clinic",
  meter: "allowance",
  section: "its booking settings",
  recommendation: "no suggestion",
  decision: "none yet",
  percent: "most",
  promisedOn: "the day we promised",
  windowStart: "the start of this month",
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
    let_close: "let the setup close",
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

/** A day as "22 Oct", in UTC: never a time. */
export function formatDay(iso: string): string {
  const at = new Date(/^\d{4}-\d{2}-\d{2}$/.test(iso) ? `${iso}T12:00:00Z` : iso);
  if (Number.isNaN(at.getTime())) return iso;
  return `${at.getUTCDate()} ${MONTHS[at.getUTCMonth()]}`;
}

/** One value as a reader should see it. */
export function formatValue(key: string, value: string | number): string {
  if (key === "percent" && typeof value === "number") return `${value}%`;
  if (typeof value === "number") return value.toLocaleString("en-US");
  if (DAY_KEYS.has(key)) return formatDay(value);
  return WORDS[key]?.[value] ?? value;
}

/** "day" → "days", "closed day" → "closed days", "try" → "tries". */
export function plural(noun: string): string {
  if (/[^aeiou]y$/.test(noun)) return `${noun.slice(0, -1)}ies`;
  if (/(s|x|ch|sh)$/.test(noun)) return `${noun}es`;
  return `${noun}s`;
}

const PLACEHOLDER = /\{([A-Za-z][A-Za-z0-9]*)(?::([a-z][a-z -]*))?\}/g;
const CLAUSE = /\[([^[\]]*)\]/g;

/** Every placeholder key a text names, in order. For the lint test. */
export function placeholdersOf(text: string): string[] {
  return [...text.matchAll(PLACEHOLDER)].map((m) => m[1]!);
}

/** The placeholders a text names outside any optional clause. */
export function requiredPlaceholdersOf(text: string): string[] {
  return placeholdersOf(text.replace(CLAUSE, ""));
}

function present(values: WordingValues, key: string): boolean {
  const value = values[key];
  return typeof value === "number" ? Number.isFinite(value) : typeof value === "string" && value.length > 0;
}

function substitute(text: string, values: WordingValues): string {
  return text.replace(PLACEHOLDER, (_whole, key: string, noun: string | undefined) => {
    if (!present(values, key)) {
      if (noun) return `some ${plural(noun)}`;
      return FALLBACKS[key] ?? "an unrecorded value";
    }
    const value = values[key]!;
    if (noun) {
      const n = typeof value === "number" ? value : Number(value);
      return `${formatValue(key, value)} ${n === 1 ? noun : plural(noun)}`;
    }
    return formatValue(key, value);
  });
}

/** Fill one text: optional clauses first, then every placeholder; tidy what a dropped clause leaves. */
export function fill(text: string, values: WordingValues): string {
  const clauses = text.replace(CLAUSE, (_whole, inner: string) =>
    placeholdersOf(inner).every((key) => present(values, key)) ? substitute(inner, values) : "",
  );
  return substitute(clauses, values)
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
