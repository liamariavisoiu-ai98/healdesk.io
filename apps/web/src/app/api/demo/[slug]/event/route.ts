import { demoVariant } from "@/lib/demo/close";
import { demoEventDetail, isDemoEventName, recordDemoEvent } from "@/lib/demo/events";
import { getDemoSession, isDemoSlug } from "@/lib/demo/sessions";
import { clientKey, rateLimit } from "@/lib/rate-limit";

/**
 * POST /api/demo/[slug]/event, the demo page's own measurement
 * (lib/demo/events.ts says why it is first party and server side).
 *
 * Takes a name and at most one detail, both from a closed list; anything else
 * is dropped. The close the demo shows is worked out here from the slug, never
 * taken from the browser, so a report cannot be skewed from the page. Always
 * 204 to a well-formed call, recorded or not: the page has nothing to do with
 * the answer, and a missing demo learns nothing from it either.
 * `checkout_paid` is the Stripe webhook's alone.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const IP_LIMIT = 120;
const WINDOW_MS = 60 * 60 * 1000;

export async function POST(request: Request, ctx: { params: Promise<{ slug: string }> }): Promise<Response> {
  const { slug } = await ctx.params;
  if (!isDemoSlug(slug)) return new Response(null, { status: 404 });

  const limit = await rateLimit(`demo-event:${clientKey(request.headers)}`, IP_LIMIT, WINDOW_MS);
  if (!limit.ok) return new Response(null, { status: 429 });

  let body: { name?: unknown; detail?: unknown } | null;
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return new Response(null, { status: 400 });
  }
  const name = body?.name;
  if (!isDemoEventName(name) || name === "checkout_paid") return new Response(null, { status: 400 });

  const session = await getDemoSession(slug);
  if (session) {
    await recordDemoEvent({ slug, variant: demoVariant(slug), name, detail: demoEventDetail(name, body?.detail) });
  }
  return new Response(null, { status: 204 });
}
