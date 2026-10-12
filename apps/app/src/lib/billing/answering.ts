import { COVERAGE_MODES, type Channel } from "@healdesk/catalog";
import { and, eq, sql } from "drizzle-orm";

import type { Transaction } from "@/db";
import {
  clinicChannels,
  clinics,
  clinicSettings,
  usageEvents,
  type BillingStatus,
  type ChannelsEnabled,
  type UsageMeter,
  type UsageSource,
} from "@/db/schema";
import type { ActorContext } from "@/lib/audit";
import { isPaused, type ClinicPause } from "@/lib/channels/state";
import { clinicLocalDate, closedOn } from "@/lib/clinic/closures";
import { isOpenAt, parseOpeningHours } from "@/lib/clinic/opening-hours";
import { notifyOps, notifyOpsOnce } from "@/lib/ops/notify";
import { withTenant } from "@/lib/tenant";

import { effectiveIncluded, getEntitlements, hasPlanStarted } from "./entitlements";
import { deliverCriticalAfterCommit } from "./notices";
import { enqueueAllowanceFallback, openWindowAt, usedOf } from "./usage";

/**
 * May the assistant answer this call or conversation? The one place every
 * answer rule lives (build decisions BD9, BD22 and R1): the agreement,
 * billing, whether the channel was bought, whether it is on and live, the
 * header's pause, voice coverage, and "Stop and fall back" at the allowance.
 *
 * Two halves. `decideAnswer` is pure: the rules, in order, over a set of
 * facts, so every reason and its precedence is one table test.
 * `assistantMayAnswer` reads those facts and decides. It takes no
 * transaction and must be called outside one (R1): a location has no
 * entitlements row of its own, its billing clinic's row is FORCE RLS, and
 * reading it from inside the location's transaction would mean a second
 * connection waiting on the first, which in a ten-connection pool is a
 * deadlock Postgres cannot see. So it opens the location's transaction, then
 * the billing clinic's, one after the other.
 *
 * A refusal is a pass-through, never silence: voice goes to the clinic's
 * direct line, website chat to the contact form, a Meta message to no reply
 * (staff see it in the inbox). Where a voice pass-through has no direct line
 * to go to, the runtime still never leaves a dead line: it answers with the
 * fixed safe script (R25; see `voiceAnswerDecision`).
 */

export type { Channel };

/**
 * How a clinic's calls reach us (BD23): every call, the calls staff miss plus
 * everything after hours (the default), or after hours only. Read from
 * `clinic_settings.coverage_mode`, the single source (plan Part F2), by
 * `coverageModeOf`, the one accessor every billing reader goes through.
 */
export type CoverageMode = "all_calls" | "overflow_after_hours" | "after_hours_only";

/**
 * Why the assistant passes a call or conversation through instead of
 * answering, in the order BD22 checks them: no agreement in effect (BAA 1.3.0
 * clause 17: terminating the agreement ends the Services that day), billing
 * (BD9, R21), not bought, the channel row, the pause, voice coverage, the
 * allowance cap.
 */
export type PassThroughReason =
  | "no_agreement"
  | "unpaid"
  | "not_active"
  | "cancel_before_start"
  | "suspended"
  | "canceled"
  | "not_purchased"
  | "channel_not_live"
  | "channel_off"
  | "ai_paused"
  | "outside_coverage"
  | "allowance_cap";

/**
 * The refusals that mean the Services are not in effect at all: no agreement
 * (BAA 1.3.0 clause 17 ¶3, terminating it "ends the Services on the same
 * day"), or a subscription that has ended, before its plan started or after
 * (clause 1: the Services end when the subscription does). A refused voice
 * call with no direct line otherwise falls back to the assistant's safe
 * script (R25), because the agreement still covers it; after one of these
 * nothing may process the caller at all, so the runtime closes the call with
 * a fixed line instead (voice/tools.ts, answer_mode "closed").
 */
