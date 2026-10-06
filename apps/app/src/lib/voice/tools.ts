import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import { findClinicalContent, resolveBookingRequirements } from "@healdesk/catalog";
import { toE164 } from "@healdesk/connectors";
import { and, eq } from "drizzle-orm";

import { agentConfigs, appointments, bookingRequests, clinics } from "@/db/schema";
import type { ActorContext } from "@/lib/audit";
import { voiceAnswerDecision, type AnswerDecision } from "@/lib/billing/answering";
import { slotLabel, slotsFor, writeToCalendar, type CalendarWriteOutcome } from "@/lib/booking/calendar";
import { directBookingAllowed } from "@/lib/booking/mode";
import { env } from "@/lib/env";
import { describeError, log } from "@/lib/log";
import { BOOKING_REQUEST_TTL_DAYS, cleanCollectedFields, notifyDesk } from "@/lib/meta/booking-requests";
import type { EmailTransport } from "@/lib/reporting/deliver";
import { withTenant, type TenantTx } from "@/lib/tenant";

import { upsertCallerContact } from "./ingest";
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
 * Three tools behind one handler:
 *
 *   context   what this clinic's assistant asks for, and whether it may
 *             book: the requirement set as one spoken sentence, the
 *             effective booking mode, the deposit line and the practice's
 *             number for the ear.
 *   slots     free times from the writable calendar, six at most, each with
 *             a spoken form — refused outright unless every direct-booking
 *             gate holds, so the agent falls back to taking a request.
 *   book      the direct booking: idempotent on the vendor's call id, the
 *             time must be one a fresh slot read returned, the appointment
 *             and an already-`confirmed` request are inserted together,
 *             the calendar is written after the commit with an eight-second
 *             budget, and the desk gets the FYI.
 *
 * The call-back tool of 23 September 2026 (§F.9) was removed: v1 places no
 * calls. TODO(v1, launch plan steps 1.5 and 1.7): the Google Calendar write
 * and the 60-second hold before anything confirming is said; see
 * lib/booking/mode.ts for the gate this path still depends on.
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
export const VOICE_TOOL_SLOT_LIMIT = 6;
/** How long the calendar write may take before the agent is told "unknown" (§E.2). The write itself carries on and records its own result. */
export const BOOK_CALENDAR_BUDGET_MS = 8_000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOOL_ACTOR: ActorContext = { type: "agent", serviceName: "voice-tools" };
const DIRECT_BOOKING_LABEL = "assistant (direct booking)";

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

function isoDate(v: unknown): Date | null {
  if (typeof v !== "string" || !v.trim()) return null;
  const d = new Date(v);
  return Number.isFinite(d.getTime()) ? d : null;
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
  /** The EFFECTIVE mode: "direct" only while every §E.1 gate holds right now, so the agent never starts a flow the tool would refuse. */
  booking_mode: "desk_confirms" | "direct";
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
 */
async function voiceToolContext(call: ToolCall, gate: AnswerDecision): Promise<ToolReply> {
  const refused = gate.decision === "pass_through";
  const transferTo = gate.decision === "pass_through" ? gate.directLine : null;
  const reply = await withTenant({ clinicId: call.clinicId, actor: TOOL_ACTOR }, async (tx): Promise<VoiceContextReply | null> => {
    const [clinic] = await tx.db
      .select({ specialty: clinics.specialty, requirements: clinics.bookingRequirements, bookingMode: clinics.bookingMode, phone: clinics.publishedPhoneE164 })
      .from(clinics)
      .where(eq(clinics.id, tx.clinicId))
      .limit(1);
    if (!clinic) return null;
    const [agent] = await tx.db.select({ depositPolicy: agentConfigs.depositPolicy }).from(agentConfigs).where(eq(agentConfigs.clinicId, tx.clinicId)).limit(1);
    const direct = !refused && clinic.bookingMode === "direct" && (await directBookingAllowed(tx)).ok;
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
      deposit_line: depositLine(agent?.depositPolicy ?? null),
      clinic_phone_spoken: clinic.phone ? spokenPhone(clinic.phone) : "",
      answer_mode: answerMode,
      transfer_number: transferTo,
    };
  });
  if (!reply) return { status: 404, body: { error: "Unknown endpoint." } };
  return { status: 200, body: reply };
}

