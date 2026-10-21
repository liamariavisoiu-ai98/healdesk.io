import { toE164 } from "@healdesk/connectors";
import { and, eq, isNull, sql } from "drizzle-orm";

import { clinics, conversations } from "@/db/schema";
import type { ActorContext } from "@/lib/audit";
import { isDemoClinic } from "@/lib/booking/terms";
import { clinicHasLeft } from "@/lib/clinic/leaving";
import type { TranscriptTurn } from "@/lib/conversations/transcript-email";
import { describeError, log } from "@/lib/log";
import { notifyBookingAlert } from "@/lib/notices/booking-alerts";
import { withTenant, type TenantTx } from "@/lib/tenant";

import { keepRedialContext } from "./redial";
import { voiceRealCallsAllowed } from "./test-calls";

/**
 * A call that ended unexpectedly (the owner's decision of 21 October 2026,
 * "A. Ended early"): the clinic is told, in the usual ways, so its own staff
 * can call the person back. That call back is a person at the clinic; healdesk
 * contacts nobody, during a call or after it (CLAUDE.md, "Inbound only").
 *
 * ## What counts
 *
 * Decided from Retell's `disconnection_reason`, the value its call object
 * and its call_ended webhook carry (docs.retellai.com, Get Call;
 * "Debug call disconnection"), and from one signal of our own: the backstop
 * recorded the call because the live socket never did.
 *
 *   - A technical reason (TECHNICAL_ENDINGS) is ended early, always.
 *   - A normal ending (NORMAL_ENDINGS: the caller or AYA hung up, a
 *     transfer, voicemail, an IVR, inactivity, spam) never is, whatever else
 *     happened: Retell saw how the call ended.
 *   - No reason at all, or one this list does not know, is ended early only
 *     when the backstop recorded the call (`unexplained`): our process died
 *     or failed to record it, and nobody can say the call ended well. A call
 *     the live socket recorded with no reason is left alone.
 *
 * Conservative on purpose: a flag is an alert to the clinic and a mark
 * staff act on, so it is raised only where the call is known to have been
 * cut by a fault. The live socket's own death is not a signal on its own:
 * the session asks Retell to reconnect a dropped socket (auto_reconnect,
 * lib/voice/retell.ts), the call may well go on, and Retell's reason
 * (`error_llm_websocket_lost_connection` or `_runtime`) says when it did not.
 *
 * ## Where the flag is set
 *
 *   - by the post-call ingest (lib/voice/ingest.ts), for a call the backstop
 *     records: Retell's reason is on the call it read back;
 *   - by the Retell webhook (recordRetellEnding below), for a call already
 *     recorded by the live socket, which never knows Retell's reason;
 *   - by the backstop, for a call the webhook found not yet recorded: the
 *     reason travels in the job (a code, never anything about the caller).
 *
 * Each sets conversations.ended_early_reason once (markEndedEarly), queues
 * the clinic's L35 alert once per conversation, keeps the short-lived redial
 * record (./redial.ts) when the caller's number and the turns are at hand,
 * and writes an audit row. The transcript email reads the flag when it is
 * sent and opens with a fixed banner: a transcript the live socket already
 * emailed before Retell's word arrived goes without it, and the alert and
 * the Conversations mark still say it.
 */

/** Retell's reasons that mean a fault cut the call (docs.retellai.com, call object). */
export const TECHNICAL_ENDINGS: ReadonlySet<string> = new Set([
  "error_llm_websocket_open",
  "error_llm_websocket_lost_connection",
  "error_llm_websocket_runtime",
  "error_llm_websocket_corrupt_payload",
  "error_no_audio_received",
  "error_asr",
  "error_retell",
  "error_unknown",
  "error_user_not_joined",
  "registered_call_timeout",
  "telephony_provider_unavailable",
  "sip_routing_error",
  "concurrency_limit_reached",
  "no_concurrency_fallback",
  // Retell's own account could not pay for the call: not the caller's doing.
  "no_valid_payment",
  // The agent's maximum call length cut the caller off mid-conversation.
  "max_duration_reached",
]);

