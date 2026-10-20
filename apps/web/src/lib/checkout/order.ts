import {
  agreementKindFor,
  agreementPlatformFor,
  asksCoveredQuestion,
  type BillingInterval,
  type BookingSystemId,
  type CalendarAccount,
  cleanWebsite,
  type ClinicProfile,
  type CoveredAnswer,
  getPlan,
  isBillingInterval,
  isBookingSystemId,
  isCalendarAccount,
  isCoveredAnswer,
  isSpecialtyId,
  parseClinicProfile,
  type Plan,
  planNeedsWebsite,
  type SpecialtyId,
  specialtyOffered,
} from "@healdesk/catalog";

import { LEGAL_VERSION } from "@/lib/legal";

/**
 * The purchase the browser posts to /api/checkout, validated field by field
 * before anything upstream is asked (plan Part A4, step 1).
 *
 * An allowlist: what leaves this function is built from the fields below and
 * nothing else, so a key the browser invents never reaches apps/app, the
 * signed intent or Stripe. apps/app validates the same purchase again (its
 * checkout intent), and the two refuse with the same field names, so the form
 * can point at the step the buyer has to go back to.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export const PROFILE_STATUSES = ["read", "failed", "none"] as const;
export type ProfileStatus = (typeof PROFILE_STATUSES)[number];

export type Order = {
  plan: Plan;
  interval: BillingInterval;
  clinicName: string;
  specialty: SpecialtyId;
  /** The clinic's website, cleaned, or null: it has none. */
  website: string | null;
  bookingSystem: BookingSystemId;
  calendarAccount: CalendarAccount;
  /** The phase-two platform the released agreement names, derived here, never taken from the browser. */
  platform: string;
  contactName: string;
  /** Lower-cased: the clinic's one address. */
  contactEmail: string;
  contactTitle: string | null;
  agreementId: string;
  /**
   * The covered-entity answer, as the agreement records it: true for "Yes",
   * false for "No", null for "Not sure", and false for a practice never asked
   * (agreementKindFor's own reading). apps/app checks it against the signed
   * agreement before anyone pays.
   */
  isCoveredEntity: boolean | null;
  profile: ClinicProfile | null;
  profileStatus: ProfileStatus;
  /** The browser's own time zone, a fallback for the clinic's; dropped when it is not one. */
  timezone: string | null;
};

export type OrderRefusal = { error: string; field: string };

export type OrderResult = { ok: true; order: Order } | { ok: false; refusal: OrderRefusal };

const refuse = (field: string, error: string): OrderResult => ({
  ok: false,
  refusal: { field, error },
});

function text(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= max ? trimmed : null;
}

