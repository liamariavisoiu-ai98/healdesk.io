import { PRODUCTS } from "@healdesk/catalog";

import { allPieces, piecePath } from "@/lib/content/registry";
import { INDEXNOW_KEY } from "@/lib/indexnow";
import { site } from "@/lib/site";

/**
 * Ten checks against the public site as search and AI engines see it,
 * run each time /admin/seo opens. They fetch only the site's own origin
 * (`site.url`, the production domain unless NEXT_PUBLIC_SITE_URL says
 * otherwise), so they check what is deployed, not what is in this commit,
 * and store nothing.
 *
 * The parsing is pure and exported, so the tests feed it HTML rather than
 * the network.
 */

export type HealthCheck = { id: string; label: string; ok: boolean | null; detail: string };

type Page = { status: number; body: string } | null;

const TIMEOUT_MS = 8000;

async function get(path: string, fetchImpl: typeof fetch): Promise<Page> {
  try {
    const response = await fetchImpl(new URL(path, site.url).toString(), {
      cache: "no-store",
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { "user-agent": "healdesk-admin-seo-check" },
    });
    return { status: response.status, body: response.status === 200 ? await response.text() : "" };
  } catch {
    return null;
  }
}

export function titleOf(html: string): string | null {
  const match = /<title[^>]*>([^<]*)<\/title>/i.exec(html);
  return match ? decode(match[1] ?? "").trim() : null;
}

