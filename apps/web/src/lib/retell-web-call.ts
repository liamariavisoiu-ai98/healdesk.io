/**
 * Retell browser calls, for "talk now": the personalised demo's, as the
 * clinic, and the homepage's, as AYA (since 9 October 2026).
 *
 * ## Why this dials nobody
 *
 * A web call is the visitor's own browser opening a microphone to the agent
 * after they clicked a button: no phone rings, no number is involved, and the
 * TCPA consent that guards `/api/callback` has nothing to attach to. It is the
 * inbound half of the demo. The outbound half, the agent ringing the owner's
 * phone, stays in lib/retell-demo-call.ts behind its one route, and
 * src/lib/no-outbound-voice.test.ts keeps it there.
 *
 * ## The API contract, transcribed
 *
 * POST https://api.retellai.com/v3/create-web-call, from
 * https://docs.retellai.com/api-references/create-web-call.md:
 *
 *   - `agent_id` is required. `retell_llm_dynamic_variables` fills `{{name}}`
 *     in the prompt; values must be strings. `metadata` is stored on the call.
 *   - 201 returns `call_id`, `access_token`, `transport` ("gateway"),
 *     `ice_servers` and `expires_at`. The browser SDK (retell-client-js-sdk 3)
 *     uses exactly that object to connect, so the route returns it unchanged.
 *
 * The body is built here, on the server, from the stored demo: the browser
 * cannot choose the agent, the variables or the metadata, so it cannot point
 * our account at another agent or inject its own "clinic information".
 */

const ENDPOINT = "https://api.retellai.com/v3/create-web-call";

export type WebCallConfig = { apiKey: string; agentId: string };

export function readClinicDemoAgentConfig():
  | { ok: true; config: WebCallConfig }
  | { ok: false; missing: string[] } {
  const apiKey = process.env.RETELL_API_KEY;
  const agentId = process.env.RETELL_CLINIC_DEMO_AGENT_ID;
  const missing: string[] = [];
  if (!apiKey) missing.push("RETELL_API_KEY");
  if (!agentId) missing.push("RETELL_CLINIC_DEMO_AGENT_ID");
  if (missing.length > 0) return { ok: false, missing };
  return { ok: true, config: { apiKey: apiKey!, agentId: agentId! } };
}

/**
 * AYA's own browser call on the homepage. It is the agent that answers the
 * demo line (scripts/retell-demo-agent.ts, "inbound"), because a browser call
 * is the visitor calling her: it opens "Thank you for calling healdesk",
 * never with the outbound agent's "did you just request a demo?".
 */
export function readAyaDemoAgentConfig():
  | { ok: true; config: WebCallConfig }
  | { ok: false; missing: string[] } {
  const apiKey = process.env.RETELL_API_KEY;
  const agentId = process.env.RETELL_DEMO_INBOUND_AGENT_ID;
  const missing: string[] = [];
  if (!apiKey) missing.push("RETELL_API_KEY");
  if (!agentId) missing.push("RETELL_DEMO_INBOUND_AGENT_ID");
  if (missing.length > 0) return { ok: false, missing };
  return { ok: true, config: { apiKey: apiKey!, agentId: agentId! } };
}

export type WebCallResult =
  | { ok: true; status: number; body: string }
  | { ok: false; reason: string; detail: string };

export async function createWebCall(
  config: WebCallConfig,
  request: { variables: Record<string, string>; metadata: Record<string, string> },
): Promise<WebCallResult> {
  let response: Response;
  try {
    response = await fetch(ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        agent_id: config.agentId,
        retell_llm_dynamic_variables: request.variables,
        metadata: request.metadata,
      }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    return { ok: false, reason: "network", detail: error instanceof Error ? error.message : String(error) };
  }
  const body = await response.text().catch(() => "");
  if (!response.ok) {
    const reason =
      response.status === 401 ? "auth" : response.status === 402 ? "out-of-credit" : response.status === 429 ? "vendor-rate-limited" : `http-${response.status}`;
    return { ok: false, reason, detail: `HTTP ${response.status} ${body.slice(0, 400)}` };
  }
  return { ok: true, status: response.status, body };
}
