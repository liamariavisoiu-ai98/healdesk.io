import { describe, expect, test } from "vitest";
import {
  fetchBookingPages,
  type BookingPageFinding,
  type BookingPageTarget,
} from "../src/enrich/booking-page.ts";

const targets = (n: number): BookingPageTarget[] =>
  Array.from({ length: n }, (_, i) => ({
    clinicId: `c${String(i).padStart(3, "0")}`,
    url: `https://c${i}.com/book`,
  }));

const found = (b: BookingPageTarget[]): BookingPageFinding[] =>
  b.map((t) => ({
    clinicId: t.clinicId,
    url: t.url,
    detection: { platform: "zenoti", platformName: "Zenoti" },
  })) as BookingPageFinding[];

describe("the booking-page pool", () => {
  test("never exceeds the configured concurrency", async () => {
    let live = 0;
    let peak = 0;
    await fetchBookingPages(targets(700), {
      token: "t",
      batchSize: 100,
      concurrency: 3,
      runBatch: async (b) => {
        live++;
        peak = Math.max(peak, live);
        await new Promise((r) => setTimeout(r, 5));
        live--;
        return found(b);
      },
    });
    expect(peak).toBeLessThanOrEqual(3);
  });

  test("the probe batch runs alone, before any fan-out", async () => {
    // Seven batches launched together are all billed before the first result
    // can be inspected.
    const during: number[] = [];
    let live = 0;
    await fetchBookingPages(targets(600), {
      token: "t",
      batchSize: 100,
      concurrency: 4,
      runBatch: async (b) => {
        live++;
        during.push(live);
        await new Promise((r) => setTimeout(r, 5));
        live--;
        return found(b);
      },
    });
    expect(during[0]).toBe(1);
  });

  test("output order follows the input, not completion order", async () => {
    const out = await fetchBookingPages(targets(400), {
      token: "t",
      batchSize: 100,
      concurrency: 4,
      runBatch: async (b) => {
        await new Promise((r) => setTimeout(r, 40 - Number(b[0]!.clinicId.slice(1))));
        return found(b);
      },
    });
    expect(out.map((f) => f.clinicId)).toEqual(targets(400).map((t) => t.clinicId));
  });

  test("writes are serialised even though the fetches are not", async () => {
    let inWrite = 0;
    let overlapped = false;
    await fetchBookingPages(targets(600), {
      token: "t",
      batchSize: 100,
      concurrency: 5,
      runBatch: async (b) => found(b),
      onBatch: async () => {
        inWrite++;
        if (inWrite > 1) overlapped = true;
        await new Promise((r) => setTimeout(r, 3));
        inWrite--;
      },
    });
    expect(overlapped).toBe(false);
  });

  test("every batch persists, so an interrupt keeps what was paid for", async () => {
    // The defect this rewrite exists for: nothing reached disk until all seven
    // batches finished, so stopping at batch two discarded both.
    const sizes: number[] = [];
    await fetchBookingPages(targets(500), {
      token: "t",
      batchSize: 100,
      concurrency: 4,
      runBatch: async (b) => found(b),
      onBatch: (partial) => {
        sizes.push(partial.length);
      },
    });
    expect(sizes.length).toBe(5);
    expect(sizes).toEqual([...sizes].sort((a, b) => a - b));
    expect(sizes.at(-1)).toBe(500);
  });
});

describe("failure isolation", () => {
  test("one failed batch does not abandon the others", async () => {
    const out = await fetchBookingPages(targets(500), {
      token: "t",
      batchSize: 100,
      concurrency: 4,
      runBatch: async (b) => {
        if (b[0]!.clinicId === "c200") throw new Error("apify 500");
        return found(b);
      },
    });
    // 400 survive; the failed batch contributes nothing, which reads the same
    // as finding no platform. Acceptable here and nowhere else: a missed
    // booking page weakens a clinic's angle, it does not put a false claim in
    // an email.
    expect(out).toHaveLength(400);
    expect(out.some((f) => f.clinicId.startsWith("c2"))).toBe(false);
  });

  test("a single batch that throws still rejects rather than silently returning nothing", async () => {
    // With one batch there is no pool to isolate it, so the probe's failure is
    // the run's failure and the caller must see it.
    await expect(
      fetchBookingPages(targets(50), {
        token: "t",
        batchSize: 100,
        runBatch: async () => {
          throw new Error("apify 500");
        },
      }),
    ).rejects.toThrow(/apify 500/);
  });
});