export const SERVICES_ENDED_REASONS: readonly PassThroughReason[] = [
  "no_agreement",
  "canceled",
  "cancel_before_start",
];

export function servicesEnded(reason: PassThroughReason): boolean {
  return SERVICES_ENDED_REASONS.includes(reason);
}

/**
 * Where a passed-through interaction goes: voice to the clinic's direct line
 * (which may not be set: the runtime must still never leave a dead line),
 * website chat to the contact form, Meta to no reply at all.
 */
export type AnswerFallback = "direct_line" | "contact_form" | "no_reply";

export type AnswerDecision =
  | { decision: "answer" }
  | {
      decision: "pass_through";
      reason: PassThroughReason;
      fallback: AnswerFallback;
      /** The clinic's direct line, E.164, for voice; null when it has none. */
      directLine: string | null;
    };

/**
 * Everything `decideAnswer` needs, read by `assistantMayAnswer` in
 * sequential transactions (the location's, then its billing clinic's) and
 * then decided purely, so the rules are a table test.
 */
export type AnswerFacts = {
  channel: Channel;
  now: Date;
  /**
   * The location's data classification is 'synthetic'. R1: only a synthetic
   * clinic with no billing row skips the billing checks, and only a synthetic
   * clinic treats a missing channel row as live; any other clinic fails
   * closed.
   */
  isSynthetic: boolean;
  /**
   * The location's organisation and its agreements (app_agreement_in_effect,
   * drizzle/0048): one is in effect; it had one and every one has been
   * terminated (`ended`); or none was ever bound to it (`none`). Ending the
   * agreement ends the Services on the same day (BAA 1.3.0 clauses 1, 17 and
   * 20), so `ended` refuses on every clinic, and `none` refuses everywhere
   * but on synthetic data, which no agreement is needed for.
   */
  agreement: "in_effect" | "ended" | "none";
  /** The BILLING clinic's entitlements, or null when it has no row. */
  billing: {
    status: BillingStatus;
    graceEndsAt: Date | null;
    /** R8: plan_started_at or plan_start_applied_at is set. */
    isPlanStarted: boolean;
    cancelAt: Date | null;
    /** Follows the BOUGHT package (BD31 keeps legacy rows on plan_code). */
    channelsEnabled: ChannelsEnabled;
    overageMode: "allow" | "hard_cap";
    /** effectiveIncluded for the channel's meter (BD5): pooled across locations. */
    included: number;
    /** Usage counted so far in the open window. */
    used: number;
    /** The allowance window; both null before the first one opens (BD6). */
    windowStart: Date | null;
    windowEnd: Date | null;
  } | null;
  /** The location's clinic_channels row for this channel, or null when it has none. */
  channelRow: { enabled: boolean; liveAt: Date | null } | null;
  pause: ClinicPause;
  /** clinic_settings.direct_line_e164. */
  directLine: string | null;
  /** Voice only. */
  coverageMode: CoverageMode;
  /** Voice only: isOpenAt at `now`; null when the hours are unknown or the time zone is bad. */
  openNow: boolean | null;
  /** Voice only: today, in the clinic's time zone, is one of its closure days. */
  closedToday: boolean;
  /**
   * R1 and R18: the call or conversation is not yet counted (no usage row for
   * its reference), so the allowance cap applies to it. No reference counts
   * as new.
   */
  startsNew: boolean;
};

export type AssistantMayAnswerInput = {
  /** The clinic the call or message reached: a location or a billing clinic. */
  clinicId: string;
  channel: Channel;
  /** The call's or conversation's usage reference; it replaces `startsNew` (R1). */
  usage?: { source: UsageSource; sourceRef: string };
  /**
   * The interaction is one already had (the desk's Meta follow-up): it is
   * not a new conversation for the allowance cap, and asking raises no
   * allowance notice.
   */
  continuing?: boolean;
  now?: Date;
  actor: ActorContext;
};

const FALLBACKS: Readonly<Record<Channel, AnswerFallback>> = {
  voice: "direct_line",
  web: "contact_form",
  meta: "no_reply",
};

