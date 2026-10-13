import { getPlan } from "@healdesk/catalog";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";

import TermsPage from "@/app/terms/page";
import type { AgreementResult } from "@/components/checkout/AgreementStep";
import { ReviewStep } from "@/components/checkout/ReviewStep";
import { siteReadLine } from "@/lib/checkout/site-read";
import { GUARANTEE_TEXT } from "@/lib/legal";

/**
 * One guarantee, two places, identical words.
 *
 * The spec ("The guarantee") requires the guarantee to read the same where it
 * is advertised as in the service agreement. Until 9 October 2026 the place it
 * was advertised was /pricing; the owner disabled that page that day, and the
 * guarantee is now met where the prices are, at checkout's Review and pay
 * step, in full (16 CFR 239.3(b): the conditions where the claim is made).
 * /pricing came back on 13 October 2026 without the guarantee on it, so
 * Review and pay is still the one place it is advertised; a pricing page
 * that names it must render GUARANTEE_TEXT in full and join this test.
 * Both render GUARANTEE_TEXT, so the cheapest way for them to drift is for
 * one of them to stop rendering it, or to render a different paragraph set.
 * This reads both as text and checks every paragraph is present in each,
 * word for word.
 */

function toText(markup: string): string {
  return markup
    .replace(/<style[\s\S]*?<\/style>/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

const SIGNED: AgreementResult = {
  agreementId: "6f1b0c9e-8f2a-4d31-9c77-1a2b3c4d5e6f",
  version: "1.2.1",
  hash: "a".repeat(64),
  text: "HEALDESK BUSINESS ASSOCIATE AGREEMENT\n\n1. Definitions...",
  acceptedAt: "2026-10-06T10:00:00.000Z",
  approvedByCounsel: true,
};
const noop = () => undefined;

/** Review and pay, as a buyer of AYA Voice at 500 minutes sees it, from its guarantee block to its end. */
function reviewGuarantee(): string {
  const markup = renderToStaticMarkup(
    h(ReviewStep, {
      plan: getPlan("voice-500")!,
      interval: "month",
      specialty: "med-spa",
      clinicName: "Glow Med Spa LLC",
      siteRead: siteReadLine(null, "glowmedspa.com"),
      salesTax: false,
      agreement: SIGNED,
      copyLink: h("a", { href: "#" }, "Download"),
      termsAccepted: false,
      onTerms: noop,
      submitting: false,
      error: null,
      onPay: noop,
      onBack: noop,
    }),
  );
  const start = markup.indexOf('aria-labelledby="guarantee-heading"');
  expect(start, "Review and pay no longer has its guarantee block").toBeGreaterThan(0);
  return toText(markup.slice(markup.lastIndexOf("<section", start), markup.indexOf("</section>", start)));
}

describe("the first-month guarantee reads the same at checkout and in the terms", () => {
  const checkout = reviewGuarantee();
  const terms = toText(renderToStaticMarkup(h(TermsPage)));

  test("every paragraph of the guarantee is in both, word for word", () => {
    for (const para of GUARANTEE_TEXT.paragraphs) {
      const sentence = `${para.lead} ${para.body}`;
      expect(checkout, `Review and pay lacks: ${para.lead}`).toContain(sentence);
      expect(terms, `terms lack: ${para.lead}`).toContain(sentence);
    }
  });

  test("checkout states the material conditions, not a summary with a link", () => {
    // FTC Act § 5: an advertised guarantee's conditions must be clear where it
    // is advertised. The "what does not count" and "limits" paragraphs are the
    // conditions, and a buyer at Review and pay must not need /terms to find
    // them.
    expect(checkout).toContain("What does not count:");
    expect(checkout).toContain("One refund per practice, meaning one account");
    // The setup fee sits outside the guarantee, said in its first paragraph,
    // which is why the block is never a "money-back guarantee" (16 CFR
    // 239.3(a)).
    expect(checkout).toContain("The setup fee is not part of this guarantee.");
    expect(checkout).toContain("This refund is your only remedy for a call or message missed during your first month.");
  });

  test("nothing above the block says more than its first sentence", () => {
    // docs/counsel/guarantee-and-refund.md, "Advertising the guarantee", rule
    // 1. The eyebrow "If she misses one, the month is on us" dropped the
    // first-month, routed and setup-fee conditions, so it is gone; the heading
    // is the guarantee's name and claims nothing.
    const beforeBlock = checkout.slice(0, checkout.indexOf(GUARANTEE_TEXT.paragraphs[0].lead));
    expect(beforeBlock.trim()).toBe(GUARANTEE_TEXT.heading);
    expect(checkout).not.toMatch(/month is on us/i);
  });

  test("the guarantee text carries no unfilled placeholder", () => {
    const whole = GUARANTEE_TEXT.paragraphs.map((p) => `${p.lead} ${p.body}`).join("\n");
    expect(whole).not.toMatch(/\[[^\]]*\]/);
    expect(whole).not.toMatch(/\bTBD\b|\bTODO\b/i);
  });
});
