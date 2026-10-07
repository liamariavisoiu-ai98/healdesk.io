import { getPlan, OVERAGE_RATES_PROVISIONAL, plans, planStartSentence } from "@healdesk/catalog";
import { describe, expect, test } from "vitest";

import {
  audienceFor,
  channelsInServiceLine,
  includedLine,
  locationsLine,
  overageSentence,
  payLabel,
  planStartLine,
  runOutLine,
  setupFeeToday,
} from "./review";

/**
 * Review and pay's sentences (plan Part A3, step 4), from the catalog.
 */

const plan = (id: string) => getPlan(id)!;

describe("today", () => {
  test("is the setup fee alone, never refunded, and the button charges exactly that", () => {
    expect(setupFeeToday(plan("web-voice")).headline).toBe("Today: $997 setup fee");
    expect(setupFeeToday(plan("chat-web")).headline).toBe("Today: $497 setup fee");
    expect(setupFeeToday(plan("voice")).covers).toMatch(/never refunded/);
    expect(payLabel(plan("chat-meta"))).toBe("Pay $497 and start setup");
    expect(payLabel(plan("complete"))).toBe("Pay $997 and start setup");
  });
});

describe("the plan-start sentence", () => {
  test("is the catalog's, for every package and both intervals", () => {
    for (const p of plans) {
      for (const interval of ["month", "year"] as const) {
        expect(planStartLine(p, interval, "med-spa")).toBe(
          planStartSentence(p, interval, "patient"),
        );
      }
    }
    expect(planStartLine(plan("web-voice"), "month", "med-spa")).toBe(
      "Monthly billing ($897) starts the day AYA first answers a patient.",
    );
  });

  test("has no backstop date", () => {
    for (const p of plans) expect(planStartLine(p, "month", null)).not.toMatch(/no later than/);
  });

  test("a practice whose patients are animals is told about its clients", () => {
    expect(audienceFor("veterinary")).toBe("client");
    expect(audienceFor("dental")).toBe("patient");
    expect(audienceFor(null)).toBe("patient");
  });
});

describe("channels in service", () => {
  test("only for a package with more than one channel", () => {
    expect(channelsInServiceLine(plan("voice"), "month")).toBeNull();
    expect(channelsInServiceLine(plan("chat-web"), "month")).toBeNull();
    expect(channelsInServiceLine(plan("chat-meta"), "month")).toBeNull();
    expect(channelsInServiceLine(plan("web-voice"), "month")).toBe(
      "Until every channel in your package is in service, your monthly price is the price of the channels that are.",
    );
    expect(channelsInServiceLine(plan("complete"), "year")).toBe(
      "Until every channel in your package is in service, your annual price is the price of the channels that are.",
    );
  });
});

describe("each month", () => {
  test("names the package's own allowance", () => {
    expect(includedLine(plan("voice"))).toBe("Included each month: 1,000 voice minutes.");
    expect(includedLine(plan("chat-dual"))).toBe("Included each month: 2,000 chat conversations.");
    expect(includedLine(plan("complete"))).toBe(
      "Included each month: 1,000 voice minutes and 2,000 chat conversations.",
    );
  });

  test("the overage is the package's own rate, and said to be provisional", () => {
    if (OVERAGE_RATES_PROVISIONAL) return;
    expect(overageSentence(plan("chat-web"), "month")).toMatch(
      /^Past that: \$0\.40 a chat conversation, on your next invoice\./,
    );
    expect(overageSentence(plan("complete"), "year")).toMatch(
      /^Past that: \$0\.80 a voice minute and \$0\.30 a chat conversation, invoiced monthly\./,
    );
    for (const p of plans) expect(overageSentence(p, "month")).toMatch(/provisional/);
  });

  test("the run-out line fits the package's channels", () => {
    expect(runOutLine(plan("voice"))).toMatch(
      /past the allowance, calls go to your own direct line\.$/,
    );
    expect(runOutLine(plan("chat-web"))).toMatch(/website chat shows a contact form\.$/);
    expect(runOutLine(plan("chat-meta"))).toMatch(
      /Instagram, Messenger and WhatsApp messages wait for your team\.$/,
    );
    expect(runOutLine(plan("complete"))).toMatch(
      /calls go to your own direct line, website chat shows a contact form and Instagram, Messenger and WhatsApp messages wait for your team\.$/,
    );
    expect(runOutLine(plan("voice"))).not.toMatch(/website chat|Instagram/);
  });
});

describe("locations", () => {
  test("one per purchase, more from Billing at the package's price plus its setup fee", () => {
    expect(locationsLine(plan("web-voice"), "month")).toBe(
      "This sets up one location. Add more from Billing after setup: $897/mo + $997 setup fee each.",
    );
    expect(locationsLine(plan("chat-web"), "year")).toBe(
      "This sets up one location. Add more from Billing after setup: $3,804/yr + $497 setup fee each.",
    );
  });
});