/** The meter a channel's interactions count against. */
export function meterForChannel(channel: Channel): UsageMeter {
  return channel === "voice" ? "voice_minutes" : "chat_conversations";
}

/**
 * The clinic's voice coverage mode (BD23): `clinic_settings.coverage_mode`,
 * the single source the wizard and Settings write, which is the only column
 * that can say After hours only. A clinic with no settings row yet falls back
 * to what `clinics.call_routing` means: `always` forwards every call (All
 * calls), `conditional` forwards the calls staff miss and, with after-hours
 * forwarding, everything outside hours (Overflow and after hours, the
 * default). An unknown value is the default mode.
 */
export function coverageModeOf(
  clinic: { readonly callRouting: string | null | undefined },
  settings?: { readonly coverageMode: string | null | undefined } | null,
): CoverageMode {
  const stored = settings?.coverageMode;
  if (stored && (COVERAGE_MODES as readonly string[]).includes(stored)) {
    return stored as CoverageMode;
  }
  switch (clinic.callRouting) {
    case "always":
      return "all_calls";
    case "conditional":
      return "overflow_after_hours";
    default:
      return "overflow_after_hours";
  }
}

/**
 * `coverageModeOf` for the clinic `tx` is scoped to, reading its settings
 * row in the caller's transaction: for the billing emails that print the
 * steps for undoing call forwarding (R31).
 */
export async function readCoverageMode(
  db: Transaction,
  clinicId: string,
  clinic: { readonly callRouting: string | null | undefined },
): Promise<CoverageMode> {
  const [settings] = await db
    .select({ coverageMode: clinicSettings.coverageMode })
    .from(clinicSettings)
    .where(eq(clinicSettings.clinicId, clinicId))
    .limit(1);
  return coverageModeOf(clinic, settings ?? null);
}

function passThrough(
  channel: Channel,
  reason: PassThroughReason,
  directLine: string | null,
): AnswerDecision {
  return {
    decision: "pass_through",
    reason,
    fallback: FALLBACKS[channel],
    directLine: channel === "voice" ? directLine : null,
  };
}

/**
 * The billing rule (BD9, R8, R21), or null when billing lets the assistant
 * answer. A `demo` row reaches it only on a clinic that is not synthetic,
 * where it fails closed like a missing row (R1).
 */
function billingRefusal(
  billing: NonNullable<AnswerFacts["billing"]>,
  now: Date,
): PassThroughReason | null {
  const graceRunning =
    billing.graceEndsAt !== null && billing.graceEndsAt.getTime() > now.getTime();
  switch (billing.status) {
    case "active":
      break;
    case "past_due":
      // Inside grace the clinic keeps its service while Stripe retries.
      if (!graceRunning) return "unpaid";
      break;
    case "canceling":
      // A cancellation scheduled before the plan started means it never
      // will: nothing more is charged, so nothing more is answered. After
      // the start the paid period runs out, unless a payment failed in it
      // and its grace has ended (R21: turning auto-renew off is not a way to
      // keep an unpaid service).
      if (!billing.isPlanStarted) return "cancel_before_start";
      if (billing.graceEndsAt !== null && !graceRunning) return "unpaid";
      break;
    case "provisioning":
    case "paused":
    case "demo":
      return "not_active";
    case "suspended":
      return "suspended";
    case "canceled":
    case "purged":
      return "canceled";
  }
  // Auto-renew off before the start: setAutoRenew stamps cancel_at at once,
  // before the webhook moves the status, so a first answer in between cannot
  // start a plan the clinic has just declined (BD10).
  if (billing.cancelAt !== null && !billing.isPlanStarted) return "cancel_before_start";
  return null;
}

