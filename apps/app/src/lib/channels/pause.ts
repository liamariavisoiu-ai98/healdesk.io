import { CHANNELS, type Channel } from "@healdesk/catalog";
import { and, eq, gt, isNotNull, isNull, sql } from "drizzle-orm";

import { unsafeDb } from "@/db";
import {
  agreementResigns,
  channelEvents,
  clinicChannels,
  clinics,
  clinicSettings,
} from "@/db/schema";
import type { ActorContext } from "@/lib/audit";
import {
  getClinicSettings,
  updateClinicSettings,
  type ClinicSettings,
  type ClinicSettingsPatch,
} from "@/lib/billing/settings";
import { isAllowedDeviceName } from "@/lib/email/lint";
import type { AiPausedPayload } from "@/lib/email/templates/ai_paused";
import { describeError, log } from "@/lib/log";
import type { MetaPlatform } from "@/lib/meta/front-door";
import { enqueuePlanNotice } from "@/lib/notices/plan-notices";
import { publicOriginProblem, publicUrl } from "@/lib/public-url";
import { withTenant, type TenantTx } from "@/lib/tenant";

import { readMetaPlatformSwitches } from "./meta-platforms";
import {
  isPauseChoice,
  PAUSE_LINE_ORDER,
  pauseEmailsClinic,
  pauseEndFor,
  type PauseChoice,
} from "./pause-words";
import { isPaused, type ClinicPause } from "./state";

/**
 * Pause AI (plan Part F0; spec, "Every switch in the portal"): the header's
 * "AYA is answering" switch, and what a pause leaves behind.
 *
 * The pause itself is three clinic_settings columns, written by
 * healdesk-io-58's `updateClinicSettings` (lib/billing/settings.ts), the one
 * writer, and read by the answer gate on every call, chat and message
 * (lib/billing/answering.ts refuses with `ai_paused` while `isPaused` holds:
 * a call goes to the direct line, website chat shows its contact form, a
 * Meta message waits for the team). This module calls that writer and adds,
 * in the same transaction:
 *
 *   - **the record.** A `paused` channel_events row when a pause begins and a
 *     `resumed` row when it ends, clinic-wide (no channel), naming the device.
 *     They are the pause windows the guarantee and billing evidence read
 *     (plan, "channel_events: … pause windows"), so each pause gets exactly
 *     one `resumed`, keyed by when the pause began (`detail.pausedAt`): at
 *     once when it is switched back on, and at its own end, written by the
 *     hourly sweep (`sweepEndedPauses`) or by the next pause or resume,
 *     whichever comes first, when it ends by itself;
 *   - **L15** (lib/email/templates/ai_paused.ts): for a pause until tomorrow
 *     or with no end, never one for an hour (`pauseEmailsClinic`), and a
 *     reminder 24 hours into one with no end, queued now with that delay and
 *     closed unsent at its due time if AYA was back on by then
 *     (`pauseEmailSuperseded`, through lib/email/superseded.ts). The same for
 *     a live channel switched Off in Settings, which counts as a pause with
 *     no end for that channel (`noteChannelSwitchedOff`).
 *
 * Every write of the pause takes one advisory lock per clinic first
 * (`lockPause`), so the header, the console and the sweep are taken one
 * after another, and "has this pause its `resumed` row yet?" is never
 * answered by two of them at once.
 *
 * Tenant plane, no patient data: times, channel ids and a device's name.
 */

/** A pause with no end gets its second L15 this long after it began. */
export const PAUSE_REMINDER_MS = 24 * 60 * 60 * 1000;

/** Why a pause or resume was refused, worded for the person who asked. */
export class PauseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PauseError";
  }
}

function pauseOf(settings: Pick<ClinicSettings, "aiPausedAt" | "aiPausedUntil">): ClinicPause {
  return { pausedAt: settings.aiPausedAt, pausedUntil: settings.aiPausedUntil };
}

