import {
  BAA_1_6_0_RELEASED,
  isDpaReleased,
  MODEL_RETENTION_EXCEPTIONS,
  MODEL_RETENTION_PUBLIC,
  OVERAGE_RATES_PROVISIONAL,
  TRANSCRIPT_RETENTION_DAYS,
  USAGE_ALERT_PERCENT,
} from "@healdesk/catalog";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";

import { ENTITY, GUARANTEE_TEXT, LEGAL_VERSION, POLICY, packagesForTerms, productsForTerms } from "@/lib/legal";

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
    expect(text).toContain("it places no calls, and sends no reminders");
    // The one optional text after a booking call (owner, 28 October 2026),
    // phrased as design while nothing sends it.
    expect(text).toContain(
      "There is one optional exception, which is off unless you turn it on: after a booking by phone, if the caller says yes and reads their number back, the agent is designed to send that caller one text with your Practice's own payment link, in fixed words that name no treatment, time or amount. It is sent once, for that call, and never again.",
    );
    expect(text).toContain("Payment-link texts. If you turn on the payment-link text");
    // Softened on 30 October 2026 (owner, LEGAL_VERSION 2026-10-30.1): no
    // sender is chosen, so the Terms promise neither a carrier registration
    // nor how long one takes, only the steps the carriers require.
    expect(text).toContain(
      "Payment-link texts. If you turn on the payment-link text, you agree that it is designed to go out under your Practice's name, and that we may take the steps the phone carriers require before it can be sent. You can turn it off at any time, and it stops on the next call.",
    );
    expect(text).not.toContain("the text goes out under your Practice's name");
    expect(text).not.toMatch(/register your Practice/i);
    expect(text).not.toMatch(/one to four weeks/i);
    expect(text).not.toMatch(/carrier registration/i);
    expect(text).toContain(
      "or, if you have turned on the payment-link text, is designed to offer to text the caller your Practice's payment link.",
    );
  });

  test("no degradation path produces a dead phone line", () => {
    expect(text).not.toContain("forwarded calls are not answered until you do");
    expect(text).not.toContain("forwarded calls are lost");
    expect(text).not.toContain("console");
    // Pause, suspension, the allowance cap and the end of the service all pass
    // calls straight through to the Practice's own direct line.
    // Each location's calls go to that location's own line (owner, 20
    // October 2026): one direct line "given at setup" would send a second
    // location's callers to the first location's desk.
    expect(text).toContain("passed straight through to the direct line you gave us for that location");
    expect(text).not.toContain("the direct line you gave us at setup");
    expect(text).toContain("forwarded calls are passed straight through to your direct line (section 8) rather than answered");
    expect(text).toContain(
      `at least ${POLICY.forwardingPassThroughDays} days after the service ends or until you remove call forwarding, whichever is first`,
    );
    expect(text).toContain("a direct phone number for each of your locations that is not itself forwarded to us");
  });

  test("the AI line opens every channel and says calls are transcribed", () => {
    expect(text).toContain("On every channel the assistant's first line says it is an AI assistant");
    expect(text).toContain(
      "on calls the same line says the call is transcribed, that we keep no call audio and that our voice provider holds a recording for no more than a day",
    );
  });

  test("the model's 30-day retention is disclosed as Anthropic documents it, and liability is allocated once", () => {
    // Anthropic's documentation for the models the product calls
    // (claude-opus-5-5 and claude-sonnet-5-5, not Covered Models): no more
    // than 30 days under the standard retention of a HIPAA-ready
    // organisation, two years for flagged content alone, and as long as the
    // law requires for what the law requires (packages/catalog
    // model-retention.ts; agreement-changes.md § 17). Section 9 prints the
    // catalog's sentences; the annex its exceptions sentence.
    expect(text).toContain(MODEL_RETENTION_PUBLIC);
    expect(text).toContain(
      "it keeps conversation content for no more than the 30 days of its standard retention, and then deletes it.",
    );
    // "Conversation content", never "inputs": the provider keeps and deletes
    // inputs and outputs alike.
    expect(text).toContain(
      "The AI model provider keeps conversation content for up to 30 days. Our model provider's own business associate agreement covers its service only under its standard retention, which we do not control",
    );
    expect(text).not.toMatch(/keeps (conversation )?inputs/);
    expect(text.split(MODEL_RETENTION_EXCEPTIONS).length - 1).toBe(2);
    // What Anthropic says only of its Covered Models, a purpose it does not
    // state, and a cap on law-required content it does not give.
    expect(text).not.toContain("cannot run with shorter retention");
    expect(text).not.toContain("cannot run with none");
    expect(text).not.toContain("for abuse detection and security");
    expect(text).not.toMatch(/covered models? require/i);
    expect(text).not.toMatch(/law requires it to keep[^.]*two years/);
    expect(text).not.toMatch(/never trains/);
    // BAA 1.6.0, released by the owner on 29 October 2026 and the version
    // signed since, states Anthropic's retention as section 9 does
    // (MODEL_RETENTION_AGREEMENT), so the terms say so again; 1.5.1, offered
    // until then, carried the old clause and the sentence was held back.
    expect(BAA_1_6_0_RELEASED).toBe(true);
    expect(text).toContain("The Business Associate Agreement states the same.");
    expect(text).toContain("consistently with sections 13 and 14");
    expect(text).toContain("consistently with this section and section 13");
    expect(text).toContain("These limits do not apply to our wilful misconduct or gross negligence");
    expect(text).toContain("civil money penalty a regulator imposes on us for our own conduct");
  });

  test("the model provider's agreement is a promise about when it is signed, not a fact", () => {
    // BAA 1.3.0's Subcontractors clause: Anthropic receives conversation
    // content "only under a business associate agreement with healdesk signed
    // before any patient's information reaches it". That agreement is an
    // owner item and is not signed yet (release gate 17), so the terms may
    // not describe it as in force (release gate 14). The page names no
    // vendor (the owner's direction of 9 October 2026).
    // The support drafter (owner, 27 October 2026; apps/app
    // lib/support/draft/email.ts) sends a clinic's support email to the same
    // provider, under the same agreement, for a reply a person approves.
    expect(text).toContain(
      "Our language-model provider receives the content of each conversation, to generate the agent's replies, and may receive the text of an email your Practice sends to our support, to draft our reply, which one of our team approves before it is sent. It receives both only under a business associate agreement with us signed before any patient's information reaches it.",
    );
    expect(text).toContain(
      "We process no real patient information for your Practice until each business associate agreement in the chain is in place: yours with us, and ours with every vendor that will handle it, which are our hosting provider, our database provider, our voice provider and our language-model provider.",
    );
    expect(text).not.toContain("Under its business associate agreement with us it keeps");
  });

  test("the opening line's promise of a person is a duty the Practice has agreed to", () => {
    // The assistant tells a caller who asks for a person that the practice
    // will get back to them. Without this the line promises something nobody
    // is bound to do (docs/counsel/state-disclosure.md, decision 1).
    expect(text).toContain(
      "Requests for a person. When a caller or visitor asks for a person, the assistant takes their details and alerts the contact you named. You get back to them within 24 hours, as the assistant tells them you will.",
    );
  });

  test("ending the Data Agreement ends the subscription that day, with the refund only where 1.3.0 gives one", () => {
    // BAA 1.3.0's Term clause: "Terminating this agreement ends the Services
    // on the same day. Where Practice terminates because healdesk has violated
    // a material term, or under the Subcontractors clause, no Fees accrue for
    // any time after that day, and healdesk refunds any Fees Practice has paid
    // for that time." Its Liability clause keeps that refund outside the
    // exclusion and the indemnity, and its Definitions clause lets it govern
    // the Terms on termination and the Fees (release gate 14). The owner
    // confirmed on 12 October 2026 how it works, for the BAA and the DPA
    // alike: every ending stops fees that day; the refund is the prorated
    // unused part of the paid period, never the setup fee or overage already
    // billed, nothing before the plan starts, and nothing on any other ending.
    expect(text).toContain(
      'In these terms your Data Agreement means that Business Associate Agreement or, for a Practice that signs our data protection agreement in its place, that agreement. Where these terms and your Data Agreement differ about terminating it and what then happens to the service and your fees, your Data Agreement controls (section 15).',
    );
    expect(text).toContain(
      "However your Data Agreement ends, your subscription and the service end on the same day, and no fees accrue for any time after that day.",
    );
    expect(text).toContain(
      "A refund is owed only where you terminate your Data Agreement because we have violated a material term of it, or under its Subcontractors clause after objecting to a new subprocessor. We then refund the fees you have paid for the time after that day: the prorated unused part of the subscription period you have paid for, which on an annual plan is the rest of the year. The refund never includes the setup fee or usage above the allowance already billed, and if your plan has not started (section 3) there is nothing to refund.",
    );
    expect(text).toContain(
      "Where we terminate your Data Agreement because of your breach, or it ends in any other way, this section refunds nothing.",
    );
    expect(text).toContain(
      "If your Data Agreement ends, however it ends, your subscription ends with it on the same day, not at the end of the period you have paid for, and no fees accrue for any time after that day.",
    );
    expect(text).toContain(
      "the agent stops answering when it ends, which is at the end of the paid period, or on the day your Data Agreement ends if that comes first (section 15)",
    );
    expect(text).toContain("and neither is the refund section 15 gives when you terminate your Data Agreement");
    expect(text).toContain("It does not extend to a claim for the refund section 15 gives.");
  });

  test("cancelling is the portal's Auto-renew switch, because Stripe's portal offers no cancel", () => {
    // apps/web/scripts/stripe-account-settings.ts switches subscription_cancel
    // off in Stripe's Customer Portal; apps/app's Billing screen carries the
    // Auto-renew switch, and ops turns it off for a Practice that emails.
    expect(text).toContain("in your portal, open Billing and turn Auto-renew off");
    expect(text).not.toContain("cancel at end of period");
    expect(text).not.toContain("open the billing portal");
  });

  test("leaving delivers an export within 30 days, then destruction on the agreement's terms", () => {
    // The Data Agreement's Term clause (the BAA's, or the DPA's since its
    // release on 20 October 2026): an export within thirty days of
    // termination, then destruction. The terms must not promise a different
    // order or a different clock.
    // No transcript is in it since 13 October 2026: each reached the clinic
    // by email when its conversation ended (BAA 1.4.0 clause 11).
    expect(text).toContain(
      "Within 30 days of the end we deliver an export of your data — the records of your conversations and the booking log; the transcripts themselves reached you by email as each conversation ended — and we then destroy our copies when and as your Data Agreement says.",
    );
    expect(text).not.toContain("transcripts and the booking log");
    expect(text).not.toContain("before destroying our copies on the schedule");
  });
});