export function isTimeZone(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

export function validateOrder(body: Record<string, unknown>): OrderResult {
  // A plan is a package at its steps (`voice-metachat-500-300`), and the id
  // is parsed, not looked up (catalog, getPlan): a step off the grid of 100
  // to 1,500, or a package id without its steps, is no plan. The funnel
  // always sends a full plan id; a bare package id or a retired package id
  // (chat-web, complete) is accepted only as a `?plan=` link, which the
  // funnel turns into a plan before anything is signed or paid.
  const plan = getPlan(String(body.plan ?? ""));
  if (!plan) return refuse("plan", "Unknown plan.");

  // A missing interval is monthly, which is what every button that does not
  // say otherwise has always meant; a wrong one is an error, not a quiet
  // fallback to the cheaper terms.
  const interval: unknown = body.interval ?? "month";
  if (!isBillingInterval(interval)) return refuse("interval", "Unknown billing interval.");

  const clinicName = text(body.clinicName, 120);
  if (!clinicName || clinicName.length < 2) {
    return refuse("clinicName", "Enter your practice's legal name, up to 120 characters.");
  }

  if (!isSpecialtyId(body.specialty) || !specialtyOffered(body.specialty)) {
    return refuse("specialty", "Choose your specialty.");
  }
  const specialty: SpecialtyId = body.specialty;

  // The covered-entity answer selects a paragraph of the agreement, so it
  // travels with the purchase and apps/app matches it against what was
  // signed. Asked only where it can matter; never sent where it was not.
  const asked = asksCoveredQuestion(specialty);
  const covered = body.covered ?? null;
  if (asked ? !isCoveredAnswer(covered) : covered !== null) {
    return refuse(
      "covered",
      "Answer whether your practice bills any health insurance electronically.",
    );
  }
  const agreement = agreementKindFor({ specialty, covered: asked ? (covered as CoveredAnswer) : null });
  if (!agreement.ok) return refuse("specialty", "Choose your specialty.");

  // Present, always: a website, or null for none. Absent is a page that never
  // asked, and guessing which would decide whether web chat may be sold.
  let website: string | null;
  if (body.website === null) {
    website = null;
  } else {
    website = cleanWebsite(body.website);
    if (!website)
      return refuse(
        "website",
        "Enter your website, like glowmedspa.com, or tell us you don't have one.",
      );
  }
  if (website === null && planNeedsWebsite(plan)) {
    return refuse(
      "plan",
      "AYA Web Chat needs a website. Choose AYA Voice or AYA Meta Chat, or give us your website.",
    );
  }

  if (!isBookingSystemId(body.bookingSystem)) {
    return refuse("bookingSystem", "Tell us where your bookings live today.");
  }
  if (!isCalendarAccount(body.calendarAccount)) {
    return refuse("calendarAccount", "Tell us which Google account bookings would go into.");
  }

  const contactName = text(body.contactName, 120);
  if (!contactName || contactName.length < 2)
    return refuse("contactName", "Your name is required.");
  const email = typeof body.contactEmail === "string" ? body.contactEmail.trim().toLowerCase() : "";
  if (email.length > 254 || !EMAIL.test(email))
    return refuse("contactEmail", "Enter your clinic's email address.");
  let contactTitle: string | null = null;
  if (body.contactTitle !== undefined && body.contactTitle !== null && body.contactTitle !== "") {
    contactTitle = text(body.contactTitle, 120);
    if (!contactTitle) return refuse("contactTitle", "Your title is too long.");
  }

  // A shape check, not proof of a signature: apps/app checks the agreement
  // exists, is unbound and was signed by this address, before payment.
  if (typeof body.agreementId !== "string" || !UUID.test(body.agreementId)) {
    return refuse("agreementId", "Sign the agreement before paying.");
  }

  const profileStatus = body.profileStatus;
  if (!(PROFILE_STATUSES as readonly unknown[]).includes(profileStatus)) {
    return refuse("profile", "The website read is missing its status.");
  }
  const sentProfile = body.profile ?? null;
  let profile: ClinicProfile | null = null;
  if (website === null) {
    if (profileStatus !== "none" || sentProfile !== null) {
      return refuse("profile", "A practice with no website has no website read.");
    }
  } else if (profileStatus === "read") {
    profile = parseClinicProfile(sentProfile);
    // Only the read of this very website rides on this purchase.
    if (!profile || profile.website !== website) {
      return refuse("profile", "The website read doesn't match this purchase.");
    }
  } else if (profileStatus === "failed") {
    if (sentProfile !== null) return refuse("profile", "A failed read has no profile.");
  } else {
    return refuse("profile", "A website was given, so its read is either done or failed.");
  }

  // The terms tick-box, against the version this server publishes: a page
  // loaded before the terms changed showed other words beside the box.
  if (body.termsAccepted !== true) {
    return refuse("terms", "Tick the box to accept the Terms of service and the Privacy policy.");
  }
  if (body.termsVersion !== LEGAL_VERSION) {
    return refuse(
      "terms",
      "Our terms have changed since this page opened. Reload it to read them, then tick the box again.",
    );
  }

  return {
    ok: true,
    order: {
      plan,
      interval,
      clinicName,
      specialty,
      website,
      bookingSystem: body.bookingSystem,
      calendarAccount: body.calendarAccount,
      platform: agreementPlatformFor(body.bookingSystem),
      contactName,
      contactEmail: email,
      contactTitle,
      agreementId: body.agreementId,
      isCoveredEntity: agreement.isCoveredEntity,
      profile,
      profileStatus: profileStatus as ProfileStatus,
      timezone: isTimeZone(body.timezone) ? body.timezone : null,
    },
  };
}

/**
 * The purchase as apps/app's checkout intent takes it: provisioning's fields
 * under provisioning's names, plus what the funnel added. `platform` is
 * still sent because apps/app still requires it (it names the released
 * agreement's system); it is derived above, never the browser's.
 */
export function intentFields(order: Order): Record<string, unknown> {
  return {
    clinicName: order.clinicName,
    specialty: order.specialty,
    platform: order.platform,
    plan: order.plan.id,
    billingInterval: order.interval,
    contactName: order.contactName,
    contactEmail: order.contactEmail,
    ...(order.contactTitle ? { contactTitle: order.contactTitle } : {}),
    agreementId: order.agreementId,
    isCoveredEntity: order.isCoveredEntity,
    bookingSystem: order.bookingSystem,
    calendarAccount: order.calendarAccount,
    website: order.website,
    ...(order.timezone ? { timezone: order.timezone } : {}),
    profile: order.profile,
    profileStatus: order.profileStatus,
  };
}

/**
 * The calendar answers on a signature request, checked by /api/agreement
 * before it signs anything over to apps/app (whose signing path does not read
 * them yet; the calendar session's next agreement version does).
 *
 * The booking system and the Google account must be answers the funnel
 * offers; `platform`, which the released agreement still renders from, must
 * be the one the booking system implies, so the document cannot name one
 * system while the purchase names another; and the practice must be one this
 * screen can sign for: `agreementKindFor` decides, the Business Associate
 * Agreement or the Data Protection Agreement, which the owner released on 20
 * October 2026. Until then the decision never named the DPA and refused a
 * veterinary practice; it still would for an unreleased one. `dpaReleased`
 * is for tests; the route passes nothing.
 */
export function signRequestRefusal(
  body: Record<string, unknown>,
  options: { dpaReleased?: boolean } = {},
): OrderRefusal | null {
  if (!isBookingSystemId(body.bookingSystem)) {
    return { field: "bookingSystem", error: "Tell us where your bookings live today." };
  }
  if (!isCalendarAccount(body.calendarAccount)) {
    return {
      field: "calendarAccount",
      error: "Tell us which Google account bookings would go into.",
    };
  }
  if (body.platform !== agreementPlatformFor(body.bookingSystem)) {
    return {
      field: "platform",
      error: "The agreement names a different booking system. Please reload and sign again.",
    };
  }
  const isCovered = body.isCoveredEntity;
  const covered =
    isCovered === true
      ? "yes"
      : isCovered === false
        ? "no"
        : isCovered === null
          ? "not_sure"
          : null;
  const choice = agreementKindFor({
    specialty: String(body.specialty ?? ""),
    covered,
    dpaReleased: options.dpaReleased,
  });
  if (!choice.ok) {
    return { field: "specialty", error: "We can't offer an agreement for this practice here." };
  }
  return null;
}
