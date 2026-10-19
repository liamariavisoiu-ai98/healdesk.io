import { indexNowPayload, sitemapLocations, submitToIndexNow } from "../src/lib/indexnow";

/**
 * Send every URL in the live sitemap to IndexNow, once:
 *
 *   npm run indexnow -w @healdesk/web
 *
 * SITE_URL picks the origin (default https://healdesk.io). Run by
 * .github/workflows/indexnow.yml after each production deployment; safe to
 * run by hand, since a resubmitted URL is simply crawled again.
 */
async function main(): Promise<void> {
  const origin = (process.env.SITE_URL ?? "https://healdesk.io").replace(/\/+$/, "");
  const response = await fetch(`${origin}/sitemap.xml`, { cache: "no-store" });
  if (!response.ok) throw new Error(`GET ${origin}/sitemap.xml returned ${String(response.status)}`);
  const urls = sitemapLocations(await response.text());

  const key = await fetch(`${origin}/${indexNowPayload(origin, []).key}.txt`, { cache: "no-store" });
  if (!key.ok) throw new Error(`The IndexNow key file is not reachable on ${origin} (${String(key.status)})`);

  const payload = indexNowPayload(origin, urls);
  const status = await submitToIndexNow(payload);
  console.log(`IndexNow: ${String(payload.urlList.length)} URLs on ${payload.host}, HTTP ${String(status)}`);
  if (status !== 200 && status !== 202 && status !== 204) process.exit(1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