/** Hold the clinic's pause until the transaction ends. Taking it twice in one transaction is harmless. */
async function lockPause(tx: TenantTx): Promise<void> {
  await tx.db.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`ai-pause:${tx.clinicId}`}, 0))`,
  );
}

/** The `resumed` row that closes the pause that began at `pausedAt`, if there is one. */
async function resumedAlready(tx: TenantTx, pausedAt: Date): Promise<boolean> {
  const [row] = await tx.db
    .select({ id: channelEvents.id })
    .from(channelEvents)
    .where(
      and(
        eq(channelEvents.clinicId, tx.clinicId),
        eq(channelEvents.kind, "resumed"),
        isNull(channelEvents.channel),
        sql`${channelEvents.detail}->>'pausedAt' = ${pausedAt.toISOString()}`,
      ),
    )
    .limit(1);
  return row !== undefined;
}

/**
 * A timed pause that has ended by itself gets its `resumed` row, at the
 * moment it ended, unless it has one. The caller holds `lockPause` and passes
 * the settings it read under it. Returns whether it wrote one.
 */
async function settleLocked(tx: TenantTx, current: ClinicSettings, now: Date): Promise<boolean> {
  const { aiPausedAt, aiPausedUntil } = current;
  if (aiPausedAt === null || aiPausedUntil === null) return false;
  if (isPaused(pauseOf(current), now)) return false;
  if (await resumedAlready(tx, aiPausedAt)) return false;
  await tx.db.insert(channelEvents).values({
    clinicId: tx.clinicId,
    channel: null,
    kind: "resumed",
    actor: "system",
    detail: { pausedAt: aiPausedAt.toISOString(), endedBy: "time" },
    occurredAt: aiPausedUntil,
  });
  return true;
}

/**
 * updateClinicSettings (lib/billing/settings.ts), recording what a change to
 * the pause did: the `paused` or `resumed` row, and L15 when the pause now in
 * force is long enough for it. Every writer of the pause calls this rather
 * than the writer itself: the header (pauseAya, resumeAya) and the console
 * (lib/ops/billing.ts). A patch that does not name the pause is passed
 * straight through. Returns the settings before and after, as the console
 * reports them.
 */
export async function updateClinicSettingsRecordingPause(
  tx: TenantTx,
  patch: ClinicSettingsPatch,
  actorLabel: string,
  now: Date = new Date(),
  options: {
    /**
     * False for a pause whose own email says it already: the agreement
     * re-sign's (lib/agreements/resign.ts), whose L22 says AYA is paused
     * until it is signed, and which L15's "until someone turns her back on"
     * would contradict. The record of the pause is written either way.
     */
    emailClinic?: boolean;
  } = {},
): Promise<{ before: ClinicSettings; after: ClinicSettings }> {
  const touchesPause = patch.aiPaused !== undefined || patch.aiPausedUntil !== undefined;
  if (touchesPause) await lockPause(tx);
  const before = await getClinicSettings(tx);
  // A timed pause that ended by itself is closed at its end before anything
  // else is recorded, so its window never runs into the next one's.
  if (touchesPause) await settleLocked(tx, before, now);
  const after = await updateClinicSettings(tx, patch, actorLabel, now);
  if (touchesPause) {
    await recordPauseChange(tx, before, after, actorLabel, now, options.emailClinic ?? true);
  }
  return { before, after };
}

async function recordPauseChange(
  tx: TenantTx,
  before: ClinicSettings,
  after: ClinicSettings,
  actorLabel: string,
  now: Date,
  emailClinic: boolean,
): Promise<void> {
  const was = isPaused(pauseOf(before), now);
  const is = isPaused(pauseOf(after), now);
  const actor = actorLabel.slice(0, 200);

  if (!was && is && after.aiPausedAt) {
    await tx.db.insert(channelEvents).values({
      clinicId: tx.clinicId,
      channel: null,
      kind: "paused",
      actor,
      detail: { endsAt: after.aiPausedUntil?.toISOString() ?? null },
      occurredAt: after.aiPausedAt,
    });
  } else if (was && !is && before.aiPausedAt) {
    await tx.db.insert(channelEvents).values({
      clinicId: tx.clinicId,
      channel: null,
      kind: "resumed",
      actor,
      detail: { pausedAt: before.aiPausedAt.toISOString(), endedBy: "switch" },
      occurredAt: now,
    });
  }

  // L15, once per pause (its dedupe key is when the pause began): on a new
  // pause long enough for it, and on a pause whose end moved so that it now
  // is, as when the console turns an hour into "until switched back on".
  if (
    emailClinic &&
    is &&
    after.aiPausedAt &&
    pauseEmailsClinic(after.aiPausedAt, after.aiPausedUntil)
  ) {
    await queuePauseEmails(tx, {
      kind: "pause",
      channels: await answeringChannels(tx),
      platform: null,
      label: after.aiPausedByLabel ?? actor,
      pausedAt: after.aiPausedAt,
      endsAt: after.aiPausedUntil,
      directLine: after.directLineE164,
    });
  }
}

/** The channels that answer when nothing stops them: live, and switched On in Settings. */
async function answeringChannels(tx: TenantTx): Promise<Channel[]> {
  const rows = await tx.db
    .select({ channel: clinicChannels.channel })
    .from(clinicChannels)
    .where(
      and(
        eq(clinicChannels.clinicId, tx.clinicId),
        eq(clinicChannels.enabled, true),
        isNotNull(clinicChannels.liveAt),
      ),
    );
  const live = new Set(rows.map((r) => r.channel));
  return PAUSE_LINE_ORDER.filter((c) => live.has(c));
}

/**
 * L15 and, for a pause with no end, its reminder a day later, in a
 * savepoint: an email that cannot be queued is logged and never undoes the
 * pause, which is the one dangerous action the portal has and must always
 * work. Nothing is queued while no channel answers (a pause before go-live
 * stops nothing a patient would see), or without a public origin to link to.
 */
async function queuePauseEmails(
  tx: TenantTx,
  input: {
    kind: AiPausedPayload["kind"];
    channels: Channel[];
    platform: MetaPlatform | null;
    label: string;
    pausedAt: Date;
    endsAt: Date | null;
    directLine: string | null;
  },
): Promise<void> {
  if (input.channels.length === 0) return;
  if (publicOriginProblem()) {
    log.error("pause email not queued: no public origin", { clinicId: tx.clinicId });
    return;
  }
  try {
    await tx.db.transaction(async (savepoint) => {
      const [clinic] = await savepoint
        .select({ slug: clinics.slug })
        .from(clinics)
        .where(eq(clinics.id, tx.clinicId))
        .limit(1);
      if (!clinic) return;
      const payload: AiPausedPayload = {
        kind: input.kind,
        channels: input.channels,
        platform: input.platform,
        // The one free-text field: left out, rather than have the sender
        // refuse the email for good, when a device's name is one an email
        // may not carry (lib/email/lint.ts).
        deviceName: isAllowedDeviceName(input.label) ? input.label : null,
        pausedAt: input.pausedAt.toISOString(),
        endsAt: input.endsAt?.toISOString() ?? null,
        isReminder: false,
        directLineE164: input.directLine,
        homeUrl: publicUrl(`/c/${clinic.slug}`),
        settingsUrl: publicUrl(`/c/${clinic.slug}/settings`),
      };
      const key =
        input.kind === "pause"
          ? `pause:${payload.pausedAt}`
          : `off:${input.channels[0]}${input.platform ? `:${input.platform}` : ""}:${payload.pausedAt}`;
      await enqueuePlanNotice(savepoint, tx.clinicId, "ai_paused", key, payload);
      if (input.endsAt === null) {
        await enqueuePlanNotice(
          savepoint,
          tx.clinicId,
          "ai_paused",
          `${key}:24h`,
          { ...payload, isReminder: true },
          { sendAfter: new Date(input.pausedAt.getTime() + PAUSE_REMINDER_MS) },
        );
      }
    });
  } catch (error) {
    log.error("pause email not queued", { clinicId: tx.clinicId, error: describeError(error) });
  }
}

// -----------------------------------------------------------------------------
// The header's switch
// -----------------------------------------------------------------------------

/**
 * While a practice owes its updated agreement (lib/agreements/resign.ts), AYA
 * stays paused and the header cannot move the pause: turning her back on,
 * or choosing a pause that ends by itself, would have her answer a covered
 * practice's patients with no business associate agreement in force, and
 * would make L22's "AYA is paused until it's signed" untrue. Signing it lifts
 * the pause. The console (lib/ops/billing.ts) can still move it: an
 * operator's override, never the header's.
 */
async function refuseWhileAgreementToSign(tx: TenantTx): Promise<void> {
  const [open] = await tx.db
    .select({ id: agreementResigns.id })
    .from(agreementResigns)
    .where(and(eq(agreementResigns.clinicId, tx.clinicId), eq(agreementResigns.status, "open")))
    .limit(1);
  if (open) {
    throw new PauseError(
      "AYA stays paused until your updated agreement is signed. Sign it in Billing, under Your agreement.",
    );
  }
}

/**
 * Pause AYA on every channel from the header: for an hour, until 08:00
 * tomorrow on the clinic's clock, or until someone turns her back on.
 * Refused before go-live, when there is nothing to pause: the header then
 * says AYA isn't answering yet, and offers no switch.
 */
export async function pauseAya(
  tx: TenantTx,
  input: { choice: PauseChoice; actorLabel: string; now?: Date },
): Promise<{ settings: ClinicSettings; timeZone: string }> {
  if (!isPauseChoice(input.choice)) throw new PauseError("Choose how long to pause AYA.");
  await refuseWhileAgreementToSign(tx);
  const now = input.now ?? new Date();
  const [clinic] = await tx.db
    .select({ timezone: clinics.timezone })
    .from(clinics)
    .where(eq(clinics.id, tx.clinicId))
    .limit(1);
  if (!clinic) throw new PauseError("This clinic could not be found.");
  const [live] = await tx.db
    .select({ channel: clinicChannels.channel })
    .from(clinicChannels)
    .where(and(eq(clinicChannels.clinicId, tx.clinicId), isNotNull(clinicChannels.liveAt)))
    .limit(1);
  if (!live) {
    throw new PauseError("AYA isn't answering anyone yet, so there's nothing to pause.");
  }
  const until = pauseEndFor(input.choice, now, clinic.timezone);
  const { after } = await updateClinicSettingsRecordingPause(
    tx,
    { aiPaused: true, aiPausedUntil: until },
    input.actorLabel,
    now,
  );
  return { settings: after, timeZone: clinic.timezone };
}

/** Turn AYA back on from the header. A clinic that is not paused writes nothing. */
export async function resumeAya(
  tx: TenantTx,
  input: { actorLabel: string; now?: Date },
): Promise<ClinicSettings> {
  await refuseWhileAgreementToSign(tx);
  const { after } = await updateClinicSettingsRecordingPause(
    tx,
    { aiPaused: false },
    input.actorLabel,
    input.now ?? new Date(),
  );
  return after;
}

// -----------------------------------------------------------------------------
// A channel switched Off in Settings
// -----------------------------------------------------------------------------

/**
 * A channel, or one of the Meta apps, has just been switched Off in Settings
 * (lib/portal/settings.ts, after setChannelEnabled or setMetaPlatformEnabled
 * said it changed): L15 for that channel, and its reminder a day later while
 * it is still off. Only for a live channel: one that has not gone live was
 * answering nobody, and Off there changes nothing a patient sees. Returns
 * whether it queued.
 */
export async function noteChannelSwitchedOff(
  tx: TenantTx,
  input: { channel: Channel; platform?: MetaPlatform | null; actorLabel: string; now?: Date },
): Promise<boolean> {
  const now = input.now ?? new Date();
  const [row] = await tx.db
    .select({ liveAt: clinicChannels.liveAt })
    .from(clinicChannels)
    .where(and(eq(clinicChannels.clinicId, tx.clinicId), eq(clinicChannels.channel, input.channel)))
    .limit(1);
  if (!row?.liveAt) return false;
  const [settings] = await tx.db
    .select({ directLine: clinicSettings.directLineE164 })
    .from(clinicSettings)
    .where(eq(clinicSettings.clinicId, tx.clinicId))
    .limit(1);
  await queuePauseEmails(tx, {
    kind: "channel_off",
    channels: [input.channel],
    platform: input.channel === "meta" ? (input.platform ?? null) : null,
    label: input.actorLabel,
    pausedAt: now,
    endsAt: null,
    directLine: settings?.directLine ?? null,
  });
  return true;
}

// -----------------------------------------------------------------------------
// The reminder, at its due time
// -----------------------------------------------------------------------------

/**
 * Whether an L15 reminder no longer needs sending, asked by the outbox when
 * it falls due (lib/email/superseded.ts), in the clinic's tenant: why, for
 * its `last_error`, or null to send it. The first email always goes: it is
 * about a pause that has already happened, and it is how a pause nobody at
 * the practice made gets noticed.
 *
 * A pause's reminder goes only while the same pause still holds with no end.
 * A channel's goes only while it is still Off, and was not switched On and
 * Off again since: the later Off has its own reminder.
 */
export async function pauseEmailSuperseded(tx: TenantTx, payload: unknown): Promise<string | null> {
  const p = payload as Partial<AiPausedPayload> | null;
  if (!p || p.isReminder !== true || typeof p.pausedAt !== "string") return null;
  const pausedAt = new Date(p.pausedAt);
  if (Number.isNaN(pausedAt.getTime())) return null;

  if (p.kind === "pause") {
    const s = await getClinicSettings(tx);
    const same = s.aiPausedAt !== null && s.aiPausedAt.getTime() === pausedAt.getTime();
    return same && s.aiPausedUntil === null
      ? null
      : "AYA was turned back on, or the pause was given an end, before it could go";
  }

  const channel = p.channels?.[0];
  if (p.kind !== "channel_off" || !channel || !(CHANNELS as readonly string[]).includes(channel)) {
    return null;
  }
  const platform = channel === "meta" ? (p.platform ?? null) : null;
  let off: boolean;
  if (platform) {
    off = !(await readMetaPlatformSwitches(tx.db, tx.clinicId))[platform];
  } else {
    const [row] = await tx.db
      .select({ enabled: clinicChannels.enabled })
      .from(clinicChannels)
      .where(and(eq(clinicChannels.clinicId, tx.clinicId), eq(clinicChannels.channel, channel)))
      .limit(1);
    off = row?.enabled === false;
  }
  const [backOn] = await tx.db
    .select({ id: channelEvents.id })
    .from(channelEvents)
    .where(
      and(
        eq(channelEvents.clinicId, tx.clinicId),
        eq(channelEvents.channel, channel),
        eq(channelEvents.kind, "turned_on"),
        gt(channelEvents.occurredAt, pausedAt),
        ...(platform ? [sql`${channelEvents.detail}->>'platform' = ${platform}`] : []),
      ),
    )
    .limit(1);
  return off && !backOn ? null : "the channel was switched back on before it could go";
}

// -----------------------------------------------------------------------------
// The hourly sweep
// -----------------------------------------------------------------------------

const SWEEP_ACTOR: ActorContext = { type: "service", serviceName: "ai-pause" };

/**
 * Every clinic whose timed pause has ended by itself gets that pause's
 * `resumed` row, at the moment it ended, once. Nothing else needs doing when
 * a pause ends: the answer gate reads the end itself (isPaused), so AYA
 * answered again from that moment. Not a switched job: a pure function of
 * rows the clinic set, like the channel-states sweep. Each clinic in its own
 * transaction; one clinic's failure is logged and the sweep carries on.
 */
export async function sweepEndedPauses(
  now: Date = new Date(),
): Promise<{ clinics: number; resumed: number; failures: number }> {
  const result = await unsafeDb.execute<{ id: string }>(
    sql`select id from app_clinics_overview()
         where offboarding_started_at is null
           and destroyed_at is null`,
  );
  const ids = ((result as unknown as { rows?: { id: string }[] }).rows ?? []).map((r) =>
    String(r.id),
  );
  const summary = { clinics: ids.length, resumed: 0, failures: 0 };
  for (const clinicId of ids) {
    try {
      const wrote = await withTenant({ clinicId, actor: SWEEP_ACTOR }, async (tx) => {
        // Unlocked first: most clinics are not paused, and a pause already
        // closed stays closed, so they stop here without taking the lock.
        const seen = await getClinicSettings(tx);
        if (seen.aiPausedAt === null || seen.aiPausedUntil === null) return false;
        if (isPaused(pauseOf(seen), now) || (await resumedAlready(tx, seen.aiPausedAt))) {
          return false;
        }
        await lockPause(tx);
        return settleLocked(tx, await getClinicSettings(tx), now);
      });
      if (wrote) summary.resumed += 1;
    } catch (error) {
      summary.failures += 1;
      log.error("ended pause not recorded", { clinicId, error: describeError(error) });
    }
  }
  return summary;
}
