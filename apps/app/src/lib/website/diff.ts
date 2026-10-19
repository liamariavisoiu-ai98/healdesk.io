import { createHash } from "node:crypto";

import {
  PROFILE_DAY_KEYS,
  type ClinicProfile,
  type ProfileFaq,
  type ProfileHours,
  type ProfileLocation,
  type ProfileProvider,
  type ProfileService,
} from "@healdesk/catalog";

import type { AgentService, KnowledgeAnswer } from "@/db/schema";
import type { OpeningHours } from "@/lib/clinic/opening-hours";
import { defaultAgentConfig, MAX_AGENT_SERVICES } from "@/lib/onboarding/agent-config";
import { serviceFromProfile } from "@/lib/setup/knowledge";
import { priceKindOf } from "@/lib/setup/prices";
import { toE164 } from "@/lib/setup/settings";

import type { WebsiteChangeKind, WebsiteChangeSection } from "./types";

/**
 * The drift list's diff (plan Part B, "Re-reads"; Part F3, "Changes on your
 * website"): a fresh read of a clinic's website against its baseline,
 * clinics.site_profile, per Knowledge section, and what of that Knowledge
 * does not already say.
 *
 * Both profiles have been through the purchase read's clinical screen
 * (screenClinicProfile, under the specialty the clinic bought) before they
 * reach here, so nothing clinical is compared, stored or shown.
 *
 * Each section compares items by a key, the item's name lower-cased with its
 * spacing collapsed: a service by its name, a question by its wording, a
 * provider by name, a policy by its whole text (a reworded policy is one
 * removed and one added). The location is the clinic's own: the one whose
 * address is the clinic's, else the one with the baseline's label, else the
 * first. Only that location's address, phone and hours are compared; another
 * location on the same website is another clinic's business.
 *
 * Pure: no database. The store (store.ts) reads the profiles and Knowledge
 * and records what this returns.
 */

/** What a change holds about its item, by section: the item as the website gives it. */
export type ChangeValueBySection = {
  practice: { field: "address" | "phone"; value: string };
  prices: ProfileService;
  hours: ProfileHours;
  providers: ProfileProvider;
  policies: { text: string };
  quick_answers: ProfileFaq;
};

export type WebsiteChange = {
  [S in WebsiteChangeSection]: {
    section: S;
    kind: WebsiteChangeKind;
    /** Which item: lower-cased, spacing collapsed. */
    key: string;
    /** The item in the baseline; null for an addition. */
    before: ChangeValueBySection[S] | null;
    /** The item on the website now; null for a removal. */
    after: ChangeValueBySection[S] | null;
  };
}[WebsiteChangeSection];

/** What the clinic's Knowledge says now, for the parts the website also says. */
export type KnowledgeView = {
  services: AgentService[];
  policies: string[];
  quickAnswers: KnowledgeAnswer[];
  /** The active named providers' names; empty for a practice booking any available time. */
  providers: string[];
  address: string | null;
  phoneE164: string | null;
  openingHours: OpeningHours | null;
};

