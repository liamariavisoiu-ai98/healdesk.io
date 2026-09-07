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
  /**
   * Anchored patterns, for the cases a substring cannot express.
   *
   * Mostly negative lookaheads that exclude a vendor's own marketing
   * subdomains while still matching every tenant. Zenoti is the clearest
   * example: tenant booking lives at `<tenant>.zenoti.com/webstore`, but
   * `www.`, `help.`, `support.`, `resources.` and `blog.` are the vendor's own
   * and must not match. No substring separates those two sets.
   */
  patterns?: readonly RegExp[];
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
  {
    id: "boulevard",
    name: "Boulevard",
    signatures: ["//blvd.app/", "//dashboard.boulevard.io/booking"],
  },
  {
    id: "gohighlevel",
    name: "GoHighLevel",
    signatures: [
      "leadconnectorhq.com/widget/bookings/",
      "leadconnectorhq.com/widget/booking/",
      "leadconnectorhq.com/widget/group/",
      "msgsndr.com/widget/bookings/",
      "msgsndr.com/widget/booking/",
      "msgsndr.com/widget/group/",
      "ludicrous.cloud/widget/bookings/",
    ],
  },
  {
    id: "zenoti",
    name: "Zenoti",
    // /webstore and /webstoreNew are Zenoti's own path shape, and they travel
    // onto customer domains when the booking page is white-labelled — the live
    // crawl turned up book.vivecenter.com/webstoreNew/services, which a
    // .zenoti.com-anchored pattern can never match.
    signatures: [
      "//book.zenoti.com",
      "//booking.zenoti.com",
      "//webstore.zenoti.com",
      "/webstorenew/",
      "/webstore/services",
    ],
    patterns: [new RegExp("https?://(?!www\\.|help\\.|support\\.|resources\\.|blog\\.|go\\.|info\\.)[a-z0-9][a-z0-9-]*\\.zenoti\\.com/webstore", "i")],
  },
  {
    id: "patientnow",
    name: "PatientNow",
    signatures: ["//book.mypatientnow.com", "//scheduler.app.rxphoto.com", "book.mypatientnow.com/practice/", "mypatientnow.com/?pid=", "portal.mypatientnow.com", "schedulingapp.mypatientnow.com"],
  },
  {
    id: "acuity",
    name: "Acuity / Squarespace Scheduling",
    signatures: [".as.me/", "acuityscheduling.com/schedule.php", "acuityscheduling.com/schedule/", "embed.acuityscheduling.com/js/embed.js", "embed.squarespacescheduling.com/js/embed.js", "squarespacescheduling.com/schedule.php", "squarespacescheduling.com/schedule/"],
  },
  {
    id: "vagaro",
    name: "Vagaro",
    signatures: ["resources/widgetembeddedloader/", "vagaro.com/us01/", "vagaro.com/us02/", "vagaro.com/us03/", "vagaro.com/us04/", "vagaro.com/us05/"],
  },
  {
    id: "mindbody",
    name: "Mindbody",
    signatures: [".healcode.com/", "brandedweb-assets.mindbodyonline.com", "brandedweb.mindbodyonline.com", "cart.mindbodyonline.com", "clients.mindbodyonline.com", "javascripts/healcode.js", "widgets.mindbodyonline.com"],
  },
  {
    id: "aesthetic-record",
    name: "Aesthetic Record",
    signatures: [".myaestheticrecord.com/online-booking"],
  },
  {
    id: "aestheticspro",
    name: "AestheticsPro",
    signatures: ["myaestheticspro.com/bn/", "myaestheticspro.com/clientportal/"],
  },
  {
    id: "appointy",
    name: "Appointy",
    signatures: ["//booking.appointy.com/"],
  },
  // Found by auditing the live crawl rather than by research: each turned up
  // among clinics reported as having no booking at all. Path-anchored on the
  // same rule as the rest — a vendor's marketing domain must not match.
  {
    id: "klara",
    name: "Klara",
    signatures: ["patient.klara.com/#/widget"],
  },
  {
    id: "drchrono",
    name: "DrChrono",
    signatures: [".drchrono.com/welcome/", ".drchrono.com/o/"],
  },
  {
    id: "phreesia",
    name: "Phreesia",
    signatures: ["phreesia.me/", "phreesia.com/appointment"],
  },
  {
    id: "vsappointments",
    name: "VS Appointments",
    signatures: [".vsappointments.com/"],
  },
  {
    id: "prospyr",
    name: "Prospyr",
    signatures: ["book.prospyrmed.com/"],
  },
  {
    id: "birdeye",
    name: "Birdeye",
    signatures: ["//widget-v7-cdn.birdeye.com/", "//widgets-v7.birdeye.com/api/widgets"],
  },
  {
    id: "booker",
    name: "Booker (Mindbody)",
    signatures: [".secure-booker.com/", "//api.booker.com/", "//ccwidget.secure-booker.com", "//go.booker.com/"],
  },
  {
    id: "booksy",
    name: "Booksy",
    signatures: ["booksy.com/dl/show-business/", "booksy.com/en-us/dl/show-business/", "booksy.com/widget-2021/", "booksy.com/widget/code.js"],
  },
  {
    id: "calendly",
    name: "Calendly",
    signatures: ["assets.calendly.com/assets/external/", "calendly-inline-widget", "calendly.com/d/"],
  },
  {
    id: "cerbo",
    name: "Cerbo",
    signatures: ["md-hq.com/embedded/schedule", "md-hq.com/schedule_visit"],
  },
  {
    id: "fresha",
    name: "Fresha",
    signatures: ["fresha.com/a/"],
  },
  {
    id: "jane",
    name: "Jane App",
    signatures: [".janeapp.com/#/", ".janeapp.com/embed/book_online", "janeapp.com/locations/"],
    patterns: [new RegExp("\\.janeapp\\.(?:com|co\\.uk)/(?:locations/|#/)", "i"), new RegExp("https?://(?!www\\.|accounts\\.)[a-z0-9][a-z0-9-]*\\.janeapp\\.co\\.uk(?=[/\"'?#]|$)", "i"), new RegExp("https?://(?!www\\.|accounts\\.)[a-z0-9][a-z0-9-]*\\.janeapp\\.com(?=[/\"'?#]|$)", "i")],
  },
  {
    id: "mangomint",
    name: "Mangomint",
    signatures: ["//booking.mangomint.com/", "//clients.mangomint.com/"],
  },
  {
    id: "meevo",
    name: "Meevo",
    signatures: [".meevo.com/customerportal", ".meevo.com/onlinebooking"],
  },
  {
    id: "modmed",
    name: "ModMed EMA",
    signatures: [".ema.md/", ".modmedapp.com"],
  },
  {
    id: "nextech",
    name: "Nextech (myPatientVisit)",
    signatures: ["//mypatientvisit.com", "//www.mypatientvisit.com", "mypatientvisit.com/#/login?practiceid="],
    patterns: [new RegExp("://([a-z0-9-]+\\.)*mypatientvisit\\.com([/:?#]|$)", "i")],
  },
  {
    id: "patientfusion",
    name: "Patient Fusion (Veradigm)",
    signatures: ["//my.patientfusion.com"],
  },
  {
    id: "phorest",
    name: "Phorest",
    signatures: [],
    patterns: [new RegExp("//booking-widget\\.phorestcdn\\.com/", "i"), new RegExp("https?://(www\\.)?phorest\\.com/book/[A-Za-z0-9]", "i"), new RegExp("https?://(www\\.)?phorest\\.com/salon/[A-Za-z0-9][A-Za-z0-9_-]*", "i")],
  },
  {
    id: "podium",
    name: "Podium",
    signatures: ["//booking.podium.com/"],
  },
  {
    id: "schedulicity",
    name: "Schedulicity",
    signatures: ["schedulicity.com/api/public/widget/", "schedulicity.com/scheduling/"],
  },
  {
    id: "setmore",
    name: "Setmore",
    signatures: ["booking.setmore.com/", "booking.setmore.com/scheduleappointment", "my.setmore.com/webapp/js/src/others/setmore_iframe.js"],
  },
  {
    id: "simplybook",
    name: "SimplyBook.me",
    signatures: [".simplybook.asia/v2", ".simplybook.it/v2", ".simplybook.me/v2", "simplybook.it/v2/widget/widget.js", "simplybook.me/v2/widget/widget.js"],
  },
  {
    id: "solutionreach",
    name: "Solutionreach",
    signatures: ["limelight.solutionreach.com/scheduling/", "patron.solutionreach.com/uipatron/schedule", "schedule.solutionreach.com", "smilereminder.com/sr/appt_schedule"],
  },
  {
    id: "square",
    name: "Square Appointments",
    signatures: ["book.squareup.com/appointments/", "squareup.com/appointments/book/", "squareup.com/appointments/buyer/widget/"],
  },
  {
    id: "symplast",
    name: "Symplast",
    signatures: ["//appointmentrequestsapp.symplast.com", "//scheduling.symplast.com", "appointmentrequestsapp.symplast.com"],
  },
  {
    id: "tebra",
    name: "Tebra (PatientPop)",
    signatures: ["app.kareo.com/patient-engagement-ui", "cdn-prd.patientpop.com/scheduling-booking-ui", "cdn-prd.patientpop.com/widget/popup/", "legacy.patientpop.com/widgets/bookonline", "legacy.patientpop.com/widgets/calendars", "scheduling.api.patientpop.com", "websites-widget-manager.api.patientpop.com"],
  },
  {
    id: "weave",
    name: "Weave",
    signatures: ["//book.getweave.com/", "//book2.getweave.com/"],
  },
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

