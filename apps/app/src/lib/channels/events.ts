import type { Channel } from "@healdesk/catalog";
import { and, asc, eq, sql } from "drizzle-orm";

import { unsafeDb } from "@/db";
import {
  agentConfigs,
  channelEvents,
  clinicChannels,
  clinics,
  clinicSettings,
  entitlements,
  type ChannelWaitingOn,
  type ForwardingTestObservation,
} from "@/db/schema";
import type { ActorContext, AuditEntry } from "@/lib/audit";
import { hasPlanStarted } from "@/lib/billing/entitlements";
import { startPlan, stepUpPackage } from "@/lib/billing/requests";
import {
  platformMissingAll,
  readPlatformCompliance,
  type PlatformMissing,
} from "@/lib/compliance/platform";
import { describeError, log } from "@/lib/log";
import { queueChannelReady } from "@/lib/notices/channel-ready";
import { enqueuePlanNotice } from "@/lib/notices/plan-notices";
import {
  goLiveCodes,
  goLivePreconditions,
  markClinicProduction,
  readGoLiveFacts,
  type GoLiveChannelGate,
  type GoLiveCheck,
  type GoLiveCode,
  type GoLiveVia,
} from "@/lib/onboarding/go-live";
import { notifyOps, notifyOpsOnce } from "@/lib/ops/notify";
import { publicOriginProblem, publicUrl } from "@/lib/public-url";
import { helpContacts } from "@/lib/setup/help";
import { readProgress, screensFor, wizardFinished } from "@/lib/setup/screens";
import { withTenant, type TenantTx } from "@/lib/tenant";
import type { VoiceCallEvent, VoiceMetering } from "@/lib/voice/ingest";

import { channelsWithAuditPassed } from "./audit-seam";
import { connectedMetaPlatforms } from "./meta-platforms";

/**
 * Channel events (plan Part G; contracts §7): a channel's `ready`,
 * `waiting_on`, `live` and `first_answer`, in `clinic_channels` (`ready_at`,
 * `waiting_on`, `live_at`, `first_answer_at`) and, append-only, in
 * `channel_events`. The answer gate (lib/billing/answering.ts) refuses a
 * channel whose `live_at` is null, and billing is charged from
 * `first_answer_at`, so the runtime role cannot write either: the definers
 * of drizzle/0079 record ready, live and the first answer, each re-checking
 * in SQL what it records, and this module decides when to ask them.
 *
 * ## ready, waiting, live
 *
 * **Ready on our side** is: the clinic has not left, the channel's audit
 * passed (lib/channels/audit-seam.ts, the seam the practice questions
 * replace; until they exist only an operator records it), and our half of
 * its runtime exists (phone: AYA's number, which an operator enters once the
 * clinic's Retell agent and number exist; the Meta channel: the operator's
 * front door; website chat has no half of ours). The operator's go-live is
 * not needed, so phone is ready, and the clinic told to forward its line
 * (O10, and the "Email these steps" form, O11), before go-live.
 *
 * **Waiting on the clinic**, while ready and not live, names the clinic's one
 * next step: finishing setup (`setup`), phone's direct line
 * (`direct_line`), then the channel's own step: the forwarding, the line on
 * the website, the Meta login.
 *
 * **Live** needs everything ready needs, plus:
 *   - **go-live**: the clinic is in production (app_mark_clinic_production).
 *     Automatic since WP2: when a synthetic clinic's channel has every input
 *     but go-live, this writer asks lib/onboarding/go-live.ts whether the
 *     clinic may go live (its agreement, its covered status, the platform's
 *     attestations, Gate B) and, when it may, flips it in the same
 *     transaction, then takes the channel live. The practice questions'
 *     pass is the usual last input (lib/engine/practice/store.ts, afterPass).
 *     A refusal leaves the clinic as it is, tells ops once per reason
 *     (go_live_held) and is on the clinic's tracker;
 *   - **the platform's attestations** (`platform`): what every channel needs
 *     attested in platform_compliance, and the channel's own (Retell and
 *     phone's tests; the other channels' runtimes), lib/compliance;
 *   - **the clinic's step, evidenced**: for phone, a call observed with the
 *     caller's number intact, in a forwarding test the clinic or an operator
 *     ran, or forwarded from the clinic's own line with no test at all
 *     (never the onboarding stamp alone, which an operator can set by hand);
 *     for website chat, an
 *     operator's confirmation that its line is on the clinic's site
 *     (`runtime_seen`; an Origin header is never proof, because anyone can
 *     send one); for the Meta channel, a connected platform;
 *   - **setup done** as its skip lines promise (lib/setup/skip-costs.ts):
 *     every wizard screen answered or skipped, and what a skip line says a
 *     channel cannot go live without: phone's hours (confirmed) and its
 *     direct line, a vet practice's emergency referral number, prices read or
 *     filled in checked on the services screen, and the covered status a
 *     hipaa-if-covered practice left open.
 *
 * `ready_at` and `live_at` are set once and kept, so a channel never goes
 * live twice and L1 is sent once. A precondition lost after go-live does not
 * un-live a channel: the answer gate and the runtimes refuse on what is true
 * now (the front door, the number, the switches, the pause).
 *
 * Every writer of a clinic's channel rows locks all of them in channel order
 * (`lockChannelRows`, and the same in the definers), so no two can deadlock;
 * and a channel already live is skipped before any lock is taken. The
 * callers are the events that change an input (the operator's go-live,
 * attestations and phone settings, the front door, a Meta connection, the
 * forwarding test, a setup screen saved) and the hourly sweep
 * (`sweepChannelStates`), which catches anything they missed. The voice
 * ingest calls `evaluateChannelsSafely`, in a savepoint, so nothing here can
 * cost a call its record.
 *
 * ## first_answer
 *
 * The first inbound patient conversation answered on a live channel: the day
 * its price joins the plan (spec: "Monthly billing starts the day the
 * assistant first answers a patient"). The clinic's first one records
 * healdesk-io-58's `startPlan(first_answer)`; each later channel's records
 * `stepUpPackage(channel, first_answer)` (lib/billing/requests.ts), in the
 * same savepoint as the event, so both commit or neither does. It excludes
 * Healdesk's own test calls (every call in a forwarding test's window, and
 * calls from HEALDESK_TEST_NUMBERS), calls from the clinic's own numbers,
 * a web chat on a local page, a turn that answered only with the failure
 * line, anything the answer gate passed through, a conversation in which the
 * person never said anything, and the preview and the practice questions,
 * which never reach the runtimes' callers and are refused by name if they
 * ever do (`firstAnswerExclusion`).
 *
 * Tenant plane, no patient data: channels, codes, ids and times.
 */

