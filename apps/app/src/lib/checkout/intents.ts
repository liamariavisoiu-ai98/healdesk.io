import { createHash, timingSafeEqual } from "node:crypto";

import {
  agreementPlatformFor,
  type BookingSystemId,
  type CalendarAccount,
  cleanWebsite,
  type ClinicProfile,
  getPlan,
  isBookingSystemId,
  isCalendarAccount,
  META_SOLD_ALONE,
  parseClinicProfile,
  planNeedsWebsite,
  screenClinicProfile,
  sellsMetaAlone,
  type SpecialtyId,
  specialtyOffered,
} from "@healdesk/catalog";
import { and, eq, isNull, sql } from "drizzle-orm";

import { unsafeDb } from "@/db";
import {
  CHECKOUT_PROFILE_STATUSES,
  checkoutIntents,
  type CheckoutIntentPayload,
  type CheckoutProfileStatus,
} from "@/db/schema";
import { getAgreement } from "@/lib/agreements";
import { ProvisioningError, validateProvisionRequest, type ProvisionRequest } from "@/lib/provisioning";

/**
 * Checkout intents: a purchase waiting on its first paid invoice (design D1,
 * plan Part A4).
 *
 * apps/web stores nothing, so before it creates a Stripe Checkout Session it
 * sends the validated purchase here, and Stripe carries only `{ app, ref }`.
 * Everything provisioning will need is checked now, before anyone pays, which
 * is what removes the "paid, then provisioning refused the form" case: the
 * agreement must exist, be unbound and have been signed by the buying address.
 *
 * While purchases are by invitation, one setup link makes one intent
 * (`invite_ref` is unique). Pressing Pay again after cancelling at Stripe
 * reuses it: the attempt counter moves, and apps/web expires the previous
 * Checkout Session so only one can be paid.
 *
 * The four-step funnel (plan Part A3) adds the clinic's answers: where its
 * bookings live and the kind of Google account they would go into, its
 * website or none, and the read of that website. Each is checked again here,
 * with the catalog's own rules, because the browser that carried them can
 * change them: a practice with no website is never sold website chat, and a
 * website read is kept only when it parses, is of the website bought under,
 * and has been screened under the specialty bought, never the one the
 * website looked like.
 */

export const INTENT_TTL_DAYS = 14;

