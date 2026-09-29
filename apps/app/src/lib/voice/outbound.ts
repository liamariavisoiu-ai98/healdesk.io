import { env } from "@/lib/env";
import { log } from "@/lib/log";

/**
 * Placing a call (design of 23 September 2026, §F.8).
 *
 * This is the only file that asks a vendor to dial, and it knows nothing
 * about consent, windows or caps: every gate is passed before the dialer
 * (lib/callbacks/dial.ts) reaches `placeCall`, the attempt is on the ledger
 * before the request leaves, and the ledger — not this client — decides
 * whether a second attempt exists. So the interface is a single method and
 * the two implementations differ only in where the call goes: Synthflow's
 * outbound API, or an in-memory list a test reads back.
 *
 * Injected by parameter, never chosen from the environment: the worker
 * constructs the Synthflow client, the tests construct the fixture, and no
 * code path can end up dialling a real number because a variable was set in
 * the wrong place. Nothing PHI-shaped is logged — the number goes to the
 * vendor and to the ledger, and nowhere else.
 */
export interface VoiceOutboundClient {
  placeCall(input: {
    clinicId: string;
    /** The clinic's callback agent (clinics.synthflow_callback_agent_id). */
    agentId: string;
    /** E.164. PHI. */
    toPhone: string;
    /** The clinic's Synthflow number, or null when the vendor's default is to be used. */
    fromPhone: string | null;
    /** The first name, as the vendor's lead record wants it. */
    name: string;
    /** The verbatim first message (lib/compliance/disclosure.ts callbackDisclosure). */
    greeting: string;
    /** IANA, the recipient's; what the vendor uses for its own scheduling. */
    timeZone: string;
    /** `custom_variables` — every string the callback agent's script reads. */
    variables: Record<string, string>;
  }): Promise<{ vendorCallId: string }>;
}

export class VoiceOutboundError extends Error {
  constructor(
    message: string,
    /** A short vendor status for the ledger's audit row: never the body, which could echo the number. */
    readonly code: string,
  ) {
    super(message);
    this.name = "VoiceOutboundError";
  }
}

/** Synthflow's US cluster: the only origin the dialer will place a PHI-bearing call through (§F.5 step 1). */
export const SYNTHFLOW_US_API_BASE = "https://api.us.synthflow.ai";

/** How long the vendor gets to accept the request before the attempt is recorded as failed. */
export const PLACE_CALL_TIMEOUT_MS = 8_000;

export function isUsSynthflowBase(base: string | undefined | null): base is string {
  return typeof base === "string" && base.startsWith(SYNTHFLOW_US_API_BASE);
}

/**
 * `POST ${HEALDESK_SYNTHFLOW_API_BASE}/v2/calls` with a Bearer key.
 *
 * ⚠️ verify-before-go-live. Read from https://docs.synthflow.ai/api-reference/
 * platform-api/calls/voice-call on 23 September 2026: the documented body is
 * `{ model_id, phone, name, from_phone_number, custom_variables: [{key,
 * value}], lead_email, lead_timezone, prompt, greeting }` and the response
 * `{ status, response: { call_id }, eta }`. Three things this relies on that
 * a test call must confirm before the first real one: that a per-call
 * `greeting` overrides the agent's first message verbatim; that
 * `custom_variables` reach the agent's script as `{{name}}`; and that
 * `response.call_id` is the same id the post-call webhook later carries as
 * `call_id`, because that equality is what lets ingestCall() recognise the
 * call as ours (§F.6). `eta` means the call is queued, not ringing — it is
 * logged and not stored, and the dialer stops thirty minutes before the
 * window's edge to absorb it. `lead_email` and `prompt` are never sent: no
 * patient email exists, and the script lives on the agent.
 */
export class SynthflowOutboundClient implements VoiceOutboundClient {
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;

  constructor(opts: { fetch?: typeof fetch; timeoutMs?: number } = {}) {
    this.#fetch = opts.fetch ?? fetch;
    this.#timeoutMs = opts.timeoutMs ?? PLACE_CALL_TIMEOUT_MS;
  }

