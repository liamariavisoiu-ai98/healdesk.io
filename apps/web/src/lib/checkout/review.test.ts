import {
  allPlans,
  COHORT_SETUP_CREDIT,
  DEMO_SETUP_CREDIT,
  getPlan,
  planStartSentence,
  setupAfterCreditUsd,
  SITE_SETUP_CREDIT,
} from "@healdesk/catalog";
import { describe, expect, test } from "vitest";

import {
  audienceFor,
  channelsInServiceLine,
  extraBlockPrices,
  includedLine,
  liveOffer,
  locationsLine,
  offerHeadline,
  offerLine,
  overageSentence,
  payLabel,
  planStartLine,
  runOutLine,
  type SetupOffer,
  setupDueUsd,
  setupFeeToday,
  strongestOffer,
} from "./review";

/**
 * Review and pay's sentences (plan Part A3, step 4), from the catalog, at the
 * pricing sheet of 13 October 2026: a package at its steps.
 */

const plan = (id: string) => getPlan(id)!;

/** One plan per package, at the sheet's examples, and the extremes of the grid. */
const SAMPLE = [
  "voice-500",
  "webchat-300",
  "metachat-300",
  "voice-webchat-500-300",
  "voice-metachat-500-300",
  "voice-100",
  "metachat-1500",
  "voice-webchat-1500-100",
].map(plan);

const NOW = Date.parse("2026-10-13T12:00:00.000Z");
const LATER = new Date(NOW + 60 * 60 * 1000).toISOString();
const EARLIER = new Date(NOW - 1).toISOString();
const offer = (kind: SetupOffer["kind"], endsAt = LATER): SetupOffer => ({ kind, endsAt });

describe("today", () => {
  test("is the setup fee alone, never refunded, and the button charges exactly that", () => {
    expect(setupFeeToday(plan("voice-webchat-500-300")).headline).toBe("Today: $956 setup fee");
    expect(setupFeeToday(plan("webchat-300")).headline).toBe("Today: $259 setup fee");
    expect(setupFeeToday(plan("voice-500")).covers).toMatch(/never refunded/);
    expect(payLabel(plan("metachat-300"))).toBe("Pay $697 and start setup");
    expect(payLabel(plan("voice-metachat-500-300"))).toBe("Pay $1,394 and start setup");
  });

  test("the setup fee is the package's, whatever the steps", () => {
    expect(plan("voice-metachat-100-100").setupFeeUsd).toBe(1394);
    expect(plan("voice-metachat-1500-1500").setupFeeUsd).toBe(1394);
  });
});

describe("the setup offer", () => {
  test("takes the catalog's figure off, rounded up to whole dollars, the one Stripe's coupon is built from", () => {
    const voice = plan("voice-500");
    expect(setupDueUsd(voice, offer("demo"))).toBe(349);
    expect(setupDueUsd(voice, offer("site"))).toBe(488);
    expect(setupDueUsd(plan("webchat-300"), offer("site"))).toBe(182);
    expect(setupDueUsd(voice, offer("cohort"))).toBe(0);
    expect(setupDueUsd(voice, null)).toBe(697);
    for (const p of allPlans()) {
      expect(setupDueUsd(p, offer("demo"))).toBe(setupAfterCreditUsd(p, DEMO_SETUP_CREDIT));
      expect(setupDueUsd(p, offer("site"))).toBe(setupAfterCreditUsd(p, SITE_SETUP_CREDIT));
      expect(setupDueUsd(p, offer("cohort"))).toBe(setupAfterCreditUsd(p, COHORT_SETUP_CREDIT));
    }
  });

  test("today's figure and the button say the price after the offer", () => {
    const p = plan("voice-metachat-500-300");
    expect(setupFeeToday(p, offer("site")).headline).toBe("Today: $976 setup fee");
    expect(payLabel(p, offer("site"))).toBe("Pay $976 and start setup");
    expect(payLabel(p, offer("demo"))).toBe("Pay $697 and start setup");
    expect(offerLine(p, offer("site"))).toBe("$1,394 less $418: 30% off setup. Our website offer.");
    expect(offerLine(p, offer("demo"))).toBe("$1,394 less $697: 50% off setup. Your demo offer.");
    expect(offerLine(p, offer("cohort"))).toBe(
      "$1,394 less $1,394: the setup fee in full. Your setup credit.",
    );
  });

  test("headlines", () => {
    expect(offerHeadline(offer("site"))).toBe("30% off your setup fee");
    expect(offerHeadline(offer("demo"))).toBe("50% off your setup fee");
    expect(offerHeadline(offer("cohort"))).toBe("Your setup fee, in full, is on us");
  });

  test("only one applies: cohort over demo over site, among those still live", () => {
    const all = [offer("site"), offer("demo"), offer("cohort")];
    expect(strongestOffer(all, NOW)?.kind).toBe("cohort");
    expect(strongestOffer([offer("site"), offer("demo")], NOW)?.kind).toBe("demo");
    expect(strongestOffer([offer("site"), offer("demo", EARLIER)], NOW)?.kind).toBe("site");
    expect(strongestOffer([offer("cohort", EARLIER), null, undefined], NOW)).toBeNull();
    expect(strongestOffer([], NOW)).toBeNull();
  });

  test("an offer whose clock has run out, or one that is malformed, is no offer", () => {
    expect(liveOffer(offer("site"), NOW)).toEqual(offer("site"));
    expect(liveOffer(offer("site", EARLIER), NOW)).toBeNull();
    expect(liveOffer({ kind: "site", endsAt: "soon" }, NOW)).toBeNull();
    expect(liveOffer({ kind: "half" as SetupOffer["kind"], endsAt: LATER }, NOW)).toBeNull();
    expect(liveOffer(null, NOW)).toBeNull();
  });
});

