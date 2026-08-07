import type { BookingDetection, MapsPlace } from "./types.ts";

/**
 * Scheduler footprints, from docs/leadgen-playbook.md → Stage 2.
 *
 * Order matters only for reporting; all matches are collected. GoHighLevel is
 * the most detectable of the lot — it leaves msgsndr/leadconnector strings all
 * over the rendered page.
 */
const SIGNATURES: Record<string, readonly string[]> = {
  mindbody: ["mindbodyonline", "book.mindbody.io", "mindbody.io"],
  vagaro: ["vagaro.com"],
  gohighlevel: ["leadconnectorhq", "msgsndr", "leadconnector"],
  acuity: ["acuityscheduling", "squarespace-scheduling", "app.squarespacescheduling"],
  calendly: ["calendly.com"],
  square: ["squareup.com/appointments", "book.squareup.com"],
  booksy: ["booksy.com"],
  fresha: ["fresha.com"],
  schedulicity: ["schedulicity.com"],
  setmore: ["setmore.com"],
  jane: ["jane.app"],
  aestheticrecord: ["aestheticrecord.com"],
  zenoti: ["zenoti.com"],
  boulevard: ["getboulevard.com", "blvd.co", "joinblvd.com"],
  mangomint: ["mangomint.com"],
  pabau: ["pabau.com"],
  patientnow: ["patientnow.com"],
  aestheticspro: ["aestheticspro.com"],
};

/**
 * Booking platforms that indicate the clinic is already on an enterprise suite
 * with native AI bundled in. Per the playbook this is a *scoring* attribute,
 * not a hard exclude — the true exclusion is a live AI receptionist.
 */
export const ENTERPRISE_SUITES = new Set(["zenoti", "boulevard"]);

/** Link/button text that suggests scheduling intent. */
const BOOKING_TEXT = /\b(book|schedule|reserve|request\s+(an\s+)?appointment)\b/i;

/** A form that just emails the clinic is NOT self-serve booking. */
const CONTACT_FORM_HINTS =
  /\b(contact\s+us|request\s+(a\s+)?(consultation|callback|info)|send\s+(us\s+)?a\s+message)\b/i;

/**
 * Stage 1 filter — free, straight off the Maps payload.
 *
 * A populated `bookingLinks` means Reserve-with-Google is wired up, so the
 * clinic is definitively bookable. An empty one means nothing on its own:
 * most clinics run a widget on their own site without ever telling Google.
 */
export function detectFromMaps(place: MapsPlace): BookingDetection | null {
  const links = [
    ...(place.bookingLinks ?? []),
    ...(place.tableReservationLinks ?? []),
  ].filter((link) => link?.url);

  if (links.length > 0) {
    const urls = links.map((link) => link.url!).join(" ").toLowerCase();
    return {
      hasOnlineBooking: true,
      method: "widget",
      provider: providerFor(urls) ?? null,
      source: "reserve_with_google",
      matchedSignatures: matchesIn(urls),
    };
  }

  // No website at all — phone-only front desk. The hottest bucket for a voice
  // agent, and one a whitelist approach would make invisible.
  if (!place.website) {
    return {
      hasOnlineBooking: false,
      method: "phone_only",
      provider: null,
      source: "no_website",
      matchedSignatures: [],
    };
  }

  // Inconclusive — needs a rendered page fetch (Stage 2).
  return null;
}

/**
 * Stage 2 — footprint match against rendered page HTML.
 *
 * MUST be given output from a *rendering* crawler (Puppeteer/Playwright).
 * These widgets inject via JavaScript, so a plain HTTP fetch reports a false
 * "no booking" for a clinic that is perfectly bookable.
 */
export function detectFromHtml(html: string): BookingDetection {
  const haystack = html.toLowerCase();
  const matched = matchesIn(haystack);

  if (matched.length > 0) {
    return {
      hasOnlineBooking: true,
      method: "widget",
      provider: matched[0] ?? null,
      source: "footprint",
      matchedSignatures: matched,
    };
  }

  const hasBookingText = BOOKING_TEXT.test(html);
  const hasContactForm = CONTACT_FORM_HINTS.test(html);

  if (hasBookingText && !hasContactForm) {
    // Scheduling language with no recognised vendor — could be a self-hosted
    // widget or an unlisted one. Flag for LLM classification rather than guess.
    return {
      hasOnlineBooking: false,
      method: "none",
      provider: null,
      source: "footprint",
      matchedSignatures: [],
    };
  }

  return {
    hasOnlineBooking: false,
    method: hasContactForm ? "contact_form" : "phone_only",
    provider: null,
    source: "footprint",
    matchedSignatures: [],
  };
}

function matchesIn(haystack: string): string[] {
  const found: string[] = [];
  for (const [provider, needles] of Object.entries(SIGNATURES)) {
    if (needles.some((needle) => haystack.includes(needle))) found.push(provider);
  }
  return found;
}

function providerFor(haystack: string): string | undefined {
  return matchesIn(haystack)[0];
}
