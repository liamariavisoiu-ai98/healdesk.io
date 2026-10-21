import { toE164 } from "@healdesk/connectors";
import { and, eq } from "drizzle-orm";

import { billingNotices, clinics, conversations, handovers } from "@/db/schema";
import type { ActorContext } from "@/lib/audit";
import { cardNumberIn } from "@/lib/assistant/guard";
import { isDemoClinic } from "@/lib/booking/terms";
import { clinicHasLeft } from "@/lib/clinic/leaving";
import { disclosureFor } from "@/lib/compliance/disclosure";
import type { TranscriptTurn } from "@/lib/conversations/transcript-email";
import { describeError, log } from "@/lib/log";
import { dedupeKey } from "@/lib/notices/booking-alerts";
import { enqueue, getBoss, QUEUE_VOICE_CALL_BACKSTOP } from "@/lib/queue/boss";
import type { EmailTransport } from "@/lib/reporting/deliver";
import { withTenant } from "@/lib/tenant";

import { ingestCall, VoiceIngestError, type IngestResult, type VoiceCallEvent } from "./ingest";
import { deleteRetellCallAfterIngest, type RetellCallDeletion } from "./recording-alerts";
import { voiceRealCallsAllowed } from "./test-calls";

/**
 * The backstop for a call the live socket never recorded.
 *
 * A call's words, and what the caller asked the desk for, live in the voice
 * process's memory until Retell closes the socket (lib/voice/retell.ts). If
 * the voice task dies mid-call, or the ingest at hang-up fails, nothing
 * records the call: no conversation, no transcript for the clinic, no
 * minutes. Retell's own call-ended webhook is the second witness.
 *
 * Each clinic's Retell agent sends its webhooks to
 * https://app.healdesk.io/api/webhooks/retell/<clinic id> (the agent's own
 * `webhook_url`, so the path names the clinic the same way the socket's path
 * does). The route checks Retell's signature and does nothing else but queue
 * one job, carrying the clinic id and Retell's call id and nothing from the
 * payload: the queue's tables have no RLS (lib/queue/boss.ts), so the words
 * never go there.
 *
 * ## Why the job waits
 *
 * The live socket closes when the call ends, as the webhook is sent, and its
 * ingest is the better record: it alone holds what the caller asked for,
 * whether the answer gate let AYA answer, and the urgent flag. ingestCall is
 * idempotent on the call id, so whichever records first wins and the other
 * gets `duplicate`. If the backstop won that race the socket's booking
 * request would be dropped as a duplicate, so the job starts
 * BACKSTOP_DELAY_SECONDS after the webhook, by which time a live socket has
 * long finished, and records only a call that still has no conversation.
 *
 * ## What it records, and what it cannot
 *
 * The job reads the call back from Retell's API by its id
 * (GET /v2/get-call/<id>, with HEALDESK_RETELL_API_KEY), so nothing the
 * webhook carried is trusted beyond the call id, and it checks the call
 * reached this clinic's own Retell number before it records anything. Then
 * the ordinary ingest: the conversation, the minutes, and the transcript
 * from Retell's own turn list, emailed to the clinic like any other.
 *
 * What the caller asked for is not reconstructed: the capture was the
 * session's, and guessing a time from the words would put a request in
 * front of the desk nobody made. The clinic reads the request in the
 * transcript. For the same reason the call is not evidence of a first
 * answer (the gate's decision is unknown). What the session raised while
 * the call was up is read back by the call's id instead of guessed: an
 * urgent alert (L12, whose dedupe key names the call) marks the call
 * `urgent`, as the session would have, so the URGENT email's link to
 * Conversations finds it marked; that or a handover row for the call sets
 * the outcome to `escalated_to_human`. Otherwise the outcome is left unset.
 *
 * A call AYA never spoke on (no opening line: put through to the clinic or
 * closed by the pass-through or by a start that failed) is recorded, with no
 * disclosure, and the ingest bills it nothing and the claims leave it out.
 *
 * It covers a call that was never recorded, not one recorded in part. The
 * session asks Retell to reconnect a dropped socket (lib/voice/retell.ts);
 * if Retell reconnects a crashed task's call to another task, that task's
 * session records the call from the reconnect on, and the backstop, seeing
 * a conversation, leaves the first half unrecorded.
 *
 * It needs Retell to have kept the call's transcript, which every agent our
 * code writes does (lib/voice/retell-agent.ts, data_storage_setting
 * `everything`, the owner's decision of 21 October 2026).
 *
 * ## Then Retell's copy is deleted
 *
 * Once the call has a conversation here, recorded by the live socket
 * (`already_recorded`) or by this job (`recorded`, after the ingest has
 * committed the conversation with its sealed transcript and tried the email
 * once), the job deletes the call at Retell
 * (./recording-alerts.ts, deleteRetellCallAfterIngest). A delete that fails
 * throws, so pg-boss retries the whole job; the retry finds the
 * conversation and goes straight to the delete. Nothing is deleted for a
 * call that is not recorded here, whatever the reason: Retell's one-day
 * retention removes those. A delete still failing
 * RETELL_DELETION_WINDOW_MS after the call ended is one alert for the call.
 */

