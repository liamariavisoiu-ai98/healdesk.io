import { and, count, desc, eq, gte, inArray, isNull, or, sql } from "drizzle-orm";

import { unsafeDb } from "@/db";
import { channelEvents, chatThreads, conversations } from "@/db/schema";
import { readChannelStates, type ChannelState } from "@/lib/channels/state";
import { describeError, log } from "@/lib/log";
import { notifyOpsOnce } from "@/lib/ops/notify";
import { JOB_HEALTH_FLAGS, runJob, type JobOutcome } from "@/lib/scheduler/jobs";
import { withTenant, type TenantTx } from "@/lib/tenant";

/**
 * The spec's two internal health flags (WP5), keyed on each clinic's first
 * `clinic_channels.live_at` (WP1's channel events):
 *
 *   - `no_interactions_48_hours`: "An account with zero interactions on any
 *     channel after 48 hours is flagged internally. Something is wrong with
 *     the deployment, not with the clinic" (spec, "The first 48 hours"). 48
 *     hours after the clinic's first channel went live, nothing has reached
 *     any channel since: no call, no web chat, no Meta message. Once per
 *     clinic, ever.
 *   - `no_inbound_calls_14_days`: "A clinic on an active voice plan receiving
 *     zero inbound calls for fourteen consecutive days is flagged internally.
 *     That is silent churn, and it is almost always forwarding that was set
 *     up, then removed or broken." Phone live, switched on and not paused,
 *     and no call for fourteen days, counted from the latest of its go-live,
 *     its last call, and the last time it was switched back on or resumed.
 *     Once per quiet stretch: the alert carries the stretch's last call's id
 *     (none before a first call), so a later stretch is a new alert, and the
 *     alert names no time a caller called.
 *
 * Internal, as the spec says: they reach ops through notifyOps and the
 * clinic never sees them. A call is any conversations row on voice, which
 * the voice ingest writes for every call that reached AYA's number,
 * passed through or answered; an interaction is any conversations row, or a
 * Meta thread's inbound message. Healdesk's own test call counts: it proves
 * the deployment answers, which is what the 48-hour flag asks.
 *
 * Every read is counts and one id inside the clinic's own tenant, with an
 * audit row for the conversations it counted. A clinic paused or with every
 * channel switched off is the clinic's choice, not a broken deployment, and
 * is not flagged.
 */

export const NO_INTERACTIONS_AFTER_MS = 48 * 60 * 60_000;
export const NO_CALLS_FOR_MS = 14 * 24 * 60 * 60_000;

const ACTOR = { type: "service", serviceName: "health-flags" } as const;

export type ClinicFlags = {
  noInteractions48Hours: boolean;
  noInboundCalls14Days: boolean;
};

/** One clinic's two flags at `now`, raised through notifyOpsOnce. Reads inside its tenant. */
export async function flagClinic(tx: TenantTx, now: Date): Promise<ClinicFlags> {
  const flags: ClinicFlags = { noInteractions48Hours: false, noInboundCalls14Days: false };
  const states = await readChannelStates(tx.db, tx.clinicId, now);
  const firstLive = earliest(states.map((s) => s.liveAt));
  if (!firstLive) return flags;

  if (
    now.getTime() - firstLive.getTime() >= NO_INTERACTIONS_AFTER_MS &&
    states.some((s) => s.status === "live") &&
    (await interactionsSince(tx, firstLive)) === 0
  ) {
    flags.noInteractions48Hours = true;
    await notifyOpsOnce("no_interactions_48_hours", { clinicId: tx.clinicId });
  }

  const voice = states.find((s) => s.channel === "voice");
  if (voice?.status === "live" && voice.liveAt) {
    const quiet = await voiceQuietSince(tx, voice);
    if (now.getTime() - quiet.since.getTime() >= NO_CALLS_FOR_MS) {
      flags.noInboundCalls14Days = true;
      await notifyOpsOnce("no_inbound_calls_14_days", {
        clinicId: tx.clinicId,
        channel: "voice",
        ...(quiet.lastCallId ? { conversationId: quiet.lastCallId } : {}),
      });
    }
  }
  return flags;
}

function earliest(dates: readonly (Date | null)[]): Date | null {
  return dates.reduce<Date | null>((min, d) => (d && (!min || d < min) ? d : min), null);
}

