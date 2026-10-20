import { createHash, randomBytes, randomUUID } from "node:crypto";

import { AGREEMENT_COPY, INTENT_TTL_DAYS } from "@healdesk/catalog";
import { effectiveDateOf, prepareSigning, validateSignRequest } from "@healdesk/catalog/agreement-signing";
import {
  agreementRecordFrom,
  sealRecord,
  type AgreementRecord,
  type IntentRecord,
  type SealedRecord,
} from "@healdesk/catalog/checkout-record";

/**
 * The checkout records apps/web keeps in the marketing Sheet and relays to
 * /api/provision with the first paid invoice (since 14 October 2026;
 * docs/design/checkout-records-on-vercel-2026-10-14.md), built here exactly
 * as apps/web builds them, from the catalog's own code, so a test can import
 * and provision a purchase without apps/web.
 */

export type SignatureAnswers = {
  clinicLegalName?: string;
  specialty?: string;
  signatoryName?: string;
  signatoryTitle?: string;
  signatoryEmail: string;
  isCoveredEntity?: boolean | null;
  platform?: string;
  bookingSystem?: string;
  calendarAccount?: string;
  displayedHash?: string;
  /**
   * Which agreement the record is. Default the BAA: for a practice that
   * answered "No" (the default answer), one signed before the DPA's release
   * on 20 October 2026, as every "No" signed until then. "dpa" signs the
   * released Data Protection Agreement, as apps/web signs one for a "No" or a
   * veterinary practice from that day.
   */
  kind?: "baa" | "dpa";
};

/** A signature, recorded as apps/web's /api/agreement records one. */
export function agreementRecord(
  answers: SignatureAnswers,
  facts: { id?: string; acceptedAt?: Date; ipAddress?: string | null; userAgent?: string | null } = {},
): AgreementRecord {
  const kind = answers.kind ?? "baa";
  const request: Record<string, unknown> = {
    clinicLegalName: answers.clinicLegalName ?? "Glow Med Spa LLC",
    specialty: answers.specialty ?? "med-spa",
    signatoryName: answers.signatoryName ?? "Laura Owner",
    signatoryTitle: answers.signatoryTitle ?? "Owner",
    signatoryEmail: answers.signatoryEmail,
    isCoveredEntity: answers.isCoveredEntity === undefined ? false : answers.isCoveredEntity,
    attributionMode: "estimated",
    platform: answers.platform ?? "none",
    bookingSystem: answers.bookingSystem ?? "none",
    calendarAccount: answers.calendarAccount ?? "workspace_no_baa",
    assentLabel: AGREEMENT_COPY[kind].assentLabel,
    templateVersion: AGREEMENT_COPY[kind].currentVersion,
    ...(answers.displayedHash ? { displayedHash: answers.displayedHash } : {}),
  };
  const options = kind === "baa" ? { dpaReleased: false } : {};
  validateSignRequest(request, options);
  const acceptedAt = facts.acceptedAt ?? new Date();
  return agreementRecordFrom(prepareSigning(request, effectiveDateOf(acceptedAt), options), {
    id: facts.id ?? randomUUID(),
    acceptedAt,
    ipAddress: facts.ipAddress === undefined ? "203.0.113.4" : facts.ipAddress,
    userAgent: facts.userAgent === undefined ? "Mozilla/5.0 (vitest)" : facts.userAgent,
  });
}

/** A nonce and the hash a purchase record carries for it. */
export function nonce(): { value: string; hash: string } {
  const value = randomBytes(24).toString("base64url");
  return { value, hash: createHash("sha256").update(value).digest("hex") };
}

/** One press of Pay for that agreement, recorded as apps/web's /api/checkout records one. */
export function intentRecord(
  agreement: AgreementRecord,
  options: {
    ref?: string;
    attempt?: number;
    sessionId?: string | null;
    nonceHash?: string;
    createdAt?: Date;
    /** Fields of the purchase itself, over the ones that match the agreement. */
    purchase?: Record<string, unknown>;
  } = {},
): IntentRecord {
  const variables = agreement.variables as Record<string, unknown>;
  const answers = agreement.answers as Record<string, unknown>;
  const createdAt = options.createdAt ?? new Date();
  const purchase = options.purchase ?? {};
  const inviteRef = (purchase.inviteRef as string | null | undefined) ?? null;
  return {
    record: "checkout_intent",
    v: 1,
    id: randomUUID(),
    ref: options.ref ?? inviteRef ?? randomUUID(),
    attempt: options.attempt ?? 1,
    createdAt: createdAt.toISOString(),
    expiresAt: new Date(createdAt.getTime() + INTENT_TTL_DAYS * 86_400_000).toISOString(),
    sessionId: options.sessionId === undefined ? null : options.sessionId,
    intent: {
      // The agreement's own answers: the legal name it names, its covered
      // answer and the calendar answers the current version reads.
      clinicName: variables.clinicLegalName,
      specialty: "med-spa",
      platform: answers.platformId ?? "none",
      bookingSystem: answers.bookingSystem ?? variables.bookingSystem,
      calendarAccount: answers.calendarAccount ?? variables.calendarAccount,
      plan: "voice-webchat-1000-1000",
      billingInterval: "month",
      contactName: agreement.signatoryName,
      contactEmail: agreement.signatoryEmail.toUpperCase(),
      agreementId: agreement.id,
      isCoveredEntity: variables.isCoveredEntity ?? false,
      inviteRef,
      nonceHash: options.nonceHash ?? nonce().hash,
      website: "glowspa.test",
      profileStatus: "failed",
      profile: null,
      timezone: "America/New_York",
      terms: { version: "2026-10-14.1", acceptedAt: createdAt.toISOString(), ip: "203.0.113.4" },
      ...purchase,
    },
  };
}

/** A record sealed with the secret the provision route opens it with. */
export function sealed(record: AgreementRecord | IntentRecord, secret = process.env.HEALDESK_PROVISION_SECRET ?? ""): SealedRecord {
  return sealRecord(record, secret);
}

/** Both records, as the invoice.paid relay carries them. */
export function records(agreement: AgreementRecord, intent: IntentRecord, secret?: string) {
  return { intent: sealed(intent, secret), agreement: sealed(agreement, secret) };
}
