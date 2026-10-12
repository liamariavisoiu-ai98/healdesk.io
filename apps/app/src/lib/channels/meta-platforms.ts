import { and, eq, inArray } from "drizzle-orm";

import type { Transaction } from "@/db";
import { channelEvents, clinicChannels, clinicSettings, providerConnections } from "@/db/schema";
import type { MetaPlatform } from "@/lib/meta/front-door";
import { META_PROVIDERS } from "@/lib/meta/providers";
import type { TenantTx } from "@/lib/tenant";

import { ChannelSwitchError, setChannelEnabled } from "./switch";

/**
 * Settings → Channels: Instagram, Messenger and WhatsApp, each On or Off on
 * its own (spec, "Every switch in the portal": three rows, default On). The
 * clinic bought one Meta channel; it answers on three apps, and a clinic may
 * want AYA on Instagram while its team keeps WhatsApp.
 *
 * The switches are three clinic_settings columns (0061), On by default, so a
 * platform answers once it is connected. The webhook skips a message on a
 * platform that is Off before anything is claimed, counted or answered
 * (app_meta_channel's `platform_enabled`), and the person's message waits for
 * the clinic's team in the app, as it does when the whole channel is Off.
 *
 * They sit beneath the operator's front door (clinics.meta_front_door_enabled,
 * lib/meta/channels.ts), never instead of it: the front door carries the
 * release gates (a production clinic, a published number, a released
 * agreement), and a message is answered only when both are on.
 *
 * This is the switches' one writer. It keeps the Meta channel's own
 * clinic_channels.enabled in step (`syncMetaChannelSwitch`): On while any
 * CONNECTED platform's switch is On, Off once every connected one is Off,
 * through setChannelEnabled, so the answer gate, the status word and the
 * channel_events record that is billing evidence all keep reading the one
 * channel row they always have, and Home never calls the channel Live while
 * nothing connected answers. Connected, not all three: a clinic on Instagram
 * alone that switches Instagram Off has nothing answering, whatever the
 * unconnected Messenger switch says. Connecting a platform runs the same
 * step (attachMetaChannel), because a new connection answers by default.
 * Before anything is connected the channel is left as it is, so its status
 * keeps saying what the clinic still has to do.
 *
 * Each flip of a platform is a channel_events row of its own, on the Meta
 * channel, naming the platform in its detail and the device or person that
 * did it. No step-up, as for the channel switches: Off sends nobody anywhere
 * new.
 */

export const META_PLATFORMS: readonly MetaPlatform[] = ["instagram", "messenger", "whatsapp"];

/** The names patients use for them (spec, "No jargon"). */
export const META_PLATFORM_NAMES: Readonly<Record<MetaPlatform, string>> = {
  instagram: "Instagram",
  messenger: "Messenger",
  whatsapp: "WhatsApp",
};

export type MetaPlatformSwitches = Record<MetaPlatform, boolean>;

/** The columns' default: the spec's. A clinic with no clinic_settings row has these. */
export const DEFAULT_META_PLATFORM_SWITCHES: Readonly<MetaPlatformSwitches> = Object.freeze({
  instagram: true,
  messenger: true,
  whatsapp: true,
});

const COLUMNS = {
  instagram: clinicSettings.instagramEnabled,
  messenger: clinicSettings.messengerEnabled,
  whatsapp: clinicSettings.whatsappEnabled,
} as const;

const FIELDS = {
  instagram: "instagramEnabled",
  messenger: "messengerEnabled",
  whatsapp: "whatsappEnabled",
} as const;

/** Read the clinic's three switches. Takes a Transaction, so a withTenant() block passes `tx.db`. */
export async function readMetaPlatformSwitches(
  db: Transaction,
  clinicId: string,
): Promise<MetaPlatformSwitches> {
  const [row] = await db
    .select({ instagram: COLUMNS.instagram, messenger: COLUMNS.messenger, whatsapp: COLUMNS.whatsapp })
    .from(clinicSettings)
    .where(eq(clinicSettings.clinicId, clinicId))
    .limit(1);
  return row ?? { ...DEFAULT_META_PLATFORM_SWITCHES };
}

/**
 * The platforms the clinic has connected: a Meta connection that is active,
 * or pending as a Facebook login leaves it (the statuses app_meta_channel
 * answers on). Provider names and statuses only; no credential is opened.
 */
