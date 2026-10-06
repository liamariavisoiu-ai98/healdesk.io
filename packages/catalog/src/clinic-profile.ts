import { findClinicalContent, serviceNameScreen } from "./clinical-content";
import { isSpecialtyId, type SpecialtyId } from "./specialties";

/**
 * What the funnel learned from a clinic's own website: ClinicProfile, version 1.
 *
 * At checkout the buyer types the clinic's website and apps/web reads it in
 * the background (app/api/clinic-site). The profile goes back to the browser,
 * which keeps it and sends it into the checkout intent at Pay; apps/app keeps
 * it as the setup wizard's starting point and, later, as the baseline the
 * monthly drift check compares a fresh read against. So setup starts
 * pre-filled ("We read glowmedspa.com: 14 services, your hours, 3 providers")
 * and the funnel never asks for what the site already says
 * (docs/design/funnel-onboarding-portal-2026-10-06.md, Part B).
 *
 * Everything in it is what a practice publishes about itself: services and
 * prices, addresses and hours, the people who work there, its policies and
 * its answers to common questions. Business data, never patient information.
 * The read is told not to copy a patient's name, testimonial or story, and
 * `screenClinicProfile` takes out anything clinical before the profile leaves
 * apps/web.
 *
 * ## Why the parser trusts nothing
 *
 * Between apps/web and apps/app the profile lives in a browser, which can
 * change it. So `parseClinicProfile` is the whole contract: the exact keys at
 * every level, a hard cap on every count and every string, and nothing else
 * rides along. A profile that breaks any rule is refused whole, never
 * repaired, because a repair is a guess about what a stranger meant. What it
 * cannot check is whether the text is true, or clinical under the specialty
 * the clinic actually bought under: `practiceKind` is only what the website
 * looked like, so apps/app screens again, with `screenClinicProfile` and the
 * clinic's own specialty.
 */

export const CLINIC_PROFILE_VERSION = 1;

/**
 * How a menu states a price: the plan's "price kinds" registry.
 *
 * - `exact`: one price, "$199".
 * - `from`: a starting price, "from $650".
 * - `range`: a low and a high, "$300 to $450"; `maxUsd` is the high one.
 * - `per_unit`: a price per something, "$14 per unit", "$650 per syringe";
 *   `unit` is the something.
 *
 * Named for services because plans.ts already exports `PriceKind` for
 * Stripe's month, year and setup prices, and both reach the catalog's index.
 */
export const SERVICE_PRICE_KINDS = ["exact", "from", "range", "per_unit"] as const;
export type ServicePriceKind = (typeof SERVICE_PRICE_KINDS)[number];

export function isServicePriceKind(value: unknown): value is ServicePriceKind {
  return typeof value === "string" && (SERVICE_PRICE_KINDS as readonly string[]).includes(value);
}

/** Whether the website says the practice takes insurance. Most say nothing, so unknown is an answer. */
export const ACCEPTS_INSURANCE = ["yes", "no", "unknown"] as const;
export type AcceptsInsurance = (typeof ACCEPTS_INSURANCE)[number];

/**
 * The days of apps/app's OpeningHours (lib/clinic/opening-hours.ts), in its
 * order, so a location's hours go to `parseOpeningHours` unchanged.
 */
export const PROFILE_DAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
export type ProfileDayKey = (typeof PROFILE_DAY_KEYS)[number];

/** `{ mon: [["09:00", "17:00"]], sun: [], … }`: 24-hour HH:MM, local time; an empty list is closed that day. */
export type ProfileHours = {
  readonly [K in ProfileDayKey]: readonly (readonly [string, string])[];
};

export type ProfileLocation = {
  /** The location's own name, or the clinic's when there is one location. */
  label: string;
  address: string | null;
  phone: string | null;
  /** Null when the site gives no hours, which is not the same as closed. */
  hours: ProfileHours | null;
};