/**
 * Which social channels the clinic actually runs.
 *
 * Presence is the whole signal. A clinic that links Instagram from its homepage
 * is a clinic where somebody is posting, which means somebody is also answering
 * the DMs — usually the same person who is meant to be answering the phone, and
 * usually at nine in the evening.
 *
 * That is worth knowing because Meta channels are a different product
 * conversation with a hard boundary: WhatsApp, Instagram and Messenger cannot
 * carry PHI, since Meta states in its own Cloud API terms that it is not a
 * business associate. So the offer there is intent capture and handoff, never
 * anything clinical, and the enrichment only records that the channel exists.
 */
export function detectSocial(links: readonly string[]): string[] {
  const found = new Set<string>();
  for (const raw of links) {
    const url = raw.toLowerCase();
    if (/(?:^|\/\/|\.)instagram\.com\//.test(url)) found.add("instagram");
    if (/(?:^|\/\/|\.)facebook\.com\//.test(url)) found.add("facebook");
    if (/(?:^|\/\/|\.)tiktok\.com\//.test(url)) found.add("tiktok");
    if (/wa\.me\/|api\.whatsapp\.com\/|web\.whatsapp\.com\//.test(url)) {
      found.add("whatsapp");
    }
  }
  return [...found];
}

export function detectBooking(links: readonly string[]): BookingDetection {
  const seen = new Map<string, string>();

  for (const raw of links) {
    const url = raw.toLowerCase();
    if (NOT_BOOKING.some((bad) => url.includes(bad))) continue;

    for (const platform of BOOKING_PLATFORMS) {
      if (seen.has(platform.id)) continue;
      const hit =
        platform.signatures.some((sig) => url.includes(sig)) ||
        platform.patterns?.some((re) => re.test(url));
      if (hit) seen.set(platform.id, raw);
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
    if (SELF_HOSTED_BOOKING.some((path) => url.includes(path))) return true;

    // A booking SUBDOMAIN on the clinic's own domain — book.clinic.com,
    // appointment.clinic.com, portal.clinic.com. This is the ordinary shape of
    // a white-labelled widget, and checking only paths reported nine clinics in
    // a 402-site sample as having no online booking at all when they plainly
    // did.
    try {
      return /^(book|booking|schedule|scheduling|appointments?|portal)\./i.test(
        new URL(raw).hostname,
      );
    } catch {
      return false;
    }
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
