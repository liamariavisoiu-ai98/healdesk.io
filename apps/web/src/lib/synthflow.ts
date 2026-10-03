/**
 * Synthflow outbound calling, for the "have AYA call me" button.
 *
 * ## Pre-Retell: this is the marketing demo call only
 *
 * The product's voice agent runs on Retell, pointed at a Healdesk-hosted
 * Claude endpoint (docs/v1-product-spec.md, "Scope and locked decisions"),
 * and it lives in apps/app, not here. This file places one thing: the single
 * consented demo call a clinic owner asks for on this website. It stays on
 * Synthflow until a Retell demo agent exists, and then it is replaced, not
 * extended. It never carries a patient call, and nothing else in apps/web may
 * import it (src/lib/no-outbound-voice.test.ts).
 *
 * The history below is kept because it explains the API contract, not because
 * Synthflow is still the product's voice vendor: that decision changed to
 * Retell on 24 September 2026.
 *
 * ## Why Synthflow and not the Vapi client this replaces
 *
 * Synthflow was the decided voice vendor at the time this route was written, docs/launch-plan.md:777 lists it under "Resolved this session", the
 * build phases name it outright, and there are two long briefs written for the
 * prompt engineer building the agent. An earlier version of this file talked to
 * Vapi, purely because `.env.example` still carried VAPI_* stubs from an
 * abandoned evaluation and the stubs were mistaken for the decision.
 *
 * The reasoning behind the choice is all compliance and cost, none of it voice
 * quality: Synthflow's Subscriber Terms §14.4 promise not to train on customer
 * input or output, its published BAA carries no tier gate or per-agent HIPAA
 * fee, and it has a US single-region cluster that makes the "US infrastructure"
 * claim true. One accepted cost: Synthflow's model selector is OpenAI-only, so
 * it cannot run Claude the way the chat demo does.
 *
 * ## The API contract below was transcribed, not remembered
 *
 * Every field name here was read off the raw docs at
 * https://docs.synthflow.ai/api-reference/platform-api/calls/voice-call
 * and then independently re-verified against the same primary source. That
 * matters because three of them are counter-intuitive and would each produce a
 * plausible-looking request that fails or does the wrong thing:
 *
 *   - The agent is `model_id`, NOT `assistant_id` or `agent_id`.
 *   - `name` is the CALL RECIPIENT'S name, not the agent's. Passing the agent
 *     name here calls a stranger and greets them as AYA.
 *   - `custom_variables` is an ARRAY of {key, value} objects on this endpoint,
 *     not a flat map, even though Synthflow's own /variables page and its
 *     batch endpoint both show the flat map form. The array is what the
 *     endpoint reference and all seven of its SDK samples use.
 *
 * `model_id`, `phone` and `name` are the three required fields.
 */

/** Region hosts. Data residency matters here, so this is explicit. */
const HOSTS = {
  us: "https://api.us.synthflow.ai/v2",
  eu: "https://api.eu.synthflow.ai/v2",
  global: "https://api.synthflow.ai/v2",
} as const;

export type SynthflowRegion = keyof typeof HOSTS;

export type SynthflowConfig = {
  apiKey: string;
  /** The outbound agent's id, from its page in the Synthflow dashboard. */
  modelId: string;
  region: SynthflowRegion;
  /** Optional caller ID. Must already be attached to the outbound agent. */
  fromNumber?: string;
};

/**
 * Read configuration, or explain precisely what is missing.
 *
 * Returns the reason rather than throwing, so the caller can log something an
 * operator can act on instead of a generic 500.
 */
export function readSynthflowConfig():
  | { ok: true; config: SynthflowConfig }
  | { ok: false; missing: string[] } {
  const apiKey = process.env.SYNTHFLOW_API_KEY;
  const modelId = process.env.SYNTHFLOW_DEMO_AGENT_ID;

  const missing: string[] = [];
  if (!apiKey) missing.push("SYNTHFLOW_API_KEY");
  if (!modelId) missing.push("SYNTHFLOW_DEMO_AGENT_ID");
  if (missing.length > 0) return { ok: false, missing };

  const requested = process.env.SYNTHFLOW_REGION;
  // Defaults to `us`, not to `global`. The workspace cluster is a permanent,
  // one-time choice and the US one is what keeps Synthflow's row on
  // /subprocessors ("United States workspace") true; silently defaulting to
  // the global host would undermine it.
  const region: SynthflowRegion =
    requested === "eu" || requested === "global" || requested === "us"
      ? requested
      : "us";

  return {
    ok: true,
    config: {
      apiKey: apiKey!,
      modelId: modelId!,
      region,
      fromNumber: process.env.SYNTHFLOW_FROM_NUMBER || undefined,
    },
  };
}

