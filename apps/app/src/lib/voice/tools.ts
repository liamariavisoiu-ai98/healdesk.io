import { createHash, timingSafeEqual } from "node:crypto";

import { resolveBookingRequirements } from "@healdesk/catalog";
import { toE164, zonedToUtc } from "@healdesk/connectors";
import { eq } from "drizzle-orm";

import { agentConfigs, clinics, type DepositPolicy } from "@/db/schema";
import type { ActorContext } from "@/lib/audit";
import { servicesEnded, voiceAnswerDecision, type AnswerDecision } from "@/lib/billing/answering";
import {
  clinicDefaultDepositUsd,
  depositDecision,
  normaliseDepositUsd,
  readClinicDepositFacts,
  type DepositAction,
} from "@/lib/billing/deposits";
import { bookConversation, keyReusedFor, logRequest, offerTimes, placeHold, type BookConversationResult, type OfferedTime } from "@/lib/booking/engine";
import { HOLD_SECONDS } from "@/lib/booking/holds";
import {
  bookedLine,
  DEPOSIT_HOLD_LINE,
  DEPOSIT_REQUEST_LINE,
  HOLD_LINE,
  IN_PROGRESS_LINE,
  MANUAL_BOOKING_LINE,
  MISSING_DETAIL_LINES,
  NO_FREE_TIME_LINE,
  ONE_REQUEST_PER_CALL_LINE,
  oneBookingPerCallLine,
  REQUEST_TAKEN_LINE,
  slotGoneLine,
  TOOL_FAILURE_LINE,
} from "@/lib/booking/lines";
import { clinicHasLeft } from "@/lib/clinic/leaving";
import { bookingModeFor } from "@/lib/booking/mode";
import { isDemoClinic } from "@/lib/booking/terms";
import { env } from "@/lib/env";
import { describeError, log } from "@/lib/log";
import type { EmailTransport } from "@/lib/reporting/deliver";
import { withTenant, type TenantTx } from "@/lib/tenant";

import { spokenFieldList, spokenPhone, spokenSlot } from "./spoken";

/**
 * The mid-call tool routes (design of 23 September 2026, §E.2): what the
 * phone agent may ask the product for while a call is up, and the only way
 * a voice call writes anything before its post-call webhook.
 *
 * Pre-Retell. These are HTTP routes a Synthflow agent calls mid-call. The v1
 * voice agent runs on Retell, whose custom-LLM WebSocket endpoint will run
 * the same fixed tool layer (availability, the 60-second slot hold, the
 * booking write) in its own long-lived process (launch plan step 2.1); the
 * logic here is what that endpoint should call, not a second copy of it.
 *
 * Five tools behind one handler:
 *
 *   context   what this clinic's assistant asks for, and whether it may
 *             book: the requirement set as one spoken sentence, the
 *             booking mode, the deposit line and the practice's number for
 *             the ear.
 *   slots     free times (the engine's offerTimes), three at most, each
 *             with its spoken form.
 *   hold      one of them held for 60 seconds (placeHold), before anything
 *             confirming is said.
 *   book      the booking: hold, re-check, claim, write, record
 *             (bookConversation), answered with a fixed line.
 *   request   the caller's preferred time as a request for the clinic to
 *             confirm (logRequest).
 *
 * A pre-Retell test harness (plan §7.13). No time read from a clinic's
 * Google Calendar reaches Synthflow for any real clinic: for every clinic
 * but healdesk's demo clinic (app_clinic_is_demo), the context says
 * `desk_confirms` and cannot offer times (`harness_demo_only`), `slots`,
 * `hold` and `book` answer 403 `manual_booking`, and `request` answers 403
 * `not_available`, so the post-call webhook stays the one path by which a
 * request reaches that clinic's desk, synthetic clinics in setup included.
 * The demo clinic reaches the booking engine (lib/booking/engine.ts), which
 * is all the booking there is: these routes add only the keys, the order
 * of the answer gate and the fixed lines (lib/booking/lines.ts). The keys
 * are the harness's (the design record's §6): holder "voice:" + call id,
 * booking key the call id itself, so a call books once or passes one
 * request, and a retry of either answers as the first did.
 *
 * B's answer gate (lib/billing/answering.ts voiceAnswerDecision) is asked
 * before any time is offered or held, and for a booking after its replay,
 * as the engine's `gate`. `request` asks it only for one thing: taking a
 * request is what a refused call with no direct line falls back to, so a
 * patient calling a clinic always reaches someone (CLAUDE.md, "Failure"),
 * except once the Services have ended (servicesEnded: no agreement, or the
 * subscription over), when nothing may take the caller's details and the
 * call is closed with a fixed line (answer_mode "closed").
 *
 * What the future Retell process should take from here: the engine calls
 * with its own keys ("retell:" + call id, and "retell:" + call id + ":" + n
 * for each booking the caller asks for), the fixed lines, depositLine for a
 * deposit (a call is never sent a link), voiceOffer for the times it says,
 * times read on the clinic's clock, and the order in which the gate is
 * asked. The design record's §6 keeps that contract.
 *
 * The call-back tool of 23 September 2026 (§F.9) was removed: v1 places no
 * calls.
 *
 * Authentication is a fixed Bearer secret compared in constant time, and it
 * is a DIFFERENT secret from the post-call webhook's: these routes can book;
 * the webhook can only report. Unset means 503 and nothing written. Bodies are capped at 32 KB and must carry the vendor's
 * `call_id` and `user_phone_number`; the limits are 60 calls a minute per
 * clinic and 12 per call id. Every call writes one audit row whose metadata
 * carries `callRef`, the SHA-256 of the call id — the scanner strips a
 * 64-hex digest, where a raw vendor id can be digit-heavy enough to read as
 * a phone number — and never the number itself.
 */

