import { and, eq, inArray, or, sql } from "drizzle-orm";

import {
  appointments,
  auditLog,
  bookingRequests,
  chatThreads,
  consentRecords,
  contactAttempts,
  contacts,
  conversations,
  depositPayments,
  metaBookingDrafts,
  slotHolds,
  suppressions,
  transactions,
  webhookEvents,
} from "@/db/schema";
import type { TenantTx } from "@/lib/tenant";

import { amendmentsFor, withAmendments, type RecordAmendment } from "./amendments";
import { isPatientRequester, type PatientRequester } from "./requesters";

/**
 * The patient-rights export: everything held about one person, in one
 * bundle, with the accounting of disclosures beside it.
 *
 * The BAA's patient-rights clause commits healdesk to give the clinic what
 * it needs to answer an access, amendment or accounting request within ten
 * business days. This is that: found by phone or email inside the clinic's
 * tenant, every row that names the contact, and the audit trail filtered to
 * those rows — which is the only possible accounting of disclosures, and
 * which report.ts already proves records even a count.
 *
 * Its own audit row is written for the export itself: producing a bundle is
 * an access, and the next accounting request must show this one.
 *
 * Each booking request, appointment and conversation carries its amendments beside it
 * (`amendments`, oldest first; lib/patient-rights/amendments.ts), as BAA
 * 1.3.0's clause 14(b) promises: "Every later export of that record, and
 * every screen of healdesk's that shows it, then carries the amendment." So
 * does the whole clinic's bundle. The portal's export (M5) must do the same,
 * and so must any screen that shows a request or a conversation.
 *
 * Each bundle also carries the deposits the clinic took through its own
 * Stripe account for the person's appointments (the whole clinic's, in its
 * bundle): the amount, when and how it was paid, and the Stripe session the
 * clinic can find it by. Destruction deletes them (BAA 1.3.0 clause 17 lets
 * only two records survive), so the return bundle is the clinic's copy.
 *
 * The whole clinic's bundle also carries the raw payloads other services
 * sent (`rawPayloads`: provider, when it arrived, whether it was processed,
 * and the body, decoded where it parses), which hold the transcripts' words
 * that no other table does, the messaging threads as keyed references, and
 * the half-collected Meta drafts: clause 17 promises "an export of the
 * patient information it holds" (the calendar session's re-audit, C19).
 *
 * Who asked is one of PATIENT_REQUESTERS, chosen, never typed: the audit
 * row this writes outlives the person, so it holds nothing typed.
 *
 * A person's bundle is produced for the covered entity, which validates the
 * request: the operator's script, or the clinic itself from a conversation
 * it opens in the portal behind its passkey (M5, lib/portal/conversations.ts).
 * The whole clinic's bundle is the clinic's to download from the portal at
 * any time, and the operator's to hand over at offboarding.
 */
/** A record as exported: the row, and every amendment Practice directed to it beside it. */
export type Amended<T> = T & { amendments: RecordAmendment[] };

export type PatientBundle = {
  producedAt: string;
  contacts: (typeof contacts.$inferSelect)[];
  conversations: Amended<typeof conversations.$inferSelect>[];
  appointments: Amended<typeof appointments.$inferSelect>[];
  transactions: (typeof transactions.$inferSelect)[];
  consentRecords: (typeof consentRecords.$inferSelect)[];
  suppressions: (typeof suppressions.$inferSelect)[];
  contactAttempts: (typeof contactAttempts.$inferSelect)[];
  /** Booking requests from any channel, handed to the desk on the manual booking path; the token digest is not included. */
  bookingRequests: Amended<Omit<typeof bookingRequests.$inferSelect, "tokenHash">>[];
  /** Deposits taken through the clinic's own Stripe account for their appointments: never the Stripe account id or event id. */
  depositPayments: DepositRecord[];
  /** Times the assistant held for them on a call (plan §11.8): when, for how long, and what became of it. */
  slotHolds: { id: string; startsAt: Date; endsAt: Date; status: string; createdAt: Date }[];
  /** Every audit row that touched any of the ids above: the accounting of disclosures. */
  accountingOfDisclosures: (typeof auditLog.$inferSelect)[];
  /**
   * The whole clinic's bundle only. The raw copies the voice vendor and the
   * other services sent (webhook_events), each decoded where it parses and
   * as its text where it does not: the only place a transcript's words sit
   * in our database (a conversation keeps the transcript's address), kept up
   * to the record clock when never processed (C19, 12 October 2026).
   */
  rawPayloads?: RawPayloadRecord[];
  /** The whole clinic's bundle only: messaging threads, as keyed references (never the sender's id) and dates. */
  messagingThreads?: MessagingThreadRecord[];
  /** The whole clinic's bundle only: half-collected Meta bookings (a first name, a number, a time). */
  metaBookingDrafts?: (typeof metaBookingDrafts.$inferSelect)[];
};

