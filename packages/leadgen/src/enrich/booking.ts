import { isPlatformId } from "@healdesk/catalog";

/**
 * Which booking system a clinic runs, read off its own links.
 *
 * ## Why this is the most valuable column in the file
 *
 * Everything healdesk sells rests on the claim that calls are being lost. A
 * clinic whose patients already self-serve online is losing fewer of them, so
 * this field is the closest thing the pipeline has to a direct measure of the
 * product's value — far more load-bearing than the segment label, which only
 * says what the clinic sells.
 *
 * It also splits the list into three genuinely different sales conversations:
 *
 *   no booking system   The strongest fit. Every booking goes through the
 *                       phone, so every missed call is a missed booking. The
 *                       launch plan calls these the hottest prospects, and
 *                       nothing else in the data identifies them.
 *   supported platform  Can connect read-only and get VERIFIED attribution
 *                       rather than estimates — a materially better pitch, and
 *                       the id here is the same string the checkout picker
 *                       uses, so the campaign can deep-link into the funnel
 *                       with the platform already chosen.
 *   other platform      Bookable but unconnectable. Estimated attribution
 *                       only, and a weaker ROI story.
 *
 * ## Why URLs and not the model
 *
 * A clinic almost never names its booking vendor in prose. The page says
 * "Book Now" and the href says `clients.mindbodyonline.com` — the text carries
 * no information and the URL carries all of it. Asking a model to infer the
 * platform from page copy invites a confident guess; matching a URL is
 * evidence. So detection is deterministic, and the model's own
 * `offersOnlineBooking` guess is only consulted when no link matched.
 */

export type BookingPlatform = {
  id: string;
  name: string;
  /** Lowercased substrings that identify a booking URL for this platform. */
  signatures: readonly string[];
};

/**
 * The signature table.
 *
 * Ids match `packages/catalog/src/platforms.ts` wherever healdesk supports the
 * platform, so a detected `boulevard` is the same string the funnel's platform
 * picker expects. Platforms we do not connect to keep their own ids and are
 * reported as unsupported — still useful, since knowing a clinic is on Booksy
 * tells you the ROI story is weaker even though we cannot integrate.
 *
 * Signatures are deliberately narrow. `boulevard` alone would match every
 * clinic on a street called Boulevard; `blvd.app` matches the widget. The rule
 * throughout: prefer the booking subdomain over the vendor's marketing domain,
 * because a clinic linking to a vendor's blog is not a clinic using the vendor.
 */
export const BOOKING_PLATFORMS: readonly BookingPlatform[] = [
  // --- Platforms healdesk can connect to (ids match the catalog) -----------
  { id: "boulevard", name: "Boulevard", signatures: ["blvd.app", "joinblvd.com", "getboulevard.com", "blvd.co/"] },
  { id: "gohighlevel", name: "GoHighLevel", signatures: ["msgsndr.com", "leadconnectorhq.com", "gohighlevel.com/widget"] },
  { id: "zenoti", name: "Zenoti", signatures: ["zenoti.com", "webstore.zenoti.com"] },
  { id: "patientnow", name: "PatientNow", signatures: ["patientnow.com/book", "portal.patientnow.com"] },
  { id: "acuity", name: "Acuity Scheduling", signatures: ["acuityscheduling.com", "squarespacescheduling.com", "squarespace-scheduling.com"] },
  { id: "vagaro", name: "Vagaro", signatures: ["vagaro.com"] },
  { id: "mindbody", name: "Mindbody", signatures: ["mindbodyonline.com", "book.mindbody.io", "mindbody.io/book"] },

  // --- Everything else: real signal, no integration path ------------------
  { id: "booker", name: "Booker (Mindbody)", signatures: ["booker.com", "secure.booker.com"] },
  { id: "booksy", name: "Booksy", signatures: ["booksy.com"] },
  { id: "fresha", name: "Fresha", signatures: ["fresha.com"] },
  { id: "square", name: "Square Appointments", signatures: ["squareup.com/appointments", "book.squareup.com", "square.site/book"] },
  { id: "calendly", name: "Calendly", signatures: ["calendly.com"] },
  { id: "schedulicity", name: "Schedulicity", signatures: ["schedulicity.com"] },
  { id: "setmore", name: "Setmore", signatures: ["setmore.com"] },
  { id: "jane", name: "Jane App", signatures: ["jane.app", "janeapp.com"] },
  { id: "mangomint", name: "Mangomint", signatures: ["mangomint.com/book", "book.mangomint.com"] },
  { id: "aesthetic-record", name: "Aesthetic Record", signatures: ["aestheticrecord.com", "book.aestheticrecord.com"] },
  { id: "aestheticspro", name: "AestheticsPro", signatures: ["aestheticspro.com"] },
  { id: "pabau", name: "Pabau", signatures: ["pabau.com", "connect.pabau.com"] },
  { id: "phorest", name: "Phorest", signatures: ["phorest.com/book", "bookings.phorest.com"] },
  { id: "symplast", name: "Symplast", signatures: ["symplast.com", "symplastpatient.com"] },
  { id: "nextech", name: "Nextech", signatures: ["nextech.com/book", "nexhealth.com"] },
  { id: "tebra", name: "Tebra (PatientPop)", signatures: ["patientpop.com", "tebra.com/book"] },
  { id: "podium", name: "Podium", signatures: ["podium.com/scheduling"] },
  { id: "weave", name: "Weave", signatures: ["getweave.com/schedule"] },
  { id: "simplybook", name: "SimplyBook.me", signatures: ["simplybook.me", "simplybook.it"] },
  { id: "janeapp-ca", name: "Jane (CA)", signatures: [".ca.janeapp.com"] },
];

