import { demoBuildElapsedMs, demoBuildState, getDemoSession, isDemoSlug } from "@/lib/demo/sessions";

/**
 * GET /api/demo/[slug]/status, how far a demo's build has got.
 *
 * Asked every few seconds by the homepage's "See it in your own branding"
 * window after "Send it to me" (components/OwnBranding.tsx), so a visitor
 * who stays on, or comes back to, the homepage sees the same progress as the
 * demo's own page in the tab it opened (lib/demo/build-progress.ts). Answers
 * the state and how long the build has run, and nothing about the demo
 * itself: the slug is the key to the demo, and whoever holds it can open the
 * page anyway.
 *
 * A read is the same cached row the demo page reads (lib/demo/sessions.ts),
 * so polling costs the Sheet at most one read a minute per instance.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: Request, ctx: { params: Promise<{ slug: string }> }): Promise<Response> {
  const { slug } = await ctx.params;
  const session = isDemoSlug(slug) ? await getDemoSession(slug) : null;
  if (!session) return Response.json({ error: "Demo not found." }, { status: 404, headers: { "Cache-Control": "no-store" } });
  const now = Date.now();
  return Response.json(
    { state: demoBuildState(session, now), elapsedMs: demoBuildElapsedMs(session, now) },
    { headers: { "Cache-Control": "no-store" } },
  );
}
