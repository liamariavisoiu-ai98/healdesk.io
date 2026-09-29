import { CALLBACK_CONSENT } from "@healdesk/catalog";
import { and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";

import { bookingRequests, clinics, consentRecords, contacts, outboundCalls, suppressions, type OutboundCallPurpose } from "@/db/schema";
import { suppress } from "@/lib/compliance/contact-policy";
import type { TenantTx } from "@/lib/tenant";

/**
 * Queueing a consented callback (design of 23 September 2026, §F.4).
 *
 * This file writes the `due` row; it never dials. The dialer (§F.5, lib/
 * callbacks/dial.ts) re-checks every gate at dial time, so nothing here is
 * the last line of defence — but everything here is a line, and each refusal
 * names itself so the page and the audit row can say why the desk has to
 * ring instead:
 *
 *   - the environment kill switch and the clinic's own switch, both off by
 *     default;
 *   - a consent row for THIS number, unrevoked, captured on an inbound
 *     contact, and carrying the CURRENT wording version — a person who said
 *     yes to an older question did not say yes to this one;
 *   - no suppression for the number (a "stop" outranks a "yes" that came
 *     before it);
 *   - the request still open (or confirmed, for the informational
 *     `confirm_time` call only);
 *   - one row per attempt: the unique index refuses a second attempt 1, and
 *     attempt 2 is the dialer's to insert, only after attempt 1 positively
 *     reported no answer.
 *
 * The table's own shape (NOT NULL consent FK, the consent-match trigger, the
 * attempt CHECK) refuses what this code might forget.
 */

/** No sooner than this after the request: the desk gets first look at the page. */
export const CALLBACK_NOT_BEFORE_MINUTES = 15;

export type CallbackPurpose = OutboundCallPurpose;

export type ScheduleOutcome = { scheduled: true; callId: string } | { scheduled: false; reason: string };

const OPEN_STATUSES = ["requested", "accepted", "rescheduling"] as const;

/** §F.1: the product-wide switch. Read directly for now; lib/compliance/contact-policy.ts centralises it. */
export function outboundCallbacksEnabled(): boolean {
  return process.env.HEALDESK_OUTBOUND_CALLBACKS_ENABLED === "true";
}

/**
 * The consent row a callback to this number may be placed under, or null.
 * Unrevoked, inbound-sourced, current wording, and the number not suppressed.
 */
export async function callbackConsentFor(tx: TenantTx, phone: string): Promise<{ consentRecordId: string } | null> {
  const [suppressed] = await tx.db
    .select({ id: suppressions.id })
    .from(suppressions)
    .where(and(eq(suppressions.clinicId, tx.clinicId), eq(suppressions.phone, phone), or(isNull(suppressions.channel), eq(suppressions.channel, "voice"))))
    .limit(1);
  if (suppressed) return null;
  const [consent] = await tx.db
    .select({ id: consentRecords.id })
    .from(consentRecords)
    .where(
      and(
        eq(consentRecords.clinicId, tx.clinicId),
        eq(consentRecords.phone, phone),
        eq(consentRecords.channel, "voice"),
        isNull(consentRecords.revokedAt),
        eq(consentRecords.wordingVersion, CALLBACK_CONSENT.version),
        inArray(consentRecords.source, ["inbound_call", "meta_thread"]),
      ),
    )
    .orderBy(desc(consentRecords.grantedAt))
    .limit(1);
  return consent ? { consentRecordId: consent.id } : null;
}

/** Both switches and a usable consent row: what the desk page reads to choose its copy (§B.3, §F.3). */
export async function callbacksAvailable(tx: TenantTx, phone: string | null): Promise<boolean> {
  if (!phone || !outboundCallbacksEnabled()) return false;
  const [clinic] = await tx.db.select({ enabled: clinics.outboundCallbacksEnabled }).from(clinics).where(eq(clinics.id, tx.clinicId)).limit(1);
  if (!clinic?.enabled) return false;
  return (await callbackConsentFor(tx, phone)) !== null;
}

export async function scheduleCallback(
  tx: TenantTx,
  requestId: string,
  purpose: CallbackPurpose,
  opts: { now?: Date } = {},
): Promise<ScheduleOutcome> {
  const now = opts.now ?? new Date();
  const refuse = (reason: string): ScheduleOutcome => {
    tx.audit.record({ action: "update", resourceType: "booking_request", resourceId: requestId, metadata: { outcome: "callback_refused", purpose, reason } });
    return { scheduled: false, reason };
  };

  if (!outboundCallbacksEnabled()) return refuse("outbound_disabled");
  const [clinic] = await tx.db.select({ enabled: clinics.outboundCallbacksEnabled }).from(clinics).where(eq(clinics.id, tx.clinicId)).limit(1);
  if (!clinic?.enabled) return refuse("clinic_disabled");

  const [request] = await tx.db
    .select({
      id: bookingRequests.id,
      status: bookingRequests.status,
      contactId: bookingRequests.contactId,
      createdAt: bookingRequests.createdAt,
      expired: sql<boolean>`${bookingRequests.expiresAt} <= now()`,
      phone: contacts.phone,
    })
    .from(bookingRequests)
    .innerJoin(contacts, eq(contacts.id, bookingRequests.contactId))
    .where(and(eq(bookingRequests.id, requestId), eq(bookingRequests.clinicId, tx.clinicId)))
    .limit(1);
  if (!request) return refuse("not_found");
  if (!request.phone) return refuse("no_phone");
  if (request.expired) return refuse("request_expired");
  const open = (OPEN_STATUSES as readonly string[]).includes(request.status) || (purpose === "confirm_time" && request.status === "confirmed");
  if (!open) return refuse("request_terminal");

  const consent = await callbackConsentFor(tx, request.phone);
  if (!consent) return refuse("no_consent");

  const [existing] = await tx.db
    .select({ id: outboundCalls.id })
    .from(outboundCalls)
    .where(and(eq(outboundCalls.bookingRequestId, requestId), eq(outboundCalls.attemptNo, 1)))
    .limit(1);
  if (existing) return refuse("already_scheduled");

  const earliest = new Date(request.createdAt.getTime() + CALLBACK_NOT_BEFORE_MINUTES * 60_000);
  const [row] = await tx.db
    .insert(outboundCalls)
    .values({
      clinicId: tx.clinicId,
      contactId: request.contactId,
      bookingRequestId: requestId,
      consentRecordId: consent.consentRecordId,
      purpose,
      phone: request.phone,
      attemptNo: 1,
      notBefore: earliest > now ? earliest : now,
      status: "due",
    })
    .returning({ id: outboundCalls.id });
  if (!row) throw new Error("Failed to schedule a callback: no row returned.");
  tx.audit.record({ action: "create", resourceType: "outbound_call", resourceId: row.id, resourceIds: [requestId], metadata: { purpose, attempt: 1 } });
  return { scheduled: true, callId: row.id };
}

/**
 * Honour a stop from the person, whichever surface it arrived on (§F.2 for a
 * Meta message, §F.7 for the callback's own "stop"): suppress the number on
 * every channel, revoke every consent row for it, and cancel every callback
 * still queued. One transaction, so a crash between them cannot leave a
 * queued call under a revoked consent.
 */
export async function honourStopRequest(tx: TenantTx, phone: string, reason: "stop_reply" | "stop_request"): Promise<{ revoked: number; cancelled: number }> {
  await suppress(tx.db, { clinicId: tx.clinicId, phone, reason });
  const revoked = await tx.db
    .update(consentRecords)
    .set({ revokedAt: new Date() })
    .where(and(eq(consentRecords.clinicId, tx.clinicId), eq(consentRecords.phone, phone), isNull(consentRecords.revokedAt)))
    .returning({ id: consentRecords.id });
  const cancelled = await tx.db
    .update(outboundCalls)
    .set({ status: "cancelled", refusalCode: "stop" })
    .where(and(eq(outboundCalls.clinicId, tx.clinicId), eq(outboundCalls.phone, phone), eq(outboundCalls.status, "due")))
    .returning({ id: outboundCalls.id });
  tx.audit.record({
    action: "update",
    resourceType: "consent_record",
    resourceIds: revoked.map((r) => r.id),
    resultCount: revoked.length,
    metadata: { outcome: "revoked", reason, cancelledCalls: cancelled.length },
  });
  return { revoked: revoked.length, cancelled: cancelled.length };
}