/** The deposit rule as the agent states it: the fact and who collects it, never a payment link (there is none, §E.7). */
export function depositLine(policy: { required: boolean; amountUsd: number | null } | null): string {
  if (!policy?.required) return "";
  const amount = policy.amountUsd !== null && Number.isFinite(policy.amountUsd) ? `A deposit of ${policy.amountUsd} dollars` : "A deposit";
  return `${amount} is required to hold the appointment. The front desk will call you to take it; nothing is charged on this call.`;
}

// -----------------------------------------------------------------------------
// slots
// -----------------------------------------------------------------------------

export type VoiceSlot = { at: string; label: string; spoken: string };

async function voiceToolSlots(call: ToolCall, gate: AnswerDecision): Promise<ToolReply> {
  const from = isoDate(call.body.from);
  const daysRaw = call.body.days;
  const days = typeof daysRaw === "number" && Number.isInteger(daysRaw) && daysRaw >= 1 && daysRaw <= 14 ? daysRaw : 14;
  return withTenant({ clinicId: call.clinicId, actor: TOOL_ACTOR }, async (tx): Promise<ToolReply> => {
    // Refused by the answer gate: no times offered. The vendor hears only
    // that the service is unavailable, never why (a clinic's billing state
    // is not the voice vendor's business); the audit row keeps the reason.
    if (gate.decision === "pass_through") {
      tx.audit.record({ action: "read", resourceType: "voice_tool_slots", resourceId: tx.clinicId, metadata: { callRef: call.callRef, outcome: "refused", reason: gate.reason } });
      return { status: 403, body: { error: "service_unavailable" } };
    }
    const allowed = await directBookingAllowed(tx);
    if (!allowed.ok) {
      tx.audit.record({ action: "read", resourceType: "voice_tool_slots", resourceId: tx.clinicId, metadata: { callRef: call.callRef, outcome: "refused", reason: allowed.reason } });
      return { status: 403, body: { error: "direct_booking_off", missing: allowed.missing } };
    }
    const start = from && from.getTime() > call.now.getTime() ? from : call.now;
    const slots = await listSpokenSlots(tx, { from: start, days });
    tx.audit.record({ action: "read", resourceType: "voice_tool_slots", resourceId: tx.clinicId, metadata: { callRef: call.callRef, count: slots.length, days } });
    return { status: 200, body: { slots } };
  });
}

/** The first six free times, chronologically, each with its spoken form in the clinic's clock. */
async function listSpokenSlots(tx: TenantTx, opts: { from: Date; days: number }): Promise<VoiceSlot[]> {
  const [clinic] = await tx.db.select({ timezone: clinics.timezone }).from(clinics).where(eq(clinics.id, tx.clinicId)).limit(1);
  const timeZone = clinic?.timezone ?? "America/New_York";
  const listed = await slotsFor(tx, opts.days, { now: opts.from });
  return listed
    .map((s) => ({ ...s, ms: Date.parse(s.at) }))
    .sort((a, b) => a.ms - b.ms)
    .slice(0, VOICE_TOOL_SLOT_LIMIT)
    .map((s) => ({ at: s.at, label: s.label, spoken: spokenSlot(new Date(s.ms), timeZone) }));
}

// -----------------------------------------------------------------------------
// book
// -----------------------------------------------------------------------------

export type VoiceBookReply = { booked: true; when_spoken: string; calendar: CalendarWriteOutcome };

type Booked = { kind: "booked"; requestId: string; token: string; appointmentId: string; whenSpoken: string };
type BookStep = Booked | { kind: "replay"; reply: VoiceBookReply } | { kind: "refused"; reply: ToolReply };

