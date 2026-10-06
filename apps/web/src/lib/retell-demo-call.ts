/**
 * Retell outbound calling, for the "have AYA call me" button.
 *
 * ## This is the marketing demo call only
 *
 * It places one thing: the single consented demo call a clinic owner asks for
 * on this website, to AYA's demo agent (lib/voice-demo-prompt.ts, pushed by
 * scripts/retell-demo-agent.ts). It never carries a patient call, and nothing
 * else in apps/web may import it (src/lib/no-outbound-voice.test.ts). The
 * product's voice agent is a different Retell agent pointed at our own Claude
 * endpoint in apps/app, and it never dials anyone.
 *
 * It replaces the Synthflow client that placed this call until 5 October
 * 2026. Replaced, not extended: there is one vendor for the demo call, and
 * the privacy notice and /subprocessors name it.
 *
 * ## The API contract, transcribed
 *
 * POST https://api.retellai.com/v2/create-phone-call, from
 * https://docs.retellai.com/api-references/create-phone-call.md:
 *
 *   - `from_number` and `to_number` are required, both E.164. The from number
 *     must be one bought from or imported into Retell, and a Retell-bought
 *     number can only dial US numbers.
 *   - `override_agent_id` picks the agent for this call only, without binding
 *     the number to it.
 *   - `retell_llm_dynamic_variables` fills `{{name}}` in the prompt; values
 *     must be strings.
 *   - `honor_internal_dnc: true` makes Retell refuse (400) a number whose
 *     contact said "stop calling me" on an earlier call. The agent's DNC
 *     detection marks it; this is what makes the mark stick.
 *   - `idempotency_key` lets a retried request return the same call for an
 *     hour instead of dialling twice.
 *
 * Success is 201 with the call object. A 201 means Retell accepted the call,
 * not that the phone rang or anyone answered; the UI says "she's calling you
 * now" and must not claim more.
 */

const ENDPOINT = "https://api.retellai.com/v2/create-phone-call";

export type RetellDemoConfig = {
  apiKey: string;
  /**
   * AYA's demo agent (scripts/retell-demo-agent.ts), or, for a call asked for
   * from a personalised demo page, the clinic-demo agent
   * (scripts/retell-clinic-demo-agent.ts). Either way an owner who asked.
   */
  agentId: string;
  /** A number bought in Retell, E.164. */
  fromNumber: string;
};

/**
 * Read configuration, or explain precisely what is missing.
 *
 * Returns the reason rather than throwing, so the caller can log something an
 * operator can act on instead of a generic 500.
 */
export function readRetellDemoConfig(agent: "aya" | "clinic" = "aya"):
  | { ok: true; config: RetellDemoConfig }
  | { ok: false; missing: string[] } {
  const agentVar = agent === "clinic" ? "RETELL_CLINIC_DEMO_AGENT_ID" : "RETELL_DEMO_AGENT_ID";
  const apiKey = process.env.RETELL_API_KEY;
  const agentId = process.env[agentVar];
  const fromNumber = process.env.RETELL_DEMO_FROM_NUMBER;

  const missing: string[] = [];
  if (!apiKey) missing.push("RETELL_API_KEY");
  if (!agentId) missing.push(agentVar);
  if (!fromNumber) missing.push("RETELL_DEMO_FROM_NUMBER");
  if (missing.length > 0) return { ok: false, missing };

  return { ok: true, config: { apiKey: apiKey!, agentId: agentId!, fromNumber: fromNumber! } };
}

export type CallRequest = {
  /** Recipient, E.164. */
  phone: string;
  /** Strings only: Retell rejects anything else. */
  variables: Record<string, string>;
  /** Stored on the call for our own reference; not read by the agent. */
  metadata?: Record<string, string>;
  /** One per consented request, so a retry cannot ring twice. */
  idempotencyKey?: string;
};

export type CallResult =
  | { ok: true; callId: string | null }
  | { ok: false; reason: string; detail: string };

/** Place one outbound demo call. */
export async function placeCall(config: RetellDemoConfig, request: CallRequest): Promise<CallResult> {
  const body = {
    from_number: config.fromNumber,
    to_number: request.phone,
    override_agent_id: config.agentId,
    retell_llm_dynamic_variables: request.variables,
    honor_internal_dnc: true,
    ...(request.metadata ? { metadata: request.metadata } : {}),
    ...(request.idempotencyKey ? { idempotency_key: request.idempotencyKey } : {}),
  };

  let response: Response;
  try {
    response = await fetch(ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      // Without this a hung vendor holds the request open until the platform
      // kills it, and the visitor watches a spinner the whole time.
      signal: AbortSignal.timeout(12_000),
    });
  } catch (error) {
    return { ok: false, reason: "network", detail: error instanceof Error ? error.message : String(error) };
  }

  const text = await response.text().catch(() => "");
  let payload: { call_id?: string; message?: string } | null = null;
  try {
    payload = JSON.parse(text) as { call_id?: string; message?: string };
  } catch {
    payload = null;
  }

  if (!response.ok) {
    return {
      ok: false,
      reason: classify(response.status, payload?.message),
      detail: `HTTP ${response.status} ${text.slice(0, 400)}`,
    };
  }
  return { ok: true, callId: payload?.call_id ?? null };
}

/** Map a failure onto something an operator can act on. */
function classify(status: number, message?: string): string {
  const text = (message ?? "").toLowerCase();
  if (status === 400 && /do.?not.?call|dnc/.test(text)) return "do-not-call";
  if (status === 401) return "auth";
  if (status === 402) return "out-of-credit";
  if (status === 422) return "agent-or-number-not-found";
  if (status === 429) return "vendor-rate-limited";
  return `http-${status}`;
}
