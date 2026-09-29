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
 */

export type ConnectionMethod =
  /** One click; they approve a permissions screen and we do the rest. */
  | "oauth"
  /** They create a read-only user for us; we configure everything after. */
  | "readonly_user"
  /**
   * They create an API key in their own account and paste it, with the id of
   * the one event type we may touch. The key is theirs to revoke. The only
   * method that grants a WRITE (adding an appointment); the guide says so.
   */
  | "api_key"
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
   * Set false on a platform whose connection exists to be WRITTEN to (a
   * calendar) and cannot support verified attribution: it holds no revenue
   * and does not know whether the person arrived. `supportsVerifiedAttribution()`
   * honours it, so checkout forces estimated reporting, and the BAA describes
   * the connection through its calendar-write clause rather than the
   * verified data-sources clause. Absent means "as the connection implies".
   */
  verifiedAttribution?: boolean;
};

export const NO_PLATFORM_ID = "none";

export const platforms: readonly Platform[] = [
  {
    id: "boulevard",
    name: "Boulevard",
    connection: "oauth",
    money: "full",
    arrival: "full",
  },
  {
    id: "gohighlevel",
    name: "GoHighLevel",
    connection: "oauth",
    money: "partial",
    arrival: "partial",
    note: "We'll read your appointments from GoHighLevel and your revenue from your card processor — GoHighLevel only sees payments it processed itself.",
    requiresProcessorForRevenue: true,
  },
  {
    id: "zenoti",
    name: "Zenoti",
    connection: "readonly_user",
    money: "full",
    arrival: "full",
  },
  {
    id: "patientnow",
    name: "PatientNow",
    connection: "readonly_user",
    money: "full",
    arrival: "full",
  },
  {
    id: "acuity",
    name: "Acuity Scheduling",
    connection: "readonly_user",
    money: "partial",
    arrival: "unsupported",
    note: "Acuity has no concept of a patient arriving, so we'll infer attendance from payment timing and label it as inferred.",
    requiresProcessorForRevenue: true,
  },
  {
    id: "vagaro",
    name: "Vagaro",
    connection: "readonly_user",
    money: "webhook_only",
    arrival: "full",
    note: "Vagaro tells us about sales as they happen but won't let us ask for history, so verified revenue starts from the day you connect.",
    requiresProcessorForRevenue: true,
  },
  {
    id: "mindbody",
    name: "Mindbody",
    connection: "readonly_user",
    money: "partial",
    arrival: "partial",
    note: "We work with Mindbody through a read-only account rather than their API, and read revenue from your card processor.",
    requiresProcessorForRevenue: true,
  },
  {
    // The one calendar healdesk can write into in this release. Read-only
    // attribution is not what it is for: Cal.com has no revenue and no
    // arrival concept, so a Cal.com clinic reports estimated and gets the
    // calendar-write clause instead.
    id: "calcom",
    name: "Cal.com",
    connection: "api_key",
    money: "unsupported",
    arrival: "unsupported",
    verifiedAttribution: false,
    note: "The one calendar we can add appointments to: when your front desk confirms a time, it lands in your Cal.com calendar. Cal.com holds no revenue and doesn't know whether someone arrived, so your report stays estimated.",
  },
  {
    id: NO_PLATFORM_ID,
    name: "No booking software",
    connection: "none",
    money: "unsupported",
    arrival: "unsupported",
    note: "Phone and paper, or a website form. Most of our customers start here.",
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
