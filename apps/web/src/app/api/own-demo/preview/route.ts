import { fetchBrandPreview, parseWebsiteUrl, ScrapeError, type BrandPreview } from "@/lib/demo/scrape";
import { clientKey, rateLimit } from "@/lib/rate-limit";

/**
 * POST /api/own-demo/preview, what the homepage's "See it in your own
 * branding" shows of a visitor's own site before it asks for an email. Body:
 *
 *   { "domain": "peachystudio.com" }
 *
 * Answers 200 with `{ host, name, logoUrl, image, color }`, each but `host`
 * null when the site did not give it up: a site that cannot be read still
 * gets a preview (the window falls back to the name on a neutral page), so
 * the form is never blocked by it. The logo and the picture come back as
 * `data:` URIs, fetched here through the crawler's address checks, so the
 * visitor's browser never contacts the clinic's site and the homepage's
 * Content-Security-Policy does not have to open to every https image.
 *
 * It is not a demo build: one request for the front page, no model call, no
 * demo row, no email, nothing kept (the Privacy page says so). That is why it
 * can answer while the visitor watches a progress line, inside eight seconds,
 * and why its limits are looser than /api/own-demo's: ten an hour from one
 * address and six an hour for one website, per instance, which is what keeps
 * the field from being a way to hit somebody else's site.
 *
 * 422 is for an address that is not a public website (a typo, a private
 * address, a name that does not resolve): the visitor is told at once, since
 * the build would only fail on it later. 429 means the limit, and the page
 * treats it like any other failure to preview.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 15;

const HOUR_MS = 60 * 60 * 1000;
const IP_LIMIT = 10;
const HOST_LIMIT = 6;

const NO_STORE = { "Cache-Control": "no-store" } as const;

function refuse(status: number, error: string, extra: Record<string, unknown> = {}, retryAfter?: number): Response {
  return Response.json(
    { error, ...extra },
    { status, headers: { ...NO_STORE, ...(retryAfter ? { "Retry-After": String(retryAfter) } : {}) } },
  );
}

export async function POST(request: Request): Promise<Response> {
  const perIp = await rateLimit(`own-demo-preview:ip:${clientKey(request.headers)}`, IP_LIMIT, HOUR_MS);
  if (!perIp.ok) return refuse(429, "Too many previews. Try again in a while.", {}, perIp.retryAfter);

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return refuse(400, "Invalid request.");
  }

  let website: URL;
  try {
    website = parseWebsiteUrl(typeof body.domain === "string" ? body.domain.trim().slice(0, 300) : "");
  } catch (error) {
    return refuse(422, (error as Error).message, { field: "domain" });
  }
  const host = website.hostname.replace(/^www\./, "").toLowerCase();

  const perHost = await rateLimit(`own-demo-preview:host:${host}`, HOST_LIMIT, HOUR_MS);
  if (!perHost.ok) return refuse(429, "Too many previews of that website. Try again in a while.", {}, perHost.retryAfter);

  let preview: BrandPreview;
  try {
    preview = await fetchBrandPreview(website.href);
  } catch (error) {
    if (error instanceof ScrapeError) return refuse(422, error.message, { field: "domain" });
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOTFOUND" || code === "ENODATA") {
      return refuse(422, "We couldn't find a website at that address. Check the spelling.", { field: "domain" });
    }
    // Anything else (a resolver hiccup, a bug) is ours, not the visitor's: show the fallback.
    console.warn("[healdesk] own-demo preview failed", { host, error: error instanceof Error ? error.message : String(error) });
    preview = { host, name: null, logoUrl: null, image: null, color: null };
  }
  return Response.json(preview, { headers: NO_STORE });
}
