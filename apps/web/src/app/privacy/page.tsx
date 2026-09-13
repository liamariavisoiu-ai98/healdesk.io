import type { Metadata } from "next";

import { LegalPage, Section } from "@/components/LegalPage";
import { CALL_CONSENT, CONSENT_NOTICE_VERSION, MARKETING_CONSENT_LABEL } from "@/lib/consent";
import { GATE_COOKIE } from "@/lib/gate";
import { ENTITY, POLICY, entityDisplayName } from "@/lib/legal";
import { site } from "@/lib/site";
import { SUBPROCESSORS } from "@/lib/subprocessors";

export const metadata: Metadata = {
  title: "Privacy policy",
  description:
    "What healdesk.io collects from visitors, why, who processes it, and how to exercise your rights. Patient data is governed separately, by the Business Associate Agreement.",
};

/**
 * The privacy policy for the MARKETING SITE.
 *
 * Its scope is deliberately narrow and stated in the first section: this
 * page covers healdesk.io and the people who visit it — clinic owners and
 * staff, and anyone who tries the demo. It does not cover patients. Patient
 * information is handled only inside the product, under a signed Business
 * Associate Agreement, and this page says so rather than trying to be both
 * documents at once.
 *
 * Every concrete fact is imported from the module that owns it — the cookie
 * name from src/lib/gate.ts, the consent wording from src/lib/consent.ts, the
 * vendors from src/lib/subprocessors.ts — so the policy cannot describe a
 * site that no longer exists.
 */