export type VoiceTool = "context" | "slots" | "hold" | "book" | "request";

export const VOICE_TOOL_MAX_BODY_BYTES = 32 * 1024;
/** At most this many times in one voice offer (Q7; plan §6.4; the spec's "two or three options aloud"). */
export const VOICE_TOOL_SLOT_LIMIT = 3;
/** How long a booking waits for Google before the caller hears a request instead; the write carries on and records itself. */
export const BOOK_CALENDAR_BUDGET_MS = 8_000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOOL_ACTOR: ActorContext = { type: "agent", serviceName: "voice-tools" };

/** The `slots`, `hold` and `book` answer for every clinic but the demo clinic (plan §7.13), and the demo clinic's when it takes requests. */
export const MANUAL_BOOKING_REPLY = {
  status: 403,
  body: { error: "manual_booking", say: MANUAL_BOOKING_LINE },
} as const;

type Deps = { transport?: EmailTransport; now?: Date };

let depsForTests: Deps | undefined;
/** Test seam: the desk's email transport and the clock. Undefined restores the real ones. */
export function __setVoiceToolRuntimeForTests(deps: Deps | undefined): void {
  depsForTests = deps;
}

// -----------------------------------------------------------------------------
// The handler every route delegates to
// -----------------------------------------------------------------------------

export async function handleVoiceTool(request: Request, clinicIdParam: string, tool: VoiceTool, deps: Deps = depsForTests ?? {}): Promise<Response> {
  const secret = env.voiceToolsSecret();
  if (!secret) {
    log.error("HEALDESK_VOICE_TOOLS_SECRET is not set; refusing voice tool calls");
    return Response.json({ error: "Voice tools are not configured." }, { status: 503 });
  }
  if (!authorised(request, secret)) return Response.json({ error: "Unauthorized." }, { status: 401 });
  if (!UUID.test(clinicIdParam)) return Response.json({ error: "Unknown endpoint." }, { status: 404 });
  const clinicId = clinicIdParam.toLowerCase();

  const raw = await request.text();
  if (Buffer.byteLength(raw, "utf8") > VOICE_TOOL_MAX_BODY_BYTES) return Response.json({ error: "Payload too large." }, { status: 413 });
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return Response.json({ error: "Invalid JSON." }, { status: 400 });
  }
  const body = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  const callId = text(body?.call_id, 200);
  const phone = toE164(text(body?.user_phone_number, 32));
  if (!body || !callId) return Response.json({ error: "call_id is required." }, { status: 400 });
  if (!phone) return Response.json({ error: "user_phone_number is required and must be a phone number." }, { status: 400 });

  if (!withinVoiceToolLimit(clinicId, callId)) return Response.json({ error: "Too many requests." }, { status: 429 });

  const call: ToolCall = { clinicId, callId, callRef: callRefOf(callId), phone, body, now: deps.now ?? new Date(), transport: deps.transport };
  try {
    // The tools that write (a hold, a booking, a request) write nothing for
    // a clinic that has left (lib/clinic/leaving.ts; the branch review's
    // R11): the caller hears the failure line, and the call goes on to the
    // clinic's direct line as any failure does.
    if (tool !== "context" && tool !== "slots") {
      const left = await withTenant({ clinicId, actor: TOOL_ACTOR }, (tx) => clinicHasLeft(tx));
      if (left) {
        log.warn("voice tool refused: the clinic has left", { clinicId, op: tool });
        return Response.json(LEFT_REPLY.body, { status: LEFT_REPLY.status });
      }
    }
    let reply: ToolReply;
    if (tool === "book") {
      reply = await voiceToolBook(call);
    } else if (tool === "request") {
      // A request is what a refused call falls back to (see the header), so
      // the gate stops it only once the Services have ended.
      const gate = await voiceAnswerDecision(clinicId, call.now);
      reply = gate.decision === "pass_through" && servicesEnded(gate.reason) ? await closedRequest(call, gate.reason) : await voiceToolRequest(call);
    } else {
      // The answer gate (BD22, BD25), outside any transaction, for the
      // tools that decide what the assistant does on this call: `context` at
      // its first turn, and `slots` and `hold` before a time is offered or
      // held. `book` asks it after its replay (voiceToolBook), so a retry of
      // a booking that already went through still hears that it did,
      // whatever the gate says now.
      const gate = await voiceAnswerDecision(clinicId, call.now);
      reply = await (tool === "context" ? voiceToolContext(call, gate) : tool === "slots" ? voiceToolSlots(call, gate) : voiceToolHold(call, gate));
    }
    return Response.json(reply.body, { status: reply.status });
  } catch (error) {
    // A BAA-gate refusal (synthetic clinic in production) or a database
    // outage. Nothing about the caller is in the message.
    log.error("voice tool failed", { clinicId, op: tool, error: describeError(error) });
    return Response.json({ error: "The tool could not be completed." }, { status: 500 });
  }
}

/**
 * The Services have ended (no agreement in effect, or the subscription over)
 * and the clinic has no direct line: the runtime says this and ends the
 * call, with no assistant, nothing listened to and nothing taken down. Not
 * the assistant's voice: a fixed line, so it makes no claim to be one.
 */
export const CLOSED_LINE =
  "Thank you for calling. This line isn't being answered here at the moment. Please try the practice again later, or contact them another way.";

const CLOSED_REPLY: ToolReply = { status: 403, body: { error: "closed", say: CLOSED_LINE } };

/** A request on a call to a clinic whose Services have ended: refused, with its audit row, codes only. */
async function closedRequest(call: ToolCall, reason: string): Promise<ToolReply> {
  await withTenant({ clinicId: call.clinicId, actor: TOOL_ACTOR }, async (tx) => {
    tx.audit.record({ action: "create", resourceType: "voice_tool_request", resourceId: tx.clinicId, metadata: { callRef: call.callRef, outcome: "refused", reason } });
  });
  return CLOSED_REPLY;
}

