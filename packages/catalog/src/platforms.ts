/**
 * Booking / POS platforms offered in the purchase flow.
 *
 * Shared between the picker in apps/web and the validator in apps/app, because
 * drift here is a real bug: the site would offer a platform the API rejects,
 * and the customer would hit it mid-checkout.
 *
 * `connection` records HOW a clinic grants us access, which drives the wizard.
 * `money` and `arrival` record what we can actually read — declared here rather
 * than discovered later, so an unsupported capability reaches the customer as
 * a caveat instead of rendering as a zero.
 *
 * Research behind these values is in docs/launch-plan.md.
 *
 * This is the phase-two list: the systems the read-back would connect to.
 * The v1 answer to "where do bookings live today?" is booking-systems.ts,
 * which points back here through `phaseTwoPlatformId` where the same system
 * appears in both. `readsGoogleCalendar` is on both lists, and a test in
 * booking-systems.test.ts keeps the two from disagreeing.
 */

/**
 * Whether an event healdesk adds to the clinic's Google Calendar blocks that
 * slot in the clinic's own booking system (v1 spec, "What the hub model does
 * and does not guarantee"). "unverified" is a system nobody has confirmed in
 * writing, and it is treated exactly as "no".
 */
export type ReadsGoogleCalendar = "yes" | "no" | "unverified";

/**
 * Whether the assistant may book live into the clinic's Google Calendar
 * ("live") or must take each booking as a request staff confirm in their own
 * system ("manual"). Derived from `readsGoogleCalendar`, never chosen.
 */
export type BookingSync = "live" | "manual";

export type ConnectionMethod =
  /** One click; they approve a permissions screen and we do the rest. */
  | "oauth"
  /** They create a read-only user for us; we configure everything after. */
  | "readonly_user"
  /** Nothing to connect. */
  | "none";

export type Capability =
  | "full" // read directly and completely
  | "partial" // readable, with a stated gap
  | "webhook_only" // forward-only, no history
  | "unsupported";

export type Platform = {
  id: string;
  name: string;
  connection: ConnectionMethod;
  /** Can we read settled revenue from this system? */
  money: Capability;
  /** Can we tell whether the patient actually showed up? */
  arrival: Capability;
  /** Shown in the picker. Plain, honest, no hedging. */
  note?: string;
  /** Blocks selecting "verified" attribution through this platform alone. */
  requiresProcessorForRevenue?: boolean;
  /**
   * Set false on a platform that cannot support verified attribution because
   * it holds no revenue and does not know whether the person arrived (a
   * scheduling calendar). `supportsVerifiedAttribution()` honours it, so
   * checkout forces estimated reporting. Absent means "as the connection
   * implies".
   */
  verifiedAttribution?: boolean;
  /**
   * Whether this system reads the clinic's Google Calendar for conflicts, so
   * a booking healdesk writes there stops the system offering that slot.
   * Required, so a platform added later has to answer it: a wrong "yes" is a
   * double booking the AI made, which the spec calls the most damaging
   * failure this product can produce.
   */
  readsGoogleCalendar: ReadsGoogleCalendar;
};

export const NO_PLATFORM_ID = "none";

