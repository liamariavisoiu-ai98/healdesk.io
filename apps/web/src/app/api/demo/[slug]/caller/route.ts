import { getDemoSession, isDemoActive, isDemoSlug, updateDemoSession } from "@/lib/demo/sessions";
import { maskPhone, normalizePhone } from "@/lib/phone";
import { clientKey, rateLimit } from "@/lib/rate-limit";

/**
 * POST /api/demo/[slug]/caller, the "Call us" tab: "I'll call from this number."
 *
 * Saves the number on the demo, so that when it rings the demo line the
 * inbound webhook (app/api/voice-demo/inbound) answers as this clinic rather
 * than as healdesk. Nothing is dialled: the prospect places the call
 * themselves, which is why no consent tick is needed here, unlike "Call me".
 *
 * It overwrites the number the operator may have entered for "Call me";
 * both are the owner's own number, and the latest one they typed is the one
 * they are holding.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const IP_LIMIT = 10;
const WINDOW_MS = 60 * 60 * 1000;

export async function POST(request: Request, ctx: { params: Promise<{ slug: string }> }): Promise<Response> {
  const { slug } = await ctx.params;
  if (!isDemoSlug(slug)) return Response.json({ error: "Demo not found." }, { status: 404 });

  const limit = await rateLimit(`demo-caller:${clientKey(request.headers)}`, IP_LIMIT, WINDOW_MS);
  if (!limit.ok) return Response.json({ error: "Too many attempts. Try again shortly." }, { status: 429 });

  let phone: unknown;
  try {
    phone = ((await request.json()) as { phone?: unknown } | null)?.phone;
  } catch {
    return Response.json({ error: "Invalid request body." }, { status: 400 });
  }
  const parsed = normalizePhone(phone);
  if (!parsed.ok) return Response.json({ error: parsed.reason }, { status: 400 });

  const session = await getDemoSession(slug);
  if (!session) return Response.json({ error: "Demo not found." }, { status: 404 });
  if (!isDemoActive(session)) return Response.json({ error: "This demo has expired." }, { status: 410 });

  try {
    await updateDemoSession(slug, { phoneE164: parsed.e164 });
  } catch (error) {
    console.error("[healdesk] demo caller not saved", { slug, error: error instanceof Error ? error.message : String(error) });
    return Response.json({ error: "We couldn't save that. Try again." }, { status: 503 });
  }
  return Response.json({ ok: true, last4: maskPhone(parsed.e164) });
}