/** A hold, a booking or a request for a clinic that has left. */
const LEFT_REPLY = { status: 403, body: { error: "not_available", say: TOOL_FAILURE_LINE } } as const;

type ToolCall = { clinicId: string; callId: string; callRef: string; phone: string; body: Record<string, unknown>; now: Date; transport?: EmailTransport };
type ToolReply = { status: number; body: Record<string, unknown> };

function authorised(request: Request, secret: string): boolean {
  const header = request.headers.get("authorization") ?? "";
  const presented = header.startsWith("Bearer ") ? header.slice(7) : header;
  const a = Buffer.from(presented);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The full 64-hex SHA-256 of the vendor's call id: what the audit rows carry instead of the id. */
export function callRefOf(callId: string): string {
  return createHash("sha256").update(callId, "utf8").digest("hex");
}

function text(v: unknown, max: number): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim().replace(/\s+/g, " ").slice(0, max) : undefined;
}

// -----------------------------------------------------------------------------
// Rate limits — the attempt-limit.ts pattern, per clinic and per call id
// -----------------------------------------------------------------------------

const LIMIT_WINDOW_MS = 60_000;
export const VOICE_TOOL_LIMITS = { perClinic: 60, perCall: 12 } as const;
const MAX_TRACKED_WINDOWS = 10_000;
const windows = new Map<string, { count: number; resetAt: number }>();

/** Both counters are always taken, never short-circuited, so tripping one buys no pass on the other. */
export function withinVoiceToolLimit(clinicId: string, callId: string, now = Date.now()): boolean {
  reclaim(now);
  const clinicOk = take(`c:${clinicId}`, VOICE_TOOL_LIMITS.perClinic, now);
  // Keyed on the digest, never the id: this map outlives the request.
  const callOk = take(`k:${callRefOf(callId)}`, VOICE_TOOL_LIMITS.perCall, now);
  return clinicOk && callOk;
}

export function __resetVoiceToolLimitsForTests(): void {
  windows.clear();
}

function take(key: string, limit: number, now: number): boolean {
  const existing = windows.get(key);
  if (!existing || existing.resetAt <= now) {
    windows.set(key, { count: 1, resetAt: now + LIMIT_WINDOW_MS });
    return true;
  }
  existing.count += 1;
  return existing.count <= limit;
}

function reclaim(now: number): void {
  if (windows.size < 1_000) return;
  for (const [key, window] of windows) if (window.resetAt <= now) windows.delete(key);
  if (windows.size < MAX_TRACKED_WINDOWS) return;
  for (const [key] of [...windows.entries()].sort((a, b) => a[1].resetAt - b[1].resetAt).slice(0, MAX_TRACKED_WINDOWS / 10)) windows.delete(key);
}

// -----------------------------------------------------------------------------
// context
// -----------------------------------------------------------------------------

export type VoiceContextReply = {
  required_fields_spoken: string;
  /** "direct" only for healdesk's demo clinic while bookingModeFor says live; every other clinic takes requests. */
  booking_mode: "desk_confirms" | "direct";
  /** Whether the assistant may offer real free times on this call (bookingModeFor's canOfferTimes). */
  can_offer_times: boolean;
  /** How long a held time lasts while the caller's details are taken. */
  hold_seconds: number;
  /** Why the assistant takes requests, as codes: `harness_demo_only` for any clinic but the demo clinic. */
  booking_mode_reasons: string[];
  deposit_line: string;
  clinic_phone_spoken: string;
  /**
   * What the agent does with this call (BD25): "assistant" answers it;
   * "pass_through" transfers it to `transfer_number`, the clinic's direct
   * line, because the answer gate refused (billing, the channel, the pause,
   * coverage or "Stop and fall back"); "closed" says `closed_line` and ends
   * the call, with no assistant, because the Services have ended and there
   * is no direct line to send it to (servicesEnded).
   */
  answer_mode: "assistant" | "pass_through" | "closed";
  /** The direct line, E.164, only for "pass_through"; null otherwise. */
  transfer_number: string | null;
  /** Only for "closed": the fixed line said before the call ends; null otherwise. */
  closed_line: string | null;
};

/**
 * The call's context, with the gate's decision applied. A refusal with a
 * direct line passes the call through to it. A refusal with NO direct line
 * has nowhere to send the caller, and a patient calling a clinic must always
 * reach someone (CLAUDE.md, "Failure"; R25): the assistant answers with the
 * fixed safe script, the ordinary request flow (`desk_confirms`: it takes
 * the caller's details for the front desk and books nothing), and ops has
 * already been told (voiceAnswerDecision). Either way a refused call never
 * books straight into the calendar, so `booking_mode` is never "direct" then.
 *
 * The booking mode is the harness's (plan §7.13): requests, with no times on
 * offer, for every clinic but healdesk's demo clinic, whose mode is read
 * fresh from bookingModeFor.
 */
