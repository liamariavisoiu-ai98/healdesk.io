import {
  cleanProfileText,
  cleanWebsite,
  CLINIC_PROFILE_LIMITS,
  CLINIC_PROFILE_VERSION,
  type ClinicProfile as SiteProfile,
  isSpecialtyId,
  parseClinicProfile,
  type ProfileDayKey,
  type ProfileHours,
  type ProfileLocation,
  type ProfileService,
  screenClinicProfile,
} from "@healdesk/catalog";

import { weekSchedule } from "./opening-hours";
import type { ClinicProfile as DemoProfile, ClinicService } from "./profile";
import { profileOf, type DemoSession } from "./sessions";

/**
 * A built demo's profile as the checkout's website read (catalog
 * ClinicProfile v1), so what the demo learned carries on into setup when the
 * checkout's own read of the same site fails (owner, 13 October 2026: the
 * work built through "See it in your own branding" is built on later, not
 * thrown away).
 *
 * The checkout reads the buyer's website at step 2 and sends what it found
 * into the purchase, and apps/app starts the setup wizard and the knowledge
 * base from it (catalog clinic-profile.ts). The demo read the same site more
 * thoroughly, rendered, and had it audited, so when the checkout's read fails
 * api/checkout sends this instead of nothing. It is built on the server from
 * our own row, never from the browser, and only for the very website being
 * bought for; apps/app parses and screens it again under the specialty
 * bought, and the clinic confirms all of it in the wizard, as it does any read.
 *
 * Nothing is guessed. The demo keeps a price as the site wrote it ("from
 * $12/unit"); one that is not plainly one of the four price kinds becomes a
 * service without a price, which the wizard asks for. The same holds for a
 * duration, and hours are taken only when every row reads (the demo's own
 * calendar rule, `weekSchedule`). Anything the catalog parser would refuse
 * makes the whole conversion null, and the purchase goes ahead without it.
 */

const LIMIT = CLINIC_PROFILE_LIMITS;

/** "$450", "$1,200.50": the whole dollars and the cents. */
const AMOUNT = String.raw`\$\s?((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{2})?)`;
const EXACT = new RegExp(`^${AMOUNT}$`);
const FROM = new RegExp(`^(?:from|starting at|starts at|starting from)\\s+${AMOUNT}$|^${AMOUNT}\\s?\\+$`, "i");
const RANGE = new RegExp(`^${AMOUNT}\\s*(?:-|–|—|to)\\s*${AMOUNT}$`, "i");
const PER_UNIT = new RegExp(`^${AMOUNT}\\s*(?:/|per)\\s*([a-z][a-z ]{0,38}[a-z]|[a-z])$`, "i");

function dollars(raw: string | undefined): number | null {
  if (!raw) return null;
  const value = Number(raw.replace(/,/g, ""));
  return Number.isFinite(value) && value >= 0 && value <= LIMIT.priceUsd ? value : null;
}

type Price = Pick<ProfileService, "priceKind" | "priceUsd" | "maxUsd" | "unit">;

const NO_PRICE: Price = { priceKind: null, priceUsd: null, maxUsd: null, unit: null };

/** A price as the site stated it, read only when it is plainly one of the four kinds. */
export function readPrice(stated: string | null): Price {
  const text = stated?.trim().replace(/\s+/g, " ") ?? "";
  if (!text) return NO_PRICE;
  let match = EXACT.exec(text);
  if (match) {
    const usd = dollars(match[1]);
    return usd === null ? NO_PRICE : { priceKind: "exact", priceUsd: usd, maxUsd: null, unit: null };
  }
  match = FROM.exec(text);
  if (match) {
    const usd = dollars(match[1] ?? match[2]);
    return usd === null ? NO_PRICE : { priceKind: "from", priceUsd: usd, maxUsd: null, unit: null };
  }
  match = RANGE.exec(text);
  if (match) {
    const low = dollars(match[1]);
    const high = dollars(match[2]);
    return low === null || high === null || high <= low ? NO_PRICE : { priceKind: "range", priceUsd: low, maxUsd: high, unit: null };
  }
  match = PER_UNIT.exec(text);
  if (match) {
    const usd = dollars(match[1]);
    const unit = cleanProfileText(match[2]!.toLowerCase(), LIMIT.unit);
    return usd === null || !unit ? NO_PRICE : { priceKind: "per_unit", priceUsd: usd, maxUsd: null, unit };
  }
  return NO_PRICE;
}