// -----------------------------------------------------------------------------
// The decision
// -----------------------------------------------------------------------------

/** One of the inputs `live` waits for, in the order the operator console names them. */
export type LiveInput =
  | "leaving"
  | "audit"
  | "runtime"
  | "setup"
  | "hours"
  | "direct_line"
  | "vet_referral"
  | "prices_checked"
  | "covered_status"
  | "clinic_step"
  | "platform"
  | "go_live";

export const LIVE_INPUTS: readonly LiveInput[] = [
  "leaving",
  "audit",
  "runtime",
  "setup",
  "hours",
  "direct_line",
  "vet_referral",
  "prices_checked",
  "covered_status",
  "clinic_step",
  "platform",
  "go_live",
];

export type ChannelInputs = {
  channel: Channel;
  /** The clinic is offboarding or destroyed: nothing is ready, nothing goes live. */
  leaving: boolean;
  /** The seam the practice questions replace (lib/channels/audit-seam.ts). */
  auditPassed: boolean;
  /** Our half of the runtime: phone, AYA's number; Meta, the front door; website chat, none. */
  runtimeOurs: boolean;
  /** Every wizard screen this clinic is shown, answered or skipped. */
  setupDone: boolean;
  /** Phone only: opening hours on file and confirmed. True for the other channels. */
  hours: boolean;
  /** Phone only: the direct line is on file. True for the other channels. */
  directLine: boolean;
  /** A vet practice's emergency referral number, or a practice that needs none. */
  vetReferral: boolean;
  /** No price stands unchecked: no priced service, or the services screen answered. */
  pricesChecked: boolean;
  /** The covered status is known, or the practice's regime never asks it. */
  coveredStatus: boolean;
  /** The clinic's half, evidenced: phone, a forwarding test observed; website chat, its line confirmed on the site; Meta, a platform connected. */
  clinicStepDone: boolean;
  /** platform_compliance: what every channel needs attested, and this channel's own (lib/compliance/subjects.ts). */
  platform: boolean;
  /** Go-live put the clinic in production: automatically, once everything go-live asks holds. */
  opsReady: boolean;
};

export type ChannelDecision = {
  /** Ready on our side. */
  ready: boolean;
  /** While ready and not live, the clinic's one outstanding action; null while it waits on us. */
  waitingOn: ChannelWaitingOn | null;
  live: boolean;
  /** What stands between the channel and live, in order; empty exactly when live. */
  missing: LiveInput[];
};

/** The clinic's own step for each channel, once setup is done. */
export const CLINIC_STEP: Readonly<Record<Channel, ChannelWaitingOn>> = {
  web: "snippet",
  voice: "forwarding",
  meta: "meta_connect",
};

/**
 * Pure: whether a channel is ready on our side, what it waits on, and
 * whether it is live. drizzle/0079's app_channel_ours_ok and
 * app_channel_live_ok are the SQL mirror the definers enforce, and
 * tests/channel-events.test.ts holds the two together.
 */
export function decideChannel(inputs: ChannelInputs): ChannelDecision {
  if (inputs.leaving) return { ready: false, waitingOn: null, live: false, missing: ["leaving"] };
  const ours: LiveInput[] = [];
  if (!inputs.auditPassed) ours.push("audit");
  if (!inputs.runtimeOurs) ours.push("runtime");
  const theirs: LiveInput[] = [];
  if (!inputs.setupDone) theirs.push("setup");
  if (inputs.channel === "voice" && !inputs.hours) theirs.push("hours");
  if (inputs.channel === "voice" && !inputs.directLine) theirs.push("direct_line");
  if (!inputs.vetReferral) theirs.push("vet_referral");
  if (!inputs.pricesChecked) theirs.push("prices_checked");
  if (!inputs.coveredStatus) theirs.push("covered_status");
  if (!inputs.clinicStepDone) theirs.push("clinic_step");
  const missing = [
    ...ours,
    ...theirs,
    ...(inputs.platform ? [] : (["platform"] as const)),
    ...(inputs.opsReady ? [] : (["go_live"] as const)),
  ];
  const ready = ours.length === 0;
  const live = missing.length === 0;
  const next = theirs[0];
  const waitingOn: ChannelWaitingOn | null =
    !ready || live || next === undefined
      ? null
      : next === "clinic_step"
        ? CLINIC_STEP[inputs.channel]
        : next === "direct_line"
          ? "direct_line"
          : "setup";
  return { ready, waitingOn, live, missing };
}

