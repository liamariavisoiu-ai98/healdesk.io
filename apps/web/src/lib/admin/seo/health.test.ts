import { PRODUCTS } from "@healdesk/catalog";
import { describe, expect, test } from "vitest";

import { allPieces, piecePath } from "@/lib/content/registry";
import { INDEXNOW_KEY } from "@/lib/indexnow";
import { site } from "@/lib/site";
import { organizationLd, serializeLd, softwareApplicationLd } from "@/lib/structured-data";

import { jsonLd, metaDescription, runHealthChecks, sitemapEntries, titleOf } from "./health";

/**
 * The ten checks /admin/seo runs against the deployed site (health.ts): each
 * check on its own, with the fault it exists to find and the words it says
 * about it, and the way the fetches are made. seo.test.ts holds the whole-run
 * cases; these pin one check at a time, so a rule loosened or an id renamed
 * names itself. The network is a function from path to page.
 */

type Page = { status: number; body: string };

const pieces = allPieces();
const live = pieces.filter((piece) => piece.stage === "live");
const hidden = pieces.filter((piece) => piece.stage !== "live");

const ld = (data: Parameters<typeof serializeLd>[0]) =>
  `<script type="application/ld+json">${serializeLd(data)}</script>`;

/** A site that passes all ten, built from the site's own builders, with changes laid over it. */
function pages(overrides: Record<string, Page | null> = {}): Record<string, Page | null> {
  return {
    "/": {
      status: 200,
      body: `<title>${site.name}: ${site.category}</title><meta name="description" content="${site.description}"/>${ld([organizationLd()])}`,
    },
    "/pricing": { status: 200, body: ld(softwareApplicationLd()) },
    "/sitemap.xml": {
      status: 200,
      body: `<urlset>${["/", ...live.map((piece) => piecePath(piece))]
        .map((path) => `<url><loc>${site.url}${path}</loc><lastmod>2026-10-19</lastmod></url>`)
        .join("")}</urlset>`,
    },
    "/robots.txt": {
      status: 200,
      body: `User-Agent: *\nAllow: /\nDisallow: /admin\nSitemap: ${site.url}/sitemap.xml`,
    },
    [`/${INDEXNOW_KEY}.txt`]: { status: 200, body: `${INDEXNOW_KEY}\n` },
    "/llms.txt": { status: 200, body: `# ${site.name}\n` },
    ...Object.fromEntries(
      live.map((piece) => [piecePath(piece), { status: 200, body: "Last reviewed 19 October 2026" }]),
    ),
    ...overrides,
  };
}

/** The fetch that serves them: a path with no page is a 404, a null page is a network failure. */
function serve(table: Record<string, Page | null>, seen: { url: string; init?: RequestInit }[] = []): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen.push({ url: String(input), init });
    const page = table[new URL(String(input)).pathname];
    if (page === null) throw new TypeError("fetch failed");
    const answer = page ?? { status: 404, body: "" };
    return new Response(answer.body, { status: answer.status });
  }) as typeof fetch;
}

async function check(id: string, table: Record<string, Page | null>) {
  const found = (await runHealthChecks(serve(table))).find((c) => c.id === id);
  if (!found) throw new Error(`no check ${id}`);
  return found;
}

describe("the parsers", () => {
  test("a title or a description is read whichever way round its attributes are written, and its entities decoded", () => {
    expect(titleOf("<title>  Tom &amp; Jerry&#39;s  </title>")).toBe("Tom & Jerry's");
    expect(titleOf("<p>no title</p>")).toBeNull();
    expect(metaDescription(`<meta content="A &quot;B&quot; &lt;C&gt;" name="description">`)).toBe('A "B" <C>');
    expect(metaDescription(`<meta name='description' content='plain'>`)).toBe("plain");
    expect(metaDescription(`<meta name="keywords" content="x">`)).toBeNull();
  });

  test("JSON-LD arrays are flattened, and a block that is not JSON, or not an object, is skipped", () => {
    const html = [
      `<script type="application/ld+json">[{"@type":"A"},{"@type":"B"}]</script>`,
      `<script type="application/ld+json">{"@type":"C"}</script>`,
      `<script type="application/ld+json">"just a string"</script>`,
      `<script type="application/ld+json">{broken</script>`,
      `<script type="text/javascript">{"@type":"D"}</script>`,
    ].join("");
    expect(jsonLd(html).map((item) => item["@type"])).toEqual(["A", "B", "C"]);
  });

  test("a sitemap entry with no date reads as null, and one with no location as an empty string", () => {
    expect(sitemapEntries("<url><loc> https://x.test/a </loc></url><url><lastmod>2026-01-01</lastmod></url>")).toEqual([
      { loc: "https://x.test/a", lastmod: null },
      { loc: "", lastmod: "2026-01-01" },
    ]);
  });
});