/** Long after any live socket has recorded its call; short enough that the clinic's transcript is still timely. */
export const BACKSTOP_DELAY_SECONDS = 10 * 60;

/**
 * The job's retries. pg-boss waits retryDelay * 2^n * (1 to 2) seconds
 * after the n-th failure (n from 0), so the last try is at least
 * BACKSTOP_DELAY_SECONDS + 31 minutes after the webhook, past
 * RETELL_DELETION_WINDOW_MS (tests/recording-alerts.test.ts pins it).
 */
export const BACKSTOP_RETRY_LIMIT = 5;
export const BACKSTOP_RETRY_DELAY_SECONDS = 60;

/** Retell's events that say a call is over. `call_analyzed` follows `call_ended`; either queues the same job. */
export const BACKSTOP_EVENTS: ReadonlySet<string> = new Set(["call_ended", "call_analyzed"]);

const RETELL_API = "https://api.retellai.com";
const ACTOR: ActorContext = { type: "agent", serviceName: "retell-backstop" };
const CALL_ID = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_TURNS = 400;
const MAX_TURN_CHARS = 4_000;

export type CallBackstopPayload = { clinicId: string; callId: string };

/** The engine's Retell key: signs the webhooks and reads calls back. Unset (or the placeholder) is null. */
export function retellApiKey(source: Record<string, string | undefined> = process.env): string | null {
  const value = source.HEALDESK_RETELL_API_KEY?.trim();
  return value && value !== "__unset__" ? value : null;
}

export function isRetellCallId(value: unknown): value is string {
  return typeof value === "string" && CALL_ID.test(value);
}

/**
 * Queue the backstop for one call. One job per call while it waits (the
 * queue's `short` policy with the call as its key, scripts/install-queue.ts),
 * so call_ended, call_analyzed and Retell's retries collapse onto it; a
 * second job that slipped through would find the conversation and stop.
 */
export async function scheduleCallBackstop(
  payload: CallBackstopPayload,
  send: typeof enqueue = enqueue,
  queueInstalled: () => Promise<boolean> = async () => Boolean(await (await getBoss()).getQueue(QUEUE_VOICE_CALL_BACKSTOP)),
): Promise<void> {
  const id = await send(QUEUE_VOICE_CALL_BACKSTOP, { clinicId: payload.clinicId, callId: payload.callId }, {
    startAfter: BACKSTOP_DELAY_SECONDS,
    singletonKey: `${payload.clinicId}:${payload.callId}`,
    // Retell's API down for a while is the likely failure. pg-boss doubles
    // the delay each time, with jitter: about half an hour to an hour in all.
    retryLimit: BACKSTOP_RETRY_LIMIT,
    retryDelay: BACKSTOP_RETRY_DELAY_SECONDS,
    retryBackoff: true,
  });
  // null is pg-boss declining the job: a duplicate of one already waiting,
  // which is the point of the queue's policy, or a queue that was never
  // installed, which would drop the backstop without a word. Only the
  // second is an error, and Retell retries on it.
  if (id === null && !(await queueInstalled())) {
    throw new Error("the voice-call-backstop queue is not installed: run `npm run queue:install` as the migrator");
  }
}

/** The fields of Retell's call object this file reads (https://docs.retellai.com/api-references/get-call). */
export type RetellCall = {
  call_id?: unknown;
  call_type?: unknown;
  call_status?: unknown;
  from_number?: unknown;
  to_number?: unknown;
  direction?: unknown;
  start_timestamp?: unknown;
  end_timestamp?: unknown;
  duration_ms?: unknown;
  transcript_object?: unknown;
};