// -----------------------------------------------------------------------------
// The facts
// -----------------------------------------------------------------------------

/** Everything `decideChannel` reads, for every channel of one clinic. */
export type ReadinessFacts = {
  slug: string;
  leaving: boolean;
  opsReady: boolean;
  setupDone: boolean;
  hours: boolean;
  directLine: boolean;
  vetReferral: boolean;
  pricesChecked: boolean;
  coveredStatus: boolean;
  assistantNumberE164: string | null;
  metaFrontDoor: boolean;
  metaConnected: boolean;
  /**
   * A call observed with the caller's number intact: a forwarding test's, or
   * one the carrier forwarded from the clinic's own line (observeForwardingCall).
   */
  forwardingObserved: boolean;
  auditPassed: ReadonlySet<Channel>;
  runtimeSeen: ReadonlySet<Channel>;
  /** What every channel, and each channel, still needs attested (platform_compliance). */
  platform: PlatformMissing;
};

/** The inputs for one channel, from the clinic's facts. */
export function channelInputs(channel: Channel, facts: ReadinessFacts): ChannelInputs {
  return {
    channel,
    leaving: facts.leaving,
    auditPassed: facts.auditPassed.has(channel),
    runtimeOurs:
      channel === "voice"
        ? facts.assistantNumberE164 !== null
        : channel === "meta"
          ? facts.metaFrontDoor
          : true,
    setupDone: facts.setupDone,
    hours: channel === "voice" ? facts.hours : true,
    directLine: channel === "voice" ? facts.directLine : true,
    vetReferral: facts.vetReferral,
    pricesChecked: facts.pricesChecked,
    coveredStatus: facts.coveredStatus,
    clinicStepDone:
      channel === "voice"
        ? facts.forwardingObserved
        : channel === "meta"
          ? facts.metaConnected
          : facts.runtimeSeen.has("web"),
    platform: facts.platform.clinic.length === 0 && facts.platform.channel[channel].length === 0,
    opsReady: facts.opsReady,
  };
}

/**
 * Each channel against Gate B, as go-live asks it (lib/onboarding/go-live.ts):
 * every input its own `live` reads but the clinic's go-live, with only its
 * own attestations as `platform`; the ones every channel shares are
 * go-live's `platform`, asked once. app_channel_gate_b_ok (drizzle/0090) is
 * the SQL.
 */
export function channelGates(
  rows: readonly { channel: Channel; liveAt: Date | null }[],
  facts: ReadinessFacts,
): GoLiveChannelGate[] {
  return rows.map((row) => {
    const own = facts.platform.channel[row.channel];
    const decision = decideChannel({
      ...channelInputs(row.channel, facts),
      platform: own.length === 0,
      opsReady: true,
    });
    return {
      channel: row.channel,
      live: row.liveAt !== null,
      met: decision.live,
      missing: decision.missing.filter((m) => m !== "platform"),
      platform: own,
    };
  });
}

async function channelsWithEvent(
  tx: TenantTx,
  kind: "runtime_seen" | "audit_passed",
): Promise<Set<Channel>> {
  if (kind === "audit_passed") return channelsWithAuditPassed(tx.db, tx.clinicId);
  const rows = await tx.db
    .selectDistinct({ channel: channelEvents.channel })
    .from(channelEvents)
    .where(and(eq(channelEvents.clinicId, tx.clinicId), eq(channelEvents.kind, kind)));
  return new Set(rows.map((r) => r.channel).filter((c): c is Channel => c !== null));
}

/** Read the clinic's facts in its own transaction; null when there is no such clinic. */
export async function readReadinessFacts(
  tx: TenantTx,
  bought: readonly Channel[],
  now: Date = new Date(),
): Promise<ReadinessFacts | null> {
  const [clinic] = await tx.db
    .select({
      slug: clinics.slug,
      dataClassification: clinics.dataClassification,
      offboardingStartedAt: clinics.offboardingStartedAt,
      destroyedAt: clinics.destroyedAt,
      assistantNumberE164: clinics.assistantNumberE164,
      metaFrontDoorEnabled: clinics.metaFrontDoorEnabled,
      onboarding: clinics.onboarding,
      openingHours: clinics.openingHours,
      forwardingTestObserved: clinics.forwardingTestObserved,
      regulatoryRegime: clinics.regulatoryRegime,
      agreementKind: clinics.agreementKind,
      isCoveredEntity: clinics.isCoveredEntity,
    })
    .from(clinics)
    .where(eq(clinics.id, tx.clinicId))
    .limit(1);
  if (!clinic) return null;
  const progress = await readProgress(tx.db, tx.clinicId);
  // The backup factor is offered after the four steps and is not one of
  // them (wizardScreens), so whether the sign-in has one changes nothing.
  const screens = screensFor(
    {
      channels: bought,
      regulatoryRegime: clinic.regulatoryRegime,
      agreementKind: clinic.agreementKind,
      isCoveredEntity: clinic.isCoveredEntity,
      hasBackup: true,
    },
    progress,
  );
  const [settings] = await tx.db
    .select({
      directLine: clinicSettings.directLineE164,
      vetReferral: clinicSettings.vetReferralE164,
    })
    .from(clinicSettings)
    .where(eq(clinicSettings.clinicId, tx.clinicId))
    .limit(1);
  const [agent] = await tx.db
    .select({ services: agentConfigs.services })
    .from(agentConfigs)
    .where(eq(agentConfigs.clinicId, tx.clinicId))
    .limit(1);
  const onboarding = (clinic.onboarding ?? {}) as Record<string, unknown>;
  const observed = clinic.forwardingTestObserved as ForwardingTestObservation | null;
  const priced = (agent?.services ?? []).some(
    (s) => (s as { priceFromUsd?: unknown }).priceFromUsd != null,
  );
  return {
    slug: clinic.slug,
    leaving: clinic.offboardingStartedAt !== null || clinic.destroyedAt !== null,
    opsReady: clinic.dataClassification === "production",
    setupDone: wizardFinished(screens, progress),
    hours: clinic.openingHours != null && onboarding.hours_confirmed != null,
    directLine: Boolean(settings?.directLine),
    vetReferral: clinic.regulatoryRegime !== "non-hipaa" || Boolean(settings?.vetReferral),
    pricesChecked: !priced || progress.get("services")?.outcome === "done",
    coveredStatus: !(
      clinic.regulatoryRegime === "hipaa-if-covered" && clinic.isCoveredEntity === null
    ),
    assistantNumberE164: clinic.assistantNumberE164,
    metaFrontDoor: clinic.metaFrontDoorEnabled,
    metaConnected: bought.includes("meta")
      ? (await connectedMetaPlatforms(tx.db, tx.clinicId)).length > 0
      : false,
    forwardingObserved: observed?.callerIdPreserved === true,
    auditPassed: await channelsWithEvent(tx, "audit_passed"),
    runtimeSeen: await channelsWithEvent(tx, "runtime_seen"),
    platform: platformMissingAll(await readPlatformCompliance(tx.db, now)),
  };
}

