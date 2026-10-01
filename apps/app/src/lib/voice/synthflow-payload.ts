import type { VoiceCallEvent } from "./ingest";

/**
 * Synthflow's post-call webhook, mapped to the one row the product runs on.
 *
 * Pre-Retell. The v1 product voice agent runs on Retell (v1 spec, "Voice runs
 * on Retell"), through a Healdesk-hosted custom-LLM WebSocket endpoint that
 * is not built yet (launch plan step 2.1). Until it is, this reader is the
 * only source of `VoiceCallEvent`s, and it stays because the voice webhook,
 * the forwarding test and the operator console's view of calls still run on
 * it. Do not extend it; build the Retell end-of-call path beside it, then
 * delete this file.
 *
 * ## What this trusts, and what it does not
 *
 * The payload supplies OBSERVABLE facts: the call id, the caller's number,
 * when it started and ended, the transcript link, and the
 * variables the agent extracted during the call. It does not supply a verdict
 * on whether the call was "missed": the vendor knows the agent answered, not
 * whether a human would have. `ingestCall()` decides that from the clinic's
 * own routing mode and opening hours, and nothing here pre-empts it. The
 * vendor's own missed-call flag, if it ever sends one, is deliberately not
 * read.
 *
 * ## The documented shape, and the aliases kept behind it
 *
 * Synthflow's post-call webhook (https://docs.synthflow.ai/post-call-webhook,
 * read 23 September 2026) carries `call_id`, `model_id`, `start_time`,
 * `duration`, `status`, `lead { name, phone_number }`, `transcript`,
 * `executed_actions` and **`collected_variables`** — the object the
 * information extractors fill. That shape is read FIRST: `collected_variables`
 * heads the variables alias chain and `lead.phone_number` heads the phone
 * chain. The older aliases (`custom_variables`/`extracted_variables`/
 * `variables`, `phone_number`/`customer_phone`/`from`) stay behind them so a
 * payload from an agent configured under the earlier draft still lands. A
 * payload with no call id is refused (nothing to deduplicate on); everything
 * else is optional and missing means "unknown", never a guess. The test
 * fixture is the contract; verify the field names against the vendor before
 * go-live.
 *
 * ## What is captured by the agent, by design
 *
 * The agent is configured (docs/synthflow-voice-agent-context.md §11) to
 * produce these variables at the end of a call:
 *   outcome            booked | qualified_no_booking | price_shopper |
 *                      escalated_to_human | spam | abandoned
 *   treatment_interest a service name, never a condition
 *   caller_name        as given
 *   booked_for         ISO datetime, when outcome is booked
 *   preferred_window   the first choice in the caller's own words
 *   preferred_alt_1/2  up to two other times, verbatim or empty (§D.1)
 *   booked_treatment   as offered from the approved service list
 *   field_<id>         one per voice-eligible required field (§H.5)
 *   rang_at_clinic_first / clinic_line_busy / is_callback   carrier facts,
 *                      when the forwarding leg exposes them; a call flagged
 *                      as placed by the agent is refused by ingestCall()
 *
 * The call-back variables of 23 September 2026 (`callback_consent`,
 * `callback_consent_quote`, `stop_requested`) and the dialer's reading of the
 * top-level `status` were removed with the call-back: v1 is inbound only.
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

/** `field_<id>` variables, as the requirement fields they name. Values only; the ids are validated downstream. */
function collectedFields(vars: Obj): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(vars)) {
    if (!key.startsWith("field_")) continue;
    const id = key.slice("field_".length);
    const text = str(value);
    if (id && text) out[id] = text;
  }
  return Object.keys(out).length ? out : undefined;
}

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
  const lead = obj(body.lead ?? call.lead);
  // The documented object first (§D.1); the earlier aliases behind it.
  const vars = obj(
    body.collected_variables ?? call.collected_variables ?? call.custom_variables ?? call.extracted_variables ?? call.variables ?? body.variables,
  );

  const externalCallId = str(call.call_id, call.id, body.call_id, body.id);
  if (!externalCallId) throw new VoicePayloadError("The payload carries no call id.");

  const startedAt = when(call.start_time, call.started_at, call.start_timestamp, body.start_time, body.timestamp);
  if (!startedAt) throw new VoicePayloadError("The payload carries no start time.");
  const endedAt = when(call.end_time, call.ended_at, call.end_timestamp, body.end_time);

  const outcome = str(vars.outcome, vars.call_outcome, call.outcome)?.toLowerCase();
  const bookedFor = when(vars.booked_for, vars.appointment_time, vars.booking_time);
  const alternatives = [str(vars.preferred_alt_1), str(vars.preferred_alt_2)].filter((v): v is string => Boolean(v));

  const event: VoiceCallEvent = {
    externalCallId,
    clinicId,
    callerPhone: e164(str(lead.phone_number, call.phone_number, call.customer_phone, call.from, call.caller, body.phone_number)),
    callerName: str(vars.caller_name, vars.name, lead.name, call.customer_name),
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
    // `recording_url` is deliberately not read: no audio reference is kept
    // (decision of 21 September 2026). The vendor's recording storage is
    // switched off in its console; if a URL still arrives, it is ignored.
    booking:
      outcome === "booked" && bookedFor
        ? {
            scheduledFor: bookedFor,
            // The window in the caller's own words, when the agent captured
            // it; the desk reads this before the extracted time.
            preferredWindow: str(vars.preferred_window, vars.preferred_time),
            alternativeWindows: alternatives.length ? alternatives : undefined,
            treatment: str(vars.booked_treatment, vars.treatment_interest),
            externalId: str(vars.booking_id),
            externalSource: str(vars.booking_source),
          }
        : undefined,
    collectedFields: collectedFields(vars),
  };
  return event;
}
