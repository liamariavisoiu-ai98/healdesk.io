import { eq, sql } from "drizzle-orm";

import { unsafeDb } from "@/db";
import {
  appointments,
  clinicClosures,
  clinics,
  contacts,
  conversations,
  metaBookingDrafts,
  providerConnections,
  reconciliationExceptions,
  transactions,
  webhookEvents,
} from "@/db/schema";
import { recordSecurityEvent } from "@/lib/audit";
import { describeError, log } from "@/lib/log";
import { listClinics } from "@/lib/ops/clinics";
import type { TenantTx } from "@/lib/tenant";
import { withTenant } from "@/lib/tenant";

/**
 * Offboarding: the BAA's return-or-destroy clause, as two dates and a job.
 *
 * When a subscription ends (Stripe's customer.subscription.deleted, or an
 * operator), the clinic gets `offboarding_started_at` and a `destroy_after`
 * thirty days out. Two things happen in between, by a person: the agent is
 * switched off at the vendor and the clinic is told how to remove
 * forwarding (terms §7), and the export is produced and handed over —
 * `exportPatient()` per contact, or the per-clinic bundle the ops console
 * offers — which stamps `export_delivered_at`.
 *
 * Destruction runs from the daily job once `destroy_after` has passed AND
 * either the export was delivered or ninety days have elapsed (a clinic that
 * never collected its export does not get to keep us holding its patients
 * forever; the ninety days and the notices are documented in the handover).
 * It deletes every PHI row for the clinic and revokes its connections.
 * Booking requests go first, through app_destroy_booking_requests(), because
 * a confirmed one holds its appointment; the function refuses a clinic whose
 * offboarding did not start thirty days ago by the database's clock.
 *
 * So the dates are the database's. `offboarding_started_at`, `destroy_after`
 * and `destroyed_at` are stamped by app_start_offboarding() and
 * app_mark_clinic_destroyed(), from the database's clock, and the runtime
 * role has no UPDATE on them: if it could write the dates the delete function
 * reads, it could stamp a live clinic as due, empty its requests and put the
 * dates back. Tests that need thirty days to pass move the stamps back as the
 * migrator, which owns the table.
 *
 * What stays: the clinic row (a customer we had), the audit log
 * (append-only, and the record that the destruction happened), the signed
 * agreement (its own six-year floor), suppressions, consent records and
 * contact attempts (the TCPA evidence, on its own four-year clock), and the
 * billing history. That history includes channel_events, kept like
 * billing_notices: the plan start and every step-up were charged from its
 * rows, which hold no patient data. Deposit rows are money records too and
 * stay, without the appointment they were taken for.
 *
 * Of the tables 0044 added, clinic_closures (the days the clinic was closed)
 * goes with the patient rows. clinic_channels is classed with it but cannot
 * go yet: the runtime role holds no DELETE on it (a channel in service must
 * never drop out of the price), and destruction runs as that role. It holds
 * no patient data.
 *
 * Vendor-side data — recordings at Synthflow, the agent itself — is deleted
 * in the vendor console by the operator and noted on the security event;
 * this job cannot reach it and does not claim to.
 */
const DAY_MS = 24 * 60 * 60 * 1000;
/** The days app_start_offboarding() puts between the start and destroy_after; a test pins the two together. */
export const DESTROY_AFTER_DAYS = 30;
export const DESTROY_WITHOUT_EXPORT_AFTER_DAYS = 90;

/** Stamps the start and destroy_after from the database's clock, once; starting again moves neither. */
export async function startOffboarding(tx: TenantTx, reason: string): Promise<void> {
  await tx.db.execute(sql`select app_start_offboarding(${tx.clinicId}::uuid)`);
  tx.audit.record({ action: "update", resourceType: "clinic_offboarding", resourceId: tx.clinicId, metadata: { started: true, reason } });
}

export async function markExportDelivered(tx: TenantTx, how: string, now: Date = new Date()): Promise<void> {
  await tx.db.update(clinics).set({ exportDeliveredAt: now, updatedAt: now }).where(eq(clinics.id, tx.clinicId));
  tx.audit.record({ action: "export", resourceType: "clinic_offboarding", resourceId: tx.clinicId, metadata: { how: how.slice(0, 200) } });
}

export type DestructionResult = { clinicId: string; deleted: Record<string, number> };

/**
 * Every patient row for one clinic, booking requests included, and its
 * closed days, gone. Consent evidence, suppressions, audit, agreements and
 * billing stay.
 */
