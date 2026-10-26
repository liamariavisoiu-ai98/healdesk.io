import { describe, expect, test } from "vitest";

import { closeFunnel, DEMO_EVENT_DETAILS, demoEventDetail, isDemoEventName } from "./events";

describe("the demo page's vocabulary", () => {
  test("only listed names, and only listed details", () => {
    expect(isDemoEventName("cta_clicked")).toBe(true);
    expect(isDemoEventName("chat_text")).toBe(false);
    expect(isDemoEventName("toString")).toBe(false);
    expect(demoEventDetail("cta_clicked", "close-card")).toBe("close-card");
    expect(demoEventDetail("cta_clicked", "someone@clinic.com")).toBeNull();
    expect(demoEventDetail("value_inputs_used", "40")).toBeNull();
  });

  test("the brief's events are all there", () => {
    for (const name of [
      "demo_ended",
      "close_card_shown",
      "close_card_cta",
      "coverage_mode_changed",
      "value_inputs_used",
      "offer_seen",
      "cta_clicked",
      "checkout_paid",
    ]) {
      expect(Object.hasOwn(DEMO_EVENT_DETAILS, name)).toBe(true);
    }
  });
});

describe("closeFunnel", () => {
  const at = (m: number) => new Date(Date.UTC(2026, 9, 26, 12, m));

  test("counts demos, not presses, and paid from the demo row", () => {
    const sessions = [
      { slug: "a", claimed: true },
      { slug: "b", claimed: false },
      { slug: "c", claimed: false },
      { slug: "d", claimed: false },
    ];
    const events = [
      { slug: "a", variant: "close", name: "demo_viewed", detail: null, at: at(0) },
      { slug: "a", variant: "close", name: "cta_clicked", detail: "close-card", at: at(2) },
      { slug: "a", variant: "close", name: "cta_clicked", detail: "closing", at: at(3) },
      { slug: "b", variant: "close", name: "demo_viewed", detail: null, at: at(0) },
      { slug: "c", variant: "control", name: "demo_viewed", detail: null, at: at(0) },
      { slug: "c", variant: "control", name: "cta_clicked", detail: "header", at: at(1) },
      // A demo that is no longer in the Sheet is not counted.
      { slug: "gone", variant: "control", name: "demo_viewed", detail: null, at: at(0) },
    ];
    const [close, control] = closeFunnel(sessions, events);
    expect(close).toEqual({ variant: "close", viewed: 2, clicked: 1, paid: 1, firstClickFrom: { "close-card": 1 } });
    expect(control).toEqual({ variant: "control", viewed: 1, clicked: 1, paid: 0, firstClickFrom: { header: 1 } });
  });
});
