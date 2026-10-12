import { SUBPROCESSOR_NOTICE_HOURS } from "@healdesk/catalog";
import type { Metadata } from "next";

import { LegalPage, Section } from "@/components/LegalPage";
import { ENTITY, POLICY } from "@/lib/legal";
import { SUBPROCESSORS, type BaaStatus, type Subprocessor } from "@/lib/subprocessors";

export const metadata: Metadata = {
  alternates: { canonical: "/subprocessors" },
  title: "Subprocessors",
  description:
    "Every company that processes data for healdesk, what each receives, where it runs, and whether it handles patient information under a signed agreement.",
};

/**
 * The page the Business Associate Agreement promises: "a current list of
 * these subcontractors at healdesk.io/subprocessors". The list itself lives
 * in src/lib/subprocessors.ts so the agreement, this page and the compliance
 * file all read one source.
 *
 * The "How to read this" text describes two kinds of row. It does not say
 * every patient-information vendor is pinned to a US region: that is not
 * confirmed for Retell, and the region column says so where it is not. The
 * clinic's own calendar, its own payment processor and its own Instagram,
 * Messenger and WhatsApp accounts are in the patient's path too, but they are
 * the clinic's own services, connected under its own accounts, so they are
 * notes above the register rather than rows in it.
 *
 * Adopted 3 Oct 2026 by the owner without external counsel review, with the
 * Anthropic row split in two and the deposit leg moved out of Stripe's row
 * (docs/counsel/agreement-changes.md § 8). The BAA points at this page.
 *
 * Revised on 12 October 2026 as LEGAL_VERSION 2026-10-12.1, for BAA 1.3.0
 * (release gate 13, docs/counsel/agreement-changes.md § 12.14). Meta's row
 * became the third note, in the words of 1.3.0's clauses headed "Where
 * Practice is not a covered entity" (the clinic's own services) and "What
 * healdesk is not authorised to do" (Meta signs no business associate
 * agreement; replies only inside a conversation the person started; each
 * message checked before the model sees it). "Notice of changes" gives the
 * Subcontractors clause's 24 hours, sent to the Notices clause's address and
 * naming the vendor, what it will receive and why, and says that an agreement
 * earlier than 1.3.0 keeps its fifteen days. The objection's effect is the
 * Term clause's: the service ends that day and the prorated unused part of
 * the paid subscription period is refunded, as Terms § 15 gives every clinic
 * (the owner's refund rule of 12 October 2026).
 */
