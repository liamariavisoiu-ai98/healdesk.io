import { describe, expect, test } from "vitest";

import { billingSections, billingTiles } from "@/lib/portal/billing-glance";

/**
 * The top of Billing (portal redesign, fourth slice, owner, 1 November
 * 2026): the plan and its price, the next charge, and this month's use.
 * Every figure is passed in from the billing summary or Stripe's preview.
 */

const NOW = new Date("2026-11-04T15:00:00Z");
const base = {
  packageName: "AYA Voice + Meta Chat",
  periodUsd: 580,
  interval: "month" as const,
  locations: 1,
  ended: false,
  isPlanStarted: true,
  nextInvoice: {
    status: "ok" as const,
    amountDueCents: 58_000,
    nextPaymentOn: "2026-12-01",
    periodStartsOn: null,
    periodEndsOn: null,
  },
  usage: [
    { meter: "voice_minutes" as const, used: 312, included: 500, isWindowOpen: true },
    { meter: "chat_conversations" as const, used: 128, included: 300, isWindowOpen: true },
  ],
  timeZone: "America/New_York",
  now: NOW,
};

describe("billingTiles", () => {
  test("a running plan: its price, Stripe's next charge, and the meter nearest its allowance", () => {
    expect(billingTiles(base)).toEqual([
      { key: "plan", label: "Your plan", value: "AYA Voice + Meta Chat", hint: "$580 a month" },
      { key: "next", label: "Next charge", value: "$580", hint: "On Tuesday 1 December." },
      { key: "usage", label: "This month's use", value: "62%", hint: "312 voice minutes of 500." },
    ]);
  });

  test("annual billing and several locations say so", () => {
    expect(billingTiles({ ...base, interval: "year", periodUsd: 5_568, locations: 2 })[0]!.hint).toBe(
      "$5,568 a year per location",
    );
  });

  test("before the plan starts: nothing charged yet, and the allowance waits", () => {
    const tiles = billingTiles({
      ...base,
      isPlanStarted: false,
      nextInvoice: null,
      usage: base.usage.map((m) => ({ ...m, used: 0, isWindowOpen: false })),
    });
    expect(tiles[1]).toMatchObject({ value: "$0 for now", hint: "Your plan starts the day AYA first answers." });
    expect(tiles[2]).toMatchObject({ value: "0%", hint: "Your allowance starts when your plan does." });
  });

  test("when Stripe's preview is not available, its own message is shown", () => {
    const tiles = billingTiles({ ...base, nextInvoice: { status: "not_available", message: "Stripe is busy." } });
    expect(tiles[1]).toMatchObject({ value: "—", hint: "Stripe is busy." });
  });

  test("an ended plan says so, and shows no next charge at all", () => {
    const tiles = billingTiles({ ...base, ended: true });
    expect(tiles[0]!.hint).toBe("This plan has ended.");
    expect(tiles.map((t) => t.key)).toEqual(["plan", "usage"]);
    expect(JSON.stringify(tiles)).not.toContain("Next charge");
  });

  test("the chat meter leads when it is nearer its allowance", () => {
    const tiles = billingTiles({
      ...base,
      usage: [
        { meter: "voice_minutes", used: 100, included: 500, isWindowOpen: true },
        { meter: "chat_conversations", used: 290, included: 300, isWindowOpen: true },
      ],
    });
    expect(tiles[2]).toMatchObject({ value: "96%", hint: "290 chat conversations of 300." });
  });
});

describe("billingSections", () => {
  test("every section while the plan runs; no switches or plan change once it ended", () => {
    expect(billingSections({ ended: false, canChange: true }).map((s) => s.id)).toEqual([
      "plan",
      "usage",
      "switches",
      "change",
      "payment-method",
      "agreement",
    ]);
    expect(billingSections({ ended: true, canChange: false }).map((s) => s.id)).toEqual([
      "plan",
      "usage",
      "payment-method",
      "agreement",
    ]);
  });
});
