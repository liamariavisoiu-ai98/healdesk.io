import { CHANNELS, type Channel } from "@healdesk/catalog";
import { and, eq } from "drizzle-orm";

import { clinicChannels, type ChannelWaitingOn } from "@/db/schema";
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
 * the step is done or the channel is live.
 *
 * L11 and L12 (`handover`, `urgent`), a day after they were queued: "Please
 * check on them now" about a message a day old is wrong too. Nothing in the
 * outbox's own retries or its wait for Resend's daily quota holds one that
 * long; a backlog does, queued while the sender's switch was off (urgent
 * replies said nothing about the team then, urgentAlertLive) and released
 * all at once when it is turned on. Each conversation is still marked in
 * Conversations.
 *
 * Every other kind is about something that has already happened, and goes
 * regardless.
 */

/** How long an urgent alert or a handover may wait before it is closed unsent. */
export const STALE_ALERT_MS = 24 * 60 * 60 * 1000;

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
  at?: { createdAt: Date; now: Date },
): Promise<string | null> {
  if (kind === "urgent" || kind === "handover") {
    return at && at.now.getTime() - at.createdAt.getTime() > STALE_ALERT_MS
      ? "a day old; the conversation is marked in Conversations"
      : null;
  }
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
