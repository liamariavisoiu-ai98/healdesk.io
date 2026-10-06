import { createHash, timingSafeEqual } from "node:crypto";

import {
  agreementKindOfVersion,
  agreementPlatformFor,
  type BookingSystemId,
  type CalendarAccount,
  cleanWebsite,
  type ClinicProfile,
  getBaaTemplate,
  getPlan,
  getPlatform,
  isBookingSystemId,
  isCalendarAccount,
  isSpecialtyId,
  META_SOLD_ALONE,
  NO_PLATFORM_ID,
  parseClinicProfile,
  planNeedsWebsite,
  regimeFor,
  screenClinicProfile,
  sellsMetaAlone,
  specialties,
  type SpecialtyId,
  specialtyOffered,
  templateReadsCalendarAccount,
} from "@healdesk/catalog";
import { and, eq, isNull, sql } from "drizzle-orm";

import { unsafeDb } from "@/db";
import {
  baaAcceptances,
  CHECKOUT_PROFILE_STATUSES,
  checkoutIntents,
  type CheckoutIntentPayload,
  type CheckoutProfileStatus,
} from "@/db/schema";
import { agreementKindSufficient, agreementTemplateReleased } from "@/lib/agreements/kind";
import { getStripe, stripeConfigured } from "@/lib/billing/stripe-client";
import { describeError, log } from "@/lib/log";
import { ProvisioningError, validateProvisionRequest, type ProvisionRequest } from "@/lib/provisioning";

/**
 * Checkout intents: a purchase waiting on its first paid invoice (design D1,
 * plan Part A4).
 *
 * apps/web stores nothing, so before it creates a Stripe Checkout Session it
 * sends the validated purchase here, and Stripe carries only the ref and the
 * terms of that press of Pay (`{ app, ref, plan, billingInterval, attempt }`).
 * Everything provisioning will need is checked now, before anyone pays, which
 * is what removes the "paid, then provisioning refused the form" case: the
 * agreement must exist, be unbound, have been signed by the buying address,
 * and be the document this purchase describes (checkIntentAgreement).
 *
 * While purchases are by invitation, one setup link makes one intent
 * (`invite_ref` is unique). Pressing Pay again after cancelling at Stripe
 * reuses it: the attempt counter moves, and apps/web expires the previous
 * Checkout Session so only one can be paid. Pressing it after paying creates
 * nothing (assertInviteOpen, and apps/web's createCheckout), and a payment is
 * provisioned only while the intent still names the press and the terms that
 * were paid (paidTermsMismatch).
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
  /**
   * The covered-entity answer, as the agreement records it: true ("Yes"),
   * false ("No", and a practice never asked), null ("Not sure"). Matched
   * against the signed agreement (checkIntentAgreement); never assumed.
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
 * The agreement must exist, be unbound, have been signed by the address that
 * is buying, and be the document this purchase describes (agreementMismatch,
 * plan Part A4). Checked before payment: after it, a refusal would mean a
 * charge with no account behind it. The browser compares the same answers to
 * decide whether a signature still holds (sameAgreementInputs); this is the
 * comparison a changed request cannot skip. Every refusal of the document
 * names `agreementId`, which sends the buyer back to sign again.
 */
export async function checkIntentAgreement(input: IntentRequest): Promise<void> {
  const [agreement] = UUID.test(input.agreementId)
    ? await unsafeDb
        .select({
          version: baaAcceptances.documentVersion,
          variables: baaAcceptances.variables,
          organizationId: baaAcceptances.organizationId,
          acceptedByEmail: baaAcceptances.acceptedByEmail,
        })
        .from(baaAcceptances)
        .where(eq(baaAcceptances.id, input.agreementId))
        .limit(1)
    : [];
  if (!agreement) throw new IntentError("That agreement wasn't found. Please sign it again.", "agreementId");
  if (agreement.organizationId !== null) {
    throw new IntentError("That agreement already belongs to an account. Please sign it again.", "agreementId");
  }
  if (agreement.acceptedByEmail.trim().toLowerCase() !== input.contactEmail) {
    throw new IntentError("The agreement was signed with a different email address.", "contactEmail");
  }
  const mismatch = agreementMismatch(agreement.version, agreement.variables, input);
  if (mismatch) throw new IntentError(mismatch, "agreementId");
}

/**
 * Why a signed agreement is not the document this purchase describes, or
 * null when it is. Pure, so every rule is testable without a database.
 *
 * - Its template must be one that may be put in force
 *   (agreementTemplateReleased): a released DPA, or a BAA go-live accepts.
 * - Its kind must cover the practice, by the rule the PHI gate applies
 *   (agreementKindSufficient): a veterinary practice never pays on a BAA
 *   only for provisioning to refuse it afterwards.
 * - Every answer that names or selects the document must be the one signed:
 *   the legal name, the specialty, the covered-entity answer, and the booking
 *   system, as the platform it names before 1.3.0, and with the kind of
 *   Google account from 1.3.0 on (and always on a DPA), which read both.
 *
 * Each side is compared as signAgreement wrote it: the name trimmed, a BAA's
 * specialty by the catalogue's name (a DPA's by its id), and a DPA's covered
 * answer as "No", the only one a DPA is signed on.
 */
