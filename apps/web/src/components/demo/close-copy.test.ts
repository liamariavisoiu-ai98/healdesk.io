import { createElement as h, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => undefined }) }));

import { ASSUMED_SHOW_RATE, type RoiInputs } from "@/lib/demo/roi";
import type { WeekSchedule } from "@/lib/demo/opening-hours";

import { ClosingOffer, objections } from "./ClosingOffer";
import { CoverageModes } from "./CoverageModes";
import { CloseCard, DemoCloseProvider, OfferPrice, TopOfferBar } from "./DemoClose";
import { ValueTiles } from "./ValueTiles";

/**
 * What the redesigned demo close says, rendered and read as text against the
 * spec's rules (docs/v1-product-spec.md, root CLAUDE.md "Claims and copy"):
 * no revenue or money collected, no unqualified "HIPAA compliant", no refund
 * or guarantee language beside a fee that is never refunded, no timing for a
 * channel going live, no outbound contact, and one label on every button.
 */

const inputs: RoiInputs = {
  priceUsd: 425,
  priceSource: "Wrinkle Treatment, from your website",
  bookingRate: 0.35,
  showRate: ASSUMED_SHOW_RATE,
  repeat: null,
  missedCallsPerWeek: 8,
  missedMessagesPerWeek: 4,
};

const week: WeekSchedule = {
  listed: true,
  days: [[[540, 1080]], [[540, 1080]], [[540, 1080]], [[540, 1080]], [[540, 1080]], [[600, 960]], []],
};

function page(endsAt: string | null): ReactElement {
  return h(DemoCloseProvider, {
    slug: "peachy-studio-abcdefgh23",
    clinicName: "Peachy Studio",
    logoUrl: null,
    selfServe: false,
    initialInputs: inputs,
    terms: { percent: 50, endsAt },
    initialEnded: { voice: true, chat: true },
    children: [
      h(TopOfferBar, { key: "bar", demoClock: null, copyLink: null }),
      h(CloseCard, { key: "card", channel: "voice" }),
      h(CoverageModes, { key: "coverage", schedule: week, source: { kind: "website" } }),
      h(ValueTiles, { key: "value", schedule: week }),
      h(OfferPrice, { key: "offer", placement: "closing" }),
      h(ClosingOffer, { key: "closing" }),
    ],
  });
}

function text(element: ReactElement): string {
  return renderToStaticMarkup(element)
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&rsquo;|&#8217;/g, "’")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");
}

const LIVE = "2099-01-01T00:00:00.000Z";

describe("the demo close's copy", () => {
  const live = text(page(LIVE));
  const ended = text(page(null));

  test.each([
    [/revenue/i, "revenue"],
    [/collected/i, "collected"],
    [/HIPAA compliant/i, "an unqualified HIPAA claim"],
    [/refund|money.back|guarantee/i, "refund language beside a non-refundable fee"],
    [/live in (two |\d+ )?minutes|within \d+ (minutes|hours)/i, "a time to go live"],
    [/coming soon|opening (date|soon)/i, "a channel not on sale"],
    [/\btexts?\b|SMS|remind|follow.?up|win.?back/i, "outbound contact"],
    [/book (my )?onboarding/i, "a label that does not say what it does"],
    [/most clinics/i, "a claim about clinics we cannot back"],
    [/ring out/i, "an assumption about what the clinic's phone does"],
    [/mindbody|boulevard|cal\.com|emr|point of sale/i, "an integration v1 does not write to"],
  ])("never %s (%s)", (pattern) => {
    expect(live).not.toMatch(pattern);
    expect(ended).not.toMatch(pattern);
  });

  test("the data line is the spec's own", () => {
    expect(live).toContain("We sign a business associate agreement and handle patient data under it.");
  });

  test("set-up is about fifteen minutes of the clinic's time, not a time to go live", () => {
    expect(live).toContain("About 15 minutes of your time");
  });

  test("the offer is in dollars, struck through, with what is saved, while it holds", () => {
    expect(live).toMatch(/50% off setup/);
    expect(live).toMatch(/You save \$\d/);
    expect(live).toMatch(/ends in/);
  });

  test("once it has ended: the standard fee, said plainly, and no clock", () => {
    expect(ended).not.toMatch(/% off setup|You save|ends in/);
    expect(ended).toContain("This is the standard setup fee.");
  });

  test("every estimate says so, and the money figure is booked value", () => {
    expect(live.match(/Estimate/g)?.length).toBeGreaterThanOrEqual(2);
    expect(live).toContain("Booked value");
    expect(live).toContain("first visits only");
  });

  test("the close card says what the demo was and what pressing does", () => {
    expect(live).toContain("That was your AYA.");
    expect(live).toContain("Make her live");
  });

  test("chat answers in every coverage mode, and the three modes are named", () => {
    expect(live).toContain("Chat answers 24/7 in every mode.");
    for (const mode of ["After hours only", "Overflow + after hours", "All calls"]) expect(live).toContain(mode);
  });

  test("the objections are answered from what v1 does", () => {
    const answers = objections("Peachy Studio", "AYA").map((o) => o.a).join(" ");
    expect(answers).toMatch(/AI assistant in her first line/);
    expect(answers).toMatch(/Google Calendar/);
    expect(answers).toMatch(/keep your number/);
    expect(answers).toMatch(/direct line/);
  });
});
