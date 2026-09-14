import { and, eq } from "drizzle-orm";

import { appointments } from "@/db/schema";
import { describeError, log } from "@/lib/log";
import { listClinics } from "@/lib/ops/clinics";
import { getTransport, type EmailTransport } from "@/lib/reporting/deliver";
import { claimDelivery, listRecipients, recordDelivery } from "@/lib/reporting/recipients";
import { withTenant } from "@/lib/tenant";

/**
 * Live alerts, on two events only: the agent booked an appointment, and the
 * agent escalated a call to a human. Sent to the clinic's report recipients
 * with a count and a prompt — never a name, never a number, never a time,
 * because a shared front-desk inbox is not a place to put a patient. The
 * ledger keys on the conversation id, so a replayed webhook alerts once.
 *
 * Called from the voice webhook after ingestion, outside the ingest
 * transaction: an alert that fails must not undo a conversation row.
 */
export type AlertKind = "booked" | "escalated";

export async function sendLiveAlert(
  clinicId: string,
  kind: AlertKind,
  conversationId: string,
  transport?: EmailTransport,
): Promise<"sent" | "skipped" | "failed"> {
  const actor = { type: "service", serviceName: "live-alert" } as const;
  try {
    const clinic = (await listClinics()).find((c) => c.id === clinicId);
    if (!clinic || clinic.dataClassification !== "production") return "skipped";
    return await withTenant({ clinicId, actor }, async (tx) => {
      const recipients = await listRecipients(tx);
      if (recipients.length === 0) return "skipped";
      // The deposit fallback: the desk owes a call. A status, not an amount
      // and not a name.
      const [booking] =
        kind === "booked"
          ? await tx.db
              .select({ depositStatus: appointments.depositStatus })
              .from(appointments)
              .where(and(eq(appointments.clinicId, tx.clinicId), eq(appointments.conversationId, conversationId)))
              .limit(1)
          : [];
      const depositDue = booking?.depositStatus === "pending_front_desk";
      const subject =
        kind === "booked"
          ? `${clinic.name}: AYA just booked an appointment`
          : `${clinic.name}: a caller asked for a person`;
      const text =
        kind === "booked"
          ? `AYA booked a new appointment a moment ago. It is in your booking system now; open the console to see the call.\n` +
            (depositDue ? `A deposit is due on it. The caller was told the front desk will call to collect it, so that call is yours.\n` : "")
          : `A caller asked to speak with a person and AYA took a message. Please follow up from the console.\n`;
      let any = false;
      for (const recipient of recipients) {
        const claim = await claimDelivery(tx, { kind: "alert", periodKey: `${kind}:${conversationId}`, recipient: recipient.email });
        if (!claim) continue;
        const result = await (transport ?? getTransport("none")).send(
          { to: recipient.email, clinicId, clinicName: clinic.name },
          { subject, text, html: "", phiClass: "none" },
        );
        await recordDelivery(tx, claim, result.status === "sent" ? { status: "sent", messageId: result.messageId } : { status: result.status, reason: result.reason });
        if (result.status === "sent") any = true;
      }
      return any ? "sent" : "skipped";
    });
  } catch (error) {
    log.error("live alert failed", { clinicId, conversationId, error: describeError(error) });
    return "failed";
  }
}
