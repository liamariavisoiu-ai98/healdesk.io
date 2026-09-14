import { and, eq, isNull } from "drizzle-orm";

import { reportDeliveries, reportRecipients } from "@/db/schema";
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
 * and send leaves a "failed" row the operator can see, and a second run of
 * the same period is a conflict rather than a duplicate email.
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

export type DeliveryKind = "monthly" | "weekly" | "alert" | "renewal";

/**
 * Claim the (clinic, kind, period, recipient) slot. Returns the row id when
 * this run owns the send, null when a previous run already did.
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
      reason: "claimed; send not yet attempted",
    })
    .onConflictDoNothing({
      target: [reportDeliveries.clinicId, reportDeliveries.kind, reportDeliveries.periodKey, reportDeliveries.recipient],
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

/** Has anything of this kind gone to this clinic for this period already? */
export async function deliveredAlready(
  tx: TenantTx,
  input: { kind: DeliveryKind; periodKey: string },
): Promise<boolean> {
  const [row] = await tx.db
    .select({ id: reportDeliveries.id })
    .from(reportDeliveries)
    .where(
      and(
        eq(reportDeliveries.clinicId, tx.clinicId),
        eq(reportDeliveries.kind, input.kind),
        eq(reportDeliveries.periodKey, input.periodKey),
        eq(reportDeliveries.status, "sent"),
      ),
    )
    .limit(1);
  return Boolean(row);
}
