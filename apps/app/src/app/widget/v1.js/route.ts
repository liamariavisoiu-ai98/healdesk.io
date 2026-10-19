import { widgetResponse } from "@/lib/widget/script";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** GET /widget/v1.js: the website chat bubble (lib/widget/script.ts). */
export function GET(request: Request): Response {
  return widgetResponse(request);
}

export function HEAD(request: Request): Response {
  const response = widgetResponse(request);
  return new Response(null, { status: response.status, headers: response.headers });
}