// -----------------------------------------------------------------------------
// ready, waiting, live: the writer
// -----------------------------------------------------------------------------

/** An hour after readiness, O10 goes if the channel is still waiting on its step. */
export const CHANNEL_READY_EMAIL_DELAY_MS = 60 * 60 * 1000;

export type ChannelTransition = {
  channel: Channel;
  /** It became ready on our side in this call. */
  readied: boolean;
  /** Its waiting_on changed in this call, to this. */
  waitingOn?: ChannelWaitingOn | null;
  /** It went live in this call. */
  wentLive: boolean;
  /** What still stands between it and live, after this call. */
  missing: LiveInput[];
};

type ChannelRow = {
  channel: Channel;
  readyAt: Date | null;
  waitingOn: ChannelWaitingOn | null;
  liveAt: Date | null;
  firstAnswerAt: Date | null;
};

const ROW = {
  channel: clinicChannels.channel,
  readyAt: clinicChannels.readyAt,
  waitingOn: clinicChannels.waitingOn,
  liveAt: clinicChannels.liveAt,
  firstAnswerAt: clinicChannels.firstAnswerAt,
};

/**
 * The clinic's channel rows, locked in channel order: the one order every
 * writer of them takes (here, the first answer and drizzle/0079's definers),
 * so no two writers can each hold a row the other waits for.
 */
async function lockChannelRows(tx: TenantTx): Promise<ChannelRow[]> {
  return tx.db
    .select(ROW)
    .from(clinicChannels)
    .where(eq(clinicChannels.clinicId, tx.clinicId))
    .orderBy(asc(clinicChannels.channel))
    .for("update");
}

async function definerFlag(tx: TenantTx, query: ReturnType<typeof sql>): Promise<boolean> {
  const result = await tx.db.execute<{ ok: boolean }>(query);
  return result.rows[0]?.ok === true;
}

/**
 * Move the clinic's channels on as far as their inputs allow, inside the
 * caller's transaction: ready, waiting on the clinic, live. Idempotent: a
 * channel already where its inputs put it writes nothing, and when every
 * channel asked about is already live it takes no lock at all. Returns one
 * entry per channel looked at.
 *
 * `only` limits it to one channel. `actor` goes on the event rows: 'system',
 * 'ops', or the label of the device whose passkey did it.
 */
export async function evaluateChannels(
  tx: TenantTx,
  options: EvaluateOptions = {},
): Promise<ChannelTransition[]> {
  return evaluate(tx, options, (entry) => tx.audit.record(entry));
}

/**
 * `evaluateChannels` in a savepoint that never throws, for a caller whose own
 * write must survive it: the voice ingest, whose transaction is the call's
 * only record. A failure (a deadlock Postgres broke on this side, say) rolls
 * back only what this did, is logged, and the hourly sweep tries again.
 */
export async function evaluateChannelsSafely(
  tx: TenantTx,
  options: EvaluateOptions = {},
): Promise<ChannelTransition[]> {
  const audits: AuditEntry[] = [];
  try {
    const moved = await tx.db.transaction((savepoint) =>
      evaluate({ ...tx, db: savepoint }, options, (entry) => audits.push(entry)),
    );
    for (const entry of audits) tx.audit.record(entry);
    return moved;
  } catch (error) {
    log.error("channels not moved on", {
      clinicId: tx.clinicId,
      channel: options.only,
      error: describeError(error),
    });
    return [];
  }
}

