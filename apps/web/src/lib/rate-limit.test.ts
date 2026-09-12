import { describe, expect, it } from "vitest";

import { isOverLimit, rateLimit } from "./rate-limit";

const key = () => `test:${Math.random()}`;

describe("rateLimit", () => {
  it("allows up to the limit then refuses", () => {
    const k = key();
    expect(rateLimit(k, 2, 60_000).ok).toBe(true);
    expect(rateLimit(k, 2, 60_000).ok).toBe(true);
    const third = rateLimit(k, 2, 60_000);
    expect(third.ok).toBe(false);
    expect(third.retryAfter).toBeGreaterThan(0);
  });
});

describe("isOverLimit", () => {
  it("does not spend from the budget", () => {
    const k = key();
    // Peeking a hundred times must not exhaust a budget of two.
    for (let i = 0; i < 100; i += 1) expect(isOverLimit(k, 2)).toBe(false);
    expect(rateLimit(k, 2, 60_000).ok).toBe(true);
    expect(rateLimit(k, 2, 60_000).ok).toBe(true);
    expect(isOverLimit(k, 2)).toBe(true);
  });

  it("reports false for a key that has never been seen", () => {
    expect(isOverLimit(key(), 1)).toBe(false);
  });

  // The callback route peeks before dialling and charges after. A request that
  // fails at the provider must leave the destination number's allowance intact.
  it("leaves the budget untouched when the charge never happens", () => {
    const k = key();
    expect(isOverLimit(k, 2)).toBe(false);
    // ...provider fails, no rateLimit() call...
    expect(isOverLimit(k, 2)).toBe(false);
    expect(rateLimit(k, 2, 60_000).ok).toBe(true);
  });
});