export function metaDescription(html: string): string | null {
  const match = /<meta[^>]+name=["']description["'][^>]*content=["']([^"']*)["']/i.exec(html)
    ?? /<meta[^>]+content=["']([^"']*)["'][^>]*name=["']description["']/i.exec(html);
  return match ? decode(match[1] ?? "").trim() : null;
}

/** Every JSON-LD object on the page, flattened out of arrays; unparseable blocks are skipped. */
export function jsonLd(html: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const match of html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const parsed: unknown = JSON.parse(match[1] ?? "");
      for (const item of Array.isArray(parsed) ? parsed : [parsed]) {
        if (item && typeof item === "object") out.push(item as Record<string, unknown>);
      }
    } catch {
      // skipped
    }
  }
  return out;
}

export function sitemapEntries(xml: string): { loc: string; lastmod: string | null }[] {
  return [...xml.matchAll(/<url>([\s\S]*?)<\/url>/g)].map((match) => {
    const block = match[1] ?? "";
    return {
      loc: /<loc>\s*([^<\s]+)\s*<\/loc>/.exec(block)?.[1] ?? "",
      lastmod: /<lastmod>\s*([^<\s]+)\s*<\/lastmod>/.exec(block)?.[1] ?? null,
    };
  });
}

function decode(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&#x27;|&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

const unreachable = (id: string, label: string, path: string): HealthCheck => ({
  id,
  label,
  ok: null,
  detail: `${path} did not answer from ${site.url}.`,
});

export async function runHealthChecks(fetchImpl: typeof fetch = fetch): Promise<HealthCheck[]> {
  const pieces = allPieces();
  const live = pieces.filter((piece) => piece.stage === "live");
  const hidden = pieces.filter((piece) => piece.stage !== "live");

  const [home, pricing, sitemap, robots, key, llms, livePages, hiddenPages] = await Promise.all([
    get("/", fetchImpl),
    get("/pricing", fetchImpl),
    get("/sitemap.xml", fetchImpl),
    get("/robots.txt", fetchImpl),
    get(`/${INDEXNOW_KEY}.txt`, fetchImpl),
    get("/llms.txt", fetchImpl),
    Promise.all(live.map((piece) => get(piecePath(piece), fetchImpl))),
    Promise.all(hidden.map((piece) => get(piecePath(piece), fetchImpl))),
  ]);

  const checks: HealthCheck[] = [];

  if (!home) checks.push(unreachable("title", "Homepage title names the category", "/"));
  else {
    const title = titleOf(home.body) ?? "";
    checks.push({
      id: "title",
      label: "Homepage title names the category",
      ok: /AI receptionist/i.test(title),
      detail: title ? `"${title}"` : "No <title> found.",
    });
  }

  if (!home) checks.push(unreachable("description", "One description, no coverage overclaim", "/"));
  else {
    const description = metaDescription(home.body) ?? "";
    const ok = description === site.description && !/\banswers? every call\b/i.test(description);
    checks.push({
      id: "description",
      label: "One description, no coverage overclaim",
      ok,
      detail: ok ? "Matches the site's description." : `Live: "${description || "none"}"`,
    });
  }

  if (!home) checks.push(unreachable("organization", "Organization markup", "/"));
  else {
    const org = jsonLd(home.body).find((item) => item["@type"] === "Organization");
    const ok = !!org && org.name === site.name && !("legalName" in org);
    checks.push({
      id: "organization",
      label: "Organization markup",
      ok,
      detail: org ? (ok ? "Present, named healdesk, no legal name." : "Present but its name or legal name is off.") : "Not found on the homepage.",
    });
  }

  if (!pricing) checks.push(unreachable("product", "Prices in the markup match checkout", "/pricing"));
  else {
    const app = jsonLd(pricing.body).find((item) => item["@type"] === "SoftwareApplication");
    const offers = Array.isArray(app?.offers) ? (app.offers as { price?: unknown }[]) : [];
    const expected = Object.values(PRODUCTS).map((product) => product.perStepMonthlyUsd);
    const ok = offers.length === expected.length && offers.every((offer, i) => offer.price === expected[i]);
    checks.push({
      id: "product",
      label: "Prices in the markup match checkout",
      ok: app ? ok : false,
      detail: app ? (ok ? `${String(offers.length)} offers at the catalog's prices.` : "The offers differ from the catalog.") : "No SoftwareApplication markup on /pricing.",
    });
  }

  if (!sitemap) checks.push(unreachable("sitemap", "Sitemap lists real dates and every live page", "/sitemap.xml"));
  else {
    const entries = sitemapEntries(sitemap.body);
    const undated = entries.filter((entry) => !entry.lastmod).length;
    const locs = new Set(entries.map((entry) => new URL(entry.loc, site.url).pathname));
    const missing = live.filter((piece) => !locs.has(piecePath(piece))).length;
    checks.push({
      id: "sitemap",
      label: "Sitemap lists real dates and every live page",
      ok: entries.length > 0 && undated === 0 && missing === 0,
      detail: `${String(entries.length)} URLs, ${String(undated)} without a date, ${String(missing)} live pages missing.`,
    });
  }

  if (!robots) checks.push(unreachable("robots", "Robots open to search crawlers", "/robots.txt"));
  else {
    const blocksAll = /^Disallow:\s*\/\s*$/im.test(robots.body);
    const ok = /^Allow:\s*\/\s*$/im.test(robots.body) && /^Sitemap:/im.test(robots.body) && !blocksAll;
    checks.push({ id: "robots", label: "Robots open to search crawlers", ok, detail: ok ? "Allows the site and names the sitemap." : "Check robots.txt." });
  }

  checks.push(
    !key
      ? unreachable("indexnow", "IndexNow key file reachable", `/${INDEXNOW_KEY}.txt`)
      : { id: "indexnow", label: "IndexNow key file reachable", ok: key.status === 200 && key.body.trim() === INDEXNOW_KEY, detail: `HTTP ${String(key.status)}.` },
  );

  checks.push(
    !llms
      ? unreachable("llms", "llms.txt served", "/llms.txt")
      : { id: "llms", label: "llms.txt served", ok: llms.status === 200 && llms.body.startsWith(`# ${site.name}`), detail: `HTTP ${String(llms.status)}.` },
  );

  const liveFailures = live.filter((_, i) => {
    const page = livePages[i];
    return !page || page.status !== 200 || !page.body.includes("Last reviewed");
  });
  checks.push({
    id: "live-pages",
    label: "Every live page answers, with its review date",
    ok: liveFailures.length === 0,
    detail:
      liveFailures.length === 0
        ? `${String(live.length)} live pages answer.`
        : `Not answering: ${liveFailures.map((piece) => piecePath(piece)).join(", ")}`,
  });

  const leaked = hidden.filter((_, i) => hiddenPages[i]?.status === 200);
  checks.push({
    id: "drafts-hidden",
    label: "Drafts stay unpublished",
    ok: leaked.length === 0,
    detail: leaked.length === 0 ? `${String(hidden.length)} drafts return 404.` : `Public: ${leaked.map((piece) => piecePath(piece)).join(", ")}`,
  });

  return checks;
}
