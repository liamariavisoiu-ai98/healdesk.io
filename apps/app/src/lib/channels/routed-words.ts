/**
 * The routed/answered counter's closed words (drizzle/0137), kept apart from
 * lib/channels/routed-answered.ts so the schema can import them without the
 * database client.
 *
 * Every call or conversation that reaches AYA for a clinic is ROUTED; the
 * runtime that took it then records what became of it, once, and only ever
 * towards the worse outcome (pending → excluded → answered → missed), so a
 * retry, a redelivery or a second message never undoes a miss. The words
 * follow the first-month guarantee as Terms §5 defines it
 * (docs/counsel/guarantee-and-refund.md, "The adopted text"):
 *
 *   - `answered`: on a call, the opening line started within 10 seconds of
 *     the call reaching us and our side did not cut the call off later; on a
 *     message, a reply other than a failure line sent within 60 seconds;
 *   - `excluded`: what "does not count": the clinic's own choices (a pause, a
 *     channel switched off, the allowance's "Stop and fall back", outside the
 *     voice coverage it chose), billing (suspended, unpaid, ended), a channel
 *     not live or not bought, the clinic's own agreement, a caller who hung up
 *     within 5 seconds, a Meta reply outside the window Meta's delivery left;
 *   - `missed`: it reached us and our systems or our suppliers failed to
 *     answer it, including a vendor's or the host's agreement lapsed, which
 *     is ours to keep in force, and a reply sent too late.
 */

/** The channels the counter counts: the catalog's three. */
export const ROUTED_CHANNELS = ["voice", "web", "meta"] as const;

/** What became of a routed call or conversation, from best known to worst. */
export const ROUTED_OUTCOMES = ["pending", "excluded", "answered", "missed"] as const;
export type RoutedOutcome = (typeof ROUTED_OUTCOMES)[number];

/** Why one does not count (Terms §5, "What does not count"). */
export const EXCLUDED_REASONS = [
  // The answer gate's refusals that are the clinic's own state or choice
  // (lib/billing/answering.ts PassThroughReason).
  "no_agreement",
  "agreement_insufficient",
  "unpaid",
  "not_active",
  "cancel_before_start",
  "suspended",
  "canceled",
  "not_purchased",
  "channel_not_live",
  "channel_off",
  "ai_paused",
  "outside_coverage",
  "allowance_cap",
  // The clinic has left, or switched the Meta app off between the gate and the reply.
  "clinic_left",
  "withheld",
  // The caller ended the call within 5 seconds of it reaching us.
  "caller_ended",
  // Meta delivered the message after its 24-hour window had closed.
  "outside_window",
  // v1 is inbound only: a call that was not one a patient made to us.
  "outbound",
] as const;
export type ExcludedReason = (typeof EXCLUDED_REASONS)[number];

/** Why one was missed: ours, or one of our suppliers'. */
export const MISSED_REASONS = [
  // A supplier's or the host's agreement not in force (ours to keep).
  "host_agreement_lapsed",
  "vendor_agreement_lapsed",
  // A call whose start failed: put through to the direct line or closed.
  "start_failed",
  // Answered, but after 10 seconds (a call) or 60 seconds (a message).
  "late",
  // The caller waited more than 5 seconds and hung up before the opening line.
  "no_opening",
  // Answered, then put through to the direct line because a turn failed.
  "cut_off",
  // Only the fixed failure line was sent: not an answer (Terms §5).
  "failure_line",
  // The runtime threw before a reply was produced or sent.
  "error",
  // Still pending when the sweep looked (ROUTED_PENDING_GRACE_MS): the
  // process that took it stopped before it said what happened.
  "no_outcome",
] as const;
export type MissedReason = (typeof MISSED_REASONS)[number];

export const ROUTED_REASONS = [...EXCLUDED_REASONS, ...MISSED_REASONS] as const;
export type RoutedReason = ExcludedReason | MissedReason;

/**
 * The misses that are a failure of our side to answer at all, which is what
 * the outage notices (L17, L18) are about: every miss but a late answer,
 * where AYA did answer.
 */
export const OUTAGE_MISSED_REASONS: readonly MissedReason[] = MISSED_REASONS.filter((r) => r !== "late");

/** Terms §5: a call is answered when its opening line starts within 10 seconds of reaching us. */
export const CALL_ANSWER_WITHIN_MS = 10_000;
/** Terms §5: a message is answered when the first reply is sent within 60 seconds. */
export const MESSAGE_ANSWER_WITHIN_MS = 60_000;
/** Terms §5: a call the caller ends within 5 seconds does not count. */
export const CALLER_ENDED_WITHIN_MS = 5_000;
