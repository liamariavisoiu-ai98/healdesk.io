import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import { INDEXNOW_ENDPOINT, INDEXNOW_KEY, indexNowPayload, sitemapLocations, submitToIndexNow } from "./indexnow";

describe("IndexNow", () => {
  it("serves the key from public/<key>.txt, whose whole content is the key", () => {
    const file = fileURLToPath(new URL(`../../public/${INDEXNOW_KEY}.txt`, import.meta.url));
    expect(readFileSync(file, "utf8").trim()).toBe(INDEXNOW_KEY);
  });

  it("builds a payload for one host and drops URLs on any other", () => {
    const payload = indexNowPayload("https://healdesk.io", [
      "https://healdesk.io/",
      "https://healdesk.io/pricing",
      "https://healdesk.io/pricing",
      "https://evil.example/",
      "not a url",
    ]);
    expect(payload).toEqual({
      host: "healdesk.io",
      key: INDEXNOW_KEY,
      keyLocation: `https://healdesk.io/${INDEXNOW_KEY}.txt`,
      urlList: ["https://healdesk.io/", "https://healdesk.io/pricing"],
    });
  });

  it("reads every <loc> from a sitemap", () => {
    const xml =
      '<?xml version="1.0"?><urlset><url><loc>https://healdesk.io/</loc></url><url><loc>https://healdesk.io/guides</loc></url></urlset>';
    expect(sitemapLocations(xml)).toEqual(["https://healdesk.io/", "https://healdesk.io/guides"]);
  });

  it("posts JSON to the shared endpoint, and sends nothing for an empty list", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 202 }));
    const payload = indexNowPayload("https://healdesk.io", ["https://healdesk.io/"]);
    expect(await submitToIndexNow(payload, fetchImpl as unknown as typeof fetch)).toBe(202);
    expect(fetchImpl).toHaveBeenCalledWith(INDEXNOW_ENDPOINT, expect.objectContaining({ method: "POST" }));
    expect(await submitToIndexNow({ ...payload, urlList: [] }, fetchImpl as unknown as typeof fetch)).toBe(204);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
