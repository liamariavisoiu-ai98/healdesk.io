import {
  ACCEPTS_INSURANCE,
  CLINIC_PROFILE_LIMITS,
  CLINIC_PROFILE_VERSION,
  PROFILE_DAY_KEYS,
  SERVICE_PRICE_KINDS,
  cleanProfileText,
  isServicePriceKind,
  type AcceptsInsurance,
  type ClinicProfile,
  type ProfileDayKey,
  type ProfileFaq,
  type ProfileHours,
  type ProfileLocation,
  type ProfileProvider,
  type ProfileService,
} from "./clinic-profile";
import { isSpecialtyId, specialties } from "./specialties";

/**
 * The shape a model answers in when it reads a clinic's business facts, and
 * the cleaning of that answer into a ClinicProfile, shared by the two places
 * that read one: apps/web's website read (lib/site-read/extract.ts, public
 * pages, its own key) and apps/app's file read (lib/knowledge-file, a file a
 * clinic uploads to Your practice, healdesk's product key under the BAA).
 * Moved here from apps/web on 1 November 2026 so both read into one
 * definition; screening (screenClinicProfile) and the final check
 * (parseClinicProfile) stay with each caller.
 */

const TIME = {
  type: "string",
  pattern: "^[0-2][0-9]:[0-5][0-9]$",
  description: "24-hour HH:MM",
} as const;
const DAY = {
  type: "array",
  items: {
    type: "object",
    additionalProperties: false,
    required: ["open", "close"],
    properties: { open: TIME, close: TIME },
  },
} as const;

/**
 * The answer's shape. Absent beats null for the optional fields: the model
 * leaves out what a site does not say, which costs fewer tokens than a null
 * for each, and nine optional fields sit well inside the limits on optional
 * and union-typed parameters.
 */
export const EXTRACTION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "practiceKind",
    "acceptsInsurance",
    "locations",
    "services",
    "providers",
    "policies",
    "faqs",
  ],
  properties: {
    practiceKind: { enum: [...specialties.map((s) => s.id), null] },
    acceptsInsurance: { enum: [...ACCEPTS_INSURANCE] },
    locations: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["label"],
        properties: {
          label: { type: "string" },
          address: { type: "string" },
          phone: { type: "string" },
          hours: {
            type: "object",
            additionalProperties: false,
            required: [...PROFILE_DAY_KEYS],
            properties: Object.fromEntries(PROFILE_DAY_KEYS.map((day) => [day, DAY])),
          },
        },
      },
    },
    services: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name"],
        properties: {
          name: { type: "string" },
          priceKind: { enum: [...SERVICE_PRICE_KINDS] },
          priceUsd: { type: "number" },
          maxUsd: { type: "number" },
          unit: { type: "string" },
          durationMinutes: { type: "integer" },
        },
      },
    },
    providers: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name"],
        properties: { name: { type: "string" }, title: { type: "string" } },
      },
    },
    policies: { type: "array", items: { type: "string" } },
    faqs: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["question", "answer"],
        properties: { question: { type: "string" }, answer: { type: "string" } },
      },
    },
  },
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clean(value: unknown, max: number): string | null {
  return typeof value === "string" ? cleanProfileText(value, max) || null : null;
}

/** Whole cents within the cap, or null. */
function money(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  const cents = Math.round(value * 100) / 100;
  return cents <= CLINIC_PROFILE_LIMITS.priceUsd ? cents : null;
}

function time(value: unknown): string | null {
  const match = typeof value === "string" ? /^(\d{1,2}):(\d{2})$/.exec(value.trim()) : null;
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  return hour <= 23 && minute <= 59 ? `${String(hour).padStart(2, "0")}:${match[2]}` : null;
}

/**
 * Hours in the profile's shape, or null. All or nothing, as in apps/app's
 * opening-hours.ts: a schedule half understood is worse than none, because
 * none is visibly missing and half is confidently wrong.
 */
function hours(value: unknown): ProfileHours | null {
  if (!isRecord(value)) return null;
  const out = {} as Record<ProfileDayKey, (readonly [string, string])[]>;
  for (const day of PROFILE_DAY_KEYS) {
    const ranges = value[day];
    if (!Array.isArray(ranges) || ranges.length > CLINIC_PROFILE_LIMITS.rangesPerDay) return null;
    const pairs: (readonly [string, string])[] = [];
    for (const range of ranges) {
      const [rawOpen, rawClose] = Array.isArray(range)
        ? range
        : isRecord(range)
          ? [range.open, range.close]
          : [];
      const open = time(rawOpen);
      const close = time(rawClose);
      if (!open || !close) return null;
      pairs.push([open, close]);
    }
    out[day] = pairs;
  }
  return out;
}

/**
 * The price fields made to agree with the kind, or all four null. A
 * per-unit price without its unit, or a price without an amount, is dropped
 * rather than guessed: quoting "$14" for what is "$14 per unit" is worse
 * than quoting nothing, and setup asks for the price either way.
 */
