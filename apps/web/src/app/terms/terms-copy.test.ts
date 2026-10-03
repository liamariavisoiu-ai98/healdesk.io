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
    // Anthropic's own retention page: 30 days, except flagged or legally
    // required content, which it may keep for up to two years. The terms
    // must carry the exception, or they overstate what happens.
    expect(text).toContain("keeps that content for 30 days, for abuse detection, and then deletes it, except content");
    expect(text).toContain("which it may keep for up to two years; it never trains on it");
    expect(text).toContain("in the same way as sections 13 and 14");
    expect(text).toContain("in the same way as this section and section 13");
    expect(text).toContain("These limits do not apply to our wilful misconduct or gross negligence");
    expect(text).toContain("civil money penalty a regulator imposes on us for our own conduct");
  });

  test("the opening line's promise of a person is a duty the Practice has agreed to", () => {
    // The assistant tells a caller who asks for a person that the practice
    // will get back to them. Without this the line promises something nobody
    // is bound to do (docs/counsel/state-disclosure.md, decision 1).
    expect(text).toContain(
      "Requests for a person. When a caller or visitor asks for a person, the assistant takes their details and alerts the contact you named. You get back to them within 24 hours, as the assistant tells them you will.",
    );
  });

  test("leaving delivers an export within 30 days, then destruction on the agreement's terms", () => {
    // The Business Associate Agreement's Term clause: an export within thirty
    // days of termination, then destruction. The terms must not promise a
    // different order or a different clock.
    expect(text).toContain(
      "Within 30 days of the end we deliver an export of your data — transcripts and the booking log — and we then destroy our copies when and as the Business Associate Agreement says.",
    );
    expect(text).not.toContain("before destroying our copies on the schedule");
  });
});

describe("refunds say what is refunded, how, and when", () => {
  const text = pageText();

  test("the setup fee has exactly one exception, and section 5 points to it", () => {
    // A flat "never refundable" for a service that was never delivered is the
    // term the FTC Act and a card dispute both reach
    // (docs/counsel/guarantee-and-refund.md, decision 5).
    expect(text).toContain(
      `It is not refundable, except in one case. If none of your channels has gone live within ${POLICY.setupFeeRefundNotLiveDays} days of your payment, and the delay is not caused by something still waiting on you (such as connecting your calendar or a channel, or setting up call forwarding), we refund the setup fee.`,
    );
    expect(text).toContain("The setup fee is not refundable, except as section 3 says.");
    // The flat versions are gone from both sections.
    expect(text).not.toContain("It is not refundable. Moving");
    expect(text).not.toMatch(/The setup fee is not refundable\.\s/);
  });

  test("the annual-plan asymmetry is stated in section 4, not only discovered in section 5", () => {
    expect(text).toContain(
      `Under section 5 an annual plan is refunded in one of two amounts: the whole first year's subscription fee if you cancel within ${POLICY.refundWindowDays} days of your first payment, or, under the first-month guarantee, one month at your plan's annual per-month price.`,
    );
  });

  test("a refund to a leaving Practice goes back to whatever it paid with, not only a card", () => {
    expect(text).toContain("where the Practice is leaving, it is returned to the payment method you paid with");
    expect(text).not.toContain("returned to the card");
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
    expect(whole).toContain(`calls the caller ends within ${POLICY.guaranteeAbandonedCallSeconds} seconds of reaching us`);
    expect(whole).toContain(
      `A call the caller ends after ${POLICY.guaranteeAbandonedCallSeconds} seconds and before the opening line has started does count as missed.`,
    );
    expect(whole).toContain(`Your first month is the ${POLICY.guaranteeFirstMonthDays} days that start on the day your first channel goes live`);
    expect(whole).toContain(`Within ${POLICY.guaranteeClaimWindowDays} days after your first month ends, the account owner emails ${ENTITY.supportEmail}`);
    expect(whole).toContain(`We tell you our finding within ${POLICY.guaranteeFindingBusinessDays} business days of your claim.`);
    expect(whole).toContain(
      `to the payment method you paid with, within ${POLICY.guaranteeRefundWithinDays} days of that finding`,
    );
    expect(whole).toContain(`we tell the account owner by email within ${POLICY.guaranteeMissNoticeDays} days of recording it, whether or not you have claimed`);
    expect(whole).toContain("One refund per practice, meaning one account");
    expect(whole).toContain("one month at your plan's annual per-month price, meaning the annual fee divided by twelve");
    expect(whole).toContain("one of our suppliers failed counts as missed whatever the cause of that failure");
    expect(whole).toContain("Your carrier, Google and Meta are not our suppliers.");
    expect(whole).toContain("The setup fee is not part of this guarantee.");
    expect(whole).toContain(
      "It does not limit your rights under the Business Associate Agreement, or for anything other than the missed call or message itself.",
    );
    expect(whole).not.toContain("to the card you paid with");
    expect(whole).not.toMatch(/\[|\]/);
    expect(whole).not.toMatch(/revenue/i);
  });

  test("tells a claimant to keep patient details out of the claim", () => {
    // The claim goes to hello@, a mailbox on the no-PHI side, and a carrier
    // record lists patients' numbers. The redaction instruction sits right
    // after the sentence that invites the records.
    const claim = GUARANTEE_TEXT.paragraphs.find((p) => p.lead === "How to claim.")!.body;
    expect(claim).toContain(
      "or a screenshot of an unanswered message in your Instagram, Messenger or WhatsApp inbox. Send dates and times, not names: black out every phone number on a carrier record or screenshot except its last four digits, and never send a transcript. A call your carrier's record shows",
    );
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
    expect(LEGAL_VERSION).toBe("2026-10-03.2");
    expect(text).toContain(`Version ${LEGAL_VERSION}`);
  });
});
