import { createHash, timingSafeEqual } from "node:crypto";

import {
  agreementMismatch as catalogAgreementMismatch,
  clinicTimeZone,
  IntentError,
  INTENT_TTL_DAYS,
  parseClinicProfile,
  validateIntentRequest,
  type AgreementMatchPurchase,
  type IntentRequest,
} from "@healdesk/catalog";
import type { IntentRecord } from "@healdesk/catalog/checkout-record";
import { and, eq, isNull, sql } from "drizzle-orm";

import { unsafeDb } from "@/db";
import { baaAcceptances, checkoutIntents, type CheckoutIntentPayload } from "@/db/schema";
import { agreementTemplateReleased } from "@/lib/agreements/kind";
import type { ProvisionRequest } from "@/lib/provisioning";

/**
 * Checkout intents: a purchase waiting on its first paid invoice (design D1,
 * plan Part A4).
 *
 * Until 14 October 2026 apps/web sent the validated purchase here when the
 * buyer pressed Pay, and this module stored it (`saveIntent`, at
 * /api/checkout/intents) before Stripe saw anything. Since then apps/web
 * records it itself, sealed, in the marketing Sheet, so a buyer can pay while
 * this host is in standby, and the first paid invoice brings it here with the
 * signed agreement, to be imported and provisioned
 * (lib/checkout/import.ts; docs/design/checkout-records-on-vercel-2026-10-14.md).
 * Stripe still carries only the ref and the terms of that press of Pay
 * (`{ app, ref, plan, billingInterval, attempt }`).
 *
 * What the purchase must be is the catalog's (`validateIntentRequest`,
 * `agreementMismatch`; packages/catalog/src/checkout-intent.ts and
 * agreement-match.ts), because apps/web holds the purchase to it before
 * anyone pays and this module holds the imported record to it again: the
 * agreement must exist, be unbound, have been signed by the buying address,
 * and be the document this purchase describes (checkIntentAgreement). A
 * payment is provisioned only while the intent names the press and the terms
 * that were paid (paidTermsMismatch).
 */

export { IntentError, INTENT_TTL_DAYS, validateIntentRequest, type IntentRequest };

/**
 * The catalog's agreementMismatch (packages/catalog/src/agreement-match.ts),
 * judged under this host's release gate (lib/agreements/kind.ts), which is
 * the one provisioning applies.
 */
export function agreementMismatch(
  version: string,
  variables: unknown,
  purchase: AgreementMatchPurchase,
  options: { released?: (version: string) => boolean } = {},
): string | null {
  return catalogAgreementMismatch(version, variables, purchase, {
    released: options.released ?? agreementTemplateReleased,
  });
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The agreement must exist, be unbound, have been signed by the address that
 * is buying, and be the document this purchase describes (agreementMismatch,
 * plan Part A4). apps/web asks the same of its own record before payment,
 * when a refusal costs nothing; this asks it of the imported row, after
 * payment, where a refusal is a paid order ops finishes by hand, because the
 * record has crossed a store this host does not control. Every refusal of the
 * document names `agreementId`.
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
 * The intent row's `payload`: the purchase as provisioning will read it back
 * (provisionRequestFromIntent), built as the stored intents always were.
 */
export function intentPayload(input: IntentRequest): CheckoutIntentPayload & Record<string, unknown> {
  return {
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
}

/**
 * Take in the purchase record apps/web kept, as the intent row this module has
 * always provisioned from: the same ref, attempt, nonce and Checkout Session,
 * and the record's own creation and expiry. Idempotent: a row already there
 * for this ref is left exactly as it is (a retried invoice event, or an
 * import that ran before a transient failure), and the caller reads it.
 *
 * `on conflict do nothing` with no target, so the unique `invite_ref` cannot
 * fail the import either: a record's ref is its setup link's own id, so a
 * conflict there is an intent made before 14 October 2026 for the same link,
 * under another ref, which findIntent then does not find, and provisioning
 * refuses as an unknown purchase, to ops.
 */
export async function importIntent(record: IntentRecord, input: IntentRequest): Promise<"imported" | "present"> {
  const rows = await unsafeDb
    .insert(checkoutIntents)
    .values({
      ref: record.ref,
      payload: intentPayload(input),
      agreementId: input.agreementId,
      contactEmail: input.contactEmail,
      plan: input.plan,
      billingInterval: input.billingInterval ?? "month",
      createdAt: new Date(record.createdAt),
      expiresAt: new Date(record.expiresAt),
      profile: input.profile,
      profileStatus: input.profileStatus,
      inviteRef: input.inviteRef,
      attempt: record.attempt,
      openSessionId: record.sessionId,
      nonceHash: Buffer.from(input.nonceHash, "hex"),
    })
    .onConflictDoNothing()
    .returning({ ref: checkoutIntents.ref });
  return rows.length > 0 ? "imported" : "present";
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
  // The clinic's time zone (plan C2): the address the website read found,
  // then the buyer's browser, then New York. The wizard shows it and asks
  // when the browser disagrees.
  const readAddress = parseClinicProfile(intent.profile)?.locations[0]?.address ?? null;
  const timezone = clinicTimeZone({ address: readAddress, browserTimeZone: payload.timezone });
  return {
    clinicName: payload.clinicName,
    specialty: payload.specialty,
    platform: payload.platform,
    plan: payload.plan,
    billingInterval: payload.billingInterval,
    contactName: payload.contactName,
    contactEmail: payload.contactEmail,
    ...(payload.contactTitle ? { contactTitle: payload.contactTitle } : {}),
    // Absent unless the purchase asked (intentPayload), so provisioning applies
    // the column defaults and leaves both unconfirmed for the wizard.
    ...(payload.phoneSystemType ? { phoneSystemType: payload.phoneSystemType } : {}),
    ...(payload.callRouting ? { callRouting: payload.callRouting } : {}),
    agreementId: payload.agreementId,
    ...(payload.attributionMode ? { attributionMode: payload.attributionMode } : {}),
    ...(payload.averageTreatmentValueUsd !== undefined ? { averageTreatmentValueUsd: payload.averageTreatmentValueUsd } : {}),
    timezone,
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
