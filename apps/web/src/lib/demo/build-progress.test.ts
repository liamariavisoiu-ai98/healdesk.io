import { describe, expect, it } from "vitest";

import { BUILD_BUDGET_MS } from "./budget";
import { estimateBuild, READ_ESTIMATE_MS, secondsLeft, timeLeftText } from "./build-progress";

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

  it("counts one minute down, whatever the stage, and never below zero", () => {
    expect(estimateBuild("building", 0).leftMs).toBe(BUILD_BUDGET_MS);
    expect(estimateBuild("building", 20_000).leftMs).toBe(BUILD_BUDGET_MS - 20_000);
    // The audit seen to begin early leaves the countdown where the clock has it: it never jumps back up.
    expect(estimateBuild("auditing", 25_000, 25_000).leftMs).toBe(BUILD_BUDGET_MS - 25_000);
    expect(estimateBuild("auditing", BUILD_BUDGET_MS * 2, 30_000).leftMs).toBe(0);
  });

  it("is due to finish within the build's minute", () => {
    expect(READ_ESTIMATE_MS).toBeLessThan(BUILD_BUDGET_MS);
    expect(estimateBuild("auditing", BUILD_BUDGET_MS, READ_ESTIMATE_MS).percent).toBeGreaterThan(90);
  });
});

describe("the time left, in words", () => {
  it("counts whole seconds, rounding up, then says it is nearly there", () => {
    expect(secondsLeft(BUILD_BUDGET_MS)).toBe(60);
    expect(timeLeftText(BUILD_BUDGET_MS)).toBe("60 seconds left");
    expect(timeLeftText(41_200)).toBe("42 seconds left");
    expect(timeLeftText(800)).toBe("1 second left");
    expect(timeLeftText(0)).toBe("Nearly there");
  });
});
