import { specialtyOffered } from "./agreement-kind";
import { isBookingSystemId, type BookingSystemId } from "./booking-systems";
import { isCalendarAccount, type CalendarAccount } from "./calendar-terms";
import { parseClinicProfile, screenClinicProfile, type ClinicProfile } from "./clinic-profile";
import { getPlan } from "./plans";
import { ProvisioningError, validateProvisionRequest, type ProvisionRequest } from "./provision-request";
import { agreementPlatformFor, cleanWebsite, planNeedsWebsite } from "./purchase";
import type { SpecialtyId } from "./specialties";

/**
 * A checkout intent: a purchase waiting on its first paid invoice (design D1,
 * plan Part A4), and the rules it is held to.
 *
 * Until 14 October 2026 apps/app stored the intent, and checked it, when the
 * buyer pressed Pay. Since then apps/web records it, sealed, in the marketing
 * Sheet, so a buyer can pay while the AWS host is in standby, and apps/app
 * imports it when the first invoice is paid
 * (docs/design/checkout-records-on-vercel-2026-10-14.md). Both ends run
 * `validateIntentRequest`, from here: apps/web before it creates the Stripe
 * Checkout Session, so a purchase provisioning would refuse is refused before
 * anyone pays, and apps/app again at the import, because the record has
 * crossed a store it does not control.
 *
 * Everything provisioning will need is checked now, which is what removes the
 * "paid, then provisioning refused the form" case: provisioning's own checks
 * (validateProvisionRequest), and the funnel's answers, each with the
 * catalog's own rules, because the browser that carried them can change them:
 * a practice with no website is never sold Web Chat (planNeedsWebsite; Meta
 * Chat includes website chat but does not need it), and a website read is
 * kept only when it parses, is of the website bought under, and has been
 * screened under the specialty bought, never the one the website looked like.
 */

/** How long a purchase waits for its first paid invoice. */
export const INTENT_TTL_DAYS = 14;

/** Whether the purchase came with a read of the clinic's website. */
export const CHECKOUT_PROFILE_STATUSES = ["read", "failed", "none"] as const;
export type CheckoutProfileStatus = (typeof CHECKOUT_PROFILE_STATUSES)[number];

/**
 * The website read is capped where it is made (ClinicProfile's own limits);
 * this is the backstop, in characters of its JSON, as apps/app has always
 * measured it.
 */
export const CHECKOUT_PROFILE_MAX_CHARS = 200_000;

/** What apps/web records: the purchase, plus what the plan added around it. */
export type IntentRequest = Omit<ProvisionRequest, "idempotencyKey" | "stripeCustomerId" | "stripeSubscriptionId"> & {
  /** The setup request id whose link opened the purchase, while by invitation. */
  inviteRef: string | null;
  /** SHA-256 hex of the nonce cookie apps/web sets on the paying browser. */
  nonceHash: string;
  /**
   * The covered-entity answer, as the agreement records it: true ("Yes"),
   * false ("No", and a practice never asked), null ("Not sure"). Matched
   * against the signed agreement (agreementMismatch); never assumed.
   */
  isCoveredEntity: boolean | null;
  /** "Where do bookings live today?" Absent only on a request from before the four-step funnel. */
  bookingSystem?: BookingSystemId;
  /** "Which Google account will bookings go into?" Sent with the booking system, or not at all. */
  calendarAccount?: CalendarAccount;
  /** The website, cleaned, or null: the practice has none. Absent only before the funnel asked. */
  website?: string | null;
  /** Validated and screened under the specialty bought (validateIntentRequest). */
  profile: ClinicProfile | null;
  profileStatus: CheckoutProfileStatus;
  /** The terms tick-box: which version, when, and from where. */
  terms: { version: string; acceptedAt: string; ip: string | null } | null;
};