async function voiceToolContext(call: ToolCall, gate: AnswerDecision): Promise<ToolReply> {
  const refused = gate.decision === "pass_through";
  const transferTo = gate.decision === "pass_through" ? gate.directLine : null;
  const closed = gate.decision === "pass_through" && transferTo === null && servicesEnded(gate.reason);
  const reply = await withTenant({ clinicId: call.clinicId, actor: TOOL_ACTOR }, async (tx): Promise<VoiceContextReply | null> => {
    const [clinic] = await tx.db
      .select({ specialty: clinics.specialty, requirements: clinics.bookingRequirements, phone: clinics.publishedPhoneE164 })
      .from(clinics)
      .where(eq(clinics.id, tx.clinicId))
      .limit(1);
    if (!clinic) return null;
    const [agent] = await tx.db.select({ depositPolicy: agentConfigs.depositPolicy }).from(agentConfigs).where(eq(agentConfigs.clinicId, tx.clinicId)).limit(1);
    const mode = await bookingModeFor(tx);
    const direct = !refused && mode.demo && mode.mode === "live";
    const canOfferTimes = !refused && mode.demo && mode.canOfferTimes;
    const reasons = mode.demo ? mode.reasons.map((r) => r.code as string) : ["harness_demo_only"];
    const answerMode = transferTo ? "pass_through" : closed ? "closed" : "assistant";
    tx.audit.record({
      action: "read",
      resourceType: "voice_tool_context",
      resourceId: tx.clinicId,
      metadata: { callRef: call.callRef, bookingMode: direct ? "direct" : "desk_confirms", answerMode, ...(gate.decision === "pass_through" ? { reason: gate.reason } : {}) },
    });
    return {
      required_fields_spoken: spokenFieldList(resolveBookingRequirements(clinic.specialty, clinic.requirements ?? null)),
      booking_mode: direct ? "direct" : "desk_confirms",
      can_offer_times: canOfferTimes,
      hold_seconds: HOLD_SECONDS,
      booking_mode_reasons: reasons,
      // A closed call says nothing but its line: no deposit rule, and not
      // the published number, which is the very line forwarded here.
      deposit_line: closed ? "" : await voiceDepositLine(tx, agent?.depositPolicy ?? null),
      clinic_phone_spoken: !closed && clinic.phone ? spokenPhone(clinic.phone) : "",
      answer_mode: answerMode,
      transfer_number: transferTo,
      closed_line: closed ? CLOSED_LINE : null,
    };
  });
  if (!reply) return { status: 404, body: { error: "Unknown endpoint." } };
  return { status: 200, body: reply };
}

/**
 * The deposit rule as the agent states it (BD27): what the deposit decision
 * means for this caller, and who collects, never a payment link (voice never
 * collects, §E.7). `book_and_flag` books and leaves the deposit to the front
 * desk; `decline_and_alert` books nothing, so the line never promises a
 * booking, and says the team will call to take the deposit and confirm a
 * time. `booking` is one appointment's line; `clinic` is the context's line
 * for the clinic's default deposit, said before anything is chosen;
 * `some_services` is the context's line when there is no default but some
 * services ask for one, and the agent learns which at booking.
 */
export function depositLine(input: { action: DepositAction; amountUsd: number | null; scope?: "booking" | "clinic" | "some_services" } | null): string {
  if (!input) return "";
  const amount = input.amountUsd !== null && Number.isFinite(input.amountUsd) && input.amountUsd > 0 ? input.amountUsd : null;
  if (input.action === "book_and_flag") {
    if (input.scope === "some_services") return "Some appointments need a deposit to hold them. If yours does, the front desk will call you to take it; nothing is charged on this call.";
    return `${amount !== null ? `A deposit of ${amount} dollars` : "A deposit"} is required to hold the appointment. The front desk will call you to take it; nothing is charged on this call.`;
  }
  if (input.action === "decline_and_alert") {
    if (input.scope === "some_services") return "Some appointments need a deposit and can't be booked on this call. For those, I'll pass your request to the team, who will call you to take the deposit and confirm a time; nothing is charged on this call.";
    if (input.scope === "clinic") return `Appointments need a deposit${amount !== null ? ` of ${amount} dollars` : ""}, so they can't be booked on this call. I'll pass your request to the team, who will call you to take the deposit and confirm a time; nothing is charged on this call.`;
    return `This appointment needs a deposit${amount !== null ? ` of ${amount} dollars` : ""}, so it can't be booked on this call. I'll pass your request to the team, who will call you to take the deposit and confirm a time; nothing is charged on this call.`;
  }
  return "";
}

/**
 * The context's deposit line for this clinic: the decision for the clinic's
 * default deposit, or, when there is none, for the services that set their
 * own, so a caller is told before they choose. Voice's own switch decides
 * (lib/billing/deposits.ts depositDecision); deposits off, no connected
 * account or no amount means no line at all.
 */
async function voiceDepositLine(tx: TenantTx, policy: DepositPolicy | null): Promise<string> {
  const facts = await readClinicDepositFacts(tx);
  const base = {
    channel: "voice" as const,
    depositsEnabled: facts.depositsEnabled,
    isConnected: facts.isConnected,
    bookVoiceWithoutDeposit: facts.bookVoiceWithoutDeposit,
    bookChatWithoutDeposit: facts.bookChatWithoutDeposit,
    uncollectable: facts.uncollectable,
  };
  const byDefault = depositDecision({ ...base, amountUsd: clinicDefaultDepositUsd(policy) });
  if (byDefault.isRequired) return depositLine({ action: byDefault.action, amountUsd: byDefault.amountUsd, scope: "clinic" });
  const smallest = facts.services.map((service) => normaliseDepositUsd(service.depositUsd)).filter((usd): usd is number => usd !== null && usd > 0).sort((a, b) => a - b)[0];
  if (smallest === undefined) return "";
  const bySome = depositDecision({ ...base, amountUsd: smallest });
  return bySome.isRequired ? depositLine({ action: bySome.action, amountUsd: null, scope: "some_services" }) : "";
}

// -----------------------------------------------------------------------------
// slots, hold, book and request: the engine, for the demo clinic (plan §7.13)
// -----------------------------------------------------------------------------