export type ProfileService = {
  name: string;
  /** Null when the site states no price, and then so are the three after it. */
  priceKind: ServicePriceKind | null;
  priceUsd: number | null;
  /** The high end of a `range`; null for every other kind. */
  maxUsd: number | null;
  /** What a `per_unit` price is per ("unit", "syringe", "session"); null for every other kind. */
  unit: string | null;
  durationMinutes: number | null;
};

export type ProfileProvider = { name: string; title: string | null };

export type ProfileFaq = { question: string; answer: string };

export type ClinicProfile = {
  version: typeof CLINIC_PROFILE_VERSION;
  /** What was read: host and path as the buyer typed them, without the scheme. */
  website: string;
  /** When, as an ISO timestamp. */
  readAt: string;
  /** How many pages the read used. */
  pages: number;
  locations: ProfileLocation[];
  services: ProfileService[];
  providers: ProfileProvider[];
  policies: string[];
  faqs: ProfileFaq[];
  acceptsInsurance: AcceptsInsurance;
  /** The catalog specialty the site looks like, or null. A hint, never the specialty the clinic bought under. */
  practiceKind: SpecialtyId | null;
  /** How many services, policies and questions screening took out: the wizard's "We left out N items". */
  dropped: number;
};

/**
 * The hard caps. They bound what apps/app takes from a browser, not what a
 * practice may have: the wizard adds whatever the read left out.
 */
export const CLINIC_PROFILE_LIMITS = {
  /** The home page and the likeliest seven of its links. */
  pages: 8,
  locations: 20,
  services: 200,
  providers: 50,
  policies: 30,
  faqs: 30,
  /** A split shift is two ranges; four is already unusual. */
  rangesPerDay: 4,
  /** Every free-text field: names, labels, addresses, titles, policies, questions and answers. */
  text: 300,
  phone: 40,
  unit: 40,
  /** The same bound as apps/web's `cleanWebsite`. */
  website: 200,
  /** Dollars. A price above this is a misreading, not a menu. */
  priceUsd: 100_000,
  /** One day. */
  durationMinutes: 1_440,
  dropped: 1_000,
} as const;

/**
 * Control characters, bidirectional overrides and line separators. Nothing a
 * service or an address needs, and the overrides can make a portal show text
 * other than what is stored.
 */
const UNSAFE_CHARS =
  /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

/**
 * Text as a profile may hold it: unsafe characters out, whitespace collapsed
 * to single spaces, trimmed, and cut to `max` without splitting a character.
 * The site read cleans with it, and the parser accepts only text this leaves
 * unchanged, so the two cannot disagree about what is allowed.
 */
export function cleanProfileText(raw: string, max: number): string {
  const clean = raw
    .replace(UNSAFE_CHARS, " ")
    .replace(LONE_SURROGATE, "")
    .replace(/\s+/g, " ")
    .trim();
  if (clean.length <= max) return clean;
  const code = clean.charCodeAt(max - 1);
  const end = code >= 0xd800 && code <= 0xdbff ? max - 1 : max;
  return clean.slice(0, end).trimEnd();
}

/** The same shape apps/web's `cleanWebsite` produces: a host with a dot, an optional path, no scheme. */
const WEBSITE = /^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}(\/[^\s]*)?$/i;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const HH_MM = /^([01]\d|2[0-3]):[0-5]\d$/;

class Refused extends Error {}

function refuse(): never {
  throw new Refused();
}

/** A plain object with exactly these keys, no more and no fewer. */
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) refuse();
  const proto: unknown = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) refuse();
  const own = Object.keys(value);
  if (own.length !== keys.length || !keys.every((key) => Object.hasOwn(value, key))) refuse();
  return value as Record<string, unknown>;
}

function list<T>(value: unknown, max: number, item: (entry: unknown) => T): T[] {
  if (!Array.isArray(value) || value.length > max) refuse();
  return value.map(item);
}

function text(value: unknown, max: number): string {
  if (typeof value !== "string" || value.length === 0 || cleanProfileText(value, max) !== value) {
    refuse();
  }
  return value;
}