export async function destroyClinicData(tx: TenantTx): Promise<DestructionResult> {
  const c = tx.clinicId;
  const deleted: Record<string, number> = {};
  const del = async (name: string, run: () => Promise<{ id: string }[]>) => {
    deleted[name] = (await run()).length;
  };
  await del("reconciliation_exceptions", () => tx.db.delete(reconciliationExceptions).where(eq(reconciliationExceptions.clinicId, c)).returning({ id: reconciliationExceptions.id }));
  await del("transactions", () => tx.db.delete(transactions).where(eq(transactions.clinicId, c)).returning({ id: transactions.id }));
  // Booking requests before the appointments: a confirmed request must keep
  // its appointment (CHECK, 0039) and cannot be rewritten (trigger, 0041), so
  // its appointment cannot go while it stands, and waiting for the contact's
  // cascade (0037) never gets that far. The app role has no DELETE on them;
  // app_destroy_booking_requests() deletes this tenant's, once offboarding
  // started thirty days ago by the database's clock.
  const requests = await tx.db.execute<{ n: number }>(sql`select app_destroy_booking_requests(${c}::uuid) as n`);
  deleted.booking_requests = requests.rows[0]?.n ?? 0;
  await del("appointments", () => tx.db.delete(appointments).where(eq(appointments.clinicId, c)).returning({ id: appointments.id }));
  await del("conversations", () => tx.db.delete(conversations).where(eq(conversations.clinicId, c)).returning({ id: conversations.id }));
  // The half-collected drafts hold a phone number and nothing the record
  // needs, so they are deleted outright.
  await del("meta_booking_drafts", () => tx.db.delete(metaBookingDrafts).where(eq(metaBookingDrafts.clinicId, c)).returning({ id: metaBookingDrafts.senderId }));
  await del("contacts", () => tx.db.delete(contacts).where(eq(contacts.clinicId, c)).returning({ id: contacts.id }));
  await del("webhook_events", () => tx.db.delete(webhookEvents).where(eq(webhookEvents.clinicId, c)).returning({ id: webhookEvents.id }));
  // sync_runs and connection_links are append-only by grant (0015, 0024):
  // operational history with no patient in it, kept as the record of what
  // ran. The credentials go with the connection row below.
  // Credentials: revoked and their ciphertext gone with the row.
  await del("provider_connections", () => tx.db.delete(providerConnections).where(eq(providerConnections.clinicId, c)).returning({ id: providerConnections.id }));
  // Suppressions, consent records and contact attempts stay, by grant as
  // well as by choice: they are the evidence an outbound contact was lawful
  // and that "stop" was honoured, on the TCPA's four-year clock
  // (lib/retention/purge.ts says the same). The BAA permits retention the
  // law requires; the handover names it in the destruction notice.
  // The closed days go with the clinic; channel_events stays as billing
  // evidence (see the header).
  await del("clinic_closures", () => tx.db.delete(clinicClosures).where(eq(clinicClosures.clinicId, c)).returning({ id: clinicClosures.closedOn }));

  // The number is released with the data. destroyed_at is the database's
  // to stamp, and it refuses a clinic that is not due (see the header).
  await tx.db.update(clinics).set({ synthflowNumberE164: null }).where(eq(clinics.id, c));
  await tx.db.execute(sql`select app_mark_clinic_destroyed(${c}::uuid)`);
  const total = Object.values(deleted).reduce((a, b) => a + b, 0);
  tx.audit.record({
    action: "delete",
    resourceType: "clinic_destruction",
    resourceId: c,
    resultCount: total,
    metadata: Object.fromEntries(Object.entries(deleted).map(([k, v]) => [k, v])),
  });
  return { clinicId: c, deleted };
}

/** The daily job's selection rule, in one place so the test and the job agree. */
export function dueForDestruction(
  clinic: { offboardingStartedAt: Date | null; destroyAfter: Date | null; exportDeliveredAt: Date | null; destroyedAt: Date | null },
  now: Date,
): boolean {
  if (clinic.destroyedAt || !clinic.offboardingStartedAt || !clinic.destroyAfter) return false;
  if (now.getTime() < clinic.destroyAfter.getTime()) return false;
  if (clinic.exportDeliveredAt) return true;
  return now.getTime() - clinic.offboardingStartedAt.getTime() >= DESTROY_WITHOUT_EXPORT_AFTER_DAYS * DAY_MS;
}

export async function destroyDueClinics(now: Date = new Date()): Promise<DestructionResult[]> {
  const actor = { type: "service", serviceName: "offboarding-destroy" } as const;
  const results: DestructionResult[] = [];
  for (const clinic of await listClinics()) {
    if (!dueForDestruction(clinic, now)) continue;
    try {
      const result = await withTenant({ clinicId: clinic.id, actor }, (tx) => destroyClinicData(tx));
      await recordSecurityEvent(unsafeDb, {
        event: "clinic_data_destroyed",
        actorLabel: "offboarding-destroy",
        metadata: { clinicSlug: clinic.slug, rows: Object.values(result.deleted).reduce((a, b) => a + b, 0), exportDelivered: Boolean(clinic.exportDeliveredAt) },
      });
      results.push(result);
    } catch (error) {
      log.error("destruction failed", { clinicId: clinic.id, error: describeError(error) });
    }
  }
  return results;
}
