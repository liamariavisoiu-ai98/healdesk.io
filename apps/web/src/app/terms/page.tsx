import {
  MAX_STEP_UNITS,
  MIN_STEP_UNITS,
  OVERAGE_BLOCK_UNITS,
  OVERAGE_RATES_PROVISIONAL,
  STEP_UNITS,
  TRANSCRIPT_RETENTION_DAYS,
  USAGE_ALERT_PERCENT,
} from "@healdesk/catalog";
import type { Metadata } from "next";

import { LegalPage, Section } from "@/components/LegalPage";
import {
  ENTITY,
  GUARANTEE_TEXT,
  POLICY,
  entityDisplayName,
  packagesForTerms,
  productsForTerms,
} from "@/lib/legal";
import { annualSavingsPercent, extraBlockUsd } from "@/lib/pricing";
import { site } from "@/lib/site";
import { phiAgreementsOutstanding } from "@/lib/subprocessors";

export const metadata: Metadata = {
  alternates: { canonical: "/terms" },
  title: "Terms of service",
  description:
    "The subscription agreement for healdesk: packages and fees, automatic renewal and how to cancel, the setup fee, refunds and the first-month guarantee, what the AI does and does not do, liability, and how patient information is governed; with an annex on how we protect data.",
};

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

/**
 * The terms of service and subscription agreement.
 *
 * Every number comes from packages/catalog/src/plans.ts, so a pricing change
 * is a contract change in the same commit and the terms can never quote a
 * stale figure. The founder-supplied facts (entity, governing law, liability
 * floor, refund window, guarantee thresholds) come from src/lib/legal.ts and
 * drive the wording below: a zero refund window renders as "no refund window",
 * not as a blank. The first-month guarantee in section 5 is rendered from
 * GUARANTEE_TEXT there, because the spec requires the identical words
 * wherever the guarantee is advertised; checkout's Review and pay step
 * renders the same object beside the prices.
 *
 * What the service is (section 2) follows docs/v1-product-spec.md: inbound
 * only on five channels, booking straight into the Practice's Google Calendar,
 * a deposit link in chat, nothing clinical, and no claim of revenue. Every
 * degradation path — pause, suspension, allowance cap, the end of the service
 * — passes forwarded calls straight through to the Practice's own direct line
 * (sections 2, 6, 7 and 8), because the spec's rule is that non-payment never
 * produces a dead phone line.
 *
 * The contracting party on the page is the trade name, "healdesk". The legal
 * entity behind it is named exactly once, in section 20 ("Operating entity
 * and company information"), the way the Scalabid site does it: the Delaware
 * mailbox printed there is correspondence-only, no UAE street address is
 * published, and formal notices (section 18) go by email. Decision of
 * 23 September 2026, docs/handover.md "Decisions log", item 14. Do not name
 * the entity anywhere else on this page.
 *
 * Order of precedence is stated in section 9 and matters: the Business
 * Associate Agreement signed at checkout controls for patient information,
 * these terms for everything else. The two must not be read as conflicting,
 * which is why sections 9, 13 and 14 describe one liability allocation and
 * say the Business Associate Agreement makes the same one.
 *
 * Finalised by the owner on 1 October 2026 without external counsel review,
 * and revised the same way on 3 October 2026 (the setup-fee exception in
 * section 3, the annual-plan refunds in section 4, the export in section 7,
 * the handover duty in section 8); docs/counsel/agreement-changes.md § 7 and
 * guarantee-and-refund.md record what changed and the choices made.
 *
 * Revised to the owner's decisions of 6 October 2026, and published on
 * 7 October 2026 as LEGAL_VERSION 2026-10-07.1. The decisions are recorded in
 * docs/v1-product-spec.md ("Stage 1, payment" and "The guarantee"): billing
 * starts on the plan start, the day the agent first answers a patient, and
 * renewal, the first-period refund and the guarantee's first month all run
 * from it (sections 3 to 5); the setup fee is never refunded, which ends the
 * 3 October exception, and an account with nothing live 30 days after payment
 * is closed (section 3); a failed payment is emailed to the account's one
 * address (section 6).
 *
 * Revised the same day as LEGAL_VERSION 2026-10-07.2, to the owner's
 * decision of 6 October 2026 (docs/v1-product-spec.md, "Overage prices"):
 * usage above the allowance is billed per started block of 100 extra minutes
 * or conversations, not per unit, and section 3's table prints each package's
 * block prices from the catalog (`overageBlockPrices`, the prices Stripe
 * bills), marked provisional until measured.
 *
 * Revised to the owner's decisions of 9 October 2026, as LEGAL_VERSION
 * 2026-10-09.1. There is no pricing page any more, so section 3's prices are
 * the ones shown at checkout. No vendor is named publicly: the list of the
 * subcontractors that handle patient information is given to a Practice on
 * request under the Business Associate Agreement (section 9), and section 3's
 * payment processor goes unnamed. hello@healdesk.io is the one address,
 * notices included (sections 18 and 20). And the content of /trust moved here
 * as the closing annex, "How we protect data" (id "security", where /trust
 * now redirects): our practices, for information, expressly not a term of
 * this agreement, because the Business Associate Agreement incorporates this
 * page by its address and must not pick up promises it does not itself make.
 * The annex follows the spec's breach clock (without unreasonable delay and
 * in no case later than 60 calendar days after discovery) in place of /trust's five
 * days, and names no vendor and counts none. It does not name the entity
 * either, for the reason above: section 20 is the one place on this page that
 * does. The same version carries the package names the personalised demo's
 * branch gave them on 7 October (AYA Web Chat, AYA Meta Chat, AYA Voice, AYA
 * Complete Frontdesk), which section 3's table reads from the catalog: that
 * branch numbered them 2026-10-07.3 on its own line, which never went out.
 *
 * Revised on 12 October 2026 as LEGAL_VERSION 2026-10-12.2, for BAA 1.3.0
 * (release gate 14, docs/counsel/agreement-changes.md § 12.14):
 *   - section 1 defines the "Data Agreement": the Business Associate
 *     Agreement, or the data protection agreement a Practice signs in its
 *     place, and gives it 1.3.0's (and the DPA's) precedence on termination
 *     and fees;
 *   - sections 4, 7 and 15 give the rule the owner confirmed on 12 October
 *     2026, which 1.3.0's Term clause (third paragraph) and Subcontractors
 *     clause state for the BAA: every ending of the Data Agreement ends the
 *     subscription and the service, and stops fees, the same day; a refund is
 *     owed only where the Practice terminates for our violation of a material
 *     term or under the Subcontractors clause, and is the prorated unused
 *     part of the paid subscription period (the rest of the year on an annual
 *     plan), never the setup fee or overage already billed, and nothing
 *     before the plan starts; any other ending refunds nothing. The Terms
 *     give it whichever version a Practice signed, and to a DPA Practice,
 *     whose agreement refunds only the objection today (docs/counsel/dpa.md,
 *     gap 17). Sections 13 and 14 leave that refund outside the exclusion and
 *     the indemnity, as 1.3.0's Liability clause does;
 *   - section 4's cancellation is the portal's Auto-renew switch (apps/app,
 *     Billing), or an email ops acts on; Stripe's portal has cancellation
 *     off (apps/web/scripts/stripe-account-settings.ts);
 *   - section 9 states the language-model provider's agreement as 1.3.0's
 *     Subcontractors clause states Anthropic's, as a promise about when it is
 *     signed, and says no real patient information is processed until every
 *     agreement in the chain is in place. It names no vendor, as the owner's
 *     direction of 9 October 2026 has it; sections 9 and 14 say "consistently
 *     with" (ICD-16);
 *   - section 9's Meta paragraph and the annex's Instagram, Messenger and
 *     WhatsApp item say no more than 1.3.0's softened clause 16, which the
 *     owner chose on 12 October 2026: each message checked before the model
 *     sees it; no message and no summary kept; the assistant instructed not
 *     to repeat clinical content, name a treatment or confirm appointment
 *     details there; each reply checked by automated filters designed to keep
 *     those out, a refused reply replaced by a fixed one; and, since no
 *     filter catches every wording, no invitation to send clinical
 *     information there. "Caught on arrival", "not stored" and "replies never
 *     name a treatment" are gone;
 *   - sections 2 and 9 say the Meta assistant takes booking requests for staff
 *     to confirm and sends no payment link, which is what the code does:
 *     lib/meta/front-door.ts creates booking requests and books nothing, its
 *     prompt forbids deposits and links, and nothing calls
 *     depositLinkMessage (lib/booking/deposit-gate.ts). Section 2's deposit
 *     link is "in website chat", not "in chat".
 *
 * Revised on 13 October 2026 as LEGAL_VERSION 2026-10-13.3, for BAA 1.4.0
 * (docs/counsel/agreement-changes.md § 14): the owner decided that day that
 * healdesk keeps no transcript.
 *   - section 7's export holds the records of the clinic's conversations and
 *     the booking log, and says the transcripts reached the clinic by email,
 *     where it promised "transcripts and the booking log";
 *   - the annex's "Transcripts are deleted automatically" item says each
 *     call's and website chat's transcript is emailed to the clinic's address
 *     over an encrypted connection, that the one copy held to send a failed
 *     email again goes seven days after the email is first accepted (or after
 *     it was queued, if it never is), and that the conversation's record,
 *     without what was said, goes at 90 days, where it said each
 *     conversation and its transcript went at 90 days "or sooner if you
 *     choose a shorter period in your portal", a setting that is gone;
 *   - the annex's opening-line item says the record of each call notes when
 *     the line was given (conversations.disclosure_played_at), where it said
 *     the line is "the first line of every transcript", which healdesk no
 *     longer holds (docs/counsel/state-disclosure.md, decision 3).
 *
 * Revised to the owner's pricing sheet of 13 October 2026, as LEGAL_VERSION
 * 2026-10-13.4. The seven packages with fixed allowances are gone: a Practice
 * picks one of five packages and a usage step for each product in it, 100 to
 * 1,500 minutes or conversations a month, and the steps it picks are its
 * allowance. Section 3 therefore prints a table of the three products (their
 * price per 100, annual and monthly, each one's extra-100 price and its setup
 * fee) and one of the five packages' setup fees, every figure from the
 * catalog, rather than one row per plan: there are 495 plans. Overage is
 * still per started block of 100, now at the product's extra-100 price,
 * provisional; the 90% email the sheet promises is stated, with what follows
 * if the Practice does not move up; prices are per location, and a further
 * location is the same plan price again plus its setup fee; and the setup
 * credits are the four the catalog defines, only one of which applies to a
 * purchase. The deferred start, the non-refundable setup fee and the refund
 * window are unchanged.
 */
