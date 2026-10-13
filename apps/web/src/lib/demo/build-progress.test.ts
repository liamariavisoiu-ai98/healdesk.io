import { describe, expect, it } from "vitest";

import { CHECK_ESTIMATE_MS, estimateBuild, READ_ESTIMATE_MS, timeLeftText } from "./build-progress";

describe("the build estimate", () => {
  it("starts low, and while reading never claims the audit has begun", () => {
    const start = estimateBuild("building", 0);
    expect(start.percent).toBeGreaterThan(0);
    expect(start.percent).toBeLessThan(5);
    expect(start.step).toBe("read");
    // However long the crawl takes, the bar stays below where checking starts.
    for (const minutes of [1, 3, 5, 8, 30]) {
      expect(estimateBuild("building", minutes * 60_000).percent).toBeLessThan(estimateBuild("auditing", 0, 0).percent);
    }
  });

  it("moves from reading to learning on the clock, and to checking only on the server's word", () => {
    expect(estimateBuild("building", READ_ESTIMATE_MS * 0.5).step).toBe("read");
    expect(estimateBuild("building", READ_ESTIMATE_MS * 0.7).step).toBe("learn");
    expect(estimateBuild("building", READ_ESTIMATE_MS * 3).step).toBe("learn");
    expect(estimateBuild("auditing", 10_000).step).toBe("check");
  });

  it("never reaches 100 before the demo is ready, however long it runs", () => {
    expect(estimateBuild("auditing", 60 * 60_000, 0).percent).toBeLessThan(100);
    expect(estimateBuild("building", 60 * 60_000).percent).toBeLessThan(100);
  });

  it("never falls as time passes within a stage", () => {
    let last = 0;
    for (let t = 0; t <= 10 * 60_000; t += 1_000) {
      const { percent } = estimateBuild("building", t);
      expect(percent).toBeGreaterThanOrEqual(last);
      last = percent;
    }
    last = 0;
    for (let t = 0; t <= 10 * 60_000; t += 1_000) {
      const { percent } = estimateBuild("auditing", 40_000 + t, 40_000);
      expect(percent).toBeGreaterThanOrEqual(last);
      last = percent;
    }
  });

  it("counts the whole estimate down, reading and checking together", () => {
    expect(estimateBuild("building", 0).leftMs).toBe(READ_ESTIMATE_MS + CHECK_ESTIMATE_MS);
    expect(estimateBuild("building", READ_ESTIMATE_MS * 2).leftMs).toBe(CHECK_ESTIMATE_MS);
    expect(estimateBuild("auditing", 50_000, 50_000).leftMs).toBe(CHECK_ESTIMATE_MS);
    expect(estimateBuild("auditing", 50_000 + CHECK_ESTIMATE_MS * 2, 50_000).leftMs).toBe(0);
  });

  it("dates an audit it did not see begin from when reading was due to end", () => {
    // Opened two minutes in, mid-audit: assumed to have begun at the reading estimate.
    const opened = estimateBuild("auditing", 120_000);
    expect(opened.leftMs).toBe(CHECK_ESTIMATE_MS - (120_000 - READ_ESTIMATE_MS));
    // Opened early, already auditing: the audit began no later than now.
    expect(estimateBuild("auditing", 30_000).leftMs).toBe(CHECK_ESTIMATE_MS);
  });
});

describe("the time left, in words", () => {
  it("speaks in minutes, then less than one, and never counts below zero", () => {
    expect(timeLeftText(READ_ESTIMATE_MS + CHECK_ESTIMATE_MS)).toBe("About 3 minutes left");
    expect(timeLeftText(100_000)).toBe("About 2 minutes left");
    expect(timeLeftText(70_000)).toBe("About a minute left");
    expect(timeLeftText(20_000)).toBe("Less than a minute left");
    expect(timeLeftText(0)).toBe("Nearly there");
  });
});
