import {
  PROFILE_DAY_KEYS,
  type ClinicProfile,
  type ProfileHours,
  type ProfileService,
} from "@healdesk/catalog";

import type { AgentService, KnowledgeAnswer } from "@/db/schema";
import { serviceInputOf } from "@/lib/setup/knowledge";
import { hoursWords, keyOf, priceWords } from "@/lib/website/diff";

/**
 * What a file adds to Your practice (portal redesign, owner, 1 November
 * 2026): the screened profile read from a clinic's file (read.ts) against
 * what its page already says, as rows the clinic adds or skips. Only what
 * the page does not already say is offered: a treatment it does not list, or
 * one whose price or length the file gives differently; the weekly hours
 * when they differ; a policy or a question it does not have. Never the
 * address, the phone or the website, which change where calls and patients
 * go and stay typed; never providers or the never-say list.
 *
 * Pure: the page's knowledge comes in, the rows go out. Writing is
 * applyFileRows (apply.ts), through the knowledge writers, on the clinic's
 * tap.
 */

export type FileRow =
  | { id: string; section: "prices"; kind: "new" | "changed"; text: string; was: string | null; service: ProfileService }
  | { id: string; section: "hours"; kind: "new" | "changed"; text: string; was: string | null; hours: ProfileHours }
  | { id: string; section: "policies"; kind: "new"; text: string; was: null; policy: string }
  | {
      id: string;
      section: "quick_answers";
      kind: "new";
      text: string;
      was: null;
      answer: { question: string; answer: string };
    };

export type PageKnowledge = {
  services: readonly AgentService[];
  policies: readonly string[];
  quickAnswers: readonly KnowledgeAnswer[];
  mostAsked: KnowledgeAnswer | null;
  /** The weekly hours on file, by the same day keys, or null when none are set. */
  hours: Partial<Record<(typeof PROFILE_DAY_KEYS)[number], readonly (readonly [string, string])[]>> | null;
};

/** A stored service in the profile's shape, for priceWords. */
export function profileServiceOf(service: AgentService): ProfileService {
  // serviceInputOf reads the kind of a row stored before kinds were (priceKindOf).
  const input = serviceInputOf(service);
  return {
    name: input.name,
    priceKind: input.priceKind,
    priceUsd: input.priceKind === null ? null : input.price,
    maxUsd: input.priceKind === "range" ? input.maxPrice : null,
    unit: input.priceKind === "per_unit" ? input.unit : null,
    durationMinutes: input.durationMinutes,
  };
}

function samePrice(a: ProfileService, b: ProfileService): boolean {
  return (
    a.priceKind === b.priceKind &&
    a.priceUsd === b.priceUsd &&
    a.maxUsd === b.maxUsd &&
    (a.unit ?? "").toLowerCase() === (b.unit ?? "").toLowerCase()
  );
}

function sameHours(a: ProfileHours, b: PageKnowledge["hours"]): boolean {
  if (!b) return false;
  return PROFILE_DAY_KEYS.every((day) => {
    const x = a[day] ?? [];
    const y = b[day] ?? [];
    return x.length === y.length && x.every(([o, c], i) => y[i]?.[0] === o && y[i]?.[1] === c);
  });
}

function hasAnyHours(hours: PageKnowledge["hours"]): boolean {
  return Boolean(hours) && PROFILE_DAY_KEYS.some((day) => (hours?.[day]?.length ?? 0) > 0);
}

export function fileRows(profile: ClinicProfile, page: PageKnowledge): FileRow[] {
  const rows: FileRow[] = [];

  const current = new Map(page.services.map((s) => [keyOf(s.name), profileServiceOf(s)]));
  for (const service of profile.services) {
    const key = keyOf(service.name);
    const now = current.get(key);
    const words = `${service.name} · ${priceWords(service)}`;
    if (!now) {
      rows.push({ id: `prices:${key}`, section: "prices", kind: "new", text: words, was: null, service });
      continue;
    }
    // The file says nothing new about a treatment it gives no price for.
    if (service.priceKind === null) continue;
    const lengthDiffers =
      service.durationMinutes !== null && service.durationMinutes !== now.durationMinutes;
    if (!samePrice(service, now) || lengthDiffers) {
      rows.push({
        id: `prices:${key}`,
        section: "prices",
        kind: "changed",
        text: words,
        was: `Your page says ${priceWords(now)}`,
        service,
      });
    }
  }

  const fileHours = profile.locations.find((l) => l.hours !== null)?.hours ?? null;
  if (fileHours && PROFILE_DAY_KEYS.some((d) => fileHours[d].length > 0) && !sameHours(fileHours, page.hours)) {
    const had = hasAnyHours(page.hours);
    rows.push({
      id: "hours:weekly",
      section: "hours",
      kind: had ? "changed" : "new",
      text: `Hours: ${hoursWords(fileHours)}`,
      was: had && page.hours ? `Your page says ${hoursWords(fillDays(page.hours))}` : null,
      hours: fileHours,
    });
  }

  const policies = new Set(page.policies.map(keyOf));
  for (const policy of profile.policies) {
    const key = keyOf(policy);
    if (policies.has(key)) continue;
    policies.add(key);
    rows.push({ id: `policies:${key}`, section: "policies", kind: "new", text: policy, was: null, policy });
  }

  const questions = new Set([
    ...page.quickAnswers.map((a) => keyOf(a.question)),
    ...(page.mostAsked ? [keyOf(page.mostAsked.question)] : []),
  ]);
  for (const faq of profile.faqs) {
    const key = keyOf(faq.question);
    if (questions.has(key)) continue;
    questions.add(key);
    rows.push({
      id: `quick_answers:${key}`,
      section: "quick_answers",
      kind: "new",
      text: `${faq.question} ${faq.answer}`,
      was: null,
      answer: { question: faq.question, answer: faq.answer },
    });
  }

  return rows;
}

function fillDays(hours: NonNullable<PageKnowledge["hours"]>): ProfileHours {
  return Object.fromEntries(PROFILE_DAY_KEYS.map((d) => [d, [...(hours[d] ?? [])]])) as unknown as ProfileHours;
}

/** The section names a row is filed under, as Your practice shows them. */
export const FILE_ROW_SECTION_NAMES: Readonly<Record<FileRow["section"], string>> = {
  prices: "Prices",
  hours: "Hours",
  policies: "Policies",
  quick_answers: "Quick answers",
};
