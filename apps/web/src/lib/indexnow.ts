/**
 * IndexNow: telling search engines a URL changed, instead of waiting for
 * their crawlers to notice.
 *
 * One submission to the shared endpoint reaches every participating engine:
 * Amazon, Bing, Naver, Seznam, Yandex and Yep (indexnow.org/faq, read 14
 * October 2026). Bing's AI Performance report recommends it for keeping AI
 * answers current. Google does not take IndexNow; it reads the sitemap's
 * `lastModified` dates instead (app/sitemap.ts).
 *
 * ## The key is public by design
 *
 * IndexNow proves a submitter controls the host by fetching the key from a
 * file on that host: `public/<key>.txt`, whose whole content is the key. It
 * is not a secret, it grants nothing but the right to suggest URLs for
 * crawling, and it lives in the repo so the file and the constant cannot
 * disagree (`indexnow.test.ts` checks them).
 *
 * ## Who calls it
 *
 * `.github/workflows/indexnow.yml` runs `scripts/indexnow.ts` once after
 * every successful production deployment, with every URL in the live
 * sitemap. Nothing on the request path calls it.
 */

export const INDEXNOW_KEY = "efe7223f3eb6aa8926367180bd12a2f4";

export const INDEXNOW_ENDPOINT = "https://api.indexnow.org/indexnow";

/** The protocol's limit per request. */
export const INDEXNOW_MAX_URLS = 10_000;

export type IndexNowPayload = {
  host: string;
  key: string;
  keyLocation: string;
  urlList: string[];
};

/**
 * The request body for a set of URLs on one host. URLs on any other host are
 * dropped: the protocol rejects the whole batch if one URL is off-host.
 */
export function indexNowPayload(origin: string, urls: readonly string[]): IndexNowPayload {
  const { host } = new URL(origin);
  const onHost = urls.filter((url) => {
    try {
      return new URL(url).host === host;
    } catch {
      return false;
    }
  });
  return {
    host,
    key: INDEXNOW_KEY,
    keyLocation: `${new URL(origin).origin}/${INDEXNOW_KEY}.txt`,
    urlList: [...new Set(onHost)].slice(0, INDEXNOW_MAX_URLS),
  };
}

/** Every `<loc>` in a sitemap document. */
export function sitemapLocations(xml: string): string[] {
  return [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((match) => match[1] ?? "").filter(Boolean);
}

/**
 * Submit and return the HTTP status. 200 and 202 both mean accepted; 202
 * means the key is still being verified, which is normal on a first call.
 */
export async function submitToIndexNow(
  payload: IndexNowPayload,
  fetchImpl: typeof fetch = fetch,
): Promise<number> {
  if (payload.urlList.length === 0) return 204;
  const response = await fetchImpl(INDEXNOW_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify(payload),
  });
  return response.status;
}