/** A refused call hears only that the service is unavailable, never why: a clinic's billing state is not the voice vendor's business. */
const SERVICE_UNAVAILABLE_REPLY: ToolReply = { status: 403, body: { error: "service_unavailable" } };
const UNKNOWN_CLINIC_REPLY: ToolReply = { status: 404, body: { error: "Unknown endpoint." } };
/** Google, or the engine, did not answer: the agent says the fixed line and offers a person. */
const TOOL_FAILURE_REPLY: ToolReply = { status: 503, body: { error: "unavailable", say: TOOL_FAILURE_LINE } };
const IN_PROGRESS_REPLY: ToolReply = { status: 409, body: { error: "in_progress", say: IN_PROGRESS_LINE } };
/**
 * `request` for every clinic but the demo clinic: the agent takes the
 * details itself, and the post-call webhook writes the request and mails the
 * desk (lib/voice/ingest.ts, notifyDesk).
 */
const REQUEST_NOT_AVAILABLE_REPLY: ToolReply = { status: 403, body: { error: "not_available", say: TOOL_FAILURE_LINE } };

type ToolResource = "voice_tool_slots" | "voice_tool_hold" | "voice_tool_book" | "voice_tool_request";

/** What the harness needs of the clinic: whether it is healdesk's demo clinic, and its clock. */
type Harness = { demo: boolean; timeZone: string };

async function harnessOf(tx: TenantTx): Promise<Harness | null> {
  const [clinic] = await tx.db.select({ timeZone: clinics.timezone }).from(clinics).where(eq(clinics.id, tx.clinicId)).limit(1);
  if (!clinic) return null;
  return { demo: await isDemoClinic(tx), timeZone: clinic.timeZone };
}

/** The harness's holder key (the design record's §6); its booking key is the call id itself. */
function holderKeyOf(call: ToolCall): string {
  return `voice:${call.callId}`;
}

/**
 * `slots` and `hold` before the engine: the answer gate's refusal, or the
 * parked `manual_booking` for any clinic but the demo clinic, each with its
 * audit row. A demo call that has already booked or passed a request hears
 * so here, before another time is offered or held: its key allows one, so a
 * time held now could only end in `key_reused` once the caller had chosen
 * it. Otherwise the demo clinic's facts to go on with.
 */
async function parkedOr(call: ToolCall, resourceType: ToolResource, gate: AnswerDecision): Promise<{ reply: ToolReply } | { harness: Harness }> {
  const action = resourceType === "voice_tool_slots" ? "read" : "create";
  return withTenant({ clinicId: call.clinicId, actor: TOOL_ACTOR }, async (tx) => {
    if (gate.decision === "pass_through") {
      tx.audit.record({ action, resourceType, resourceId: tx.clinicId, metadata: { callRef: call.callRef, outcome: "refused", reason: gate.reason } });
      return { reply: SERVICE_UNAVAILABLE_REPLY };
    }
    const harness = await harnessOf(tx);
    if (!harness) return { reply: UNKNOWN_CLINIC_REPLY };
    if (!harness.demo) {
      tx.audit.record({ action, resourceType, resourceId: tx.clinicId, metadata: { callRef: call.callRef, outcome: "refused", reason: "manual_booking" } });
      return { reply: MANUAL_BOOKING_REPLY };
    }
    const used = await keyReusedFor(tx, call.callId);
    if (used) {
      tx.audit.record({ action, resourceType, resourceId: tx.clinicId, metadata: { callRef: call.callRef, outcome: "key_reused", reason: used.first } });
      return { reply: keyReusedReply(used, harness.timeZone) };
    }
    return { harness };
  });
}

/** One audit row for an engine answer, in a short transaction of its own: the engine runs outside any. Codes and counts only. */
async function auditTool(call: ToolCall, resourceType: ToolResource, metadata: Record<string, string | number | boolean>): Promise<void> {
  await withTenant({ clinicId: call.clinicId, actor: TOOL_ACTOR }, async (tx) => {
    tx.audit.record({ action: resourceType === "voice_tool_slots" ? "read" : "create", resourceType, resourceId: tx.clinicId, metadata: { callRef: call.callRef, ...metadata } });
  });
}

/**
 * One engine call, or null when it threw (the database, a refused tenant, a
 * fault): the caller then hears TOOL_FAILURE_LINE and is offered a person,
 * as when Google does not answer, rather than the agent improvising over a
 * bare 500, and the tool's audit row says `error`. The row is written in a
 * transaction of its own, so a database that is down costs the row (logged),
 * never the caller's line.
 */
async function engineOr<T>(call: ToolCall, resourceType: ToolResource, run: () => Promise<T>): Promise<T | null> {
  try {
    return await run();
  } catch (error) {
    log.error("voice tool engine call failed", { clinicId: call.clinicId, op: resourceType, error: describeError(error) });
    try {
      await auditTool(call, resourceType, { outcome: "error" });
    } catch (auditError) {
      log.error("voice tool audit row not written", { clinicId: call.clinicId, op: resourceType, error: describeError(auditError) });
    }
    return null;
  }
}

/**
 * Free times for the demo clinic (offerTimes), as voiceOffer chooses them:
 * three at most, each with its spoken form on the clinic's clock and the
 * named provider whose calendar it is on (null for the location's own),
 * which `hold` and `book` take back. `day` is a date the caller named
 * (YYYY-MM-DD), for that day only; `from` the earliest start they asked
 * about, a date or a time with its offset. Both are read on the clinic's
 * clock, never the server's, and anything else is refused, never guessed.
 */
