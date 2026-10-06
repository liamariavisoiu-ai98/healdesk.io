import type { BookingSync, ReadsGoogleCalendar } from "./platforms";

/**
 * The v1 answer to "Where do bookings live today?".
 *
 * v1 writes bookings to one place, the clinic's own Google Calendar, and the
 * clinic keeps whatever booking system it already uses, linked to that
 * calendar (v1 spec, "Where bookings are written"). Whether that link protects
 * against a double booking depends on the direction of the system's own sync,
 * which is what `readsGoogleCalendar` records, from the spec's table "What the
 * hub model does and does not guarantee". Only "yes" lets the assistant book
 * live; "no" and "unverified" run manual booking, where the assistant takes
 * each booking as a request and staff confirm it in their own system.
 *
 * This list is separate from `platforms` (platforms.ts), which is the
 * phase-two read-back's list and keeps its connection guides for that. BAA
 * 1.3.0 reads this one, and so are the funnel's checkout picker and, from
 * plan C15, provisioning; agreement versions before 1.3.0 name a phase-two
 * platform instead, which is how their bytes stay what was signed
 * (baa-selections.ts).
 *
 * The order and the values are a contract with the funnel (plan addendum, "C2
 * interface the funnel session imports", 6 October 2026), pinned by
 * booking-systems.test.ts. A system moves to "yes" only on the spec's say,
 * which means its vendor's own documentation or a written confirmation.
 */

export type BookingSystemId =
  | "google_calendar"
  | "calendly"
  | "calcom"
  | "gohighlevel"
  | "mindbody"
  | "boulevard"
  | "other"
  | "none";

export type BookingSystem = {
  id: BookingSystemId;
  /** The answer as the picker shows it. */
  label: string;
  readsGoogleCalendar: ReadsGoogleCalendar;
  /**
   * The one setting the clinic has to turn on in its own system for "yes" to
   * hold, worded for the checkout card, or null when linking the calendar is
   * all it takes.
   */
  setupNote: string | null;
  /** The vendor's own page for that setting, or null. */
  setupHelpUrl: string | null;
  /** The same system in the phase-two `platforms` list, or null when it has none. */
  phaseTwoPlatformId: string | null;
};

export const BOOKING_SYSTEMS: readonly BookingSystem[] = [
  {
    id: "google_calendar",
    label: "Google Calendar only",
    readsGoogleCalendar: "yes",
    setupNote: null,
    setupHelpUrl: null,
    phaseTwoPlatformId: null,
  },
  {
    // Spec: Calendly reads connected Google calendars for conflicts.
    id: "calendly",
    label: "Calendly",
    readsGoogleCalendar: "yes",
    setupNote: null,
    setupHelpUrl: null,
    phaseTwoPlatformId: null,
  },
  {
    // Spec: "Same conflict-checking model" as Calendly.
    id: "calcom",
    label: "Cal.com",
    readsGoogleCalendar: "yes",
    setupNote: null,
    setupHelpUrl: null,
    phaseTwoPlatformId: "calcom",
  },
  {
    // Spec table (commit a45cd9a), from HighLevel's own documentation: it
    // blocks any slot holding an event marked busy in a Google calendar the
    // clinic turns on as a conflict calendar, and Google marks healdesk's
    // events busy by default. "yes" holds only once that setting is on, so the
    // card says so before the clinic buys.
    id: "gohighlevel",
    label: "HighLevel",
    readsGoogleCalendar: "yes",
    setupNote:
      "In HighLevel, turn on the Google Calendar your assistant books into as a conflict " +
      "calendar. HighLevel then stops offering any time your assistant has booked.",
    setupHelpUrl: "https://help.gohighlevel.com/support/solutions/articles/155000002374",
    phaseTwoPlatformId: "gohighlevel",
  },
  {
    // Spec: Mindbody's integration runs one direction only, Mindbody to Google.
    id: "mindbody",
    label: "Mindbody",
    readsGoogleCalendar: "no",
    setupNote: null,
    setupHelpUrl: null,
    phaseTwoPlatformId: "mindbody",
  },
  {
    // Spec: "Treat as no until confirmed in writing".
    id: "boulevard",
    label: "Boulevard",
    readsGoogleCalendar: "unverified",
    setupNote: null,
    setupHelpUrl: null,
    phaseTwoPlatformId: "boulevard",
  },
  {
    // A system nobody has checked is not given the benefit of the doubt.
    id: "other",
    label: "Something else",
    readsGoogleCalendar: "unverified",
    setupNote: null,
    setupHelpUrl: null,
    phaseTwoPlatformId: null,
  },
  {
    // The assistant books into the Google Calendar the clinic connects.
    id: "none",
    label: "No booking system yet",
    readsGoogleCalendar: "yes",
    setupNote: null,
    setupHelpUrl: null,
    phaseTwoPlatformId: null,
  },
] as const;

export function getBookingSystem(id: unknown): BookingSystem | undefined {
  return typeof id === "string" ? BOOKING_SYSTEMS.find((s) => s.id === id) : undefined;
}

export function isBookingSystemId(id: unknown): id is BookingSystemId {
  return getBookingSystem(id) !== undefined;
}

/**
 * "live" only for a system that reads Google Calendar for conflicts. Anything
 * else, an unknown id included, is "manual": the cost of a wrong "live" is a
 * double booking the assistant made. The one derivation the agreement and
 * the calendar election use, and the one provisioning is to use (plan C15);
 * the browser never chooses it.
 */
export function bookingSyncFor(id: unknown): BookingSync {
  return getBookingSystem(id)?.readsGoogleCalendar === "yes" ? "live" : "manual";
}

/** The answers that name no product, so no sentence can name one for them. */
const NAMES_NO_PRODUCT: ReadonlySet<BookingSystemId> = new Set([
  "google_calendar",
  "other",
  "none",
]);

/**
 * The name a sentence about the clinic's own booking system can use: the
 * product's name, or null when the answer names no product. "Google Calendar
 * only" is the calendar healdesk itself connects to, not a system healdesk
 * holds no credentials to; "Something else" and "No booking system yet" are
 * not names at all. BAA 1.3.0 renders this as `connectedPlatform`, and its
 * render guard refuses any other value, so the agreement and the booking
 * system it was signed with cannot name different things.
 */
export function bookingSystemName(id: BookingSystemId): string | null {
  if (NAMES_NO_PRODUCT.has(id)) return null;
  return getBookingSystem(id)?.label ?? null;
}

/**
 * Said before the clinic buys whenever its booking system is manual: the
 * spec's "Do not sell live calendar booking to a one-way clinic without
 * saying which of these applies".
 *
 * Takes the answer's `label`, as the picker shows it (the interface agreed
 * with the funnel); the answer's id, or `bookingSystemName(id)`, gives the
 * same sentence. An answer that names no product reads as "Your booking
 * system", so "Something else" is never presented as a product's name. Any
 * other text is taken as the product's own name, which is how a phase-two
 * platform name (Zenoti, say) reads.
 */
export function manualBookingNotice(label: string | null): string {
  const text = label?.trim() ?? "";
  const answer = BOOKING_SYSTEMS.find((s) => s.label === text || s.id === text);
  const named = answer ? bookingSystemName(answer.id) : text || null;
  return named
    ? `${named} doesn't read Google Calendar, or we haven't confirmed that it does, so your ` +
        `assistant takes each booking as a request and your staff confirm it in ${named}.`
    : "Your booking system doesn't read Google Calendar, or we haven't confirmed that it does, " +
        "so your assistant takes each booking as a request and your staff confirm it in your " +
        "booking system.";
}
