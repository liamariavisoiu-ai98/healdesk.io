import { annualTotalUsd, OVERAGE_RATES_PROVISIONAL } from "@healdesk/catalog";
import type { Metadata } from "next";

import { LegalPage, Section } from "@/components/LegalPage";
import { ENTITY, POLICY, entityDisplayName, packagesForTerms } from "@/lib/legal";
import { site } from "@/lib/site";

export const metadata: Metadata = {
  title: "Terms of service",
  description:
    "The subscription agreement for healdesk: packages and fees, automatic renewal and how to cancel, the setup fee, what the AI does and does not do, liability, and how patient information is governed.",
};

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

/**
 * The terms of service and subscription agreement.
 *
 * Every number comes from packages/catalog/src/plans.ts, so a pricing change
 * is a contract change in the same commit and the terms can never quote a
 * stale figure. The founder-supplied facts (entity, governing law, liability
 * floor, refund window) come from src/lib/legal.ts and drive the wording
 * below: a zero refund window renders as "no refund window", not as a blank.
 *
 * Order of precedence is stated in section 9 and matters: the Business
 * Associate Agreement signed at checkout controls for patient information,
 * these terms for everything else. The two must not be read as conflicting.
 */
export default function TermsPage() {
  const packages = packagesForTerms();
  const state = ENTITY.governingLawState || "[governing-law state]";
  return (
    <LegalPage
      title="Terms of service"
      intro="The agreement between a clinic and healdesk: what you buy, what it costs, how it renews, how you leave, and who is responsible for what."
    >
      <Section id="parties" title="1. The agreement">
        <p>
          These terms are between {entityDisplayName()}
          {ENTITY.formation ? `, ${ENTITY.formation}` : ""} ("{site.name}", "we") and the business
          that subscribes ("you", the "Practice"). By clicking the button at checkout you accept
          them on the Practice's behalf and confirm you are authorised to. They are a business
          contract; the service is not offered to consumers.
        </p>
        <p>
          Patient information is governed by the separate <strong>Business Associate Agreement</strong>{" "}
          you sign at checkout. Where the two conflict on anything about patient information, the
          Business Associate Agreement controls (section 9).
        </p>
      </Section>

      <Section id="service" title="2. What the service is, and is not">
        <p>
          {site.name} is an AI front desk: {site.agent} answers calls, web chat and, where
          purchased, Instagram, Messenger and WhatsApp for your Practice; qualifies enquiries;
          takes booking requests and hands each one to your front desk, who confirm a time, call
          the person back, or decline; and reports which recovered contacts became revenue. The
          agent never confirms an appointment itself.
        </p>
        <ul className="list-disc space-y-2 pl-6">
          <li>
            <strong>It is not a medical device and gives no medical advice.</strong> The agent is
            configured to decline clinical questions and route them to your staff. You will not
            configure it to diagnose, recommend treatment, or triage, and you will not rely on it
            for emergencies. Every call opens with a disclosure that the caller is speaking to an
            AI; that disclosure cannot be switched off.
          </li>
          <li>
            <strong>It works on your instructions.</strong> The services it offers, the prices it
            quotes and the hours it keeps are what you approve in onboarding. You are responsible
            for keeping them accurate.
          </li>
          <li>
            <strong>It never leaves you without a line in silence.</strong> Your number stays
            yours: you forward it to the agent, and you can remove that forwarding at any time
            without us. If the service is suspended or ends, we tell you at once, and again in
            writing, how to remove it so calls reach your Practice exactly as they did before, and we
            switch the agent off, so forwarded calls are not answered until you do.
          </li>
        </ul>
      </Section>

      <Section id="fees" title="3. Packages and fees">
        <p>
          Prices are in US dollars, exclusive of any applicable sales tax, and are those published
          at <a href="/pricing" className="underline underline-offset-2">/pricing</a> when you
          subscribe. The packages at the date of these terms:
        </p>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-[14.5px]">
            <thead>
              <tr className="border-line border-b text-left">
                <th className="py-2 pr-3 font-semibold">Package</th>
                <th className="py-2 pr-3 font-semibold">Monthly</th>
                <th className="py-2 pr-3 font-semibold">Annual (per year)</th>
                <th className="py-2 pr-3 font-semibold">One-time setup</th>
                <th className="py-2 pr-3 font-semibold">Voice minutes / mo</th>
                <th className="py-2 font-semibold">Chat conversations / mo</th>
              </tr>
            </thead>
            <tbody>
              {packages.map((p) => (
                <tr key={p.id} className="border-line border-b align-top">
                  <td className="py-2 pr-3 font-semibold">{p.name}</td>
                  <td className="py-2 pr-3">{usd.format(p.monthlyUsd)}</td>
                  <td className="py-2 pr-3">{usd.format(annualTotalUsd(p))}</td>
                  <td className="py-2 pr-3">{usd.format(p.setupFeeUsd)}</td>
                  <td className="py-2 pr-3">{p.includedVoiceMinutes ? p.includedVoiceMinutes.toLocaleString() : "—"}</td>
                  <td className="py-2">{p.includedChatConversations ? p.includedChatConversations.toLocaleString() : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p>
          <strong>Usage above the included allowance</strong> is billed in arrears on the next
          invoice, per voice minute and per chat conversation, at the rate published on the
          pricing page.{" "}
          {OVERAGE_RATES_PROVISIONAL
            ? "Until those rates are published, usage above the allowance is not billed."
            : "On a monthly package, usage above the allowance appears on the next invoice at those rates. On an annual package it is invoiced separately, monthly in arrears, at the same rates."}{" "}
          Nothing else is charged for usage.
        </p>
        <p>
          <strong>The setup fee</strong> is charged once, on your first invoice, and pays for
          building, configuring and testing your agent. It is not refundable. Moving to a package
          with a higher setup fee charges only the difference. Where a founding-cohort credit was
          offered to you by email, it is applied to the setup fee at checkout and to nothing else.
        </p>
      </Section>

      <Section id="renewal" title="4. Automatic renewal, and how to cancel">
        <p>
          <strong>Your subscription renews automatically.</strong> A monthly package renews every
          month and an annual package every year, on the anniversary of your first payment, at
          the package price in force on that date, and your payment method on file is charged on
          that date. It continues to renew until you cancel.
        </p>
        <p>
          <strong>To cancel:</strong> open the billing portal from the link in any invoice email and
          choose "cancel at end of period", or email{" "}
          <a href={`mailto:${ENTITY.supportEmail}`} className="underline underline-offset-2">
            {ENTITY.supportEmail}
          </a>{" "}
          from the address on the account. Cancellation takes effect at the end of the period you
          have paid for; the agent keeps working until then; nothing further is charged. You can
          reverse a cancellation any time before that date.
        </p>
        <p>
          <strong>Annual plans.</strong> We email you at least 30 days before an annual renewal
          with the renewal date, the amount and how to cancel.{" "}
          {POLICY.annualProRataRefund
            ? "If you cancel an annual plan mid-term we refund the unused whole months."
            : "If you cancel an annual plan mid-term the service continues to the end of the term you paid for and no refund is made for the unused part."}
        </p>
        <p>
          <strong>Price changes</strong> apply from your next renewal and are announced by email
          at least 30 days beforehand; you may cancel before they take effect.
        </p>
      </Section>

      <Section id="refunds" title="5. Refunds">
        <p>
          {POLICY.refundWindowDays > 0
            ? `If you cancel within ${POLICY.refundWindowDays} days of your first payment we refund the first period's subscription fee in full. The setup fee is not refundable.`
            : "Subscription fees are not refundable except where these terms or the law say otherwise. The setup fee is not refundable."}{" "}
          Where a refund is due to a Practice that is staying, it is applied as a credit to the next
          invoice; where the Practice is leaving, it is returned to the card.
        </p>
      </Section>

      <Section id="payment" title="6. Late and failed payment">
        <p>
          If a renewal payment fails we retry it and email your billing contact. The service stays
          fully on for seven days. If the invoice is still unpaid after that, the agent is
          suspended: it stops answering on every channel, we tell you how to remove call
          forwarding so callers reach your Practice, and your data is kept and stays readable in
          your console. Paying the open invoice restores everything at once. If
          the invoice is still unpaid thirty days after it was due, we may cancel the subscription,
          and section 7 then applies. Amounts unpaid when due may bear interest at the lower of 1% per
          month and the maximum lawful rate.
        </p>
      </Section>

      <Section id="end" title="7. When the service ends">
        <p>
          When your subscription ends for any reason: the agent stops answering at the end of the
          paid period; we tell you how to remove call forwarding (if you do not, forwarded calls
          are lost — that is why we tell you twice); we revoke our access to your calendar and
          booking system; and we deliver an export of your data — transcripts, notes
          and the booking log — before destroying our copies on the schedule the Business Associate
          Agreement sets. Billing records are retained as tax law requires.
        </p>
      </Section>

      <Section id="you" title="8. Your responsibilities">
        <ul className="list-disc space-y-2 pl-6">
          <li>
            <strong>Inbound only.</strong> The agent answers calls and messages that come to you. It
            does not call or text anyone on your behalf: no reminders, no call-backs, no
            reactivation campaigns. If you ask for outbound contact, we will decline; it is not
            part of the Service.
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
            <strong>Your account.</strong> You will keep your credentials confidential and tell us
            promptly if you believe they have been compromised.
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
          we report, and what happens to it when you leave. The list of companies that process it for
          us, and whether each has signed with us, is at{" "}
          <a href="/subprocessors" className="underline underline-offset-2">/subprocessors</a>.
        </p>
        <p>
          <strong>Meta channels.</strong> Instagram, Messenger and WhatsApp are operated by Meta,
          which does not sign Business Associate Agreements. On those channels the agent answers
          public questions and moves the conversation to phone, text or the web to book; it does not
          collect or confirm health information there. You may switch those channels off at any
          time, and you accept this documented limitation when you purchase a package that includes
          them.
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
          THE SERVICE IS PROVIDED "AS IS" AND "AS AVAILABLE". WE DO NOT WARRANT THAT IT WILL BE
          UNINTERRUPTED OR ERROR-FREE, THAT THE AGENT WILL ANSWER EVERY CALL OR BOOK EVERY
          APPOINTMENT, OR THAT ANY PARTICULAR REVENUE WILL RESULT. FIGURES ON OUR WEBSITE ARE
          ILLUSTRATIVE INDUSTRY RANGES, NOT PROMISES. EXCEPT AS EXPRESSLY STATED IN THESE TERMS OR
          THE BUSINESS ASSOCIATE AGREEMENT, WE DISCLAIM ALL WARRANTIES, EXPRESS OR IMPLIED,
          INCLUDING MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NON-INFRINGEMENT.
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
          These limits do not apply to your indemnity obligations in section 14, or to any
          liability that cannot be excluded or limited by law. We carry no liability insurance; you
          should size your own cover accordingly.
        </p>
      </Section>

      <Section id="indemnity" title="14. Indemnity">
        <p>
          <strong>You</strong> will defend, indemnify and hold harmless us and our officers,
          contractors and subprocessors against every claim, loss, liability, penalty, fine, cost
          and expense, including reasonable legal fees, the cost of defending a claim, and the cost
          of investigating a security incident and of notifying patients, regulators and anyone
          else about a breach, to the extent it arises from or relates to the service, your use of
          it, the patient information you or your patients give it, the calls and messages the agent
          handles for you, instructions you gave us, your responsibilities in sections 8 and 9, or a
          claim by a patient, a regulator or any other third party. This indemnity applies to the
          fullest extent the law allows, including where the claim alleges negligence on our part.
        </p>
        <p>
          <strong>We</strong> give you no indemnity. The Business Associate Agreement allocates
          liability for patient information the same way.
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
          material breach the other does not cure within 30 days of written notice. Sections 7 and
          9 to 19 survive termination.
        </p>
      </Section>

      <Section id="changes" title="16. Changes to these terms">
        <p>
          We may update these terms. A change that affects your rights or your fees is emailed to
          your billing contact at least 30 days before it applies and takes effect at your next
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
          <a href={`mailto:${ENTITY.noticesEmail}`} className="underline underline-offset-2">
            {ENTITY.noticesEmail}
          </a>
          {ENTITY.postalAddress ? ` or by post to ${entityDisplayName()}, ${ENTITY.postalAddress}` : ""}.
          Notices to you go to the billing email on your account. A notice is effective when
          delivered.
        </p>
      </Section>

      <Section id="general" title="19. General">
        <p>
          These terms, the Business Associate Agreement and the order you complete at checkout are
          the entire agreement between us and replace any earlier discussion. If a term is
          unenforceable the rest stands. Neither party is liable for delay caused by events beyond
          its reasonable control, except for payment obligations. You may not assign these terms
          without our consent, except to a successor of your whole Practice; we may assign them to a
          successor of our business. Nothing creates a partnership or agency beyond the agent acting
          on your instructions as section 2 describes.
        </p>
      </Section>
    </LegalPage>
  );
}