export type RawPayloadRecord = {
  id: string;
  provider: string;
  deliveryId: string;
  receivedAt: Date;
  processedAt: Date | null;
  processed: boolean;
  signatureValid: boolean;
  /** The body, decoded, where it parses as JSON; otherwise null and `text` holds it. */
  body: unknown;
  /** The body as received, where it does not parse as JSON; otherwise null. */
  text: string | null;
};

export type MessagingThreadRecord = Pick<
  typeof chatThreads.$inferSelect,
  "channel" | "partyRef" | "conversationStartedAt" | "lastInboundAt" | "conversationsCount"
>;

/**
 * How deep a decoded payload may nest and still go into the bundle decoded.
 * patient-export writes the bundle with JSON.stringify(bundle, null, 2),
 * which recurses once per level and overflows the stack a few thousand
 * levels down, with the bundle's own levels on top; a check that the body
 * alone could be written out ran shallower than that, so a body about 6,900
 * deep decoded here and failed the write (third review of C19, 12 October
 * 2026). A real vendor body nests a dozen levels; anything past this one is
 * not data to read, and goes in as its text.
 */
export const DECODED_PAYLOAD_MAX_DEPTH = 512;

/** Whether a decoded JSON value nests no deeper than `max` arrays and objects. Iterative, so a deep value cannot overflow it. */
function nestsWithin(value: unknown, max: number): boolean {
  const stack: [unknown, number][] = [[value, 0]];
  while (stack.length) {
    const [node, depth] = stack.pop()!;
    if (node === null || typeof node !== "object") continue;
    if (depth + 1 > max) return false;
    for (const child of Array.isArray(node) ? node : Object.values(node)) {
      if (child !== null && typeof child === "object") stack.push([child, depth + 1]);
    }
  }
  return true;
}

/**
 * A raw payload for the bundle: decoded where it parses and nests no deeper
 * than DECODED_PAYLOAD_MAX_DEPTH, its text otherwise (a body too deep to
 * parse included), so the bundle can always be written out.
 */
function payloadRecord(row: typeof webhookEvents.$inferSelect): RawPayloadRecord {
  let body: unknown = null;
  let text: string | null = row.rawPayload;
  try {
    const decoded: unknown = JSON.parse(row.rawPayload);
    if (nestsWithin(decoded, DECODED_PAYLOAD_MAX_DEPTH)) {
      body = decoded;
      text = null;
    }
  } catch {
    body = null;
  }
  return {
    id: row.id,
    provider: row.provider,
    deliveryId: row.deliveryId,
    receivedAt: row.receivedAt,
    processedAt: row.processedAt,
    processed: row.processedAt !== null,
    signatureValid: row.signatureValid,
    body,
    text,
  };
}

export type DepositRecord = Pick<
  typeof depositPayments.$inferSelect,
  "id" | "appointmentId" | "channel" | "amountCents" | "currency" | "status" | "checkoutSessionId" | "paidAt" | "createdAt"
>;

const DEPOSIT_COLUMNS = {
  id: depositPayments.id,
  appointmentId: depositPayments.appointmentId,
  channel: depositPayments.channel,
  amountCents: depositPayments.amountCents,
  currency: depositPayments.currency,
  status: depositPayments.status,
  checkoutSessionId: depositPayments.checkoutSessionId,
  paidAt: depositPayments.paidAt,
  createdAt: depositPayments.createdAt,
};