describe("usage above the allowance is billed per started block of 100", () => {
  const text = pageText();

  test("section 3 states the block rule plainly, with nothing of our costs", () => {
    // The owner's decision of 6 October 2026 (docs/v1-product-spec.md,
    // "Overage prices"), kept by the pricing sheet of 13 October: each
    // started block of 100 past the allowance is billed at the product's
    // extra-100 price, $104 for voice minutes and $52 or $78 for chat
    // conversations. Stripe bills exactly that from the same catalog, and
    // src/lib/overage-copy.test.ts holds the table's prices to it.
    if (OVERAGE_RATES_PROVISIONAL) return;
    expect(text).toContain(
      "Usage above the included allowance is billed in blocks: each month, every started block of 100 extra voice minutes or 100 extra chat conversations is billed at that product's price for each extra 100 in the table above, so a single minute or conversation over the allowance is billed as a whole block, and the same applies above the largest step.",
    );
    // Owner, 30 October 2026: no client-facing copy calls the rates
    // provisional or talks about what usage costs us to serve.
    expect(text).not.toMatch(/provisional|costs to serve|measured what/i);
    expect(text).toContain(
      "On a monthly plan the blocks are billed in arrears on the next invoice; on an annual plan they are invoiced separately, monthly in arrears, at the same prices.",
    );
    expect(text).toContain("Each extra 100, per started block of 100");
  });

  test("the 90% email is promised, and what follows when the Practice does not move up", () => {
    // The sheet: "When you use 90% of your included amount, we send you a
    // short email", with the choice to move up a step or let the next block
    // bill at the extra-100 price.
    expect(text).toContain(
      `When you have used ${USAGE_ALERT_PERCENT}% of an allowance we email the address on your account, so you can move up a step before you go over; if you do not, usage above it is billed as this paragraph says.`,
    );
  });

  test("and nothing in the terms is priced per minute or per conversation", () => {
    expect(text).not.toContain("per voice minute and per chat conversation");
    // Word boundaries, because "extra voice minutes" holds "a voice minute".
    expect(text).not.toMatch(
      /\/min\b|\/conversation|\bper (?:voice )?minute|\bper (?:chat )?conversation|\ba voice minute|\ba chat conversation|\$0\.\d\d/i,
    );
  });
});