/**
 * The rules, in order; the first that refuses decides (BD22, with R1, R8,
 * R18, R20 and R21):
 *
 *   0. the agreement: none in effect is `no_agreement`, on synthetic data
 *      too once one has been terminated (see `AnswerFacts.agreement`). It
 *      comes first because nothing else can make a terminated practice's
 *      Services run again;
 *   1. billing (BD9). A synthetic clinic with no billing row skips it; any
 *      other clinic with none is `not_active` (fail closed, R1). A `demo`
 *      row skips it on a synthetic clinic and is `not_active` elsewhere;
 *   2. the channel was not bought: `not_purchased`;
 *   3. the channel row: missing is live on a synthetic clinic and
 *      `channel_not_live` elsewhere (R1); switched Off is `channel_off`; not
 *      live yet is `channel_not_live`;
 *   4. the header's pause: `ai_paused`;
 *   5. voice in After hours only coverage while the clinic is open and not
 *      closed today: `outside_coverage`. Unknown hours or a bad time zone
 *      answer;
 *   6. "Stop and fall back" with an interaction not yet counted and the open
 *      window's allowance used up: `allowance_cap`. Never before the first
 *      window or on an expired one (BD6, R20), and never on an interaction
 *      already counted, so an allowed conversation is not cut off mid-way
 *      (R18).
 */
export function decideAnswer(facts: AnswerFacts): AnswerDecision {
  const { channel, now, billing } = facts;
  const refuse = (reason: PassThroughReason) => passThrough(channel, reason, facts.directLine);

  // 0. The agreement.
  if (facts.agreement === "ended" || (facts.agreement === "none" && !facts.isSynthetic)) {
    return refuse("no_agreement");
  }

  // 1. Billing.
  if (billing === null) {
    if (!facts.isSynthetic) return refuse("not_active");
  } else if (!(billing.status === "demo" && facts.isSynthetic)) {
    const reason = billingRefusal(billing, now);
    if (reason) return refuse(reason);
  }

  // 2. Bought.
  if (billing !== null && !billing.channelsEnabled[channel]) return refuse("not_purchased");

  // 3. The channel row.
  if (facts.channelRow === null) {
    if (!facts.isSynthetic) return refuse("channel_not_live");
  } else {
    if (!facts.channelRow.enabled) return refuse("channel_off");
    if (facts.channelRow.liveAt === null) return refuse("channel_not_live");
  }

  // 4. The pause.
  if (isPaused(facts.pause, now)) return refuse("ai_paused");

  // 5. Voice coverage.
  if (
    channel === "voice" &&
    facts.coverageMode === "after_hours_only" &&
    facts.openNow === true &&
    !facts.closedToday
  ) {
    return refuse("outside_coverage");
  }

  // 6. The allowance cap.
  if (billing !== null && billing.overageMode === "hard_cap" && facts.startsNew) {
    const window = openWindowAt(
      { currentPeriodStart: billing.windowStart, currentPeriodEnd: billing.windowEnd },
      now,
    );
    if (window !== null && billing.used >= billing.included) return refuse("allowance_cap");
  }

  return { decision: "answer" };
}

/** isOpenAt, or null when the hours are missing, malformed or the time zone is bad. */
function openAt(hours: unknown, at: Date, timeZone: string): boolean | null {
  if (!hours) return null;
  try {
    return isOpenAt(parseOpeningHours(hours), at, timeZone);
  } catch {
    return null;
  }
}

/**
 * The gate (R1). Takes no transaction and must be called outside one: it
 * opens the location's transaction (the clinic row, its channel row, its
 * settings), then the billing clinic's (entitlements, and whether this call
 * or conversation is already counted), and decides. When "Stop and fall back"
 * engages it queues `allowance_fallback` on the billing clinic in a third
 * transaction and sends critical notices after that commit.
 */
export async function assistantMayAnswer(input: AssistantMayAnswerInput): Promise<AnswerDecision> {
  return (await runGate(input)).decision;
}

