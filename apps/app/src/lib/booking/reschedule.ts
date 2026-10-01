import { eq } from "drizzle-orm";

import { clinics } from "@/db/schema";
import { describeError, log } from "@/lib/log";
import { followUpLine, type BookingChannel } from "@/lib/meta/booking-requests";
import { sendMetaReply, type MetaChannelOwner, type MetaSender } from "@/lib/meta/channels";
import type { MetaPlatform } from "@/lib/meta/front-door";
import type { TenantTx } from "@/lib/tenant";

/**
 * Carrying the desk's alternatives to the person (design of 23 September
 * 2026, §C.2, as narrowed by the v1 spec's "No outbound on any product").
 *
 * healdesk places no calls, so the desk goes through the times with the
 * person by phone itself, and the page says so. The 23 September design
 * also offered them on a consented call-back from the assistant; that path
 * was removed for v1.
 *
 * On a Meta thread, and only inside Meta's 24-hour window (which
 * sendMetaReply enforces), the person also gets one fixed line that names no
 * day, time or provider. The line says the practice will go through the
 * options by phone, which is what happens.
 */
export type RescheduleRequest = {
  id: string;
  channel: BookingChannel;
  platform: MetaPlatform | null;
  externalId: string | null;
  senderId: string | null;
  connectionId: string | null;
};

export type RescheduleOutreach = {
  /** The Meta line: sent, refused by the window, the thread gone, failed — or null for a phone request. */
  meta: "sent" | "failed" | "outside_window" | "no-channel" | null;
};

export async function planRescheduleOutreach(
  tx: TenantTx,
  request: RescheduleRequest,
  deps: { send?: MetaSender; now?: Date } = {},
): Promise<RescheduleOutreach> {
  let meta: RescheduleOutreach["meta"] = null;
  if (request.channel === "meta") {
    if (!request.connectionId || !request.platform || !request.externalId || !request.senderId) {
      meta = "no-channel";
    } else {
      const [clinic] = await tx.db.select({ name: clinics.name }).from(clinics).where(eq(clinics.id, tx.clinicId)).limit(1);
      const owner: MetaChannelOwner = { clinicId: tx.clinicId, connectionId: request.connectionId, platform: request.platform, enabled: true };
      try {
        const sent = await sendMetaReply(tx, owner, request.externalId, request.senderId, followUpLine(clinic?.name ?? "The practice", "rescheduling"), deps.send, { now: deps.now });
        meta = sent.status === "sent" ? "sent" : "outside_window";
        if (sent.status === "sent") {
          tx.audit.record({ action: "create", resourceType: "meta_front_door_reply", resourceId: tx.clinicId, metadata: { platform: request.platform, source: "booking_follow_up" } });
        }
      } catch (error) {
        log.error("reschedule line not sent", { clinicId: tx.clinicId, requestId: request.id, error: describeError(error) });
        meta = "failed";
      }
    }
  }

  const outreach: RescheduleOutreach = { meta };
  tx.audit.record({
    action: "update",
    resourceType: "booking_request",
    resourceId: request.id,
    metadata: { outcome: "reschedule_outreach", meta: meta ?? undefined, deskCalls: true },
  });
  return outreach;
}
