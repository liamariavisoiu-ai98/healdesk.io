import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";

import PrivacyPage from "./page";

/**
 * What the privacy policy says happens to the website read at checkout.
 *
 * The read goes back to the browser, and this website keeps nothing; but
 * pressing Pay sends it, with the rest of the purchase, to the product, which
 * keeps it on the checkout intent (apps/app's checkout_intents.profile) so
 * that setup can start from it. Until 6 October 2026 the policy said only the
 * first half, and its retention list said the read was "not stored by us at
 * all". The periods are apps/app's: INTENT_TTL_DAYS (14, from the last press
 * of Pay) for a purchase never completed, and CONSUMED_INTENT_RETENTION_DAYS
 * (90, from the account's creation) once it is.
 *
 * Read as text, the way terms-copy.test.ts reads the terms.
 */

function pageText(): string {
  return renderToStaticMarkup(h(PrivacyPage))
    .replace(/<style[\s\S]*?<\/style>/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

describe("the website read at checkout", () => {
  const text = pageText();

  test("is said to go to the product with the purchase when Pay is pressed, and to be kept there", () => {
    expect(text).toContain(
      "When you press Pay, what was read is sent with your other answers to the healdesk product, which keeps it with your purchase so that setup can start from it",
    );
  });

  test("has its retention stated, in the checkout section and in the retention list", () => {
    expect(text).toContain(
      "it is deleted 14 days after you last pressed Pay if the purchase is not completed, and otherwise 90 days after your account is created",
    );
    expect(text).toContain(
      "What was read from them, once you press Pay: kept with your purchase, and deleted 14 days after you last pressed Pay if the purchase is not completed, otherwise 90 days after your account is created.",
    );
  });
});