/** The gate's work, and whether the clinic exists at all (an unknown id raises no alert). */
async function runGate(
  input: AssistantMayAnswerInput,
): Promise<{ decision: AnswerDecision; isKnownClinic: boolean }> {
  const now = input.now ?? new Date();
  const { channel, actor } = input;
  const meter = meterForChannel(channel);

  const location = await withTenant({ clinicId: input.clinicId, actor }, async (tx) => {
    const [clinic] = await tx.db
      .select({
        timezone: clinics.timezone,
        openingHours: clinics.openingHours,
        callRouting: clinics.callRouting,
        dataClassification: clinics.dataClassification,
        billingClinicId: clinics.billingClinicId,
        organizationId: clinics.organizationId,
      })
      .from(clinics)
      .where(eq(clinics.id, tx.clinicId))
      .limit(1);
    if (!clinic) return null;
    const [row] = await tx.db
      .select({ enabled: clinicChannels.enabled, liveAt: clinicChannels.liveAt })
      .from(clinicChannels)
      .where(and(eq(clinicChannels.clinicId, tx.clinicId), eq(clinicChannels.channel, channel)))
      .limit(1);
    const [settings] = await tx.db
      .select({
        pausedAt: clinicSettings.aiPausedAt,
        pausedUntil: clinicSettings.aiPausedUntil,
        directLine: clinicSettings.directLineE164,
        coverageMode: clinicSettings.coverageMode,
      })
      .from(clinicSettings)
      .where(eq(clinicSettings.clinicId, tx.clinicId))
      .limit(1);

    // The organisation's agreements, as the tenant sees them: its own
    // organisation's rows (baa_acceptances is FORCE RLS, 0031).
    const agreementRows = await tx.db.execute<{ in_effect: boolean; any_bound: boolean }>(
      sql`select exists (select 1 from app_agreement_in_effect(c.organization_id)) as in_effect,
                 exists (select 1 from baa_acceptances b
                          where b.organization_id = c.organization_id) as any_bound
            from clinics c
           where c.id = ${tx.clinicId}`,
    );
    const agreementRow = agreementRows.rows[0];
    const agreement: AnswerFacts["agreement"] = agreementRow?.in_effect
      ? "in_effect"
      : agreementRow?.any_bound
        ? "ended"
        : "none";

    const coverageMode = coverageModeOf(clinic, settings ?? null);
    const openNow = channel === "voice" ? openAt(clinic.openingHours, now, clinic.timezone) : null;
    // A closure day matters only where it could change the answer: an After
    // hours only clinic whose weekly hours say it is open now.
    let closedToday = false;
    if (channel === "voice" && coverageMode === "after_hours_only" && openNow === true) {
      let today: string | null = null;
      try {
        today = clinicLocalDate(now, clinic.timezone);
      } catch {
        today = null;
      }
      if (today) closedToday = await closedOn(tx.db, tx.clinicId, today);
    }

    return {
      billingClinicId: clinic.billingClinicId ?? tx.clinicId,
      organizationId: clinic.organizationId,
      isSynthetic: clinic.dataClassification === "synthetic",
      agreement,
      channelRow: row ?? null,
      pause: { pausedAt: settings?.pausedAt ?? null, pausedUntil: settings?.pausedUntil ?? null },
      directLine: settings?.directLine ?? null,
      coverageMode,
      openNow,
      closedToday,
    };
  });
  // No clinic behind the id: nothing to answer for, and no line to pass to.
  if (!location) {
    return { decision: passThrough(channel, "not_active", null), isKnownClinic: false };
  }

  const { billingClinicId } = location;
  const billed = await withTenant({ clinicId: billingClinicId, actor }, async (tx) => {
    // billing_clinic_id is the runtime role's to write, so a location's
    // pointer is followed only into its own practice (as the termination
    // follows it, app_organization_clinics): one at another practice's
    // billing clinic is treated as no billing clinic at all, which fails
    // closed, and ops is told once.
    if (billingClinicId !== input.clinicId) {
      const [payer] = await tx.db
        .select({ organizationId: clinics.organizationId })
        .from(clinics)
        .where(eq(clinics.id, billingClinicId))
        .limit(1);
      if (payer && payer.organizationId !== location.organizationId) {
        return { row: null, counted: false, foreign: true };
      }
    }
    const row = await getEntitlements(tx.db, billingClinicId);
    if (!row || !input.usage) return { row, counted: false };
    const [seen] = await tx.db
      .select({ id: usageEvents.id })
      .from(usageEvents)
      .where(
        and(
          eq(usageEvents.clinicId, billingClinicId),
          eq(usageEvents.meter, meter),
          eq(usageEvents.source, input.usage.source),
          eq(usageEvents.sourceRef, input.usage.sourceRef),
        ),
      )
      .limit(1);
    return { row, counted: seen !== undefined };
  });

  if ("foreign" in billed) {
    await notifyOpsOnce("billing_pointer_outside_practice", { clinicId: input.clinicId });
  }
  const row = billed.row;
  const facts: AnswerFacts = {
    channel,
    now,
    isSynthetic: location.isSynthetic,
    agreement: location.agreement,
    billing: row
      ? {
          status: row.status,
          graceEndsAt: row.graceEndsAt,
          isPlanStarted: hasPlanStarted(row),
          cancelAt: row.cancelAt,
          channelsEnabled: row.channelsEnabled,
          overageMode: row.overageMode === "hard_cap" ? "hard_cap" : "allow",
          included: effectiveIncluded(row, meter),
          used: usedOf(row, meter),
          windowStart: row.currentPeriodStart,
          windowEnd: row.currentPeriodEnd,
        }
      : null,
    channelRow: location.channelRow,
    pause: location.pause,
    directLine: location.directLine,
    coverageMode: location.coverageMode,
    openNow: location.openNow,
    closedToday: location.closedToday,
    startsNew: input.continuing ? false : !billed.counted,
  };
  const decision = decideAnswer(facts);

  // "Stop and fall back" has engaged: tell the clinic once per meter per
  // window (L19), whatever its usage-alerts switch says (BD21).
  if (decision.decision === "pass_through" && decision.reason === "allowance_cap" && row) {
    const window = openWindowAt(row, now);
    if (window) {
      const included = facts.billing?.included ?? 0;
      const queued = await withTenant({ clinicId: billingClinicId, actor }, (tx) =>
        enqueueAllowanceFallback(tx, { meter, included, window }),
      );
      if (queued) await deliverCriticalAfterCommit(billingClinicId);
    }
  }
  return { decision, isKnownClinic: true };
}

