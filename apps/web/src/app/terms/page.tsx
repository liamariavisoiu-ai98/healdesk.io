import { annualTotalUsd, OVERAGE_RATES_PROVISIONAL } from "@healdesk/catalog";
import type { Metadata } from "next";

import { LegalPage, Section } from "@/components/LegalPage";
import { ENTITY, GUARANTEE_TEXT, POLICY, entityDisplayName, packagesForTerms } from "@/lib/legal";
import { site } from "@/lib/site";

export const metadata: Metadata = {
  alternates: { canonical: "/terms" },
  title: "Terms of service",
  description:
    "The subscription agreement for healdesk: packages and fees, automatic renewal and how to cancel, the setup fee, refunds and the first-month guarantee, what the AI does and does not do, liability, and how patient information is governed.",
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
 * GUARANTEE_TEXT there, because the spec requires the pricing page to carry
 * the identical words; /pricing must render the same object.
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
 * Revised 7 October 2026 to the owner's decisions of 6 October, recorded in
 * docs/v1-product-spec.md ("Stage 1, payment" and "The guarantee"): billing
 * starts on the plan start, the day the agent first answers a patient, and
 * renewal, the first-period refund and the guarantee's first month all run
 * from it (sections 3 to 5); the setup fee is never refunded, which ends the
 * 3 October exception, and an account with nothing live 30 days after
 * payment is closed (section 3); a failed payment is emailed to the
 * account's one address (section 6).
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
          These terms are between {site.name} ("we", "us"; the professional services brand
          described in section 20) and the business that subscribes ("you", the "Practice"). By
          clicking the button at checkout you accept them on the Practice's behalf and confirm
          you are authorised to. They are a business contract; the service is not offered to
          consumers.
        </p>
        <p>
          Patient information is governed by the separate <strong>Business Associate Agreement</strong>{" "}
          you sign at checkout. Where the two conflict on anything about patient information, the
          Business Associate Agreement controls (section 9).
        </p>
      </Section>

      <Section id="service" title="2. What the service is, and is not">
        <p>
          {site.name} is an AI front desk. {site.agent} answers your Practice's phone calls,
          website chat, Instagram, Messenger and WhatsApp, on the channels you buy, from the
          services, prices, hours and policies you approve; qualifies enquiries; books
          appointments straight into the Google Calendar you connect, during the conversation,
          holding the slot before anything is confirmed; sends a hosted deposit link in chat,
          through your own payment gateway, where you want one; routes anything clinical to your
          Practice; and reports conversations handled, appointments booked, calls answered that
          would otherwise have rung out, deposits collected and booked value, meaning the bookings
          it made multiplied by your own configured prices. It does not report revenue, because
          it cannot see it. "Auto-confirm bookings" is on by default; you may instead set every
          booking to be a request your staff approve, and a Practice whose booking system does
          not read Google Calendar for conflicts runs that way (section 8). By phone it cannot
          take a payment: it books and flags the deposit for your staff to collect. Card numbers
          are never taken on any channel.
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
                  <td className="py-2 pr-3">{p.includedVoiceMinutes ? p.includedVoiceMinutes.toLocaleString("en-US") : "—"}</td>
                  <td className="py-2">{p.includedChatConversations ? p.includedChatConversations.toLocaleString("en-US") : "—"}</td>
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
          building, configuring and testing your agent. That work starts as soon as it is paid,
          so the setup fee is never refunded. Moving to a package with a higher setup fee charges
          only the difference. Where a setup credit was offered to you by email, it is applied to
          the setup fee at checkout and to nothing else.
        </p>
        <p>
          <strong>Your plan starts the day the agent first answers a patient.</strong> Until
          then your subscription carries a $0 monthly line, and the setup fee is all you have
          paid. On that day, your plan start, the package price replaces the $0 line and your
          first period is charged, monthly or yearly as you chose. If your package has more than
          one channel and only some of them are answering patients, the price is that of the
          package made up of those channels. Each further channel's price applies from the day it
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
          Payments are processed through our Stripe account, which is linked to our operating
          entity (section 20).
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
          <strong>To cancel:</strong> open the billing portal from the link in any invoice email and
          choose "cancel at end of period", or email{" "}
          <a href={`mailto:${ENTITY.supportEmail}`} className="underline underline-offset-2">
            {ENTITY.supportEmail}
          </a>{" "}
          from the address on the account. Cancellation takes effect at the end of the period you
          have paid for; the agent keeps working until then; nothing further is charged. You can
          reverse a cancellation any time before that date. If you cancel before your plan
          starts, it never starts: the agent does not begin answering patients, nothing more is
          charged, the setup fee is not refunded, and your account closes at the end of the
          current month of your subscription, or when your 30 days to finish setup end if that is
          sooner.
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
          When your subscription ends for any reason: the agent stops answering at the end of the
          paid period, and from then forwarded calls are passed straight through to your direct
          line (section 8) rather than answered. That pass-through continues for at least{" "}
          {POLICY.forwardingPassThroughDays} days after the service ends or until you remove call
          forwarding, whichever is first; we tell you how to remove it, at once and again in
          writing, so calls reach your Practice exactly as they did before. We revoke our access to
          your Google Calendar, your Meta accounts and your payment gateway. Within 30 days of the
          end we deliver an export of your data — transcripts and the booking log — and we then
          destroy our copies when and as the Business Associate Agreement says. Billing records
          are retained as tax law requires.
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
          we report, and what happens to it when you leave. It allocates liability for patient
          information in the same way as sections 13 and 14 of these terms. The list of companies
          that process it for us, and whether each has signed with us, is at{" "}
          <a href="/subprocessors" className="underline underline-offset-2">/subprocessors</a>.
        </p>
        <p>
          <strong>The language model.</strong> The provider of the language model that generates
          the agent's replies receives the content of each conversation to do so. Under its
          business associate agreement with us it keeps that content for 30 days, for abuse
          detection, and then deletes it, except content its automated trust-and-safety systems
          flag or the law requires it to keep, which it may keep for up to two years; it never
          trains on it. The Business Associate Agreement states the same.
        </p>
        <p>
          <strong>Meta channels.</strong> Instagram, Messenger and WhatsApp are operated by Meta,
          which does not sign Business Associate Agreements. If you connect them, the agent replies
          there only inside the conversation the person opened, and only within the window Meta
          allows; it answers from your public menu, prices, hours and policies, can book and can
          send your own payment link, and never sends clinical content or a treatment name there.
          Clinical content a person sends on those channels is caught on arrival and is not stored,
          echoed back or carried into a summary; the agent moves the person to a call or to your
          own secure route and says why in one sentence. What a person chooses to send to Meta,
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
          section. We carry no liability insurance; you should size your own cover accordingly.
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
        </p>
        <p>
          <strong>We</strong> give you no indemnity. The Business Associate Agreement allocates
          liability for patient information in the same way as this section and section 13.
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
          <a href={`mailto:${ENTITY.noticesEmail}`} className="underline underline-offset-2">
            {ENTITY.noticesEmail}
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
            <strong>General contact:</strong>{" "}
            <a href={`mailto:${ENTITY.supportEmail}`} className="underline underline-offset-2">
              {ENTITY.supportEmail}
            </a>
          </li>
          <li>
            <strong>Legal contact:</strong>{" "}
            <a href={`mailto:${ENTITY.noticesEmail}`} className="underline underline-offset-2">
              {ENTITY.noticesEmail}
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
    </LegalPage>
  );
}
