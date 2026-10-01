import type { Metadata } from "next";

import { LegalPage, Section } from "@/components/LegalPage";
import { ENTITY } from "@/lib/legal";
import { site } from "@/lib/site";

export const metadata: Metadata = {
  title: "Data deletion",
  description:
    "How to have your data deleted by healdesk: as a visitor to this site, as a clinic that uses healdesk, or as someone who messaged a clinic on Instagram, Messenger or WhatsApp.",
};

/**
 * /data-deletion, the deletion instructions Meta's App Review asks every app
 * that receives Platform data to publish, and the page privacy § 13 points at.
 * Linked from the footer and listed in the sitemap.
 *
 * DRAFT pending counsel review (2026-09-30). Three audiences, because the
 * answer differs: a visitor to this site, whose data we control; a clinic,
 * whose connections and account we hold; and a patient who messaged a
 * clinic, whose record the clinic controls under its Business Associate
 * Agreement with us, so we act on the clinic's instructions rather than
 * deleting a clinic's record on our own say-so. The 30-day answer is the one
 * privacy § 7 already promises; nothing here adds a new timeline.
 *
 * The clinic routes describe the v1 portal (docs/v1-product-spec.md, "Portal
 * map"), which is not built yet; the email route works today.
 */
export default function DataDeletionPage() {
  const email = (
    <a href={`mailto:${ENTITY.privacyEmail}`} className="underline underline-offset-2">
      {ENTITY.privacyEmail}
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
            <strong>Instagram, Messenger and WhatsApp.</strong> Disconnect the channel from the
            Channels screen of your portal, or remove {site.name} from the business integrations
            in your Facebook, Instagram or WhatsApp settings. Either stops Meta sending us anything
            further.
          </li>
          <li>
            <strong>Google Calendar.</strong> Disconnect it from your portal, or remove{" "}
            {site.name}&apos;s access from your Google Account&apos;s security settings.
          </li>
          <li>
            <strong>Everything else.</strong> Conversations, bookings and the data we received from
            Google or Meta are deleted on your instruction, under your Business Associate Agreement
            with us. Email {email} from the owner&apos;s address on the account. Our AI model
            provider keeps conversation inputs for 30 days under its own agreement, which we cannot
            shorten.
          </li>
        </ul>
      </Section>

      <Section id="patients" title="If you messaged or called a clinic that uses healdesk">
        <p>
          The clinic you contacted controls the record of that conversation, and we act on its
          instructions. Ask the clinic to delete it. If you would rather ask us, email {email},
          say which clinic you contacted and on which channel, and we will pass the request to that
          clinic and tell you we have.
        </p>
      </Section>
    </LegalPage>
  );
}