async function voiceToolBook(call: ToolCall): Promise<ToolReply> {
  const firstNameRaw = text(call.body.first_name, 40);
  const firstName = firstNameRaw && /^[\p{L}][\p{L}' -]*$/u.test(firstNameRaw) ? firstNameRaw : null;
  const at = isoDate(call.body.at);
  // A service name is screened the way `treatment` is on an inbound call:
  // no clinical content and no digit run; the window matcher's treatment
  // words would refuse "consultation", which is exactly what this field is.
  const serviceRaw = text(call.body.service, 120);
  const service = serviceRaw && findClinicalContent({ service: serviceRaw }).length === 0 && !/\d{7,}/.test(serviceRaw) ? serviceRaw : null;
  const fieldsRaw = call.body.fields;
  const fields = fieldsRaw && typeof fieldsRaw === "object" && !Array.isArray(fieldsRaw) ? (fieldsRaw as Record<string, unknown>) : {};

  let step: BookStep;
  try {
    step = await withTenant({ clinicId: call.clinicId, actor: TOOL_ACTOR }, (tx) => bookInTenant(tx, call, { firstName, at, service, fields }));
  } catch (error) {
    // Two retries of one call racing: the partial unique index on
    // (clinic_id, vendor_call_id) let exactly one through. Answer with it.
    if (!isUniqueViolation(error)) throw error;
    const replay = await withTenant({ clinicId: call.clinicId, actor: TOOL_ACTOR }, (tx) => replayBooking(tx, call));
    if (!replay) throw error;
    return { status: 200, body: replay };
  }
  if (step.kind === "refused") return step.reply;
  if (step.kind === "replay") return { status: 200, body: step.reply };

  // §B.4 after the commit, inside the agent's patience (§E.2): the write
  // carries on past the budget and records its own outcome; the agent is
  // told "unknown" and says the desk will make sure.
  const calendar = await withBudget(writeToCalendar(call.clinicId, step.appointmentId, { actor: TOOL_ACTOR, now: call.now }), BOOK_CALENDAR_BUDGET_MS, "unknown" as const);

  await withTenant({ clinicId: call.clinicId, actor: TOOL_ACTOR }, (tx) =>
    notifyDesk(tx, { id: step.requestId, token: step.token }, { channel: "voice", platform: null }, { transport: call.transport, variant: "fyi_direct" }),
  );
  return { status: 200, body: { booked: true, when_spoken: step.whenSpoken, calendar } satisfies VoiceBookReply };
}

async function bookInTenant(
  tx: TenantTx,
  call: ToolCall,
  input: { firstName: string | null; at: Date | null; service: string | null; fields: Record<string, unknown> },
): Promise<BookStep> {
  const refuse = (status: number, error: string, extra: Record<string, unknown> = {}): BookStep => {
    tx.audit.record({ action: "create", resourceType: "voice_tool_book", resourceId: tx.clinicId, metadata: { callRef: call.callRef, outcome: "refused", reason: error } });
    return { kind: "refused", reply: { status, body: { error, ...extra } } };
  };

  // Idempotent on the vendor's call id before anything else is read: a
  // retry of a booked call answers with the booking, whatever the gates say now.
  const replay = await replayBooking(tx, call);
  if (replay) return { kind: "replay", reply: replay };

  const allowed = await directBookingAllowed(tx);
  if (!allowed.ok) return refuse(403, "direct_booking_off", { missing: allowed.missing });
  if (!input.firstName) return refuse(400, "first_name_required");
  if (!input.at || input.at.getTime() <= call.now.getTime()) return refuse(400, "at_required");

  // The time must be one a fresh read of the calendar returned: the agent
  // cannot invent a slot, and a slot taken since the list was read is gone.
  const fresh = await slotsFor(tx, 14, { now: call.now });
  const slot = fresh.find((s) => Date.parse(s.at) === input.at!.getTime());
  if (!slot) return refuse(409, "slot_unavailable");

  const [clinic] = await tx.db
    .select({ timezone: clinics.timezone, specialty: clinics.specialty, requirements: clinics.bookingRequirements })
    .from(clinics)
    .where(eq(clinics.id, tx.clinicId))
    .limit(1);
  if (!clinic) return refuse(404, "unknown_clinic");
  const requirements = resolveBookingRequirements(clinic.specialty, clinic.requirements ?? null);
  const { accepted, refused } = cleanCollectedFields(requirements, input.fields);
  for (const r of refused) {
    tx.audit.record({ action: "create", resourceType: "booking_request", metadata: { outcome: "field_refused", field: r.field, reason: r.reason } });
  }

  const contactId = await upsertCallerContact(tx.db, { clinicId: tx.clinicId, phone: call.phone, name: input.firstName, clinicTimezone: clinic.timezone });

  // The deposit rule exactly as lib/meta/booking-requests.ts insertAppointment
  // applies it (private there): with no payment link, a required deposit is
  // owed to the front desk.
  const [agent] = await tx.db.select({ depositPolicy: agentConfigs.depositPolicy }).from(agentConfigs).where(eq(agentConfigs.clinicId, tx.clinicId)).limit(1);
  const depositPolicy = agent?.depositPolicy ?? null;
  const [appointment] = await tx.db
    .insert(appointments)
    .values({
      clinicId: tx.clinicId,
      contactId,
      conversationId: null,
      scheduledFor: input.at,
      treatment: input.service ?? accepted.service ?? null,
      depositUsd: depositPolicy?.required && depositPolicy.amountUsd !== null ? String(depositPolicy.amountUsd) : null,
      depositStatus: depositPolicy?.required ? "pending_front_desk" : "none",
      externalConfirmedAt: null,
    })
    .returning({ id: appointments.id });
  if (!appointment) throw new Error("Direct booking: no appointment row returned.");

  // The request, INSERTed already confirmed (the 0040 trigger is BEFORE
  // UPDATE only, on purpose). The token exists once, here, for the FYI.
  const raw = randomBytes(32);
  const token = raw.toString("base64url");
  raw.fill(0);
  const label = slotLabel(input.at, clinic.timezone);
  const [request] = await tx.db
    .insert(bookingRequests)
    .values({
      clinicId: tx.clinicId,
      contactId,
      channel: "voice",
      conversationId: null,
      preferredWindow: label,
      alternativeWindows: [],
      treatment: input.service,
      collectedFields: accepted,
      status: "confirmed",
      tokenHash: createHash("sha256").update(token, "utf8").digest(),
      expiresAt: new Date(call.now.getTime() + BOOKING_REQUEST_TTL_DAYS * 24 * 60 * 60 * 1000),
      decidedAt: call.now,
      decidedByLabel: DIRECT_BOOKING_LABEL,
      confirmedFor: input.at,
      appointmentId: appointment.id,
      bookedVia: "agent_direct",
      vendorCallId: call.callId,
    })
    .returning({ id: bookingRequests.id });
  if (!request) throw new Error("Direct booking: no request row returned.");

  tx.audit.record({
    action: "create",
    resourceType: "appointment",
    resourceId: appointment.id,
    metadata: { bookingRequestId: request.id, confirmedByDesk: false, bookedByAssistant: true, confirmedByClinicSystem: false, deposit: depositPolicy?.required ? "pending_front_desk" : "none" },
  });
  tx.audit.record({ action: "create", resourceType: "booking_request", resourceId: request.id, resourceIds: [contactId], metadata: { channel: "voice", via: "agent_direct", expiresInDays: BOOKING_REQUEST_TTL_DAYS } });
  tx.audit.record({ action: "create", resourceType: "voice_tool_book", resourceId: request.id, metadata: { callRef: call.callRef, outcome: "booked", fields: Object.keys(accepted) } });
  return { kind: "booked", requestId: request.id, token, appointmentId: appointment.id, whenSpoken: spokenSlot(input.at, clinic.timezone) };
}

/** The booking this call already made, as the agent was first told it, or null. */
async function replayBooking(tx: TenantTx, call: ToolCall): Promise<VoiceBookReply | null> {
  const [existing] = await tx.db
    .select({ id: bookingRequests.id, confirmedFor: bookingRequests.confirmedFor, calendar: appointments.calendarWriteStatus, timezone: clinics.timezone })
    .from(bookingRequests)
    .innerJoin(clinics, eq(clinics.id, bookingRequests.clinicId))
    .leftJoin(appointments, eq(appointments.id, bookingRequests.appointmentId))
    .where(and(eq(bookingRequests.clinicId, tx.clinicId), eq(bookingRequests.vendorCallId, call.callId)))
    .limit(1);
  if (!existing || !existing.confirmedFor) return null;
  tx.audit.record({ action: "create", resourceType: "voice_tool_book", resourceId: existing.id, metadata: { callRef: call.callRef, outcome: "replayed" } });
  const calendar: CalendarWriteOutcome = existing.calendar === "written" ? "written" : existing.calendar === "failed" ? "failed" : existing.calendar === "none" ? "not-connected" : "unknown";
  return { booked: true, when_spoken: spokenSlot(existing.confirmedFor, existing.timezone), calendar };
}

function isUniqueViolation(error: unknown): boolean {
  const code = (error as { code?: string })?.code ?? (error as { cause?: { code?: string } })?.cause?.code;
  return code === "23505";
}

async function withBudget<T, F>(work: Promise<T>, ms: number, fallback: F): Promise<T | F> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<F>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  try {
    return await Promise.race([work, late]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
