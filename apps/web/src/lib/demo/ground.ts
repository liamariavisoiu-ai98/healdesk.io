import { normalizeProfile, type ClinicProfile } from "./profile";
import type { ScrapedPage } from "./scrape";

/**
 * The extracted profile, checked against the pages it came from, in code,
 * before the audit sees it.
 *
 * The extraction runs at low effort to fit the build's minute
 * (lib/demo/structure.ts), and the one mistake that costs most is a figure the
 * website never printed: a price the demo then quotes as "what the website
 * lists". So every number in a service's price must appear on the pages, and a
 * price with one that does not is dropped (the service stays, priceless, and
 * the note says some prices were not found). The same for the phone number:
 * its digits must be on the pages, or it is dropped and the Google listing may
 * fill it (lib/demo/build.ts). Dropping a fact that cannot be shown beats
 * holding the whole demo for it.
 *
 * Also the clean-ups a person would make at a glance: an SEO tagline off the
 * clinic's name ("Smith Dental | Best Dentist in Austin"), and a service listed
 * twice under the same name.
 */

export type Grounded = { profile: ClinicProfile; dropped: string[] };

/** The pages' text with digit-group commas taken out, so "$1,200" and "1200" meet. */
function siteNumbers(pages: readonly ScrapedPage[]): string {
  return pages.map((p) => p.text).join("\n").replace(/(\d),(?=\d{3}\b)/g, "$1");
}

function numbersIn(price: string): string[] {
  return (price.replace(/(\d),(?=\d{3}\b)/g, "$1").match(/\d+(?:\.\d+)?/g) ?? []).map((n) => n.replace(/\.0+$/, ""));
}

function onPages(number: string, text: string): boolean {
  const escaped = number.replace(".", "\\.");
  return new RegExp(`(?<![\\d.])${escaped}(?:\\.0+)?(?![\\d])`).test(text);
}

/** "Smith Dental | Family Dentist in Austin" is "Smith Dental"; a name without a separator is left alone. */
export function cleanClinicName(name: string): string {
  const first = name.split(/\s[|–—·:]\s|\s-\s/)[0]!.trim();
  return first.length >= 2 ? first : name;
}

export function groundProfile(profile: ClinicProfile, pages: readonly ScrapedPage[]): Grounded {
  const text = siteNumbers(pages);
  const digits = text.replace(/\D/g, "");
  const dropped: string[] = [];

  const seen = new Set<string>();
  const services = profile.services
    .filter((s) => {
      const key = s.name.toLowerCase().replace(/\s+/g, " ").trim();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((s) => {
      if (!s.price) return s;
      const missing = numbersIn(s.price).filter((n) => !onPages(n, text));
      if (missing.length === 0) return s;
      dropped.push(`price "${s.price}" for ${s.name}`);
      return { ...s, price: null };
    });

  let phone = profile.phone;
  if (phone && profile.phoneSource !== "google") {
    const own = phone.replace(/\D/g, "").slice(-10);
    if (own.length < 7 || !digits.includes(own)) {
      dropped.push(`phone "${phone}"`);
      phone = null;
    }
  }

  const clinicName = cleanClinicName(profile.clinicName);
  return {
    profile: normalizeProfile({ ...profile, clinicName, services, phone, phoneSource: phone ? profile.phoneSource : null }, clinicName),
    dropped,
  };
}
