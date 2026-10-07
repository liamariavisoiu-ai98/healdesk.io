import { ConnectError, mintConnectState } from "@/lib/billing/connect";
import { describeError, log } from "@/lib/log";
import { requirePortal } from "@/lib/portal/access";
import { requireStepUp } from "@/lib/portal/step-up";
import { publicUrl } from "@/lib/public-url";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The shape of a clinic slug (lib/provisioning.ts slugify, plus a suffix). */
const SLUG = /^[a-z0-9][a-z0-9-]{0,99}$/;

/**
 * GET /api/connect/stripe/start?clinic=<slug>&from=settings|setup: the
 * portal's "Connect Stripe" button (BD28), from Settings → Payments or the
 * setup wizard.
 *
 * The clinic's sign-in must be on this clinic (requirePortal) with a live
 * passkey step-up (`sensitive_change`: connecting a payment account is one).
 * Both guards answer by throwing Next's own redirect or not-found signals,
 * to the sign-in page, the step-up page or a 404, so neither is called
 * inside a try/catch: catching them would turn a sign-in redirect into an
 * error page. After a step-up the browser comes back to the page it started
 * from, and the button is pressed again.
 *
 * The state minted here is bound to the signed-in user, and the callback
 * refuses it from any other browser. The step-up's device label is the
 * actor on the audit row, as the access log records it.
 *
 * A link that cannot be minted (Connect not configured, no public origin,
 * already connected) sends the browser back with `connect=failed`, never an
 * error page, and never to `/admin`.
 */
export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const slug = url.searchParams.get("clinic") ?? "";
  const from = url.searchParams.get("from");
  if (!SLUG.test(slug) || (from !== "settings" && from !== "setup")) {
    return new Response("Not found.", { status: 404, headers: { "Cache-Control": "no-store" } });
  }

  const ctx = await requirePortal(slug);
  const back = `/c/${ctx.clinicSlug}/${from}`;
  const stepUp = await requireStepUp(ctx, "sensitive_change", { returnTo: back });

  let location: string;
  try {
    const minted = await mintConnectState({
      clinicId: ctx.clinicId,
      returnTo: from,
      userId: ctx.userId,
      actor: { type: "user", userId: ctx.userId, label: stepUp.deviceLabel },
    });
    location = minted.url;
  } catch (error) {
    if (error instanceof ConnectError) {
      log.warn("stripe connect start refused", { clinicId: ctx.clinicId, code: error.code });
    } else {
      log.error("stripe connect start failed", {
        clinicId: ctx.clinicId,
        error: describeError(error),
      });
    }
    location = portalUrl(`${back}?connect=failed`);
  }
  return new Response(null, {
    status: 303,
    headers: { Location: location, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" },
  });
}

function portalUrl(path: string): string {
  try {
    return publicUrl(path);
  } catch {
    return path;
  }
}
