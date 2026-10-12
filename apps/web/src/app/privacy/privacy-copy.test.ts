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

/**
 * What BAA 1.3.0 says this page says (release gate 12,
 * docs/counsel/agreement-changes.md § 12.14).
 *
 * Its clause headed "healdesk's own use, and de-identified statistics" says
 * healdesk "commits publicly, at healdesk.io/privacy, to keep and use that
 * information only in de-identified form and not to try to re-identify it".
 * Until 12 October 2026 nothing here said so. Its Google Calendar clause lets
 * a practice that books by provider choose one calendar per provider, where
 * section 11 said the clinic "chooses which calendar". And its reporting
 * clause gives 24 hours where section 9 said five calendar days.
 */
describe("the commitments BAA 1.3.0 points at", () => {
  const text = pageText();

  test("section 14 makes the de-identification commitment, in the clause's terms", () => {
    expect(text).toContain(
      "We commit to keep and use it only in de-identified form and not to try to re-identify it, and we will not re-identify, or try to re-identify, any individual from it.",
    );
    expect(text).toContain(
      "only to produce aggregate statistics about the service, such as what fraction of after-hours calls are answered. We use those statistics only to measure and improve the service.",
    );
    expect(text).toContain("Anyone we give it to must meet the same conditions under a contract with us.");
  });

  test("section 11 allows the calendar or one per provider, and reads nothing else", () => {
    expect(text).toContain(
      "chooses the calendar the assistant books into or, where it books by provider, one calendar for each provider",
    );
    expect(text).not.toContain("chooses which calendar");
    expect(text).toContain("the product does not read or store any of them");
    expect(text).not.toContain("It uses other events on the calendar");
  });

  test("section 9 gives the agreement's 24 hours", () => {
    expect(text).toContain("and in any case within 24 hours of discovery");
    expect(text).not.toContain("five calendar days");
  });
});
