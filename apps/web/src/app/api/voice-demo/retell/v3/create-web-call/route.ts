import { clientKey, rateLimit } from "@/lib/rate-limit";
import { createWebCall, readAyaDemoAgentConfig } from "@/lib/retell-web-call";
import { VOICE_DEMO_VARIABLES } from "@/lib/voice-demo-prompt";

/**
 * POST /api/voice-demo/retell/v3/create-web-call, the homepage's "talk now".
 *
 * The owner asked on 9 October 2026 for the homepage's voice card to work
 * like the personalised demo's: talk to AYA from the browser, or have her
 * ring your phone. This is the first half; /api/callback is the second.
 *
 * The browser SDK (retell-client-js-sdk 3) is constructed with a `fetch`
 * override that sends its one control request here instead of to Retell,
 * keeping the path it would have used, exactly as on the personalised demo
 * (api/demo/[slug]/retell). This route holds the API key and builds the whole
 * create-web-call body itself (lib/retell-web-call.ts): it reads nothing from
 * the request, so a browser cannot choose the agent, the variables or the
 * metadata. Retell's reply goes back unchanged, because the SDK connects with
 * exactly that object.
 *
 * The agent is AYA's inbound one, the agent on the demo line, so the call
 * opens the way a call to her does: that she is an AI assistant and that the
 * call is transcribed. It talks to clinic owners, never to patients, which is
 * why it lives on apps/web.
 *
 * Bounded per IP and by a site-wide daily ceiling of its own
 * (`voice-demo-webcall:global:day`, VOICE_DEMO_DAILY_WEBCALL_CAP, where 0
 * switches browser calls off), each charged before Retell is asked.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const IP_LIMIT = 6;
const IP_WINDOW_MS = 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Override with VOICE_DEMO_DAILY_WEBCALL_CAP; 0 switches browser calls off. */
const DAILY_CAP = Number(process.env.VOICE_DEMO_DAILY_WEBCALL_CAP ?? 60);

function fail(error: string, status: number, retryAfter?: number): Response {
  return Response.json(
    { error_message: error },
    { status, headers: retryAfter ? { "Retry-After": String(retryAfter) } : undefined },
  );
}

export async function POST(request: Request): Promise<Response> {
  const config = readAyaDemoAgentConfig();
  if (!config.ok) {
    console.error(`[healdesk] homepage web call requested but Retell is unconfigured: ${config.missing.join(", ")}`);
    return fail("The voice line isn't available right now.", 503);
  }

  const ip = clientKey(request.headers);
  const perIp = await rateLimit(`voice-demo-webcall:ip:${ip}`, IP_LIMIT, IP_WINDOW_MS);
  if (!perIp.ok) return fail("You've started a few calls already. Try again shortly.", 429, perIp.retryAfter);

  const daily = await rateLimit("voice-demo-webcall:global:day", DAILY_CAP, DAY_MS);
  if (!daily.ok) {
    return fail("The voice line has reached its daily limit. Try the chat, or have her call you.", 429, daily.retryAfter);
  }

  const result = await createWebCall(config.config, {
    variables: { ...VOICE_DEMO_VARIABLES },
    metadata: { source: "healdesk.io homepage demo" },
  });
  if (!result.ok) {
    // For us, never for the visitor: a vendor message can name our account or balance.
    console.error("[healdesk] homepage web call failed", { reason: result.reason, detail: result.detail });
    return fail("We couldn't connect the call. Try again in a moment.", 502);
  }
  return new Response(result.body, {
    status: result.status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