describe("one check at a time", () => {
  test("there are ten, each with an id, a label and a verdict, and a healthy site passes them all", async () => {
    const checks = await runHealthChecks(serve(pages()));
    expect(checks.map((c) => c.id)).toEqual([
      "title",
      "description",
      "organization",
      "product",
      "sitemap",
      "robots",
      "indexnow",
      "llms",
      "live-pages",
      "drafts-hidden",
    ]);
    for (const c of checks) {
      expect(c.label, c.id).not.toBe("");
      expect(c.ok, `${c.id}: ${c.detail}`).toBe(true);
    }
    expect(new Set(checks.map((c) => c.id)).size).toBe(10);
  });

  test("title: the homepage title must name the category", async () => {
    const wrong = await check("title", pages({ "/": { status: 200, body: "<title>healdesk</title>" } }));
    expect(wrong).toMatchObject({ ok: false, detail: '"healdesk"' });
    const none = await check("title", pages({ "/": { status: 200, body: "<p>hello</p>" } }));
    expect(none).toMatchObject({ ok: false, detail: "No <title> found." });
  });

  test("description: the site's own words, and never a claim to answer every call", async () => {
    const other = await check("description", pages({ "/": { status: 200, body: `<meta name="description" content="Something else."/>` } }));
    expect(other).toMatchObject({ ok: false, detail: 'Live: "Something else."' });
    const none = await check("description", pages({ "/": { status: 200, body: "<title>x</title>" } }));
    expect(none).toMatchObject({ ok: false, detail: 'Live: "none"' });
    const good = await check("description", pages());
    expect(good).toMatchObject({ ok: true, detail: "Matches the site's description." });
    // The overclaim is caught by its own rule, not only by the text differing.
    expect(site.description).not.toMatch(/\banswers? every call\b/i);
  });

  test("organization: present, named healdesk, and without the operating company's legal name", async () => {
    const legal = { ...organizationLd(), legalName: "Viixi FZC" };
    const withLegal = await check("organization", pages({ "/": { status: 200, body: ld([legal]) } }));
    expect(withLegal).toMatchObject({ ok: false, detail: "Present but its name or legal name is off." });
    const renamed = await check("organization", pages({ "/": { status: 200, body: ld([{ ...organizationLd(), name: "Other" }]) } }));
    expect(renamed.ok).toBe(false);
    const absent = await check("organization", pages({ "/": { status: 200, body: "<title>x</title>" } }));
    expect(absent).toMatchObject({ ok: false, detail: "Not found on the homepage." });
    expect((await check("organization", pages())).detail).toBe("Present, named healdesk, no legal name.");
  });

  test("product: the offers on /pricing are the catalog's prices, in order", async () => {
    const prices = Object.values(PRODUCTS).map((p) => p.perStepMonthlyUsd);
    const app = softwareApplicationLd() as { offers: { price: number }[] };
    const wrong = { ...app, offers: app.offers.map((o, i) => (i === 0 ? { ...o, price: o.price + 1 } : o)) };
    const bad = await check("product", pages({ "/pricing": { status: 200, body: ld(wrong as never) } }));
    expect(bad).toMatchObject({ ok: false, detail: "The offers differ from the catalog." });
    const fewer = await check("product", pages({ "/pricing": { status: 200, body: ld({ ...app, offers: app.offers.slice(1) } as never) } }));
    expect(fewer.ok).toBe(false);
    const none = await check("product", pages({ "/pricing": { status: 200, body: "<p>no markup</p>" } }));
    expect(none).toMatchObject({ ok: false, detail: "No SoftwareApplication markup on /pricing." });
    expect((await check("product", pages())).detail).toBe(`${String(prices.length)} offers at the catalog's prices.`);
  });

  test("sitemap: a URL with no date, or a live page missing from it, fails and is counted", async () => {
    const [first] = live;
    expect(first).toBeDefined();
    const urls = ["/", ...live.map((p) => piecePath(p))];
    const undated = `<urlset>${urls.map((u, i) => `<url><loc>${site.url}${u}</loc>${i === 0 ? "" : "<lastmod>2026-10-19</lastmod>"}</url>`).join("")}</urlset>`;
    const noDate = await check("sitemap", pages({ "/sitemap.xml": { status: 200, body: undated } }));
    expect(noDate).toMatchObject({ ok: false, detail: `${String(urls.length)} URLs, 1 without a date, 0 live pages missing.` });
    const short = `<urlset><url><loc>${site.url}/</loc><lastmod>2026-10-19</lastmod></url></urlset>`;
    const missing = await check("sitemap", pages({ "/sitemap.xml": { status: 200, body: short } }));
    expect(missing).toMatchObject({ ok: false, detail: `1 URLs, 0 without a date, ${String(live.length)} live pages missing.` });
    const empty = await check("sitemap", pages({ "/sitemap.xml": { status: 200, body: "<urlset></urlset>" } }));
    expect(empty.ok).toBe(false);
  });

  test("robots: allows the site and names the sitemap, and a blanket Disallow fails", async () => {
    const closed = await check("robots", pages({ "/robots.txt": { status: 200, body: `User-Agent: *\nAllow: /\nDisallow: /\nSitemap: ${site.url}/sitemap.xml` } }));
    expect(closed).toMatchObject({ ok: false, detail: "Check robots.txt." });
    const noSitemap = await check("robots", pages({ "/robots.txt": { status: 200, body: "User-Agent: *\nAllow: /" } }));
    expect(noSitemap.ok).toBe(false);
    const noAllow = await check("robots", pages({ "/robots.txt": { status: 200, body: `User-Agent: *\nSitemap: ${site.url}/sitemap.xml` } }));
    expect(noAllow.ok).toBe(false);
    // /admin is disallowed on a healthy site, and that is not a blanket block.
    expect((await check("robots", pages())).detail).toBe("Allows the site and names the sitemap.");
  });

  test("indexnow: the key file answers 200 with the key, and a wrong body or a 404 fails", async () => {
    const wrongKey = await check("indexnow", pages({ [`/${INDEXNOW_KEY}.txt`]: { status: 200, body: "not-the-key" } }));
    expect(wrongKey).toMatchObject({ ok: false, detail: "HTTP 200." });
    const gone = await check("indexnow", pages({ [`/${INDEXNOW_KEY}.txt`]: { status: 404, body: "" } }));
    expect(gone).toMatchObject({ ok: false, detail: "HTTP 404." });
  });

  test("llms: served with the site's name as its first heading", async () => {
    const wrong = await check("llms", pages({ "/llms.txt": { status: 200, body: "# Somebody else\n" } }));
    expect(wrong).toMatchObject({ ok: false, detail: "HTTP 200." });
    expect((await check("llms", pages({ "/llms.txt": { status: 500, body: "" } }))).ok).toBe(false);
  });

  test("live pages: each answers 200 and prints its review date, and the ones that do not are named", async () => {
    const [a] = live;
    const noDate = await check("live-pages", pages({ [piecePath(a!)]: { status: 200, body: "A page with no date" } }));
    expect(noDate).toMatchObject({ ok: false, detail: `Not answering: ${piecePath(a!)}` });
    const gone = await check("live-pages", pages({ [piecePath(a!)]: { status: 404, body: "" } }));
    expect(gone.ok).toBe(false);
    const down = await check("live-pages", pages({ [piecePath(a!)]: null }));
    expect(down.ok).toBe(false);
    expect((await check("live-pages", pages())).detail).toBe(`${String(live.length)} live pages answer.`);
  });

  test("drafts: a piece that is not live must 404, and one that answers is named as public", async () => {
    if (hidden.length === 0) return; // every piece is live: nothing to leak
    const [d] = hidden;
    const leaked = await check("drafts-hidden", pages({ [piecePath(d!)]: { status: 200, body: "<p>draft</p>" } }));
    expect(leaked).toMatchObject({ ok: false, detail: `Public: ${piecePath(d!)}` });
    expect((await check("drafts-hidden", pages())).detail).toBe(`${String(hidden.length)} drafts return 404.`);
    // An unreachable draft is hidden, not leaked.
    expect((await check("drafts-hidden", pages({ [piecePath(d!)]: null }))).ok).toBe(true);
  });
});

