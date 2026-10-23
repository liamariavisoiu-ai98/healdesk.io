import { NextResponse } from "next/server";

import { placeFromHeaders } from "@/lib/visitor-place";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/visitor-place: the place the visitor's request came from, for the
 * lock screen's weather (lib/visitor-place.ts).
 *
 * A route of its own rather than a header read in the page, because reading
 * a request header would turn the whole homepage dynamic and put its cache
 * behind every visit. `private, no-store` keeps a shared cache from showing
 * one visitor's town to the next. `{ place: null }` means the lookup found
 * nothing, and the screen keeps saying "Current Location".
 */
export async function GET(request: Request): Promise<NextResponse> {
  const place = placeFromHeaders(request.headers);
  return NextResponse.json({ place }, { headers: { "cache-control": "private, no-store" } });
}
