import { DEMO_SETUP_CREDIT, PACKAGES, packageSetupFeeUsd, PRODUCTS, SITE_SETUP_CREDIT } from "@healdesk/catalog";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";

import { countdownLabel } from "@/components/pricing/use-site-offer";
import { checkoutStart, overageExample, setupFeeRangeLabel } from "@/lib/pricing";

import PricingPage from "./page";

/**
 * /pricing says what the owner's pricing sheet of 13 October 2026 says, and
 * nothing a public page may not.
 *
 * Read as text, the way the terms and the checkout copy are: the figures come
 * from the catalog, so what is checked here is that each one is on the page
 * and that the page holds to the copy rules (CLAUDE.md, "Claims and copy").
 */

const markup = renderToStaticMarkup(h(PricingPage));
const words = markup
  .replace(/<style[\s\S]*?<\/style>/g, "")
  .replace(/<[^>]+>/g, " ")
  .replace(/&#x27;|&apos;|&#39;/g, "'")
  .replace(/&quot;/g, '"')
  .replace(/&amp;/g, "&")
  .replace(/\s+/g, " ")
  .trim();

describe("the sheet, in its order", () => {
  test("how it works, in three steps", () => {
    const at = ["How it works.", "1. Pick a product", "2. Pick a usage step", "3. Pay"].map((s) => words.indexOf(s));
    expect(at.every((i) => i >= 0), JSON.stringify(at)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(words).toContain("500 minutes and 300 web chat conversations is $400 + $120 = $520 a month.");
  });

  test("each product's price per 100, its extra 100 and its setup fee at list price", () => {
    for (const product of Object.values(PRODUCTS)) {
      const unit = product.unit === "minute" ? "minutes" : "conversations";
      expect(words, product.name).toContain(`${product.name}`);
      expect(words, product.name).toContain(`$${product.perStepMonthlyUsd} per 100 ${unit}`);
      expect(words, product.name).toContain(`$${product.setupFeeUsd.toLocaleString("en-US")}`);
    }
    for (const pkg of PACKAGES.filter((p) => p.voice && p.chat)) {
      expect(words, pkg.name).toContain(`$${packageSetupFeeUsd(pkg).toLocaleString("en-US")}`);
    }
    expect(words).toContain("Each extra 100 (provisional)");
    expect(setupFeeRangeLabel()).toBe("$259–$1,394");
  });

  test("a calculator that opens checkout on the plan it built, and the step table", () => {
    // Server-rendered on the recommended package at the sheet's default steps.
    expect(markup).toContain('href="/get-started?plan=voice-metachat-500-300&amp;interval=month"');
    expect(words).toContain("Work out your price.");
    expect(words).toContain("Find your step.");
    // The last row of the step table: 1,500 of each product.
    expect(words).toContain("1,500 $1,200 /mo $600 /mo $900 /mo");
  });

  test("going over a step: the 90% email, the block, and the sheet's example", () => {
    const example = overageExample();
    expect(example).toMatchObject({ stepUsd: 400, extraUsd: 104, nextStep: 600, nextStepUsd: 480 });
    expect(words).toContain("When you have used 90% of what your step includes, we send you a short email.");
    expect(words).toContain(
      "you chose 500 minutes ($400 a month) and used 580. That is $400 + $104 for one started block of 100 = $504. Moving up to 600 minutes would have cost $480.",
    );
    expect(words).toContain("An extra block costs more than moving up a step");
  });

  test("prices are per location, and annual billing is 20% off", () => {
    expect(words).toContain("Prices are per location.");
    expect(words).toContain("at the same plan price again and its own setup fee");
    expect(words).toContain("annual billing is 20% off");
    expect(words).toContain("Save 20%");
  });
});

describe("what a public page may not say", () => {
  test("never the personalised demo's half off, and no discount before the server says so", () => {
    // Half off setup belongs to a demo the clinic asked for. The website's
    // own offer appears only after /api/site-offer answers, so the server
    // render shows list prices with nothing struck through.
    expect(words).not.toMatch(new RegExp(`\\b${DEMO_SETUP_CREDIT.percentOfSetupFee}%`));
    expect(words).not.toMatch(/half (?:off|the setup)/i);
    expect(markup).not.toMatch(/<s[ >]/);
    expect(words).not.toContain(`${SITE_SETUP_CREDIT.percentOfSetupFee}% off the setup fee`);
  });

  test("no fixed packages, no revenue, no unqualified compliance, no timing", () => {
    expect(words).not.toMatch(/Complete Frontdesk|Web or Meta|\$1,197|\$997|\$397/);
    expect(words).not.toMatch(/\brevenue\b/i);
    expect(words).not.toMatch(/HIPAA compliant/i);
    expect(words).toContain("We sign a business associate agreement and handle patient data under it");
    expect(words).not.toMatch(/same day|in minutes|two minutes/i);
    expect(words).not.toMatch(/\bchatbot\b|AI voice agent/i);
  });
});

describe("checkout opens on what the page links to", () => {
  test("a plan id opens that plan; a package id opens it at the default steps", () => {
    expect(checkoutStart("voice-webchat-500-300")?.id).toBe("voice-webchat-500-300");
    expect(checkoutStart("voice-metachat")?.id).toBe("voice-metachat-500-300");
    expect(checkoutStart("voice")?.id).toBe("voice-500");
    expect(checkoutStart("webchat")?.id).toBe("webchat-300");
  });

  test("a stale or unknown id opens nothing", () => {
    for (const id of ["complete", "chat-web", "web-voice", "voice-150", "", 7, null]) {
      expect(checkoutStart(id), String(id)).toBeNull();
    }
  });
});

describe("the offer's clock", () => {
  test("counts down in hours, minutes and seconds", () => {
    expect(countdownLabel(48 * 60 * 60 * 1000)).toBe("48:00:00");
    expect(countdownLabel(47 * 3_600_000 + 59 * 60_000 + 12_000 + 999)).toBe("47:59:12");
    expect(countdownLabel(-5)).toBe("00:00:00");
  });
});
