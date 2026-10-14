import type { Channel } from "@healdesk/catalog";
import { and, asc, eq, isNull, sql } from "drizzle-orm";

import { unsafeDb } from "@/db";
import {
  channelEvents,
  clinicChannels,
  clinics,
  clinicSettings,
  entitlements,
  type ChannelWaitingOn,
} from "@/db/schema";
import type { ActorContext } from "@/lib/audit";
import { hasPlanStarted } from "@/lib/billing/entitlements";
import { startPlan, stepUpPackage } from "@/lib/billing/requests";
import { describeError, log } from "@/lib/log";
import { queueChannelReady } from "@/lib/notices/channel-ready";
import { enqueuePlanNotice } from "@/lib/notices/plan-notices";
import { publicOriginProblem, publicUrl } from "@/lib/public-url";
import { helpContacts } from "@/lib/setup/help";
import { readProgress, screensFor, wizardFinished } from "@/lib/setup/screens";
import { withTenant, type TenantTx } from "@/lib/tenant";
import type { VoiceCallEvent, VoiceMetering } from "@/lib/voice/ingest";

import { channelsWithAuditPassed } from "./audit-seam";
import { connectedMetaPlatforms } from "./meta-platforms";

/**
 * Channel events (plan Part G; contracts §7): the one writer of a channel's
 * `ready`, `waiting_on`, `live` and `first_answer`, to `clinic_channels`
 * (`ready_at`, `waiting_on`, `live_at`, `first_answer_at`) and, append-only,
 * to `channel_events`. The answer gate (lib/billing/answering.ts) refuses a
 * channel whose `live_at` is null, so until something here records `live`,
 * no production channel answers anyone.
 *
 * ## live
 *
 * A channel goes live on four inputs, all of them required and none of them
 * a default:
 *
 *   1. **the operator's go-live**: the clinic is in production
 *      (app_mark_clinic_production, which only the operator's go-live calls
 *      until package WP2 makes it automatic). That is the ops-attested
 *      readiness: the agreement, the covered status and the operator's
 *      checklist (lib/onboarding/go-live.ts);
 *   2. **the channel's audit passed**: lib/channels/audit-seam.ts, the seam
 *      the practice questions replace; until they exist only an operator
 *      records it;
 *   3. **the channel's runtime is present**:
 *        - phone: AYA's number on the clinic row (`assistant_number_e164`),
 *          which an operator enters once the clinic's Retell agent and number
 *          exist; and the forwarding to it confirmed, by the forwarding test
 *          (`test_call_passed`: Healdesk's test call reached her with the
 *          caller's number intact, lib/onboarding/forwarding-test.ts);
 *        - website chat: the widget has loaded on the clinic's own website
 *          (`runtime_seen`, recorded by lib/chat/web-chat.ts the first time
 *          the widget opens there; spec: "The dashboard detects the first
 *          time the widget loads on the clinic's domain and flips the channel
 *          to live automatically");
 *        - Instagram, Messenger & WhatsApp: a platform connected, behind the
 *          operator's Meta front door (`meta_front_door_enabled`, which itself
 *          needs a production clinic, a published number and a released
 *          agreement);
 *   4. **setup done**: the wizard's four steps are finished, and for phone
 *      the direct line is on file, because every call AYA can't answer goes
 *      there (CLAUDE.md, "Failure").
 *
 * `ready` is "ready on our side": 1, 2 and our half of 3 (AYA's number, the
 * front door; website chat has no part of its own). A ready channel that is
 * not live is waiting on the clinic for one thing, `waiting_on`: finishing
 * setup, then the clinic's half of 3 (the line on its website, the
 * forwarding, the Facebook login). `ready_at` is set once and kept; `live_at`
 * is set once and kept, so a channel never goes live twice and L1 is sent
 * once. A precondition lost after go-live does not un-live a channel: the
 * answer gate and the runtimes refuse on what is true now (the front door,
 * the number, the switches, the pause).
 *
 * Every transition is in the caller's transaction, with the channel's row
 * locked (rows are always locked in channel order, here and in the first
 * answer, so two writers never deadlock). Its callers are the events that
 * change an input (the operator's go-live, audit attestation, phone settings
 * and front door; a Meta connection; the forwarding test; the widget's first
 * load; a setup screen saved), and the hourly sweep (`sweepChannelStates`)
 * catches anything they missed.
 *
 * ## first_answer
 *
 * The first inbound patient conversation answered on a live channel: the day
 * its price joins the plan (spec: "Monthly billing starts the day the
 * assistant first answers a patient"). The clinic's first one records
 * healdesk-io-58's `startPlan(first_answer)`; each later channel's records
 * `stepUpPackage(channel, first_answer)` (lib/billing/requests.ts), in the
 * same transaction as the event, so both commit or neither does. It excludes
 * Healdesk's test calls (the forwarding-test window), calls from the
 * clinic's own published, direct or AYA numbers (voiceMeteringFor,
 * lib/voice/ingest.ts), a web chat opened from the clinic's own machine
 * (localhost), anything the answer gate passed through, a conversation in
 * which the person never said anything, and the preview and the practice
 * questions, which never reach the runtimes' callers and are refused by name
 * if they ever do (`firstAnswerExclusion`).
 *
 * Tenant plane, no patient data: channels, codes, ids and times.
 */