export class IntentError extends Error {
  constructor(
    message: string,
    readonly field?: string,
    readonly status: number = 422,
  ) {
    super(message);
    this.name = "IntentError";
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256_HEX = /^[0-9a-f]{64}$/;

/** Validate a purchase exactly as provisioning will, plus the plan's fields. */
export function validateIntentRequest(input: unknown): IntentRequest {
  const body = input as Partial<IntentRequest> | null;
  if (!body || typeof body !== "object") throw new IntentError("Invalid request body.");

  try {
    // Provisioning's own checks, with a key standing in for the one the
    // webhook will stamp, so the two can never disagree about a purchase.
    validateProvisionRequest({ ...body, idempotencyKey: "intent-validation" });
  } catch (error) {
    if (error instanceof ProvisioningError) throw new IntentError(error.message, error.field);
    throw error;
  }

  // Provisioning's own checks passed, so the specialty and the plan are
  // known. The plan is a package at its usage steps (`voice-500`,
  // `voice-metachat-500-300`; owner, 13 October 2026): getPlan parses the id,
  // so a step off the grid and an id from the seven packages of 5 October
  // were both refused there.
  const specialty = body.specialty as SpecialtyId;
  const plan = getPlan(body.plan as string)!;

  // A practice with no agreement it can sign cannot buy: a veterinary one,
  // until the Data Protection Agreement is released (plan Part L).
  if (!specialtyOffered(specialty)) {
    throw new IntentError("This practice's agreement can't be signed here.", "specialty");
  }

  const inviteRef = body.inviteRef ?? null;
  if (inviteRef !== null && (typeof inviteRef !== "string" || !UUID.test(inviteRef))) {
    throw new IntentError("Invalid setup link reference.", "inviteRef");
  }
  if (typeof body.nonceHash !== "string" || !SHA256_HEX.test(body.nonceHash)) {
    throw new IntentError("Invalid nonce.", "nonceHash");
  }
  // Required, because the agreement is matched against it before payment.
  const isCoveredEntity = body.isCoveredEntity;
  if (isCoveredEntity !== true && isCoveredEntity !== false && isCoveredEntity !== null) {
    throw new IntentError(
      "Answer whether the practice bills any health insurance electronically.",
      "covered",
    );
  }

  // The calendar answers travel together, and the platform the released
  // agreement names must be the one the booking system implies.
  const bookingSystem = body.bookingSystem;
  const calendarAccount = body.calendarAccount;
  if (bookingSystem !== undefined || calendarAccount !== undefined) {
    if (!isBookingSystemId(bookingSystem)) throw new IntentError("Unknown booking system.", "bookingSystem");
    if (!isCalendarAccount(calendarAccount)) throw new IntentError("Unknown Google account kind.", "calendarAccount");
    if (body.platform !== agreementPlatformFor(bookingSystem)) {
      throw new IntentError("The agreement's platform is not the booking system's.", "platform");
    }
  }

  // The website, as apps/web cleans it, or null for none.
  const website = body.website;
  if (website !== undefined && website !== null && (typeof website !== "string" || cleanWebsite(website) !== website)) {
    throw new IntentError("Invalid website.", "website");
  }
  if (website === null && planNeedsWebsite(plan)) {
    throw new IntentError("Web Chat needs a website. Choose AYA Voice or AYA Meta Chat instead.", "plan");
  }

  const profileStatus = body.profileStatus ?? "none";
  if (!(CHECKOUT_PROFILE_STATUSES as readonly string[]).includes(profileStatus)) {
    throw new IntentError("Invalid profile status.", "profileStatus");
  }
  const raw = body.profile ?? null;
  let profile: ClinicProfile | null = null;
  if (raw !== null) {
    if (typeof raw !== "object" || Array.isArray(raw)) throw new IntentError("Invalid profile.", "profile");
    if (JSON.stringify(raw).length > CHECKOUT_PROFILE_MAX_CHARS) {
      throw new IntentError("The profile is too large.", "profile");
    }
    const parsed = parseClinicProfile(raw);
    if (!parsed) throw new IntentError("Invalid profile.", "profile");
    // Screened again, under the specialty bought: `practiceKind` is only what
    // the website looked like, and the browser could have changed it.
    profile = screenClinicProfile(parsed, specialty);
  }
  if (profileStatus === "read" && profile === null) throw new IntentError("A read needs its profile.", "profile");
  if (profileStatus !== "read" && profile !== null) throw new IntentError("Only a read carries a profile.", "profile");
  if (profile !== null && (typeof website !== "string" || profile.website !== website)) {
    throw new IntentError("The website read is not of this purchase's website.", "profile");
  }
  if (website === null && profileStatus !== "none") {
    throw new IntentError("A practice with no website has no website read.", "profileStatus");
  }
  if (typeof website === "string" && profileStatus === "none") {
    throw new IntentError("A website was given, so its read is either done or failed.", "profileStatus");
  }

  const terms = body.terms ?? null;
  if (terms !== null) {
    const ok =
      typeof terms === "object" &&
      typeof terms.version === "string" &&
      terms.version.length > 0 &&
      terms.version.length <= 40 &&
      typeof terms.acceptedAt === "string" &&
      !Number.isNaN(Date.parse(terms.acceptedAt)) &&
      (terms.ip === null || (typeof terms.ip === "string" && terms.ip.length <= 64));
    if (!ok) throw new IntentError("Invalid terms record.", "terms");
  }

  if (body.timezone !== undefined && !isTimeZone(body.timezone)) {
    throw new IntentError("Unknown time zone.", "timezone");
  }

  return {
    ...(body as IntentRequest),
    contactEmail: (body.contactEmail as string).trim().toLowerCase(),
    inviteRef,
    profile,
    profileStatus,
    terms,
  };
}

function isTimeZone(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}
