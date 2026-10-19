import { toE164 } from "@healdesk/connectors";
import { and, eq, isNull } from "drizzle-orm";

import { contacts, conversations, handovers, type HandoverPlatform } from "@/db/schema";
import type { BookingCapture } from "@/lib/assistant/turn";
import { describeError, log } from "@/lib/log";
import { cleanFirstName } from "@/lib/meta/booking-requests";
import { notifyBookingAlert } from "@/lib/notices/booking-alerts";
import type { TenantTx } from "@/lib/tenant";

/**
 * Someone asked AYA for a person (L11): the handover row Bookings lists
 * under Needs you until the desk marks it handled (plan Part F5, "open
 * handovers"), and the alert, in the caller's transaction, once per call,
 * web chat or Meta conversation.
 *
 * The row holds no words (drizzle/0085): only which conversation it was
 * asked in, through which the person is reached, kept and erased, and for a
 * web chat the number the visitor gave (attachHandoverCaller). A call's
 * conversation is written when the call ends, so a call's handover carries
 * the call id and the database links it then.
 *
 * Meta: only the front door's model answer raises one, and the model never
 * sees a message the inbound screen refused (lib/meta/front-door.ts), so
 * nothing clinical is behind a Meta handover; and nothing the person wrote is
 * kept here on any channel.
 *
 * Never throws, and never breaks the caller's transaction: the insert runs in
 * a savepoint, so a failure rolls back only itself and the conversation is
 * still recorded and the alert still queued.
 */
export type HandoverRef =
  | { channel: "voice"; callId: string }
  | { channel: "web_chat"; conversationId: string }
  | { channel: "meta"; platform: HandoverPlatform; partyRef: string; metaConversationId: string };

export async function raiseHandover(tx: TenantTx, ref: HandoverRef): Promise<void> {
  try {
    await tx.db.transaction(async (savepoint) => {
      const values =
        ref.channel === "voice"
          ? {
              clinicId: tx.clinicId,
              channel: "voice" as const,
              externalCallId: ref.callId.slice(0, 200),
              // A call already written (a retried ingest) takes it at once.
              conversationId: await callConversation(savepoint, tx.clinicId, ref.callId),
            }
          : ref.channel === "web_chat"
            ? { clinicId: tx.clinicId, channel: "web_chat" as const, conversationId: ref.conversationId }
            : {
                clinicId: tx.clinicId,
                channel: "meta" as const,
                platform: ref.platform,
                partyRef: ref.partyRef,
                metaConversationId: ref.metaConversationId,
              };
      const [row] = await savepoint
        .insert(handovers)
        .values(values)
        .onConflictDoNothing()
        .returning({ id: handovers.id });
      if (row) {
        tx.audit.record({
          action: "create",
          resourceType: "handover",
          resourceId: row.id,
          metadata: { channel: ref.channel },
        });
      }
    });
  } catch (error) {
    try {
      log.error("handover not recorded", { clinicId: tx.clinicId, channel: ref.channel, error: describeError(error) });
    } catch {
      // Nothing reaches the caller; see above.
    }
  }
  // L11, a pointer, whatever became of the row: the clinic is told either way.
  await notifyBookingAlert(
    tx,
    "handover",
    ref.channel === "voice"
      ? { callId: ref.callId, channel: "voice" }
      : ref.channel === "web_chat"
        ? { conversationId: ref.conversationId, channel: "web" }
        : { conversationId: ref.metaConversationId, channel: "meta" },
  );
}

async function callConversation(db: TenantTx["db"], clinicId: string, callId: string): Promise<string | null> {
  const [row] = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(and(eq(conversations.clinicId, clinicId), eq(conversations.externalCallId, callId)))
    .limit(1);
  return row?.id ?? null;
}

/**
 * A web chat's handover, once the visitor has given a number: the desk needs
 * one to call them back, and AYA asks for a first name and a number when
 * someone wants a person (lib/assistant/prompt.ts). Only a number that is a
 * number (toE164) and a name that passes the first-name screen; nothing else
 * of the chat.
 *
 * Kept as a contact of the handover's own, never on the conversation and
 * never an existing contact found by the number (review of 19 October 2026):
 * the number is whatever the visitor typed, so reusing a patient's contact
 * would show their name on a stranger's handover and put the stranger's
 * conversation in that patient's export and erasure; and a conversation a
 * later request's appointment points at could not go with this person's
 * erasure. The contact takes the handover with it when it goes (erasure by
 * the number, the record clock). Called each message while the chat has an
 * open handover; a no-op once the handover has its contact. Never throws.
 */
export async function attachHandoverCaller(
  tx: TenantTx,
  input: { conversationId: string; capture: Pick<BookingCapture, "firstName" | "phone">; timeZone: string },
): Promise<void> {
  const phone = typeof input.capture.phone === "string" && input.capture.phone.length <= 32 ? toE164(input.capture.phone) : null;
  if (!phone) return;
  try {
    await tx.db.transaction(async (savepoint) => {
      const [open] = await savepoint
        .select({ id: handovers.id })
        .from(handovers)
        .where(
          and(
            eq(handovers.clinicId, tx.clinicId),
            eq(handovers.channel, "web_chat"),
            eq(handovers.conversationId, input.conversationId),
            isNull(handovers.contactId),
          ),
        )
        .limit(1);
      if (!open) return;
      const [contact] = await savepoint
        .insert(contacts)
        .values({
          clinicId: tx.clinicId,
          phone,
          fullName: cleanFirstName(input.capture.firstName),
          timezone: input.timeZone,
          updatedAt: new Date(),
        })
        .returning({ id: contacts.id });
      await savepoint
        .update(handovers)
        .set({ contactId: contact!.id })
        .where(and(eq(handovers.clinicId, tx.clinicId), eq(handovers.id, open.id), isNull(handovers.contactId)));
    });
  } catch (error) {
    try {
      log.error("handover caller not attached", { clinicId: tx.clinicId, error: describeError(error) });
    } catch {
      // As above.
    }
  }
}
