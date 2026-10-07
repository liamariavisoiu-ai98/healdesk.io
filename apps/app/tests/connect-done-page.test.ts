import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";

import ConnectStripeDonePage from "@/app/connect/stripe/done/page";
import { connectReturnPath } from "@/lib/billing/connect";

/**
 * /connect/stripe/done, the public page an operator's Connect link lands on
 * (BD28). Anyone can open it with any query, so it must print nothing it was
 * told: a page on our real origin that echoed text from its URL would let a
 * crafted link put an attacker's sentence ("Payment failed. Pay at …") under
 * our name, and no filter that still passes a real business name stops a
 * plain sentence. The connected account's name is read on the server by the
 * ops panel and the portal instead.
 */

async function render(query: Record<string, string>): Promise<string> {
  return renderToStaticMarkup(
    await ConnectStripeDonePage({ searchParams: Promise.resolve(query) }),
  );
}

describe("the Connect done page", () => {
  test("prints no account text from its query, whatever it says", async () => {
    const html = await render({
      result: "ok",
      account: "Payment failed. Pay at acme-payouts.com",
    });
    expect(html).toContain("Your Stripe account is connected");
    expect(html).not.toContain("Payment failed");
    expect(html).not.toContain("acme-payouts");
  });

  test("an operator's successful connect lands on the bare result, with no name in the URL", () => {
    const target = { clinicId: "c-1", slug: "glow", returnTo: "ops" as const };
    expect(
      connectReturnPath({ status: "connected", target, accountLabel: "Glow Aesthetics" }),
    ).toBe("/connect/stripe/done?result=ok");
  });

  test("an unknown result reads as a failure", async () => {
    expect(await render({ result: "constructor" })).toContain(
      "We couldn’t connect your Stripe account",
    );
  });
});
