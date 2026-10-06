import { clinicVoiceVariables } from "@/lib/demo/clinic-prompts";
import { getDemoSession, isDemoActive, isDemoSlug, profileOf } from "@/lib/demo/sessions";
import { clientKey, rateLimit } from "@/lib/rate-limit";
import { createWebCall, readClinicDemoAgentConfig } from "@/lib/retell-web-call";

/**
 * POST /api/demo/[slug]/retell/v3/create-web-call, "talk to it now".
 *
 * The browser SDK (retell-client-js-sdk 3) is constructed with a `fetch`
 * override that sends its one control request here instead of to Retell,
 * keeping the path it would have used. This route holds the API key and
 * builds the whole create-web-call body itself (lib/retell-web-call.ts): it
 * reads nothing from the request but the slug, so a browser cannot choose
 * the agent, the clinic text or the metadata. Retell's reply goes back
 * unchanged, because the SDK connects with exactly that object.
 *
 * The call audio then flows browser-to-Retell over WebRTC, which is why the
 * /demo pages, and only they, allow the microphone and api.retellai.com in
 * their security headers (next.config.ts).
 *
 * Bounded like the dialled call: per IP, per demo, and a site-wide daily
 * ceiling (`webcall:global:day`), each charged before Retell is asked.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const IP_LIMIT = 8;
const IP_WINDOW_MS = 60 * 60 * 1000;
const DEMO_LIMIT = 25;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Override with DEMO_DAILY_WEBCALL_CAP; 0 switches browser calls off. */
const DAILY_CAP = Number(process.env.DEMO_DAILY_WEBCALL_CAP ?? 60);

function fail(error: string, status: number, retryAfter?: number): Response {
  return Response.json(
    { error_message: error },
    { status, headers: retryAfter ? { "Retry-After": String(retryAfter) } : undefined },
  );
}

export async function POST(request: Request, ctx: { params: Promise<{ slug: string }> }): Promise<Response> {
  const { slug } = await ctx.params;
  if (!isDemoSlug(slug)) return fail("Demo not found.", 404);

  const ip = clientKey(request.headers);
  const perIp = await rateLimit(`demo-webcall:ip:${ip}`, IP_LIMIT, IP_WINDOW_MS);
  if (!perIp.ok) return fail("You've started a few calls already. Try again shortly.", 429, perIp.retryAfter);

  const session = await getDemoSession(slug);
  if (!session) return fail("Demo not found.", 404);
  const profile = profileOf(session);
  if (!isDemoActive(session) || !profile) return fail("This demo has expired.", 410);

  const config = readClinicDemoAgentConfig();
  if (!config.ok) {
    console.error(`[healdesk] demo web call requested but Retell is unconfigured: ${config.missing.join(", ")}`);
    return fail("The voice line isn't available right now.", 503);
  }

  const perDemo = await rateLimit(`demo-webcall:slug:${slug}`, DEMO_LIMIT, DAY_MS);
  if (!perDemo.ok) return fail("This demo has had a lot of calls today. It resets tomorrow.", 429, perDemo.retryAfter);
  const daily = await rateLimit("webcall:global:day", DAILY_CAP, DAY_MS);
  if (!daily.ok) return fail("The voice line has reached its daily limit. Try the chat, or call again tomorrow.", 429, daily.retryAfter);

  const result = await createWebCall(config.config, {
    variables: clinicVoiceVariables(profile, "browser"),
    metadata: { demo_slug: slug, source: "healdesk.io personalised demo" },
  });
  if (!result.ok) {
    // For us, never for the visitor: a vendor message can name our account or balance.
    console.error("[healdesk] demo web call failed", { slug, reason: result.reason, detail: result.detail });
    return fail("We couldn't connect the call. Try again in a moment.", 502);
  }
  return new Response(result.body, {
    status: result.status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
