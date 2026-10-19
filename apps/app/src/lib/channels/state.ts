import { CHANNELS, type Channel } from "@healdesk/catalog";
import { and, eq } from "drizzle-orm";

import type { Transaction } from "@/db";
import {
  clinicChannels,
  clinics,
  clinicSettings,
  type ChannelWaitingOn,
  type ClinicChannelRow,
} from "@/db/schema";

/**
 * Where each of a clinic's channels stands: one reading of `clinic_channels`
 * and the header's pause, shared by the portal's status words, the answer
 * gate and billing (funnel and portal contracts §2, §7).
 *
 * `channelsInService` is what the price is made of, answered here and nowhere
 * else: a channel is in service from its first answer, whatever its Settings
 * switch says now, because a clinic that switches a live channel Off still
 * has it in its plan. `channelsReadyOnOurSide` is every channel we have
 * finished, whether live or still waiting on the clinic.
 *
 * Like lib/billing/entitlements.ts, the reader takes a `Transaction` and a
 * clinic id rather than a `TenantTx`, so provisioning's own transaction can
 * call it as well as a withTenant() block (pass `tx.db`). RLS filters the
 * statements to the declared tenant either way.
 */

/**
 * The key of the channel's status word: "Off", "Paused until …", "Live
 * since …", "Waiting on you: …", "Setting up".
 */
export type ChannelStatus = "off" | "paused" | "live" | "waiting" | "setting_up";

export type ChannelState = {
  channel: Channel;
  enabled: boolean;
  readyAt: Date | null;
  waitingOn: ChannelWaitingOn | null;
  liveAt: Date | null;
  firstAnswerAt: Date | null;
  /**
   * While the channel is paused, when the pause ends, or null for until it is
   * turned back on. Null when it is not paused.
   */
  pausedUntil: Date | null;
  status: ChannelStatus;
};

/** The header's pause, from clinic_settings. It is clinic-wide: every live channel stops. */
export type ClinicPause = { pausedAt: Date | null; pausedUntil: Date | null };

/** Whether the header's pause holds at `now`: set, and open-ended or not over yet. */
export function isPaused(pause: ClinicPause, now: Date): boolean {
  if (pause.pausedAt === null) return false;
  return pause.pausedUntil === null || pause.pausedUntil.getTime() > now.getTime();
}

/**
 * A channel's status, by these rules in order: switched Off is "off"; paused
 * and live is "paused"; live is "live"; ready on our side is "waiting" (on the
 * clinic); anything else is "setting_up". The pause shows only on a live
 * channel, because one that has not opened has nothing to pause.
 */
export function channelStatus(
  row: Pick<ClinicChannelRow, "enabled" | "readyAt" | "liveAt">,
  pause: ClinicPause,
  now: Date,
): ChannelStatus {
  if (!row.enabled) return "off";
  if (row.liveAt !== null && isPaused(pause, now)) return "paused";
  if (row.liveAt !== null) return "live";
  if (row.readyAt !== null) return "waiting";
  return "setting_up";
}

/**
 * Every channel the clinic bought, in the catalog's order, with its status at
 * `now`. A clinic with no clinic_settings row has the defaults: not paused.
 */
export async function readChannelStates(
  tx: Transaction,
  clinicId: string,
  now: Date = new Date(),
): Promise<ChannelState[]> {
  const rows = await tx.select().from(clinicChannels).where(eq(clinicChannels.clinicId, clinicId));
  const [settings] = await tx
    .select({ pausedAt: clinicSettings.aiPausedAt, pausedUntil: clinicSettings.aiPausedUntil })
    .from(clinicSettings)
    .where(eq(clinicSettings.clinicId, clinicId))
    .limit(1);
  const pause: ClinicPause = {
    pausedAt: settings?.pausedAt ?? null,
    pausedUntil: settings?.pausedUntil ?? null,
  };

  return rows
    .sort((a, b) => CHANNELS.indexOf(a.channel) - CHANNELS.indexOf(b.channel))
    .map((row) => {
      const status = channelStatus(row, pause, now);
      return {
        channel: row.channel,
        enabled: row.enabled,
        readyAt: row.readyAt,
        waitingOn: row.waitingOn,
        liveAt: row.liveAt,
        firstAnswerAt: row.firstAnswerAt,
        pausedUntil: status === "paused" ? pause.pausedUntil : null,
        status,
      };
    });
}

/** The channels the price is made of: each from its first answer, whatever its switch says now. */
export function channelsInService(states: readonly ChannelState[]): Channel[] {
  return states.filter((s) => s.firstAnswerAt !== null).map((s) => s.channel);
}

/** The channels ready on our side, whether live or still waiting on the clinic. */
export function channelsReadyOnOurSide(states: readonly ChannelState[]): Channel[] {
  return states.filter((s) => s.readyAt !== null).map((s) => s.channel);
}

/**
 * AYA's number, once phone is ready on our side for the clinic
 * (lib/channels/events.ts sets `ready_at`), and null until then: the number
 * and the forwarding steps are shown and sent on only once voice is ready,
 * so nobody forwards calls to an assistant that cannot answer yet (spec,
 * "The forwarding step, treated properly"). Null for a clinic that did not
 * buy phone.
 */
export async function readPhoneStepsNumber(tx: Transaction, clinicId: string): Promise<string | null> {
  const [row] = await tx
    .select({ readyAt: clinicChannels.readyAt, number: clinics.assistantNumberE164 })
    .from(clinicChannels)
    .innerJoin(clinics, eq(clinics.id, clinicChannels.clinicId))
    .where(and(eq(clinicChannels.clinicId, clinicId), eq(clinicChannels.channel, "voice")))
    .limit(1);
  return row?.readyAt && row.number ? row.number : null;
}