export default function PrivacyPage() {
  const marketingVendors = SUBPROCESSORS.filter((s) => s.scope !== "product");
  return (
    <LegalPage
      title="Privacy policy"
      intro="What this website collects, what we do with it, and what you can ask us to do. Written to be read, not skimmed."
    >
      <Section id="scope" title="1. What this policy covers">
        <p>
          This policy covers <strong>{site.domain}</strong> and the people who use it: clinic
          owners and staff considering {site.name}, and anyone who tries the demo. It is
          operated by {entityDisplayName()} ("we"). It does not cover patients of our customers.
        </p>
        <p>
          <strong>Patient information is not handled on this website.</strong> When a clinic
          becomes a customer, its patients' information is processed only inside the product,
          under a Business Associate Agreement the clinic signs at checkout. That agreement,
          not this page, governs patient data. If you are a patient of a clinic that uses{" "}
          {site.name}, contact your clinic; it controls your records and we act on its
          instructions.
        </p>
      </Section>

      <Section id="collect" title="2. What we collect, and why">
        <p>We collect only what a feature needs to work. In each case the feature is the reason.</p>
        <ul className="list-disc space-y-3 pl-6">
          <li>
            <strong>Your email, when you unlock the demo.</strong> The chat demo asks for an email
            after your first message. We use it to send you a copy of the conversation and to know
            who tried the product. It sets one cookie, <code>{GATE_COOKIE}</code>, for 30 days, so
            you are not asked again. We record whether the address is a business or a personal
            domain, and nothing else about it.
          </li>
          <li>
            <strong>Whether you ticked the marketing box.</strong> Beside the email field is an
            unticked checkbox reading: <em>"{MARKETING_CONSENT_LABEL}"</em>. If you tick it we
            record that, the wording you saw (notice version {CONSENT_NOTICE_VERSION}) and the
            time. If you do not tick it, we do not email you about the product. Unlocking the demo
            is not consent to marketing.
          </li>
          <li>
            <strong>What you type into the demo.</strong> Your messages are sent to our language
            model provider to generate a reply. We do not store the conversation on our servers
            after it ends. Do not put anyone's health information into the demo; it is a
            demonstration for clinic staff, not a patient channel.
          </li>
          <li>
            <strong>Your phone number, if you ask AYA to call you.</strong> Only when you tick a
            separate box reading: <em>"{CALL_CONSENT.text}"</em>. {CALL_CONSENT.note}
          </li>
          <li>
            <strong>Your clinic's public website, if you request a personalised demo.</strong> We
            read the pages your site already publishes to build a demo that knows your services
            and hours. We keep the extracted summary with your lead record and show it back to you
            to correct.
          </li>
          <li>
            <strong>Contact form submissions</strong> — your name, email and message, to reply.
          </li>
          <li>
            <strong>Billing identity, when you buy.</strong> Your clinic's name, your work email
            and the package you chose. Card details go directly to Stripe and never touch our
            servers.
          </li>
          <li>
            <strong>Technical data.</strong> Your IP address and the page requested, kept in server
            logs for {POLICY.logRetentionDays} days to stop abuse and to rate-limit the demo.
          </li>
          <li>
            <strong>Analytics, only if you accept the cookie notice.</strong> Page views and named
            funnel steps (for example "viewed pricing", "reached checkout step 3"). Never the
            contents of a form, an email address, a phone number or a chat message. If you decline,
            nothing is measured and the site works identically.
          </li>
        </ul>
      </Section>

      <Section id="not" title="3. What we do not do">
        <ul className="list-disc space-y-3 pl-6">
          <li>
            <strong>We do not sell or share your personal information</strong>, in the ordinary
            sense or in the sense defined by California law. There is no advertising pixel, tag
            manager or conversion tag on this site, and no data is sent to Meta, Google Ads or
            any other advertising platform. This is a design rule written into the site's code,
            not only a policy.
          </li>
          <li>We do not use what you type into the demo to train any model.</li>
          <li>We do not knowingly collect information from anyone under 18; the site is for businesses.</li>
          <li>We do not use "dark patterns": declining analytics is one click and changes nothing else.</li>
        </ul>
      </Section>

      <Section id="cookies" title="4. Cookies">
        <ul className="list-disc space-y-3 pl-6">
          <li>
            <code>{GATE_COOKIE}</code> — functional. Set when you unlock the demo; HTTP-only; 30 days.
            Proves to the chat endpoint that an email was given. No consent banner is required
            for a cookie that only does the thing you asked for.
          </li>
          <li>
            <code>hd_consent</code> — functional. Remembers your answer to the cookie notice, in your
            browser only.
          </li>
          <li>
            <strong>Analytics cookies</strong> — set by PostHog only after you accept the notice, to
            tell one visit from another. Withdraw at any time by clearing the site's cookies; the
            notice will ask again.
          </li>
        </ul>
      </Section>

      <Section id="vendors" title="5. Who processes it">
        <p>
          The companies below process visitor data for this website. Each receives only what
          the row says, and none receives patient information. The full register, including the
          vendors inside the product that do handle patient information under signed agreements,
          is at <a href="/subprocessors" className="underline underline-offset-2">/subprocessors</a>.
        </p>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[560px] text-[15px]">
            <thead>
              <tr className="border-line border-b text-left">
                <th className="py-2 pr-4 font-semibold">Vendor</th>
                <th className="py-2 pr-4 font-semibold">Purpose</th>
                <th className="py-2 font-semibold">Receives</th>
              </tr>
            </thead>
            <tbody>
              {marketingVendors.map((v) => (
                <tr key={v.name} className="border-line border-b align-top">
                  <td className="py-2 pr-4 font-semibold">{v.name}</td>
                  <td className="py-2 pr-4">{v.purpose}</td>
                  <td className="py-2">{v.data}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      <Section id="retention" title="6. How long we keep it">
        <ul className="list-disc space-y-3 pl-6">
          <li>
            A lead that never becomes a customer: {POLICY.leadRetentionMonths} months after the
            last visit, then deleted.
          </li>
          <li>Server logs: {POLICY.logRetentionDays} days.</li>
          <li>Demo conversations: not stored by us after the session; the model provider's own retention applies to its processing.</li>
          <li>Customer billing records: for as long as tax and accounting law require.</li>
          <li>The record of a signed Business Associate Agreement: for six years after the relationship ends, as HIPAA requires.</li>
        </ul>
      </Section>

      <Section id="rights" title="7. Your rights">
        <p>
          Wherever you are, you can ask us what we hold about you, ask for it to be corrected or
          deleted, and withdraw marketing consent. Email{" "}
          <a href={`mailto:${ENTITY.privacyEmail}`} className="underline underline-offset-2">
            {ENTITY.privacyEmail}
          </a>{" "}
          and we answer within 30 days. We will verify the request by replying to the address on
          file; we do not require an account or a form.
        </p>
        <p>
          <strong>California residents.</strong> You have the rights to know, to delete, to correct,
          and to opt out of sale or sharing. We do not sell or share personal information, so there
          is nothing to opt out of; the rest are honoured through the address above, and we do not
          discriminate against anyone for exercising them. An authorised agent may act for you
          with written permission.
        </p>
        <p>
          <strong>Washington residents.</strong> This website is not designed to collect consumer
          health data. If you type health information into the demo it is processed only to
          generate the reply and is not retained by us. The product itself, used by a clinic on
          your behalf, operates under that clinic's own notices and the agreement it signs with us.
        </p>
        <p>
          <strong>Email marketing.</strong> Every marketing email carries a working unsubscribe link
          and our postal address, and we honour an unsubscribe within ten business days as the
          CAN-SPAM Act requires — in practice, immediately.
        </p>
      </Section>

      <Section id="sms" title="8. Text messages">
        <p>
          If you give us a mobile number and agree to texts, here is the programme in the terms
          the carriers require: <strong>{site.name} notifications</strong> — replies to your
          enquiry, your demo link, and appointment-related messages if you are a customer. Message
          frequency varies. Message and data rates may apply. Reply <strong>STOP</strong> to opt
          out at any time and <strong>HELP</strong> for help. We never send marketing texts without
          a separate, explicit opt-in.
        </p>
      </Section>

      <Section id="security" title="9. Security">
        <p>
          The marketing site holds no patient information, which is the first and best security
          control. What it does hold is encrypted in transit and at rest, reachable only through
          this site's own server code, and rate-limited. The product's controls — a signed
          agreement with every vendor that touches patient data, US-only infrastructure,
          encryption with customer-managed keys, and audit logging of every access — are described
          in the Business Associate Agreement and on the subprocessor page. No third party has
          audited us; these are our own commitments and we will show you the architecture behind
          any of them.
        </p>
      </Section>

      <Section id="changes" title="10. Changes and contact">
        <p>
          When this policy changes we update the version and date at the foot of the page. A
          change that reduces your rights or widens what we collect is announced on this page for
          30 days before it takes effect and, for customers, by email.
        </p>
        <p>
          {entityDisplayName()}
          {ENTITY.postalAddress ? `, ${ENTITY.postalAddress}` : ""}. Privacy requests:{" "}
          <a href={`mailto:${ENTITY.privacyEmail}`} className="underline underline-offset-2">
            {ENTITY.privacyEmail}
          </a>
          . Everything else:{" "}
          <a href={`mailto:${ENTITY.supportEmail}`} className="underline underline-offset-2">
            {ENTITY.supportEmail}
          </a>
          .
        </p>
      </Section>
    </LegalPage>
  );
}
