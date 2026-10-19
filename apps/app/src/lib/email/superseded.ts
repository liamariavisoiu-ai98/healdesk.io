import { CHANNELS, type Channel } from "@healdesk/catalog";
import { and, eq } from "drizzle-orm";

import { clinicChannels, clinics, type ChannelWaitingOn } from "@/db/schema";
import { pauseEmailSuperseded } from "@/lib/channels/pause";
import type { TenantTx } from "@/lib/tenant";

import type { NoticeKind } from "./kinds";

/**
 * Notices whose subject can be over before they go. The outbox asks here at
 * send time, after quiet hours have let the notice through and before it
 * claims a send, so an email queued in the evening and held until 07:00 is
 * not sent about a step the clinic finished overnight. A superseded notice is
 * closed unsent, like one whose optional switch is off.
 *
 * O10 (`channel_ready`): "{Channel} is ready: one step left" is wrong once
 * the step is done or the channel is live. And L15's reminder (`ai_paused`,
 * 24 hours into a pause with no end, or a channel left Off): wrong once AYA
 * is back on there (lib/channels/pause.ts). E4 and E5 (`export_ready`,
 * `export_reminder`): "Your export is ready" and "Download it by" are wrong
 * once a download or the operator's handover has recorded the export as
 * delivered, or once the data is destroyed (lib/offboarding/
 * after-cancellation.ts). Every other kind, the first L15 among them, is
 * about something that has already happened, and goes regardless.
 */

/** The one step O10 names for each channel that has its ready email. */
export const READY_STEP: Readonly<Partial<Record<Channel, ChannelWaitingOn>>> = {
  voice: "forwarding",
};

/** A channel is still waiting on the step O10 names: ready on our side, not live, that step open. */
export function isWaitingOnReadyStep(
  channel: Channel,
  row: { readyAt: Date | null; waitingOn: string | null; liveAt: Date | null } | undefined,
): boolean {
  const step = READY_STEP[channel];
  return Boolean(step && row?.readyAt && !row.liveAt && row.waitingOn === step);
}

/**
 * Why the notice no longer needs sending, for its `last_error`, or null when
 * it still does. Reads in the outbox's tenant transaction.
 */
export async function supersededReason(
  tx: TenantTx,
  kind: NoticeKind,
  payload: unknown,
): Promise<string | null> {
  if (kind === "ai_paused") return pauseEmailSuperseded(tx, payload);
  if (kind === "export_ready" || kind === "export_reminder") return exportNoticeSuperseded(tx);
  if (kind !== "channel_ready") return null;
  const channel = (payload as { channel?: unknown } | null)?.channel;
  if (typeof channel !== "string" || !(CHANNELS as readonly string[]).includes(channel)) {
    return null;
  }
  const [row] = await tx.db
    .select({
      readyAt: clinicChannels.readyAt,
      waitingOn: clinicChannels.waitingOn,
      liveAt: clinicChannels.liveAt,
    })
    .from(clinicChannels)
    .where(
      and(eq(clinicChannels.clinicId, tx.clinicId), eq(clinicChannels.channel, channel as Channel)),
    )
    .limit(1);
  return isWaitingOnReadyStep(channel as Channel, row)
    ? null
    : "the channel's last step was done before it could go";
}

/** E4 and E5 are moot once the export is delivered, or once there is nothing left to export. */
async function exportNoticeSuperseded(tx: TenantTx): Promise<string | null> {
  const [clinic] = await tx.db
    .select({ deliveredAt: clinics.exportDeliveredAt, destroyedAt: clinics.destroyedAt })
    .from(clinics)
    .where(eq(clinics.id, tx.clinicId))
    .limit(1);
  if (clinic?.destroyedAt) return "the clinic's data was destroyed before it could go";
  if (clinic?.deliveredAt) return "the export was delivered before it could go";
  return null;
}
