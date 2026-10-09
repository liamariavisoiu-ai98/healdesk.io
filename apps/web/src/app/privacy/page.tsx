import { TRANSCRIPT_RETENTION_DAYS } from "@healdesk/catalog";
import type { Metadata } from "next";

import { LegalPage, Section } from "@/components/LegalPage";
import { CookieChoice } from "@/components/analytics/CookieChoice";
import { CALL_CONSENT, CONSENT_NOTICE_VERSION, MARKETING_CONSENT_LABEL, DEMO_ACCESS_DAYS } from "@/lib/consent";
import { DEMO_LIFETIME_MS, DEMO_RETENTION_AFTER_EXPIRY_DAYS } from "@/lib/demo/sessions";
import { GATE_COOKIE } from "@/lib/gate";
import { ENTITY, POLICY, entityDisplayName } from "@/lib/legal";
import { site } from "@/lib/site";
import { PROCESSOR_CATEGORIES, WEBSITE_PROCESSING } from "@/lib/subprocessors";

/** A personalised demo's week, in days, as lib/demo/sessions.ts counts it. */
const DEMO_LIFETIME_DAYS = DEMO_LIFETIME_MS / (24 * 60 * 60 * 1000);

export const metadata: Metadata = {
  alternates: { canonical: "/privacy" },
  title: "Privacy policy",
  description:
    "What healdesk.io collects from visitors, why, who processes it, and how to exercise your rights; what the product does with Google Calendar and Meta messaging data. Patient data is governed by the Business Associate Agreement.",
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
 * kinds of vendor from src/lib/subprocessors.ts — so the policy cannot
 * describe a site that no longer exists. The rule for the prose is the same: a sentence
 * may describe only something the code does today. Two adversarial reviews
 * removed every sentence that described a feature we meant to build.
 *
 * Sections 11 to 13 are the exception, and the comments on each say so.
 * Google requires a privacy policy that discloses what an app does with Google
 * user data, with its Limited Use statement, before it verifies the Calendar
 * scope, and Meta requires one covering Platform data, with deletion
 * instructions, before App Review. Both reviews read this page, and both have
 * to clear before launch (docs/v1-product-spec.md, "External gates on the
 * launch date"), so these sections describe the v1 product the spec defines
 * rather than code that exists today. Every sentence in them must be true by
 * the time a clinic can connect a calendar or a Meta account.
 *
 * Adopted 3 Oct 2026 by the owner without external counsel review, with the
 * wording docs/counsel/agreement-changes.md § 8 gives for sections 1, 9 and
 * 12, and section 9's claims about the product cut back to what is decided.
 *
 * Revised to the owner's decisions of 9 October 2026 (LEGAL_VERSION
 * 2026-10-09.1). No vendor of ours is named: section 5 describes each kind of
 * vendor by what it does (src/lib/subprocessors.ts, WEBSITE_PROCESSING), the
 * prose elsewhere says "our AI model provider" and the like, and the list of
 * the subcontractors that handle patient information is given to clinics on
 * request under the Business Associate Agreement. Google and Meta are still
 * named, as the platforms a clinic connects and whose app reviews read
 * sections 11 to 13. hello@healdesk.io is the one address. Section 9's breach
 * clock is the spec's (without unreasonable delay and in no case later than
 * 60 calendar days after discovery), and sections 6 and 12 say that transcripts are
 * deleted automatically after 90 days, or sooner if the clinic chooses. The
 * same version adds section 2's "If you ask for your own demo", for the
 * homepage's "See it in your own branding" (api/own-demo), and the number a
 * personalised demo's "Call us" keeps, which shipped without a line here.
 */
