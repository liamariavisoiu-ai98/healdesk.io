import type { VoiceCallEvent } from "./ingest";

/**
 * Synthflow's post-call webhook, mapped to the one row the product runs on.
 *
 * ## What this trusts, and what it does not
 *
 * The payload supplies OBSERVABLE facts: the call id, the caller's number,
 * when it started and ended, the recording and transcript links, and the
 * variables the agent extracted during the call. It does not supply a verdict
 * on whether the call was "missed": the vendor knows the agent answered, not
 * whether a human would have. `ingestCall()` decides that from the clinic's
 * own routing mode and opening hours, and nothing here pre-empts it. The
 * vendor's own missed-call flag, if it ever sends one, is deliberately not
 * read.
 *
 * ## Provisional field names
 *
 * Synthflow's webhook body is not yet confirmed field-by-field (docs/
 * synthflow-voice-agent-context.md, question 7). The reader below accepts the
 * shapes their dashboard and API docs show today — `call_id`/`id`,
 * `phone_number`/`customer_phone`/`from`, `start_time`/`started_at`,
 * `end_time`/`ended_at`, `recording_url`, `transcript_url`, and a
 * `custom_variables`/`extracted_variables`/`variables` object carrying what
 * the agent was told to capture — and is defensive about each. A payload with
 * no call id is refused (nothing to deduplicate on); everything else is
 * optional and missing means "unknown", never a guess. When the vendor
 * confirms the shape, tighten the aliases; the test fixture is the contract.
 *
 * ## What is captured by the agent, by design
 *
 * The agent is configured (docs/synthflow-voice-agent-context.md §2) to
 * produce these variables at the end of a call:
 *   outcome            booked | qualified_no_booking | price_shopper |
 *                      escalated_to_human | spam | abandoned
 *   treatment_interest a service name, never a condition
 *   caller_name        as given
 *   booked_for         ISO datetime, when outcome is booked
 *   booked_treatment   as offered from the approved service list
 *   rang_at_clinic_first / clinic_line_busy / is_callback   carrier facts,
 *                      when the forwarding leg exposes them
 */

export class VoicePayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VoicePayloadError";
  }
}

type Obj = Record<string, unknown>;

function obj(value: unknown): Obj {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Obj) : {};
}

function str(...candidates: unknown[]): string | undefined {
  for (const c of candidates) {
    if (typeof c === "string" && c.trim()) return c.trim();
    if (typeof c === "number" && Number.isFinite(c)) return String(c);
  }
  return undefined;
}

function when(...candidates: unknown[]): Date | undefined {
  for (const c of candidates) {
    if (c === undefined || c === null || c === "") continue;
    const d = typeof c === "number" ? new Date(c < 1e12 ? c * 1000 : c) : new Date(String(c));
    if (!Number.isNaN(d.getTime())) return d;
  }
  return undefined;
}

function bool(...candidates: unknown[]): boolean | undefined {
  for (const c of candidates) {
    if (typeof c === "boolean") return c;
    if (c === "true" || c === "yes" || c === "1") return true;
    if (c === "false" || c === "no" || c === "0") return false;
  }
  return undefined;
}

const OUTCOMES = new Set([
  "booked",
  "qualified_no_booking",
  "price_shopper",
  "escalated_to_human",
  "spam",
  "abandoned",
]);

/** E.164 where we can get there; anything else is not a number we should store. */
function e164(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const digits = value.replace(/[^\d+]/g, "");
  if (!/^\+?\d{7,15}$/.test(digits)) return undefined;
  if (digits.startsWith("+")) return digits;
  // Ten bare digits are a US number: the product sells to US clinics and the
  // vendor's forwarding leg is domestic. Anything else keeps its digits and
  // gains the plus, which is what the contact table's index expects.
  return digits.length === 10 ? `+1${digits}` : `+${digits}`;
}

export function readSynthflowPayload(raw: unknown, clinicId: string): VoiceCallEvent {
  const body = obj(raw);
  const call = obj(body.call ?? body.data ?? body);
  const vars = obj(call.custom_variables ?? call.extracted_variables ?? call.variables ?? body.variables);

  const externalCallId = str(call.call_id, call.id, body.call_id, body.id);
  if (!externalCallId) throw new VoicePayloadError("The payload carries no call id.");

  const startedAt = when(call.start_time, call.started_at, call.start_timestamp, body.start_time, body.timestamp);
  if (!startedAt) throw new VoicePayloadError("The payload carries no start time.");
  const endedAt = when(call.end_time, call.ended_at, call.end_timestamp, body.end_time);

  const outcome = str(vars.outcome, vars.call_outcome, call.outcome)?.toLowerCase();
  const bookedFor = when(vars.booked_for, vars.appointment_time, vars.booking_time);

  const event: VoiceCallEvent = {
    externalCallId,
    clinicId,
    callerPhone: e164(str(call.phone_number, call.customer_phone, call.from, call.caller, body.phone_number)),
    callerName: str(vars.caller_name, vars.name, call.customer_name),
    startedAt,
    endedAt,
    rangAtClinicFirst: bool(vars.rang_at_clinic_first, call.rang_at_clinic_first),
    clinicLineBusy: bool(vars.clinic_line_busy, call.clinic_line_busy),
    isCallback: bool(vars.is_callback, call.is_callback, call.outbound),
    outcome: outcome && OUTCOMES.has(outcome) ? (outcome as VoiceCallEvent["outcome"]) : undefined,
    treatmentInterest: str(vars.treatment_interest, vars.service),
    disclosurePlayedAt: when(vars.disclosure_played_at, call.disclosure_played_at) ?? startedAt,
    recordingOptOut: bool(vars.recording_opt_out) ?? false,
    transcriptUri: str(call.transcript_url, call.transcript_uri),
    recordingUri: str(call.recording_url, call.recording_uri),
    booking:
      outcome === "booked" && bookedFor
        ? {
            scheduledFor: bookedFor,
            treatment: str(vars.booked_treatment, vars.treatment_interest),
            externalId: str(vars.booking_id),
            externalSource: str(vars.booking_source),
          }
        : undefined,
  };
  return event;
}