async function evaluate(
  tx: TenantTx,
  options: EvaluateOptions,
  audit: (entry: AuditEntry) => void,
): Promise<ChannelTransition[]> {
  const now = options.now ?? new Date();
  const actor = (options.actor ?? "system").slice(0, 200);
  const asked = (row: ChannelRow) => !options.only || row.channel === options.only;

  // Unlocked first: a live channel is final, so the calls and chats of a live
  // clinic stop here without taking any lock.
  const seen = await tx.db
    .select(ROW)
    .from(clinicChannels)
    .where(eq(clinicChannels.clinicId, tx.clinicId));
  if (!seen.some((row) => asked(row) && row.liveAt === null)) {
    return seen
      .filter(asked)
      .map((row) => ({ channel: row.channel, readied: false, wentLive: false, missing: [] }));
  }

  const rows = await lockChannelRows(tx);
  let facts = await readReadinessFacts(
    tx,
    rows.map((r) => r.channel),
    now,
  );
  if (!facts) return [];
  // Go-live, automatic (WP2): a synthetic clinic whose channel has every
  // input but go-live is taken to production here, when everything go-live
  // asks holds, so the channel goes live below in this same transaction.
  if (!facts.opsReady && (await goLiveIfReady(tx, rows, facts, options))) {
    facts = { ...facts, opsReady: true };
  }
  const anyFirstAnswer = rows.some((r) => r.firstAnswerAt !== null);

  const out: ChannelTransition[] = [];
  for (const row of rows) {
    if (!asked(row)) continue;
    if (row.liveAt !== null) {
      out.push({ channel: row.channel, readied: false, wentLive: false, missing: [] });
      continue;
    }
    const decision = decideChannel(channelInputs(row.channel, facts));

    // Live, through its definer, which re-checks the four inputs itself.
    let wentLive = false;
    if (decision.live) {
      wentLive = await definerFlag(
        tx,
        sql`select app_channel_mark_live(${row.channel}, ${now}::timestamptz, ${actor}) as ok`,
      );
      if (!wentLive) {
        log.warn("channel not taken live: the database's inputs disagree", {
          clinicId: tx.clinicId,
          channel: row.channel,
        });
      }
    }
    // Ready on our side, through its definer, once.
    let readied = false;
    if (!wentLive && decision.ready && row.readyAt === null) {
      readied = await definerFlag(
        tx,
        sql`select app_channel_mark_ready(${row.channel}, ${now}::timestamptz, ${actor}) as ok`,
      );
    }
    const readyAt = row.readyAt ?? (readied || wentLive ? now : null);
    const waitingOn = wentLive || readyAt === null ? null : decision.waitingOn;
    const waitingChanged = !wentLive && waitingOn !== row.waitingOn;
    if (waitingChanged) {
      await tx.db
        .update(clinicChannels)
        .set({ waitingOn, updatedAt: now })
        .where(
          and(eq(clinicChannels.clinicId, tx.clinicId), eq(clinicChannels.channel, row.channel)),
        );
      if (waitingOn !== null) {
        await tx.db.insert(channelEvents).values({
          clinicId: tx.clinicId,
          channel: row.channel,
          kind: "waiting",
          waitingOn,
          actor,
          occurredAt: now,
        });
      }
    }
    if (readied || wentLive || waitingChanged) {
      audit({
        action: "update",
        resourceType: "clinic_channel",
        resourceId: tx.clinicId,
        metadata: {
          channel: row.channel,
          ready: readyAt !== null,
          waitingOn: waitingOn ?? "none",
          live: wentLive,
        },
      });
    }

    // O10: phone is ready and waiting on the clinic's forwarding. Queued now,
    // due an hour after readiness, and closed unsent at its due time if the
    // forwarding was done meanwhile (lib/email/superseded.ts). Once per
    // readiness, whatever this is asked.
    if (
      row.channel === "voice" &&
      waitingChanged &&
      waitingOn === "forwarding" &&
      readyAt &&
      facts.assistantNumberE164
    ) {
      await queueChannelReady(tx, {
        channel: "voice",
        ayaNumberE164: facts.assistantNumberE164,
        sendAfter: new Date(readyAt.getTime() + CHANNEL_READY_EMAIL_DELAY_MS),
      });
    }
    if (wentLive) {
      await queueChannelLive(tx, {
        channel: row.channel,
        slug: facts.slug,
        liveAt: now,
        isPlanStarted: anyFirstAnswer || (await billingStarted(tx)),
      });
    }
    out.push({
      channel: row.channel,
      readied,
      ...(waitingChanged ? { waitingOn } : {}),
      wentLive,
      missing: wentLive ? [] : decision.missing,
    });
  }
  return out;
}

export type EvaluateOptions = {
  /** Look at one channel only; go-live, when it happens, is the clinic's and asks every channel. */
  only?: Channel;
  now?: Date;
  /** On the event rows: 'system', 'ops', or the label of the device whose passkey did it. */
  actor?: string;
  /** What set an automatic go-live off, for its security event. A channel input, unless the caller says. */
  goLiveVia?: GoLiveVia;
};

/** The agreement's refusals: the practice's to put right, with our help, whatever else is ready. */
const AGREEMENT_CODES: ReadonlySet<GoLiveCode> = new Set([
  "no_agreement",
  "agreement_version",
  "agreement_kind_mismatch",
  "agreement_insufficient",
]);

/**
 * Take the clinic to production if go-live's preconditions all hold
 * (lib/onboarding/go-live.ts), inside the caller's transaction, which holds
 * the clinic's channel rows. True when it did. Asked only once a channel
 * has every input its `live` reads but the platform's attestations and
 * go-live itself (the clinic's part done), or when the agreement is what
 * stands in the way, which the practice cannot put right alone.
 *
 * A refusal leaves the clinic as it is: logged, and ops told once per
 * clinic and reason (go_live_held), when the clinic's part is done or the
 * agreement is the problem. Never a demo clinic's, never a leaving one's.
 */
