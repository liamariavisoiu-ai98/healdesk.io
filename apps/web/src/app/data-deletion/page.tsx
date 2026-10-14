import { TRANSCRIPT_RETENTION_DAYS } from "@healdesk/catalog";
import type { Metadata } from "next";

import { LegalPage, Section } from "@/components/LegalPage";
import { ENTITY } from "@/lib/legal";
import { site } from "@/lib/site";

export const metadata: Metadata = {
  alternates: { canonical: "/data-deletion" },
  title: "Data deletion",
  description:
    "How to have your data deleted by healdesk: as a visitor to this site, as a clinic that uses healdesk, or as someone who messaged a clinic on Instagram, Messenger or WhatsApp.",
};

/**
 * /data-deletion, the deletion instructions Meta's App Review asks every app
 * that receives Platform data to publish, and the page privacy § 13 points at.
 * Linked from the footer and listed in the sitemap.
 *
 * Adopted 3 Oct 2026 by the owner without external counsel review, with the
 * model provider's two-year exception added beside its 30 days
 * (docs/counsel/agreement-changes.md, finding A3). Three audiences, because
 * the answer differs: a visitor to this site, whose data we control; a clinic,
 * whose connections and account we hold; and a patient who messaged a
 * clinic, whose record the clinic controls under its Business Associate
 * Agreement with us, so we act on the clinic's instructions rather than
 * deleting a clinic's record on our own say-so. The 30-day answer is the one
 * privacy § 7 already promises; nothing here adds a new timeline.
 *
 * The clinic routes describe the v1 portal (docs/v1-product-spec.md, "Portal
 * map"), which is not built yet; the email route works today.
 *
 * Revised 9 October 2026 (LEGAL_VERSION 2026-10-09.1): every route is
 * hello@healdesk.io, the one address, and the clinic and patient sections say
 * that transcripts are deleted automatically after TRANSCRIPT_RETENTION_DAYS,
 * the period the Business Associate Agreement states and apps/app's
 * clinics.retention_media_days defaults to, or sooner if the clinic chooses.
 *
 * Revised 13 October 2026 (LEGAL_VERSION 2026-10-13.3), for BAA 1.4.0: the
 * owner decided that day that healdesk keeps no transcript. The clinic and
 * patient sections say each transcript is emailed to the clinic and kept by
 * it, that healdesk's encrypted copy goes seven days after the email first
 * goes, and that the conversation's record, without what was said, goes at
 * TRANSCRIPT_RETENTION_DAYS, where they said the conversation and its
 * transcript went then "or sooner if you choose a shorter period in your
 * portal", a setting that is gone.
 *
 * Revised 14 October 2026 (LEGAL_VERSION 2026-10-14.1), for BAA 1.5.0: the
 * encrypted copy goes as soon as the clinic's mail server confirms delivery,
 * or 30 days after it was queued if it is never delivered, where it went
 * seven days after the email first went.
 */
export default function DataDeletionPage() {
  const email = (
    <a href={`mailto:${ENTITY.email}`} className="underline underline-offset-2">
      {ENTITY.email}
    </a>
  );
  return (
    <LegalPage
      title="Data deletion"
      intro="How to have your data deleted, depending on how it reached us. Every route ends with a person here reading your request."
    >
      <Section id="visitors" title="If you used this website">
        <p>
          Email {email} from the address you gave us and ask for your data to be deleted. That
          covers the email you unlocked the demo with, contact-form messages and the funnel events
          recorded against you. A demo-call consent record is the one exception: privacy § 6 says
          how long it is kept, and why. We verify the request by replying to
          that address and answer within 30 days. Section 7 of our{" "}
          <a href="/privacy#rights" className="underline underline-offset-2">
            privacy policy
          </a>{" "}
          sets out the rest of your rights.
        </p>
      </Section>

      <Section id="clinics" title="If you are a clinic that uses healdesk">
        <ul className="list-disc space-y-3 pl-6">
          <li>
            {/* Revised 13 Oct 2026 (LEGAL_VERSION 2026-10-13.2). The portal has no
                Channels screen: each platform has a switch in Settings, and a
                platform switched off has its messages skipped before anything is
                stored (app/api/webhooks/meta/route.ts), while Meta keeps sending
                them until its integration is removed. */}
            <strong>Instagram, Messenger and WhatsApp.</strong> Switch the channel off in Settings
            in your portal: we stop answering it and keep nothing from new messages. To stop Meta
            sending them to us at all, remove {site.name} from the business integrations in your
            Facebook, Instagram or WhatsApp settings.
          </li>
          <li>
            <strong>Google Calendar.</strong> Disconnect it from your portal, or remove{" "}
            {site.name}&apos;s access from your Google Account&apos;s security settings.
          </li>
          <li>
            <strong>Everything else.</strong> Conversations, bookings and the data we received from
            Google or Meta are deleted on your instruction, under your Business Associate Agreement
            with us. We keep no transcript: each is emailed to you when its conversation ends, and
            our encrypted copy is deleted as soon as your mail server confirms it has the email (or
            30 days after it was queued, if it is never delivered), so a transcript in your inbox
            is yours to delete. The record of each conversation, without what was
            said, is also deleted automatically {TRANSCRIPT_RETENTION_DAYS} days after it took
            place. Email {email} from the owner&apos;s address on the account. Our AI model
            provider keeps conversation inputs for 30 days under its own agreement, which we cannot
            shorten, and may keep content its automated trust-and-safety systems flag, or that the
            law requires it to keep, for up to two years.
          </li>
        </ul>
      </Section>

      <Section id="patients" title="If you messaged or called a clinic that uses healdesk">
        <p>
          The clinic you contacted controls the record of that conversation, and we act on its
          instructions. We keep no transcript of a call or a website chat: it goes to the clinic
          by email, and the clinic keeps it. Our record of the conversation, without what was
          said, is deleted automatically {TRANSCRIPT_RETENTION_DAYS} days after it. To have
          either deleted sooner, ask the clinic. If you would rather ask us, email {email},
          say which clinic you contacted and on which channel, and we will pass the request to that
          clinic and tell you we have.
        </p>
      </Section>
    </LegalPage>
  );
}