export default function PrivacyPage() {
  return (
    <LegalPage
      title="Privacy policy"
      intro="What this website collects, what we do with it, and what you can ask us to do. Written to be read, not skimmed."
    >
      <Section id="scope" title="1. What this policy covers">
        <p>
          This policy covers <strong>{site.domain}</strong> and the people who use it: clinic
          owners and staff considering {site.name}, and anyone who tries the demo. {site.name}{" "}
          ("we", "us") operates it; the operating entity is named in section 10. It does not
          cover patients of our customers, except as sections 11 to 13 say about the product.
        </p>
        {/* Adopted 3 Oct 2026 by the owner without external counsel review.
            The scope sentence for sections 11 to 13, which Google's and Meta's
            app reviews read. */}
        <p>
          Sections 11 and 12 also describe what the product does with data it receives from Google
          and from Meta when a clinic connects its Google Calendar, its Facebook Page, its Instagram
          account or its WhatsApp number, and section 13 says how to have that data deleted.
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
            after your first message. We use it to know who tried the product and to reply if you
            ask us something. It sets one cookie, <code>{GATE_COOKIE}</code>, for {DEMO_ACCESS_DAYS} days, so you
            are not asked again. Alongside the address we keep: whether it is a business or a
            personal domain, which specialty's demo you opened, the campaign code if you arrived
            from an email we sent, the site that referred you (the site name only, never the full
            link), the dates you first and last unlocked the demo, and which steps of this site
            you reached afterwards (for example "started checkout", "completed payment"), recorded
            against your record so we know what worked. We do not email you a transcript, and we
            do not email you about the product unless you tick the box below.
          </li>
          <li>
            <strong>Whether you ticked the marketing box.</strong> Beside the email field is an
            unticked checkbox reading: <em>"{MARKETING_CONSENT_LABEL}"</em>. If you tick it we
            record that, the wording you saw (notice version {CONSENT_NOTICE_VERSION}) and the
            time, and we send at most four emails over the following eight days, each with a
            one-click unsubscribe; then we stop. If you do not tick it, we do not email you about
            the product. Unlocking the demo is not consent to marketing.
          </li>
          <li>
            <strong>What you type into the demo.</strong> Your messages are sent to our AI model
            provider to generate a reply, together with the public service information of the
            specialty being demonstrated. We do not store the conversation on
            our servers, during or after it. Do not put anyone's health information into the demo;
            it is a demonstration for clinic staff, not a patient channel.
          </li>
          <li>
            <strong>Your phone number, if you ask {site.agent} to call you.</strong> Only when you
            tick a separate box reading: <em>"{CALL_CONSENT.text}"</em>. {CALL_CONSENT.note} The
            call is placed by our voice provider, on a separate agent from the product&apos;s own
            voice agent, which never calls anyone. The voice provider passes your number, the
            first name you gave and the specialty you were viewing to the agent, and runs the
            conversation on our AI model provider&apos;s model. Neither we nor the voice provider
            keep a recording or a transcript of the call. The number, the exact wording you agreed to, its
            version, the time and your IP address are stored as the consent record
            for {POLICY.callConsentRetentionYears} years — the period in which a call could be
            disputed — and are used for nothing else.
          </li>
          <li>
            {/* Added 7 Oct 2026 (LEGAL_VERSION 2026-10-07.3): the demo line on
                the site, and the setup link AYA emails when an owner says yes. */}
            <strong>If you call {site.agent}&apos;s demo line.</strong> When you dial{" "}
            {site.demoLine.display}, our voice provider receives your number and the call&apos;s
            audio while it is live, and {site.agent} runs on our AI model provider&apos;s model, as
            above. Neither we nor the voice provider keep a recording or a transcript of the call,
            we do not keep your number, and the line is never used to call you back.
          </li>
          <li>
            <strong>If you ask {site.agent}, on either call, to email you.</strong> Only if you
            ask to get started, or ask about pricing, terms or a session with our team, and say yes
            when she asks whether we may email you. If you are getting started, we email you the
            link to set up the package you discussed, once. Either way, she emails us your name,
            your clinic, the email address you spelled out, a time that suits you, and a short
            summary of what you told her about your phones, so we do not ask twice. We use it to
            answer that request and for nothing else: it is not added to a marketing list, and we
            never phone the number you called from or were called on.
          </li>
          <li>
            <strong>If we contacted you first.</strong> We research practices before we send a
            first email, using only what the practice publishes: its website, its public business
            listing (name, address, phone, rating, opening hours), its public job posts, and how
            it takes bookings. We keep that business profile with the email we sent. It is
            information about a business, not about a person; it is never patient information;
            and every email we send this way says who we are and carries a working unsubscribe.
          </li>
          <li id="own-demo">
            {/* Added 9 Oct 2026 (LEGAL_VERSION 2026-10-09.1) with the
                homepage's "See it in your own branding", and the personalised
                demo's "Call us", which keeps the number you will call from. */}
            <strong>If you ask for your own demo.</strong> &ldquo;See it in your own branding&rdquo;
            on the homepage asks for your clinic&apos;s website and your email. We read the
            website&apos;s public pages, and the practice&apos;s public business listing for its
            opening hours, and our AI model provider turns what we read into the demo: a private
            page with your clinic&apos;s name, logo, colours, services and prices on it. We keep the
            website, your email and what was read with the demo, and email you its link once, when
            it is ready. A copy of your request, the website and your email, goes to our team, who
            may reply to you about it; it is not added to a marketing list. Your IP address is used
            only to limit how many demos can be asked for (Technical data, below). If, on the demo&apos;s page,
            you tell us the number you will call the demo line from, we keep it with the demo so
            the line answers as your clinic when you call; we never call it unless you ask us to
            and tick the box above. A demo is live for {DEMO_LIFETIME_DAYS} days; section 6 says
            when it is deleted, with everything kept with it.
          </li>
          <li>
            <strong>Contact form submissions</strong> — your name, your clinic's name if you give
            it, your email and your message. They are delivered to our inbox by email and kept as
            ordinary correspondence. We send one email to the address you give, saying when we
            will reply.
          </li>
          <li>
            {/* Added 6 Oct 2026 with the setup request form (LEGAL_VERSION
                2026-10-06.1). */}
            <strong>Setup requests</strong> ("Tell us about your clinic") — your name, your
            clinic's name and website, the email address your clinic will use with us, the
            channels you want, and the IP address the request came from, which we keep with it to
            stop abuse. We use them to reply and to send your setup link, and we record when the
            link is opened and used. We send one email to the address you give, saying when we
            will reply; the setup link emails carry a one-click unsubscribe. If you came from one
            of our follow-up emails, asking for setup stops them.
          </li>
          <li>
            {/* Added 6 Oct 2026 with "Get in touch" (LEGAL_VERSION
                2026-10-06.2). */}
            <strong>Calls you book</strong> ("Get in touch") — the booking form is our scheduling
            provider&apos;s, shown on our page. The name and email you give, anything you add in its
            form and the time you pick go to that provider, which passes the booking to us so we
            can hold the call. Nothing of the provider&apos;s loads until you open it.
          </li>
          <li>
            {/* Adopted 3 Oct 2026 by the owner without external counsel review;
                the field list updated 6 Oct 2026 (LEGAL_VERSION 2026-10-07.1)
                to what the four-step checkout asks: the website or none, the
                kind of Google account and the browser's time zone are new,
                and the appointment value and the calls question are gone. */}
            <strong>What you enter at checkout.</strong> Your clinic's legal name, its website or
            that it has none, its specialty, where its bookings live today, which kind of Google
            account its calendar is on, and the email address your clinic will use with us; to sign
            the agreement, your name and your title at the practice; and, when you tick the box
            beside Pay, which version of these terms you accepted, when, and the IP address you
            accepted from. Your browser's time zone is sent with them, as a starting point for your
            clinic's own until you confirm it in setup. Card
            details go directly to our payment processor and never touch our servers. If you reach the payment
            page and stop, we send one email about it, an hour later, and no more; it carries the
            same one-click unsubscribe.
            {/* Added 6 Oct 2026 with the website read (LEGAL_VERSION 2026-10-06.3):
                app/api/clinic-site and lib/site-read. */}{" "}
            If you give your clinic's website, we read it so that setup starts with your details
            already filled in: up to eight of its public pages, never one its robots.txt asks
            robots not to read. We send the text of those pages to our AI model provider, which
            picks out the business details: services and prices, locations and opening hours, the practitioners
            the site names, its policies and its answers to common questions. It is told to leave
            out anything a patient wrote or said, such as reviews and testimonials. The details go
            back to your browser for the rest of checkout, and this website keeps neither the pages
            nor what was read from them.
            {/* Added 6 Oct 2026 (LEGAL_VERSION 2026-10-07.1): Pay sends the read
                with the purchase to apps/app, which keeps it on the checkout intent
                (checkout_intents.profile) until billing-housekeeping purges it. */}{" "}
            When you press Pay, what was read is sent with your other answers to the {site.name}{" "}
            product, which keeps it with your purchase so that setup can start from it: it is
            deleted 14 days after you last pressed Pay if the purchase is not completed, and
            otherwise 90 days after your account is created. Once you are a customer we may read
            the site again the same way, to keep your setup current.
          </li>
          <li>
            <strong>Technical data.</strong> Your IP address and the page requested, used to
            rate-limit the demo and stop abuse. Rate-limit counters expire with their window: an
            hour for most, a day for the demo-call limit on a given number and for the number of
            demos asked for with one email address or for one website. Request logs are kept
            briefly by our hosting provider and never longer than {POLICY.logRetentionDays} days.
          </li>
          <li>
            <strong>Analytics, only if you accept the cookie notice.</strong> Page views and named
            funnel steps (for example "started checkout", "reached checkout step 3"). Never the
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
            any other advertising platform. This is a design rule written into the site's code —
            the browser is told which servers this site may talk to, and those are not on the
            list — not only a policy.
          </li>
          <li>We do not use what you type into the demo to train any model, and neither does our AI model provider.</li>
          <li>We do not knowingly collect information from anyone under 18; the site is for businesses.</li>
          <li>We do not use "dark patterns": declining analytics is one click and changes nothing else.</li>
        </ul>
      </Section>

      <Section id="cookies" title="4. Cookies">
        <ul className="list-disc space-y-3 pl-6">
          <li>
            <code>{GATE_COOKIE}</code> — functional. Set when you unlock the demo; HTTP-only; {DEMO_ACCESS_DAYS} days.
            Proves to the chat endpoint that an email was given. No consent banner is required
            for a cookie that only does the thing you asked for.
          </li>
          <li>
            <strong>Your cookie-notice answer</strong> — functional, and not a cookie: it is kept
            in your browser's local storage under <code>hd_consent</code> and never sent to us.
            Because it is not a cookie, clearing cookies does not change it; this does:
          </li>
        </ul>
        <div className="pl-6">
          <CookieChoice />
        </div>
        <ul className="list-disc space-y-3 pl-6">
          <li>
            <strong>Analytics cookies</strong> — set by our analytics provider only after you accept
            the notice, to tell one visit from another. Withdraw with the button above; analytics stops on the
            next page load and the notice asks again.
          </li>
          <li>
            <strong>Our scheduling provider&apos;s cookies</strong> — only if you open "Get in
            touch": the scheduling provider may set its own cookies inside its booking window.
            They are its own, under its own cookie policy, and we do not read them.
          </li>
        </ul>
      </Section>

      {/* By category, never by name (owner, 9 October 2026): the rows are
          WEBSITE_PROCESSING, which privacy-copy.test.ts ties to the internal
          register's website rows. */}
      <Section id="vendors" title="5. Who processes it">
        <p>
          We use service providers for the jobs below, and describe them by what they do. Each
          receives only what its row says, and none receives patient information from this
          website.
        </p>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[560px] text-[15px]">
            <thead>
              <tr className="border-line border-b text-left">
                <th className="py-2 pr-4 font-semibold">Kind of provider</th>
                <th className="py-2 pr-4 font-semibold">What it does</th>
                <th className="py-2 font-semibold">What it receives</th>
              </tr>
            </thead>
            <tbody>
              {WEBSITE_PROCESSING.map((row) => (
                <tr key={row.category} className="border-line border-b align-top">
                  <td className="py-2 pr-4 font-semibold">{PROCESSOR_CATEGORIES[row.category]}</td>
                  <td className="py-2 pr-4">{row.purpose}</td>
                  <td className="py-2">{row.receives}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p>
          Inside the product, patient information is processed by our cloud hosting provider, our
          voice provider and our AI model provider, each under a business associate agreement with
          us, signed before any patient information reaches it; messages on Instagram, Messenger
          and WhatsApp travel through Meta, which signs no such agreement, so the product keeps
          them non-clinical (section 12). The list of the subcontractors that handle patient
          information is given to clinics on request, under the Business Associate Agreement.
        </p>
      </Section>

      <Section id="retention" title="6. How long we keep it">
        <ul className="list-disc space-y-3 pl-6">
          <li>
            A lead that never becomes a customer: {POLICY.leadRetentionMonths} months after the
            last visit, then deleted automatically, together with the funnel events recorded
            against it.
          </li>
          <li>
            A setup request: {POLICY.leadRetentionMonths} months after it was last updated, then
            deleted automatically.
          </li>
          <li>Server logs: {POLICY.logRetentionDays} days.</li>
          <li>Demo-call consent records: {POLICY.callConsentRetentionYears} years, then deleted.</li>
          <li>Demo conversations: not stored by us at all; our AI model provider's own retention applies to its processing.</li>
          <li>A personalised demo, and what was read to build it: live for {DEMO_LIFETIME_DAYS} days, then deleted {DEMO_RETENTION_AFTER_EXPIRY_DAYS} days later, unless your clinic buys from it, when it is kept with your purchase.</li>
          <li>Your website's pages, read at checkout: not stored by us at all; our AI model provider's own retention applies to its processing. What was read from them, once you press Pay: kept with your purchase, and deleted 14 days after you last pressed Pay if the purchase is not completed, otherwise 90 days after your account is created.</li>
          <li>The demo call itself: no recording or transcript is kept by us or by our voice provider, which keeps the call&apos;s basic record (time, length, how it ended) for 30 days. We hold the number only in the consent record above.</li>
          <li>A follow-up you asked for on the demo call: as ordinary email correspondence, until the request is answered and closed.</li>
          <li>Contact-form messages: as ordinary email correspondence, until the enquiry is closed.</li>
          <li>Customer billing records: for as long as tax and accounting law require.</li>
          <li>The record of a signed Business Associate Agreement: for six years after the relationship ends, as HIPAA requires.</li>
          <li>
            Inside the product, a clinic&apos;s patient conversations: each conversation and its
            transcript is deleted automatically {TRANSCRIPT_RETENTION_DAYS} days after it took
            place, or sooner if the clinic chooses a shorter period, and no call audio is kept at
            all. The clinic&apos;s Business Associate Agreement with us governs the rest.
          </li>
        </ul>
      </Section>

      <Section id="rights" title="7. Your rights">
        <p>
          Wherever you are, you can ask us what we hold about you, ask for it to be corrected or
          deleted, and withdraw marketing consent. Email{" "}
          <a href={`mailto:${ENTITY.email}`} className="underline underline-offset-2">
            {ENTITY.email}
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
          This website does not send text messages, and nothing on it asks you to agree to any.
          The demo call in section 2 is a voice call. If we ever add texts, the programme will be
          described here first, with the carrier-standard terms: message frequency, "message and
          data rates may apply", and <strong>STOP</strong> to opt out and <strong>HELP</strong>{" "}
          for help. Marketing texts would need a separate, explicit opt-in.
        </p>
      </Section>

      <Section id="security" title="9. Security">
        <p>
          The marketing site holds no patient information, which is the first and best security
          control. What it does hold is encrypted at rest, and in transit wherever we control both
          ends, reachable only through this site's own server code, and rate-limited.
        </p>
        <p>
          The controls the product commits to for patient information are set out in the
          Business Associate Agreement. There is an agreement with every vendor that holds patient
          information, signed before any patient information reaches it; Meta and payment
          processors sign none, so the product keeps clinical content away from them. Patient information is
          encrypted at rest, and in transit wherever we control both ends. Two routes are outside
          that: a phone call is not end-to-end encrypted, and a patient who telephones has chosen
          the telephone; and a message on Instagram, Messenger or WhatsApp travels through
          Meta&apos;s systems, which we do not control. Email that would carry patient information
          goes only over an encrypted connection, and is not sent if the receiving server cannot
          accept one. A breach of unsecured patient information, or any other security incident,
          is reported to the clinic without unreasonable delay and in no case later than 60 calendar days
          after discovery.
        </p>
        <p>
          The product&apos;s servers and its database run in our cloud hosting provider&apos;s US
          East region. The voice provider&apos;s region is being confirmed in writing. A clinic can
          ask for the list of the subcontractors that handle its patients&apos; information, under
          its Business Associate Agreement. No third party has audited us; these are our own
          commitments. The annex to our{" "}
          <a href="/terms#security" className="underline underline-offset-2">terms</a> describes the
          controls, and we will show you the architecture behind any of them.
        </p>
      </Section>

      <Section id="entity" title="10. Operating entity, changes and contact">
        {/* Adopted 3 Oct 2026 by the owner without external counsel review:
            the entity sentence in the wording the spec requires on the footer,
            Terms and Privacy. The registered address prints only once
            ENTITY.registeredAddress is filled in from the trade licence. */}
        <p>
          {site.name} is a service of {entityDisplayName()}, {ENTITY.formation}
          {ENTITY.registeredAddress ? `, registered address ${ENTITY.registeredAddress}` : ""}.
          Everything on this page applies regardless of the operating entity's place of
          incorporation.
        </p>
        <ul className="list-disc space-y-2 pl-6">
          <li>
            <strong>Privacy requests, and everything else:</strong>{" "}
            <a href={`mailto:${ENTITY.email}`} className="underline underline-offset-2">
              {ENTITY.email}
            </a>
          </li>
          <li>
            <strong>{ENTITY.postalAddressLabel}:</strong> {ENTITY.postalAddress}
          </li>
        </ul>
        <p>
          When this policy changes we update the version and date at the foot of the page. A
          change that reduces your rights or widens what we collect is announced on this page for
          30 days before it takes effect and, for customers, by email.
        </p>
      </Section>

      {/* Adopted 3 Oct 2026 by the owner without external counsel review.
          Required for Google's verification of the Calendar scope: what the
          app does with Google user data, and the Limited Use statement,
          verbatim in substance. It describes the v1 calendar connection in
          docs/v1-product-spec.md ("Where bookings are written"), which is not
          built yet; every sentence must be true before the first clinic
          connects. */}
      <Section id="google" title="11. Google Calendar data (clinics that connect a calendar)">
        <p>
          A clinic that uses {site.name} connects its Google Calendar with a Google sign-in during
          setup, and chooses which calendar the assistant uses. With that access the product does
          two things, and only these:
        </p>
        <ul className="list-disc space-y-3 pl-6">
          <li>
            <strong>Reads availability</strong> on the chosen calendar, so the assistant offers
            patients times that are actually free.
          </li>
          <li>
            <strong>Creates and changes the events it books</strong> on that calendar.
          </li>
        </ul>
        <p>
          It uses other events on the calendar only to see when the clinic is busy, never changes
          an event it did not create, and writes to no other Google service. The access is used only to provide the booking feature
          the clinic turned on. We do not sell Google user data, do not use it for advertising, do
          not use it to build or improve generalized artificial intelligence or machine learning
          models, and do not let people read it except where the clinic asks us to, where it is
          needed for security, or where the law requires it. It is shared with no one except the
          service providers that run the product for us, whose list a clinic can ask us for, and
          only as they need it to do so.
        </p>
        <p>
          <strong>
            {site.name}&apos;s use and transfer to any other app of information received from
            Google APIs will adhere to the{" "}
            <a
              href="https://developers.google.com/terms/api-services-user-data-policy"
              className="underline underline-offset-2"
            >
              Google API Services User Data Policy
            </a>
            , including the Limited Use requirements.
          </strong>
        </p>
        <p>
          The connection is stored encrypted. A clinic can disconnect or change the calendar from
          its portal at any time, which deletes the stored connection, or remove {site.name}&apos;s
          access from its Google Account&apos;s security settings, which ends it at once. The events
          the assistant booked stay in the clinic&apos;s own calendar, which the clinic controls
          under its own agreement with Google.
        </p>
      </Section>

      {/* Adopted 3 Oct 2026 by the owner without external counsel review.
          Required for Meta App Review of the messaging permissions: what
          Platform data the product receives and how it is used, kept and
          deleted. Describes the v1 Meta bot in docs/v1-product-spec.md ("Meta
          bot behaviour"), which is not built yet, and the one Meta rule in
          docs/counsel/agreement-changes.md § 6. */}
      <Section id="meta" title="12. Messages received through Meta (Instagram, Messenger, WhatsApp)">
        <p>
          A clinic can connect its Facebook Page, its Instagram professional account and its
          WhatsApp Business number. When it does, Meta sends {site.name} the messages people send
          to those accounts, with the identifiers Meta attaches to them (on WhatsApp, the
          sender&apos;s phone number), and the assistant replies on the clinic&apos;s behalf.
        </p>
        <ul className="list-disc space-y-3 pl-6">
          <li>
            <strong>Only to answer.</strong> The assistant uses the messages to answer the person
            who wrote, on the clinic&apos;s behalf, and to book an appointment or send the
            clinic&apos;s own payment link while that conversation is open. The payment link
            itself carries an amount and a reference and never names a time, service or
            practitioner. The messages are never used for advertising, never sold, and never used
            to train models.
          </li>
          <li>
            <strong>Only when the person wrote first.</strong> The assistant replies only inside the
            window Meta opens when someone messages the clinic. It never messages anyone first and
            sends nothing after a conversation ends.
          </li>
          <li>
            <strong>Nothing clinical.</strong> Meta does not sign the agreements that health
            information requires, so these conversations are kept non-clinical: clinical content is
            detected when a message arrives and is not stored, and the assistant moves the
            conversation to a call or the clinic&apos;s own secure route.
          </li>
          <li>
            <strong>Kept for the clinic.</strong> The conversation is kept for the clinic that
            received it, under that clinic&apos;s instructions and its Business Associate Agreement
            with us, and is visible to that clinic&apos;s team in its portal, and to healdesk staff
            only as the clinic&apos;s agreement allows. It is deleted automatically{" "}
            {TRANSCRIPT_RETENTION_DAYS} days after it took place, or sooner if the clinic chooses.
            If you wrote to a clinic, that clinic controls the record; see section 13.
          </li>
        </ul>
      </Section>

      {/* Adopted 3 Oct 2026 by the owner without external counsel review.
          The data-deletion instructions Meta asks for, summarised here and set
          out in full at /data-deletion. */}
      <Section id="deletion" title="13. Deleting your data">
        <p>
          How to have data deleted, whether you visited this site, use {site.name} as a clinic, or
          messaged a clinic that uses it, is set out on our{" "}
          <a href="/data-deletion" className="underline underline-offset-2">
            data deletion page
          </a>
          . In short: email{" "}
          <a href={`mailto:${ENTITY.email}`} className="underline underline-offset-2">
            {ENTITY.email}
          </a>{" "}
          and we answer within 30 days, as in section 7. Where the data belongs to a clinic&apos;s
          patients, we act on that clinic&apos;s instructions.
        </p>
      </Section>
    </LegalPage>
  );
}