export default function SubprocessorsPage() {
  return (
    <LegalPage
      title="Subprocessors"
      intro="Every company that processes data on our behalf, what it receives, and whether a signed agreement covers patient information."
    >
      <Section id="how-to-read" title="How to read this">
        <p>
          <strong>Handles patient information</strong> is the column that matters, and a row is
          one of two kinds.
        </p>
        <ul className="list-disc space-y-3 pl-6">
          <li>
            <strong>Yes.</strong> The vendor receives information that HIPAA protects and works
            under a Business Associate Agreement with us. The <em>Agreement</em> column says
            whether that agreement is signed or still to be executed; no patient information goes
            to a vendor until it is signed.
          </li>
          <li>
            <strong>No.</strong> The vendor never receives patient information: it hosts or
            measures this website, runs its demo, places a demo call a visitor asked for, bills
            your subscription, or sends email that carries none, and the row says which.
          </li>
        </ul>
        <p>
          Three services in the patient&apos;s path have no row, because they are yours, not
          vendors of ours: you connect each of them, where you use it, under your own account
          with its provider.
        </p>
        <p>
          Bookings are written into your own Google Calendar. That calendar is yours, held under
          your own agreement with Google, so it is not a vendor of ours and has no row here. (The
          Google row below is this website&apos;s own lead register, which never holds patient
          information.)
        </p>
        <p>
          Deposits, where you take them, go through your own payment processor account, which
          you connect during setup. It is yours too, under your own agreement with it, so it has
          no row here either. A deposit link carries only an amount, a generic description and
          a reference code: no treatment name or other clinical detail, in the description, the
          statement descriptor or the metadata. (The Stripe row below is our own billing of your
          subscription.)
        </p>
        <p>
          Instagram, Messenger and WhatsApp, where you connect them, are your own accounts with
          Meta, so Meta has no row here either. Meta signs no business associate agreement and
          keeps what passes through those channels, so they are scoped, not covered: a reply
          there tells Meta at least that the person is in contact with your clinic. The assistant
          replies there only inside a conversation the person started, and only within the window
          Meta allows. It checks each message for clinical content before the language model sees
          it, and moves anything clinical to a call or to your own secure route. We give Meta
          nothing for advertising or analytics.
        </p>
      </Section>

      <Section id="register" title="The register">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-[14.5px]">
            <thead>
              <tr className="border-line border-b text-left">
                <th className="py-2 pr-3 font-semibold">Vendor</th>
                <th className="py-2 pr-3 font-semibold">Purpose</th>
                <th className="py-2 pr-3 font-semibold">Receives</th>
                <th className="py-2 pr-3 font-semibold">Region</th>
                <th className="py-2 pr-3 font-semibold">Handles patient information</th>
                <th className="py-2 font-semibold">Agreement</th>
              </tr>
            </thead>
            <tbody>
              {SUBPROCESSORS.map((v) => (
                <tr key={v.name} className="border-line border-b align-top">
                  <td className="py-2.5 pr-3 font-semibold">{v.name}</td>
                  <td className="py-2.5 pr-3">{v.purpose}</td>
                  <td className="py-2.5 pr-3">{v.data}</td>
                  <td className="py-2.5 pr-3">{v.region || "Not yet confirmed"}</td>
                  <td className="py-2.5 pr-3">{handles(v)}</td>
                  <td className="py-2.5">{describe(v.baa)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      <Section id="notice" title="Notice of changes">
        <p>
          Before a new vendor handles patient information, we email every clinic at least{" "}
          {SUBPROCESSOR_NOTICE_HOURS} hours in advance, naming the vendor, what it will receive and
          why. A clinic whose business associate agreement is a version earlier than{" "}
          {POLICY.subprocessorNoticeHoursFromBaaVersion} gets at least{" "}
          {POLICY.earlierBaaSubprocessorNoticeDays} days&apos; notice instead.
        </p>
        <p>
          The email goes to the clinic&apos;s notice address: the email address on its account,
          which is also the one it signs in with and is billed at (before the account exists, the
          signatory&apos;s), unless it has given us another address for notices in writing. Under
          an agreement earlier than{" "}
          {POLICY.subprocessorNoticeHoursFromBaaVersion}, it goes to the signatory&apos;s email
          address, and to any other address the clinic has given us for notices in writing.
        </p>
        <p>
          A clinic that objects on reasonable grounds before the change takes effect may terminate
          its agreement without penalty. Its subscription and the service end on the day it
          terminates, no fees accrue for any time after that day, and we refund the prorated
          unused part of the subscription period it has paid for, as section 15 of our{" "}
          <a href="/terms#term" className="underline underline-offset-2">
            terms
          </a>{" "}
          sets out. Vendors that do not handle patient information are added to this page without
          notice.
        </p>
        <p>
          Questions about any row:{" "}
          <a href={`mailto:${ENTITY.privacyEmail}`} className="underline underline-offset-2">
            {ENTITY.privacyEmail}
          </a>
          .
        </p>
      </Section>
    </LegalPage>
  );
}

function handles(vendor: Subprocessor): string {
  return vendor.handlesPhi ? "Yes" : "No";
}

function describe(status: BaaStatus): string {
  switch (status.state) {
    case "signed":
      return `BAA signed ${status.on}`;
    case "requested":
      return `BAA requested ${status.on}; no patient information is sent until it is signed`;
    case "pending":
      return "BAA to be executed before any patient information is processed; none is today";
    case "not-needed":
      return `Not required — ${status.because}`;
  }
}
