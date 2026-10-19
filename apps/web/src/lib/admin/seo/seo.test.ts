import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { allPieces, piecePath } from "@/lib/content/registry";
import { INDEXNOW_KEY } from "@/lib/indexnow";
import { FakeSheets, __setSheetsClientForTests } from "@/lib/sheets/client";
import { __resetSheetSchemaForTests, AI_PANEL_RUNS, SEO_STEP_TICKS } from "@/lib/sheets/schema";
import { site } from "@/lib/site";
import { serializeLd, organizationLd, softwareApplicationLd } from "@/lib/structured-data";

import { jsonLd, metaDescription, runHealthChecks, sitemapEntries, titleOf } from "./health";
import { LAUNCH_PROMISES } from "./launch";
import { cleanSources, enginesCiting, monthlyShare, panelGrid, type PanelRun } from "./panel";
import { roadmapBounds, roadmapPosition, SEO_ROADMAP } from "./roadmap";
import { OWNER_STEPS } from "./steps";
import { readSeoLog, recordPanelRun, recordStepTick } from "./store";

/**
 * /admin/seo's logic: the AI panel's two-of-three rule, the health checks'
 * parsing against pages built from the site's own builders, the data lists'
 * invariants, and the Sheet writes against the in-memory fake.
 */

const run = (ranOn: string, hit: boolean, engine = "chatgpt", questionId = "best-med-spa"): PanelRun => ({
  ranOn,
  engine,
  questionId,
  named: hit,
  cited: false,
});

describe("the AI panel", () => {
  test("a question is cited only when two of its last three runs hit", () => {
    const grid = panelGrid([run("2026-10-01", true), run("2026-10-08", false), run("2026-10-15", true)]);
    expect(grid["best-med-spa"]?.chatgpt).toBe("cited");
    expect(grid["best-med-spa"]?.perplexity).toBe("none");
    expect(enginesCiting(grid)).toBe(1);
  });

  test("only the last three runs count, newest first", () => {
    const grid = panelGrid([run("2026-09-01", true), run("2026-09-08", true), run("2026-10-01", false), run("2026-10-08", false), run("2026-10-15", true)]);
    expect(grid["best-med-spa"]?.chatgpt).toBe("not-cited");
  });

  test("one hit in fewer than three runs is too few to call", () => {
    expect(panelGrid([run("2026-10-01", true)])["best-med-spa"]?.chatgpt).toBe("too-few");
    expect(panelGrid([run("2026-10-01", false), run("2026-10-02", false)])["best-med-spa"]?.chatgpt).toBe("too-few");
  });

  test("the monthly share is hits over runs, oldest month first", () => {
    expect(monthlyShare([run("2026-11-02", false), run("2026-10-01", true), run("2026-10-02", false), run("bad", true)])).toEqual([
      { month: "2026-10", runs: 2, share: 0.5 },
      { month: "2026-11", runs: 1, share: 0 },
    ]);
  });

  test("only http(s) URLs reach the Sheet, at most twenty", () => {
    expect(cleanSources("https://a.example/x  not a url\njavascript:alert(1) http://b.example")).toBe("https://a.example/x http://b.example/");
    expect(cleanSources(42)).toBe("");
    expect(cleanSources(Array.from({ length: 30 }, (_, i) => `https://e.example/${String(i)}`).join(" ")).split(" ")).toHaveLength(20);
  });
});

