import { describe, expect, test } from "vitest";

import { crawlSites, type CrawlResult, type CrawlTarget } from "../src/enrich/crawl.ts";

/**
 * The orchestration, without Apify.
 *
 * Everything here is about a run that is about to cost real money over ~4,100
 * domains: whether the cheap-failure guard still bites once batches run
 * concurrently, whether the checkpoint can be corrupted by two writers, and
 * whether one failing batch can take the rest down. None of that is observable
 * from a green typecheck, and none of it was testable before the seam.
 */

const targets = (n: number): CrawlTarget[] =>
  Array.from({ length: n }, (_, i) => ({
    clinicId: `c${i}`,
    domain: `clinic${i}.com`,
  }));

const ok = (batch: CrawlTarget[]): CrawlResult[] =>
  batch.map((t) => ({
    clinicId: t.clinicId,
    domain: t.domain,
    text: "content",
    links: [],
    pagesFetched: 1,
  }));

const dead = (batch: CrawlTarget[]): CrawlResult[] =>
  batch.map((t) => ({
    clinicId: t.clinicId,
    domain: t.domain,
    text: "",
    links: [],
    pagesFetched: 0,
    error: "no pages fetched",
  }));

const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("ordering and coverage", () => {
  test("results stay in input order however the batches finish", async () => {
    // Deliberately inverted: later batches return first. Appending on
    // completion would make the output depend on network timing, so two
    // identical runs would produce differently ordered files and any diff
    // between them would be unreadable.
    const out = await crawlSites(targets(100), {
      token: "x",
      batchSize: 10,
      concurrency: 8,
      runBatch: async (b) => {
        const n = Number(b[0]!.domain.match(/\d+/)![0]);
        await settle(100 - n);
        return ok(b);
      },
    });

    expect(out).toHaveLength(100);
    expect(out.map((r) => r.clinicId)).toEqual(
      targets(100).map((t) => t.clinicId),
    );
  });

  test("every target appears exactly once", async () => {
    const out = await crawlSites(targets(57), {
      token: "x",
      batchSize: 10,
      concurrency: 4,
      runBatch: async (b) => ok(b),
    });

    expect(out).toHaveLength(57);
    expect(new Set(out.map((r) => r.clinicId)).size).toBe(57);
  });

  test("a single batch works — the fan-out loop must not underflow", async () => {
    // batches.length - 1 is 0 here. An off-by-one would spawn a worker that
    // reads past the end, or spawn none and hang.
    const out = await crawlSites(targets(5), {
      token: "x",
      batchSize: 10,
      concurrency: 8,
      runBatch: async (b) => ok(b),
    });
    expect(out).toHaveLength(5);
  });
});

describe("the cheap-failure guard", () => {
  test("stops after the probe batch, before anything else is billed", async () => {
    // The whole point of running one batch alone. If the guard fired after
    // fan-out instead, eight batches would already be paid for.
    let called = 0;
    await expect(
      crawlSites(targets(500), {
        token: "x",
        batchSize: 50,
        concurrency: 8,
        runBatch: async (b) => {
          called += 1;
          return dead(b);
        },
      }),
    ).rejects.toThrow(/configuration problem/);

    expect(called, "batches billed before the guard fired").toBe(1);
  });

  test("does not fire on a retry set, which is selected for having failed", async () => {
    // The bug this replaced: guarding on a retry-only set made every re-run
    // after a full crawl throw, with no escape but paying to re-crawl
    // everything.
    const out = await crawlSites(targets(100), {
      token: "x",
      batchSize: 50,
      concurrency: 4,
      firstAttempts: 0,
      runBatch: async (b) => dead(b),
    });

    expect(out).toHaveLength(100);
    expect(out.every((r) => r.error)).toBe(true);
  });

  test("tolerates a normal dead-domain rate", async () => {
    const out = await crawlSites(targets(100), {
      token: "x",
      batchSize: 50,
      concurrency: 2,
      runBatch: async (b) => [...dead(b.slice(0, 2)), ...ok(b.slice(2))],
    });
    expect(out).toHaveLength(100);
  });
});

describe("checkpoint safety", () => {
  test("writes never overlap, however many batches finish at once", async () => {
    // Two writers inside one write leave a truncated or doubled JSON document,
    // and the failure is silent until the next run fails to parse it — by
    // which point the crawl is paid for.
    let inFlight = 0;
    let overlaps = 0;

    await crawlSites(targets(200), {
      token: "x",
      batchSize: 10,
      concurrency: 8,
      runBatch: async (b) => ok(b),
      onBatch: async () => {
        inFlight += 1;
        if (inFlight > 1) overlaps += 1;
        await settle(5);
        inFlight -= 1;
      },
    });

    expect(overlaps).toBe(0);
  });

  test("the final checkpoint holds every result, not one batch behind", async () => {
    // Returning while a write is still queued lets the caller see a complete
    // in-memory result over a file that is missing the last batch.
    let lastWrite = 0;

    await crawlSites(targets(100), {
      token: "x",
      batchSize: 10,
      concurrency: 8,
      runBatch: async (b) => ok(b),
      onBatch: async (all) => {
        await settle(3);
        lastWrite = all.length;
      },
    });

    expect(lastWrite).toBe(100);
  });

  test("a failing checkpoint does not abandon paid-for pages", async () => {
    const out = await crawlSites(targets(50), {
      token: "x",
      batchSize: 10,
      concurrency: 4,
      runBatch: async (b) => ok(b),
      onBatch: async () => {
        throw new Error("disk full");
      },
    });

    expect(out).toHaveLength(50);
  });
});

describe("batch failure", () => {
  test("one failing batch does not take the others down", async () => {
    // Each batch is a separate Apify run; the rest are already paid for or in
    // flight. Aborting would discard them.
    const out = await crawlSites(targets(100), {
      token: "x",
      batchSize: 10,
      concurrency: 8,
      runBatch: async (b) => {
        if (b[0]!.domain === "clinic30.com") throw new Error("apify 500");
        return ok(b);
      },
    });

    expect(out).toHaveLength(100);
    const failed = out.filter((r) => r.error);
    expect(failed).toHaveLength(10);
    // Recorded as errors so the incremental crawl retries them next run,
    // rather than vanishing from the output entirely.
    expect(failed[0]!.error).toMatch(/batch failed/);
    expect(out.filter((r) => !r.error)).toHaveLength(90);
  });
});