describe("the plan-start sentence", () => {
  test("is the catalog's, for every package and both intervals", () => {
    for (const p of SAMPLE) {
      for (const interval of ["month", "year"] as const) {
        expect(planStartLine(p, interval, "med-spa")).toBe(
          planStartSentence(p, interval, "patient"),
        );
      }
    }
    expect(planStartLine(plan("voice-metachat-500-300"), "month", "med-spa")).toBe(
      "Monthly billing ($580) starts the day AYA first answers a patient.",
    );
  });

  test("has no backstop date", () => {
    for (const p of SAMPLE) expect(planStartLine(p, "month", null)).not.toMatch(/no later than/);
  });

  test("a practice whose patients are animals is told about its clients", () => {
    expect(audienceFor("veterinary")).toBe("client");
    expect(audienceFor("dental")).toBe("patient");
    expect(audienceFor(null)).toBe("patient");
  });
});

describe("channels in service", () => {
  test("only for a package with more than one channel; Meta Chat has two, the website and Meta", () => {
    expect(channelsInServiceLine(plan("voice-500"), "month")).toBeNull();
    expect(channelsInServiceLine(plan("webchat-300"), "month")).toBeNull();
    expect(channelsInServiceLine(plan("metachat-300"), "month")).toBe(
      "Until every channel in your package is in service, your monthly price is the price of the channels that are.",
    );
    expect(channelsInServiceLine(plan("voice-metachat-500-300"), "year")).toBe(
      "Until every channel in your package is in service, your annual price is the price of the channels that are.",
    );
  });
});

describe("each month", () => {
  test("names the plan's own steps", () => {
    expect(includedLine(plan("voice-500"))).toBe("Included each month: 500 voice minutes.");
    expect(includedLine(plan("metachat-1500"))).toBe(
      "Included each month: 1,500 chat conversations.",
    );
    expect(includedLine(plan("voice-metachat-500-300"))).toBe(
      "Included each month: 500 voice minutes and 300 chat conversations.",
    );
  });

  test("each extra 100 has the product's own price", () => {
    expect(extraBlockPrices(plan("voice-500")).map((b) => b.price)).toEqual(["$104"]);
    expect(extraBlockPrices(plan("webchat-300")).map((b) => b.price)).toEqual(["$52"]);
    expect(extraBlockPrices(plan("voice-metachat-500-300")).map((b) => b.price)).toEqual([
      "$104",
      "$78",
    ]);
  });

  test("the overage is the package's own price per started block of 100, and said to be provisional", () => {
    expect(overageSentence(plan("webchat-300"), "month")).toBe(
      "Past that: $52 for each started block of 100 extra chat conversations, on your next invoice. " +
        "These rates are provisional until we have measured what a minute and a conversation cost to serve.",
    );
    expect(overageSentence(plan("voice-500"), "month")).toMatch(
      /^Past that: \$104 for each started block of 100 extra voice minutes, on your next invoice\./,
    );
    expect(overageSentence(plan("voice-metachat-500-300"), "year")).toMatch(
      /^Past that: \$104 for each started block of 100 extra voice minutes and \$78 for each started block of 100 extra chat conversations, invoiced monthly\./,
    );
    for (const p of SAMPLE) {
      for (const interval of ["month", "year"] as const) {
        const sentence = overageSentence(p, interval);
        expect(sentence).toMatch(/provisional/);
        // Billed per started block: never a per-unit rate. Word boundaries,
        // because "extra voice minutes" holds "a voice minute".
        expect(sentence).not.toMatch(
          /\ba voice minute|\ba chat conversation|\bper minute|\bper conversation|\$[01]\./i,
        );
      }
    }
  });

  test("the run-out line: the email at 90%, and a fallback that fits the package's channels", () => {
    expect(runOutLine(plan("voice-500"))).toMatch(
      /^We email you at 90% of your included amount, so you can move up a step\./,
    );
    expect(runOutLine(plan("voice-500"))).toMatch(
      /past the allowance, calls go to your own direct line\.$/,
    );
    expect(runOutLine(plan("webchat-300"))).toMatch(/website chat shows a contact form\.$/);
    expect(runOutLine(plan("metachat-300"))).toMatch(
      /website chat shows a contact form and Instagram, Messenger and WhatsApp messages wait for your team\.$/,
    );
    expect(runOutLine(plan("voice-metachat-500-300"))).toMatch(
      /calls go to your own direct line, website chat shows a contact form and Instagram, Messenger and WhatsApp messages wait for your team\.$/,
    );
    expect(runOutLine(plan("voice-500"))).not.toMatch(/website chat|Instagram/);
  });
});

describe("locations", () => {
  test("one per purchase, more from Billing at the plan's price plus its setup fee, all answered by one AYA", () => {
    expect(locationsLine(plan("voice-webchat-500-300"), "month")).toBe(
      "This sets up one location. Add more from Billing after setup: $520/mo + $956 setup fee each. One AYA answers for all of them.",
    );
    expect(locationsLine(plan("webchat-300"), "year")).toBe(
      "This sets up one location. Add more from Billing after setup: $1,152/yr + $259 setup fee each. One AYA answers for all of them.",
    );
  });
});
