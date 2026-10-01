import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";

import { ENTITY, GUARANTEE_TEXT, LEGAL_VERSION, POLICY } from "@/lib/legal";

import TermsPage from "./page";

/**
 * The terms must describe v1, and only v1.
 *
 * docs/v1-product-spec.md is what the product does. The terms used to carry
 * sentences from the product before it — a call-back the agent places, a
 * direct booking addendum, a report of "which recovered contacts became
 * revenue" — and two descriptions of a dead phone line ("forwarded calls are
 * not answered until you do", "forwarded calls are lost") that the spec's
 * failure rule forbids outright. A clinic that signed those terms would have
 * agreed to a product that does not exist and to a failure mode the product
 * must never have.
 *
 * Rendered to static markup and read as text, the way the admin honesty rules
 * and the checkout copy are: the text is the contract, so the question is
 * what it says, not which element says it.
 */

function pageText(): string {
  return renderToStaticMarkup(h(TermsPage))
    .replace(/<style[\s\S]*?<\/style>/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

describe("the terms describe v1 as the spec defines it", () => {
  const text = pageText();

  test("the service is five inbound channels, booking into Google Calendar, no revenue claim", () => {
    expect(text).toContain("phone calls, website chat, Instagram, Messenger and WhatsApp");
    expect(text).toContain("books appointments straight into the Google Calendar you connect");
    expect(text).toContain('"Auto-confirm bookings" is on by default');
    expect(text).toContain(
      "conversations handled, appointments booked, calls answered that would otherwise have rung out, deposits collected and booked value",
    );
    expect(text).not.toContain("recovered contacts became revenue");
    expect(text).not.toContain("direct booking addendum");
    expect(text).not.toContain("Calls we place");
    expect(text).toContain("it places no calls, sends no text messages, and sends no reminders");
  });

  test("no degradation path produces a dead phone line", () => {
    expect(text).not.toContain("forwarded calls are not answered until you do");
    expect(text).not.toContain("forwarded calls are lost");
    expect(text).not.toContain("console");
    // Pause, suspension, the allowance cap and the end of the service all pass
    // calls straight through to the Practice's own direct line.
    expect(text).toContain("passed straight through to the direct line you gave us at setup");
    expect(text).toContain("forwarded calls are passed straight through to your direct line (section 8) rather than answered");
    expect(text).toContain(
      `at least ${POLICY.forwardingPassThroughDays} days after the service ends or until you remove call forwarding, whichever is first`,
    );
    expect(text).toContain("a direct phone number for your Practice that is not itself forwarded to us");
  });

  test("the AI line opens every channel and says calls are transcribed", () => {
    expect(text).toContain("On every channel the assistant's first line says it is an AI assistant");
    expect(text).toContain("on calls the same line says the call is transcribed, and no call audio is kept");
  });

  test("the model's 30-day retention is disclosed and liability is allocated once", () => {
    expect(text).toContain("keeps that content for 30 days, for abuse detection, and then deletes it; it never trains on it");
    expect(text).toContain("in the same way as sections 13 and 14");
    expect(text).toContain("in the same way as this section and section 13");
    expect(text).toContain("These limits do not apply to our wilful misconduct or gross negligence");
    expect(text).toContain("civil money penalty a regulator imposes on us for our own conduct");
  });
});

describe("the first-month guarantee", () => {
  const text = pageText();

  test("is rendered word for word from the shared constant, so /pricing can carry the same words", () => {
    for (const para of GUARANTEE_TEXT.paragraphs) {
      expect(text).toContain(`${para.lead} ${para.body}`);
    }
  });

  test("quotes the thresholds and the claim route from POLICY and ENTITY, with no placeholder left", () => {
    const whole = GUARANTEE_TEXT.paragraphs.map((p) => `${p.lead} ${p.body}`).join("\n");
    expect(whole).toContain(`within ${POLICY.guaranteeCallAnswerSeconds} seconds of the call reaching us`);
    expect(whole).toContain(`within ${POLICY.guaranteeMessageAnswerSeconds} seconds of the message reaching us`);
    expect(whole).toContain(`Calls that end within ${POLICY.guaranteeAbandonedCallSeconds} seconds`);
    expect(whole).toContain(`Within ${POLICY.guaranteeClaimWindowDays} days after your first month ends, the account owner emails ${ENTITY.supportEmail}`);
    expect(whole).toContain("One refund per practice.");
    expect(whole).toContain("one month at your plan's annual per-month price");
    expect(whole).toContain("one of our suppliers failed does count as missed");
    expect(whole).not.toMatch(/\[|\]/);
    expect(whole).not.toMatch(/revenue/i);
  });

  test("sits outside the disclaimer, the liability cap and force majeure, and the refunds do not stack", () => {
    expect(text).toContain("EXCEPT FOR THE FIRST-MONTH GUARANTEE IN SECTION 5, THE SERVICE IS PROVIDED");
    expect(text).toContain("The guarantee refund is not limited by section 13, and section 19 does not apply to it");
    expect(text).toContain("The first-month guarantee refund in section 5 is not limited by this section");
    expect(text).toContain("except for payment obligations and the first-month guarantee in section 5");
    expect(text).toContain("at most one refund of its first period's fee");
    expect(text).toContain("Sections 5, 7 and 9 to 20 survive termination");
  });

  test("the page carries the version that introduced it", () => {
    expect(LEGAL_VERSION).toBe("2026-10-01.2");
    expect(text).toContain(`Version ${LEGAL_VERSION}`);
  });
});
