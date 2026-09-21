import { and, eq, inArray, or, sql } from "drizzle-orm";

import {
  appointments,
  auditLog,
  bookingRequests,
  consentRecords,
  contactAttempts,
  contacts,
  conversations,
  suppressions,
  transactions,
} from "@/db/schema";
import type { TenantTx } from "@/lib/tenant";

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
 * Operator-only, on purpose. The covered entity validates the request; we
 * produce the bundle. Never a self-serve clinic feature.
 */
export type PatientBundle = {
  producedAt: string;
  contacts: (typeof contacts.$inferSelect)[];
  conversations: (typeof conversations.$inferSelect)[];
  appointments: (typeof appointments.$inferSelect)[];
  transactions: (typeof transactions.$inferSelect)[];
  consentRecords: (typeof consentRecords.$inferSelect)[];
  suppressions: (typeof suppressions.$inferSelect)[];
  contactAttempts: (typeof contactAttempts.$inferSelect)[];
  /** Requests made on a Meta channel and handed to the desk; the token digest is not included. */
  bookingRequests: Omit<typeof bookingRequests.$inferSelect, "tokenHash">[];
  /** Every audit row that touched any of the ids above: the accounting of disclosures. */
  accountingOfDisclosures: (typeof auditLog.$inferSelect)[];
};

export async function exportPatient(
  tx: TenantTx,
  query: { phone?: string; email?: string; requestedBy: string },
): Promise<PatientBundle> {
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

  const everyId = [
    ...ids,
    ...convos.map((c) => c.id),
    ...appts.map((a) => a.id),
    ...txns.map((t) => t.id),
    ...consents.map((c) => c.id),
    ...bookings.map((b) => b.id),
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
    conversations: convos,
    appointments: appts,
    transactions: txns,
    consentRecords: consents,
    suppressions: supp,
    contactAttempts: attempts,
    bookingRequests: bookings,
    accountingOfDisclosures: accounting,
  };
}

/**
 * Amendment: a real correction, with the prior value in the audit trail.
 *
 * The clause promises the copy is corrected, not annotated. So the row
 * changes, and what it used to say is recorded on the audit row's metadata
 * — which is itself PHI-scanned, so the prior value is stored under a key
 * the scanner allows, as a hash and a length, not the text. The text of the
 * old value lives nowhere after this: that is the point of amending.
 */
export async function amendContact(
  tx: TenantTx,
  contactId: string,
  changes: { fullName?: string | null; phone?: string | null; email?: string | null },
  requestedBy: string,
): Promise<boolean> {
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
export async function exportClinic(tx: TenantTx, requestedBy: string): Promise<PatientBundle> {
  const c = tx.clinicId;
  const found = await tx.db.select().from(contacts).where(eq(contacts.clinicId, c));
  const convos = await tx.db.select().from(conversations).where(eq(conversations.clinicId, c));
  const appts = await tx.db.select().from(appointments).where(eq(appointments.clinicId, c));
  const txns = await tx.db.select().from(transactions).where(eq(transactions.clinicId, c));
  const consents = await tx.db.select().from(consentRecords).where(eq(consentRecords.clinicId, c));
  const supp = await tx.db.select().from(suppressions).where(eq(suppressions.clinicId, c));
  const attempts = await tx.db.select().from(contactAttempts).where(eq(contactAttempts.clinicId, c));
  const bookings = (await tx.db.select().from(bookingRequests).where(eq(bookingRequests.clinicId, c))).map(withoutDigest);
  const accounting = await tx.db.select().from(auditLog).where(eq(auditLog.clinicId, c));

  const rows = found.length + convos.length + appts.length + txns.length + consents.length;
  tx.audit.record({
    action: "export",
    resourceType: "clinic_bundle",
    resourceId: c,
    resultCount: rows,
    metadata: { requestedBy, rows, purpose: "offboarding_return" },
  });

  return {
    producedAt: new Date().toISOString(),
    contacts: found,
    conversations: convos,
    appointments: appts,
    transactions: txns,
    consentRecords: consents,
    suppressions: supp,
    contactAttempts: attempts,
    bookingRequests: bookings,
    accountingOfDisclosures: accounting,
  };
}

/** The desk's credential digest never leaves the row, even in a bundle the clinic asked for. */
function withoutDigest(row: typeof bookingRequests.$inferSelect): Omit<typeof bookingRequests.$inferSelect, "tokenHash"> {
  const { tokenHash: _digest, ...rest } = row;
  return rest;
}
