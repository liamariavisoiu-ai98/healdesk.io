import { and, eq, isNull, sql } from "drizzle-orm";

import { reportDeliveries, reportRecipients, type ReportDeliveryKind } from "@/db/schema";
import type { TenantTx } from "@/lib/tenant";

/**
 * Who receives a clinic's mail, and the ledger of what was sent.
 *
 * The recipient list is the clinic's, not a user's: a report goes to the
 * front-desk inbox the clinic named, and a departed manager is removed here
 * without touching any account. The first recipient is the buyer, seeded at
 * provisioning.
 *
 * The ledger's unique index (clinic, kind, period, recipient) is the
 * idempotency: a run claims the row BEFORE sending, so a crash between claim
 * and send leaves a "failed" row the operator can see, the next run claims it
 * again and retries it, and a run after a successful send is a conflict
 * rather than a duplicate email. Since the email platform (Annex X3) the
 * ledger also records the outbox's sends and what Resend later said about
 * each one (delivery_status, written by lib/email/events.ts).
 */

export type Recipient = typeof reportRecipients.$inferSelect;

export async function listRecipients(tx: TenantTx): Promise<Recipient[]> {
  return tx.db
    .select()
    .from(reportRecipients)
    .where(and(eq(reportRecipients.clinicId, tx.clinicId), isNull(reportRecipients.unsubscribedAt)));
}

export async function addRecipient(
  tx: TenantTx,
  input: { email: string; label?: string; addedBy: string },
): Promise<void> {
  const email = input.email.trim().toLowerCase();
  await tx.db
    .insert(reportRecipients)
    .values({ clinicId: tx.clinicId, email, label: input.label ?? null, addedBy: input.addedBy })
    .onConflictDoUpdate({
      target: [reportRecipients.clinicId, reportRecipients.email],
      set: { unsubscribedAt: null, label: input.label ?? null },
    });
  // Who added it is a column on the row and the actor on this audit entry;
  // an email in metadata would trip the PHI scan, correctly.
  tx.audit.record({ action: "create", resourceType: "report_recipient", metadata: { seeded: input.addedBy === "provisioning" } });
}

export async function removeRecipient(tx: TenantTx, email: string, reason: string): Promise<boolean> {
  const rows = await tx.db
    .update(reportRecipients)
    .set({ unsubscribedAt: new Date() })
    .where(
      and(
        eq(reportRecipients.clinicId, tx.clinicId),
        eq(reportRecipients.email, email.trim().toLowerCase()),
        isNull(reportRecipients.unsubscribedAt),
      ),
    )
    .returning({ id: reportRecipients.id });
  if (rows.length) {
    tx.audit.record({ action: "update", resourceType: "report_recipient", resourceId: rows[0]!.id, metadata: { reason } });
  }
  return rows.length > 0;
}

/** A report kind, or an outbox kind: the ledger's CHECK (REPORT_DELIVERY_KINDS in db/schema.ts). */
export type DeliveryKind = ReportDeliveryKind;

const CLAIMED = "claimed; send not yet attempted";

/**
 * Claim the (clinic, kind, period, recipient) slot. Returns the row id when
 * this run owns the send, null when the slot has already been SENT.
 *
 * A slot claimed before and never sent is claimed again, and that is the fix
 * Annex X3 names. This used to be ON CONFLICT DO NOTHING, so the first claim
 * was the only one: a send that failed, or a crash between the claim and the
 * send, left a row saying "failed" that every later run skipped, and the
 * email never went. The conflict now re-claims any row whose status is not
 * 'sent', which is safe for each caller's own reason: the report mailers run
 * under runJob's lock, so no two runs claim at once, and the outbox holds a
 * lease on its notice and resends under the same idempotency key, so a
 * request that did reach Resend is answered with the first send's result.
 */
export async function claimDelivery(
  tx: TenantTx,
  input: { kind: DeliveryKind; periodKey: string; recipient: string },
): Promise<string | null> {
  const rows = await tx.db
    .insert(reportDeliveries)
    .values({
      clinicId: tx.clinicId,
      kind: input.kind,
      periodKey: input.periodKey,
      recipient: input.recipient,
      status: "failed",
      reason: CLAIMED,
    })
    .onConflictDoUpdate({
      target: [reportDeliveries.clinicId, reportDeliveries.kind, reportDeliveries.periodKey, reportDeliveries.recipient],
      set: { status: "failed", reason: CLAIMED, attemptedAt: new Date() },
      setWhere: sql`${reportDeliveries.status} <> 'sent'`,
    })
    .returning({ id: reportDeliveries.id });
  return rows[0]?.id ?? null;
}

export async function recordDelivery(
  tx: TenantTx,
  id: string,
  result: { status: "sent"; messageId: string } | { status: "skipped" | "failed"; reason: string },
): Promise<void> {
  await tx.db
    .update(reportDeliveries)
    .set(
      result.status === "sent"
        ? { status: "sent", messageId: result.messageId, reason: null, sentAt: new Date() }
        : { status: result.status, reason: result.reason.slice(0, 300) },
    )
    .where(eq(reportDeliveries.id, id));
}

/**
 * Has this kind gone to this clinic for this period, to every recipient a run
 * has claimed?
 *
 * True only when at least one row was sent and no row of the period is left
 * unsent. It used to be "any row sent", which skipped the whole clinic once
 * one recipient had it, so a second recipient whose send failed was never
 * retried: the same defect as the claim above, one level up.
 */
export async function deliveredAlready(
  tx: TenantTx,
  input: { kind: DeliveryKind; periodKey: string },
): Promise<boolean> {
  const [row] = await tx.db
    .select({
      sent: sql<number>`count(*) filter (where ${reportDeliveries.status} = 'sent')`.mapWith(Number),
      unsent: sql<number>`count(*) filter (where ${reportDeliveries.status} <> 'sent')`.mapWith(Number),
    })
    .from(reportDeliveries)
    .where(
      and(
        eq(reportDeliveries.clinicId, tx.clinicId),
        eq(reportDeliveries.kind, input.kind),
        eq(reportDeliveries.periodKey, input.periodKey),
      ),
    );
  return (row?.sent ?? 0) > 0 && (row?.unsent ?? 0) === 0;
}