function nullable<T>(value: unknown, read: (present: unknown) => T): T | null {
  return value === null ? null : read(value);
}

function integer(value: unknown, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) refuse();
  return value;
}

/** Whole cents, from zero to the cap. */
function money(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) refuse();
  if (
    value < 0 ||
    value > CLINIC_PROFILE_LIMITS.priceUsd ||
    Math.round(value * 100) / 100 !== value
  )
    refuse();
  return value;
}

function hours(value: unknown): ProfileHours {
  const days = record(value, PROFILE_DAY_KEYS);
  const out = {} as Record<ProfileDayKey, (readonly [string, string])[]>;
  for (const day of PROFILE_DAY_KEYS) {
    out[day] = list(days[day], CLINIC_PROFILE_LIMITS.rangesPerDay, (range) => {
      if (!Array.isArray(range) || range.length !== 2) refuse();
      const [open, close] = range as unknown[];
      if (
        typeof open !== "string" ||
        typeof close !== "string" ||
        !HH_MM.test(open) ||
        !HH_MM.test(close)
      )
        refuse();
      return [open, close] as const;
    });
  }
  return out;
}

function location(value: unknown): ProfileLocation {
  const o = record(value, ["label", "address", "phone", "hours"]);
  return {
    label: text(o.label, CLINIC_PROFILE_LIMITS.text),
    address: nullable(o.address, (address) => text(address, CLINIC_PROFILE_LIMITS.text)),
    phone: nullable(o.phone, (phone) => text(phone, CLINIC_PROFILE_LIMITS.phone)),
    hours: nullable(o.hours, hours),
  };
}

function service(value: unknown): ProfileService {
  const o = record(value, ["name", "priceKind", "priceUsd", "maxUsd", "unit", "durationMinutes"]);
  const name = text(o.name, CLINIC_PROFILE_LIMITS.text);
  const priceKind =
    o.priceKind === null ? null : isServicePriceKind(o.priceKind) ? o.priceKind : refuse();
  const priceUsd = nullable(o.priceUsd, money);
  const maxUsd = nullable(o.maxUsd, money);
  const unit = nullable(o.unit, (u) => text(u, CLINIC_PROFILE_LIMITS.unit));
  const durationMinutes = nullable(o.durationMinutes, (d) =>
    integer(d, 1, CLINIC_PROFILE_LIMITS.durationMinutes),
  );
  // The price fields agree with the kind, so nothing downstream has to guess
  // which of them to read, or quote a per-unit price as the whole price.
  if (priceKind === null) {
    if (priceUsd !== null || maxUsd !== null || unit !== null) refuse();
  } else {
    if (priceUsd === null) refuse();
    if ((priceKind === "range") !== (maxUsd !== null)) refuse();
    if (maxUsd !== null && maxUsd <= priceUsd) refuse();
    if ((priceKind === "per_unit") !== (unit !== null)) refuse();
  }
  return { name, priceKind, priceUsd, maxUsd, unit, durationMinutes };
}

const PROFILE_KEYS = [
  "version",
  "website",
  "readAt",
  "pages",
  "locations",
  "services",
  "providers",
  "policies",
  "faqs",
  "acceptsInsurance",
  "practiceKind",
  "dropped",
] as const;

/**
 * Validate an untrusted profile. Null unless every rule holds; see the file
 * header for why nothing is repaired.
 */