function assertRequester(requestedBy: unknown): asserts requestedBy is PatientRequester {
  if (!isPatientRequester(requestedBy)) {
    throw new Error("Who asked is one of the closed set (PATIENT_REQUESTERS), never typed.");
  }
}

export async function exportPatient(
  tx: TenantTx,
  query: { phone?: string; email?: string; requestedBy: PatientRequester },
): Promise<PatientBundle> {
  assertRequester(query.requestedBy);
  if (!query.phone && !query.email) throw new Error("A phone number or an email address is required.");

  const found = await tx.db
    .select()
    .from(contacts)
    .where(
      and(
        eq(contacts.clinicId, tx.clinicId),
        or(
          query.phone ? eq(contacts.phone, query.phone) : sql`false`,
          query.email ? eq(contacts.email, query.email.toLowerCase()) : sql`false`,
        ),
      ),
    );
  const ids = found.map((c) => c.id);
  const phones = found.map((c) => c.phone).filter((p): p is string => Boolean(p));
  if (query.phone) phones.push(query.phone);

  const convos = ids.length
    ? await tx.db.select().from(conversations).where(and(eq(conversations.clinicId, tx.clinicId), inArray(conversations.contactId, ids)))
    : [];
  const appts = ids.length
    ? await tx.db.select().from(appointments).where(and(eq(appointments.clinicId, tx.clinicId), inArray(appointments.contactId, ids)))
    : [];
  const txns = ids.length
    ? await tx.db.select().from(transactions).where(and(eq(transactions.clinicId, tx.clinicId), inArray(transactions.contactId, ids)))
    : [];
  const consents = phones.length
    ? await tx.db.select().from(consentRecords).where(and(eq(consentRecords.clinicId, tx.clinicId), inArray(consentRecords.phone, phones)))
    : [];
  const supp = phones.length
    ? await tx.db.select().from(suppressions).where(and(eq(suppressions.clinicId, tx.clinicId), inArray(suppressions.phone, phones)))
    : [];
  const attempts = phones.length
    ? await tx.db.select().from(contactAttempts).where(and(eq(contactAttempts.clinicId, tx.clinicId), inArray(contactAttempts.phone, phones)))
    : [];
  const bookings = ids.length
    ? (await tx.db.select().from(bookingRequests).where(and(eq(bookingRequests.clinicId, tx.clinicId), inArray(bookingRequests.contactId, ids)))).map(withoutDigest)
    : [];
  const conversationAmendments = await amendmentsFor(tx, "conversation", convos.map((c) => c.id));
  const bookingAmendments = await amendmentsFor(tx, "booking_request", bookings.map((b) => b.id));
  const appointmentAmendments = await amendmentsFor(tx, "appointment", appts.map((a) => a.id));
  const holds = ids.length
    ? await tx.db
        .select({ id: slotHolds.id, startsAt: slotHolds.startsAt, endsAt: slotHolds.endsAt, status: slotHolds.status, createdAt: slotHolds.createdAt })
        .from(slotHolds)
        .where(and(eq(slotHolds.clinicId, tx.clinicId), inArray(slotHolds.contactId, ids)))
    : [];
  const deposits = appts.length
    ? await tx.db
        .select(DEPOSIT_COLUMNS)
        .from(depositPayments)
        .where(and(eq(depositPayments.clinicId, tx.clinicId), inArray(depositPayments.appointmentId, appts.map((a) => a.id))))
    : [];

  const everyId = [
    ...ids,
    ...convos.map((c) => c.id),
    ...appts.map((a) => a.id),
    ...txns.map((t) => t.id),
    ...consents.map((c) => c.id),
    ...bookings.map((b) => b.id),
    ...[
      ...conversationAmendments.values(),
      ...bookingAmendments.values(),
      ...appointmentAmendments.values(),
    ]
      .flat()
      .map((a) => a.id),
    ...holds.map((h) => h.id),
    ...deposits.map((d) => d.id),
  ];
  const accounting = everyId.length
    ? await tx.db
        .select()
        .from(auditLog)
        .where(
          and(
            eq(auditLog.clinicId, tx.clinicId),
            or(
              inArray(auditLog.resourceId, everyId),
              sql`${auditLog.resourceIds} ?| array[${sql.join(everyId.map((v) => sql`${v}`), sql`, `)}]::text[]`,
            ),
          ),
        )
    : [];

  tx.audit.record({
    action: "export",
    resourceType: "patient_bundle",
    resourceIds: ids,
    resultCount: everyId.length,
    metadata: { requestedBy: query.requestedBy, rows: everyId.length },
  });

  return {
    producedAt: new Date().toISOString(),
    contacts: found,
    conversations: withAmendments(convos, conversationAmendments),
    appointments: withAmendments(appts, appointmentAmendments),
    transactions: txns,
    consentRecords: consents,
    suppressions: supp,
    contactAttempts: attempts,
    bookingRequests: withAmendments(bookings, bookingAmendments),
    depositPayments: deposits,
    slotHolds: holds,
    accountingOfDisclosures: accounting,
  };
}

