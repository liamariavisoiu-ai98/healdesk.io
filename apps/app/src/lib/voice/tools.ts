import { createHash, timingSafeEqual } from "node:crypto";

import { resolveBookingRequirements } from "@healdesk/catalog";
import { toE164 } from "@healdesk/connectors";
import { eq } from "drizzle-orm";

import { agentConfigs, clinics, type DepositPolicy } from "@/db/schema";
import type { ActorContext } from "@/lib/audit";
import { voiceAnswerDecision, type AnswerDecision } from "@/lib/billing/answering";
import {
  clinicDefaultDepositUsd,
  depositDecision,
  normaliseDepositUsd,
  readClinicDepositFacts,
  type DepositAction,
} from "@/lib/billing/deposits";
import { HOLD_SECONDS } from "@/lib/booking/holds";
import { MANUAL_BOOKING_LINE } from "@/lib/booking/lines";
import { bookingModeFor } from "@/lib/booking/mode";
import { env } from "@/lib/env";
import { describeError, log } from "@/lib/log";
import type { EmailTransport } from "@/lib/reporting/deliver";
import { withTenant, type TenantTx } from "@/lib/tenant";

import { spokenFieldList, spokenPhone } from "./spoken";

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
 * Three tools behind one handler:
 *
 *   context   what this clinic's assistant asks for, and whether it may
 *             book: the requirement set as one spoken sentence, the
 *             booking mode, the deposit line and the practice's number for
 *             the ear.
 *   slots     parked: 403 `manual_booking` for every clinic.
 *   book      parked: 403 `manual_booking` for every clinic.
 *
 * A pre-Retell test harness (plan §7.13). No time read from a clinic's
 * Google Calendar reaches Synthflow for any real clinic: the context says
 * `desk_confirms` and cannot offer times (`harness_demo_only`) for every
 * clinic but healdesk's demo clinic, whose context reads the booking mode
 * (lib/booking/mode.ts bookingModeFor). Booking itself goes through the
 * engine (lib/booking/engine.ts), which the harness reaches for the demo
 * clinic only once it is wired (C14); until then `slots` and `book` refuse
 * for everyone, and the agent takes a request, which the post-call webhook
 * delivers to the desk. The 23 September flows these tools ran (a slot list
 * from a vendor with a PHI basis, and a booking with no hold) are gone.
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

export type VoiceTool = "context" | "slots" | "book";

export const VOICE_TOOL_MAX_BODY_BYTES = 32 * 1024;
/** At most this many times in one voice offer (Q7; plan §6.4). */
export const VOICE_TOOL_SLOT_LIMIT = 3;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOOL_ACTOR: ActorContext = { type: "agent", serviceName: "voice-tools" };

/** The `slots` and `book` answer for every clinic while the harness is parked (plan §7.13). */
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
    let reply: ToolReply;
    if (tool === "book") {
      reply = await voiceToolBook(call);
    } else {
      // The answer gate (BD22, BD25), outside any transaction, for the two
      // tools that decide what the assistant does on this call: `context` at
      // its first turn, and `slots` before it offers a time. `book` asks it
      // after its replay (voiceToolBook), so a retry of a booking that
      // already went through still hears that it did, whatever the gate
      // says now.
      const gate = await voiceAnswerDecision(clinicId, call.now);
      reply = await (tool === "context" ? voiceToolContext(call, gate) : voiceToolSlots(call, gate));
    }
    return Response.json(reply.body, { status: reply.status });
  } catch (error) {
    // A BAA-gate refusal (synthetic clinic in production) or a database
    // outage. Nothing about the caller is in the message.
    log.error("voice tool failed", { clinicId, op: tool, error: describeError(error) });
    return Response.json({ error: "The tool could not be completed." }, { status: 500 });
  }
}

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
   * coverage or "Stop and fall back").
   */
  answer_mode: "assistant" | "pass_through";
  /** The direct line, E.164, only for "pass_through"; null otherwise. */
  transfer_number: string | null;
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
    const answerMode = transferTo ? "pass_through" : "assistant";
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
      deposit_line: await voiceDepositLine(tx, agent?.depositPolicy ?? null),
      clinic_phone_spoken: clinic.phone ? spokenPhone(clinic.phone) : "",
      answer_mode: answerMode,
      transfer_number: transferTo,
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
// slots and book: parked (plan §7.13)
// -----------------------------------------------------------------------------

/**
 * Parked for every clinic: no time from a clinic's Google Calendar reaches
 * the voice vendor. The answer gate still comes first, as before: a refused
 * call hears only that the service is unavailable, never why (a clinic's
 * billing state is not the voice vendor's business); the audit row keeps
 * the reason.
 */
async function voiceToolSlots(call: ToolCall, gate: AnswerDecision): Promise<ToolReply> {
  return withTenant({ clinicId: call.clinicId, actor: TOOL_ACTOR }, async (tx): Promise<ToolReply> => {
    if (gate.decision === "pass_through") {
      tx.audit.record({ action: "read", resourceType: "voice_tool_slots", resourceId: tx.clinicId, metadata: { callRef: call.callRef, outcome: "refused", reason: gate.reason } });
      return { status: 403, body: { error: "service_unavailable" } };
    }
    tx.audit.record({ action: "read", resourceType: "voice_tool_slots", resourceId: tx.clinicId, metadata: { callRef: call.callRef, outcome: "refused", reason: "manual_booking" } });
    return MANUAL_BOOKING_REPLY;
  });
}

/**
 * Parked for every clinic: the assistant takes a request, which the
 * post-call webhook delivers. The gate is asked here, outside any
 * transaction, as the engine's route will ask it after its replay (C14).
 */
async function voiceToolBook(call: ToolCall): Promise<ToolReply> {
  const gate = await voiceAnswerDecision(call.clinicId, call.now);
  return withTenant({ clinicId: call.clinicId, actor: TOOL_ACTOR }, async (tx): Promise<ToolReply> => {
    const refused = gate.decision !== "answer";
    tx.audit.record({
      action: "create",
      resourceType: "voice_tool_book",
      resourceId: tx.clinicId,
      metadata: { callRef: call.callRef, outcome: "refused", reason: refused ? "service_unavailable" : "manual_booking", ...(gate.decision !== "answer" ? { decision: gate.reason } : {}) },
    });
    return refused ? { status: 403, body: { error: "service_unavailable" } } : MANUAL_BOOKING_REPLY;
  });
}
