import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The website chat bubble, served at GET /widget/v1.js
 * (app/widget/v1.js/route.ts): the script the line a clinic pastes loads
 * (lib/setup/snippet.ts, WIDGET_SCRIPT_PATH). Its source is src/widget/v1.js,
 * served byte for byte.
 *
 * Static and the same for every clinic, so it holds no PHI and may be cached
 * anywhere; it names nothing until the page's data-clinic does. Cached for
 * five minutes and revalidated by its ETag, so a fix reaches every clinic's
 * site within minutes while repeat visits cost a 304. The path carries the
 * version: a change that breaks what pages expect is v2, never an edit here.
 *
 * Loaded by a <script> on the clinic's own site, so its response must cross
 * origins: Cross-Origin-Resource-Policy cross-origin for a page that sets
 * COEP, and Access-Control-Allow-Origin * for one that loads it with
 * `crossorigin` and an integrity hash. Neither lets a page read anything
 * else here: this route answers the same bytes to everyone.
 */

/** The script's bytes. src/ ships in the image beside server.js (apps/app/Dockerfile), and the standalone server runs from apps/app. */
export const WIDGET_SOURCE = readFileSync(join(process.cwd(), "src/widget/v1.js"), "utf8");

const ETAG = `"${createHash("sha256").update(WIDGET_SOURCE).digest("base64url").slice(0, 27)}"`;

export const WIDGET_HEADERS: Record<string, string> = {
  "Content-Type": "text/javascript; charset=utf-8",
  "Cache-Control": "public, max-age=300, stale-while-revalidate=86400",
  ETag: ETAG,
  "Cross-Origin-Resource-Policy": "cross-origin",
  "Access-Control-Allow-Origin": "*",
  "X-Content-Type-Options": "nosniff",
};

function matches(ifNoneMatch: string | null): boolean {
  if (!ifNoneMatch) return false;
  return ifNoneMatch.split(",").some((tag) => {
    const t = tag.trim();
    return t === "*" || t === ETAG || t === `W/${ETAG}`;
  });
}

/** The script, or a 304 when the browser already holds these bytes. */
export function widgetResponse(request: Request): Response {
  if (matches(request.headers.get("if-none-match"))) return new Response(null, { status: 304, headers: WIDGET_HEADERS });
  return new Response(WIDGET_SOURCE, { status: 200, headers: WIDGET_HEADERS });
}
