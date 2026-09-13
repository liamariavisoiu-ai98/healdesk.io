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
          books appointments into your calendar or booking system; sends the follow-ups you
          configure; and reports which recovered contacts became revenue.
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
            <strong>It never leaves a dead line.</strong> If the service is suspended or ends,
            calls to your number reach your Practice as they did before, and we tell you how to
            remove call forwarding.
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
            : null}{" "}
          You may choose, in onboarding, to have the agent stop rather than bill overage; if you
          do, calls beyond the allowance reach your Practice directly.
        </p>
        <p>
          <strong>The setup fee</strong> is charged once, on your first invoice, and pays for
          building, configuring and testing your agent. It is not refundable once that work has
          begun. Moving to a package with a higher setup fee charges only the difference.
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
            ? `If you cancel within ${POLICY.refundWindowDays} days of your first payment we refund the first period's subscription fee in full. The setup fee is refundable only if provisioning has not begun.`
            : "Subscription fees are not refundable except where these terms or the law say otherwise. The setup fee is refundable only if provisioning of your agent has not begun."}{" "}
          Where a refund is due to a Practice that is staying, it is applied as a credit to the next
          invoice; where the Practice is leaving, it is returned to the card.
        </p>
      </Section>

      <Section id="payment" title="6. Late and failed payment">
        <p>
          If a renewal payment fails we retry it and email your billing contact. The service stays
          fully on for seven days. If the invoice is still unpaid after that, the agent is
          suspended: calls reach your Practice directly, the chat widget shows a contact form, and
          your data is kept and readable. Paying the open invoice restores everything at once. If
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
          booking system; and we deliver an export of your data — transcripts, recordings, notes
          and the booking log — before destroying our copies on the schedule the Business Associate
          Agreement sets. Billing records are retained as tax law requires.
        </p>
      </Section>

      <Section id="you" title="8. Your responsibilities">
        <ul className="list-disc space-y-2 pl-6">
          <li>
            <strong>Consent for outbound contact.</strong> Where you ask the agent to call or text
            people on your behalf — reminders, follow-ups, reactivation — you warrant that you hold
            the consent the law requires for each number, in the form it requires (for marketing
            messages, prior express written consent), and you will keep records of it. You will
            not ask the agent to contact anyone who has asked not to be contacted.
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
          NEITHER OF US IS LIABLE TO THE OTHER FOR INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL OR
          PUNITIVE DAMAGES, OR FOR LOST PROFITS OR REVENUE, HOWEVER CAUSED.
        </p>
        <p>
          OUR TOTAL AGGREGATE LIABILITY ARISING OUT OF OR RELATING TO THESE TERMS AND THE SERVICE,
          IN CONTRACT, TORT OR OTHERWISE, WILL NOT EXCEED{" "}
          {POLICY.liabilityFloorUsd > 0
            ? `THE GREATER OF (A) THE FEES YOU PAID US IN THE TWELVE MONTHS BEFORE THE EVENT GIVING RISE TO THE CLAIM AND (B) ${usd.format(POLICY.liabilityFloorUsd)}`
            : "THE FEES YOU PAID US IN THE TWELVE MONTHS BEFORE THE EVENT GIVING RISE TO THE CLAIM"}
          .
        </p>
        <p>
          These limits do not apply to: our gross negligence or wilful misconduct; our obligation
          under the Business Associate Agreement to bear the cost of notifying patients and
          regulators of a breach we caused; either party's indemnity obligations in section 14; or
          any liability that cannot be limited by law.
        </p>
      </Section>

      <Section id="indemnity" title="14. Indemnities">
        <p>
          <strong>You</strong> will defend and indemnify us against third-party claims, including
          claims under the Telephone Consumer Protection Act and state laws like it, arising from
          messages or calls the agent placed in reliance on your consent warranty in section 8, or
          from instructions you gave us.
        </p>
        <p>
          <strong>We</strong> will defend and indemnify you against third-party claims arising from
          our breach of these terms or the Business Associate Agreement, or from a claim that the
          service, used as permitted, infringes a third party's intellectual property. This indemnity
          is subject to section 13 except where section 13 says otherwise.
        </p>
        <p>
          The indemnified party must notify the other promptly, let it control the defence, and
          cooperate; it may not settle a claim in a way that admits fault for the other without
          consent.
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