// -----------------------------------------------------------------------------
// live: the decision
// -----------------------------------------------------------------------------

/** One of the inputs `live` waits for, in the order the operator console names them. */
export type LiveInput =
  "leaving" | "go_live" | "audit" | "runtime" | "setup" | "direct_line" | "clinic_step";

export type ChannelInputs = {
  channel: Channel;
  /** The clinic is offboarding or destroyed: nothing goes live. */
  leaving: boolean;
  /** Ops-attested readiness: the operator's go-live put the clinic in production. */
  opsReady: boolean;
  /** The seam the practice questions replace (lib/channels/audit-seam.ts). */
  auditPassed: boolean;
  /** Our half of the runtime: phone, AYA's number; Meta, the front door; website chat, none. */
  runtimeOurs: boolean;
  /** The wizard's four steps are finished. */
  setupDone: boolean;
  /** Phone only: the direct line is on file. True for the other channels. */
  directLine: boolean;
  /** The clinic's half: phone, forwarding confirmed; website chat, the widget seen on its site; Meta, a platform connected. */
  clinicStepDone: boolean;
};

export type ChannelDecision = {
  /** Ready on our side. */
  ready: boolean;
  /** While ready and not live, the clinic's one outstanding action. */
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

/** Pure: whether a channel is ready on our side, what it waits on, and whether it is live. */
export function decideChannel(inputs: ChannelInputs): ChannelDecision {
  if (inputs.leaving) return { ready: false, waitingOn: null, live: false, missing: ["leaving"] };
  const ours: LiveInput[] = [];
  if (!inputs.opsReady) ours.push("go_live");
  if (!inputs.auditPassed) ours.push("audit");
  if (!inputs.runtimeOurs) ours.push("runtime");
  const theirs: LiveInput[] = [];
  if (!inputs.setupDone) theirs.push("setup");
  if (inputs.channel === "voice" && !inputs.directLine) theirs.push("direct_line");
  if (!inputs.clinicStepDone) theirs.push("clinic_step");
  const ready = ours.length === 0;
  const live = ready && theirs.length === 0;
  const waitingOn: ChannelWaitingOn | null =
    ready && !live ? (theirs[0] === "clinic_step" ? CLINIC_STEP[inputs.channel] : "setup") : null;
  return { ready, waitingOn, live, missing: [...ours, ...theirs] };
}

// -----------------------------------------------------------------------------
// live: the facts
// -----------------------------------------------------------------------------

/** Everything `decideChannel` reads, for every channel of one clinic. */
export type ReadinessFacts = {
  slug: string;
  leaving: boolean;
  opsReady: boolean;
  setupDone: boolean;
  directLine: boolean;
  assistantNumberE164: string | null;
  metaFrontDoor: boolean;
  metaConnected: boolean;
  forwardingConfirmed: boolean;
  auditPassed: ReadonlySet<Channel>;
  runtimeSeen: ReadonlySet<Channel>;
};

/** The inputs for one channel, from the clinic's facts. */
export function channelInputs(channel: Channel, facts: ReadinessFacts): ChannelInputs {
  return {
    channel,
    leaving: facts.leaving,
    opsReady: facts.opsReady,
    auditPassed: facts.auditPassed.has(channel),
    runtimeOurs:
      channel === "voice"
        ? facts.assistantNumberE164 !== null
        : channel === "meta"
          ? facts.metaFrontDoor
          : true,
    setupDone: facts.setupDone,
    directLine: channel === "voice" ? facts.directLine : true,
    clinicStepDone:
      channel === "voice"
        ? facts.forwardingConfirmed
        : channel === "meta"
          ? facts.metaConnected
          : facts.runtimeSeen.has("web"),
  };
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
    .select({ directLine: clinicSettings.directLineE164 })
    .from(clinicSettings)
    .where(eq(clinicSettings.clinicId, tx.clinicId))
    .limit(1);
  return {
    slug: clinic.slug,
    leaving: clinic.offboardingStartedAt !== null || clinic.destroyedAt !== null,
    opsReady: clinic.dataClassification === "production",
    setupDone: wizardFinished(screens, progress),
    directLine: Boolean(settings?.directLine),
    assistantNumberE164: clinic.assistantNumberE164,
    metaFrontDoor: clinic.metaFrontDoorEnabled,
    metaConnected: bought.includes("meta")
      ? (await connectedMetaPlatforms(tx.db, tx.clinicId)).length > 0
      : false,
    forwardingConfirmed: Boolean(
      (clinic.onboarding as Record<string, unknown> | null)?.test_call_passed,
    ),
    auditPassed: await channelsWithEvent(tx, "audit_passed"),
    runtimeSeen: await channelsWithEvent(tx, "runtime_seen"),
  };
}

// -----------------------------------------------------------------------------
// live: the writer
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

type LockedRow = {
  channel: Channel;
  readyAt: Date | null;
  waitingOn: ChannelWaitingOn | null;
  liveAt: Date | null;
  firstAnswerAt: Date | null;
};

/** The clinic's channel rows, locked in channel order. */
async function lockChannelRows(tx: TenantTx): Promise<LockedRow[]> {
  return tx.db
    .select({
      channel: clinicChannels.channel,
      readyAt: clinicChannels.readyAt,
      waitingOn: clinicChannels.waitingOn,
      liveAt: clinicChannels.liveAt,
      firstAnswerAt: clinicChannels.firstAnswerAt,
    })
    .from(clinicChannels)
    .where(eq(clinicChannels.clinicId, tx.clinicId))
    .orderBy(asc(clinicChannels.channel))
    .for("update");
}

/**
 * Move the clinic's channels on as far as their inputs allow, inside the
 * caller's transaction: ready, waiting on the clinic, live. Idempotent: a
 * channel already where its inputs put it writes nothing. Returns one entry
 * per channel looked at.
 *
 * `only` limits it to one channel. `actor` goes on the event rows: 'system',
 * 'ops', or the label of the device whose passkey did it.
 */
export async function evaluateChannels(
  tx: TenantTx,
  options: { only?: Channel; now?: Date; actor?: string } = {},
): Promise<ChannelTransition[]> {
  const now = options.now ?? new Date();
  const actor = (options.actor ?? "system").slice(0, 200);
  const rows = await lockChannelRows(tx);
  if (rows.length === 0) return [];
  const facts = await readReadinessFacts(
    tx,
    rows.map((r) => r.channel),
  );
  if (!facts) return [];
  const anyFirstAnswer = rows.some((r) => r.firstAnswerAt !== null);

  const out: ChannelTransition[] = [];
  for (const row of rows) {
    if (options.only && row.channel !== options.only) continue;
    const decision = decideChannel(channelInputs(row.channel, facts));
    // Live is final: nothing here moves a live channel.
    if (row.liveAt !== null) {
      out.push({ channel: row.channel, readied: false, wentLive: false, missing: [] });
      continue;
    }
    const readied = decision.ready && row.readyAt === null;
    const readyAt = row.readyAt ?? (decision.ready ? now : null);
    const waitingOn = decision.live ? null : decision.waitingOn;
    const waitingChanged = waitingOn !== row.waitingOn;
    if (!readied && !waitingChanged && !decision.live) {
      out.push({ channel: row.channel, readied, wentLive: false, missing: decision.missing });
      continue;
    }

    await tx.db
      .update(clinicChannels)
      .set({
        readyAt,
        waitingOn,
        ...(decision.live ? { liveAt: now } : {}),
        updatedAt: now,
      })
      .where(
        and(eq(clinicChannels.clinicId, tx.clinicId), eq(clinicChannels.channel, row.channel)),
      );

    const events: (typeof channelEvents.$inferInsert)[] = [];
    if (readied)
      events.push({
        clinicId: tx.clinicId,
        channel: row.channel,
        kind: "ready",
        actor,
        occurredAt: now,
      });
    if (waitingChanged && waitingOn !== null) {
      events.push({
        clinicId: tx.clinicId,
        channel: row.channel,
        kind: "waiting",
        waitingOn,
        actor,
        occurredAt: now,
      });
    }
    if (decision.live)
      events.push({
        clinicId: tx.clinicId,
        channel: row.channel,
        kind: "live",
        actor,
        occurredAt: now,
      });
    if (events.length > 0) await tx.db.insert(channelEvents).values(events);
    tx.audit.record({
      action: "update",
      resourceType: "clinic_channel",
      resourceId: tx.clinicId,
      metadata: {
        channel: row.channel,
        ready: decision.ready,
        waitingOn: waitingOn ?? "none",
        live: decision.live,
      },
    });

    // O10: phone is ready and waiting on the clinic's forwarding. Queued now,
    // due an hour after readiness, and closed unsent at its due time if the
    // forwarding was done meanwhile (lib/email/superseded.ts). Once per
    // readiness, whatever this is asked.
    if (
      row.channel === "voice" &&
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
    if (decision.live) {
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
      wentLive: decision.live,
      missing: decision.missing,
    });
  }
  return out;
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
// runtime_seen: website chat's widget on the clinic's own site
// -----------------------------------------------------------------------------

/**
 * The widget opened on the clinic's own website (the caller checked the
 * origin, lib/chat/web-chat.ts): record it the first time, and see whether
 * website chat can now go live, in one transaction of its own, before the
 * answer gate is asked, so the very load that proves the line is on the site
 * is answered. Once website chat is live, or the load was recorded before,
 * this reads one row and writes nothing, so a busy site costs a read per
 * load. Never throws: a failure is logged, and the widget carries on.
 */
export async function noteWidgetLoaded(
  clinicId: string,
  input: { now?: Date; actor: ActorContext },
): Promise<void> {
  const now = input.now ?? new Date();
  try {
    await withTenant({ clinicId, actor: input.actor }, async (tx) => {
      const [row] = await tx.db
        .select({ liveAt: clinicChannels.liveAt })
        .from(clinicChannels)
        .where(and(eq(clinicChannels.clinicId, tx.clinicId), eq(clinicChannels.channel, "web")))
        .limit(1);
      if (!row || row.liveAt !== null) return;
      const [locked] = await tx.db
        .select({ channel: clinicChannels.channel })
        .from(clinicChannels)
        .where(and(eq(clinicChannels.clinicId, tx.clinicId), eq(clinicChannels.channel, "web")))
        .for("update");
      if (!locked) return;
      if ((await channelsWithEvent(tx, "runtime_seen")).has("web")) return;
      await tx.db.insert(channelEvents).values({
        clinicId: tx.clinicId,
        channel: "web",
        kind: "runtime_seen",
        actor: "system",
        detail: { via: "widget" },
        occurredAt: now,
      });
      tx.audit.record({
        action: "update",
        resourceType: "clinic_channel",
        resourceId: tx.clinicId,
        metadata: { channel: "web", input: "runtime_seen" },
      });
      await evaluateChannels(tx, { only: "web", now });
    });
  } catch (error) {
    log.error("widget load not recorded", {
      clinicId,
      channel: "web",
      error: describeError(error),
    });
  }
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
  /** The person said or wrote something, and AYA replied. */
  personAnswered: boolean;
  /** Healdesk's own test call: the forwarding-test window. */
  healdeskTest?: boolean;
  /** A call from one of the clinic's own numbers: its published line, its direct line, AYA's. */
  ownNumber?: boolean;
  /** A web chat opened from a page on the clinic's own machine (localhost), not its website. */
  localTest?: boolean;
  /** The conversation, for the event's record. */
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
 * gate's answer (the Retell process's `answeredByAssistant`), whether the
 * caller spoke (an `abandoned` call had no caller turn), and the exclusions
 * the call's metering already found (voiceMeteringFor: the forwarding test's
 * window, and the clinic's own published, direct and AYA numbers).
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
      reason: FirstAnswerExclusion | "not_bought" | "not_live" | "already" | "failed";
    }
  | {
      recorded: true;
      /** The clinic's first answered channel starts the plan; each later one steps it up. */
      billing: "plan_start" | "step_up";
      /** Whether the billing request was new (one per clinic, kind and channel). */
      billingRecorded: boolean;
    };

/**
 * Record the channel's first answer, if this is it, inside the caller's
 * transaction (the one that records the conversation), with the billing
 * request that prices it in: `startPlan(first_answer)` for the clinic's first
 * answered channel, `stepUpPackage(channel, first_answer)` for each later
 * one.
 *
 * Once per channel, three ways over: `first_answer_at` is set once, the
 * channel rows are locked while it is decided, and the partial unique index
 * on channel_events (drizzle/0044) refuses a second first_answer row. The
 * billing ledger keeps one request per clinic, kind and channel, so a second
 * call records nothing there either.
 *
 * All of it runs in a savepoint: a failure (the billing definer refusing,
 * say) rolls back the event and its request together, is logged, and leaves
 * the caller's conversation recorded; the channel's next answered
 * conversation tries again. Never throws.
 */
export async function recordFirstAnswer(
  tx: TenantTx,
  evidence: FirstAnswerEvidence,
  now: Date = new Date(),
): Promise<FirstAnswerResult> {
  const excluded = firstAnswerExclusion(evidence);
  if (excluded) return { recorded: false, reason: excluded };
  const { channel } = evidence;
  try {
    // Unlocked first: once a channel has its first answer, every later
    // conversation stops here without taking the channel rows' locks.
    const [seen] = await tx.db
      .select({ liveAt: clinicChannels.liveAt, firstAnswerAt: clinicChannels.firstAnswerAt })
      .from(clinicChannels)
      .where(and(eq(clinicChannels.clinicId, tx.clinicId), eq(clinicChannels.channel, channel)))
      .limit(1);
    if (!seen) return { recorded: false, reason: "not_bought" };
    if (seen.firstAnswerAt !== null) return { recorded: false, reason: "already" };
    if (seen.liveAt === null) return { recorded: false, reason: "not_live" };

    const result = await tx.db.transaction(async (savepoint): Promise<FirstAnswerResult> => {
      const scoped: TenantTx = { ...tx, db: savepoint };
      const rows = await lockChannelRows(scoped);
      const row = rows.find((r) => r.channel === channel);
      if (!row) return { recorded: false, reason: "not_bought" };
      if (row.firstAnswerAt !== null) return { recorded: false, reason: "already" };
      if (row.liveAt === null) return { recorded: false, reason: "not_live" };
      // The clinic's first answered channel starts the plan, unless the
      // plan has started already (a row billed in full from its first
      // invoice): then, like every later channel, it steps the plan up.
      const first = !rows.some((r) => r.firstAnswerAt !== null) && !(await billingStarted(scoped));

      const inserted = await savepoint
        .insert(channelEvents)
        .values({
          clinicId: tx.clinicId,
          channel,
          kind: "first_answer",
          actor: "system",
          detail: {
            source: evidence.source,
            billing: first ? "plan_start" : "step_up",
            ...(evidence.conversationId ? { conversationId: evidence.conversationId } : {}),
          },
          occurredAt: now,
        })
        .onConflictDoNothing({
          target: [channelEvents.clinicId, channelEvents.channel],
          // The index is partial: the predicate goes with the target, or
          // Postgres cannot infer it (42P10).
          where: sql`${channelEvents.kind} = 'first_answer'`,
        })
        .returning({ id: channelEvents.id });
      if (inserted.length === 0) return { recorded: false, reason: "already" };

      await savepoint
        .update(clinicChannels)
        .set({ firstAnswerAt: now, updatedAt: now })
        .where(
          and(
            eq(clinicChannels.clinicId, tx.clinicId),
            eq(clinicChannels.channel, channel),
            isNull(clinicChannels.firstAnswerAt),
          ),
        );
      const billing = first
        ? await startPlan(scoped, tx.clinicId, "first_answer")
        : await stepUpPackage(scoped, tx.clinicId, channel, "first_answer");
      return {
        recorded: true,
        billing: first ? "plan_start" : "step_up",
        billingRecorded: billing.recorded,
      };
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
    return { recorded: false, reason: "failed" };
  }
}

// -----------------------------------------------------------------------------
// The hourly sweep
// -----------------------------------------------------------------------------

const SWEEP_ACTOR: ActorContext = { type: "service", serviceName: "channel-states" };

/**
 * Every production clinic that has not left, its channels moved on as far as
 * their inputs allow: the backstop for an input whose own event did not ask
 * (a direct line added in Settings, a caller that failed). Not a switched
 * job: it is a pure function of rows that already exist, and every input it
 * acts on was set by the clinic or an operator. Each clinic in its own
 * transaction, one after another; one clinic's failure is logged and the
 * sweep carries on.
 */
export async function sweepChannelStates(
  now: Date = new Date(),
): Promise<{ clinics: number; readied: number; live: number; failures: number }> {
  const result = await unsafeDb.execute<{ id: string }>(
    sql`select id from app_clinics_overview()
         where data_classification = 'production'
           and offboarding_started_at is null
           and destroyed_at is null`,
  );
  const ids = ((result as unknown as { rows?: { id: string }[] }).rows ?? []).map((r) =>
    String(r.id),
  );
  const summary = { clinics: ids.length, readied: 0, live: 0, failures: 0 };
  for (const clinicId of ids) {
    try {
      const moved = await withTenant({ clinicId, actor: SWEEP_ACTOR }, (tx) =>
        evaluateChannels(tx, { now }),
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
