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

/** Platforms where verified attribution is possible at all. */
export function supportsVerifiedAttribution(platform: Platform): boolean {
  return platform.connection !== "none";
}
