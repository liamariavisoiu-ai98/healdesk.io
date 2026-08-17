import type {
  CanonicalAppointment,
  CanonicalContact,
  CanonicalSale,
} from "@healdesk/connectors";
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";

import type { Transaction } from "@/db";
import { appointments, contacts, transactions } from "@/db/schema";

/**
 * Writing canonical records into our tables, idempotently.
 *
 * Sync is at-least-once by construction: pages get retried, webhooks arrive
 * twice, a run crashes halfway and starts again. So every write here is an
 * upsert keyed on (clinic, source system, the platform's own id), and running
 * the same sync twice must produce the same rows.
 *
 * The conflict targets are PARTIAL unique indexes — `where external_id is not
 * null` — because Postgres treats NULLs as distinct. Without the matching
 * `targetWhere`, the ON CONFLICT silently matches nothing and every re-sync
 * inserts duplicates. That failure is invisible until a monthly total is double
 * what it should be.
 */

/** Maps an adapter's arrival state onto our appointment status. */
function statusFor(arrival: CanonicalAppointment["arrival"]) {
  switch (arrival) {
    case "arrived":
      return "showed" as const;
    case "no_show":
      return "no_show" as const;
    case "cancelled":
      return "cancelled" as const;
    case "scheduled":
      return "scheduled" as const;
    case "unknown":
      // NOT "no_show". The platform cannot tell us, which is a different fact
      // from the patient not turning up, and conflating them under-reports
      // attendance for every clinic on a platform that lacks check-in.
      return "scheduled" as const;
  }
}

export async function upsertContacts(
  tx: Transaction,
  clinicId: string,
  source: string,
  items: CanonicalContact[],
): Promise<number> {
  if (items.length === 0) return 0;

  const rows = items.map((item) => ({
    clinicId,
    externalSource: source,
    externalContactId: item.externalId,
    phone: item.phone ?? null,
    email: item.email ?? null,
    fullName: item.fullName ?? null,
    updatedAt: new Date(),
  }));

  const written = await tx
    .insert(contacts)
    .values(rows)
    .onConflictDoUpdate({
      target: [contacts.clinicId, contacts.externalSource, contacts.externalContactId],
      targetWhere: isNotNull(contacts.externalContactId),
      set: {
        phone: sql`excluded.phone`,
        email: sql`excluded.email`,
        fullName: sql`excluded.full_name`,
        updatedAt: new Date(),
      },
    })
    .returning({ id: contacts.id });

  return written.length;
}

export async function upsertAppointments(
  tx: Transaction,
  clinicId: string,
  source: string,
  items: CanonicalAppointment[],
): Promise<number> {
  if (items.length === 0) return 0;

  // Resolve contact references in one query rather than per row.
  const contactIds = await resolveContacts(
    tx,
    clinicId,
    source,
    items.map((i) => i.contactExternalId).filter((id): id is string => !!id),
  );

  const rows = items
    .map((item) => {
      const contactId = item.contactExternalId
        ? contactIds.get(item.contactExternalId)
        : undefined;

      // appointments.contactId is NOT NULL, so an appointment whose contact we
      // haven't synced yet is skipped rather than forced. It will land on the
      // next run once contacts have caught up — dropping it is recoverable,
      // inventing a contact is not.
      if (!contactId) return null;

      return {
        clinicId,
        contactId,
        externalSource: source,
        externalAppointmentId: item.externalId,
        status: statusFor(item.arrival),
        scheduledFor: item.scheduledFor,
        checkedInAt: item.checkedInAt ?? null,
        treatment: item.treatment ?? null,
        providerName: item.providerName ?? null,
        depositUsd: item.depositUsd ?? null,
        updatedAt: new Date(),
      };
    })
    .filter((row): row is NonNullable<typeof row> => row !== null);

  if (rows.length === 0) return 0;

  const written = await tx
    .insert(appointments)
    .values(rows)
    .onConflictDoUpdate({
      target: [
        appointments.clinicId,
        appointments.externalSource,
        appointments.externalAppointmentId,
      ],
      targetWhere: isNotNull(appointments.externalAppointmentId),
      set: {
        status: sql`excluded.status`,
        scheduledFor: sql`excluded.scheduled_for`,
        checkedInAt: sql`excluded.checked_in_at`,
        treatment: sql`excluded.treatment`,
        providerName: sql`excluded.provider_name`,
        depositUsd: sql`excluded.deposit_usd`,
        updatedAt: new Date(),
      },
    })
    .returning({ id: appointments.id });

  return written.length;
}

