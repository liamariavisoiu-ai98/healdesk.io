import { describe, expect, test } from "vitest";
import { fetchPlaceHours, type PlaceHours, type PlacesTarget } from "../src/enrich/places.ts";

const targets = (n: number): PlacesTarget[] =>
  Array.from({ length: n }, (_, i) => ({
    clinicId: `c${String(i).padStart(3, "0")}`,
    company: `Clinic ${i}`,
    city: "Austin",
    state: "TX",
    domain: `c${i}.com`,
  }));

const hours = (b: PlacesTarget[], match: PlaceHours["match"] = "strong"): PlaceHours[] =>
  b.map((t) => ({
    clinicId: t.clinicId,
    matchedName: t.company,
    opensAt: "09:00",
    closesAt: "17:00",
    hoursByDay: null,
    closedDays: [],
    closedHoursPerWeek: 126,
    gap: null,
    reserveUrl: null,
    phone: null,
    match,
  })) as PlaceHours[];

describe("the hours pool", () => {
  test("never exceeds the configured concurrency", async () => {
    // Apify queues runs above the plan cap rather than running them, so
    // exceeding it looks like concurrency and is not.
    let live = 0;
    let peak = 0;
    await fetchPlaceHours(targets(800), {
      token: "t",
      batchSize: 100,
      concurrency: 3,
      runBatch: async (b) => {
        live++;
        peak = Math.max(peak, live);
        await new Promise((r) => setTimeout(r, 5));
        live--;
        return hours(b);
      },
    });
    expect(peak).toBeLessThanOrEqual(3);
  });

  test("the probe batch runs alone, before any fan-out", async () => {
    // Eight batches launched together are all billed before the first result
    // can be inspected. One batch of latency buys that check back.
    const during: number[] = [];
    let live = 0;
    await fetchPlaceHours(targets(500), {
      token: "t",
      batchSize: 100,
      concurrency: 4,
      runBatch: async (b) => {
        live++;
        during.push(live);
        await new Promise((r) => setTimeout(r, 5));
        live--;
        return hours(b);
      },
    });
    expect(during[0]).toBe(1);
  });

  test("output order follows the input, not completion order", async () => {
    // Two identical runs must produce identically ordered files, or every diff
    // between them is unreadable.
    const out = await fetchPlaceHours(targets(400), {
      token: "t",
      batchSize: 100,
      concurrency: 4,
      // Later batches finish first.
      runBatch: async (b) => {
        await new Promise((r) => setTimeout(r, 40 - Number(b[0]!.clinicId.slice(1))));
        return hours(b);
      },
    });
    expect(out.map((h) => h.clinicId)).toEqual(targets(400).map((t) => t.clinicId));
  });

  test("writes are serialised even though the fetches are not", async () => {
    // Two writers entering one file at once leave a truncated document, and the
    // failure is silent until the next run fails to parse it.
    let inWrite = 0;
    let overlapped = false;
    await fetchPlaceHours(targets(600), {
      token: "t",
      batchSize: 100,
      concurrency: 5,
      runBatch: async (b) => hours(b),
      onBatch: async () => {
        inWrite++;
        if (inWrite > 1) overlapped = true;
        await new Promise((r) => setTimeout(r, 3));
        inWrite--;
      },
    });
    expect(overlapped).toBe(false);
  });

  test("every write sees the whole accumulated set, never a stale view", async () => {
    const sizes: number[] = [];
    await fetchPlaceHours(targets(500), {
      token: "t",
      batchSize: 100,
      concurrency: 4,
      runBatch: async (b) => hours(b),
      onBatch: (partial) => {
        sizes.push(partial.length);
      },
    });
    // Monotonic, and the last write carries everything.
    expect(sizes).toEqual([...sizes].sort((a, b) => a - b));
    expect(sizes.at(-1)).toBe(500);
  });
});

describe("failure isolation", () => {
  test("one failed batch does not abandon the others", async () => {
    const out = await fetchPlaceHours(targets(500), {
      token: "t",
      batchSize: 100,
      concurrency: 4,
      runBatch: async (b) => {
        if (b[0]!.clinicId === "c200") throw new Error("apify 500");
        return hours(b);
      },
    });
    expect(out).toHaveLength(500);
    expect(out.filter((h) => h.error)).toHaveLength(100);
    expect(out.filter((h) => !h.error)).toHaveLength(400);
  });

  test("a failed batch is marked, not recorded as 'Google has no listing'", async () => {
    // These two are the same row otherwise — match "none", hours null — so a
    // transient failure would be checkpointed as fact and never retried.
    const out = await fetchPlaceHours(targets(300), {
      token: "t",
      batchSize: 100,
      concurrency: 2,
      runBatch: async (b) => {
        if (b[0]!.clinicId === "c100") throw new Error("apify 500");
        // Batch 0 matches so the probe guard passes; batch 2 genuinely misses.
        return b[0]!.clinicId === "c000" ? hours(b) : hours(b, "none");
      },
    });
    const genuinelyUnmatched = out.filter((h) => h.match === "none" && !h.error);
    const failed = out.filter((h) => h.error);
    expect(genuinelyUnmatched).toHaveLength(100);
    expect(failed).toHaveLength(100);
    expect(failed[0]!.error).toMatch(/apify 500/);
  });

  test("failed batches are persisted, so an interrupt does not lose the record", async () => {
    let last: PlaceHours[] = [];
    await fetchPlaceHours(targets(300), {
      token: "t",
      batchSize: 100,
      concurrency: 3,
      runBatch: async (b) => {
        if (b[0]!.clinicId === "c100") throw new Error("boom");
        return hours(b);
      },
      onBatch: (partial) => {
        last = partial;
      },
    });
    expect(last.filter((h) => h.error)).toHaveLength(100);
  });
});

describe("the mass-failure guard", () => {
  test("stops after one batch when nothing matches at all", async () => {
    // A search-string or actor-input problem, not 100 clinics missing from
    // Google. Every batch after this would be billed for the same nothing.
    let calls = 0;
    await expect(
      fetchPlaceHours(targets(900), {
        token: "t",
        batchSize: 100,
        concurrency: 4,
        runBatch: async (b) => {
          calls++;
          return hours(b, "none");
        },
      }),
    ).rejects.toThrow(/search-string or actor-input problem/);
    expect(calls).toBe(1);
  });

  test("a normal run with some misses is not stopped", async () => {
    const out = await fetchPlaceHours(targets(300), {
      token: "t",
      batchSize: 100,
      concurrency: 3,
      runBatch: async (b) => [
        ...hours(b.slice(0, 70)),
        ...hours(b.slice(70), "none"),
      ],
    });
    expect(out).toHaveLength(300);
  });

  test("a batch too small to judge does not trip the guard", async () => {
    // Guessing from five clinics is how a healthy run gets aborted.
    const out = await fetchPlaceHours(targets(5), {
      token: "t",
      batchSize: 100,
      runBatch: async (b) => hours(b, "none"),
    });
    expect(out).toHaveLength(5);
  });
});
