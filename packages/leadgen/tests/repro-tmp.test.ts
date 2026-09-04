import { describe, expect, test } from "vitest";
import { crawlSites, type CrawlResult, type CrawlTarget } from "../src/enrich/crawl.ts";

const targets = (n: number): CrawlTarget[] =>
  Array.from({ length: n }, (_, i) => ({ clinicId: `c${i}`, domain: `clinic${i}.com` }));
const ok = (batch: CrawlTarget[]): CrawlResult[] =>
  batch.map((t) => ({ clinicId: t.clinicId, domain: t.domain, text: "content", links: [], pagesFetched: 1 }));
const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("repro", () => {
  test("sequential: last batch throws", async () => {
    let last: CrawlResult[] = [];
    let writes = 0;
    const out = await crawlSites(targets(30), {
      token: "x", batchSize: 10, concurrency: 1,
      runBatch: async (b) => {
        if (b[0]!.domain === "clinic20.com") throw new Error("apify 500");
        return ok(b);
      },
      onBatch: async (all) => { writes += 1; last = [...all]; },
    });
    console.log("SEQ returned", out.length, "errors", out.filter(r=>r.error).length,
      "| last write", last.length, "errors", last.filter(r=>r.error).length, "| writes", writes);
    expect(last.length).toBe(out.length);
  });

  test("concurrent: failing batch settles last", async () => {
    let last: CrawlResult[] = [];
    const out = await crawlSites(targets(30), {
      token: "x", batchSize: 10, concurrency: 2,
      runBatch: async (b) => {
        if (b[0]!.domain === "clinic20.com") { await settle(50); throw new Error("apify 500"); }
        await settle(5);
        return ok(b);
      },
      onBatch: async (all) => { last = [...all]; },
    });
    console.log("CONC returned", out.length, "errors", out.filter(r=>r.error).length,
      "| last write", last.length, "errors", last.filter(r=>r.error).length);
    expect(last.length).toBe(out.length);
  });

  test("failing batch NOT last", async () => {
    let last: CrawlResult[] = [];
    const out = await crawlSites(targets(30), {
      token: "x", batchSize: 10, concurrency: 2,
      runBatch: async (b) => {
        if (b[0]!.domain === "clinic10.com") { await settle(5); throw new Error("apify 500"); }
        await settle(50);
        return ok(b);
      },
      onBatch: async (all) => { last = [...all]; },
    });
    console.log("NOTLAST returned", out.length, "errors", out.filter(r=>r.error).length,
      "| last write", last.length, "errors", last.filter(r=>r.error).length);
    expect(last.length).toBe(out.length);
  });
});
