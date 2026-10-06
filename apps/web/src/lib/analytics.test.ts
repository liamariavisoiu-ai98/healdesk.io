import { afterEach, describe, expect, it } from "vitest";

import {
  attachAnalyticsClient,
  EVENTS,
  isAnalyticsActive,
  isAnalyticsExcludedPath,
  sanitize,
  track,
} from "./analytics";

afterEach(() => attachAnalyticsClient(null));

describe("analytics allowlist", () => {
  it("drops properties that are not allowlisted for the event", () => {
    expect(sanitize("checkout_step", { step: 3, plan: "voice", interval: "month", email: "a@b.co" })).toEqual({
      step: 3,
      plan: "voice",
      interval: "month",
    });
  });

  it("never lets an email or phone number through even under an allowed key", () => {
    expect(sanitize("checkout_started", { plan: "owner@clinic.com", interval: "+1 415 555 0100" })).toEqual({});
  });

  it("is a no-op before a client is attached", () => {
    expect(isAnalyticsActive()).toBe(false);
    expect(() => track("pricing_viewed", { interval: "year" })).not.toThrow();
  });

  it("sends only sanitised properties once a client exists", () => {
    const captured: Array<[string, Record<string, unknown> | undefined]> = [];
    attachAnalyticsClient({ capture: (e, p) => captured.push([e, p]) });
    track("demo_unlocked", { consent: true, email: "x@y.z", text: "hello" });
    expect(captured).toEqual([["demo_unlocked", { consent: true }]]);
  });

  it("never carries free-text keys in any event definition", () => {
    const forbidden = /message|text|email|phone|name|transcript|body/;
    for (const [event, keys] of Object.entries(EVENTS)) {
      for (const k of keys) expect(k, `${event}.${k}`).not.toMatch(forbidden);
    }
  });

  it("keeps third-party scripts off the purchase-complete page and the console", () => {
    expect(isAnalyticsExcludedPath("/get-started/done")).toBe(true);
    expect(isAnalyticsExcludedPath("/admin/ops")).toBe(true);
    expect(isAnalyticsExcludedPath("/demo/smith-dental-k7q2mz9xwa")).toBe(true);
    expect(isAnalyticsExcludedPath("/pricing")).toBe(false);
  });
});