async function voiceToolSlots(call: ToolCall, gate: AnswerDecision): Promise<ToolReply> {
  const step = await parkedOr(call, "voice_tool_slots", gate);
  if ("reply" in step) return step.reply;
  const asked = windowOf(call.body, step.harness.timeZone);
  if ("invalid" in asked) {
    await auditTool(call, "voice_tool_slots", { outcome: "invalid", field: asked.invalid });
    return { status: 400, body: { error: `${asked.invalid}_invalid`, say: MISSING_DETAIL_LINES.preferred_window } };
  }
  const offer = await engineOr(call, "voice_tool_slots", () =>
    offerTimes(call.clinicId, {
      channel: "voice",
      holderKey: holderKeyOf(call),
      from: asked.from,
      day: asked.day,
      service: text(call.body.service, 120) ?? null,
      providerId: uuidOrNull(call.body.provider_id),
      now: call.now,
      actor: TOOL_ACTOR,
    }),
  );
  if (!offer) return TOOL_FAILURE_REPLY;
  if (offer.status === "unavailable") {
    await auditTool(call, "voice_tool_slots", { outcome: "unavailable" });
    return TOOL_FAILURE_REPLY;
  }
  if (offer.status === "request_only") {
    await auditTool(call, "voice_tool_slots", { outcome: "request_only", reason: offer.reasons[0] ?? "manual_booking" });
    return requestOnlyReply(offer.reasons);
  }
  const slots = voiceOffer(offer.slots, offer.timeZone).map((slot) => ({ at: slot.at.toISOString(), spoken: spokenSlot(slot.at, offer.timeZone), provider_id: slot.providerId }));
  if (slots.length === 0) {
    // Nothing free on the day, or after the time, the caller named: ask for
    // another. Nothing free across the whole offer: take a request, rather
    // than ask the caller to name days one by one.
    const narrowed = Boolean(asked.day ?? asked.from);
    await auditTool(call, "voice_tool_slots", { outcome: "none_free", narrowed });
    if (!narrowed) return MANUAL_BOOKING_REPLY;
    return { status: 200, body: { slots, service: offer.canonicalService, service_minutes: offer.serviceMinutes, say: NO_FREE_TIME_LINE } };
  }
  await auditTool(call, "voice_tool_slots", { outcome: "offered", count: slots.length });
  return { status: 200, body: { slots, service: offer.canonicalService, service_minutes: offer.serviceMinutes } };
}

/**
 * The times a call hears (plan §6.4): at most three, spread across days,
 * earliest first. Each of the first three days with a free time gives its
 * earliest, so the caller hears a choice of days rather than three
 * back-to-back quarter-hours. Fewer days than that (a day the caller named,
 * or a sparse calendar) share the three out, each spread across its day,
 * first and last free times included. Days are the clinic's own; the same
 * start on two providers' calendars is said once.
 */
export function voiceOffer<T extends OfferedTime>(slots: readonly T[], timeZone: string, limit = VOICE_TOOL_SLOT_LIMIT): T[] {
  const dayOf = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
  const days = new Map<string, T[]>();
  for (const slot of [...slots].sort((a, b) => a.at.getTime() - b.at.getTime())) {
    const key = dayOf.format(slot.at);
    const day = days.get(key);
    if (!day) days.set(key, [slot]);
    else if (day[day.length - 1]!.at.getTime() !== slot.at.getTime()) day.push(slot);
  }
  const chosen = [...days.values()].slice(0, limit);
  const out: T[] = [];
  chosen.forEach((day, i) => {
    const share = Math.floor(limit / chosen.length) + (i < limit % chosen.length ? 1 : 0);
    out.push(...evenly(day, share));
  });
  return out.sort((a, b) => a.at.getTime() - b.at.getTime());
}

/** Up to `n` items spaced evenly across the list, first and last included. */
function evenly<T>(items: readonly T[], n: number): T[] {
  if (items.length <= n) return [...items];
  if (n === 1) return [items[0]!];
  const out: T[] = [];
  for (let i = 0; i < n; i += 1) out.push(items[Math.round((i * (items.length - 1)) / (n - 1))]!);
  return out;
}

/** One time held for 60 seconds for the demo clinic (placeHold), before the caller's details are taken. */
async function voiceToolHold(call: ToolCall, gate: AnswerDecision): Promise<ToolReply> {
  const step = await parkedOr(call, "voice_tool_hold", gate);
  if ("reply" in step) return step.reply;
  const at = instantOf(call.body.at);
  if (!at || at.getTime() <= call.now.getTime()) {
    await auditTool(call, "voice_tool_hold", { outcome: "invalid", field: "at" });
    return missingDetailReply("at");
  }
  const providerId = uuidOrNull(call.body.provider_id);
  const placed = await engineOr(call, "voice_tool_hold", () =>
    placeHold(call.clinicId, {
      channel: "voice",
      holderKey: holderKeyOf(call),
      startsAt: at,
      service: text(call.body.service, 120) ?? null,
      providerId,
      now: call.now,
      actor: TOOL_ACTOR,
    }),
  );
  if (!placed) return TOOL_FAILURE_REPLY;
  await auditTool(call, "voice_tool_hold", {
    outcome: placed.kind,
    ...(placed.kind === "held" ? { holdId: placed.holdId } : {}),
    ...(placed.kind === "request_only" ? { reason: placed.reasons[0] ?? "manual_booking" } : {}),
  });
  switch (placed.kind) {
    case "held":
      return {
        status: 200,
        body: { held: true, at: placed.startsAt.toISOString(), when_spoken: spokenSlot(placed.startsAt, step.harness.timeZone), hold_seconds: HOLD_SECONDS, provider_id: placed.providerId, say: HOLD_LINE },
      };
    case "slot_taken":
      return slotTakenReply(placed.alternatives, step.harness.timeZone, providerId);
    case "request_only":
      return requestOnlyReply(placed.reasons);
    case "in_progress":
      return IN_PROGRESS_REPLY;
    case "unavailable":
      return TOOL_FAILURE_REPLY;
  }
}

