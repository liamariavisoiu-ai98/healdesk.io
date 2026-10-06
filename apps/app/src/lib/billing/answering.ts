import type { Channel } from "@healdesk/catalog";

import type { BillingStatus, ChannelsEnabled, UsageSource } from "@/db/schema";
import type { ActorContext } from "@/lib/audit";
import type { ClinicPause } from "@/lib/channels/state";

/**
 * May the assistant answer this call or conversation? The one place every
 * answer rule lives (build decisions BD9, BD22 and R1): billing, whether the
 * channel was bought, whether it is on and live, the header's pause, voice
 * coverage, and "Stop and fall back" at the allowance.
 *
 * STUB written by S0 so callers can be built against the signatures; Package
 * B replaces the bodies of `assistantMayAnswer` and `voiceAnswerDecision`,
 * and adds the pure `decideAnswer(facts)` and `coverageModeOf`. Until then
 * the gate answers everything, which is today's behaviour: nothing calls it
 * yet.
 */

export type { Channel };

/**
 * How a clinic's calls reach us (BD23): every call, the calls staff miss plus
 * everything after hours (the default), or after hours only. Read from
 * `clinics.call_routing` until the funnel's `clinic_settings.coverage_mode`
 * lands, by `coverageModeOf`, the one accessor that switches.
 */
export type CoverageMode = "all_calls" | "overflow_after_hours" | "after_hours_only";

/**
 * Why the assistant passes a call or conversation through instead of
 * answering, in the order BD22 checks them: billing (BD9, R21), not bought,
 * the channel row, the pause, voice coverage, the allowance cap.
 */
export type PassThroughReason =
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
  now?: Date;
  actor: ActorContext;
};

/**
 * The gate (R1). Takes no transaction and must be called outside one: it
 * opens the location's transaction, then the billing clinic's, in sequence,
 * and enqueues `allowance_fallback` when the cap engages.
 *
 * STUB: answers everything until Package B lands the rules.
 */
export async function assistantMayAnswer(input: AssistantMayAnswerInput): Promise<AnswerDecision> {
  void input;
  return { decision: "answer" };
}

const VOICE_GATE_ACTOR: ActorContext = { type: "service", serviceName: "voice-gate" };

/**
 * The gate for a voice call, for the voice tools now and the Retell process
 * later (BD25). Outside any transaction, like `assistantMayAnswer`.
 */
export async function voiceAnswerDecision(clinicId: string, now?: Date): Promise<AnswerDecision> {
  return assistantMayAnswer({ clinicId, channel: "voice", now, actor: VOICE_GATE_ACTOR });
}