  async placeCall(input: Parameters<VoiceOutboundClient["placeCall"]>[0]): Promise<{ vendorCallId: string }> {
    // Read at use, like the dialer's gate, so a key rotated or a base
    // corrected in the environment takes effect on the next row.
    const apiKey = env.synthflowApiKey();
    const apiBase = env.synthflowApiBase();
    if (!apiKey) throw new VoiceOutboundError("HEALDESK_SYNTHFLOW_API_KEY is not set.", "no_vendor");
    if (!isUsSynthflowBase(apiBase)) throw new VoiceOutboundError("HEALDESK_SYNTHFLOW_API_BASE is not the US cluster.", "non_us_base");

    const body = {
      model_id: input.agentId,
      phone: input.toPhone,
      name: input.name,
      ...(input.fromPhone ? { from_phone_number: input.fromPhone } : {}),
      greeting: input.greeting,
      lead_timezone: input.timeZone,
      custom_variables: Object.entries(input.variables).map(([key, value]) => ({ key, value })),
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    let response: Response;
    try {
      response = await this.#fetch(`${apiBase.replace(/\/$/, "")}/v2/calls`, {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      const aborted = error instanceof Error && error.name === "AbortError";
      throw new VoiceOutboundError(aborted ? "The vendor did not answer within the time budget." : "The vendor could not be reached.", aborted ? "timeout" : "network");
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      // The status only: a vendor error body can echo the request, and the
      // request carries the number.
      throw new VoiceOutboundError(`The vendor refused the call (HTTP ${response.status}).`, `http_${response.status}`);
    }
    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch {
      throw new VoiceOutboundError("The vendor's reply was not JSON.", "bad_reply");
    }
    const vendorCallId = callIdOf(parsed);
    if (!vendorCallId) throw new VoiceOutboundError("The vendor's reply carried no call id.", "no_call_id");
    const eta = etaOf(parsed);
    log.info("callback placed with vendor", { clinicId: input.clinicId, provider: "synthflow", status: eta === null ? "queued" : `queued eta=${eta}` });
    return { vendorCallId };
  }
}

function callIdOf(reply: unknown): string | null {
  if (!reply || typeof reply !== "object") return null;
  const r = reply as { response?: { call_id?: unknown }; call_id?: unknown };
  const id = r.response && typeof r.response === "object" ? r.response.call_id : r.call_id;
  return typeof id === "string" && id.trim() ? id.trim() : typeof id === "number" ? String(id) : null;
}

function etaOf(reply: unknown): number | string | null {
  if (!reply || typeof reply !== "object") return null;
  const eta = (reply as { eta?: unknown }).eta;
  return typeof eta === "number" || typeof eta === "string" ? eta : null;
}

export type RecordedOutboundCall = Parameters<VoiceOutboundClient["placeCall"]>[0] & { vendorCallId: string };

/**
 * The test double: records every call in memory and hands back
 * `fx-call-<n>`. `failNext()` makes the next attempt throw the way a vendor
 * refusal would; `onPlaceCall` runs at the moment of the call so a test can
 * look at the database while the dial is in flight — which is how
 * "recordAttempt precedes placeCall" is asserted rather than assumed.
 */
export class FixtureOutboundClient implements VoiceOutboundClient {
  readonly calls: RecordedOutboundCall[] = [];
  #failNext: VoiceOutboundError | null = null;
  #onPlaceCall: ((input: Parameters<VoiceOutboundClient["placeCall"]>[0]) => Promise<void> | void) | null;

  constructor(opts: { onPlaceCall?: (input: Parameters<VoiceOutboundClient["placeCall"]>[0]) => Promise<void> | void } = {}) {
    this.#onPlaceCall = opts.onPlaceCall ?? null;
  }

  failNext(code = "http_502"): void {
    this.#failNext = new VoiceOutboundError("fixture: the vendor refused the call", code);
  }

  async placeCall(input: Parameters<VoiceOutboundClient["placeCall"]>[0]): Promise<{ vendorCallId: string }> {
    if (this.#onPlaceCall) await this.#onPlaceCall(input);
    if (this.#failNext) {
      const error = this.#failNext;
      this.#failNext = null;
      throw error;
    }
    const vendorCallId = `fx-call-${this.calls.length + 1}`;
    this.calls.push({ ...input, vendorCallId });
    return { vendorCallId };
  }

  reset(): void {
    this.calls.length = 0;
    this.#failNext = null;
  }
}