/**
 * Amendment where the record can be changed: a real correction.
 *
 * BAA 1.3.0's clause 14(b): "healdesk corrects a person's contact details in
 * its own copy." A contact's name, number and address are those details, so
 * the row changes, and the audit row says which fields changed and who
 * asked, never what they said: a "prior" that carried the old name would
 * keep the wrong data the amendment exists to remove. The records healdesk
 * does not rewrite (a booking request, an appointment, a conversation) take
 * an appended amendment instead (lib/patient-rights/amendments.ts). The operator's path is
 * `npm run ops:amend-contact` in apps/app's own shell (lib/ops/patient-entry.ts),
 * never apps/web; the portal's comes with M5.
 */
export async function amendContact(
  tx: TenantTx,
  contactId: string,
  changes: { fullName?: string | null; phone?: string | null; email?: string | null },
  /** One of PATIENT_REQUESTERS: the audit row outlives the contact, so it holds nothing typed. */
  requestedBy: PatientRequester,
): Promise<boolean> {
  if (!isPatientRequester(requestedBy)) {
    throw new Error("Who asked is one of the closed set (PATIENT_REQUESTERS), never typed.");
  }
  const [before] = await tx.db
    .select({ id: contacts.id, fullName: contacts.fullName, phone: contacts.phone, email: contacts.email })
    .from(contacts)
    .where(and(eq(contacts.clinicId, tx.clinicId), eq(contacts.id, contactId)))
    .limit(1);
  if (!before) return false;
  await tx.db
    .update(contacts)
    .set({ ...changes, updatedAt: new Date() })
    .where(and(eq(contacts.clinicId, tx.clinicId), eq(contacts.id, contactId)));
  tx.audit.record({
    action: "update",
    resourceType: "contact_amendment",
    resourceId: contactId,
    metadata: {
      requestedBy,
      fields: Object.keys(changes).join(","),
      // Which fields changed, not what they were: a "prior" that carried the
      // old name would keep the wrong data the amendment exists to remove.
      changed: Object.entries(changes)
        .filter(([k, v]) => (before as Record<string, unknown>)[k] !== v)
        .map(([k]) => k)
        .join(","),
    },
  });
  return true;
}

/**
 * The whole tenant, for the BAA's return clause at offboarding: every patient
 * row the clinic's data holds and the complete audit trail beside it. Same
 * shape as one patient's bundle so the same reader handles both. Its own audit
 * row is written for the export, which is the last accounting the clinic gets.
 */
/**
 * Why a whole clinic's bundle was produced, for its audit row: the return at
 * offboarding (the operator's script), or the clinic's own download from the
 * portal's Conversations screen, which it may take at any time.
 */
export type ClinicExportPurpose = "offboarding_return" | "portal_download";