/**
 * The booking (bookConversation) for the demo clinic, keyed on the call:
 * one booking or one request a call, and a retry answers as the first did.
 * B's gate is the engine's `gate`, asked after the replay. Every answer is
 * a fixed line: booked only once Google has the event (BOOKED_LINE, with a
 * deposit left for the front desk said by depositLine, never a link), and a
 * request for every way the assistant may not book, the budget running out
 * with the write in flight among them. Every other clinic is parked.
 */
async function voiceToolBook(call: ToolCall): Promise<ToolReply> {
  const harness = await withTenant({ clinicId: call.clinicId, actor: TOOL_ACTOR }, harnessOf);
  if (!harness) return UNKNOWN_CLINIC_REPLY;
  if (!harness.demo) return parkedBook(call);
  const providerId = uuidOrNull(call.body.provider_id);
  let refusedFor: string | null = null;
  const result = await engineOr(call, "voice_tool_book", () =>
    bookConversation(call.clinicId, {
      channel: "voice",
      holderKey: holderKeyOf(call),
      bookingKey: call.callId,
      // Missing or unreadable, the engine answers `invalid` for the field.
      startsAt: instantOf(call.body.at) ?? new Date(Number.NaN),
      firstName: text(call.body.first_name, 40) ?? "",
      phoneE164: call.phone,
      service: text(call.body.service, 120) ?? null,
      fields: fieldsOf(call.body.fields),
      providerId,
      budgetMs: BOOK_CALENDAR_BUDGET_MS,
      now: call.now,
      actor: TOOL_ACTOR,
      gate: async () => {
        const decision = await voiceAnswerDecision(call.clinicId, call.now);
        if (decision.decision === "answer") return true;
        refusedFor = decision.reason;
        return false;
      },
    }),
  );
  if (!result) return TOOL_FAILURE_REPLY;
  await auditTool(call, "voice_tool_book", bookAuditOf(result, refusedFor));
  return bookReplyOf(result, harness.timeZone, providerId);
}

function bookAuditOf(result: BookConversationResult, refusedFor: string | null): Record<string, string | number | boolean> {
  switch (result.kind) {
    case "refused":
      return { outcome: "refused", reason: "service_unavailable", ...(refusedFor ? { decision: refusedFor } : {}) };
    case "booked":
      return { outcome: "booked", replayed: result.replayed };
    case "request_logged":
      return { outcome: "request_logged", reason: result.reason, replayed: result.replayed };
    case "key_reused":
      return { outcome: "key_reused", reason: result.first };
    case "invalid":
      return { outcome: "invalid", field: result.field };
    default:
      return { outcome: result.kind };
  }
}

function bookReplyOf(result: BookConversationResult, timeZone: string, providerId: string | null): ToolReply {
  switch (result.kind) {
    case "booked": {
      const when = spokenSlot(result.startsAt, timeZone);
      const deposit = result.deposit ? depositLine({ ...result.deposit, scope: "booking" }) : "";
      return {
        status: 200,
        body: { booked: true, at: result.startsAt.toISOString(), when_spoken: when, service: result.canonicalService, say: [bookedLine(when, result.canonicalService), deposit].filter(Boolean).join(" ") },
      };
    }
    case "request_logged":
      return { status: 200, body: { booked: false, request_taken: true, say: requestLineOf(result) } };
    case "slot_taken":
      return slotTakenReply(result.alternatives, timeZone, providerId);
    case "in_progress":
      return IN_PROGRESS_REPLY;
    case "key_reused":
      return keyReusedReply(result, timeZone);
    case "unavailable":
      return TOOL_FAILURE_REPLY;
    case "refused":
      return SERVICE_UNAVAILABLE_REPLY;
    case "invalid":
      return missingDetailReply(result.field);
  }
}

/** A request's line: a deposit reservation, a deposit this call cannot take (with its amount), or the request itself. */
function requestLineOf(result: Extract<BookConversationResult, { kind: "request_logged" }>): string {
  if (result.reason === "deposit_hold") return DEPOSIT_HOLD_LINE;
  if (result.reason === "deposit_required" && result.deposit) return depositLine({ ...result.deposit, scope: "booking" }) || DEPOSIT_REQUEST_LINE;
  return REQUEST_TAKEN_LINE;
}

/**
 * A request in the caller's words (logRequest), under the same key as a
 * booking, for the demo clinic only. Every other clinic is refused,
 * synthetic ones included: a request logged here raises only a booking
 * alert (lib/notices/booking-alerts.ts), which reaches nobody until M5, and
 * the post-call record would then link it and mail nobody, so a forwarding
 * test call's request, at a clinic still in setup, would reach no one. The
 * agent hears the failure line and takes the details itself, and the
 * post-call webhook writes the request and mails the desk (notifyDesk).
 */
async function voiceToolRequest(call: ToolCall): Promise<ToolReply> {
  const harness = await withTenant({ clinicId: call.clinicId, actor: TOOL_ACTOR }, async (tx) => {
    const found = await harnessOf(tx);
    if (found && !found.demo) {
      tx.audit.record({ action: "create", resourceType: "voice_tool_request", resourceId: tx.clinicId, metadata: { callRef: call.callRef, outcome: "refused", reason: "not_available" } });
    }
    return found;
  });
  if (!harness) return UNKNOWN_CLINIC_REPLY;
  if (!harness.demo) return REQUEST_NOT_AVAILABLE_REPLY;
  const result = await engineOr(call, "voice_tool_request", () =>
    logRequest(call.clinicId, {
      channel: "voice",
      holderKey: holderKeyOf(call),
      bookingKey: call.callId,
      firstName: text(call.body.first_name, 40) ?? "",
      phoneE164: call.phone,
      preferredWindow: text(call.body.preferred_window, 120) ?? "",
      alternativeWindows: alternativesOf(call.body.alternative_windows),
      service: text(call.body.service, 120) ?? null,
      fields: fieldsOf(call.body.fields),
      now: call.now,
      actor: TOOL_ACTOR,
    }),
  );
  if (!result) return TOOL_FAILURE_REPLY;
  await auditTool(call, "voice_tool_request", {
    outcome: result.kind,
    ...(result.kind === "request_logged" ? { replayed: result.replayed } : {}),
    ...(result.kind === "key_reused" ? { reason: result.first } : {}),
    ...(result.kind === "invalid" ? { field: result.field } : {}),
  });
  switch (result.kind) {
    case "request_logged":
      return { status: 200, body: { request_taken: true, say: REQUEST_TAKEN_LINE } };
    case "key_reused":
      return keyReusedReply(result, harness.timeZone);
    case "invalid":
      return missingDetailReply(result.field);
  }
}

