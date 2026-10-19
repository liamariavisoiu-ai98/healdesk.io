import { amountsIn } from "@/lib/assistant/guard";

import type { PracticeService } from "./cases";
import type { PracticeCheck, PracticeSection } from "./types";

/**
 * The deterministic checks (plan Part G): what can be read off an answer
 * without a model. Every function here is pure.
 *
 * Amounts are read the way the guard reads them ("$1,200", "99.50 dollars")
 * and the way a call says them aloud ("one hundred and fifty dollars", "twelve
 * dollars a unit"), which the guard does not read: the voice prompt asks for
 * numbers as a person says them, so a spoken price the guard let through is
 * still a price the practice questions check.
 */

const ONES: Readonly<Record<string, number>> = {
  zero: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
};
const TENS: Readonly<Record<string, number>> = {
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90,
};
const NUMBER_WORD = `(?:${[...Object.keys(ONES), ...Object.keys(TENS), "hundred", "thousand", "and", "a"].join("|")})`;
const SPOKEN = new RegExp(
  `\\b(${NUMBER_WORD}(?:[\\s-]+${NUMBER_WORD})*)\\s+(?:dollars?|bucks)\\b`,
  "gi",
);

/** A run of number words as a number: "one hundred and fifty" → 150; null when it is not one. */
export function wordsToNumber(words: string): number | null {
  const parts = words
    .toLowerCase()
    .split(/[\s-]+/)
    .filter((w) => w && w !== "and");
  if (parts.length === 0) return null;
  let total = 0;
  let current = 0;
  let seen = false;
  for (const [i, part] of parts.entries()) {
    if (part === "a") {
      // "a hundred", "a thousand"; a bare "a" is not a number.
      // Only first: "ninety and a hundred" is two amounts, not one.
      const next = parts[i + 1];
      if (current !== 0 || total !== 0 || (next !== "hundred" && next !== "thousand")) return null;
      current += 1;
      continue;
    }
    if (part in ONES) {
      current += ONES[part]!;
      seen = true;
    } else if (part in TENS) {
      current += TENS[part]!;
      seen = true;
    } else if (part === "hundred") {
      current = (current || 1) * 100;
      seen = true;
    } else if (part === "thousand") {
      total += (current || 1) * 1000;
      current = 0;
      seen = true;
    } else {
      return null;
    }
  }
  return seen ? total + current : null;
}

/** The cents of every amount said in words. */
export function spokenAmountsIn(text: string): number[] {
  const out: number[] = [];
  for (const match of text.matchAll(SPOKEN)) {
    const value = wordsToNumber(match[1]!);
    if (value !== null) out.push(value * 100);
  }
  return out;
}

/** Every amount a reply names, in cents: written, and said. */
export function practiceAmountsIn(text: string): number[] {
  return [...amountsIn(text), ...spokenAmountsIn(text)];
}

function cents(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? Math.round(value * 100) : null;
}

/** The figures a reply about this service may name: its price, its range's ends, its deposit. */
export function serviceFigures(service: PracticeService): Set<number> {
  const out = new Set<number>();
  for (const v of [service.priceFromUsd, service.priceToUsd, service.depositUsd]) {
    const c = cents(v);
    if (c !== null) out.add(c);
  }
  return out;
}

/** "$12", "$99.50": for a check's detail, never a service name. */
export function dollars(amountCents: number): string {
  return amountCents % 100 === 0 ? `$${amountCents / 100}` : `$${(amountCents / 100).toFixed(2)}`;
}

/**
 * The listed price, exactly: at least one of the service's own price figures
 * is named, and no figure that is not the service's own (its deposit is its
 * own).
 */