export type CallRequest = {
  /** Recipient, E.164. */
  phone: string;
  /** Recipient's name. Required by the API, pass a fallback, never the agent's. */
  name: string;
  variables?: Record<string, string>;
  email?: string;
  /** Overrides the agent's own greeting for this call only. */
  greeting?: string;
};

/** The documented 200 envelope, plus the error_message seen on failures. */
type SynthflowCallResponse = {
  status?: string;
  error_message?: string;
  response?: { answer?: string; call_id?: string };
};

export type CallResult =
  | { ok: true; callId: string | null }
  | { ok: false; reason: string; detail: string };

/**
 * Place one outbound call.
 *
 * A 200 means Synthflow ACCEPTED the call for initialization, not that the
 * phone rang, and not that anyone answered. The outcome arrives later on the
 * post-call webhook, or from GET /v2/calls/{call_id}. The UI is worded to match
 * ("she's calling you now"), and must not be changed to claim a completed call.
 */
export async function placeCall(
  config: SynthflowConfig,
  request: CallRequest,
): Promise<CallResult> {
  const body: Record<string, unknown> = {
    model_id: config.modelId,
    phone: request.phone,
    name: request.name,
  };

  if (config.fromNumber) body.from_phone_number = config.fromNumber;
  if (request.email) body.lead_email = request.email;
  if (request.greeting) body.greeting = request.greeting;
  if (request.variables) {
    // Array of {key, value}, per the endpoint reference, see the header note.
    body.custom_variables = Object.entries(request.variables).map(
      ([key, value]) => ({ key, value }),
    );
  }

  let response: Response;
  try {
    response = await fetch(`${HOSTS[config.region]}/calls`, {
      method: "POST",
      headers: {
        // Bearer, never x-api-key. The string "x-api-key" does not appear
        // anywhere in Synthflow's documentation.
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      // Without this a hung vendor holds the request open until the platform
      // kills it, and the visitor watches a spinner the whole time.
      signal: AbortSignal.timeout(12_000),
    });
  } catch (error) {
    return {
      ok: false,
      reason: "network",
      detail: error instanceof Error ? error.message : String(error),
    };
  }

  const text = await response.text().catch(() => "");
  let payload: SynthflowCallResponse | null = null;
  try {
    payload = JSON.parse(text) as SynthflowCallResponse;
  } catch {
    // A non-JSON body is itself a signal (an HTML error page from a proxy, an
    // empty 502). `text` is still carried into the detail below.
    payload = null;
  }

  // Defensive on BOTH axes. Synthflow documents only the 200 for this endpoint
  //. There is no published 4xx shape, and its success envelope is
  // inconsistent across the docs ("success" here, "ok" on other endpoints). So
  // branch on the HTTP status plus the presence of a call id, never on an exact
  // status string.
  if (!response.ok) {
    return {
      ok: false,
      reason: classify(response.status, payload?.error_message),
      detail: `HTTP ${response.status} ${text.slice(0, 400)}`,
    };
  }

  if (payload?.error_message) {
    return {
      ok: false,
      reason: classify(response.status, payload.error_message),
      detail: payload.error_message.slice(0, 400),
    };
  }

  return { ok: true, callId: payload?.response?.call_id ?? null };
}

/**
 * Map a failure onto something an operator can act on.
 *
 * The three strings matched here are documented verbatim on Synthflow's
 * batch-calling page, and all three are operational rather than code faults.
 * they are the ones worth naming distinctly in a log so the fix is obvious.
 */
function classify(status: number, message?: string): string {
  const text = (message ?? "").toLowerCase();
  if (text.includes("insufficient minutes")) return "out-of-minutes";
  if (text.includes("attach a phone number")) return "agent-has-no-number";
  if (text.includes("working hours")) return "outside-working-hours";
  if (status === 401 || status === 403) return "auth";
  if (status === 429) return "vendor-rate-limited";
  return `http-${status}`;
}