export function agreementMismatch(
  version: string,
  variables: unknown,
  purchase: Pick<
    IntentRequest,
    "clinicName" | "specialty" | "platform" | "isCoveredEntity" | "bookingSystem" | "calendarAccount"
  >,
): string | null {
  if (!agreementTemplateReleased(version)) {
    return "That agreement's version can no longer be used for a new account. Please sign it again.";
  }
  if (!isSpecialtyId(purchase.specialty)) {
    return "The agreement you signed is for a different kind of practice. Please sign it again.";
  }
  const kind = agreementKindOfVersion(version);
  const signed = (variables ?? {}) as Record<string, unknown>;

  if (!agreementKindSufficient(regimeFor(purchase.specialty), kind, purchase.isCoveredEntity)) {
    return "That agreement doesn't cover this practice. Please sign the one for it.";
  }
  if (signed.clinicLegalName !== purchase.clinicName.trim()) {
    return "The agreement you signed names a different practice. Please sign it again.";
  }
  const specialty =
    kind === "dpa"
      ? purchase.specialty
      : (specialties.find((s) => s.id === purchase.specialty)?.name ?? purchase.specialty);
  if (signed.specialty !== specialty) {
    return "The agreement you signed is for a different kind of practice. Please sign it again.";
  }
  const covered = kind === "dpa" ? (signed.isCoveredEntity ?? false) : signed.isCoveredEntity;
  if (covered !== purchase.isCoveredEntity) {
    return "The agreement you signed has a different answer about billing insurance. Please sign it again.";
  }

  const readsCalendar = kind === "dpa" || templateReadsCalendarAccount(getBaaTemplate(version)!);
  if (readsCalendar) {
    if (signed.bookingSystem !== purchase.bookingSystem || signed.calendarAccount !== purchase.calendarAccount) {
      return "The agreement you signed names a different booking system or Google account. Please sign it again.";
    }
  } else {
    const platform =
      purchase.platform === NO_PLATFORM_ID ? null : (getPlatform(purchase.platform)?.name ?? null);
    if ((signed.connectedPlatform ?? null) !== platform) {
      return "The agreement you signed names a different booking system. Please sign it again.";
    }
  }
  return null;
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
    // As checked against the agreement; provisioning reads the agreement's own.
    isCoveredEntity: input.isCoveredEntity,
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
 *
 * And refuse one whose last Checkout Session has been paid, though the
 * account is not made yet (the first invoice is still on its way): before
 * saveIntent moves the intent to a new attempt, because the paid Session is
 * bound to its own attempt's terms and nonce, and an intent moved past them
 * would turn that payment away at provisioning and lock the paying browser
 * out of /welcome. apps/web asks Stripe the same question after the move
 * (createCheckout), for the press that races this one.
 */
export async function assertInviteOpen(inviteRef: string | null): Promise<void> {
  if (inviteRef === null) return;
  const [row] = await unsafeDb
    .select({ consumedAt: checkoutIntents.consumedAt, openSessionId: checkoutIntents.openSessionId })
    .from(checkoutIntents)
    .where(eq(checkoutIntents.inviteRef, inviteRef))
    .limit(1);
  if (row?.consumedAt) {
    throw new IntentError("This setup link has already been used to complete a purchase.", "setupLink", 409);
  }
  if (row?.openSessionId && (await sessionPaid(row.openSessionId))) {
    throw new IntentError("This purchase is already paid. Check your email.", undefined, 409);
  }
}

/**
 * Whether Stripe says this Checkout Session completed. A press of Pay that
 * cannot find out (Stripe errs, or does not answer within five seconds) is
 * refused with nothing moved, as apps/web refuses one whose previous Session
 * it cannot close: the intent must never move past a Session that may have
 * been paid. Without a Stripe key (development) there is nothing to ask, and
 * apps/web's own check stands.
 */
async function sessionPaid(sessionId: string): Promise<boolean> {
  if (!stripeConfigured()) return false;
  let status: string | null;
  try {
    ({ status } = await getStripe().checkout.sessions.retrieve(sessionId, undefined, { timeout: 5_000 }));
  } catch (error) {
    log.warn("checkout intents: the previous session could not be checked", { error: describeError(error) });
    throw new IntentError(
      "We couldn't check your earlier payment page. Nothing has been charged. Please try again.",
      undefined,
      503,
    );
  }
  return status === "complete";
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

/** Which of the paid terms an intent no longer carries. */
export type PaidTermsMismatch = { field: "attempt" | "plan" | "billingInterval"; message: string };

/**
 * Whether a paid first invoice paid for this intent as it stands: the press
 * of Pay whose Session was paid, and the package and billing period it
 * charged, as the webhook relays them from the subscription's metadata
 * (apps/web createCheckout writes them). Every press of Pay moves the intent
 * on and rewrites what provisioning builds the account from, so a payment for
 * any other press, or terms the intent no longer has, must never provision:
 * /api/provision refuses it, and ops finishes it by hand. Absent or malformed
 * values do not match.
 */
export function paidTermsMismatch(
  intent: Pick<StoredIntent, "attempt" | "plan" | "billingInterval">,
  paid: { attempt?: unknown; plan?: unknown; billingInterval?: unknown },
): PaidTermsMismatch | null {
  if (paid.attempt !== intent.attempt) {
    return { field: "attempt", message: "The payment was for another press of Pay than this purchase's latest." };
  }
  if (paid.plan !== intent.plan) {
    return { field: "plan", message: "The payment was for a different package than this purchase's." };
  }
  if (paid.billingInterval !== intent.billingInterval) {
    return { field: "billingInterval", message: "The payment was for a different billing period than this purchase's." };
  }
  return null;
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