export function parseClinicProfile(input: unknown): ClinicProfile | null {
  try {
    const o = record(input, PROFILE_KEYS);
    if (o.version !== CLINIC_PROFILE_VERSION) refuse();
    const website = text(o.website, CLINIC_PROFILE_LIMITS.website);
    if (!WEBSITE.test(website)) refuse();
    if (typeof o.readAt !== "string" || !ISO_INSTANT.test(o.readAt)) refuse();
    const readAt = new Date(o.readAt);
    if (Number.isNaN(readAt.getTime()) || readAt.toISOString() !== o.readAt) refuse();
    const acceptsInsurance = (ACCEPTS_INSURANCE as readonly unknown[]).includes(o.acceptsInsurance)
      ? (o.acceptsInsurance as AcceptsInsurance)
      : refuse();
    const practiceKind =
      o.practiceKind === null ? null : isSpecialtyId(o.practiceKind) ? o.practiceKind : refuse();
    return {
      version: CLINIC_PROFILE_VERSION,
      website,
      readAt: o.readAt,
      pages: integer(o.pages, 1, CLINIC_PROFILE_LIMITS.pages),
      locations: list(o.locations, CLINIC_PROFILE_LIMITS.locations, location),
      services: list(o.services, CLINIC_PROFILE_LIMITS.services, service),
      providers: list(o.providers, CLINIC_PROFILE_LIMITS.providers, (value) => {
        const p = record(value, ["name", "title"]);
        return {
          name: text(p.name, CLINIC_PROFILE_LIMITS.text),
          title: nullable(p.title, (title) => text(title, CLINIC_PROFILE_LIMITS.text)),
        };
      }),
      policies: list(o.policies, CLINIC_PROFILE_LIMITS.policies, (policy) =>
        text(policy, CLINIC_PROFILE_LIMITS.text),
      ),
      faqs: list(o.faqs, CLINIC_PROFILE_LIMITS.faqs, (value) => {
        const f = record(value, ["question", "answer"]);
        return {
          question: text(f.question, CLINIC_PROFILE_LIMITS.text),
          answer: text(f.answer, CLINIC_PROFILE_LIMITS.text),
        };
      }),
      acceptsInsurance,
      practiceKind,
      dropped: integer(o.dropped, 0, CLINIC_PROFILE_LIMITS.dropped),
    };
  } catch (error) {
    if (error instanceof Refused) return null;
    throw error;
  }
}

/**
 * The profile without anything clinical, with `dropped` counting what went.
 *
 * Each service name, each policy, and each question with its answer goes
 * through findClinicalContent, the guard every stored text in the product
 * goes through, and a hit removes the whole item: half a policy is a
 * different policy. Service names are screened by `serviceNameScreen`: in
 * full, except a veterinary practice's, which only the claims apply to. A
 * per-unit price's unit is read as "per {unit}", the notation the dosing
 * pattern lets through, so "$14 per unit" stays and "per dose" goes.
 *
 * apps/web passes the profile's own `practiceKind`. apps/app passes the
 * specialty the clinic bought under, which is the one that counts.
 */
export function screenClinicProfile(
  profile: ClinicProfile,
  specialty: SpecialtyId | null,
): ClinicProfile {
  const names = serviceNameScreen(specialty);
  let dropped = 0;
  const keep = (clinical: boolean): boolean => {
    if (clinical) dropped += 1;
    return !clinical;
  };
  const services = profile.services.filter((s) =>
    keep(
      findClinicalContent({ name: s.name, unit: s.unit === null ? null : `per ${s.unit}` }, names)
        .length > 0,
    ),
  );
  const policies = profile.policies.filter((policy) =>
    keep(findClinicalContent({ policy }).length > 0),
  );
  const faqs = profile.faqs.filter((faq) =>
    keep(findClinicalContent({ question: faq.question, answer: faq.answer }).length > 0),
  );
  return {
    ...profile,
    services,
    policies,
    faqs,
    dropped: Math.min(profile.dropped + dropped, CLINIC_PROFILE_LIMITS.dropped),
  };
}

/** The numbers in the Review & pay line: "We read glowmedspa.com: 14 services, your hours, 3 providers." */
export function summarizeClinicProfile(profile: ClinicProfile): {
  services: number;
  hours: boolean;
  providers: number;
} {
  return {
    services: profile.services.length,
    hours: profile.locations.some((l) => l.hours !== null),
    providers: profile.providers.length,
  };
}
