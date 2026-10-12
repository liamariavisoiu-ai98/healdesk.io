import { CHANNELS, type Channel } from "@healdesk/catalog";
import { and, eq, ne } from "drizzle-orm";

import { channelEvents, clinicChannels } from "@/db/schema";
import type { TenantTx } from "@/lib/tenant";

/**
 * Settings → Channels: a bought channel's own On/Off (spec, "Every switch in
 * the portal", Channels). Off stops AYA answering on that channel alone: the
 * answer gate (lib/billing/answering.ts) passes it through as `channel_off`,
 * so a call goes to the clinic's direct line, website chat shows its contact
 * form, and a Meta message waits for staff. Nothing is lost, and On puts it
 * back.
 *
 * The switch is `clinic_channels.enabled`, which the gate reads on every
 * answer, and each flip is a `channel_events` row naming the device that did
 * it, so the record of when a channel was off survives (it is billing
 * evidence: a channel in service stays in the price whatever its switch says,
 * lib/channels/state.ts). No step-up: the spec puts the step-up only where
 * calls and money go to a new place, and Off sends calls to the place the
 * clinic already chose. L15, the email a channel switched Off sends, is M6's.
 */

export class ChannelSwitchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChannelSwitchError";
  }
}

export function isChannel(value: unknown): value is Channel {
  return typeof value === "string" && (CHANNELS as readonly string[]).includes(value);
}

/**
 * Switch a bought channel On or Off. Returns whether anything changed; a
 * repeat of the switch already in place writes nothing. Refuses a channel
 * the clinic did not buy.
 */
export async function setChannelEnabled(
  tx: TenantTx,
  channel: Channel,
  enabled: boolean,
  actorLabel: string,
  now: Date = new Date(),
): Promise<{ changed: boolean }> {
  if (!isChannel(channel)) throw new ChannelSwitchError("That isn't one of your channels.");
  if (typeof enabled !== "boolean") throw new ChannelSwitchError("Choose on or off.");

  const updated = await tx.db
    .update(clinicChannels)
    .set({ enabled, updatedAt: now })
    .where(
      and(
        eq(clinicChannels.clinicId, tx.clinicId),
        eq(clinicChannels.channel, channel),
        ne(clinicChannels.enabled, enabled),
      ),
    )
    .returning({ channel: clinicChannels.channel });

  if (updated.length === 0) {
    const [row] = await tx.db
      .select({ enabled: clinicChannels.enabled })
      .from(clinicChannels)
      .where(and(eq(clinicChannels.clinicId, tx.clinicId), eq(clinicChannels.channel, channel)))
      .limit(1);
    if (!row) throw new ChannelSwitchError("That channel isn't part of your plan.");
    return { changed: false };
  }

  await tx.db.insert(channelEvents).values({
    clinicId: tx.clinicId,
    channel,
    kind: enabled ? "turned_on" : "turned_off",
    actor: actorLabel.slice(0, 200),
    occurredAt: now,
  });
  tx.audit.record({
    action: "update",
    resourceType: "clinic_channel",
    resourceId: tx.clinicId,
    metadata: { channel, enabled },
  });
  return { changed: true };
}