async function goLiveIfReady(
  tx: TenantTx,
  rows: readonly ChannelRow[],
  facts: ReadinessFacts,
  options: EvaluateOptions,
): Promise<boolean> {
  const gates = channelGates(rows, facts);
  const clinicSideDone = gates.some((g) => g.missing.length === 0);
  const goLive = await readGoLiveFacts(tx, { channels: gates, platform: facts.platform.clinic });
  if (!goLive) return false;
  if (goLive.production) return true;
  const check = goLivePreconditions(goLive);
  if (!check.ok) {
    const codes = goLiveCodes(check);
    if (codes.includes("leaving") || codes.includes("demo")) return false;
    const agreement = codes.find((c) => AGREEMENT_CODES.has(c));
    if (clinicSideDone || agreement) {
      await notifyOpsOnce("go_live_held", {
        clinicId: tx.clinicId,
        code: agreement ?? codes[0]!,
        count: codes.length,
      });
    }
    return false;
  }
  const result = await markClinicProduction(tx, {
    via: options.goLiveVia ?? "channel_event",
    clinicSlug: facts.slug,
  });
  if (result.status === "live") {
    log.info("clinic went live", { clinicId: tx.clinicId, source: options.goLiveVia ?? "channel_event" });
    return true;
  }
  // The preconditions held here and the database's own check refused: the
  // two disagree, which tests/go-live.test.ts exists to prevent.
  log.error("go-live refused by the database", { clinicId: tx.clinicId, reason: result.reason });
  await notifyOpsOnce("go_live_held", { clinicId: tx.clinicId, code: "database" });
  return false;
}

/**
 * Where go-live stands for the tenant's clinic, read without a lock: for the
 * operator's go-live view and "Check go-live now" (lib/ops/api.ts) and Home's
 * tracker (lib/portal/home.ts). Null when there is no such clinic.
 */
export async function readGoLiveCheck(
  tx: TenantTx,
  now: Date = new Date(),
): Promise<{ production: boolean; check: GoLiveCheck } | null> {
  const rows = await tx.db
    .select(ROW)
    .from(clinicChannels)
    .where(eq(clinicChannels.clinicId, tx.clinicId))
    .orderBy(asc(clinicChannels.channel));
  const facts = await readReadinessFacts(
    tx,
    rows.map((r) => r.channel),
    now,
  );
  if (!facts) return null;
  const goLive = await readGoLiveFacts(tx, {
    channels: channelGates(rows, facts),
    platform: facts.platform.clinic,
  });
  if (!goLive) return null;
  return { production: goLive.production, check: goLivePreconditions(goLive) };
}

/** The clinic's own plan has started (a billing clinic's row; a location has none it can read). */
async function billingStarted(tx: TenantTx): Promise<boolean> {
  const [row] = await tx.db
    .select({
      planStartedAt: entitlements.planStartedAt,
      planStartAppliedAt: entitlements.planStartAppliedAt,
    })
    .from(entitlements)
    .where(eq(entitlements.clinicId, tx.clinicId))
    .limit(1);
  return row ? hasPlanStarted(row) : false;
}

/**
 * L1, once per channel, in a savepoint: an email that cannot be queued is
 * logged and never undoes the go-live it announces.
 */
async function queueChannelLive(
  tx: TenantTx,
  input: { channel: Channel; slug: string; liveAt: Date; isPlanStarted: boolean },
): Promise<void> {
  try {
    if (publicOriginProblem()) {
      log.error("channel-live email not queued: no public origin", {
        clinicId: tx.clinicId,
        channel: input.channel,
      });
      return;
    }
    await tx.db.transaction(async (savepoint) => {
      await enqueuePlanNotice(
        savepoint,
        tx.clinicId,
        "channel_live",
        `channel_live:${input.channel}`,
        {
          channel: input.channel,
          liveAt: input.liveAt.toISOString(),
          isPlanStarted: input.isPlanStarted,
          homeUrl: publicUrl(`/c/${input.slug}`),
          settingsUrl: publicUrl(`/c/${input.slug}/settings`),
          helpPhoneE164: helpContacts().phoneE164,
        },
      );
    });
  } catch (error) {
    log.error("channel-live email not queued", {
      clinicId: tx.clinicId,
      channel: input.channel,
      error: describeError(error),
    });
  }
}

// -----------------------------------------------------------------------------
// Website chat's line on the clinic's site
// -----------------------------------------------------------------------------

/**
 * The widget opened from the clinic's website, by its Origin header. That is
 * never proof the line is on the site: any client can send any Origin, and
 * taking website chat live, and starting its billing, on one would let anyone
 * do both to any clinic. So a load records nothing. While website chat is
 * waiting on its line, the first such load asks an operator, once, to look at
 * the site and confirm it (`confirmWidgetOnSite`, the ops envelope's
 * confirmWebWidget). Never throws.
 */
export async function noteWidgetLoaded(
  clinicId: string,
  input: { actor: ActorContext },
): Promise<void> {
  try {
    const waiting = await withTenant({ clinicId, actor: input.actor }, async (tx) => {
      const [row] = await tx.db
        .select({ liveAt: clinicChannels.liveAt, waitingOn: clinicChannels.waitingOn })
        .from(clinicChannels)
        .where(and(eq(clinicChannels.clinicId, tx.clinicId), eq(clinicChannels.channel, "web")))
        .limit(1);
      return row !== undefined && row.liveAt === null && row.waitingOn === "snippet";
    });
    if (waiting) await notifyOpsOnce("web_widget_to_confirm", { clinicId, channel: "web" });
  } catch (error) {
    log.error("widget load not noted", { clinicId, channel: "web", error: describeError(error) });
  }
}