function price(
  item: Record<string, unknown>,
): Pick<ProfileService, "priceKind" | "priceUsd" | "maxUsd" | "unit"> {
  const none = { priceKind: null, priceUsd: null, maxUsd: null, unit: null };
  const kind = typeof item.priceKind === "string" ? item.priceKind.toLowerCase() : null;
  let low = money(item.priceUsd);
  let high = money(item.maxUsd);
  if (!isServicePriceKind(kind) || low === null) return none;
  if (kind === "per_unit") {
    const unit = clean(item.unit, CLINIC_PROFILE_LIMITS.unit);
    return unit ? { priceKind: kind, priceUsd: low, maxUsd: null, unit } : none;
  }
  if (kind === "range") {
    if (high === null) return { priceKind: "from", priceUsd: low, maxUsd: null, unit: null };
    if (high === low) return { priceKind: "exact", priceUsd: low, maxUsd: null, unit: null };
    if (high < low) [low, high] = [high, low];
    return { priceKind: "range", priceUsd: low, maxUsd: high, unit: null };
  }
  return { priceKind: kind, priceUsd: low, maxUsd: null, unit: null };
}

/** At most `max` items, the first of each key, nothing that did not read. */
function collect<T>(
  value: unknown[],
  max: number,
  read: (item: unknown) => T | null,
  key: (item: T) => string,
): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const raw of value) {
    if (out.length >= max) break;
    const item = read(raw);
    if (!item) continue;
    const k = key(item).toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(item);
  }
  return out;
}

/**
 * The model's answer as a ClinicProfile, or null when its structure is wrong.
 * Within a sound structure, text is cleaned and cut to the caps, items with
 * nothing usable are skipped, and duplicates go; screening comes after.
 */
export function normalizeExtraction(
  raw: unknown,
  meta: { website: string; readAt: Date; pages: number },
): ClinicProfile | null {
  if (!isRecord(raw)) return null;
  const { locations, services, providers, policies, faqs } = raw;
  if (![locations, services, providers, policies, faqs].every(Array.isArray)) return null;
  const TEXT = CLINIC_PROFILE_LIMITS.text;
  const kind = typeof raw.practiceKind === "string" ? raw.practiceKind.toLowerCase() : null;
  const insurance =
    typeof raw.acceptsInsurance === "string" ? raw.acceptsInsurance.toLowerCase() : "";
  return {
    version: CLINIC_PROFILE_VERSION,
    website: meta.website,
    readAt: meta.readAt.toISOString(),
    pages: meta.pages,
    locations: collect<ProfileLocation>(
      locations as unknown[],
      CLINIC_PROFILE_LIMITS.locations,
      (item) => {
        if (!isRecord(item)) return null;
        const address = clean(item.address, TEXT);
        const phone = clean(item.phone, CLINIC_PROFILE_LIMITS.phone);
        const label = clean(item.label, TEXT) ?? address ?? phone;
        return label ? { label, address, phone, hours: hours(item.hours) } : null;
      },
      (l) => `${l.label}|${l.address ?? ""}`,
    ),
    services: collect<ProfileService>(
      services as unknown[],
      CLINIC_PROFILE_LIMITS.services,
      (item) => {
        if (!isRecord(item)) return null;
        const name = clean(item.name, TEXT);
        if (!name) return null;
        const minutes =
          typeof item.durationMinutes === "number" ? Math.round(item.durationMinutes) : NaN;
        const durationMinutes =
          minutes >= 1 && minutes <= CLINIC_PROFILE_LIMITS.durationMinutes ? minutes : null;
        return { name, ...price(item), durationMinutes };
      },
      (s) => s.name,
    ),
    providers: collect<ProfileProvider>(
      providers as unknown[],
      CLINIC_PROFILE_LIMITS.providers,
      (item) => {
        const name = isRecord(item) ? clean(item.name, TEXT) : null;
        return name && isRecord(item) ? { name, title: clean(item.title, TEXT) } : null;
      },
      (p) => p.name,
    ),
    policies: collect<string>(
      policies as unknown[],
      CLINIC_PROFILE_LIMITS.policies,
      (item) => clean(item, TEXT),
      (p) => p,
    ),
    faqs: collect<ProfileFaq>(
      faqs as unknown[],
      CLINIC_PROFILE_LIMITS.faqs,
      (item) => {
        if (!isRecord(item)) return null;
        const question = clean(item.question, TEXT);
        const answer = clean(item.answer, TEXT);
        return question && answer ? { question, answer } : null;
      },
      (f) => f.question,
    ),
    acceptsInsurance: (ACCEPTS_INSURANCE as readonly string[]).includes(insurance)
      ? (insurance as AcceptsInsurance)
      : "unknown",
    practiceKind: isSpecialtyId(kind) ? kind : null,
    dropped: 0,
  };
}

/** Whether a profile holds nothing at all: no location, service, provider, policy or question. */
export function isEmptyClinicProfile(profile: ClinicProfile): boolean {
  return [
    profile.locations,
    profile.services,
    profile.providers,
    profile.policies,
    profile.faqs,
  ].every((list) => list.length === 0);
}