/** A key: lower case, spacing collapsed. */
export function keyOf(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function digits(text: string): string {
  return text.replace(/\D/g, "");
}

/** The first item per key, in order: a website that lists a service twice is read once. */
function byKey<T>(items: readonly T[], key: (item: T) => string): Map<string, T> {
  const out = new Map<string, T>();
  for (const item of items) {
    const k = key(item);
    if (k && !out.has(k)) out.set(k, item);
  }
  return out;
}

// -----------------------------------------------------------------------------
// The clinic's location
// -----------------------------------------------------------------------------

/** The location of `profile` that is the clinic's: by its address, then by label, then the first. */
export function clinicLocation(
  profile: ClinicProfile | null,
  address: string | null,
  label: string | null = null,
): ProfileLocation | null {
  if (!profile || profile.locations.length === 0) return null;
  if (address) {
    const want = keyOf(address);
    const hit = profile.locations.find((l) => l.address !== null && keyOf(l.address) === want);
    if (hit) return hit;
  }
  if (label) {
    const want = keyOf(label);
    const hit = profile.locations.find((l) => keyOf(l.label) === want);
    if (hit) return hit;
  }
  return profile.locations[0]!;
}

// -----------------------------------------------------------------------------
// The diff
// -----------------------------------------------------------------------------

function serviceDiffers(a: ProfileService, b: ProfileService): boolean {
  return (
    a.priceKind !== b.priceKind ||
    a.priceUsd !== b.priceUsd ||
    a.maxUsd !== b.maxUsd ||
    keyOf(a.unit ?? "") !== keyOf(b.unit ?? "") ||
    a.durationMinutes !== b.durationMinutes
  );
}

/** The week as one comparable string, in the profile's day order. */
function weekKey(hours: ProfileHours | OpeningHours): string {
  const days = hours as unknown as Record<
    string,
    readonly (readonly [string, string])[] | undefined
  >;
  return PROFILE_DAY_KEYS.map(
    (day) => `${day}:${(days[day] ?? []).map(([open, close]) => `${open}-${close}`).join(",")}`,
  ).join(";");
}

/**
 * Everything the website says now that the baseline did not, per section.
 * `baseline` null is a clinic with no profile yet: every item is an addition.
 */
export function diffProfiles(
  baseline: ClinicProfile | null,
  next: ClinicProfile,
  clinic: { address: string | null },
): WebsiteChange[] {
  const out: WebsiteChange[] = [];
  const before = clinicLocation(baseline, clinic.address);
  const after = clinicLocation(next, clinic.address, before?.label ?? null);

  // Your practice: the location's address and main number. A website that
  // stops giving one is not saying the practice has none, so no removal.
  for (const field of ["address", "phone"] as const) {
    const now = after?.[field] ?? null;
    if (now === null) continue;
    const then = before?.[field] ?? null;
    const same =
      then !== null &&
      (field === "phone" ? digits(then) === digits(now) : keyOf(then) === keyOf(now));
    if (same) continue;
    out.push({
      section: "practice",
      kind: then === null ? "added" : "changed",
      key: field,
      before: then === null ? null : { field, value: then },
      after: { field, value: now },
    });
  }

  // Prices.
  const thenServices = byKey(baseline?.services ?? [], (s) => keyOf(s.name));
  const nowServices = byKey(next.services, (s) => keyOf(s.name));
  for (const [key, service] of nowServices) {
    const then = thenServices.get(key);
    if (!then) out.push({ section: "prices", kind: "added", key, before: null, after: service });
    else if (serviceDiffers(then, service)) {
      out.push({ section: "prices", kind: "changed", key, before: then, after: service });
    }
  }
  for (const [key, service] of thenServices) {
    if (!nowServices.has(key)) {
      out.push({ section: "prices", kind: "removed", key, before: service, after: null });
    }
  }

  // Hours: the location's week. No hours on the website is not "closed".
  const nowHours = after?.hours ?? null;
  const thenHours = before?.hours ?? null;
  if (nowHours !== null && (thenHours === null || weekKey(thenHours) !== weekKey(nowHours))) {
    out.push({
      section: "hours",
      kind: thenHours === null ? "added" : "changed",
      key: "weekly",
      before: thenHours,
      after: nowHours,
    });
  }

  // Providers, by name.
  const thenPeople = byKey(baseline?.providers ?? [], (p) => keyOf(p.name));
  const nowPeople = byKey(next.providers, (p) => keyOf(p.name));
  for (const [key, person] of nowPeople) {
    if (!thenPeople.has(key)) {
      out.push({ section: "providers", kind: "added", key, before: null, after: person });
    }
  }
  for (const [key, person] of thenPeople) {
    if (!nowPeople.has(key)) {
      out.push({ section: "providers", kind: "removed", key, before: person, after: null });
    }
  }

  // Policies, by their whole text.
  const thenPolicies = byKey(baseline?.policies ?? [], keyOf);
  const nowPolicies = byKey(next.policies, keyOf);
  for (const [key, text] of nowPolicies) {
    if (!thenPolicies.has(key)) {
      out.push({ section: "policies", kind: "added", key, before: null, after: { text } });
    }
  }
  for (const [key, text] of thenPolicies) {
    if (!nowPolicies.has(key)) {
      out.push({ section: "policies", kind: "removed", key, before: { text }, after: null });
    }
  }

  // Quick answers, from the website's own questions, by the question.
  const thenFaqs = byKey(baseline?.faqs ?? [], (f) => keyOf(f.question));
  const nowFaqs = byKey(next.faqs, (f) => keyOf(f.question));
  for (const [key, faq] of nowFaqs) {
    const then = thenFaqs.get(key);
    if (!then) out.push({ section: "quick_answers", kind: "added", key, before: null, after: faq });
    else if (keyOf(then.answer) !== keyOf(faq.answer)) {
      out.push({ section: "quick_answers", kind: "changed", key, before: then, after: faq });
    }
  }
  for (const [key, faq] of thenFaqs) {
    if (!nowFaqs.has(key)) {
      out.push({ section: "quick_answers", kind: "removed", key, before: faq, after: null });
    }
  }

  return out;
}

// -----------------------------------------------------------------------------
// What Knowledge already says
// -----------------------------------------------------------------------------

/** Whether a stored service states exactly what the website's does. */
function sameService(stored: AgentService, site: ProfileService): boolean {
  const want = serviceFromProfile(site);
  return (
    priceKindOf(stored) === want.priceKind &&
    stored.priceFromUsd === want.priceFromUsd &&
    stored.priceToUsd === want.priceToUsd &&
    keyOf(stored.unit ?? "") === keyOf(want.unit ?? "") &&
    stored.durationMinutes === want.durationMinutes
  );
}

/**
 * Whether a change still asks something of the clinic: Knowledge does not
 * already say what the website says. A change the clinic has made itself, or
 * one confirmed already, is not raised, and leaves the list when Knowledge
 * catches up. A new main number that is not a number AYA could give is never
 * raised. Provider changes are raised only for a practice that books by named
 * provider: one that books any available time has no providers for AYA.
 */
export function stillOpen(change: WebsiteChange, knowledge: KnowledgeView): boolean {
  switch (change.section) {
    case "practice": {
      const now = change.after;
      if (!now) return false;
      if (now.field === "phone") {
        const e164 = toE164(now.value);
        return e164 !== null && e164 !== knowledge.phoneE164;
      }
      return keyOf(knowledge.address ?? "") !== keyOf(now.value);
    }
    case "prices": {
      const stored = knowledge.services.find((s) => keyOf(s.name) === change.key);
      if (change.kind === "removed") return stored !== undefined;
      return !stored || !sameService(stored, change.after!);
    }
    case "hours":
      return (
        change.after !== null &&
        (knowledge.openingHours === null ||
          weekKey(knowledge.openingHours) !== weekKey(change.after))
      );
    case "providers": {
      if (knowledge.providers.length === 0) return false;
      const present = knowledge.providers.some((name) => keyOf(name) === change.key);
      return change.kind === "removed" ? present : !present;
    }
    case "policies": {
      const present = knowledge.policies.some((text) => keyOf(text) === change.key);
      return change.kind === "removed" ? present : !present;
    }
    case "quick_answers": {
      const stored = knowledge.quickAnswers.find((a) => keyOf(a.question) === change.key);
      if (change.kind === "removed") return stored !== undefined;
      return !stored || keyOf(stored.answer) !== keyOf(change.after!.answer);
    }
  }
}

/** The same change, whenever it is found: what the website says, about which item. */
export function fingerprintOf(change: WebsiteChange): string {
  return createHash("sha256")
    .update(JSON.stringify([change.section, change.kind, change.key, change.after]))
    .digest("hex");
}

// -----------------------------------------------------------------------------
// What the purchase read seeded, for a clinic still in setup
// -----------------------------------------------------------------------------

/**
 * The services provisioning left from a profile (lib/setup/seed.ts): the
 * read's, or, where it had none, the specialty's placeholders, which the
 * agent's default words seeded before it (lib/onboarding/agent-config.ts).
 */
export function seededServices(profile: ClinicProfile | null, specialty: string): AgentService[] {
  const read = (profile?.services ?? []).slice(0, MAX_AGENT_SERVICES).map(serviceFromProfile);
  return read.length > 0 ? read : defaultAgentConfig(specialty, "").services;
}

/** The quick answers provisioning seeded from a profile's FAQs. */
export function seededAnswers(profile: ClinicProfile | null): KnowledgeAnswer[] {
  return (profile?.faqs ?? []).map((f) => ({ question: f.question, answer: f.answer }));
}

function sameStoredService(a: AgentService, b: AgentService): boolean {
  return (
    a.name === b.name &&
    (a.priceKind ?? null) === (b.priceKind ?? null) &&
    a.priceFromUsd === b.priceFromUsd &&
    a.priceToUsd === b.priceToUsd &&
    (a.unit ?? null) === (b.unit ?? null) &&
    a.durationMinutes === b.durationMinutes &&
    (a.depositUsd ?? null) === (b.depositUsd ?? null)
  );
}

/** The same services, field by field, because jsonb does not keep key order. */
export function sameServices(a: readonly AgentService[], b: readonly AgentService[]): boolean {
  return a.length === b.length && a.every((s, i) => sameStoredService(s, b[i]!));
}

export function sameTexts(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((s, i) => s === b[i]);
}

export function sameAnswers(a: readonly KnowledgeAnswer[], b: readonly KnowledgeAnswer[]): boolean {
  return (
    a.length === b.length &&
    a.every((x, i) => x.question === b[i]!.question && x.answer === b[i]!.answer)
  );
}

/**
 * Whether a Knowledge list is still what the last read put there, or empty:
 * nobody at the clinic has touched it, so a read that becomes the baseline
 * may replace it.
 */
export function untouched<T>(
  stored: readonly T[],
  seeded: readonly T[],
  same: (a: readonly T[], b: readonly T[]) => boolean,
): boolean {
  return stored.length === 0 || same(stored, seeded);
}

// -----------------------------------------------------------------------------
// In words, for the Knowledge list
// -----------------------------------------------------------------------------

function money(value: number): string {
  return Number.isInteger(value) ? `$${value}` : `$${value.toFixed(2)}`;
}

/** A website service's price as its menu states it. */
export function priceWords(service: ProfileService): string {
  const length = service.durationMinutes ? `, ${service.durationMinutes} minutes` : "";
  switch (service.priceKind) {
    case null:
      return `no price listed${length}`;
    case "exact":
      return `${money(service.priceUsd!)}${length}`;
    case "from":
      return `from ${money(service.priceUsd!)}${length}`;
    case "range":
      return `${money(service.priceUsd!)} to ${money(service.maxUsd!)}${length}`;
    case "per_unit":
      return `${money(service.priceUsd!)} per ${service.unit}${length}`;
  }
}

const DAY_WORDS: Record<(typeof PROFILE_DAY_KEYS)[number], string> = {
  sun: "Sun",
  mon: "Mon",
  tue: "Tue",
  wed: "Wed",
  thu: "Thu",
  fri: "Fri",
  sat: "Sat",
};

/** "Mon 09:00–17:00 · Tue closed · …", Monday first. */
export function hoursWords(hours: ProfileHours): string {
  const order = [...PROFILE_DAY_KEYS.slice(1), PROFILE_DAY_KEYS[0]];
  return order
    .map((day) => {
      const ranges = hours[day];
      return `${DAY_WORDS[day]} ${
        ranges.length === 0 ? "closed" : ranges.map(([o, c]) => `${o}–${c}`).join(", ")
      }`;
    })
    .join(" · ");
}

/** One change in a sentence, and the line under it when there is one. */
export function describeChange(change: WebsiteChange): { text: string; detail: string | null } {
  switch (change.section) {
    case "practice": {
      const what = change.after!.field === "phone" ? "main number" : "address";
      return { text: `Your website gives your ${what} as ${change.after!.value}.`, detail: null };
    }
    case "prices":
      if (change.kind === "removed") {
        return { text: `${change.before!.name} is no longer on your website.`, detail: null };
      }
      return {
        text: `On your website: ${change.after!.name}, ${priceWords(change.after!)}.`,
        detail: change.kind === "changed" ? `Before: ${priceWords(change.before!)}.` : null,
      };
    case "hours":
      return {
        text:
          change.kind === "added"
            ? "Your website lists your opening hours."
            : "Your website's opening hours are different.",
        detail: hoursWords(change.after!),
      };
    case "providers": {
      const person = (change.after ?? change.before)!;
      return change.kind === "removed"
        ? { text: `${person.name} is no longer on your website.`, detail: null }
        : {
            text: `${person.name}${person.title ? `, ${person.title},` : ""} is on your website's team.`,
            detail: null,
          };
    }
    case "policies":
      return change.kind === "removed"
        ? { text: "A policy is no longer on your website.", detail: change.before!.text }
        : { text: "A policy is on your website.", detail: change.after!.text };
    case "quick_answers":
      if (change.kind === "removed") {
        return {
          text: `Your website no longer answers "${change.before!.question}"`,
          detail: null,
        };
      }
      return {
        text:
          change.kind === "added"
            ? `Your website answers "${change.after!.question}"`
            : `Your website answers "${change.after!.question}" differently.`,
        detail: change.after!.answer,
      };
  }
}
