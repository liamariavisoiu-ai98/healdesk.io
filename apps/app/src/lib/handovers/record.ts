import { toE164 } from "@healdesk/connectors";
import { and, eq, isNotNull, isNull, or, sql } from "drizzle-orm";

import { conversations, handovers, type HandoverPlatform } from "@/db/schema";
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
 * web chat the number the visitor gave for the call back (attachHandoverCaller). A call's
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
 * Held on the handover itself, never as a contact and never on the
 * conversation (reviews of 19 October 2026): the number is whatever the
 * visitor typed, so a contact would be found by every later lookup by that
 * number (a patient's next call, booking or request) and could carry the
 * stranger's name onto it; and a conversation a later request in the chat
 * ties to someone else could not go with this person's erasure. Erasure by
 * the number deletes it (lib/patient-rights/erasure.ts). Called each message
 * while the chat has an open handover; a no-op once it has its number.
 * Never throws.
 */
export async function attachHandoverCaller(
  tx: TenantTx,
  input: { conversationId: string; capture: Pick<BookingCapture, "firstName" | "phone"> },
): Promise<void> {
  const phone = typeof input.capture.phone === "string" && input.capture.phone.length <= 32 ? toE164(input.capture.phone) : null;
  if (!phone) return;
  try {
    await tx.db.transaction(async (savepoint) => {
      await savepoint
        .update(handovers)
        .set({ callbackPhone: phone, callbackFirstName: cleanFirstName(input.capture.firstName) })
        .where(
          and(
            eq(handovers.clinicId, tx.clinicId),
            eq(handovers.channel, "web_chat"),
            eq(handovers.conversationId, input.conversationId),
            isNull(handovers.callbackPhone),
          ),
        );
    });
  } catch (error) {
    try {
      log.error("handover caller not attached", { clinicId: tx.clinicId, error: describeError(error) });
    } catch {
      // As above.
    }
  }
}

/**
 * Link each call's handover to the call's conversation where the database's
 * own link missed it: a handover raised in the instant the call's row was
 * written sees neither the row nor is seen by its trigger (drizzle/0085). Run
 * before anything that relies on the link to reach a handover through its
 * conversation: a person's erasure and export, and the retention purge.
 * Returns how many it linked.
 */
export async function linkCallHandovers(tx: TenantTx): Promise<number> {
  const call = sql`(select v.id from ${conversations} v
                     where v.clinic_id = ${handovers.clinicId}
                       and v.external_call_id = ${handovers.externalCallId})`;
  const linked = await tx.db
    .update(handovers)
    .set({ conversationId: sql`${call}` })
    .where(
      and(
        eq(handovers.clinicId, tx.clinicId),
        eq(handovers.channel, "voice"),
        isNull(handovers.conversationId),
        sql`exists ${call}`,
      ),
    )
    .returning({ id: handovers.id });
  return linked.length;
}

/**
 * The web chat handover an id names, by the handover's own id or its chat's
 * conversation id (the address the practice sees in its portal): how an
 * erasure or an export names someone who only asked for a person and left a
 * number, whom no contact holds. Null for any other id.
 *
 * Named this way, the request reaches that one handover and its chat and
 * nothing found by the number: the number is whatever the visitor typed, so
 * it may be a patient's own, another visitor's, or a WhatsApp sender's, and
 * following it would export or erase them (reviews of 19 October 2026).
 */
export async function namedHandover(tx: TenantTx, id: string): Promise<{ handoverId: string } | null> {
  const [row] = await tx.db
    .select({ id: handovers.id })
    .from(handovers)
    .where(
      and(
        eq(handovers.clinicId, tx.clinicId),
        eq(handovers.channel, "web_chat"),
        isNotNull(handovers.callbackPhone),
        or(eq(handovers.id, id), eq(handovers.conversationId, id)),
      ),
    )
    .limit(1);
  return row ? { handoverId: row.id } : null;
}