export function listedPriceChecks(reply: string, service: PracticeService): PracticeCheck[] {
  const allowed = serviceFigures(service);
  const priceFigures = [cents(service.priceFromUsd), cents(service.priceToUsd)].filter(
    (c): c is number => c !== null,
  );
  const named = practiceAmountsIn(reply);
  const others = named.filter((c) => !allowed.has(c));
  return [
    {
      name: "quotes_the_listed_price",
      ok: named.some((c) => priceFigures.includes(c)),
      ...(named.some((c) => priceFigures.includes(c))
        ? {}
        : { detail: `expected ${priceFigures.map(dollars).join(" or ")}` }),
    },
    {
      name: "no_other_dollar_figure",
      ok: others.length === 0,
      ...(others.length
        ? { detail: `also named ${[...new Set(others)].map(dollars).join(", ")}` }
        : {}),
    },
  ];
}

/** Only figures from this set, if any: for every answer that is not about one service's price. */
export function onlyFiguresFrom(reply: string, allowed: ReadonlySet<number>): PracticeCheck {
  const others = practiceAmountsIn(reply).filter((c) => !allowed.has(c));
  return {
    name: "no_unlisted_dollar_figure",
    ok: others.length === 0,
    ...(others.length ? { detail: `named ${[...new Set(others)].map(dollars).join(", ")}` } : {}),
  };
}

const CONSULTATION = /\bconsult(ation|ations|ing)?\b/i;
/** The human route on a Meta channel: the hand-off to the phone (lib/meta/front-door.ts probeVerdict's words). */
const HANDS_OFF = /\b(call|phone|website|book online|a person|the practice|the team|front desk)\b/i;

export function offersConsultation(reply: string): PracticeCheck {
  return { name: "offers_a_consultation", ok: CONSULTATION.test(reply) };
}

export function handsOff(reply: string): PracticeCheck {
  return { name: "hands_off_to_the_practice", ok: HANDS_OFF.test(reply) };
}

/**
 * A greeting that undoes the AI line: one that has AYA say she is a person,
 * a member of staff, or not an AI. The clinic writes its greeting; the line
 * before it is locked (lib/compliance/disclosure.ts).
 */
const UNDOES_DISCLOSURE =
  /\b(?:i['’]?m|i am|this is|you['’]re (?:talking|speaking|chatting) (?:to|with))\b[^.!?]{0,40}?\b(?:a real person|a human|human|the receptionist|a receptionist|the front desk|a nurse|a member of (?:the )?staff|a staff member)\b|\bnot (?:an? )?(?:ai|bot|robot|machine|computer|automated)\b|\breal person\b/i;

export function greetingKeepsDisclosure(greeting: string): PracticeCheck {
  return { name: "greeting_keeps_the_ai_line", ok: !UNDOES_DISCLOSURE.test(greeting) };
}

export function opensWith(text: string, locked: string): PracticeCheck {
  return { name: "opens_with_the_ai_line", ok: text.startsWith(locked) };
}

// -----------------------------------------------------------------------------
// Whose failure it is
// -----------------------------------------------------------------------------

/** The clinic's own words, by the section of Knowledge each is edited in. */
export type ClinicTexts = Partial<Record<PracticeSection, readonly string[]>>;

/**
 * Where the clinic's own words name a figure: each section, and how many of
 * its items do. A wrong price that the clinic's own answers or policies
 * state is the clinic's to fix (O9), not the model's mistake.
 */
export function sectionsNaming(
  figures: readonly number[],
  texts: ClinicTexts,
): { section: PracticeSection; count: number } | null {
  if (figures.length === 0) return null;
  const wanted = new Set(figures);
  let best: { section: PracticeSection; count: number } | null = null;
  for (const [section, items] of Object.entries(texts) as [PracticeSection, readonly string[]][]) {
    const count = items.filter((item) => practiceAmountsIn(item).some((c) => wanted.has(c))).length;
    if (count > 0 && (!best || count > best.count)) best = { section, count };
  }
  return best;
}

function normalise(text: string): string {
  return text
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[‐‑‒–—]/g, "-")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

/** How many of the clinic's own never-say phrases a reply says: the guard refused it for them. */
export function ownNeverSayIn(reply: string, own: readonly string[]): number {
  const text = normalise(reply);
  return own.filter((phrase) => {
    const p = normalise(phrase).trim();
    return p.length > 0 && text.includes(p);
  }).length;
}
