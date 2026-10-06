import { WELCOME_NONCE_COOKIE } from "@healdesk/catalog";
import { cookies } from "next/headers";

import { welcomeState } from "@/lib/checkout/welcome";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /welcome/state?h=<ref>&cs=<session>: what the /welcome page shows next.
 * Under /welcome on purpose: the nonce cookie is scoped to that path, so it
 * reaches this route and nothing else on the app.
 */
export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const state = await welcomeState({
    ref: url.searchParams.get("h"),
    sessionId: url.searchParams.get("cs"),
    nonce: (await cookies()).get(WELCOME_NONCE_COOKIE)?.value ?? null,
  });
  return Response.json(state, {
    status: state.status === "unknown" ? 404 : 200,
    headers: { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" },
  });
}