describe("the data lists", () => {
  test("step ids are unique and every step links somewhere real", () => {
    const ids = OWNER_STEPS.map((step) => step.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const step of OWNER_STEPS) expect(step.href).toMatch(/^(https:\/\/|#[a-z-]+$)/);
  });

  test("launch promises are unique, and none is marked on while it still says what is left", () => {
    const ids = LAUNCH_PROMISES.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const item of LAUNCH_PROMISES) expect(item.left.length).toBeGreaterThan(0);
  });

  test("the roadmap runs forward and today's line is clamped onto it", () => {
    for (const row of SEO_ROADMAP) expect(row.start <= row.end).toBe(true);
    const bounds = roadmapBounds();
    expect(roadmapPosition(SEO_ROADMAP[0]!.start, bounds)).toBe(0);
    expect(roadmapPosition("2030-01-01", bounds)).toBe(1);
    expect(roadmapPosition("2020-01-01", bounds)).toBe(0);
  });
});

describe("the health parsers", () => {
  const html = `<html><head><title>healdesk: AI receptionist for elective clinics</title>
    <meta name="description" content="A &amp; B"/>
    <script type="application/ld+json">${serializeLd([organizationLd()])}</script>
    <script type="application/ld+json">{not json</script></head></html>`;

  test("read the title, the description and every JSON-LD object", () => {
    expect(titleOf(html)).toBe("healdesk: AI receptionist for elective clinics");
    expect(metaDescription(html)).toBe("A & B");
    expect(jsonLd(html).map((item) => item["@type"])).toEqual(["Organization"]);
  });

  test("read the sitemap's locations and dates", () => {
    const xml = "<urlset><url><loc>https://healdesk.io/</loc><lastmod>2026-10-19</lastmod></url><url><loc>https://healdesk.io/x</loc></url></urlset>";
    expect(sitemapEntries(xml)).toEqual([
      { loc: "https://healdesk.io/", lastmod: "2026-10-19" },
      { loc: "https://healdesk.io/x", lastmod: null },
    ]);
  });
});

describe("the health checks", () => {
  const pieces = allPieces();
  const live = pieces.filter((piece) => piece.stage === "live");

  function fakeSite(overrides: Record<string, { status: number; body: string }> = {}): typeof fetch {
    const ld = (data: Parameters<typeof serializeLd>[0]) => `<script type="application/ld+json">${serializeLd(data)}</script>`;
    const pages: Record<string, { status: number; body: string }> = {
      "/": {
        status: 200,
        body: `<title>${site.name}: ${site.category}</title><meta name="description" content="${site.description}"/>${ld([organizationLd()])}`,
      },
      "/pricing": { status: 200, body: ld(softwareApplicationLd()) },
      "/sitemap.xml": {
        status: 200,
        body: `<urlset>${["/", ...live.map((piece) => piecePath(piece))].map((path) => `<url><loc>${site.url}${path}</loc><lastmod>2026-10-19</lastmod></url>`).join("")}</urlset>`,
      },
      "/robots.txt": { status: 200, body: `User-Agent: *\nAllow: /\nDisallow: /admin\nSitemap: ${site.url}/sitemap.xml` },
      [`/${INDEXNOW_KEY}.txt`]: { status: 200, body: INDEXNOW_KEY },
      "/llms.txt": { status: 200, body: `# ${site.name}\n` },
      ...Object.fromEntries(live.map((piece) => [piecePath(piece), { status: 200, body: "Last reviewed 19 October 2026" }])),
      ...overrides,
    };
    return (async (input: RequestInfo | URL) => {
      const page = pages[new URL(String(input)).pathname] ?? { status: 404, body: "" };
      return new Response(page.body, { status: page.status });
    }) as typeof fetch;
  }

  test("all ten pass against a site built from the site's own builders", async () => {
    const checks = await runHealthChecks(fakeSite());
    expect(checks).toHaveLength(10);
    expect(checks.filter((check) => check.ok !== true)).toEqual([]);
  });

  test("an overclaiming description and a public draft fail", async () => {
    const draft = pieces.find((piece) => piece.stage !== "live");
    const checks = await runHealthChecks(
      fakeSite({
        "/": { status: 200, body: `<title>healdesk</title><meta name="description" content="AYA answers every call."/>` },
        ...(draft ? { [piecePath(draft)]: { status: 200, body: "" } } : {}),
      }),
    );
    const byId = Object.fromEntries(checks.map((check) => [check.id, check.ok]));
    expect(byId.title).toBe(false);
    expect(byId.description).toBe(false);
    expect(byId.organization).toBe(false);
    if (draft) expect(byId["drafts-hidden"]).toBe(false);
  });

  test("a site that does not answer reads as no answer, not as a failure", async () => {
    const checks = await runHealthChecks((async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch);
    expect(checks.find((check) => check.id === "title")?.ok).toBeNull();
    expect(checks.find((check) => check.id === "llms")?.ok).toBeNull();
  });
});

describe("the Sheet log", () => {
  let sheets: FakeSheets;

  beforeEach(() => {
    sheets = new FakeSheets();
    __setSheetsClientForTests(sheets);
    __resetSheetSchemaForTests();
  });

  afterEach(() => {
    __setSheetsClientForTests(null);
    __resetSheetSchemaForTests();
  });

  test("the newest tick for a step is its state", async () => {
    const step = OWNER_STEPS[0]!.id;
    expect(await recordStepTick(step, true, "owner@healdesk.io", new Date("2026-10-19T08:00:00Z"))).toEqual({ ok: true });
    expect(await recordStepTick(step, false, "owner@healdesk.io", new Date("2026-10-19T09:00:00Z"))).toEqual({ ok: true });
    const log = await readSeoLog();
    expect(log.ok && log.ticks[step]).toBe(false);
    expect(sheets.tabs.get(SEO_STEP_TICKS.title)?.length).toBe(3);
  });

  test("an unknown step or engine is refused before the Sheet is touched", async () => {
    expect((await recordStepTick("not-a-step", true, "owner@healdesk.io")).ok).toBe(false);
    expect((await recordPanelRun({ engine: "bard", questionId: "cost", named: true, cited: false, sources: "" }, "owner@healdesk.io")).ok).toBe(false);
    expect(sheets.calls.filter((call) => call.startsWith("appendRows"))).toEqual([]);
  });

  test("a panel run is kept with only its URLs and read back into the grid", async () => {
    const outcome = await recordPanelRun(
      { engine: "perplexity", questionId: "cost", named: true, cited: true, sources: "https://healdesk.io/pricing some words", ranOn: "2026-10-19" },
      "owner@healdesk.io",
    );
    expect(outcome).toEqual({ ok: true });
    const row = sheets.tabs.get(AI_PANEL_RUNS.title)?.[1];
    expect(row?.slice(1, 7)).toEqual(["2026-10-19", "perplexity", "cost", true, true, "https://healdesk.io/pricing"]);
    const log = await readSeoLog();
    expect(log.ok && log.runs).toEqual([{ ranOn: "2026-10-19", engine: "perplexity", questionId: "cost", named: true, cited: true }]);
  });
});
