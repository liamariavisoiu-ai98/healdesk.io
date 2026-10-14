import type { PracticeSection } from "./types";

/**
 * Where a practice-question failure on the clinic's own data is fixed: the
 * Knowledge section or Settings card, as the portal names it and links to
 * it, and what one thing in it is called. O9, the tracker and Home's
 * "Needs attention" all say it in these words, and never name the service.
 */

export type SectionWords = {
  /** "Knowledge → Prices". */
  place: string;
  /** The screen and its anchor, under /c/<slug>/. */
  path: string;
  one: string;
  many: string;
  /** "Prices", for "We're double-checking your change to Prices". */
  name: string;
};

export const PRACTICE_SECTION_WORDS: Readonly<Record<PracticeSection, SectionWords>> = {
  practice: {
    place: "Knowledge → Your practice",
    path: "knowledge#practice",
    one: "detail",
    many: "details",
    name: "Your practice",
  },
  prices: {
    place: "Knowledge → Prices",
    path: "knowledge#prices",
    one: "price",
    many: "prices",
    name: "Prices",
  },
  policies: {
    place: "Knowledge → Policies",
    path: "knowledge#policies",
    one: "policy",
    many: "policies",
    name: "Policies",
  },
  promotions: {
    place: "Knowledge → Promotions",
    path: "knowledge#promotions",
    one: "line",
    many: "lines",
    name: "Promotions",
  },
  quick_answers: {
    place: "Knowledge → Quick answers",
    path: "knowledge#quick-answers",
    one: "answer",
    many: "answers",
    name: "Quick answers",
  },
  never_say: {
    place: "Knowledge → Never say",
    path: "knowledge#never-say",
    one: "phrase",
    many: "phrases",
    name: "Never say",
  },
  hours: {
    place: "Knowledge → Hours",
    path: "knowledge#hours",
    one: "line",
    many: "lines",
    name: "Hours",
  },
  how_aya_talks: {
    place: "Settings → How AYA talks",
    path: "settings#how-aya-talks",
    one: "greeting",
    many: "greetings",
    name: "How AYA talks",
  },
  safety_net: {
    place: "Settings → Safety net",
    path: "settings#safety-net",
    one: "number",
    many: "numbers",
    name: "Safety net",
  },
};

/** "1 price in Knowledge → Prices". */
export function whatToFix(section: PracticeSection, count: number): string {
  const words = PRACTICE_SECTION_WORDS[section];
  const n = Math.max(1, Math.round(count));
  return `${n} ${n === 1 ? words.one : words.many} in ${words.place}`;
}

/** "/c/<slug>/knowledge#prices". */
export function sectionPath(slug: string, section: PracticeSection): string {
  return `/c/${slug}/${PRACTICE_SECTION_WORDS[section].path}`;
}