export default function TermsPage() {
  const products = productsForTerms();
  const packages = packagesForTerms();
  const state = ENTITY.governingLawState || "[governing-law state]";
  return (
    <LegalPage
      title="Terms of service"
      intro="The agreement between a clinic and healdesk: what you buy, what it costs, how it renews, how you leave, and who is responsible for what."
    >
      <Section id="parties" title="1. The agreement">
        <p>
          These terms are between {site.name} ("we", "us"; the professional services brand
          described in section 20) and the business that subscribes ("you", the "Practice"). By
          clicking the button at checkout you accept them on the Practice's behalf and confirm
          you are authorised to. They are a business contract; the service is not offered to
          consumers.
        </p>
        <p>
          Patient information is governed by the separate <strong>Business Associate Agreement</strong>{" "}
          you sign at checkout. Where the two conflict on anything about patient information, the
          Business Associate Agreement controls (section 9). In these terms your{" "}
          <strong>Data Agreement</strong> means that Business Associate Agreement or, for a
          Practice that signs our data protection agreement in its place, that agreement. Where
          these terms and your Data Agreement differ about terminating it and what then happens to
          the service and your fees, your Data Agreement controls (section 15).
        </p>
      </Section>

      <Section id="service" title="2. What the service is, and is not">
        <p>
          {site.name} is an AI front desk. {site.agent} answers your Practice's phone calls,
          website chat, Instagram, Messenger and WhatsApp, on the channels you buy, from the
          services, prices, hours and policies you approve; qualifies enquiries; books
          appointments straight into the Google Calendar you connect, during the conversation,
          holding the slot before anything is confirmed; sends a hosted deposit link in website
          chat, through your own payment gateway, where you want one; routes anything clinical to
          your Practice; and reports conversations handled, appointments booked, calls answered that
          would otherwise have rung out, deposits collected and booked value, meaning the bookings
          it made multiplied by your own configured prices. It does not report revenue, because
          it cannot see it. "Auto-confirm bookings" is on by default; you may instead set every
          booking to be a request your staff approve, and a Practice whose booking system does
          not read Google Calendar for conflicts runs that way (section 8). By phone it cannot
          take a payment: it books and flags the deposit for your staff to collect. On Instagram,
          Messenger and WhatsApp it books nothing: it takes booking requests for your staff to
          confirm, and sends no payment link. Card numbers are never taken on any channel.
        </p>
        <ul className="list-disc space-y-2 pl-6">
          <li>
            <strong>It is not a medical device and gives no medical advice.</strong> The agent
            declines clinical questions, gives no diagnosis, treatment plan or promise of an
            outcome, quotes no price outside your configured list, and routes anything clinical
            to your staff; a report of a complication or an urgent symptom goes at once to the
            contact you name. You will not configure it to diagnose, recommend treatment or
            triage, and you will not rely on it for emergencies. On every channel the assistant's
            first line says it is an AI assistant; on calls the same line says the call is
            transcribed, and no call audio is kept. You cannot switch that off or edit it out
            through the greeting.
          </li>
          <li>
            <strong>It works on your instructions.</strong> The services it offers, the prices it
            quotes and the hours it keeps are what you approve in onboarding. You are responsible
            for keeping them accurate.
          </li>
          <li>
            <strong>It never leaves you without a line.</strong> Your number stays yours: you
            forward it to the agent, in the coverage mode you choose, and you can remove that
            forwarding at any time without us. Whenever the agent is not answering — because you
            paused it, because the service is suspended for non-payment, because your monthly
            allowance has run out and your setting is "Stop and fall back", or because the
            service has ended or failed — forwarded calls are passed straight through to the
            direct line you gave us at setup (section 8) rather than answered by the agent, and
            website chat becomes a contact form. Each time, we also tell you how to remove the
            forwarding so calls reach your Practice exactly as they did before.
          </li>
        </ul>
      </Section>

      <Section id="fees" title="3. Packages and fees">
        <p>
          Prices are in US dollars, exclusive of any applicable sales tax, and are the prices shown
          at checkout when you subscribe. Each covers one location. The products at the date of
          these terms, priced per {STEP_UNITS} minutes of voice or {STEP_UNITS} chat conversations
          a month:
        </p>
        {/* The extra-100 prices are terms like the per-100 prices, so each
            product's row carries its own, from the catalog: they are the
            block prices Stripe bills (src/lib/overage-copy.test.ts). While
            the rates are held back (OVERAGE_RATES_PROVISIONAL) there is no
            price to print and the column is left out. */}
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-[14.5px]">
            <thead>
              <tr className="border-line border-b text-left">
                <th className="py-2 pr-3 font-semibold">Product</th>
                <th className="py-2 pr-3 font-semibold">Monthly, per {STEP_UNITS}</th>
                <th className="py-2 pr-3 font-semibold">Annual, per {STEP_UNITS} (per year)</th>
                {OVERAGE_RATES_PROVISIONAL ? null : (
                  <th className="py-2 pr-3 font-semibold">
                    Each extra {STEP_UNITS}, per started block of {OVERAGE_BLOCK_UNITS}
                  </th>
                )}
                <th className="py-2 font-semibold">One-time setup</th>
              </tr>
            </thead>
            <tbody>
              {products.map((p) => (
                <tr key={p.id} className="border-line border-b align-top">
                  <td className="py-2 pr-3 font-semibold">{p.name}</td>
                  <td className="py-2 pr-3">
                    {usd.format(p.perStepMonthlyUsd)} per {STEP_UNITS} {p.unit}s
                  </td>
                  <td className="py-2 pr-3">
                    {usd.format(p.perStepAnnualMonthlyUsd * 12)} per {STEP_UNITS} {p.unit}s
                  </td>
                  {OVERAGE_RATES_PROVISIONAL ? null : (
                    <td className="py-2 pr-3">
                      {usd.format(extraBlockUsd(p.id))} per {OVERAGE_BLOCK_UNITS} {p.unit}s
                    </td>
                  )}
                  <td className="py-2">{usd.format(p.setupFeeUsd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p>
          {products.find((p) => p.id === "metachat")?.name} answers on Instagram, Messenger and
          WhatsApp and includes website chat. The packages, and the one-time setup fee of each,
          which for a package of voice and chat is the two products&apos; setup fees added:
        </p>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[420px] text-[14.5px]">
            <thead>
              <tr className="border-line border-b text-left">
                <th className="py-2 pr-3 font-semibold">Package</th>
                <th className="py-2 font-semibold">One-time setup</th>
              </tr>
            </thead>
            <tbody>
              {packages.map((p) => (
                <tr key={p.id} className="border-line border-b align-top">
                  <td className="py-2 pr-3 font-semibold">{p.name}</td>
                  <td className="py-2">{usd.format(p.setupFeeUsd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p>
          <strong>Your plan</strong> is the package you choose and, for each product in it, the
          step you choose: from {MIN_STEP_UNITS} to {MAX_STEP_UNITS.toLocaleString("en-US")}{" "}
          minutes or conversations a month, in steps of {STEP_UNITS}. The minutes and
          conversations your steps include are your monthly allowance. The monthly price is each
          product&apos;s price per {STEP_UNITS} times its step, added together for a package of
          voice and chat; the annual price is {annualSavingsPercent()}% less than twelve monthly
          prices and is charged yearly in advance. Moving between steps of the same package
          carries no setup fee.
        </p>
        <p>
          <strong>Usage above the included allowance</strong> is billed in blocks: each month,
          every started block of {OVERAGE_BLOCK_UNITS} extra voice minutes or{" "}
          {OVERAGE_BLOCK_UNITS} extra chat conversations is billed{" "}
          {OVERAGE_RATES_PROVISIONAL
            ? "at block prices we will give you in writing before they apply. Until then, usage above the allowance is not billed."
            : "at that product's price for each extra 100 in the table above, so a single minute or conversation over the allowance is billed as a whole block, and the same applies above the largest step. These block prices are provisional until we have measured what that usage costs to serve. On a monthly plan the blocks are billed in arrears on the next invoice; on an annual plan they are invoiced separately, monthly in arrears, at the same prices."}{" "}
          When you have used {USAGE_ALERT_PERCENT}% of an allowance we email the address on your
          account, so you can move up a step before you go over; if you do not, usage above it is
          billed as this paragraph says. Nothing else is charged for usage.
        </p>
        <p>
          <strong>More than one location.</strong> Each further location is added to your
          subscription at your plan&apos;s price again, on the same renewal date and prorated to
          it, plus the package&apos;s setup fee once.
        </p>
        <p>
          <strong>The setup fee</strong> is charged once, on your first invoice, and pays for
          building, configuring and testing your agent. That work starts as soon as it is paid,
          so the setup fee is never refunded. Moving to a package with a higher setup fee charges
          only the difference. A setup credit, where one was offered to you by email, with a
          personalised demo, or on our website, is taken off the setup fee at
          checkout while the offer holds and is applied to nothing else; only one applies to a
          purchase.
        </p>
        <p>
          <strong>Your plan starts the day the agent first answers a patient.</strong> Until
          then your subscription carries a $0 monthly line, and the setup fee is all you have
          paid. On that day, your plan start, the package price replaces the $0 line and your
          first period is charged, monthly or yearly as you chose. If your package has more than
          one channel and only some of them are answering patients, the price is that of the
          package made up of those channels, at the steps you chose. Each further channel's price applies from the day it
          first answers, prorated: on your next invoice for a monthly package, and at once for the
          rest of the year for an annual one. A channel that is ready but still waiting on a step
          of yours, such as setting up call forwarding or adding the chat snippet to your
          website, is added at its price 30 days after it became ready or after your plan
          started, whichever is later, and we email you a week before.
        </p>
        <p>
          <strong>You have 30 days to finish setup.</strong> Some steps only you can take, such as
          connecting your calendar and channels and setting up call forwarding. While none of
          your channels is answering patients, we email you a reminder every five days. If at the
          end of the 30th day after your payment none of them is, your subscription is cancelled
          and your account closed: nothing more is charged, nothing is refunded, and we keep only
          the signed Business Associate Agreement and the billing records the law requires us to
          keep.
        </p>
        <p>
          Payments are processed through our payment processor account, which is linked to our
          operating entity (section 20).
        </p>
      </Section>

      <Section id="renewal" title="4. Automatic renewal, and how to cancel">
        <p>
          <strong>Your subscription renews automatically.</strong> A monthly package renews every
          month and an annual package every year, counted from your plan start (section 3), at
          the package price in force on that date, and your payment method on file is charged on
          that date. It continues to renew until you cancel.
        </p>
        <p>
          <strong>To cancel:</strong> in your portal, open Billing and turn Auto-renew off, or
          email{" "}
          <a href={`mailto:${ENTITY.email}`} className="underline underline-offset-2">
            {ENTITY.email}
          </a>{" "}
          from the address on the account and we will turn it off for you. Cancellation takes
          effect at the end of the period you have paid for; the agent keeps working until then;
          nothing further is charged. You can reverse a cancellation, by turning Auto-renew back
          on, any time before that date. If you cancel before your plan starts, it never starts: the agent does not begin answering patients, nothing more is
          charged, the setup fee is not refunded, and your account closes at the end of the
          current month of your subscription, or when your 30 days to finish setup end if that is
          sooner.
        </p>
        <p>
          <strong>Ending your Data Agreement is different.</strong> If your Data Agreement ends,
          however it ends, your subscription ends with it on the same day, not at the end of the
          period you have paid for, and no fees accrue for any time after that day. Section 15
          says when the unused part of what you have paid is refunded.
        </p>
        <p>
          <strong>Annual plans.</strong> We email you at least 30 days before an annual renewal
          with the renewal date, the amount and how to cancel.{" "}
          {POLICY.annualProRataRefund
            ? "If you cancel an annual plan mid-term we refund the unused whole months."
            : "If you cancel an annual plan mid-term the service continues to the end of the term you paid for and no refund is made for the unused part."}{" "}
          {POLICY.refundWindowDays > 0
            ? `Under section 5 an annual plan is refunded in one of two amounts: the whole first year's subscription fee if you cancel within ${POLICY.refundWindowDays} days of your plan start, or, under the first-month guarantee, one month at your plan's annual per-month price.`
            : "Under the first-month guarantee in section 5, an annual plan is refunded one month at your plan's annual per-month price, not the year's fee."}
        </p>
        <p>
          <strong>Price changes</strong> apply from your next renewal and are announced by email
          at least 30 days beforehand; you may cancel before they take effect.
        </p>
      </Section>

      <Section id="refunds" title="5. Refunds and the first-month guarantee">
        <p>
          {POLICY.refundWindowDays > 0
            ? `If you cancel within ${POLICY.refundWindowDays} days of your plan start we refund the first period's subscription fee in full. The setup fee is never refunded (section 3).`
            : "Subscription fees are not refundable except where these terms or the law say otherwise. The setup fee is never refunded (section 3)."}{" "}
          Where a refund other than under the guarantee below is due to a Practice that is
          staying, it is applied as a credit to the next invoice; where the Practice is leaving,
          it is returned to the payment method you paid with.
        </p>
        {GUARANTEE_TEXT.paragraphs.map((para) => (
          <p key={para.lead}>
            <strong>{para.lead}</strong> {para.body}
          </p>
        ))}
        <p>
          A Practice receives at most one refund of its first period's fee, whether under the
          paragraph above or under the guarantee; the two do not stack. The guarantee refund is
          not limited by section 13, and section 19 does not apply to it.
        </p>
      </Section>

      <Section id="payment" title="6. Late and failed payment">
        <p>
          If a subscription payment fails we retry it and email the address on your account. The
          service stays fully on for seven days. If the
          invoice is still unpaid after that, the service is suspended: the agent stops answering
          on every channel, forwarded calls are passed straight through to your direct line
          (section 8) rather than answered, website chat becomes a contact form, we tell you how
          to remove call forwarding so callers reach your Practice as they did before, and your
          data is kept and stays readable in your portal. Paying the open invoice restores
          everything at once. If the invoice is still unpaid thirty days after it was due, we may
          cancel the subscription, and section 7 then applies. Amounts unpaid when due may bear
          interest at the lower of 1% per month and the maximum lawful rate.
        </p>
      </Section>

      <Section id="end" title="7. When the service ends">
        <p>
          When your subscription ends for any reason: the agent stops answering when it ends, which
          is at the end of the paid period, or on the day your Data Agreement ends if that comes
          first (section 15), and from then forwarded calls are passed straight through to your
          direct line (section 8) rather than answered. That pass-through continues for at
          least{" "}
          {POLICY.forwardingPassThroughDays} days after the service ends or until you remove call
          forwarding, whichever is first; we tell you how to remove it, at once and again in
          writing, so calls reach your Practice exactly as they did before. We revoke our access to
          your Google Calendar, your Meta accounts and your payment gateway. Within 30 days of the
          end we deliver an export of your data — the records of your conversations and the
          booking log; the transcripts themselves reached you by email as each conversation
          ended — and we then destroy our copies when and as the Business Associate Agreement
          says. Billing records are retained as tax law requires.
        </p>
      </Section>

      <Section id="you" title="8. Your responsibilities">
        <ul className="list-disc space-y-2 pl-6">
          <li>
            <strong>Inbound only.</strong> The agent speaks to a person only in reply, inside a
            conversation that person started with your Practice: it places no calls, sends no
            text messages, and sends no reminders, follow-ups or marketing to patients by any
            channel, and if you ask for any of those we will decline.
          </li>
          <li>
            <strong>Bookings.</strong> Appointments the agent writes into the Google Calendar you
            connect are your Practice's bookings, as if your own staff had made them: you keep
            that calendar's availability true, you collect any deposit the agent flagged for you,
            and you tell us which booking system you use, so we can tell you whether a booking in
            Google Calendar blocks the slot there. Mindbody's sync runs one way and it does not;
            Boulevard is unverified. Where it does not, the agent takes a booking request for
            your staff to confirm instead of booking. Our part is to book only into that calendar,
            only at a time it showed as free.
          </li>
          <li>
            <strong>Call forwarding and your direct line.</strong> You set and keep the call
            forwarding on your own line, with your carrier, in the coverage mode you chose. You
            give us a direct phone number for your Practice that is not itself forwarded to us,
            keep it staffed, and tell us when it changes: it is where calls go whenever the agent
            is not answering (sections 2, 6 and 7).
          </li>
          <li>
            <strong>Requests for a person.</strong> When a caller or visitor asks for a person, the
            assistant takes their details and alerts the contact you named. You get back to them
            within 24 hours, as the assistant tells them you will.
          </li>
          <li>
            <strong>Accurate configuration.</strong> Services, prices, hours, escalation contacts
            and the answers to onboarding questions are yours to keep true.
          </li>
          <li>
            <strong>Your own notices.</strong> You are responsible for your notice of privacy
            practices, your own consent forms, and any disclosure your state requires you to make
            to patients about the use of automated systems.
          </li>
          <li>
            <strong>Your account.</strong> Your Practice has one sign-in, the email address on
            your account, which is also where we send everything about it. You keep that inbox and
            your sign-in links confidential, and tell us promptly if you believe they have been
            compromised.
          </li>
          <li>
            <strong>Lawful use.</strong> You will not use the service for emergencies, for
            anything unlawful, to harass anyone, or to circumvent the agent's clinical boundaries.
          </li>
        </ul>
      </Section>

      <Section id="phi" title="9. Patient information and the Business Associate Agreement">
        <p>
          Where your Practice is a covered entity under HIPAA, the Business Associate Agreement you
          sign at checkout is the agreement required by 45 CFR 164.502(e); where it is not, we apply
          the same terms to the same information anyway. That agreement controls over these terms
          for everything about patient information: what we may do with it, how we protect it, what
          we report, and what happens to it when you leave. It also controls on terminating it and
          what then happens to the service and your fees (section 15). It allocates liability for
          patient information consistently with sections 13 and 14 of these terms. The list of the
          subcontractors that process patient information for us is given to you on request, under
          the Business Associate Agreement.
        </p>
        <p>
          <strong>No real patient information before every agreement is in place.</strong> We
          process no real patient information for your Practice until each business associate
          agreement in the chain is in place: yours with us, and ours with every vendor that will
          handle it, which are our hosting provider, our database provider, our voice provider and
          our language-model provider.
        </p>
        <p>
          <strong>The language model.</strong> Our language-model provider receives the content of
          each conversation, to generate the agent&apos;s replies, only under a business associate
          agreement with us signed before any patient&apos;s information reaches it. Under that
          agreement it keeps conversation content for 30 days, for abuse detection and security,
          and then deletes it, except content its automated trust-and-safety systems flag or the
          law requires it to keep, which it may keep for up to two years; the service it provides
          under that agreement cannot run with shorter retention, and it never trains on that
          content. The Business Associate Agreement states the same.
        </p>
        <p>
          <strong>Meta channels.</strong> Instagram, Messenger and WhatsApp are operated by Meta,
          which does not sign Business Associate Agreements. If you connect them, the agent replies
          there only inside the conversation the person opened, and only within the window Meta
          allows; it answers from your public menu, prices, hours and policies, and takes booking
          requests for your staff to confirm, and it sends no payment link there. We check each
          message a person sends there for clinical
          content before the language model sees it, and keep no message there and no summary of
          one. The agent is instructed not to repeat clinical content, name a treatment or confirm
          appointment details there, and to move anything clinical to a call or to your own secure
          route and say why in one sentence. Each reply the language model writes there is checked
          by automated filters designed to keep those out, and a reply the filters refuse is
          replaced by a fixed one. No filter catches every wording, so do not invite patients to
          send clinical information on these channels. What a person chooses to send to Meta,
          and what Meta keeps, is outside our control and yours. You may switch those channels off
          at any time, and you accept this documented limitation when you connect them.
        </p>
      </Section>

      <Section id="ip" title="10. Ownership">
        <p>
          We own the service, its software, the agent's underlying models and prompts, and
          improvements to them. You own your Practice's data — your configuration, your patients'
          information and the records the agent creates for you — and you grant us the licence needed
          to provide the service to you. We never use patient information to train models. You may
          give us feedback and we may use it without obligation.
        </p>
      </Section>

      <Section id="confidentiality" title="11. Confidentiality">
        <p>
          Each of us keeps the other's non-public information confidential, uses it only for this
          agreement, and protects it as carefully as its own, for as long as it remains
          confidential. Patient information is covered by the Business Associate Agreement, not by
          this section.
        </p>
      </Section>

      <Section id="disclaimers" title="12. Disclaimers">
        <p>
          EXCEPT FOR THE FIRST-MONTH GUARANTEE IN SECTION 5, THE SERVICE IS PROVIDED "AS IS" AND
          "AS AVAILABLE". WE DO NOT WARRANT THAT IT WILL BE UNINTERRUPTED OR ERROR-FREE, THAT THE
          AGENT WILL ANSWER EVERY CALL OR BOOK EVERY APPOINTMENT, OR THAT ANY PARTICULAR REVENUE
          WILL RESULT. BOOKED VALUE IS AN ESTIMATE FROM YOUR OWN CONFIGURED PRICES, NOT A MEASURE
          OF REVENUE, AND FIGURES ON OUR WEBSITE ARE ILLUSTRATIVE INDUSTRY RANGES, NOT PROMISES.
          EXCEPT AS EXPRESSLY STATED IN THESE TERMS OR THE BUSINESS ASSOCIATE AGREEMENT, WE
          DISCLAIM ALL WARRANTIES, EXPRESS OR IMPLIED, INCLUDING MERCHANTABILITY, FITNESS FOR A
          PARTICULAR PURPOSE AND NON-INFRINGEMENT.
        </p>
      </Section>

      <Section id="liability" title="13. Limitation of liability">
        <p>
          TO THE FULLEST EXTENT THE LAW ALLOWS, WE ARE NOT LIABLE TO YOU FOR ANY LOSS ARISING OUT
          OF OR RELATING TO THESE TERMS OR THE SERVICE, IN CONTRACT, TORT OR OTHERWISE, INCLUDING
          LOST PROFITS OR REVENUE AND INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL OR PUNITIVE
          DAMAGES, HOWEVER CAUSED.
        </p>
        <p>
          WHERE THE LAW DOES NOT PERMIT THAT EXCLUSION, OUR TOTAL AGGREGATE LIABILITY ARISING OUT
          OF OR RELATING TO THESE TERMS AND THE SERVICE WILL NOT EXCEED{" "}
          {POLICY.liabilityFloorUsd > 0
            ? `THE GREATER OF (A) THE FEES YOU PAID US IN THE TWELVE MONTHS BEFORE THE EVENT GIVING RISE TO THE CLAIM AND (B) ${usd.format(POLICY.liabilityFloorUsd)}`
            : "THE FEES YOU PAID US IN THE TWELVE MONTHS BEFORE THE EVENT GIVING RISE TO THE CLAIM"}
          .
        </p>
        <p>
          These limits do not apply to our wilful misconduct or gross negligence, to your
          indemnity obligations in section 14, or to any liability that cannot be excluded or
          limited by law. The first-month guarantee refund in section 5 is not limited by this
          section, and neither is the refund section 15 gives when you terminate your Data
          Agreement. We carry no liability insurance; you should size your own cover accordingly.
        </p>
      </Section>

      <Section id="indemnity" title="14. Indemnity">
        <p>
          <strong>You</strong> will defend, indemnify and hold harmless us, our operating entity,
          and our and its officers, contractors and subprocessors against every claim, loss,
          liability, penalty, fine, cost and expense, including reasonable legal fees, the cost
          of defending a claim, and the cost of investigating a security incident and of
          notifying patients, regulators and anyone else about a breach, to the extent it arises from or relates to the service, your use of
          it, the patient information you or your patients give it, the calls and messages the agent
          handles for you, instructions you gave us, your responsibilities in sections 8 and 9, or a
          claim by a patient, a regulator or any other third party. This indemnity applies to the
          fullest extent the law allows, including where the claim alleges negligence on our part.
          It does not extend to a claim for the refund section 15 gives.
        </p>
        <p>
          <strong>We</strong> give you no indemnity. The Business Associate Agreement allocates
          liability for patient information consistently with this section and section 13.
          Nothing in these terms or in the Business Associate Agreement shifts to you a civil
          money penalty a regulator imposes on us for our own conduct, or changes what either of
          us owes a regulator directly.
        </p>
        <p>
          We will tell you promptly of a claim and cooperate at your expense. You will conduct the
          defence with counsel we approve; we may take part with our own counsel at your cost; and
          you may not settle a claim in a way that admits fault on our part or imposes an obligation
          on us without our written consent.
        </p>
      </Section>

      <Section id="term" title="15. Term, suspension and termination">
        <p>
          These terms start when you subscribe and continue while any subscription is active. We
          may suspend the service for non-payment as section 6 describes, or immediately if your use
          creates a legal or security risk, telling you why. Either party may terminate for a
          material breach the other does not cure within 30 days of written notice. Sections 5, 7
          and 9 to 20 survive termination.
        </p>
        <p>
          <strong>When your Data Agreement ends.</strong> However your Data Agreement ends, your
          subscription and the service end on the same day, and no fees accrue for any time after
          that day. Forwarded calls are then passed through to your direct line as section 7
          describes.
        </p>
        <p>
          A refund is owed only where you terminate your Data Agreement because we have violated
          a material term of it, or under its Subcontractors clause after objecting to a new
          subprocessor. We then refund the fees you have paid for the time after that day: the
          prorated unused part of the subscription period you have paid for, which on an annual
          plan is the rest of the year. The refund never includes the setup fee or usage above the
          allowance already billed, and if your plan has not started (section 3) there is nothing
          to refund. It is returned to the payment method you paid with. Where we terminate your
          Data Agreement because of your breach, or it ends in any other way, this section refunds
          nothing.
        </p>
      </Section>

      <Section id="changes" title="16. Changes to these terms">
        <p>
          We may update these terms. A change that affects your rights or your fees is emailed to
          the address on your account at least 30 days before it applies and takes effect at your next
          renewal; continuing past that renewal accepts it. The version and date appear at the foot
          of this page.
        </p>
      </Section>

      <Section id="law" title="17. Governing law and disputes">
        <p>
          These terms are governed by the laws of the State of {state}, without regard to its
          conflict-of-laws rules, and the state and federal courts located there have exclusive
          jurisdiction, except that either party may bring a claim within a small-claims court's
          limits in that court. Before filing, each party agrees to give the other written notice of
          the dispute and 30 days to resolve it.
        </p>
      </Section>

      <Section id="notices" title="18. Notices">
        <p>
          Notices to us go to{" "}
          <a href={`mailto:${ENTITY.email}`} className="underline underline-offset-2">
            {ENTITY.email}
          </a>
          . Notices to you go to the email address on your account. A notice is effective when
          delivered.
        </p>
      </Section>

      <Section id="general" title="19. General">
        <p>
          These terms, the Business Associate Agreement and the order you complete at checkout are
          the entire agreement between us and replace any earlier discussion. If a term is
          unenforceable the rest stands. Neither party is liable for delay caused by events beyond
          its reasonable control, except for payment obligations and the first-month guarantee in
          section 5. You may not assign these terms without our consent, except to a successor of
          your whole Practice; we may assign them to a successor of our business. Nothing creates a
          partnership or agency beyond the agent acting on your instructions as section 2 describes.
        </p>
      </Section>

      <Section id="entity" title="20. Operating entity and company information">
        <p>
          {site.name} is a professional services brand operated by {entityDisplayName()},{" "}
          {ENTITY.formation}. Notwithstanding the place of incorporation of the operating entity,
          these terms are governed exclusively by the laws of the State of {state}, United States,
          as section 17 provides.
        </p>
        <ul className="list-disc space-y-2 pl-6">
          <li>
            <strong>Operating brand:</strong> {site.name}
          </li>
          <li>
            <strong>Website:</strong> {site.domain}
          </li>
          <li>
            <strong>Contact, legal notices included:</strong>{" "}
            <a href={`mailto:${ENTITY.email}`} className="underline underline-offset-2">
              {ENTITY.email}
            </a>
          </li>
          {/* The registered address off the trade licence, printed here and in
              privacy § 10 and nowhere else. The footer carries the mailbox
              below instead, under its own label; see ENTITY.registeredAddress
              in src/lib/legal.ts. The two are listed together, in this order,
              so neither can be mistaken for the other. */}
          {ENTITY.registeredAddress ? (
            <li>
              <strong>Registered address:</strong> {ENTITY.registeredAddress}
            </li>
          ) : null}
          <li>
            <strong>{ENTITY.postalAddressLabel}:</strong> {ENTITY.postalAddress}
          </li>
        </ul>
        <p>{ENTITY.postalAddressDisclaimer}</p>
      </Section>

      {/* The annex. Unnumbered and ruled off, so that no reader takes it for
          section 21: the Business Associate Agreement incorporates this page
          by its address, and what follows is a description of our practices,
          not a promise either agreement makes. The comment on TermsPage says
          what it carries over from /trust and what it leaves behind. */}
      <hr className="border-line mt-16" />
      <Section id="security" title="How we protect data">
        <p>
          <strong>
            This annex describes our practices for protecting information. It is provided for
            information only and is not a term of this agreement, and it changes as our practices
            do. The Business Associate Agreement you sign at checkout governs patient information.
          </strong>
        </p>

        <h3 className={ANNEX_HEADING}>The boundary</h3>
        <p>
          {site.name} is two systems. This website and its demo hold no patient information at
          all: a clinic owner&apos;s work email, a chat with a demo agent, a business enquiry. The
          product — the assistant that answers your phone and chat — runs on separate
          infrastructure, under the Business Associate Agreement, and that is the only place a
          caller&apos;s name, number or question is kept.
        </p>
        <p>
          The line is enforced in code, not only in policy: the website&apos;s lead records are
          tested against a denylist of patient-shaped fields, and the product&apos;s database
          refuses to write patient information for any clinic until its agreement is bound and the
          clinic is deliberately moved to production.
        </p>

        <h3 className={ANNEX_HEADING}>What protects patient information</h3>
        <ul className="list-disc space-y-3 pl-6">
          <li>
            <strong>One clinic cannot see another.</strong> Every table that holds patient
            information carries row-level security that the application role cannot bypass and the
            table owner cannot skip. A test suite asserts, for every such table, that the policy
            exists, is forced, and names the clinic column.
          </li>
          <li>
            <strong>The AI says it is an AI, first.</strong> Every call, chat and message opens
            with a line saying the patient is talking to an AI assistant; on the phone the same
            line says the call is transcribed, and no call audio is kept. The clinic cannot switch
            it off or edit it out through the greeting, and the record of each call notes when it
            was given.
          </li>
          <li>
            <strong>Transcripts are emailed to the clinic, not kept.</strong> When a call or a
            website chat ends, its transcript is emailed to the address on the clinic&apos;s
            account, only over an encrypted connection. The one encrypted copy we hold so that a
            failed email can be sent again is deleted seven days after the email is first
            accepted for delivery, or seven days after it was queued if it never is; from then
            on the email is the clinic&apos;s record. The record of each conversation, without
            what was said, is deleted {TRANSCRIPT_RETENTION_DAYS} days after it took place.
          </li>
          <li>
            <strong>Encryption.</strong> At rest in the database and object store, and in transit
            wherever we control both ends. Two routes are outside that: a phone call is not
            end-to-end encrypted, and a patient who telephones has chosen the telephone, which is
            the exception the Business Associate Agreement makes; and a message on Instagram,
            Messenger or WhatsApp travels through Meta&apos;s systems, which we do not control.
            Email that would carry patient information goes only over an encrypted connection, and
            is not sent if the receiving server cannot accept one.
          </li>
          <li>
            <strong>Where it runs.</strong> The product&apos;s servers and its database run in our
            cloud hosting provider&apos;s US East region. The voice provider&apos;s region is
            being confirmed in writing.
          </li>
          <li>
            <strong>Who handles it.</strong> Inside the product, patient information is processed
            by our cloud hosting provider, our voice provider and our AI model provider, each under
            a business associate agreement with us that is signed before any patient information
            reaches it. The list of these subcontractors is given to clinics on request, under the
            Business Associate Agreement. The vendors that serve this website, its demo and our
            billing never receive patient information.
          </li>
          <li>
            <strong>Every access is recorded.</strong> Reads and writes of patient information are
            written to an append-only audit table in the same transaction as the access, so an
            access that rolled back leaves no false claim behind, and a real one cannot be erased
            by the application.
          </li>
          <li>
            <strong>Logs cannot carry patient data.</strong> The product has a single logger with
            an allowlist of fields and a scrubber for numbers and addresses; a test fails the build
            on any log call that goes around it.
          </li>
          <li>
            <strong>No advertising platforms, anywhere.</strong> No pixel on this website, no
            conversion API in the product, and nothing about a patient is ever sent to Meta or
            Google for advertising; a browser policy on this website blocks the connections
            outright. The next part covers the routes that carry patient details by design.
          </li>
          <li>
            <strong>Signed agreements are evidence.</strong> The exact text a clinic signed, its
            hash, who signed and when are stored append-only; the database role the application
            uses holds no permission to change or delete them.
          </li>
        </ul>

        <h3 className={ANNEX_HEADING}>Where there is no agreement, and how we handle it</h3>
        <ul className="list-disc space-y-3 pl-6">
          <li>
            <strong>Instagram, Messenger and WhatsApp.</strong> Meta signs no business associate
            agreement for any messaging product, and no vendor in front of Meta can change that.
            So the product is set up to keep clinical content off these channels. A patient&apos;s
            message travels through Meta because that is where the patient wrote to you. We check
            each message for clinical content before the language model sees it, and keep no
            message there and no summary of one. The assistant is instructed not to repeat
            clinical content, name a treatment or confirm appointment details there, and to move
            anything clinical to a call or your own secure route and say why in one sentence. Each
            reply the language model writes there is checked by automated filters designed to keep
            those out, and a reply the filters refuse is replaced by a fixed one. No filter catches
            every wording, so do not invite patients to send clinical information on these
            channels.
          </li>
          <li>
            <strong>Deposits.</strong> A deposit is taken through your own payment processor
            account, under your own agreement with it, and payment processors sign no business
            associate agreement. So a deposit link carries only an amount, a generic description
            and a reference code: no treatment name, not in the description, the statement
            descriptor or the metadata.
          </li>
          <li>
            <strong>The AI model keeps inputs for 30 days.</strong> Our model provider covers its
            service under its own business associate agreement, but the models it covers require 30
            days of data retention and cannot run with none. Even under that agreement it may keep
            content its automated trust-and-safety systems flag, or that the law requires it to
            keep, for up to two years. Everywhere else we push retention down; this one we cannot,
            so we say so here rather than leave it for your counsel to find.
          </li>
          <li>
            <strong>Your calendar is yours.</strong> Bookings are written into your own Google
            Calendar, under your own agreement with Google. That is the right place for them, and
            it is worth confirming your Google Workspace plan carries that agreement.
          </li>
          <li>
            <strong>Who we are.</strong> The operating entity is named in section 20.
            HIPAA&apos;s obligations attach to a business associate wherever it is incorporated,
            and ours are in the Business Associate Agreement.
          </li>
        </ul>

        <h3 className={ANNEX_HEADING}>If something goes wrong</h3>
        <p>
          We tell the clinic of a breach of unsecured patient information, and of any other
          security incident whether or not it turns out to be a breach, without unreasonable delay
          and in no case later than 60 calendar days after discovery. Who pays for what follows is in the
          agreements, not in small print: the cost of notifying patients and regulators sits with
          the clinic (section 14), and we carry no liability insurance (section 13). We say both
          plainly so a clinic can size its own cover.
        </p>

        <h3 className={ANNEX_HEADING}>What we do not claim</h3>
        <ul className="list-disc space-y-3 pl-6">
          <li>
            <strong>No certification.</strong> There is no &quot;HIPAA certified&quot; and we do
            not display a seal. HIPAA is a set of obligations, and the way to check ours is to read
            the Business Associate Agreement and ask us for the architecture.
          </li>
          <li>
            <strong>No third-party audit yet.</strong> No SOC 2 report exists. The controls above
            are our own and we will walk any reviewer through them.
          </li>
          {/* Read from the internal register, so this line goes when the
              last agreement is countersigned and not before. */}
          {phiAgreementsOutstanding() ? (
            <li>
              <strong>
                Not every agreement in the patient-information path is countersigned yet.
              </strong>{" "}
              Until every one is, our operator moves no clinic to production. That is a check a
              person makes before switching a clinic over, not one the software enforces yet.
            </li>
          ) : null}
        </ul>

        <h3 className={ANNEX_HEADING}>Who to ask</h3>
        <p>
          Security questions, vulnerability reports and compliance questionnaires go to{" "}
          <a href={`mailto:${ENTITY.email}`} className="underline underline-offset-2">
            {ENTITY.email}
          </a>
          . We answer within five business days, and we do not pursue good-faith researchers.
        </p>
      </Section>
    </LegalPage>
  );
}

/** The annex's own subheadings, a step below a section title. */
const ANNEX_HEADING = "font-display pt-2 text-[20px] leading-tight font-medium tracking-[-0.015em]";
