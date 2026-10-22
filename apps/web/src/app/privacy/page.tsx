import { TRANSCRIPT_RETENTION_DAYS } from "@healdesk/catalog";
import type { Metadata } from "next";

import { LegalPage, Section } from "@/components/LegalPage";
import { CookieChoice } from "@/components/analytics/CookieChoice";
import { CALL_CONSENT, CONSENT_NOTICE_VERSION, MARKETING_CONSENT_LABEL, DEMO_ACCESS_DAYS } from "@/lib/consent";
import { OWN_DEMO_KEY } from "@/lib/demo/remembered";
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
 *
 * Revised on 12 October 2026 as LEGAL_VERSION 2026-10-12.2, for BAA 1.3.0
 * (release gate 12, agreement-changes.md § 12.14):
 *   - section 14 is the public commitment 1.3.0's clause headed "healdesk's
 *     own use, and de-identified statistics" says healdesk makes "at
 *     healdesk.io/privacy", in that clause's words and no further;
 *   - section 11 follows 1.3.0's Google Calendar clause: the calendar, or one
 *     per provider; the account's main calendar until one is chosen; the
 *     calendar names it reads so the clinic can choose; the three things
 *     Google's permission reaches that healdesk neither reads nor stores; and
 *     when the stored connection is deleted;
 *   - section 9 says a vendor signs before patient information reaches it, as
 *     1.3.0's Subcontractors clause does, a promise rather than a statement
 *     of fact. Its breach clock stays the 9 October wording: the 24 hours
 *     apps/app's incident deadline keeps is an internal operating target, and
 *     no public page promises it;
 *   - section 12 says no more than 1.3.0's softened clauses 11 and 16, which
 *     the owner chose on 12 October 2026: no message and no summary is kept;
 *     from these channels only a first name and a telephone number, each
 *     checked by automated filters designed to keep clinical content out,
 *     preferred times in a fixed day-and-time form, and Meta's identifier
 *     for the conversation (booking_requests.sender_id, which clause 4's data
 *     list names); each message checked before the model sees it; the
 *     assistant instructed, each reply filtered, a refused reply replaced by
 *     a fixed one, and no filter catching every wording. It said the
 *     conversation was kept for 90 days and that clinical content was
 *     "detected … and not stored". Section 5's "keeps them non-clinical" is
 *     "set up to keep clinical content off them". Section 12 also says the
 *     assistant takes a request for an appointment, books nothing and sends
 *     no payment link there, where it said it could "book an appointment or
 *     send the clinic's own payment link": lib/meta/front-door.ts creates
 *     booking requests only, and nothing calls depositLinkMessage.
 *
 * Revised on 13 October 2026 as LEGAL_VERSION 2026-10-13.3, for BAA 1.4.0
 * (agreement-changes.md § 14): the owner decided that day that healdesk
 * keeps no transcript. Section 6 says each call's and website chat's
 * transcript is emailed to the clinic, that the one encrypted copy held to
 * send a failed email again goes seven days after the email is first
 * accepted (or after it was queued, if it never is), and that the
 * conversation's record, without what was said, goes at 90 days, where it
 * said each conversation and its transcript went at 90 days "or sooner if
 * the clinic chooses a shorter period". Section 12's "or sooner if the
 * clinic chooses" is "or sooner if the clinic asks us to delete them": the
 * portal setting it leaned on shortened transcripts only, and is gone.
 *
 * Revised on 14 October 2026 as LEGAL_VERSION 2026-10-14.1, for BAA 1.5.0
 * (agreement-changes.md § 15): the owner decided that day that the copy is
 * deleted the moment delivery is confirmed. Section 6 says it goes as soon as
 * the clinic's mail server confirms delivery, that an email that cannot be
 * delivered is tried for at most 30 days, that one never confirmed goes 72
 * hours after it was sent, and that a record of each transcript's delivery
 * is kept without the words, where it said seven days after the email was
 * first accepted.
 *
 * Revised on 22 October 2026 as LEGAL_VERSION 2026-10-22.1 (see the terms): section 6's
 * "no call audio is kept at all" is "We keep no call audio: our voice
 * provider holds a call's transcript and recording only until we have the
 * transcript, and for no more than a day." The demo call's line is unchanged:
 * the demo agents keep only a basic record, no recording or transcript.
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
          cover patients of our customers, except as sections 11 to 14 say about the product.
        </p>
        {/* Adopted 3 Oct 2026 by the owner without external counsel review.
            The scope sentence for sections 11 to 13, which Google's and Meta's
            app reviews read. Section 14 added 12 Oct 2026 (LEGAL_VERSION
            2026-10-12.2). */}
        <p>
          Sections 11 and 12 also describe what the product does with data it receives from Google
          and from Meta when a clinic connects its Google Calendar, its Facebook Page, its Instagram
          account or its WhatsApp number, and section 13 says how to have that data deleted.
          Section 14 is the public commitment our Business Associate Agreement makes about
          de-identified statistics.
        </p>
        <p>
          <strong>Patient information is not handled on this website.</strong> When a clinic
          becomes a customer, its patients' information is processed only inside the product,
          under a Business Associate Agreement the clinic signs at checkout or, for a clinic HIPAA
          does not cover, such as a veterinary practice, the data protection agreement it signs in
          its place. That agreement, not this page, governs patient data. If you are a patient of
          a clinic that uses{" "}
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
            {/* LEGAL_VERSION 2026-10-12.1: quotes the shorter consent wording
                (CALL_CONSENT 2026-10-12.1, lib/consent.ts says what changed). */}
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
                demo's "Call us", which keeps the number you will call from.
                The "Show me" sentence was added 12 Oct 2026 under the same
                unpublished version, with the preview (api/own-demo/preview). */}
            <strong>If you ask for your own demo.</strong> &ldquo;See it in your own branding&rdquo;
            on the homepage asks for your clinic&apos;s website and your email. &ldquo;Show
            me&rdquo; first reads the website&apos;s front page once, to draw its name, logo and
            colours in the preview, and keeps nothing from it. We read the
            website&apos;s public pages, and the practice&apos;s public business listing for its
            opening hours, and our AI model provider turns them into a private demo page in your
            clinic&apos;s name. We keep the website, your email and what was read with the demo,
            and email you its link once. Our team gets a copy of the request and may reply; it is
            not added to a marketing list. If you tell us the number you will call the demo line
            from, we keep it with the demo so the line answers as your clinic. A demo is live for{" "}
            {DEMO_LIFETIME_DAYS} days; section 6 says when it is deleted.
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
            {/* Added 13 Oct 2026 (LEGAL_VERSION 2026-10-13.1), when the
                homepage began remembering the demo it builds
                (lib/demo/remembered.ts). */}
            <strong>Your own demo&apos;s link</strong> — functional, and not a cookie: if you ask
            for your own demo on the homepage, its private link and your website&apos;s address are
            kept in your browser's local storage under <code>{OWN_DEMO_KEY}</code>, so the homepage
            can take you back to it. It is never sent to us, and it is offered only while the demo
            is live; clearing this site&apos;s data removes it.
          </li>
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
          and WhatsApp travel through Meta, which signs no such agreement, so the product is set up
          to keep clinical content off them (section 12). The list of the subcontractors that handle patient
          information is given to clinics on request, under the Business Associate Agreement or
          the data protection agreement the clinic signed.
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
            Inside the product, a clinic&apos;s patient conversations: we keep no transcript. When
            a call or a website chat ends, its transcript is emailed to the clinic, and the one
            encrypted copy we hold so that a failed email can be sent again is deleted as soon as
            the clinic&apos;s mail server confirms delivery. If the email cannot be delivered we
            keep trying for at most 30 days after the transcript was queued, and if its delivery is
            never confirmed we delete the copy 72 hours after it was sent. We keep a record that
            each transcript was delivered, without what was said. The record of each conversation,
            without what was said, is deleted automatically {TRANSCRIPT_RETENTION_DAYS} days after
            it took place. We keep no call audio: our voice provider holds a call&apos;s transcript
            and recording only until we have the transcript, and for no more than a day. The
            clinic&apos;s Business Associate Agreement with us governs the rest.
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
          Business Associate Agreement. Every vendor that will handle patient information for us
          signs an agreement with us before any patient information reaches it; Meta and payment
          processors sign none, so the product keeps clinical content away from them. Patient
          information is encrypted at rest, and in transit wherever we control both ends. Two
          routes are outside
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
          docs/v1-product-spec.md ("Where bookings are written"); every
          sentence must be true before the first clinic connects. Revised 12
          Oct 2026 (LEGAL_VERSION 2026-10-12.2) to BAA 1.3.0's clause headed
          "Google Calendar", which every calendar clause and election shares
          in these respects. */}
      <Section id="google" title="11. Google Calendar data (clinics that connect a calendar)">
        <p>
          A clinic that uses {site.name} connects its Google Calendar with a Google sign-in during
          setup, and chooses the calendar the assistant books into or, where it books by provider,
          one calendar for each provider. Until it chooses, the product uses the main calendar of
          the account it connected. With that access the product does these things, and only
          these:
        </p>
        <ul className="list-disc space-y-3 pl-6">
          <li>
            <strong>Reads the names of the calendars</strong> that account owns or manages, so the
            clinic can choose.
          </li>
          <li>
            <strong>Reads when each chosen calendar is free or busy</strong>, so the assistant
            offers patients times that are actually free.
          </li>
          <li>
            <strong>Adds appointments</strong> to a chosen calendar when the assistant books one
            and when the clinic&apos;s staff confirm a booking request, and reads back only the
            appointments it added. Each is private, with no guests and no reminders, and carries a
            first name, the service and the time: never a phone number, an email address, or
            anything clinical beyond the service&apos;s name.
          </li>
        </ul>
        <p>
          Google&apos;s permission also reaches the list of every calendar the account subscribes
          to, the other events on its calendars, and when its other calendars are free or busy; the
          product does not read or store any of them. It never moves, edits or cancels an event it
          did not create, and writes to no other Google service. The access is used only to provide the booking feature
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
          The connection is stored encrypted, and the product stops using it when the
          clinic&apos;s service ends. A clinic can change the calendar in its portal at any time,
          or disconnect it there, which deletes the stored connection. It can also remove{" "}
          {site.name}&apos;s access from its Google Account&apos;s security settings, which ends
          the access at once; we delete the stored connection when we next find that it no longer
          works. In any case it is deleted when we destroy the clinic&apos;s data after its service
          ends. The appointments already added stay in the clinic&apos;s own calendar, which the
          clinic controls under its own agreement with Google.
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
            who wrote, on the clinic&apos;s behalf, and to take a request for an appointment,
            which the clinic&apos;s staff then confirm, while that conversation is open. It books
            nothing itself and sends no payment link there. The messages are never used for
            advertising, never sold, and never used to train models.
          </li>
          <li>
            <strong>Only when the person wrote first.</strong> The assistant replies only inside the
            window Meta opens when someone messages the clinic. It never messages anyone first and
            sends nothing after a conversation ends.
          </li>
          <li>
            <strong>Nothing clinical, as far as we can.</strong> Meta does not sign the
            agreements that health information requires, so the product is set up to keep these
            conversations non-clinical. Each message is checked for clinical content before the
            language model sees it. The assistant is instructed not to repeat clinical content,
            name a treatment or confirm appointment details there, and to move anything clinical
            to a call or the clinic&apos;s own secure route. Each reply the language model writes
            there is checked by automated filters designed to keep those out, and a reply the
            filters refuse is replaced by a fixed one. No filter catches every wording, so clinics
            should not invite clinical information on these channels, and you should not send it
            there.
          </li>
          <li>
            <strong>Kept for the clinic.</strong> We do not keep the messages a person sends, or
            a summary of one. From these channels we keep only what a booking request needs, for
            the clinic that received it: a first name and a telephone number, each checked by automated
            filters designed to keep clinical content out, the times the person prefers, only in a
            fixed day-and-time form, and the identifier Meta attaches to the conversation. They are
            kept under that clinic&apos;s instructions and its Business Associate Agreement or data
            protection agreement with us,
            are visible to that clinic&apos;s team in its portal, and to healdesk staff only as the
            clinic&apos;s agreement allows, and are deleted automatically within the periods that
            agreement sets, which run at most {TRANSCRIPT_RETENTION_DAYS} days from the latest of
            the request, its appointment and the last change to those details, or sooner if the
            clinic asks us to delete them. If you wrote to a clinic, that clinic controls the
            record; see section 13.
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

      {/* Added 12 Oct 2026 (LEGAL_VERSION 2026-10-12.2). BAA 1.3.0's clause
          headed "healdesk's own use, and de-identified statistics" says
          healdesk "commits publicly, at healdesk.io/privacy, to keep and use
          that information only in de-identified form and not to try to
          re-identify it". This is that commitment, with the rest of the
          clause it belongs to, in the clause's own terms and no wider: only
          aggregate statistics about the service, only to measure and improve
          it, combined only after de-identification. No code makes such
          statistics today. The data protection agreement for practices HIPAA
          does not reach permits none, so this section speaks only of the
          Business Associate Agreement. */}
      <Section id="de-identified" title="14. De-identified statistics">
        <p>
          Where a clinic&apos;s Business Associate Agreement allows it, we may de-identify its
          patient information, to the standard HIPAA sets in 45 CFR 164.514(b), and combine it
          with de-identified information from other clinics, only to produce aggregate statistics
          about the service, such as what fraction of after-hours calls are answered. We use those
          statistics only to measure and improve the service. We combine only information that has
          already been de-identified, and never combine patient information itself with
          information from any other source to produce them.
        </p>
        <p>
          We take reasonable measures to ensure that the de-identified information cannot be
          associated with any individual or household. We commit to keep and use it only in
          de-identified form and not to try to re-identify it, and we will not re-identify, or try
          to re-identify, any individual from it. Anyone we give it to must meet the same
          conditions under a contract with us. We never use patient information to train,
          fine-tune or evaluate any model.
        </p>
      </Section>
    </LegalPage>
  );
}