/** What apps/web sends: the purchase, plus what the plan added around it. */
export type IntentRequest = Omit<ProvisionRequest, "idempotencyKey" | "stripeCustomerId" | "stripeSubscriptionId"> & {
  /** The setup request id whose link opened the purchase, while by invitation. */
  inviteRef: string | null;
  /** SHA-256 hex of the nonce cookie apps/web sets on the paying browser. */
  nonceHash: string;
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
/** The website read is capped where it is made; this is the backstop. */
const MAX_PROFILE_BYTES = 200_000;

/** Validate what apps/web sent, exactly as provisioning will, plus the plan's fields. */
export function validateIntentRequest(
  input: unknown,
  /** The catalog's flag, a parameter only so a test can close it. */
  options: { metaSoldAlone?: boolean } = {},
): IntentRequest {
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

  // Provisioning's own checks passed, so the specialty and the plan are known.
  const specialty = body.specialty as SpecialtyId;
  const plan = getPlan(body.plan as string)!;

  // A practice with no agreement it can sign cannot buy: a veterinary one,
  // until the Data Protection Agreement is released (plan Part L).
  if (!specialtyOffered(specialty)) {
    throw new IntentError("This practice's agreement can't be signed here.", "specialty");
  }
  // Nor a package nothing can go live on: Meta as the only channel waits for
  // Meta's App Review (catalog, META_SOLD_ALONE), as apps/web refuses too.
  if (!(options.metaSoldAlone ?? META_SOLD_ALONE) && sellsMetaAlone(plan)) {
    throw new IntentError("Instagram, Messenger + WhatsApp is not sold on its own until Meta approves our app.", "plan");
  }

  const inviteRef = body.inviteRef ?? null;
  if (inviteRef !== null && (typeof inviteRef !== "string" || !UUID.test(inviteRef))) {
    throw new IntentError("Invalid setup link reference.", "inviteRef");
  }
  if (typeof body.nonceHash !== "string" || !SHA256_HEX.test(body.nonceHash)) {
    throw new IntentError("Invalid nonce.", "nonceHash");
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
    throw new IntentError("Website chat needs a website. Choose a package without it.", "plan");
  }

  const profileStatus = body.profileStatus ?? "none";
  if (!(CHECKOUT_PROFILE_STATUSES as readonly string[]).includes(profileStatus)) {
    throw new IntentError("Invalid profile status.", "profileStatus");
  }
  const raw = body.profile ?? null;
  let profile: ClinicProfile | null = null;
  if (raw !== null) {
    if (typeof raw !== "object" || Array.isArray(raw)) throw new IntentError("Invalid profile.", "profile");
    if (JSON.stringify(raw).length > MAX_PROFILE_BYTES) throw new IntentError("The profile is too large.", "profile");
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

/**
 * The agreement must exist, be unbound, and have been signed by the address
 * that is buying. Checked before payment: after it, a refusal would mean a
 * charge with no account behind it.
 */
export async function checkIntentAgreement(agreementId: string, contactEmail: string): Promise<void> {
  const agreement = await getAgreement(agreementId);
  if (!agreement) throw new IntentError("That agreement wasn't found. Please sign it again.", "agreementId");
  if (agreement.organizationId !== null) {
    throw new IntentError("That agreement already belongs to an account. Please sign it again.", "agreementId");
  }
  if (agreement.acceptedByEmail.trim().toLowerCase() !== contactEmail) {
    throw new IntentError("The agreement was signed with a different email address.", "contactEmail");
  }
}

export type IntentResult = {
  ref: string;
  attempt: number;
  expiresAt: Date;
  /** The Checkout Session of the attempt this one replaces, for apps/web to expire. */
  previousOpenSessionId: string | null;
};

/**
 * Store the purchase, or update the one this setup link already made.
 * Refuses a setup link whose purchase is complete.
 */
export async function saveIntent(input: IntentRequest): Promise<IntentResult> {
  const payload: CheckoutIntentPayload & Record<string, unknown> = {
    clinicName: input.clinicName.trim(),
    specialty: input.specialty,
    platform: input.platform,
    plan: input.plan,
    billingInterval: input.billingInterval ?? "month",
    contactName: input.contactName.trim(),
    contactEmail: input.contactEmail,
    ...(input.contactTitle ? { contactTitle: input.contactTitle.trim() } : {}),
    // Never defaulted here. Provisioning reads a present answer as the
    // clinic's confirmed choice (call_routing_confirmed_at, the onboarding
    // step), and the funnel asks neither: an unasked answer stays unasked,
    // and the wizard asks it.
    ...(input.phoneSystemType ? { phoneSystemType: input.phoneSystemType } : {}),
    ...(input.callRouting ? { callRouting: input.callRouting } : {}),
    agreementId: input.agreementId,
    ...(input.attributionMode ? { attributionMode: input.attributionMode } : {}),
    ...(input.averageTreatmentValueUsd !== undefined ? { averageTreatmentValueUsd: input.averageTreatmentValueUsd } : {}),
    ...(input.timezone ? { timezone: input.timezone } : {}),
    ...(input.bookingSystem ? { bookingSystem: input.bookingSystem } : {}),
    ...(input.calendarAccount ? { calendarAccount: input.calendarAccount } : {}),
    ...(input.website !== undefined ? { website: input.website } : {}),
    ...(input.terms ? { terms: input.terms } : {}),
  };
  const values = {
    payload,
    agreementId: input.agreementId,
    contactEmail: input.contactEmail,
    plan: input.plan,
    billingInterval: input.billingInterval ?? "month",
    profile: input.profile,
    profileStatus: input.profileStatus,
    nonceHash: Buffer.from(input.nonceHash, "hex"),
  };

  if (input.inviteRef === null) {
    const [row] = await unsafeDb
      .insert(checkoutIntents)
      .values({ ...values, attempt: 1, expiresAt: sql`now() + make_interval(days => ${INTENT_TTL_DAYS})` })
      .returning({ ref: checkoutIntents.ref, attempt: checkoutIntents.attempt, expiresAt: checkoutIntents.expiresAt });
    return { ...row!, previousOpenSessionId: null };
  }

  // One intent per setup link: a retry updates it, unless it already paid.
  const rows = await unsafeDb
    .insert(checkoutIntents)
    .values({
      ...values,
      inviteRef: input.inviteRef,
      attempt: 1,
      expiresAt: sql`now() + make_interval(days => ${INTENT_TTL_DAYS})`,
    })
    .onConflictDoUpdate({
      target: checkoutIntents.inviteRef,
      set: {
        ...values,
        attempt: sql`${checkoutIntents.attempt} + 1`,
        expiresAt: sql`greatest(${checkoutIntents.expiresAt}, now() + make_interval(days => ${INTENT_TTL_DAYS}))`,
      },
      setWhere: isNull(checkoutIntents.consumedAt),
    })
    .returning({
      ref: checkoutIntents.ref,
      attempt: checkoutIntents.attempt,
      expiresAt: checkoutIntents.expiresAt,
      // Not changed by this statement, so it is still the previous attempt's.
      previousOpenSessionId: checkoutIntents.openSessionId,
    });
  const row = rows[0];
  if (!row) {
    throw new IntentError("This setup link has already been used to complete a purchase.", "setupLink", 409);
  }
  return row;
}

/**
 * Refuse a setup link whose purchase is complete, before anything else is
 * checked: "already used" is the answer that helps, where "the agreement
 * already belongs to an account" would only puzzle.
 */
export async function assertInviteOpen(inviteRef: string | null): Promise<void> {
  if (inviteRef === null) return;
  const [row] = await unsafeDb
    .select({ consumedAt: checkoutIntents.consumedAt })
    .from(checkoutIntents)
    .where(eq(checkoutIntents.inviteRef, inviteRef))
    .limit(1);
  if (row?.consumedAt) {
    throw new IntentError("This setup link has already been used to complete a purchase.", "setupLink", 409);
  }
}

/** Record the Checkout Session apps/web created for one attempt. Only the latest attempt may. */
export async function recordIntentSession(ref: string, attempt: number, sessionId: string): Promise<boolean> {
  if (!UUID.test(ref) || !/^cs_(test|live)_[A-Za-z0-9]{1,200}$/.test(sessionId)) return false;
  const rows = await unsafeDb
    .update(checkoutIntents)
    .set({ openSessionId: sessionId })
    .where(and(eq(checkoutIntents.ref, ref), eq(checkoutIntents.attempt, attempt), isNull(checkoutIntents.consumedAt)))
    .returning({ ref: checkoutIntents.ref });
  return rows.length > 0;
}

export type StoredIntent = typeof checkoutIntents.$inferSelect;

export async function findIntent(ref: string): Promise<StoredIntent | null> {
  if (!UUID.test(ref)) return null;
  const [row] = await unsafeDb.select().from(checkoutIntents).where(eq(checkoutIntents.ref, ref)).limit(1);
  return row ?? null;
}

/**
 * Provisioning refused this paid intent: /welcome stops waiting and says so.
 * Returns the intent the first time only, so whatever the refusal sends (B3)
 * goes once however often the purchase is replayed; null when it was already
 * marked, already provisioned, or never existed.
 */
export async function markIntentFailed(ref: string): Promise<StoredIntent | null> {
  const [row] = await unsafeDb
    .update(checkoutIntents)
    .set({ provisionFailedAt: sql`now()` })
    .where(
      and(
        eq(checkoutIntents.ref, ref),
        isNull(checkoutIntents.consumedAt),
        isNull(checkoutIntents.provisionFailedAt),
      ),
    )
    .returning();
  return row ?? null;
}

/** The provisioning request an intent becomes once its first invoice is paid. */
export function provisionRequestFromIntent(
  intent: StoredIntent,
  stripe: { idempotencyKey: string; stripeCustomerId?: string; stripeSubscriptionId?: string },
): ProvisionRequest {
  const payload = intent.payload as CheckoutIntentPayload & Partial<ProvisionRequest>;
  return {
    clinicName: payload.clinicName,
    specialty: payload.specialty,
    platform: payload.platform,
    plan: payload.plan,
    billingInterval: payload.billingInterval,
    contactName: payload.contactName,
    contactEmail: payload.contactEmail,
    ...(payload.contactTitle ? { contactTitle: payload.contactTitle } : {}),
    // Absent unless the purchase asked (saveIntent), so provisioning applies
    // the column defaults and leaves both unconfirmed for the wizard.
    ...(payload.phoneSystemType ? { phoneSystemType: payload.phoneSystemType } : {}),
    ...(payload.callRouting ? { callRouting: payload.callRouting } : {}),
    agreementId: payload.agreementId,
    ...(payload.attributionMode ? { attributionMode: payload.attributionMode } : {}),
    ...(payload.averageTreatmentValueUsd !== undefined ? { averageTreatmentValueUsd: payload.averageTreatmentValueUsd } : {}),
    ...(payload.timezone ? { timezone: payload.timezone } : {}),
    idempotencyKey: stripe.idempotencyKey,
    ...(stripe.stripeCustomerId ? { stripeCustomerId: stripe.stripeCustomerId } : {}),
    ...(stripe.stripeSubscriptionId ? { stripeSubscriptionId: stripe.stripeSubscriptionId } : {}),
  };
}

/** SHA-256 of a nonce, as stored. */
export function hashNonce(nonce: string): Buffer {
  return createHash("sha256").update(nonce, "utf8").digest();
}

/** Whether a presented nonce is the one this intent was created with. Constant time. */
export function nonceMatches(stored: Buffer | null, presented: string | null | undefined): boolean {
  if (!stored || typeof presented !== "string" || presented.length === 0 || presented.length > 200) return false;
  const digest = hashNonce(presented);
  return digest.length === stored.length && timingSafeEqual(digest, stored);
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
