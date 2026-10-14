import {
  AGREEMENT_COPY,
  agreementKindFor,
  agreementPlatformFor,
  isBookingSystemId,
  isCalendarAccount,
  validateIntentRequest,
  type CoveredAnswer,
} from "@healdesk/catalog";
import { effectiveDateOf, prepareSigning, validateSignRequest } from "@healdesk/catalog/agreement-signing";
import { agreementRecordFrom, openSealedRecord, type AgreementRecord, type IntentRecord } from "@healdesk/catalog/checkout-record";

import { appendAgreementRecord, appendIntentRecord, recordIntentSession } from "./records";

/**
 * Test-only helpers for the checkout records: a signature recorded exactly
 * as /api/agreement records one, for the purchase routes to find, and a way
 * to read back what a relay carried. Not a `.test.ts`, so vitest does not run
 * it; nothing outside tests imports it.
 */

export type TestSignature = {
  clinicName: string;
  specialty: string;
  /** As the funnel sends it: "yes", "no", "not_sure", or null where it is not asked. */
  covered: CoveredAnswer | null;
  bookingSystem: string;
  calendarAccount: string;
  contactName: string;
  contactEmail: string;
  contactTitle?: string | null;
};

/** The request the agreement step would send for these answers. */
export function signatureRequestFor(answers: TestSignature): Record<string, unknown> {
  const choice = agreementKindFor({ specialty: answers.specialty, covered: answers.covered });
  if (!choice.ok) throw new Error(`No agreement for ${answers.specialty}`);
  const copy = AGREEMENT_COPY[choice.kind];
  if (!isBookingSystemId(answers.bookingSystem) || !isCalendarAccount(answers.calendarAccount)) {
    throw new Error("Unknown calendar answers");
  }
  return {
    clinicLegalName: answers.clinicName.trim(),
    specialty: answers.specialty,
    attributionMode: "estimated",
    platform: agreementPlatformFor(answers.bookingSystem),
    bookingSystem: answers.bookingSystem,
    calendarAccount: answers.calendarAccount,
    signatoryName: answers.contactName.trim(),
    ...(answers.contactTitle ? { signatoryTitle: answers.contactTitle } : {}),
    signatoryEmail: answers.contactEmail,
    isCoveredEntity: choice.isCoveredEntity,
    assentLabel: copy.assentLabel,
    templateVersion: copy.currentVersion,
  };
}

/** A signature recorded in the (fake) Sheet as /api/agreement records one. */
export async function signTestAgreement(
  answers: TestSignature,
  facts: { id?: string; acceptedAt?: Date } = {},
): Promise<AgreementRecord> {
  const request = signatureRequestFor(answers);
  validateSignRequest(request);
  const acceptedAt = facts.acceptedAt ?? new Date();
  const prepared = prepareSigning(request, effectiveDateOf(acceptedAt), {});
  const record = agreementRecordFrom(prepared, {
    id: facts.id ?? crypto.randomUUID(),
    acceptedAt,
    ipAddress: "203.0.113.9",
    userAgent: "vitest",
  });
  await appendAgreementRecord(record);
  return record;
}

/** The purchase record a relay carried, opened with the test secret. */
export function relayedIntent(body: Record<string, unknown>, secret: string): IntentRecord {
  const records = body.records as { intent?: unknown } | undefined;
  const opened = openSealedRecord(records?.intent, secret);
  if (!opened) throw new Error("The relayed purchase record does not open.");
  return opened as IntentRecord;
}

/** The agreement record a relay carried, opened with the test secret. */
export function relayedAgreement(body: Record<string, unknown>, secret: string): AgreementRecord {
  const records = body.records as { agreement?: unknown } | undefined;
  const opened = openSealedRecord(records?.agreement, secret);
  if (!opened) throw new Error("The relayed agreement record does not open.");
  return opened as AgreementRecord;
}

/**
 * One press of Pay, recorded as /api/checkout records it, for the agreement
 * given: the purchase body validateIntentRequest takes, sealed, with the
 * Session it opened when `sessionId` is given.
 */
export async function recordTestPurchase(
  agreement: AgreementRecord,
  options: {
    ref: string;
    attempt?: number;
    sessionId?: string | null;
    inviteRef?: string | null;
    plan?: string;
    billingInterval?: "month" | "year";
    nonceHash?: string;
  },
): Promise<IntentRecord> {
  const variables = agreement.variables as Record<string, unknown>;
  const answers = agreement.answers as Record<string, unknown>;
  const now = new Date();
  const body: Record<string, unknown> = {
    clinicName: variables.clinicLegalName,
    specialty: "med-spa",
    platform: answers.platformId ?? "none",
    plan: options.plan ?? "voice-webchat-500-300",
    billingInterval: options.billingInterval ?? "month",
    contactName: agreement.signatoryName,
    contactEmail: agreement.signatoryEmail,
    agreementId: agreement.id,
    isCoveredEntity: variables.isCoveredEntity ?? false,
    bookingSystem: answers.bookingSystem ?? variables.bookingSystem,
    calendarAccount: answers.calendarAccount ?? variables.calendarAccount,
    website: "radiancemedspa.com",
    profile: null,
    profileStatus: "failed",
    inviteRef: options.inviteRef ?? null,
    nonceHash: options.nonceHash ?? "a".repeat(64),
    terms: { version: "2026-10-14.1", acceptedAt: now.toISOString(), ip: "203.0.113.9" },
  };
  const record: IntentRecord = {
    record: "checkout_intent",
    v: 1,
    id: crypto.randomUUID(),
    ref: options.ref,
    attempt: options.attempt ?? 1,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 14 * 86_400_000).toISOString(),
    intent: body,
    sessionId: null,
  };
  const stored = await appendIntentRecord(record, validateIntentRequest(body));
  if (options.sessionId) {
    await recordIntentSession(stored, options.sessionId);
    return { ...record, sessionId: options.sessionId };
  }
  return record;
}