async function interactionsSince(tx: TenantTx, since: Date): Promise<number> {
  const [calls] = await tx.db
    .select({ n: count() })
    .from(conversations)
    .where(and(eq(conversations.clinicId, tx.clinicId), gte(conversations.startedAt, since)));
  const [threads] = await tx.db
    .select({ n: count() })
    .from(chatThreads)
    .where(and(eq(chatThreads.clinicId, tx.clinicId), gte(chatThreads.lastInboundAt, since)));
  const total = (calls?.n ?? 0) + (threads?.n ?? 0);
  tx.audit.record({
    action: "read",
    resourceType: "conversation",
    resultCount: total,
    metadata: { purpose: "health_flags" },
  });
  return total;
}

/** When phone's quiet stretch began, and the call before it, if there was one since go-live. */
async function voiceQuietSince(
  tx: TenantTx,
  voice: ChannelState,
): Promise<{ since: Date; lastCallId: string | null }> {
  const liveAt = voice.liveAt as Date;
  const [lastCall] = await tx.db
    .select({ id: conversations.id, startedAt: conversations.startedAt })
    .from(conversations)
    .where(
      and(
        eq(conversations.clinicId, tx.clinicId),
        eq(conversations.channel, "voice"),
        gte(conversations.startedAt, liveAt),
      ),
    )
    .orderBy(desc(conversations.startedAt))
    .limit(1);
  tx.audit.record({
    action: "read",
    resourceType: "conversation",
    resultCount: lastCall ? 1 : 0,
    metadata: { purpose: "health_flags" },
  });
  // Switched back on, or the header's pause lifted: the stretch starts again.
  const [restarted] = await tx.db
    .select({ at: channelEvents.occurredAt })
    .from(channelEvents)
    .where(
      and(
        eq(channelEvents.clinicId, tx.clinicId),
        inArray(channelEvents.kind, ["turned_on", "resumed"]),
        or(eq(channelEvents.channel, "voice"), isNull(channelEvents.channel)),
      ),
    )
    .orderBy(desc(channelEvents.occurredAt))
    .limit(1);
  const since = latest([liveAt, lastCall?.startedAt ?? null, restarted?.at ?? null]);
  return { since, lastCallId: lastCall?.id ?? null };
}

function latest(dates: readonly (Date | null)[]): Date {
  return dates.reduce<Date>((max, d) => (d && d > max ? d : max), dates[0] as Date);
}

/**
 * Every clinic that has not left, flagged one after another, each in its own
 * tenant transaction. A clinic that cannot be read is logged and the run
 * carries on; the count is returned.
 */
export async function flagClinics(
  now: Date = new Date(),
): Promise<{ clinics: number; noInteractions: number; noCalls: number; failures: number }> {
  const result = await unsafeDb.execute<{ id: string }>(
    sql`select id from app_clinics_overview()
         where offboarding_started_at is null and destroyed_at is null`,
  );
  const ids = ((result as unknown as { rows?: { id: string }[] }).rows ?? []).map((r) =>
    String(r.id),
  );
  const summary = { clinics: ids.length, noInteractions: 0, noCalls: 0, failures: 0 };
  for (const clinicId of ids) {
    try {
      const flags = await withTenant({ clinicId, actor: ACTOR }, (tx) => flagClinic(tx, now));
      if (flags.noInteractions48Hours) summary.noInteractions += 1;
      if (flags.noInboundCalls14Days) summary.noCalls += 1;
    } catch (error) {
      summary.failures += 1;
      log.error("health flags not read", { clinicId, error: describeError(error) });
    }
  }
  return summary;
}

/** The hourly run, behind the `health-flags` switch (seeded off). */
export async function runHealthFlagsJob(options: { now?: Date } = {}): Promise<JobOutcome> {
  const now = options.now ?? new Date();
  return runJob(
    JOB_HEALTH_FLAGS,
    async () => {
      const s = await flagClinics(now);
      const note = `${s.clinics} clinics: ${s.noInteractions} quiet since go-live, ${s.noCalls} phone lines quiet for 14 days`;
      if (s.failures > 0) throw new Error(`${note}; ${s.failures} unreadable.`);
      return `${note}.`;
    },
    now,
  );
}
