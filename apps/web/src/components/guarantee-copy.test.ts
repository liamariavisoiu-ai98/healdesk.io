import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";

import { GUARANTEE_TEXT } from "@/lib/legal";

import { Guarantee } from "./Guarantee";
import TermsPage from "@/app/terms/page";

/**
 * One guarantee, two pages, identical words.
 *
 * The spec ("The guarantee") requires the pricing page and the service
 * agreement to carry the same text. Both render GUARANTEE_TEXT, so the
 * cheapest way for them to drift is for one of them to stop rendering it, or
 * to render a different paragraph set. This reads both as text and checks
 * every paragraph is present in each, word for word.
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

describe("the first-month guarantee reads the same on the pricing page and in the terms", () => {
  const pricing = toText(renderToStaticMarkup(h(Guarantee)));
  const terms = toText(renderToStaticMarkup(h(TermsPage)));

  test("every paragraph of the guarantee is on both pages, word for word", () => {
    for (const para of GUARANTEE_TEXT.paragraphs) {
      const sentence = `${para.lead} ${para.body}`;
      expect(pricing, `pricing page lacks: ${para.lead}`).toContain(sentence);
      expect(terms, `terms lack: ${para.lead}`).toContain(sentence);
    }
  });

  test("the pricing page states the material conditions, not a summary with a link", () => {
    // FTC Act § 5: an advertised guarantee's conditions must be clear where it
    // is advertised. The "what does not count" and "limits" paragraphs are the
    // conditions, and a reader of /pricing must not need /terms to find them.
    expect(pricing).toContain("What does not count:");
    expect(pricing).toContain("One refund per practice.");
    expect(pricing).toContain("The setup fee is not refundable under this guarantee or otherwise.");
  });

  test("the guarantee text carries no unfilled placeholder", () => {
    const whole = GUARANTEE_TEXT.paragraphs.map((p) => `${p.lead} ${p.body}`).join("\n");
    expect(whole).not.toMatch(/\[[^\]]*\]/);
    expect(whole).not.toMatch(/\bTBD\b|\bTODO\b/i);
  });
});