export async function connectedMetaPlatforms(db: Transaction, clinicId: string): Promise<MetaPlatform[]> {
  const rows = await db
    .select({ provider: providerConnections.provider })
    .from(providerConnections)
    .where(
      and(
        eq(providerConnections.clinicId, clinicId),
        inArray(providerConnections.provider, Object.values(META_PROVIDERS)),
        inArray(providerConnections.status, ["active", "pending"]),
      ),
    );
  const providers = new Set(rows.map((r) => r.provider));
  return META_PLATFORMS.filter((p) => providers.has(META_PROVIDERS[p]));
}

export function isMetaPlatformName(value: unknown): value is MetaPlatform {
  return typeof value === "string" && (META_PLATFORMS as readonly string[]).includes(value);
}

/**
 * Switch one platform On or Off. Returns whether anything changed; a repeat
 * of the switch already in place writes nothing. The Meta channel's own
 * switch follows in the same transaction: Off once all three are, On again
 * with the first.
 */
export async function setMetaPlatformEnabled(
  tx: TenantTx,
  platform: MetaPlatform,
  enabled: boolean,
  actorLabel: string,
  now: Date = new Date(),
): Promise<{ changed: boolean; switches: MetaPlatformSwitches }> {
  if (!isMetaPlatformName(platform)) throw new ChannelSwitchError("That isn't one of your channels.");
  if (typeof enabled !== "boolean") throw new ChannelSwitchError("Choose on or off.");

  const column = COLUMNS[platform];
  const returning = { instagram: COLUMNS.instagram, messenger: COLUMNS.messenger, whatsapp: COLUMNS.whatsapp };
  // The UPDATE takes the row's lock and returns all three as they now stand,
  // so two platforms switched at once are counted against each other, never
  // against a stale read.
  let [after] = await tx.db
    .update(clinicSettings)
    .set({ [FIELDS[platform]]: enabled, updatedAt: now })
    .where(and(eq(clinicSettings.clinicId, tx.clinicId), eq(column, !enabled)))
    .returning(returning);

  if (!after) {
    const current = await readMetaPlatformSwitches(tx.db, tx.clinicId);
    if (current[platform] === enabled) return { changed: false, switches: current };
    // No row yet, and the change is away from the default: write the row.
    [after] = await tx.db
      .insert(clinicSettings)
      .values({ clinicId: tx.clinicId, [FIELDS[platform]]: enabled, updatedAt: now })
      .onConflictDoUpdate({ target: clinicSettings.clinicId, set: { [FIELDS[platform]]: enabled, updatedAt: now } })
      .returning(returning);
  }
  const switches: MetaPlatformSwitches = after!;

  await tx.db.insert(channelEvents).values({
    clinicId: tx.clinicId,
    channel: "meta",
    kind: enabled ? "turned_on" : "turned_off",
    actor: actorLabel.slice(0, 200),
    detail: { platform },
    occurredAt: now,
  });
  tx.audit.record({
    action: "update",
    resourceType: "clinic_meta_platform",
    resourceId: tx.clinicId,
    metadata: { platform, enabled },
  });

  await syncMetaChannelSwitch(tx, actorLabel, now, switches);
  return { changed: true, switches };
}

/**
 * Bring the Meta channel's own switch in step with its platforms': On while
 * any connected platform's switch is On, Off once every connected one is
 * Off. Nothing to do before a platform is connected, or for a clinic with no
 * Meta channel row (one the operator connected before the portal). A flip is
 * recorded by setChannelEnabled under `actorLabel`.
 */
export async function syncMetaChannelSwitch(
  tx: TenantTx,
  actorLabel: string,
  now: Date = new Date(),
  switches?: MetaPlatformSwitches,
): Promise<void> {
  const connected = await connectedMetaPlatforms(tx.db, tx.clinicId);
  if (connected.length === 0) return;
  const current = switches ?? (await readMetaPlatformSwitches(tx.db, tx.clinicId));
  const wanted = connected.some((p) => current[p]);
  const [channel] = await tx.db
    .select({ enabled: clinicChannels.enabled })
    .from(clinicChannels)
    .where(and(eq(clinicChannels.clinicId, tx.clinicId), eq(clinicChannels.channel, "meta")))
    .limit(1);
  if (channel && channel.enabled !== wanted) {
    await setChannelEnabled(tx, "meta", wanted, actorLabel, now);
  }
}

/** Whether the clinic's switch for this platform is On, inside its tenant. */
export async function metaPlatformOn(tx: TenantTx, platform: MetaPlatform): Promise<boolean> {
  return (await readMetaPlatformSwitches(tx.db, tx.clinicId))[platform];
}
