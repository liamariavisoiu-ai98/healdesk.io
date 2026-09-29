import { eq } from "drizzle-orm";

import { clinics } from "@/db/schema";
import { scheduleCallback, type ScheduleOutcome } from "@/lib/callbacks/schedule";
import { describeError, log } from "@/lib/log";
import { followUpLine, type BookingChannel } from "@/lib/meta/booking-requests";
import { sendMetaReply, type MetaChannelOwner, type MetaSender } from "@/lib/meta/channels";
import type { MetaPlatform } from "@/lib/meta/front-door";
import type { TenantTx } from "@/lib/tenant";

/**
 * Carrying the desk's alternatives to the person (design of 23 September
 * 2026, §C.2). First match wins:
 *
 *   1. Callbacks on for the clinic, the kill switch on, and a usable consent
 *      row → a consented `offer_alternatives` callback is queued; the
 *      assistant reads the times out and takes the choice (§C.3).
 *   2. Otherwise no automated contact: the desk calls, and the page says so.
 *
 * On a Meta thread, in either case and only inside Meta's 24-hour window,
 * the person also gets one fixed line that names no day, time or provider.
 * The line says the practice will go through the options by phone — which is
 * true in both branches — so it is the same text whether the phone is ours
 * or the desk's.
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
  /** The callback attempt: queued, or why not. */
  callback: ScheduleOutcome;
  /** The Meta line: sent, refused by the window, the thread gone, failed — or null for a phone request. */
  meta: "sent" | "failed" | "outside_window" | "no-channel" | null;
  /** True when no automated contact will carry the times: the page tells the desk to call. */
  deskCalls: boolean;
};

export async function planRescheduleOutreach(
  tx: TenantTx,
  request: RescheduleRequest,
  deps: { send?: MetaSender; now?: Date } = {},
): Promise<RescheduleOutreach> {
  const callback = await scheduleCallback(tx, request.id, "offer_alternatives", { now: deps.now });

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

  const outreach: RescheduleOutreach = { callback, meta, deskCalls: !callback.scheduled };
  tx.audit.record({
    action: "update",
    resourceType: "booking_request",
    resourceId: request.id,
    metadata: { outcome: "reschedule_outreach", callback: callback.scheduled ? "scheduled" : callback.reason, meta: meta ?? undefined, deskCalls: outreach.deskCalls },
  });
  return outreach;
}