/**
 * An operator looked at the clinic's website and saw its chat: website chat's
 * runtime is present. Recorded once, through drizzle/0079's definer, with
 * actor `ops`; the caller then moves the channel on.
 */
export async function confirmWidgetOnSite(tx: TenantTx): Promise<{ recorded: boolean }> {
  const recorded = await definerFlag(
    tx,
    sql`select app_channel_record_input('web', 'runtime_seen', 'ops_confirmed') as ok`,
  );
  if (recorded) {
    tx.audit.record({
      action: "update",
      resourceType: "clinic_channel",
      resourceId: tx.clinicId,
      metadata: { channel: "web", input: "runtime_seen", via: "ops_confirmed" },
    });
  }
  return { recorded };
}

// -----------------------------------------------------------------------------
// first_answer
// -----------------------------------------------------------------------------

/** What a runtime knows about the conversation it just answered. */
export type FirstAnswerEvidence = {
  channel: Channel;
  /**
   * Which path answered. Only the runtimes' adapters (voice ingest, web chat,
   * the Meta webhook) answer patients; the preview (Talk to your AYA) and the
   * practice questions run the same brain and never count.
   */
  source: "runtime" | "preview" | "practice";
  /** The answer gate said answer: not a pass-through, not the safe script for a refused call. */
  gateAnswered: boolean;
  /** The person said or wrote something, and AYA answered it, not only with the failure line. */
  personAnswered: boolean;
  /** Healdesk's own test call: a forwarding test's window, or one of HEALDESK_TEST_NUMBERS. */
  healdeskTest?: boolean;
  /** A call from one of the clinic's own numbers. */
  ownNumber?: boolean;
  /** A web chat opened from a page on the clinic's own machine (localhost), not its website. */
  localTest?: boolean;
  /**
   * The conversation: a call or a web chat's conversations row, a Meta DM's
   * chat thread. The definer records a first answer only for one that exists.
   */
  conversationId?: string | null;
};

export type FirstAnswerExclusion =
  | "preview"
  | "practice"
  | "not_answered"
  | "no_conversation"
  | "healdesk_test"
  | "own_number"
  | "local_test";

/** Pure: why this answer can never be a first answer, or null when it can. */
export function firstAnswerExclusion(evidence: FirstAnswerEvidence): FirstAnswerExclusion | null {
  if (evidence.source === "preview") return "preview";
  if (evidence.source === "practice") return "practice";
  if (!evidence.gateAnswered) return "not_answered";
  if (evidence.healdeskTest) return "healdesk_test";
  if (evidence.ownNumber) return "own_number";
  if (evidence.localTest) return "local_test";
  if (!evidence.personAnswered) return "no_conversation";
  return null;
}

/**
 * A finished call's evidence, from what the voice ingest already holds: the
 * gate's answer and a real answer on the call (the Retell process's
 * `answeredByAssistant`), whether the caller spoke (an `abandoned` call had
 * no caller turn), and the exclusions the call's metering already found
 * (voiceMeteringFor: Healdesk's test calls and the clinic's own numbers).
 */
export function voiceFirstAnswerEvidence(
  event: Pick<VoiceCallEvent, "answeredByAssistant" | "outcome">,
  metering: VoiceMetering,
  conversationId: string,
): FirstAnswerEvidence {
  const skipped = "skipped" in metering ? metering.skipped : null;
  return {
    channel: "voice",
    source: "runtime",
    gateAnswered: event.answeredByAssistant === true,
    personAnswered:
      event.outcome !== undefined && event.outcome !== "abandoned" && event.outcome !== "spam",
    healdeskTest: skipped === "test_call",
    ownNumber: skipped === "own_number",
    conversationId,
  };
}

export type FirstAnswerResult =
  | {
      recorded: false;
      reason:
        FirstAnswerExclusion | "not_bought" | "not_live" | "already" | "no_evidence" | "failed";
    }
  | {
      recorded: true;
      /** The clinic's first answered channel starts the plan; each later one steps it up. */
      billing: "plan_start" | "step_up";
      /** Whether the billing request was new (one per clinic, kind and channel). */
      billingRecorded: boolean;
    };

const DEFINER_OUTCOMES = new Set(["recorded", "already", "not_bought", "not_live", "no_evidence"]);

/**
 * Record the channel's first answer, if this is it, inside the caller's
 * transaction (the one that records the conversation), with the billing
 * request that prices it in: `startPlan(first_answer)` for the clinic's first
 * answered channel, `stepUpPackage(channel, first_answer)` for each later
 * one.
 *
 * Once per channel, three ways over: the definer (drizzle/0079, 0085) sets
 * `first_answer_at` once, for a conversation that exists on the channel; the
 * channel rows are locked in channel order while it is decided; and the
 * partial unique index on channel_events (drizzle/0044) refuses a second
 * first_answer row. The billing ledger keeps one request per clinic, kind and
 * channel, so a second call records nothing there either.
 *
 * All of it, the first read included, runs in a savepoint: a failure (a
 * statement timeout, the billing definer refusing) rolls back the event and
 * its request together, is logged, tells ops once an hour per clinic and
 * channel (`first_answer_not_recorded`), and leaves the caller's
 * conversation recorded; the channel's next answered conversation tries
 * again. Never throws.
 *
 * The first answer's time is the database's clock, stamped inside the
 * definer (drizzle/0085), as the destruction and the record clocks are: it
 * is billing evidence, the day a channel's price joins, so no caller chooses
 * it.
 */