/** "60 min", "45 minutes", "1.5 hours": whole minutes, or null when it says anything else. */
export function readDuration(stated: string | null): number | null {
  const text = stated?.trim().toLowerCase() ?? "";
  const minutes = /^(\d{1,4})\s?(?:m|min|mins|minutes?)$/.exec(text);
  const hours = /^(\d{1,2}(?:\.\d{1,2})?)\s?(?:h|hr|hrs|hours?)$/.exec(text);
  const value = minutes ? Number(minutes[1]) : hours ? Math.round(Number(hours[1]) * 60) : null;
  return value !== null && value >= 1 && value <= LIMIT.durationMinutes ? value : null;
}

/** weekSchedule's days run Monday to Sunday; the profile's are keyed by name. */
const WEEK: readonly ProfileDayKey[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

function clock(minutes: number): string {
  // Closing at midnight is the last minute of the day: the profile has no 24:00.
  const m = Math.min(minutes, 23 * 60 + 59);
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

/** The demo's hours, only when every row reads; never the demo calendar's 9-to-5 assumption. */
function readHours(rows: DemoProfile["hours"]): ProfileHours | null {
  const week = weekSchedule(rows);
  if (!week.listed) return null;
  const out = {} as Record<ProfileDayKey, (readonly [string, string])[]>;
  WEEK.forEach((day, i) => {
    out[day] = (week.days[i] ?? []).slice(0, LIMIT.rangesPerDay).map(([open, close]) => [clock(open), clock(close)] as const);
  });
  return out;
}

const clean = (value: string | null | undefined, max: number = LIMIT.text): string | null => {
  const text = value ? cleanProfileText(value, max) : "";
  return text || null;
};

function service(s: ClinicService): ProfileService | null {
  const name = clean(s.name);
  return name ? { name, ...readPrice(s.price), durationMinutes: readDuration(s.duration) } : null;
}

/**
 * The demo's read of `website`, as the checkout's, or null: no built demo,
 * another website, or nothing the catalog parser accepts.
 */
export function demoSiteProfile(session: DemoSession, website: string): SiteProfile | null {
  if (session.status !== "ready") return null;
  const profile = profileOf(session);
  if (!profile || cleanWebsite(session.websiteUrl) !== website) return null;

  const address = clean(profile.address);
  const phone = clean(profile.phone, LIMIT.phone);
  const hours = readHours(profile.hours);
  const label = clean(profile.clinicName) ?? clean(session.clinicName);
  const locations: ProfileLocation[] = label && (address || phone || hours) ? [{ label, address, phone, hours }] : [];
  const practiceKind = isSpecialtyId(profile.specialty) ? profile.specialty : isSpecialtyId(session.specialty) ? session.specialty : null;

  const candidate: SiteProfile = {
    version: CLINIC_PROFILE_VERSION,
    website,
    readAt: (session.readyAt ?? session.auditedAt ?? session.createdAt).toISOString(),
    // The row does not keep how many pages the demo read; one is the floor the parser takes.
    pages: 1,
    locations,
    services: profile.services.map(service).filter((s): s is ProfileService => s !== null).slice(0, LIMIT.services),
    providers: profile.providers
      .map((p) => ({ name: clean(p.name), title: clean(p.title) }))
      .filter((p): p is { name: string; title: string | null } => p.name !== null)
      .slice(0, LIMIT.providers),
    policies: profile.policies.map((p) => clean(p)).filter((p): p is string => p !== null).slice(0, LIMIT.policies),
    faqs: profile.faqs
      .map((f) => ({ question: clean(f.question), answer: clean(f.answer) }))
      .filter((f): f is { question: string; answer: string } => f.question !== null && f.answer !== null)
      .slice(0, LIMIT.faqs),
    acceptsInsurance: "unknown",
    practiceKind,
    dropped: 0,
  };
  return parseClinicProfile(screenClinicProfile(candidate, practiceKind));
}