export async function exportClinic(
  tx: TenantTx,
  requestedBy: PatientRequester,
  purpose: ClinicExportPurpose = "offboarding_return",
): Promise<PatientBundle> {
  assertRequester(requestedBy);
  if (purpose !== "offboarding_return" && purpose !== "portal_download") {
    throw new Error("An export's purpose is one of the closed set (ClinicExportPurpose).");
  }
  const c = tx.clinicId;
  const found = await tx.db.select().from(contacts).where(eq(contacts.clinicId, c));
  const convos = await tx.db.select().from(conversations).where(eq(conversations.clinicId, c));
  const appts = await tx.db.select().from(appointments).where(eq(appointments.clinicId, c));
  const txns = await tx.db.select().from(transactions).where(eq(transactions.clinicId, c));
  const consents = await tx.db.select().from(consentRecords).where(eq(consentRecords.clinicId, c));
  const supp = await tx.db.select().from(suppressions).where(eq(suppressions.clinicId, c));
  const attempts = await tx.db.select().from(contactAttempts).where(eq(contactAttempts.clinicId, c));
  const bookings = (await tx.db.select().from(bookingRequests).where(eq(bookingRequests.clinicId, c))).map(withoutDigest);
  const conversationAmendments = await amendmentsFor(tx, "conversation", convos.map((v) => v.id));
  const bookingAmendments = await amendmentsFor(tx, "booking_request", bookings.map((b) => b.id));
  const appointmentAmendments = await amendmentsFor(tx, "appointment", appts.map((a) => a.id));
  const holds = await tx.db
    .select({ id: slotHolds.id, startsAt: slotHolds.startsAt, endsAt: slotHolds.endsAt, status: slotHolds.status, createdAt: slotHolds.createdAt })
    .from(slotHolds)
    .where(eq(slotHolds.clinicId, c));
  const deposits = await tx.db.select(DEPOSIT_COLUMNS).from(depositPayments).where(eq(depositPayments.clinicId, c));
  const accounting = await tx.db.select().from(auditLog).where(eq(auditLog.clinicId, c));
  // Clause 17's "an export of the patient information it holds": the raw
  // payloads can hold a vendor's transcript, which no other table does, and
  // canceled.ts promises the leaving practice "your export of conversation
  // records" (the calendar session's re-audit, C19, 12 October 2026). Since
  // 13 October 2026 healdesk keeps no transcript of its own: each is emailed
  // to the practice (lib/conversations/transcript-outbox.ts).
  const payloads = (
    await tx.db.select().from(webhookEvents).where(eq(webhookEvents.clinicId, c))
  ).map(payloadRecord);
  const threads = await tx.db
    .select({
      channel: chatThreads.channel,
      partyRef: chatThreads.partyRef,
      conversationStartedAt: chatThreads.conversationStartedAt,
      lastInboundAt: chatThreads.lastInboundAt,
      conversationsCount: chatThreads.conversationsCount,
    })
    .from(chatThreads)
    .where(eq(chatThreads.clinicId, c));
  const drafts = await tx.db.select().from(metaBookingDrafts).where(eq(metaBookingDrafts.clinicId, c));

  const rows = found.length + convos.length + appts.length + txns.length + consents.length + payloads.length;
  tx.audit.record({
    action: "export",
    resourceType: "clinic_bundle",
    resourceId: c,
    resultCount: rows,
    metadata: { requestedBy, rows, purpose },
  });

  return {
    producedAt: new Date().toISOString(),
    contacts: found,
    conversations: withAmendments(convos, conversationAmendments),
    appointments: withAmendments(appts, appointmentAmendments),
    transactions: txns,
    consentRecords: consents,
    suppressions: supp,
    contactAttempts: attempts,
    bookingRequests: withAmendments(bookings, bookingAmendments),
    depositPayments: deposits,
    slotHolds: holds,
    accountingOfDisclosures: accounting,
    rawPayloads: payloads,
    messagingThreads: threads,
    metaBookingDrafts: drafts,
  };
}

/** The desk's credential digest never leaves the row, even in a bundle the clinic asked for. */
function withoutDigest(row: typeof bookingRequests.$inferSelect): Omit<typeof bookingRequests.$inferSelect, "tokenHash"> {
  const { tokenHash: _digest, ...rest } = row;
  return rest;
}