/** Retell's reasons for a call that ended as calls do. Never flagged. */
export const NORMAL_ENDINGS: ReadonlySet<string> = new Set([
  "user_hangup",
  "agent_hangup",
  "call_transfer",
  "transfer_bridged",
  "voicemail_reached",
  "ivr_reached",
  "inactivity",
  "scam_detected",
  "marked_as_spam",
  "user_declined",
  // Outbound-only reasons: healdesk places no calls, so none should arrive.
  "dial_busy",
  "dial_failed",
  "dial_no_answer",
  "invalid_destination",
  "telephony_provider_permission_denied",
  // Someone stopped or took over the call on purpose (Retell's dashboard or
  // API); not a fault, and UNCONFIRMED for an inbound call.
  "manual_stopped",
  "call_take_over",
  // A transfer that did not complete. UNCONFIRMED in Retell's docs whether
  // the caller stays on with AYA; left unflagged until a test call shows it.
  "transfer_cancelled",
]);

/** Our own reason: the backstop recorded the call and Retell gave none it knows. */
export const UNEXPLAINED = "unexplained";

const REASON = /^[a-z_]{1,64}$/;

export type CallEnding = { endedEarly: true; reason: string } | { endedEarly: false };

/** Pure: whether a call ended early, and why, from Retell's reason and who recorded it. */
export function classifyCallEnding(input: { disconnectionReason?: unknown; recordedByBackstop: boolean }): CallEnding {
  const reason = typeof input.disconnectionReason === "string" ? input.disconnectionReason.trim() : "";
  if (TECHNICAL_ENDINGS.has(reason)) return { endedEarly: true, reason };
  if (NORMAL_ENDINGS.has(reason)) return { endedEarly: false };
  return input.recordedByBackstop ? { endedEarly: true, reason: UNEXPLAINED } : { endedEarly: false };
}

/** A reason this module would store: a technical one, or `unexplained`. Anything else is not a flag. */
export function isEndedEarlyReason(value: unknown): value is string {
  return typeof value === "string" && REASON.test(value) && (TECHNICAL_ENDINGS.has(value) || value === UNEXPLAINED);
}

export type MarkOutcome = {
  /** This call set the flag; false when it was already set, or the conversation is not a call. */
  flagged: boolean;
  /** The L35 alert's row is queued (now, or already under its key). */
  alertQueued: boolean;
  /** The redial record was kept. */
  redialKept: boolean;
};

/**
 * Set the flag on a recorded call, once, inside the caller's tenant
 * transaction, and with it the alert, the redial record and the audit row.
 * The alert and the record run in savepoints and never fail the flag.
 */
export async function markEndedEarly(
  tx: TenantTx,
  input: {
    conversationId: string;
    reason: string;
    callerPhone?: string | null;
    turns?: readonly TranscriptTurn[];
    via: "ingest" | "webhook" | "backstop";
  },
): Promise<MarkOutcome> {
  if (!isEndedEarlyReason(input.reason)) return { flagged: false, alertQueued: false, redialKept: false };
  const updated = await tx.db
    .update(conversations)
    .set({ endedEarlyReason: input.reason, endedEarlyAt: sql`clock_timestamp()` })
    .where(
      and(
        eq(conversations.clinicId, tx.clinicId),
        eq(conversations.id, input.conversationId),
        eq(conversations.channel, "voice"),
        isNull(conversations.endedEarlyReason),
      ),
    )
    .returning({ id: conversations.id });
  if (updated.length === 0) return { flagged: false, alertQueued: false, redialKept: false };
  return flagged(tx, input);
}

/**
 * What follows the flag, for a row that has it now: called by markEndedEarly,
 * and by the ingest, which writes the flag in the conversation's own insert.
 */
export async function flagged(
  tx: TenantTx,
  input: { conversationId: string; reason: string; callerPhone?: string | null; turns?: readonly TranscriptTurn[]; via: "ingest" | "webhook" | "backstop" },
): Promise<MarkOutcome> {
  // The clinic's L35: a pointer to Conversations, once per conversation.
  const alertQueued = await notifyBookingAlert(tx, "ended_early", { conversationId: input.conversationId, channel: "voice" });
  let redialKept = false;
  try {
    redialKept = await tx.db.transaction(async (savepoint) =>
      keepRedialContext({ ...tx, db: savepoint }, { conversationId: input.conversationId, callerPhone: input.callerPhone, turns: input.turns }),
    );
  } catch (error) {
    log.error("redial record not kept", { clinicId: tx.clinicId, conversationId: input.conversationId, error: describeError(error) });
  }
  tx.audit.record({
    action: "update",
    resourceType: "conversation",
    resourceId: input.conversationId,
    metadata: { outcome: "ended_early", reason: input.reason, via: input.via, alertQueued, redialKept },
  });
  return { flagged: true, alertQueued, redialKept };
}