export const platforms: readonly Platform[] = [
  {
    id: "boulevard",
    name: "Boulevard",
    connection: "oauth",
    money: "full",
    arrival: "full",
    // Spec: "Treat as no until confirmed in writing" (Open items asks Boulevard).
    readsGoogleCalendar: "unverified",
  },
  {
    id: "gohighlevel",
    name: "GoHighLevel",
    connection: "oauth",
    money: "partial",
    arrival: "partial",
    note: "We'll read your appointments from GoHighLevel and your revenue from your card processor — GoHighLevel only sees payments it processed itself.",
    requiresProcessorForRevenue: true,
    // Spec table (commit a45cd9a): HighLevel blocks a slot holding a busy
    // event in a Google calendar the clinic turns on as a conflict calendar,
    // and Google marks healdesk's events busy. The setting is the clinic's to
    // turn on; booking-systems.ts carries it as the HighLevel card's note.
    readsGoogleCalendar: "yes",
  },
  {
    id: "zenoti",
    name: "Zenoti",
    connection: "readonly_user",
    money: "full",
    arrival: "full",
    // No source either way, and no written confirmation (plan Q4).
    readsGoogleCalendar: "unverified",
  },
  {
    id: "patientnow",
    name: "PatientNow",
    connection: "readonly_user",
    money: "full",
    arrival: "full",
    // No source either way, and no written confirmation (plan Q4).
    readsGoogleCalendar: "unverified",
  },
  {
    id: "acuity",
    name: "Acuity Scheduling",
    connection: "readonly_user",
    money: "partial",
    arrival: "unsupported",
    note: "Acuity has no concept of a patient arriving, so we'll infer attendance from payment timing and label it as inferred.",
    requiresProcessorForRevenue: true,
    // No written confirmation (plan Q4).
    readsGoogleCalendar: "unverified",
  },
  {
    id: "vagaro",
    name: "Vagaro",
    connection: "readonly_user",
    money: "webhook_only",
    arrival: "full",
    note: "Vagaro tells us about sales as they happen but won't let us ask for history, so verified revenue starts from the day you connect.",
    requiresProcessorForRevenue: true,
    // No written confirmation (plan Q4).
    readsGoogleCalendar: "unverified",
  },
  {
    id: "mindbody",
    name: "Mindbody",
    connection: "readonly_user",
    money: "partial",
    arrival: "partial",
    note: "We work with Mindbody through a read-only account rather than their API, and read revenue from your card processor.",
    requiresProcessorForRevenue: true,
    // Spec: Mindbody's integration runs one way, Mindbody to Google.
    readsGoogleCalendar: "no",
  },
  {
    // Nothing to connect. v1 writes bookings to the clinic's Google Calendar
    // only (v1 spec, "Where bookings are written"); Cal.com reads that
    // calendar for conflicts, so the clinic links the two in Cal.com itself.
    // The Cal.com write adapter of 23 September 2026 was removed: healdesk
    // writes nothing into Cal.com. It holds no revenue and no arrival, so
    // verified attribution is never offered through it.
    id: "calcom",
    name: "Cal.com",
    connection: "none",
    money: "unsupported",
    arrival: "unsupported",
    verifiedAttribution: false,
    note: "We book into your Google Calendar. Link Cal.com to that calendar and it stops offering a time we have booked.",
    // Spec: "Same conflict-checking model" as Calendly.
    readsGoogleCalendar: "yes",
  },
  {
    id: NO_PLATFORM_ID,
    name: "No booking software",
    connection: "none",
    money: "unsupported",
    arrival: "unsupported",
    note: "Phone and paper, or a website form. Most of our customers start here.",
    // Spec: Google Calendar alone has "Nothing to reconcile". A clinic with
    // no booking software books into the Google Calendar it connects.
    readsGoogleCalendar: "yes",
  },
] as const;

export function getPlatform(id: string): Platform | undefined {
  return platforms.find((p) => p.id === id);
}

export function isPlatformId(id: unknown): id is string {
  return typeof id === "string" && platforms.some((p) => p.id === id);
}

/**
 * Platforms where verified attribution is possible at all: something is
 * connected, and it is a system we read outcomes from rather than a calendar
 * we write into.
 */
export function supportsVerifiedAttribution(platform: Platform): boolean {
  return platform.connection !== "none" && platform.verifiedAttribution !== false;
}

/**
 * "live" only for a platform that reads Google Calendar for conflicts; every
 * other answer, an unknown id included, is "manual". A system nobody has
 * confirmed is not given the benefit of the doubt, because the cost of being
 * wrong is a double booking the assistant made.
 *
 * Deliberately not called `bookingSyncOf`: that is the BAA's accessor for a
 * rendered agreement's variables (baa.ts). For the v1 booking-system answer,
 * use `bookingSyncFor` (booking-systems.ts); this is the same derivation over
 * the phase-two list, for anything that still holds a platform id.
 */
export function bookingSyncForPlatform(platformId: unknown): BookingSync {
  const platform = typeof platformId === "string" ? getPlatform(platformId) : undefined;
  return platform?.readsGoogleCalendar === "yes" ? "live" : "manual";
}
