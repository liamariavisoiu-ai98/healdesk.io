import { withinConnectAttemptLimit } from "@/lib/connections/attempt-limit";
import { consumeConnectionLinkWithin, resolveConnectionLink } from "@/lib/connections/links";
import { describeError, log } from "@/lib/log";
import { attachMetaChannel } from "@/lib/meta/channels";
import { prepareWhatsApp } from "@/lib/meta/connect";
import { LinkAlreadySpentError, META_CONNECT_ACTOR, metaApp, requestContextFrom } from "@/lib/meta/connect-http";
import { withTenant } from "@/lib/tenant";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** A token, a code and two numeric ids. Anything larger is not this request. */
const MAX_BODY_BYTES = 4_096;

/**
 * POST /api/meta/whatsapp — the end of Embedded Signup on /channels/whatsapp/[token].
 *
 * The page relays three things Meta gave the browser: the authorization code
 * from `FB.login`, and the WhatsApp Business account and phone number ids
 * from the `WA_EMBEDDED_SIGNUP` message. None of them is trusted on its own:
 * the code is exchanged server-side with the app secret, and the two ids are
 * proved by Meta accepting the subscription and the registration under that
 * token (lib/meta/connect.ts). Storing the channel and burning the link happen
 * in one tenant transaction, as on the Facebook callback.
 *
 * Answers JSON, because the caller is the page's own script.
 */
export async function POST(request: Request): Promise<Response> {
  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) return Response.json({ ok: false, error: "bad_request" }, { status: 413 });

  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return Response.json({ ok: false, error: "bad_request" }, { status: 400 });
  }
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  const token = str(body.token);

  const context = requestContextFrom(request);
  if (!withinConnectAttemptLimit("submit", token, context.ipAddress ?? null)) {
    return Response.json({ ok: false, error: "throttled" }, { status: 429 });
  }

  const link = await resolveConnectionLink(token, context, "whatsapp");
  if (!link) return Response.json({ ok: false, error: "invalid_link" }, { status: 410 });

  const app = metaApp();
  if (!app) return Response.json({ ok: false, error: "not_configured" }, { status: 503 });

  const outcome = await prepareWhatsApp(fetch, app, {
    code: str(body.code),
    wabaId: str(body.wabaId),
    phoneNumberId: str(body.phoneNumberId),
  });
  if (!outcome.ok) {
    if (outcome.problem === "meta_error") {
      log.warn("WhatsApp signup could not be completed", { clinicId: link.clinicId, reason: outcome.detail });
    }
    return Response.json({ ok: false, error: outcome.problem }, { status: outcome.problem === "bad_request" ? 400 : 502 });
  }

  try {
    await withTenant({ clinicId: link.clinicId, actor: META_CONNECT_ACTOR, request: context }, async (tx) => {
      await attachMetaChannel(tx, { ...outcome.channel, via: "embedded_signup" });
      const burned = await consumeConnectionLinkWithin(tx, token, context.ipAddress ?? null, "whatsapp");
      if (!burned) throw new LinkAlreadySpentError();
    });
  } catch (error) {
    if (error instanceof LinkAlreadySpentError) {
      return Response.json({ ok: false, error: "invalid_link" }, { status: 410 });
    }
    log.error("Storing a clinic's WhatsApp channel failed", { clinicId: link.clinicId, error: describeError(error) });
    return Response.json({ ok: false, error: "meta_error" }, { status: 500 });
  }

  return Response.json({ ok: true, number: outcome.displayNumber });
}