export async function upsertSales(
  tx: Transaction,
  clinicId: string,
  source: string,
  items: CanonicalSale[],
): Promise<number> {
  if (items.length === 0) return 0;

  const contactIds = await resolveContacts(
    tx,
    clinicId,
    source,
    items.map((i) => i.contactExternalId).filter((id): id is string => !!id),
  );

  const appointmentIds = await resolveAppointments(
    tx,
    clinicId,
    source,
    items.map((i) => i.appointmentExternalId).filter((id): id is string => !!id),
  );

  const rows = items.map((item) => ({
    clinicId,
    // Nullable on purpose: a walk-in has no contact record, and a sale we
    // cannot attribute is a data-quality signal we want visible rather than a
    // row we drop.
    contactId: item.contactExternalId
      ? (contactIds.get(item.contactExternalId) ?? null)
      : null,
    appointmentId: item.appointmentExternalId
      ? (appointmentIds.get(item.appointmentExternalId) ?? null)
      : null,
    externalSource: source,
    externalTransactionId: item.externalId,
    amountUsd: item.amountUsd,
    lineItems: item.lineItems ?? null,
    collectedAt: item.collectedAt,
  }));

  const written = await tx
    .insert(transactions)
    .values(rows)
    .onConflictDoUpdate({
      target: [
        transactions.clinicId,
        transactions.externalSource,
        transactions.externalTransactionId,
      ],
      targetWhere: isNotNull(transactions.externalTransactionId),
      set: {
        amountUsd: sql`excluded.amount_usd`,
        lineItems: sql`excluded.line_items`,
        collectedAt: sql`excluded.collected_at`,
        // Only fill the appointment link, never clear it: the reconciler may
        // have matched this sale to a visit the platform doesn't know about,
        // and a later sync must not undo that.
        appointmentId: sql`coalesce(${transactions.appointmentId}, excluded.appointment_id)`,
        contactId: sql`coalesce(excluded.contact_id, ${transactions.contactId})`,
      },
    })
    .returning({ id: transactions.id });

  return written.length;
}

async function resolveContacts(
  tx: Transaction,
  clinicId: string,
  source: string,
  externalIds: string[],
): Promise<Map<string, string>> {
  const unique = [...new Set(externalIds)];
  if (unique.length === 0) return new Map();

  const rows = await tx
    .select({ id: contacts.id, externalId: contacts.externalContactId })
    .from(contacts)
    .where(
      and(
        eq(contacts.clinicId, clinicId),
        eq(contacts.externalSource, source),
        inArray(contacts.externalContactId, unique),
      ),
    );

  return new Map(
    rows
      .filter((r): r is { id: string; externalId: string } => !!r.externalId)
      .map((r) => [r.externalId, r.id]),
  );
}

async function resolveAppointments(
  tx: Transaction,
  clinicId: string,
  source: string,
  externalIds: string[],
): Promise<Map<string, string>> {
  const unique = [...new Set(externalIds)];
  if (unique.length === 0) return new Map();

  const rows = await tx
    .select({
      id: appointments.id,
      externalId: appointments.externalAppointmentId,
    })
    .from(appointments)
    .where(
      and(
        eq(appointments.clinicId, clinicId),
        eq(appointments.externalSource, source),
        inArray(appointments.externalAppointmentId, unique),
      ),
    );

  return new Map(
    rows
      .filter((r): r is { id: string; externalId: string } => !!r.externalId)
      .map((r) => [r.externalId, r.id]),
  );
}