describe("section 3 states the step pricing of 13 October 2026", () => {
  const text = pageText();

  test("every product's price per 100, monthly and annual, and its setup fee, from the catalog", () => {
    for (const product of productsForTerms()) {
      const units = `${product.unit}s`;
      expect(text, product.name).toContain(
        `${product.name} $${product.perStepMonthlyUsd} per 100 ${units} $${(product.perStepAnnualMonthlyUsd * 12).toLocaleString("en-US")} per 100 ${units}`,
      );
      expect(text, product.name).toContain(`$${product.setupFeeUsd.toLocaleString("en-US")}`);
    }
  });

  test("every package and its setup fee: $259 to $1,394 at list price", () => {
    for (const pkg of packagesForTerms()) {
      expect(text, pkg.name).toContain(`${pkg.name} $${pkg.setupFeeUsd.toLocaleString("en-US")}`);
    }
    expect(packagesForTerms().map((p) => p.setupFeeUsd).sort((a, b) => a - b)).toEqual([259, 697, 697, 956, 1_394]);
  });

  test("a plan is a package and its steps, and the steps are the allowance", () => {
    expect(text).toContain(
      "Your plan is the package you choose and, for each product in it, the step you choose: from 100 to 1,500 minutes or conversations a month, in steps of 100. The minutes and conversations your steps include are your monthly allowance.",
    );
    expect(text).toContain("the annual price is 20% less than twelve monthly prices");
    expect(text).toContain("Moving between steps of the same package carries no setup fee.");
    expect(text).toContain("AYA Meta Chat answers on Instagram, Messenger and WhatsApp and includes website chat.");
  });

  test("prices are per location, and a further location is the plan's price again plus its setup fee", () => {
    expect(text).toContain("Each covers one location.");
    expect(text).toContain(
      "Each further location is added to your subscription at your plan's price again, on the same renewal date and prorated to it, plus the package's setup fee once.",
    );
  });

  test("one AYA answers for every location, and only the Practice's own locations join its account", () => {
    // The owner's decision of 20 October 2026, and the extra-locations
    // plan's section 3: a location is part of one account answered by one
    // central assistant. A sister company is a separate business, which the
    // agreement's one named Practice does not cover.
    expect(text).toContain(
      "One AYA answers for all of your locations as a central assistant, like a call centre: one knowledge base, one price list and one sign-in, not a separate assistant for each location.",
    );
    expect(text).toContain(
      "Every location you add must be operated by the Practice that accepted these terms; a location run by a different business needs its own account.",
    );
  });

  test("a further location's setup fee says when it is charged and what it pays for", () => {
    // "Charged once, on your first invoice" is the first location's fee; a
    // further location's is charged when it is added (decision 4).
    expect(text).toContain(
      "The setup fee is charged once, on your first invoice, and pays for building, configuring and testing your agent. A further location's setup fee is charged when the location is added, and pays for setting that location up, its number where your package has phone, and a QA pass.",
    );
  });

  test("one setup credit applies to a purchase, and to the setup fee alone", () => {
    expect(text).toContain(
      "A setup credit, where one was offered to you by email, with a personalised demo, or on our website, is taken off the setup fee at checkout while the offer holds and is applied to nothing else; only one applies to a purchase.",
    );
    // The fixed packages of 5 October are gone from the contract.
    expect(text).not.toMatch(/Complete Frontdesk|Web or Meta|1,197|\$997/);
  });
});