const WEBHOOK_ACTOR: ActorContext = { type: "agent", serviceName: "retell-webhook" };
const MAX_TURNS = 400;
const MAX_TURN_CHARS = 4_000;

/** The turns of Retell's transcript, as the redial record takes them: the caller's run joined, as the backstop joins them. */
function retellTurns(transcript: unknown): TranscriptTurn[] {
  if (!Array.isArray(transcript)) return [];
  const turns: TranscriptTurn[] = [];
  let caller: string[] = [];
  const flush = () => {
    if (caller.length) turns.push({ speaker: "person", text: caller.join(" ").slice(0, MAX_TURN_CHARS) });
    caller = [];
  };
  for (const entry of transcript.slice(0, MAX_TURNS) as { role?: unknown; content?: unknown }[]) {
    if (!entry || typeof entry.content !== "string" || !entry.content.trim()) continue;
    if (entry.role === "user") caller.push(entry.content.trim());
    else if (entry.role === "agent") {
      flush();
      turns.push({ speaker: "assistant", text: entry.content.trim().slice(0, MAX_TURN_CHARS) });
    }
  }
  flush();
  return turns;
}

export type RetellEndingResult =
  /** Ended normally, or not ours to mark: nothing to do. */
  | { status: "normal" }
  | { status: "ignored"; why: "unknown_clinic" | "left" | "test_mode" | "not_this_clinic" | "outbound" }
  | { status: "flagged" | "already_flagged" }
  /** Ended early, and no conversation yet: the backstop carries the reason. */
  | { status: "pending"; reason: string };

/**
 * The webhook's part (app/api/webhooks/retell/[clinicId]/route.ts), from a
 * call object whose signature has been checked. Reads only the reason, the
 * direction, the numbers and, for a call that ended early, its last turns,
 * for the redial record: nothing of a normal call is read or kept.
 */
export async function recordRetellEnding(
  clinicId: string,
  call: { call_id?: unknown; disconnection_reason?: unknown; direction?: unknown; from_number?: unknown; to_number?: unknown; transcript_object?: unknown },
  deps: { realCalls?: boolean } = {},
): Promise<RetellEndingResult> {
  const ending = classifyCallEnding({ disconnectionReason: call.disconnection_reason, recordedByBackstop: false });
  if (!ending.endedEarly) return { status: "normal" };
  if (call.direction === "outbound") return { status: "ignored", why: "outbound" };
  const callId = String(call.call_id);
  return withTenant({ clinicId, actor: WEBHOOK_ACTOR }, async (tx) => {
    const [clinic] = await tx.db.select({ assistantNumber: clinics.assistantNumberE164 }).from(clinics).where(eq(clinics.id, clinicId)).limit(1);
    if (!clinic) return { status: "ignored", why: "unknown_clinic" } as const;
    if (await clinicHasLeft(tx, { lock: false })) return { status: "ignored", why: "left" } as const;
    // The voice line's test mode, as the backstop reads it.
    if (!(deps.realCalls ?? voiceRealCallsAllowed()) && !(await isDemoClinic(tx))) return { status: "ignored", why: "test_mode" } as const;
    const to = typeof call.to_number === "string" ? (toE164(call.to_number) ?? call.to_number.trim()) : null;
    const ours = clinic.assistantNumber ? (toE164(clinic.assistantNumber) ?? clinic.assistantNumber.trim()) : null;
    if (!to || !ours || to !== ours) return { status: "ignored", why: "not_this_clinic" } as const;
    const [conversation] = await tx.db
      .select({ id: conversations.id })
      .from(conversations)
      .where(and(eq(conversations.clinicId, clinicId), eq(conversations.externalCallId, callId)))
      .limit(1);
    if (!conversation) return { status: "pending", reason: ending.reason } as const;
    const outcome = await markEndedEarly(tx, {
      conversationId: conversation.id,
      reason: ending.reason,
      callerPhone: typeof call.from_number === "string" ? call.from_number : null,
      turns: retellTurns(call.transcript_object),
      via: "webhook",
    });
    return { status: outcome.flagged ? "flagged" : "already_flagged" } as const;
  });
}