export async function recordFirstAnswer(
  tx: TenantTx,
  evidence: FirstAnswerEvidence,
): Promise<FirstAnswerResult> {
  const excluded = firstAnswerExclusion(evidence);
  if (excluded) return { recorded: false, reason: excluded };
  const { channel } = evidence;
  try {
    const result = await tx.db.transaction(async (savepoint): Promise<FirstAnswerResult> => {
      const scoped: TenantTx = { ...tx, db: savepoint };
      // Unlocked first: once a channel has its first answer, every later
      // conversation stops here without taking the channel rows' locks.
      const [seen] = await savepoint
        .select({ liveAt: clinicChannels.liveAt, firstAnswerAt: clinicChannels.firstAnswerAt })
        .from(clinicChannels)
        .where(and(eq(clinicChannels.clinicId, tx.clinicId), eq(clinicChannels.channel, channel)))
        .limit(1);
      if (!seen) return { recorded: false, reason: "not_bought" };
      if (seen.firstAnswerAt !== null) return { recorded: false, reason: "already" };
      if (seen.liveAt === null) return { recorded: false, reason: "not_live" };

      const rows = await lockChannelRows(scoped);
      const row = rows.find((r) => r.channel === channel);
      if (!row) return { recorded: false, reason: "not_bought" };
      if (row.firstAnswerAt !== null) return { recorded: false, reason: "already" };
      // The clinic's first answered channel starts the plan, unless the
      // plan has started already (a row billed in full from its first
      // invoice): then, like every later channel, it steps the plan up.
      const first = !rows.some((r) => r.firstAnswerAt !== null) && !(await billingStarted(scoped));
      const billing = first ? "plan_start" : "step_up";

      const outcome = await savepoint.execute<{ outcome: string }>(
        sql`select app_channel_record_first_answer(${channel}, ${evidence.conversationId ?? null}::uuid, ${billing}) as outcome`,
      );
      const recorded = outcome.rows[0]?.outcome ?? "";
      if (recorded !== "recorded") {
        return {
          recorded: false,
          reason: DEFINER_OUTCOMES.has(recorded)
            ? (recorded as "already" | "not_bought" | "not_live" | "no_evidence")
            : "failed",
        };
      }
      // A location's channels are billed on its billing clinic, through
      // app_record_billing_request (drizzle/0050) from this location's own
      // tenant. When locations exist (LOCATION_CLINICS_READY), a location's
      // step-up is recorded in the billing clinic's own transaction.
      const request = first
        ? await startPlan(scoped, tx.clinicId, "first_answer")
        : await stepUpPackage(scoped, tx.clinicId, channel, "first_answer");
      return { recorded: true, billing, billingRecorded: request.recorded };
    });
    if (result.recorded) {
      // After the savepoint, so a rolled-back first answer leaves no audit row claiming it.
      tx.audit.record({
        action: "update",
        resourceType: "clinic_channel",
        resourceId: tx.clinicId,
        metadata: { channel, input: "first_answer", billing: result.billing },
      });
      log.info("first answer recorded", {
        clinicId: tx.clinicId,
        channel,
        outcome: result.billing,
      });
    }
    return result;
  } catch (error) {
    log.error("first answer not recorded", {
      clinicId: tx.clinicId,
      channel,
      error: describeError(error),
    });
    await notifyOps("first_answer_not_recorded", { clinicId: tx.clinicId, channel });
    return { recorded: false, reason: "failed" };
  }
}

// -----------------------------------------------------------------------------
// The hourly sweep
// -----------------------------------------------------------------------------

const SWEEP_ACTOR: ActorContext = { type: "service", serviceName: "channel-states" };

/**
 * Every clinic that has not left, its channels moved on as far as their
 * inputs allow: the backstop for an input whose own event did not ask (a
 * direct line added in Settings, a caller that failed). Synthetic clinics
 * too, because phone is ready, and the clinic told to forward, before go-live.
 * Not a switched job: it is a pure function of rows that already exist, and
 * every input it acts on was set by the clinic or an operator. Each clinic in
 * its own transaction, one after another; one clinic's failure is logged and
 * the sweep carries on.
 */
export async function sweepChannelStates(
  now: Date = new Date(),
): Promise<{ clinics: number; readied: number; live: number; failures: number }> {
  const result = await unsafeDb.execute<{ id: string }>(
    sql`select id from app_clinics_overview()
         where offboarding_started_at is null
           and destroyed_at is null`,
  );
  const ids = ((result as unknown as { rows?: { id: string }[] }).rows ?? []).map((r) =>
    String(r.id),
  );
  const summary = { clinics: ids.length, readied: 0, live: 0, failures: 0 };
  for (const clinicId of ids) {
    try {
      const moved = await withTenant({ clinicId, actor: SWEEP_ACTOR }, (tx) =>
        evaluateChannels(tx, { now, goLiveVia: "sweep" }),
      );
      summary.readied += moved.filter((m) => m.readied).length;
      summary.live += moved.filter((m) => m.wentLive).length;
    } catch (error) {
      summary.failures += 1;
      log.error("channel states not swept", { clinicId, error: describeError(error) });
    }
  }
  return summary;
}
