import { withinConnectAttemptLimit } from "@/lib/connections/attempt-limit";
import { consumeConnectionLinkWithin, resolveConnectionLink } from "@/lib/connections/links";
import { describeError, log } from "@/lib/log";
import { attachMetaChannel, MetaAssetTakenError } from "@/lib/meta/channels";
import { prepareWhatsApp } from "@/lib/meta/connect";
import { fromOwnPage, LinkAlreadySpentError, META_CONNECT_ACTOR, metaApp, requestContextFrom } from "@/lib/meta/connect-http";
import { isMetaId } from "@/lib/meta/graph";
import { portalOrNull } from "@/lib/portal/access";
import { surfaceOf } from "@/lib/meta/portal-return";
import { replacesConnectedAsset, storedRegistrationPin } from "@/lib/meta/reconnect";
import { portalActor } from "@/lib/portal/actor";
import { stepUpPath } from "@/lib/portal/step-up";
import { withTenant, type TenantTx } from "@/lib/tenant";

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
 *
 * Two callers. A mailed link's page sends `token`, which is the whole
 * authentication, spent with the channel. The portal's page
 * (/c/[slug]/whatsapp, set-up's channels step and Settings → Channels, both
 * Connect and Reconnect) sends `clinic` instead, the slug, and the signed-in
 * session is the authority (portalOrNull); there is no link to spend, so a
 * failed attempt is simply tried again. Starting asks for no passkey step-up,
 * as for the Facebook button and the calendar's first connect: a connection
 * sends nothing anywhere new, because the channel only ever answers people
 * who wrote in first. Replacing a connected number with a different one does
 * need a live step-up (the Google Calendar rule for a different account), and
 * the answer says where to get it. That is decided on the number asked for,
 * before Meta is called: a refused swap registers nothing, because a number
 * registered under a PIN that is then thrown away refuses every later
 * attempt. The request must come from our own page.
 *
 * On both paths, the number the clinic already has connected is registered
 * again with the PIN sealed with it (storedRegistrationPin): Meta refuses a
 * reconnect of the same number under a fresh one.
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
  if (str(body.clinic) !== "") return fromPortal(request, str(body.clinic), body, context);
  if (!withinConnectAttemptLimit("submit", token, context.ipAddress ?? null)) {
    return Response.json({ ok: false, error: "throttled" }, { status: 429 });
  }

  const link = await resolveConnectionLink(token, context, "whatsapp");
  if (!link) return Response.json({ ok: false, error: "invalid_link" }, { status: 410 });

  const app = metaApp();
  if (!app) return Response.json({ ok: false, error: "not_configured" }, { status: 503 });

  const input = { code: str(body.code), wabaId: str(body.wabaId), phoneNumberId: str(body.phoneNumberId) };
  const pin = isMetaId(input.phoneNumberId)
    ? await withTenant({ clinicId: link.clinicId, actor: META_CONNECT_ACTOR, request: context }, (tx) =>
        storedRegistrationPin(tx, input.phoneNumberId),
      )
    : undefined;
  const outcome = await prepareWhatsApp(fetch, app, input, pin);
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
    // Another practice holds this number: nothing saved.
    if (error instanceof MetaAssetTakenError) {
      return Response.json({ ok: false, error: "number_taken" }, { status: 409 });
    }
    log.error("Storing a clinic's WhatsApp channel failed", { clinicId: link.clinicId, error: describeError(error) });
    return Response.json({ ok: false, error: "meta_error" }, { status: 500 });
  }

  return Response.json({ ok: true, number: outcome.displayNumber });
}

/** The portal's WhatsApp sign-up: the same proof of the ids, then the same store, under the signed-in person's name. */
async function fromPortal(
  request: Request,
  slug: string,
  body: Record<string, unknown>,
  context: ReturnType<typeof requestContextFrom>,
): Promise<Response> {
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  if (!fromOwnPage(request.headers)) return Response.json({ ok: false, error: "bad_request" }, { status: 403 });
  const portal = await portalOrNull(slug);
  if (!portal) return Response.json({ ok: false, error: "signed_out" }, { status: 401 });
  if (!withinConnectAttemptLimit("submit", `portal-whatsapp:${portal.clinicId}`, context.ipAddress ?? null)) {
    return Response.json({ ok: false, error: "throttled" }, { status: 429 });
  }
  const app = metaApp();
  if (!app) return Response.json({ ok: false, error: "not_configured" }, { status: 503 });

  const input = { code: str(body.code), wabaId: str(body.wabaId), phoneNumberId: str(body.phoneNumberId) };
  // The swap and the PIN are decided on the number asked for, so it must be one.
  if (!isMetaId(input.phoneNumberId)) return Response.json({ ok: false, error: "bad_request" }, { status: 400 });

  const actor = await portalActor(portal);
  const scope = { clinicId: portal.clinicId, actor: { type: "user" as const, userId: portal.userId, label: actor.label }, request: context };
  const needsStepUp = () =>
    Response.json(
      { ok: false, error: "needs_step_up", stepUpHref: stepUpPath(portal.clinicSlug, `/c/${portal.clinicSlug}/whatsapp?from=${surfaceOf(body.from)}`) },
      { status: 403 },
    );
  const swaps = (tx: TenantTx) =>
    replacesConnectedAsset(tx.db, tx.clinicId, [{ platform: "whatsapp", externalId: input.phoneNumberId }]);
  // Before any Graph call: swapping the connected number for another needs a
  // live step-up (a first connect and a reconnect of the same number do
  // not), and a swap refused here has registered nothing with Meta. The same
  // number again reuses the PIN it was registered with.
  const before = await withTenant(scope, async (tx) =>
    (await swaps(tx)) ? { swap: true, pin: undefined } : { swap: false, pin: await storedRegistrationPin(tx, input.phoneNumberId) },
  );
  if (before.swap && !actor.steppedUp) return needsStepUp();

  const outcome = await prepareWhatsApp(fetch, app, input, before.pin);
  if (!outcome.ok) {
    if (outcome.problem === "meta_error") {
      log.warn("WhatsApp signup could not be completed", { clinicId: portal.clinicId, reason: outcome.detail });
    }
    return Response.json({ ok: false, error: outcome.problem }, { status: outcome.problem === "bad_request" ? 400 : 502 });
  }

  try {
    const stored = await withTenant(scope, async (tx) => {
      // Asked again where it is stored: another tab may have connected a
      // different number while Meta was being called.
      if (!actor.steppedUp && (await swaps(tx))) return false;
      await attachMetaChannel(tx, { ...outcome.channel, via: "embedded_signup" });
      return true;
    });
    if (!stored) return needsStepUp();
  } catch (error) {
    if (error instanceof MetaAssetTakenError) {
      return Response.json({ ok: false, error: "number_taken" }, { status: 409 });
    }
    log.error("Storing a clinic's WhatsApp channel failed", { clinicId: portal.clinicId, error: describeError(error) });
    return Response.json({ ok: false, error: "meta_error" }, { status: 500 });
  }
  return Response.json({ ok: true, number: outcome.displayNumber });
}