describe("how the site is read", () => {
  test("a path that does not answer is no verdict (null), and says which path and from where", async () => {
    const table = pages({ "/": null, "/pricing": null, "/sitemap.xml": null, "/robots.txt": null, [`/${INDEXNOW_KEY}.txt`]: null, "/llms.txt": null });
    const checks = await runHealthChecks(serve(table));
    const byId = Object.fromEntries(checks.map((c) => [c.id, c]));
    for (const id of ["title", "description", "organization", "product", "sitemap", "robots", "indexnow", "llms"]) {
      expect(byId[id]!.ok, id).toBeNull();
      expect(byId[id]!.detail, id).toContain(`did not answer from ${site.url}.`);
    }
    expect(byId.title!.detail).toBe(`/ did not answer from ${site.url}.`);
    expect(byId.product!.detail).toBe(`/pricing did not answer from ${site.url}.`);
  });

  test("only the site's own origin is fetched, uncached, with a deadline and an identifying agent", async () => {
    const seen: { url: string; init?: RequestInit }[] = [];
    await runHealthChecks(serve(pages(), seen));
    expect(seen.length).toBe(6 + live.length + hidden.length);
    for (const { url, init } of seen) {
      expect(new URL(url).origin, url).toBe(new URL(site.url).origin);
      expect(init?.cache).toBe("no-store");
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      expect((init?.headers as Record<string, string>)["user-agent"]).toBe("healdesk-admin-seo-check");
    }
  });

  test("a page that is not a 200 has its body ignored, whatever it says", async () => {
    // A 404 page that happens to print the homepage's title must not pass the title check.
    const table = pages({ "/": { status: 404, body: `<title>${site.name}: ${site.category}</title>` } });
    const title = await check("title", table);
    expect(title).toMatchObject({ ok: false, detail: "No <title> found." });
  });
});