/** Read a call back from Retell. Throws on anything but a 200 with a JSON object, so the job retries. */
export async function fetchRetellCall(callId: string, apiKey: string, fetchImpl: typeof fetch = fetch): Promise<RetellCall> {
  const response = await fetchImpl(`${RETELL_API}/v2/get-call/${encodeURIComponent(callId)}`, {
    headers: { authorization: `Bearer ${apiKey}`, accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Retell get-call answered ${response.status}`);
  const body = (await response.json()) as unknown;
  if (!body || typeof body !== "object") throw new Error("Retell get-call answered something other than a call");
  return body as RetellCall;
}

/**
 * The turns, as the transcript email takes them. Retell's agent turns are
 * the text this engine sent; its user turns are the recogniser's, raw. So
 * the caller's words since the agent last spoke are joined into one turn,
 * as the live session joins them (latestCallerWords), and every card
 * number is cut from it as answerTurn cuts it on the live path: a number
 * read out across two utterances is caught whole. One read out around an
 * agent turn is cut where the transcript is queued, which sees the turns
 * together (cutCardNumbersAcrossTurns), so the clinic is never emailed one
 * (CLAUDE.md, "Card numbers are never taken").
 */
export function turnsFromRetell(transcript: unknown): TranscriptTurn[] {
  if (!Array.isArray(transcript)) return [];
  const turns: TranscriptTurn[] = [];
  let caller: string[] = [];
  const flushCaller = () => {
    if (caller.length === 0) return;
    turns.push({ speaker: "person", text: cardNumberIn(caller.join(" ")).text.slice(0, MAX_TURN_CHARS) });
    caller = [];
  };
  for (const entry of transcript.slice(0, MAX_TURNS) as { role?: unknown; content?: unknown }[]) {
    if (!entry || typeof entry.content !== "string") continue;
    if (entry.role === "user") {
      // Cut alone before joining too, then sliced: a number beside other
      // digits in the joined text (a phone number said just before it)
      // can fail the joined match that it passes on its own.
      const text = cardNumberIn(entry.content.trim()).text.slice(0, MAX_TURN_CHARS);
      if (text) caller.push(text);
    } else if (entry.role === "agent") {
      const text = entry.content.trim().slice(0, MAX_TURN_CHARS);
      if (!text) continue;
      flushCaller();
      turns.push({ speaker: "assistant", text });
    }
  }
  flushCaller();
  return turns;
}

/**
 * True when the call's first agent turn is the locked AI line
 * (lib/compliance/disclosure.ts, said first by lib/voice/retell.ts). The
 * line is built for a stand-in name and split around it, so this follows
 * the line's wording rather than a copy of it.
 */
export function openedWithDisclosure(turns: readonly TranscriptTurn[]): boolean {
  const first = turns.find((t) => t.speaker === "assistant");
  if (!first) return false;
  const [before, after] = disclosureFor({ clinicName: "\u0000", channel: "voice" }).split("\u0000");
  return Boolean(before && after) && first.text.startsWith(before!) && first.text.includes(after!);
}

function timestamp(value: unknown): Date | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? new Date(value) : null;
}

export type BackstopRefusal =
  | "not_ended"
  | "wrong_call"
  | "not_a_phone_call"
  | "not_this_clinic"
  | "no_start"
  /**
   * The vendor says we placed it. healdesk places none; the live socket ends
   * such a call at once and its ingest records the security event, so the
   * backstop records nothing and does not record that event a second time.
   */
  | "outbound"
  /**
   * No agent turn: our endpoint never spoke on the call (the socket never
   * opened, or was refused), so there is nothing of ours to record. A call
   * with an agent turn but not the opening line (put through or closed by
   * the fall-through) is recorded, and with no disclosure the ingest neither
   * bills it nor counts it as recovered, and the claims leave it out. A call
   * whose task died mid-call always has the opening line.
   */
  | "never_answered"
  /** ingestCall refused it: a clinic it cannot find. */
  | "ingest_refused";

/**
 * Pure: Retell's call as the vendor-neutral event ingestCall takes, or why
 * it is not one this clinic should record. `assistantNumber` is the clinic's
 * own Retell number (clinics.assistant_number_e164): a call to any other
 * number is not this clinic's, whatever the URL said.
 */
export function callEventFromRetell(
  call: RetellCall,
  clinic: {
    clinicId: string;
    callId: string;
    assistantNumber: string | null;
    /** What the live session raised on the call, read back by its id (runCallBackstop). */
    raised?: { urgent: boolean; handover: boolean };
  },
): { event: VoiceCallEvent } | { refused: BackstopRefusal } {
  if (call.call_id !== clinic.callId) return { refused: "wrong_call" };
  if (call.call_status !== "ended") return { refused: "not_ended" };
  if (call.call_type !== "phone_call") return { refused: "not_a_phone_call" };
  // Before the number: on an outbound call to_number is the party dialled.
  if (call.direction === "outbound") return { refused: "outbound" };
  const to = typeof call.to_number === "string" ? (toE164(call.to_number) ?? call.to_number.trim()) : null;
  const ours = clinic.assistantNumber ? (toE164(clinic.assistantNumber) ?? clinic.assistantNumber.trim()) : null;
  if (!to || !ours || to !== ours) return { refused: "not_this_clinic" };
  const startedAt = timestamp(call.start_timestamp);
  if (!startedAt) return { refused: "no_start" };
  const endedAt = timestamp(call.end_timestamp) ?? undefined;
  const turns = turnsFromRetell(call.transcript_object);
  if (!turns.some((t) => t.speaker === "assistant")) return { refused: "never_answered" };
  const durationSeconds =
    typeof call.duration_ms === "number" && Number.isFinite(call.duration_ms) && call.duration_ms >= 0 ? Math.round(call.duration_ms / 1000) : undefined;
  const from = typeof call.from_number === "string" && call.from_number.trim() ? call.from_number.trim() : undefined;
  return {
    event: {
      externalCallId: clinic.callId,
      clinicId: clinic.clinicId,
      callerPhone: from,
      startedAt,
      endedAt,
      durationSeconds,
      isCallback: false,
      answeredByAssistant: false,
      urgent: clinic.raised?.urgent ?? false,
      ...(clinic.raised?.urgent || clinic.raised?.handover ? { outcome: "escalated_to_human" as const } : {}),
      disclosurePlayedAt: openedWithDisclosure(turns) ? startedAt : undefined,
      transcriptTurns: turns.some((t) => t.speaker === "person") ? turns : undefined,
    },
  };
}

export type BackstopOutcome =
  | { status: "already_recorded" }
  /** Test mode, and not the demo clinic: dropped (voiceRealCallsAllowed). */
  | { status: "test_mode" }
  | { status: "left" }
  | { status: "unknown_clinic" }
  | { status: "refused"; reason: BackstopRefusal }
  | { status: "recorded"; result: IngestResult };

export type BackstopDeps = {
  apiKey?: string | null;
  /** Defaults to voiceRealCallsAllowed() on the environment. */
  realCalls?: boolean;
  fetchCall?: (callId: string, apiKey: string) => Promise<RetellCall>;
  ingest?: (event: VoiceCallEvent) => Promise<IngestResult>;
  transport?: EmailTransport;
  /** Defaults to deleteRetellCallAfterIngest (./recording-alerts.ts) with this key. */
  deleteCall?: (clinicId: string, callId: string) => Promise<RetellCallDeletion>;
};

/**
 * Delete the recorded call at Retell, or throw so the job is retried. Only
 * reached once the call has a conversation here; the delete itself checks
 * again and asks Retell nothing without one.
 */
async function deleteAtRetellOrRetry(clinicId: string, callId: string, deps: BackstopDeps): Promise<void> {
  const apiKey = deps.apiKey === undefined ? retellApiKey() : deps.apiKey;
  const outcome = await (deps.deleteCall ?? ((c, id) => deleteRetellCallAfterIngest(c, id, { apiKey })))(clinicId, callId);
  if (outcome.status === "failed") throw new Error(`the call was not deleted at Retell: ${outcome.reason}`);
}

/**
 * The job: record the call if, and only if, nothing has yet. Throws when it
 * should be retried (no key, Retell unreachable, a call Retell still has as
 * ongoing); returns when there is nothing more to do.
 */
export async function runCallBackstop(payload: CallBackstopPayload, deps: BackstopDeps = {}): Promise<BackstopOutcome> {
  const { clinicId, callId } = payload;
  if (!isRetellCallId(callId)) return { status: "refused", reason: "wrong_call" };

  const state = await withTenant({ clinicId, actor: ACTOR }, async (tx) => {
    const [clinic] = await tx.db
      .select({ assistantNumber: clinics.assistantNumberE164 })
      .from(clinics)
      .where(eq(clinics.id, clinicId))
      .limit(1);
    if (!clinic) return { status: "unknown_clinic" as const };
    if (await clinicHasLeft(tx, { lock: false })) return { status: "left" as const };
    // The voice line's test mode, read by the voice line's own switch
    // (./test-calls): until real calls are on, only the demo clinic's calls
    // are recorded, so the backstop records no other clinic's either. A call
    // dropped this way leaves nothing behind, and Retell is not asked for it.
    if (!(deps.realCalls ?? voiceRealCallsAllowed()) && !(await isDemoClinic(tx))) return { status: "test_mode" as const };
    const [existing] = await tx.db
      .select({ id: conversations.id })
      .from(conversations)
      .where(and(eq(conversations.clinicId, clinicId), eq(conversations.externalCallId, callId)))
      .limit(1);
    if (existing) return { status: "recorded_here" as const };
    // What the session raised while the call was up, by the call's id: its
    // urgent alert, queued under a key naming the call, and its handover.
    const [urgentAlert] = await tx.db
      .select({ id: billingNotices.id })
      .from(billingNotices)
      .where(and(eq(billingNotices.clinicId, clinicId), eq(billingNotices.kind, "urgent"), eq(billingNotices.dedupeKey, dedupeKey("urgent", { callId }))))
      .limit(1);
    const [handover] = await tx.db
      .select({ id: handovers.id })
      .from(handovers)
      .where(and(eq(handovers.clinicId, clinicId), eq(handovers.channel, "voice"), eq(handovers.externalCallId, callId)))
      .limit(1);
    return { status: "open" as const, assistantNumber: clinic.assistantNumber, raised: { urgent: Boolean(urgentAlert), handover: Boolean(handover) } };
  });
  if (state.status === "recorded_here") {
    // The usual case: the live socket recorded the call, and its transcript
    // is sealed with it. Retell's copy goes now.
    await deleteAtRetellOrRetry(clinicId, callId, deps);
    return { status: "already_recorded" };
  }
  if (state.status !== "open") return state;

  const apiKey = deps.apiKey === undefined ? retellApiKey() : deps.apiKey;
  if (!apiKey) throw new Error("HEALDESK_RETELL_API_KEY is unset: the call cannot be read back from Retell");
  const call = await (deps.fetchCall ?? fetchRetellCall)(callId, apiKey);

  const mapped = callEventFromRetell(call, { clinicId, callId, assistantNumber: state.assistantNumber, raised: state.raised });
  if ("refused" in mapped) {
    // Retell still has it as ongoing: a long call outlived the delay. Retry later.
    if (mapped.refused === "not_ended" && (call.call_status === "ongoing" || call.call_status === "registered")) {
      throw new Error("Retell has the call as still in progress");
    }
    return { status: "refused", reason: mapped.refused };
  }
  // A duplicate here is the live socket, or a second job, recording first:
  // ingestCall returns the stored row and writes nothing twice.
  let result: IngestResult;
  try {
    result = await (deps.ingest ?? ((e) => ingestCall(e, ACTOR, { transport: deps.transport })))(mapped.event);
  } catch (error) {
    // A refusal is final; retrying it would refuse it again. Either way the
    // call is not recorded here, so Retell's copy is not touched.
    if (error instanceof VoiceIngestError) return { status: "refused", reason: "ingest_refused" };
    throw error;
  }
  // Committed: the conversation and its sealed transcript, and the email
  // tried once. Retell's copy goes now; a failure retries the job, which
  // then finds the conversation and comes straight back here.
  await deleteAtRetellOrRetry(clinicId, callId, deps);
  return { status: "recorded", result };
}

/** The worker's handler for one job: logs ids and outcomes only, never the call's content. */
export async function handleCallBackstopJob(payload: CallBackstopPayload, deps: BackstopDeps = {}): Promise<void> {
  try {
    const outcome = await runCallBackstop(payload, deps);
    if (outcome.status === "recorded") {
      log.warn("voice call recorded by the backstop", {
        clinicId: payload.clinicId,
        conversationId: outcome.result.conversationId,
        status: outcome.result.duplicate ? "duplicate" : "recorded",
      });
    } else if (outcome.status === "already_recorded") {
      // The usual case: the live socket got there first, and Retell's copy
      // is now deleted. Logged so a test call shows the backstop ran.
      log.info("voice call backstop found the call recorded and deleted it at Retell", { clinicId: payload.clinicId, status: outcome.status });
    } else if (outcome.status === "test_mode") {
      log.info("voice call backstop dropped a call in test mode", { clinicId: payload.clinicId, status: outcome.status });
    } else if (outcome.status === "refused" || outcome.status === "unknown_clinic") {
      log.warn("voice call backstop refused", { clinicId: payload.clinicId, status: outcome.status === "refused" ? outcome.reason : outcome.status });
    }
  } catch (error) {
    // Rethrown described, never as it was: pg-boss stores a failed job's
    // error in its own tables, which have no RLS, and a query error carries
    // its parameters, the caller's number among them.
    const described = describeError(error);
    log.error("voice call backstop failed", { clinicId: payload.clinicId, error: described });
    throw new Error(described);
  }
}
