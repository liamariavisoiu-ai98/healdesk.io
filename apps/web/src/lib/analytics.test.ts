import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import {
  attachAnalyticsClient,
  EVENTS,
  isAnalyticsActive,
  isAnalyticsExcludedPath,
  sanitize,
  scrubEvent,
  scrubUrl,
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

describe("query strings on the purchase pages never reach the vendor", () => {
  it("drops the query and fragment of /get-started, /start and /welcome URLs", () => {
    expect(scrubUrl("https://healdesk.io/get-started?lead=8a0c6f4e-1d2b-4c3a-9e8f-7a6b5c4d3e2f&c=spring")).toBe(
      "https://healdesk.io/get-started",
    );
    expect(scrubUrl("https://healdesk.io/get-started?plan=voice&link=expired#step-2")).toBe("https://healdesk.io/get-started");
    expect(scrubUrl("https://healdesk.io/start?setup=abc.123.sig")).toBe("https://healdesk.io/start");
    expect(scrubUrl("https://healdesk.io/welcome?h=ref&cs=cs_test_1")).toBe("https://healdesk.io/welcome");
  });

  it("leaves every other URL, and anything that is not one, as it was", () => {
    expect(scrubUrl("https://healdesk.io/?c=spring")).toBe("https://healdesk.io/?c=spring");
    expect(scrubUrl("https://healdesk.io/get-started-now?x=1")).toBe("https://healdesk.io/get-started-now?x=1");
    expect(scrubUrl("/get-started?lead=1")).toBe("/get-started?lead=1");
    expect(scrubUrl("voice")).toBe("voice");
  });

  it("scrubs the event's properties and the person properties it sets, and keeps the rest", () => {
    const event = {
      uuid: "u",
      event: "$pageview",
      properties: {
        $current_url: "https://healdesk.io/get-started?lead=8a0c6f4e-1d2b-4c3a-9e8f-7a6b5c4d3e2f",
        $referrer: "https://healdesk.io/get-started?c=spring",
        $pathname: "/get-started",
        step: 2,
      },
      $set: { $current_url: "https://healdesk.io/get-started?plan=voice" },
      $set_once: { $initial_current_url: "https://healdesk.io/get-started?c=spring" },
    };
    const scrubbed = scrubEvent(event)!;
    expect(JSON.stringify(scrubbed)).not.toMatch(/\?/);
    expect(scrubbed.properties).toEqual({
      $current_url: "https://healdesk.io/get-started",
      $referrer: "https://healdesk.io/get-started",
      $pathname: "/get-started",
      step: 2,
    });
    expect(scrubbed.uuid).toBe("u");
    expect(scrubEvent(null)).toBeNull();
  });
});

describe("the vendor client", () => {
  it("is created with the scrubber as its before_send", () => {
    // The client is made inside a consent branch with a dynamic import, so the
    // wiring is read from the source: without this line nothing is scrubbed.
    const source = readFileSync(new URL("../components/analytics/PostHogProvider.tsx", import.meta.url), "utf8");
    expect(source).toMatch(/before_send: scrubEvent,/);
  });
});
