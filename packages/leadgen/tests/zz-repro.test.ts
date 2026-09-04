import { describe, expect, test } from "vitest";
import { crawlSites, type CrawlResult, type CrawlTarget } from "/Users/liamariavisoiu/projects/healdesk.io/packages/leadgen/src/enrich/crawl.ts";

const targets = (n: number): CrawlTarget[] =>
  Array.from({ length: n }, (_, i) => ({ clinicId: `c${i}`, domain: `clinic${i}.com` }));
const ok = (b: CrawlTarget[]): CrawlResult[] =>
  b.map((t) => ({ clinicId: t.clinicId, domain: t.domain, text: "hi", links: [], pagesFetched: 1 }));
const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("repro", () => {
  test("last-completing batch is the failing one", async () => {
    let lastWriteLen = -1;
    let writeCount = 0;
    const out = await crawlSites(targets(100), {
      token: "x",
      batchSize: 10,
      concurrency: 8,
      runBatch: async (b) => {
        // batch index 9 == clinic90.com; make it slow so it finishes last
        if (b[0]!.domain === "clinic90.com") {
          await settle(60);
          throw new Error("apify 500");
        }
        await settle(1);
        return ok(b);
      },
      onBatch: async (all) => {
        writeCount += 1;
        lastWriteLen = all.length;
      },
    });
    console.log("in-memory:", out.length, "last write:", lastWriteLen, "writes:", writeCount);
    console.log("error rows in memory:", out.filter((r) => r.error).length);
    expect({mem: out.length, lastWrite: lastWriteLen, writes: writeCount, errs: out.filter((r)=>r.error).length}).toEqual("SHOW");
  });
});