/**
 * Paths that look like self-serve booking on a clinic's own domain.
 *
 * Weaker evidence than a platform match, and treated as such: a custom or
 * white-labelled booking page is real, but so is a page called /booking that
 * only holds a phone number. Reported at medium confidence, never as a platform.
 */
const SELF_HOSTED_BOOKING = [
  "/book-now",
  "/book-online",
  "/booking",
  "/schedule-appointment",
  "/book-appointment",
  "/request-appointment",
  "/appointments",
];

/**
 * Links that look like booking but are not self-serve booking.
 *
 * The distinction the whole field turns on: a form that emails the clinic is
 * still a call the front desk has to make. Counting it as online booking would
 * mark a phone-dependent clinic as already served — dropping the best prospects
 * out of the segment built to find them.
 */
const NOT_BOOKING = [
  "/contact",
  "/consultation-request",
  "mailto:",
  "tel:",
  "/careers",
  "/jobs",
];

export type BookingDetection = {
  /** True only on real self-serve booking — not a contact form. */
  hasOnlineBooking: boolean;
  /** Catalog/vendor id, or null when nothing matched. */
  platform: string | null;
  platformName: string | null;
  /** Can healdesk connect to it read-only for verified attribution? */
  supported: boolean;
  /** The actual booking URL, so a human can check the call in one click. */
  bookingUrl: string | null;
  confidence: "high" | "medium" | "none";
  /** Every platform matched — a clinic mid-migration legitimately has two. */
  allPlatforms: string[];
};

export function detectBooking(links: readonly string[]): BookingDetection {
  const seen = new Map<string, string>();

  for (const raw of links) {
    const url = raw.toLowerCase();
    if (NOT_BOOKING.some((bad) => url.includes(bad))) continue;

    for (const platform of BOOKING_PLATFORMS) {
      if (seen.has(platform.id)) continue;
      if (platform.signatures.some((sig) => url.includes(sig))) {
        seen.set(platform.id, raw);
      }
    }
  }

  if (seen.size > 0) {
    // First by table order, which puts supported platforms first. When a clinic
    // matches both a supported and an unsupported platform, the supported one
    // is the more useful answer — it is the one that changes the pitch.
    const primary = BOOKING_PLATFORMS.find((p) => seen.has(p.id))!;
    return {
      hasOnlineBooking: true,
      platform: primary.id,
      platformName: primary.name,
      supported: isPlatformId(primary.id),
      bookingUrl: seen.get(primary.id) ?? null,
      confidence: "high",
      allPlatforms: [...seen.keys()],
    };
  }

  // No vendor matched. A booking-shaped path on their own domain is weaker
  // evidence but still evidence — plenty of clinics run a custom or
  // white-labelled widget.
  const selfHosted = links.find((raw) => {
    const url = raw.toLowerCase();
    if (NOT_BOOKING.some((bad) => url.includes(bad))) return false;
    return SELF_HOSTED_BOOKING.some((path) => url.includes(path));
  });

  if (selfHosted) {
    return {
      hasOnlineBooking: true,
      platform: null,
      platformName: "Custom or unrecognised",
      supported: false,
      bookingUrl: selfHosted,
      confidence: "medium",
      allPlatforms: [],
    };
  }

  return {
    hasOnlineBooking: false,
    platform: null,
    platformName: null,
    supported: false,
    bookingUrl: null,
    confidence: "none",
    allPlatforms: [],
  };
}

/** Platforms healdesk can connect to, for reporting. */
export const SUPPORTED_PLATFORM_IDS = BOOKING_PLATFORMS.filter((p) =>
  isPlatformId(p.id),
).map((p) => p.id);