/** The demo clinic takes requests now: the manual line, or the deposit's when a call cannot take one. */
function requestOnlyReply(reasons: readonly string[]): ToolReply {
  if (reasons.includes("deposit_required")) return { status: 409, body: { error: "deposit_required", say: DEPOSIT_REQUEST_LINE } };
  return MANUAL_BOOKING_REPLY;
}

/**
 * The nearest free times to one just taken, each on the calendar of the
 * provider the caller asked for (the engine reads them there), so a hold or
 * booking that takes one back lands on the same calendar.
 */
function slotTakenReply(alternatives: readonly Date[], timeZone: string, providerId: string | null): ToolReply {
  const offered = alternatives.slice(0, VOICE_TOOL_SLOT_LIMIT).map((at) => ({ at: at.toISOString(), spoken: spokenSlot(at, timeZone), provider_id: providerId }));
  return { status: 409, body: { error: "slot_taken", alternatives: offered, say: slotGoneLine(offered.map((a) => a.spoken)) } };
}

function keyReusedReply(result: { first: "booked" | "request_logged"; firstStartsAt?: Date }, timeZone: string): ToolReply {
  const say = result.first === "booked" ? oneBookingPerCallLine(result.firstStartsAt ? spokenSlot(result.firstStartsAt, timeZone) : null) : ONE_REQUEST_PER_CALL_LINE;
  return { status: 409, body: { error: "key_reused", say } };
}

function missingDetailReply(field: keyof typeof MISSING_DETAIL_LINES): ToolReply {
  return { status: 400, body: { error: `${field}_required`, say: MISSING_DETAIL_LINES[field] } };
}

/**
 * Parked for every clinic but the demo clinic: the assistant takes a
 * request, which the post-call webhook delivers. The gate is asked here,
 * outside any transaction, as the engine asks it after its replay.
 */
async function parkedBook(call: ToolCall): Promise<ToolReply> {
  const gate = await voiceAnswerDecision(call.clinicId, call.now);
  return withTenant({ clinicId: call.clinicId, actor: TOOL_ACTOR }, async (tx): Promise<ToolReply> => {
    const refused = gate.decision !== "answer";
    tx.audit.record({
      action: "create",
      resourceType: "voice_tool_book",
      resourceId: tx.clinicId,
      metadata: { callRef: call.callRef, outcome: "refused", reason: refused ? "service_unavailable" : "manual_booking", ...(gate.decision !== "answer" ? { decision: gate.reason } : {}) },
    });
    return refused ? SERVICE_UNAVAILABLE_REPLY : MANUAL_BOOKING_REPLY;
  });
}

/** An ISO 8601 time with its offset, as `slots` gives `at`. One without would be read on the server's clock, not the clinic's. */
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/i;
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

function instantOf(v: unknown): Date | null {
  const raw = text(v, 40);
  if (!raw || !INSTANT.test(raw)) return null;
  const d = new Date(raw);
  return Number.isFinite(d.getTime()) ? d : null;
}

/** "YYYY-MM-DD" as the start of that day on the clinic's clock; null for anything else, 30 February included. */
function clinicDayStart(raw: string, timeZone: string): Date | null {
  const m = DATE_ONLY.exec(raw);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const probe = new Date(Date.UTC(y, mo - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d) return null;
  return zonedToUtc(y, mo, d, 0, 0, timeZone);
}

/**
 * `day` and `from` as the engine takes them. Absent is no bound. `day` is a
 * date only; `from` a date (its start) or a time with its offset. A date is
 * read on the clinic's clock: new Date("2026-10-15") would be UTC midnight,
 * the evening before for a clinic in the Americas.
 */
function windowOf(body: Record<string, unknown>, timeZone: string): { day: Date | null; from: Date | null } | { invalid: "day" | "from" } {
  const rawDay = text(body.day, 40);
  const day = rawDay ? clinicDayStart(rawDay, timeZone) : null;
  if (rawDay && !day) return { invalid: "day" };
  const rawFrom = text(body.from, 40);
  const from = rawFrom ? (clinicDayStart(rawFrom, timeZone) ?? instantOf(rawFrom)) : null;
  if (rawFrom && !from) return { invalid: "from" };
  return { day, from };
}

function uuidOrNull(v: unknown): string | null {
  return typeof v === "string" && UUID.test(v) ? v.toLowerCase() : null;
}

/** Up to two other times, in the caller's words; the request cleans them as the post-call webhook's. */
function alternativesOf(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((w) => text(w, 120)).filter((w): w is string => Boolean(w)).slice(0, 2);
}

/** The clinic's other required fields, as strings; the request keeps only the clinic's own set, screened (§H.6). */
function fieldsOf(v: unknown): Record<string, string> | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(v as Record<string, unknown>).slice(0, 20)) {
    const cleaned = text(value, 200);
    if (cleaned) out[key.slice(0, 64)] = cleaned;
  }
  return out;
}