const VOICE_GATE_ACTOR: ActorContext = { type: "service", serviceName: "voice-gate" };

/**
 * The gate for a voice call (BD25), outside any transaction like
 * `assistantMayAnswer`: today the Synthflow tools' `context` and `slots`
 * (and `book`, after its replay), and tomorrow the Retell custom-LLM process,
 * which asks it when a call comes in and either answers or transfers to the
 * returned direct line.
 *
 * A pass-through with no direct line has nowhere to send the caller. The
 * runtime then answers anyway, with the fixed safe script (the tools'
 * `answer_mode: "assistant"` with `booking_mode: "desk_confirms"`: take the
 * caller's request for the front desk, book nothing), because a patient
 * calling a clinic must always reach someone (CLAUDE.md, "Failure"); except
 * when the Services have ended (servicesEnded: no agreement, or the
 * subscription over), when nothing may process the caller and the call is
 * closed with a fixed line (`answer_mode: "closed"`). Either is a
 * configuration gap only a person can close, so ops hears of it here, once
 * an hour per clinic and reason (R25).
 */
export async function voiceAnswerDecision(clinicId: string, now?: Date): Promise<AnswerDecision> {
  const { decision, isKnownClinic } = await runGate({
    clinicId,
    channel: "voice",
    now,
    actor: VOICE_GATE_ACTOR,
  });
  if (isKnownClinic && decision.decision === "pass_through" && decision.directLine === null) {
    await notifyOps("voice_fallback_no_direct_line", { clinicId, code: decision.reason });
  }
  return decision;
}