describe("refunds say what is refunded, how, and when", () => {
  const text = pageText();

  test("the setup fee is never refunded, and section 5 says so too", () => {
    // The owner's decision of 6 October 2026: the work starts the moment the
    // fee is paid. It ended the one exception adopted on 3 October
    // (docs/counsel/guarantee-and-refund.md, decision 5), for a Practice
    // with nothing live 30 days after payment.
    expect(text).toContain("That work starts as soon as it is paid, so the setup fee is never refunded.");
    expect(text).toContain("The setup fee is never refunded (section 3).");
    expect(text).not.toContain("except in one case");
    expect(text).not.toContain("except as section 3 says");
    expect(text).not.toMatch(/founding/i);
  });

  test("billing starts on the plan start, and everything that counts from a date counts from it", () => {
    expect(text).toContain("Your plan starts the day the agent first answers a patient.");
    expect(text).toContain("Until then your subscription carries a $0 monthly line, and the setup fee is all you have paid.");
    expect(text).toContain("the price is that of the package made up of those channels");
    expect(text).toContain("counted from your plan start (section 3)");
    expect(text).toContain(`If you cancel within ${POLICY.refundWindowDays} days of your plan start we refund the first period's subscription fee in full.`);
    expect(text).toContain("If you cancel before your plan starts, it never starts");
    // No date in the terms counts from the first payment any more, and
    // nothing here is a trial.
    expect(text).not.toContain("first payment");
    expect(text).not.toMatch(/\btrial\b/i);
  });

  test("an account with nothing live after 30 days is closed, keeping only what the law requires", () => {
    expect(text).toContain("You have 30 days to finish setup.");
    expect(text).toContain("we email you a reminder every five days");
    expect(text).toContain(
      "If at the end of the 30th day after your payment none of them is, your subscription is cancelled and your account closed: nothing more is charged, nothing is refunded, and we keep only your signed Data Agreement and the billing records the law requires us to keep.",
    );
  });

  test("everything goes to the account's one address, and nothing describes roles v1 does not have", () => {
    expect(text).toContain("If a subscription payment fails we retry it and email the address on your account.");
    expect(text).toContain("Your Practice has one sign-in, the email address on your account");
    expect(text).toContain("Notices to you go to the email address on your account.");
    expect(text).not.toContain("any password");
    expect(text).not.toContain("billing contact");
    expect(text).not.toContain("public inbox");
  });

  test("the annual-plan asymmetry is stated in section 4, not only discovered in section 5", () => {
    expect(text).toContain(
      `Under section 5 an annual plan is refunded in one of two amounts: the whole first year's subscription fee if you cancel within ${POLICY.refundWindowDays} days of your plan start, or, under the first-month guarantee, one month at your plan's annual per-month price.`,
    );
  });

  test("a refund to a leaving Practice goes back to whatever it paid with, not only a card", () => {
    expect(text).toContain("where the Practice is leaving, it is returned to the payment method you paid with");
    expect(text).not.toContain("returned to the card");
  });
});

