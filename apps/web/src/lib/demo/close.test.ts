import { DEMO_SETUP_CREDIT, getPackage, SELF_SERVE_DEMO_SETUP_CREDIT } from "@healdesk/catalog";
import { describe, expect, test } from "vitest";

import { setupDueUsd } from "@/lib/checkout/review";

import {
  clockLabel,
  COVERAGE_MODES,
  coverageExamples,
  demoVariant,
  enquiriesPerMonth,
  openHoursOf,
  recommendation,
  recommendedPackage,
  setupFigures,
} from "./close";
import type { WeekSchedule } from "./opening-hours";
import { ASSUMED_SHOW_RATE, DEFAULT_MISSED_CALLS_PER_WEEK, DEFAULT_MISSED_MESSAGES_PER_WEEK, type RoiInputs, suggestedSteps } from "./roi";

const NOW = Date.parse("2026-10-26T12:00:00Z");
const LATER = "2026-10-28T12:00:00.000Z";
const EARLIER = "2026-10-25T12:00:00.000Z";

const inputs: RoiInputs = {
  priceUsd: 425,
  priceSource: "Wrinkle Treatment, from your website",
  bookingRate: 0.35,
  showRate: ASSUMED_SHOW_RATE,
  repeat: null,
  missedCallsPerWeek: DEFAULT_MISSED_CALLS_PER_WEEK,
  missedMessagesPerWeek: DEFAULT_MISSED_MESSAGES_PER_WEEK,
};

// Mon–Fri 9 to 6, Sat 10 to 4, Sun closed: 51 hours.
const week: WeekSchedule = {
  listed: true,
  days: [
    [[540, 1080]],
    [[540, 1080]],
    [[540, 1080]],
    [[540, 1080]],
    [[540, 1080]],
    [[600, 960]],
    [],
  ],
};

describe("demoVariant", () => {
  test("is stable for a slug and splits demos between the two closes", () => {
    const slugs = Array.from({ length: 200 }, (_, i) => `clinic-${i}-abcdefgh23`);
    const first = slugs.map((s) => demoVariant(s, undefined));
    expect(slugs.map((s) => demoVariant(s, undefined))).toEqual(first);
    const close = first.filter((v) => v === "close").length;
    expect(close).toBeGreaterThan(60);
    expect(close).toBeLessThan(140);
  });

  test("DEMO_CLOSE_SPLIT forces one close for every demo", () => {
    expect(demoVariant("any-clinic-abcdefgh23", "close")).toBe("close");
    expect(demoVariant("any-clinic-abcdefgh23", "control")).toBe("control");
  });
});

describe("the recommendation", () => {
  test("is the catalog's Recommended package at the steps the clinic's volume suggests, not the catalog floor", () => {
    const rec = recommendation(inputs, { percent: 50, endsAt: LATER }, NOW);
    expect(rec.plan.packageId).toBe(recommendedPackage().id);
    expect(getPackage(rec.plan.packageId)?.highlight).toBe("Recommended");
    const steps = suggestedSteps(inputs);
    expect(rec.plan.includedVoiceMinutes).toBe(steps.voiceMinutes);
    expect(rec.plan.includedChatConversations).toBe(steps.chatConversations);
    expect(rec.monthlyUsd).toBe(rec.plan.monthlyUsd);
  });

  test("moves with the owner's inputs", () => {
    const small = recommendation(inputs, { percent: 50, endsAt: LATER }, NOW);
    const busy = recommendation({ ...inputs, missedCallsPerWeek: 40 }, { percent: 50, endsAt: LATER }, NOW);
    expect(busy.plan.includedVoiceMinutes).toBeGreaterThan(small.plan.includedVoiceMinutes);
    expect(busy.monthlyUsd).toBeGreaterThan(small.monthlyUsd);
    expect(busy.estimate.bookedValueUsd).toBeGreaterThan(small.estimate.bookedValueUsd);
  });
});

describe("setupFigures", () => {
  const plan = { setupFeeUsd: 1394 };

  test("while the offer holds: the figure the Stripe coupon takes, and the dollars saved", () => {
    const f = setupFigures(plan, { percent: DEMO_SETUP_CREDIT.percentOfSetupFee, endsAt: LATER }, NOW);
    expect(f.dueUsd).toBe(setupDueUsd(plan, { kind: "demo", endsAt: LATER, percentOfSetupFee: 50 }));
    expect(f.dueUsd).toBe(697);
    expect(f.savedUsd).toBe(697);
    expect(f.percent).toBe(50);
    expect(f.endsAt).toBe(LATER);
  });

  test("a homepage demo's share is its own", () => {
    const f = setupFigures(plan, { percent: SELF_SERVE_DEMO_SETUP_CREDIT.percentOfSetupFee, endsAt: LATER }, NOW);
    expect(f.percent).toBe(30);
    expect(f.dueUsd).toBe(setupDueUsd(plan, { kind: "demo", endsAt: LATER, percentOfSetupFee: 30 }));
  });

  test("once it has ended: the list fee, no share and no clock, never a reset", () => {
    for (const endsAt of [EARLIER, null]) {
      const f = setupFigures(plan, { percent: 50, endsAt }, NOW);
      expect(f).toEqual({ listUsd: 1394, dueUsd: 1394, savedUsd: 0, percent: null, endsAt: null });
    }
  });
});

describe("the coverage section", () => {
  test("hours and enquiries come from the schedule and the owner's figures", () => {
    expect(openHoursOf(week)).toBe(51);
    expect(enquiriesPerMonth({ missedCallsPerWeek: 8, missedMessagesPerWeek: 4 })).toBe(52);
  });

  test("the three modes are the product's, overflow and after hours the default", () => {
    expect(COVERAGE_MODES.map((m) => m.id)).toEqual(["after-hours", "overflow", "all"]);
    expect(COVERAGE_MODES.find((m) => "note" in m)?.id).toBe("overflow");
  });

  test("examples out of hours sit where the clinic is closed, and only the open-hours modes add one in hours", () => {
    const isOpen = (day: number, minute: number) => (week.days[day] ?? []).some(([a, b]) => minute >= a && minute < b);
    const after = coverageExamples(week, "after-hours");
    expect(after.length).toBe(2);
    for (const e of after) expect(isOpen(e.day, e.minute)).toBe(false);
    for (const mode of ["overflow", "all"] as const) {
      const examples = coverageExamples(week, mode);
      expect(examples.length).toBe(3);
      expect(isOpen(examples[2]!.day, examples[2]!.minute)).toBe(true);
    }
  });

  test("no example names a treatment or a person", () => {
    for (const mode of ["after-hours", "overflow", "all"] as const) {
      for (const e of coverageExamples(week, mode)) {
        expect(`${e.label} ${e.result}`).toMatch(/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun) \d/);
        expect(`${e.label} ${e.result}`).not.toMatch(/botox|filler|laser|facial|treatment|injection|[A-Z][a-z]+ [A-Z][a-z]+/);
      }
    }
  });

  test("clock labels read like a sign", () => {
    expect(clockLabel(21 * 60 + 42)).toBe("9:42pm");
    expect(clockLabel(10 * 60)).toBe("10am");
    expect(clockLabel(0)).toBe("12am");
  });
});
