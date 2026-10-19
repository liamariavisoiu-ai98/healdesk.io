import { toE164 } from "@healdesk/connectors";
import { and, eq } from "drizzle-orm";

import { clinics, conversations } from "@/db/schema";
import type { ActorContext } from "@/lib/audit";
import { clinicHasLeft } from "@/lib/clinic/leaving";
import { disclosureFor } from "@/lib/compliance/disclosure";
import type { TranscriptTurn } from "@/lib/conversations/transcript-email";
import { describeError, log } from "@/lib/log";
import { enqueue, QUEUE_VOICE_CALL_BACKSTOP } from "@/lib/queue/boss";
import type { EmailTransport } from "@/lib/reporting/deliver";
import { withTenant } from "@/lib/tenant";

import { ingestCall, VoiceIngestError, type IngestResult, type VoiceCallEvent } from "./ingest";

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
 * transcript. For the same reason the outcome is left unset, the call is
 * not evidence of a first answer (the gate's decision is unknown), and
 * `urgent` stays false; an urgent caller's alert was raised in the call
 * itself, when it was heard.
 */

/** Long after any live socket has recorded its call; short enough that the clinic's transcript is still timely. */
export const BACKSTOP_DELAY_SECONDS = 10 * 60;

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
): Promise<void> {
  await send(QUEUE_VOICE_CALL_BACKSTOP, { clinicId: payload.clinicId, callId: payload.callId }, {
    startAfter: BACKSTOP_DELAY_SECONDS,
    singletonKey: `${payload.clinicId}:${payload.callId}`,
    // Retell's API down for a while is the likely failure; give it the hour.
    retryLimit: 6,
    retryDelay: 120,
    retryBackoff: true,
  });
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

/** The turns, as the transcript email takes them. Retell's agent turns are the text this engine sent; its user turns are the recogniser's. */
export function turnsFromRetell(transcript: unknown): TranscriptTurn[] {
  if (!Array.isArray(transcript)) return [];
  const turns: TranscriptTurn[] = [];
  for (const entry of transcript.slice(0, MAX_TURNS) as { role?: unknown; content?: unknown }[]) {
    if (!entry || typeof entry.content !== "string") continue;
    const text = entry.content.trim().slice(0, MAX_TURN_CHARS);
    if (!text) continue;
    if (entry.role === "agent") turns.push({ speaker: "assistant", text });
    else if (entry.role === "user") turns.push({ speaker: "person", text });
  }
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
  /** ingestCall refused it: an outbound call (recorded there as a security event), or a clinic it cannot find. */
  | "ingest_refused";

/**
 * Pure: Retell's call as the vendor-neutral event ingestCall takes, or why
 * it is not one this clinic should record. `assistantNumber` is the clinic's
 * own Retell number (clinics.assistant_number_e164): a call to any other
 * number is not this clinic's, whatever the URL said.
 */
export function callEventFromRetell(
  call: RetellCall,
  clinic: { clinicId: string; callId: string; assistantNumber: string | null },
): { event: VoiceCallEvent } | { refused: BackstopRefusal } {
  if (call.call_id !== clinic.callId) return { refused: "wrong_call" };
  if (call.call_status !== "ended") return { refused: "not_ended" };
  if (call.call_type !== "phone_call") return { refused: "not_a_phone_call" };
  const to = typeof call.to_number === "string" ? (toE164(call.to_number) ?? call.to_number.trim()) : null;
  const ours = clinic.assistantNumber ? (toE164(clinic.assistantNumber) ?? clinic.assistantNumber.trim()) : null;
  if (!to || !ours || to !== ours) return { refused: "not_this_clinic" };
  const startedAt = timestamp(call.start_timestamp);
  if (!startedAt) return { refused: "no_start" };
  const endedAt = timestamp(call.end_timestamp) ?? undefined;
  const turns = turnsFromRetell(call.transcript_object);
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
      // ingestCall refuses an outbound call and records it as a security event, as for the live socket.
      isCallback: call.direction === "outbound",
      answeredByAssistant: false,
      urgent: false,
      disclosurePlayedAt: openedWithDisclosure(turns) ? startedAt : undefined,
      transcriptTurns: turns.some((t) => t.speaker === "person") ? turns : undefined,
    },
  };
}

export type BackstopOutcome =
  | { status: "already_recorded" }
  | { status: "left" }
  | { status: "unknown_clinic" }
  | { status: "refused"; reason: BackstopRefusal }
  | { status: "recorded"; result: IngestResult };

export type BackstopDeps = {
  apiKey?: string | null;
  fetchCall?: (callId: string, apiKey: string) => Promise<RetellCall>;
  ingest?: (event: VoiceCallEvent) => Promise<IngestResult>;
  transport?: EmailTransport;
};

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
    const [existing] = await tx.db
      .select({ id: conversations.id })
      .from(conversations)
      .where(and(eq(conversations.clinicId, clinicId), eq(conversations.externalCallId, callId)))
      .limit(1);
    if (existing) return { status: "already_recorded" as const };
    return { status: "open" as const, assistantNumber: clinic.assistantNumber };
  });
  if (state.status !== "open") return state;

  const apiKey = deps.apiKey === undefined ? retellApiKey() : deps.apiKey;
  if (!apiKey) throw new Error("HEALDESK_RETELL_API_KEY is unset: the call cannot be read back from Retell");
  const call = await (deps.fetchCall ?? fetchRetellCall)(callId, apiKey);

  const mapped = callEventFromRetell(call, { clinicId, callId, assistantNumber: state.assistantNumber });
  if ("refused" in mapped) {
    // Retell still has it as ongoing: a long call outlived the delay. Retry later.
    if (mapped.refused === "not_ended" && (call.call_status === "ongoing" || call.call_status === "registered")) {
      throw new Error("Retell has the call as still in progress");
    }
    return { status: "refused", reason: mapped.refused };
  }
  // A duplicate here is the live socket, or a second job, recording first:
  // ingestCall returns the stored row and writes nothing twice.
  try {
    const result = await (deps.ingest ?? ((e) => ingestCall(e, ACTOR, { transport: deps.transport })))(mapped.event);
    return { status: "recorded", result };
  } catch (error) {
    // A refusal is final; retrying it would only record the security event again.
    if (error instanceof VoiceIngestError) return { status: "refused", reason: "ingest_refused" };
    throw error;
  }
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
    } else if (outcome.status === "refused" || outcome.status === "unknown_clinic") {
      log.warn("voice call backstop refused", { clinicId: payload.clinicId, status: outcome.status === "refused" ? outcome.reason : outcome.status });
    }
  } catch (error) {
    log.error("voice call backstop failed", { clinicId: payload.clinicId, error: describeError(error) });
    throw error;
  }
}