describe("the first-month guarantee", () => {
  const text = pageText();

  test("is rendered word for word from the shared constant, so checkout can carry the same words", () => {
    for (const para of GUARANTEE_TEXT.paragraphs) {
      expect(text).toContain(`${para.lead} ${para.body}`);
    }
  });

  test("a call is routed to it when it is forwarded to the healdesk number of any of the Practice's locations", () => {
    // With one AYA number per location (decision 1), "the healdesk number
    // assigned to your practice" would leave a second location's forwarded
    // calls outside the guarantee.
    const routed = GUARANTEE_TEXT.paragraphs.find((p) => p.lead === "Routed to it")!.body;
    expect(routed).toContain(
      "means: a phone call your carrier forwards to a healdesk number assigned to one of your locations, from the moment your carrier's record or ours shows the forward;",
    );
    expect(routed).not.toContain("assigned to your practice");
  });

  test("quotes the thresholds and the claim route from POLICY and ENTITY, with no placeholder left", () => {
    const whole = GUARANTEE_TEXT.paragraphs.map((p) => `${p.lead} ${p.body}`).join("\n");
    expect(whole).toContain(`within ${POLICY.guaranteeCallAnswerSeconds} seconds of the call reaching us`);
    expect(whole).toContain(`within ${POLICY.guaranteeMessageAnswerSeconds} seconds of the message reaching us`);
    expect(whole).toContain(`calls the caller ends within ${POLICY.guaranteeAbandonedCallSeconds} seconds of reaching us`);
    expect(whole).toContain(
      `A call the caller ends after ${POLICY.guaranteeAbandonedCallSeconds} seconds and before the opening line has started does count as missed.`,
    );
    expect(whole).toContain(`Your first month is the ${POLICY.guaranteeFirstMonthDays} days that start on your plan start, the day the assistant first answers a patient`);
    expect(whole).toContain(`Within ${POLICY.guaranteeClaimWindowDays} days after your first month ends, the account owner emails ${ENTITY.email}`);
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
      "It does not limit your rights under your Data Agreement, or for anything other than the missed call or message itself.",
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

  test("has been in the terms since the version that introduced it, and the page prints its version", () => {
    // Introduced in 2026-10-05.2. Versions are dated, so later ones sort after
    // it; legal-version.test.ts is what pins each version's exact text.
    expect(LEGAL_VERSION >= "2026-10-05.2").toBe(true);
    expect(text).toContain(`Version ${LEGAL_VERSION}`);
  });
});

describe("the terms point at no retired page, and name one address", () => {
  const text = pageText();

  test("prices are the ones shown at checkout; the vendor list is given on request", () => {
    // The owner disabled /pricing and deleted /subprocessors on 9 October
    // 2026; a contract that sends its reader to either sends them to nothing.
    // /pricing came back on 13 October, but the contract still states its own
    // prices and binds the ones shown at checkout, so it does not link a
    // marketing page whose wording changes without a new version.
    expect(text).toContain("are the prices shown at checkout when you subscribe");
    expect(text).toContain(
      "The list of the subcontractors that process patient information for us is given to you on request, under the Business Associate Agreement.",
    );
    // The page's own links; the navbar and the footer have owners of their own.
    const markup = renderToStaticMarkup(h(TermsPage));
    const main = markup.slice(markup.indexOf("<main"), markup.indexOf("</main>"));
    expect(main).not.toMatch(/href="\/(?:pricing|subprocessors|trust)\b/);
  });

  test("notices, and everything else, go to the one address", () => {
    expect(text).toContain(`Notices to us go to ${ENTITY.email} .`);
    expect(text.match(/[\w.+-]+@healdesk\.io/g)?.every((address) => address === ENTITY.email)).toBe(true);
  });
});

/**
 * The content of /trust, moved into the terms on 9 October 2026 as an annex.
 * The Business Associate Agreement incorporates this page by its address, so
 * the annex must say, before anything else, that it describes our practices
 * and binds nobody, and that the agreement governs patient information.
 */
describe("the annex on how we protect data", () => {
  const markup = renderToStaticMarkup(h(TermsPage));
  const annex = pageTextOf(markup.slice(markup.indexOf('id="security"'), markup.indexOf("</main>")));

  test("is the last thing on the page, after section 20, under its own anchor", () => {
    expect(markup.indexOf('id="security"')).toBeGreaterThan(markup.indexOf('id="entity"'));
    expect(annex.startsWith("How we protect data")).toBe(true);
  });

  test("says the locations of one account are not kept apart from each other", () => {
    // Row-level security separates accounts. Under one central AYA the
    // locations of an account share it, and anyone with its sign-in sees
    // every location's conversations and bookings (owner, 20 October 2026).
    expect(annex).toContain(
      "names the clinic column. The locations of one account share that account, so they are not kept apart from each other.",
    );
  });

  test("opens by saying it is not a term of the agreement", () => {
    expect(annex).toContain(
      "How we protect data This annex describes our practices for protecting information. It is provided for information only and is not a term of this agreement, and it changes as our practices do. The Data Agreement you sign at checkout (section 1) governs patient information.",
    );
  });

  test("states the spec's breach clock, for breaches and security incidents alike", () => {
    expect(annex).toContain(
      "We tell the clinic of a breach of unsecured patient information, and of any other security incident whether or not it turns out to be a breach, without unreasonable delay and in no case later than 10 calendar days after discovery.",
    );
    expect(annex).not.toMatch(/five calendar days|within five business days of/);
  });

  test("says transcripts are emailed to the clinic and not kept, and claims no audit", () => {
    // BAA 1.4.0 clause 11 (owner, 13 October 2026; LEGAL_VERSION 2026-10-13.3),
    // and since 14 October 2026 BAA 1.5.0's: the copy goes once delivery is
    // confirmed (LEGAL_VERSION 2026-10-14.1).
    expect(annex).toContain(
      "Transcripts are emailed to the clinic, not kept. When a call or a website chat ends, its transcript is emailed to the address on the clinic's account, only over an encrypted connection. The one encrypted copy we hold so that a failed email can be sent again is deleted as soon as the clinic's mail server confirms delivery. An email that fails is sent again until it is delivered, but the copy is never kept more than 30 days after the transcript was queued, and one whose delivery is never confirmed is deleted 72 hours after it was sent; from then on the email is the clinic's record. We keep a record that each transcript was delivered, without what was said.",
    );
    expect(annex).toContain(
      `The record of each conversation, without what was said, is deleted ${TRANSCRIPT_RETENTION_DAYS} days after it took place.`,
    );
    expect(annex).not.toMatch(/shorter period in your portal|first line of every transcript/);
    expect(annex).toContain("the record of each call notes when it was given");
    expect(annex).toContain("No SOC 2 report exists.");
  });

  test("counts no vendor and promises no notice period for a new one", () => {
    expect(annex).not.toMatch(/\b(?:\d+|two|three|four|five|six|seven|eight|nine|ten) vendors\b/i);
    expect(annex).not.toMatch(/days before a vendor is added|fifteen days|15 days/i);
    expect(annex).toContain("The list of these subcontractors is given to clinics on request");
  });
});

function pageTextOf(markup: string): string {
  return markup
    .replace(/^[^>]*>/, "")
    .replace(/<style[\s\S]*?<\/style>/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The Meta channels, no more strongly than BAA 1.3.0's clause 16 as the owner
 * softened it on 12 October 2026: each message checked before the model sees
 * it, no message and no summary kept, the assistant instructed, each reply
 * checked by filters designed to keep clinical content out, a refused reply
 * replaced by a fixed one, and no filter catching every wording. Section 9 and
 * the annex used to say clinical content was "caught on arrival" and "not
 * stored", and that replies "never name a treatment", which no word list can
 * promise.
 */
describe("the Meta channels are described as the agreement describes them", () => {
  const text = pageText();

  test("section 9 and the annex say instructed, filtered, replaced, and not every wording", () => {
    for (const sentence of [
      "We check each message a person sends there for clinical content before the language model sees it, and keep no message there and no summary of one. The agent is instructed not to repeat clinical content, name a treatment or confirm appointment details there",
      "We check each message for clinical content before the language model sees it, and keep no message there and no summary of one. The assistant is instructed not to repeat clinical content, name a treatment or confirm appointment details there",
    ]) {
      expect(text).toContain(sentence);
    }
    const filtered = text.match(
      /Each reply the language model writes there is checked by automated filters designed to keep those out, and a reply the filters refuse is replaced by a fixed one\. No filter catches every wording, so do not invite patients to send clinical information on these channels\./g,
    );
    expect(filtered?.length, "section 9 and the annex both carry it").toBe(2);
  });

  test("and nothing stronger", () => {
    expect(text).not.toMatch(
      /caught on arrival|caught when it arrives|is not stored|not repeated back|never name a treatment|never sends clinical content|keeps none|repeats none|confirms no appointment details|not kept at all|scoped to carry nothing clinical|every later use/i,
    );
  });
});

/**
 * On Instagram, Messenger and WhatsApp the assistant takes booking requests
 * and books nothing (lib/meta/front-door.ts calls createBookingRequest and no
 * calendar writer). Since LEGAL_VERSION 2026-10-29.3 (DEP-META slice 1) it
 * sends the practice's own payment link there only after staff confirm a
 * request inside the conversation's window, as one fixed line with no amount,
 * treatment or time (apps/app/src/lib/meta/deposit-link.ts); the model itself
 * still refuses deposits and links. Section 9 once said it "can book and can
 * send your own payment link", and 2026-10-29.1 said it "sends no payment link".
 */
describe("the Meta assistant takes booking requests, and sends the payment link only after staff confirm one", () => {
  const text = pageText();

  test("sections 2 and 9 say so", () => {
    expect(text).toContain(
      "On Instagram, Messenger and WhatsApp it books nothing: it takes booking requests for your staff to confirm, and where you take deposits and your staff confirm a request while that conversation is still open, it is designed to send your own hosted payment link there, with no amount, treatment or time in the message.",
    );
    expect(text).toContain(
      "and takes booking requests for your staff to confirm, and where you take deposits it may send your own hosted payment link there once your staff confirm one, inside that window only.",
    );
    expect(text).not.toMatch(/sends no payment link/);
    expect(text).toContain("sends a hosted deposit link in website chat");
    expect(text).not.toMatch(/can book and (?:can )?send your own payment link/);
  });
});

/**
 * "Business Associate Agreement" only where the BAA itself is meant (plan
 * Part A6: "Data Agreement" is defined, BAA or DPA, "with a test that fails on
 * stray 'Business Associate Agreement' wording outside BAA passages").
 *
 * Section 2 defines the Data Agreement as the BAA or, for a practice that
 * signs the data protection agreement in its place, the DPA. So the defined
 * term "Business Associate Agreement" belongs only where the BAA is the point:
 * the definition, section 9 on HIPAA's own agreement, and the claims only the
 * BAA makes. Everywhere else the agreement meant is the practice's Data
 * Agreement, whichever kind it signed.
 *
 * Until the owner released the DPA on 20 October 2026 (catalog
 * `isDpaReleased()`), every practice signed the BAA, so eleven passages said
 * "Business Associate Agreement" where they meant the Data Agreement and were
 * listed here as true for the time being. The release made them false for a
 * DPA practice, and LEGAL_VERSION 2026-10-20.1 says "Data Agreement" in each,
 * so the list is gone: every use is now a BAA passage, or the test fails. The
 * lowercase noun (a vendor's business associate agreement) and the plural
 * are the general term, not the document, and are not read.
 */
describe('"Business Associate Agreement" only where the BAA is meant', () => {
  const DEFINED_TERM = /Business Associate Agreement(?!s)|BUSINESS ASSOCIATE AGREEMENT(?!S)/;

  /** Where the BAA itself is the point. */
  const BAA_PASSAGES: readonly { text: string; why: string }[] = [
    { text: "Patient information is governed by the separate Business Associate Agreement you sign at checkout.", why: "section 2's definition" },
    { text: "the Business Associate Agreement controls (section 9).", why: "section 2's definition" },
    { text: "In these terms your Data Agreement means that Business Associate Agreement or", why: "the definition of the Data Agreement" },
    { text: "Patient information and the Business Associate Agreement", why: "section 9's title: HIPAA's agreement" },
    { text: "Where your Practice is a covered entity under HIPAA, the Business Associate Agreement you sign at checkout is the agreement required by 45 CFR 164.502(e)", why: "section 9: HIPAA's own requirement" },
    { text: "is given to you on request, under the Business Associate Agreement.", why: "section 9: the BAA's subcontractor clause" },
    { text: "The Business Associate Agreement states the same.", why: "section 9: BAA 1.6.0's Subcontractors clause states the model's retention (the DPA states it word for word too, and section 9 carries over to it)" },
    { text: "which is the exception the Business Associate Agreement makes", why: "the annex: the BAA's telephone exception" },
    { text: "ours are in the Business Associate Agreement.", why: "the annex: HIPAA's obligations" },
    { text: "the way to check ours is to read the Business Associate Agreement", why: "the annex: HIPAA's obligations" },
  ];

  /** Every sentence of the terms that uses the defined term, as a reader sees it. */
  function sentences(): string[] {
    const markup = renderToStaticMarkup(h(TermsPage));
    const main = markup.slice(markup.indexOf("<main"), markup.indexOf("</main>"));
    return main
      .replace(/<style[\s\S]*?<\/style>/g, "")
      .split(/<\/(?:p|li|td|th|h[1-6]|summary)>/)
      .map((block) =>
        block
          .replace(/<[^>]+>/g, " ")
          .replace(/&quot;/g, '"')
          .replace(/&#x27;/g, "'")
          .replace(/&amp;/g, "&")
          .replace(/\s+/g, " ")
          .trim(),
      )
      .flatMap((block) => block.split(/(?<=[.!?;])\s+(?=[A-Z"])/))
      .filter((sentence) => DEFINED_TERM.test(sentence));
  }

  const found = sentences();
  const isBaaPassage = (s: string) => BAA_PASSAGES.some((p) => s.includes(p.text));

  test("the scan finds the definition, so it is reading the terms", () => {
    expect(found.some((s) => s.includes("In these terms your Data Agreement means"))).toBe(true);
    // Nine since the DPA's release, each one where the BAA itself is meant.
    expect(found.length).toBeGreaterThanOrEqual(BAA_PASSAGES.length);
  });

  test("every use is a BAA passage: the DPA is released, so a practice may have signed it instead", () => {
    expect(isDpaReleased()).toBe(true);
    expect(
      found.filter((s) => !isBaaPassage(s)),
      'A practice may have signed the DPA: where the Data Agreement is meant, say "Data Agreement" (bump LEGAL_VERSION).',
    ).toEqual([]);
  });

  test("where the Data Agreement is meant, the terms say so, and section 9 carries over to the DPA", () => {
    const markup = renderToStaticMarkup(h(TermsPage));
    const words = markup.replace(/<[^>]+>/g, " ").replace(/&#x27;|&apos;/g, "'").replace(/\s+/g, " ");
    for (const text of [
      "we keep only your signed Data Agreement and the billing records",
      "we then destroy our copies when and as your Data Agreement says.",
      "Patient information is covered by your Data Agreement, not by this section.",
      "EXCEPT AS EXPRESSLY STATED IN THESE TERMS OR YOUR DATA AGREEMENT",
      "Your Data Agreement allocates liability for patient information consistently with this section",
      "Nothing in these terms or in your Data Agreement shifts to you a civil money penalty",
      "These terms, your Data Agreement and the order you complete at checkout are the entire agreement",
      "The Data Agreement you sign at checkout (section 1) governs patient information.",
      "under your Data Agreement, and that is the only place",
      "given to clinics on request, under each clinic's Data Agreement.",
      "It does not limit your rights under your Data Agreement",
      "For a Practice that signs our data protection agreement in its place (section 1), everything this section says of that agreement it says of the data protection agreement.",
    ]) {
      expect(words, text).toContain(text);
    }
  });

  test("every listed passage is still in the terms, so the list does not outlive its sentence", () => {
    for (const { text } of BAA_PASSAGES) expect(found.some((s) => s.includes(text)), text).toBe(true);
  });

  test("the rule catches a stray use, and leaves the general noun alone", () => {
    const stray = "Your Business Associate Agreement ends when your subscription does.";
    expect(DEFINED_TERM.test(stray) && !isBaaPassage(stray)).toBe(true);
    expect(DEFINED_TERM.test("each under a business associate agreement with us")).toBe(false);
    expect(DEFINED_TERM.test("Meta, which does not sign Business Associate Agreements.")).toBe(false);
  });
});
