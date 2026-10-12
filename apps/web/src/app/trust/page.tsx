import { SUBPROCESSOR_NOTICE_HOURS } from "@healdesk/catalog";
import type { Metadata } from "next";

import { LegalPage, Section } from "@/components/LegalPage";
import { ENTITY, POLICY } from "@/lib/legal";
import { site } from "@/lib/site";
import { PHI_SUBPROCESSORS, SUBPROCESSORS } from "@/lib/subprocessors";

export const metadata: Metadata = {
  alternates: { canonical: "/trust" },
  title: "Trust and security",
  description:
    "How healdesk protects patient information: the boundary, the controls, the vendors, and what we do not claim.",
};

/**
 * The trust page.
 *
 * docs/research-conclusions.md "What we shipped instead" is the brief: no
 * badges, no "HIPAA compliant" seal (the FTC has brought a deception count
 * for exactly that), no claims of audits that have not happened. What a
 * clinic's compliance reviewer actually asks for is the architecture, the
 * vendor list with agreement status, the breach clock, and a named person —
 * so that is what this page is.
 *
 * Every vendor row is the same register the BAA promises and /subprocessors
 * publishes; the counts below are computed from it so the two pages cannot
 * disagree.
 *
 * Section 4, on the parts of the patient's path with no agreement (Meta, the
 * clinic's own payment processor), Anthropic's 30-day retention and the
 * clinic's own Google Calendar, was added on 30 September 2026 from
 * docs/v1-product-spec.md ("HIPAA and BAA position"). Adopted 3 Oct 2026 by
 * the owner without external counsel review, with every claim cut back to
 * what is decided (docs/counsel/agreement-changes.md § 8): encryption in
 * transit only where we control both ends, with the telephone and Meta
 * exceptions; email as the BAA describes it; the hosting region that is
 * decided, and the voice provider's as not yet confirmed; the model
 * provider's two-year exception; and the vendor check before production
 * described as the operator's check it is, not as something the software
 * enforces.
 *
 * Revised on 12 October 2026 as LEGAL_VERSION 2026-10-12.1, for BAA 1.3.0
 * (release gate 13, docs/counsel/agreement-changes.md § 12.14). Section 3
 * gives the Subcontractors clause's 24 hours, with the fifteen days an
 * agreement earlier than 1.3.0 keeps, and no longer counts Meta as a scoped
 * row of the register: the clinic's Instagram, Messenger and WhatsApp
 * accounts are its own, as 1.3.0 says, and section 4 covers them. Section 5
 * gives the clause headed "Reporting breaches and security incidents" in
 * place of five calendar days for a breach and five business days for an
 * incident: immediately following discovery and in any case within 24 hours,
 * which apps/app's incident deadline applies to every clinic, whichever
 * version it signed (agreement-changes.md § 12.14, gate 5).
 */
/** Small counts read better as words in prose. Past ten, the digit is fine. */
const WORDS: Record<number, string> = {
  2: "Two", 3: "Three", 4: "Four", 5: "Five", 6: "Six", 7: "Seven", 8: "Eight", 9: "Nine", 10: "Ten",
};

export default function TrustPage() {
  const signed = PHI_SUBPROCESSORS.filter((s) => s.baa.state === "signed").length;
  const pending = PHI_SUBPROCESSORS.length - signed;
  return (
    <LegalPage
      title="Trust and security"
      intro="What we do with patient information, what we do not, and how you can check. No badges — the controls, and the list of what is still in progress."
    >
      <Section id="boundary" title="1. The boundary">
        <p>
          {site.name} is two systems. This website and the demo hold no patient information at
          all: a clinic owner's work email, a chat with a demo agent, a business enquiry. The
          product — the agent that answers your phone and chat — runs on separate infrastructure,
          under the Business Associate Agreement you sign at checkout, and that is the only place
          a caller's name, number or question ever lives.
        </p>
        <p>
          The line is enforced in code, not policy: the marketing site's database schema is
          tested against a denylist of patient-shaped columns, and the product's database refuses
          to write patient information for any clinic until its agreement is bound and the clinic
          is deliberately moved to production.
        </p>
      </Section>

      <Section id="controls" title="2. What protects patient information">
        <ul className="list-disc space-y-3 pl-6">
          <li>
            <strong>One clinic cannot see another.</strong> Every table that holds patient
            information carries row-level security that the application role cannot bypass and
            the table owner cannot skip. A test suite asserts, for every such table, that the
            policy exists, is forced, and names the clinic column.
          </li>
          <li>
            <strong>The AI says it is an AI, first.</strong> Every call, chat and DM opens with a
            line saying the patient is talking to an AI assistant; on the phone the same breath
            says the call is transcribed and that no audio recording is kept. The clinic cannot
            switch it off or edit it out through the greeting, and it is the first line of every
            transcript.
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
            <strong>Where it runs.</strong> The product&apos;s servers and its database run in
            Amazon Web Services&apos; US East region. The voice provider&apos;s region is being
            confirmed in writing, and appears on{" "}
            <a href="/subprocessors" className="underline underline-offset-2">/subprocessors</a>{" "}
            once it is.
          </li>
          <li>
            <strong>Every access is recorded.</strong> Reads and writes of patient information
            are written to an append-only audit table in the same transaction as the access, so
            an access that rolled back leaves no false claim behind, and a real one cannot be
            erased by the application.
          </li>
          <li>
            <strong>Logs cannot carry patient data.</strong> The product has a single logger with an
            allowlist of fields and a scrubber for numbers and addresses; a test fails the build
            on any log call that goes around it.
          </li>
          <li>
            <strong>No advertising platforms, anywhere.</strong> No pixel on this site, no
            conversion API in the product, and nothing about a patient is ever sent to Meta or
            Google for advertising; a browser policy on this site blocks the connections outright.
            Section 4 covers the two routes that carry patient details by design.
          </li>
          <li>
            <strong>Signed agreements are evidence.</strong> The exact text a clinic signed, its
            hash, who signed and when are stored append-only; the database role the application
            uses holds no permission to change or delete them.
          </li>
        </ul>
      </Section>

      <Section id="vendors" title="3. Who touches patient information">
        <p>
          {PHI_SUBPROCESSORS.length} vendors process patient information for the product.{" "}
          {signed} {signed === 1 ? "has" : "have"} a countersigned Business Associate Agreement with
          us; {pending} {pending === 1 ? "is" : "are"} pending. The full register, with what each
          receives and the status of each agreement, is at{" "}
          <a href="/subprocessors" className="underline underline-offset-2">/subprocessors</a>.
          Before a new vendor handles patient information, we email every clinic at its notice
          address at least {SUBPROCESSOR_NOTICE_HOURS} hours in advance, naming the vendor, what it
          will receive and why; a clinic whose business associate agreement is a version earlier
          than {POLICY.subprocessorNoticeHoursFromBaaVersion} gets at least{" "}
          {POLICY.earlierBaaSubprocessorNoticeDays} days&apos; notice instead.{" "}
          {SUBPROCESSORS.length - PHI_SUBPROCESSORS.length} further vendors serve this
          website, the demo and billing and never receive patient information.
        </p>
        <p>
          Your Google Calendar, your payment processor and your Instagram, Messenger and WhatsApp
          accounts are in the patient&apos;s path too. They are yours, connected under your own
          accounts, not vendors of ours, and section 4 says how we handle each.
        </p>
      </Section>

      <Section id="no-baa" title="4. Where there is no agreement, and how we handle it">
        <ul className="list-disc space-y-3 pl-6">
          <li>
            <strong>Instagram, Messenger and WhatsApp.</strong> These are your own accounts with
            Meta, which you connect only if you choose to. Meta signs no Business Associate
            Agreement for any messaging product, and no vendor in front of Meta can change that.
            So these channels are scoped to carry nothing clinical. A patient&apos;s message
            travels through Meta because that is where the patient wrote to you. Anything clinical
            in it is caught when it arrives, is not stored, is not repeated back and is not carried
            into a summary, and the assistant moves the conversation to a call or your own secure
            route and says why in one sentence. Replies never name a treatment.
          </li>
          <li>
            <strong>Deposits.</strong> A deposit is taken through your own payment processor
            account, under your own agreement with it, and Stripe, for one, signs no agreement on
            any tier. So a deposit link carries only an amount, a generic description and a
            reference code: no treatment name, not in the description, the statement descriptor or
            the metadata.
          </li>
          <li>
            <strong>The AI model keeps inputs for 30 days.</strong> Our model provider covers its
            API under its own Business Associate Agreement, but the models it covers require 30
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
            <strong>Who we are.</strong> {site.name} is a service of {ENTITY.legalName},{" "}
            {ENTITY.formation}. HIPAA&apos;s obligations attach to a business associate wherever it
            is incorporated, and ours are in the agreement. Questions about data location,
            enforcement or our vendors go to the address in section 7.
          </li>
        </ul>
      </Section>

      <Section id="breach" title="5. If something goes wrong">
        <p>
          We tell the clinic, by email to its notice address, immediately after we discover a
          breach of unsecured patient information, a security incident, or a use or disclosure of
          patient information that the agreement does not permit, and in any case within 24 hours
          of discovery. For a breach, 24 hours is deliberately far inside the sixty days the rule
          allows, because the clinic&apos;s own clock to notify its patients may run from our
          discovery rather than from our notice. Routine unsuccessful attempts that compromise
          nothing, such as blocked sign-ins and port scans, are reported once, in the agreement
          itself, and we summarise them on request.
        </p>
        <p>
          The notice is also our written report, as complete as we can then make it, and we add to
          it as we learn more. The list of the people affected travels by secure transfer, never in
          the email itself. We delay a notice only where a law enforcement official states that it
          would impede a criminal investigation or damage national security, and then only for as
          long as the law provides.
        </p>
        <p>
          Who pays for what follows is in the agreement, not in small print: the cost of notifying
          patients and regulators sits with the clinic, and we carry no liability insurance. We say
          both plainly so a clinic can size its own cover.
        </p>
      </Section>

      <Section id="honest" title="6. What we do not claim">
        <ul className="list-disc space-y-3 pl-6">
          <li>
            <strong>No certification.</strong> There is no "HIPAA certified" and we do not display a
            seal. HIPAA is a set of obligations, and the way to check ours is to read the
            agreement and ask us for the architecture.
          </li>
          <li>
            <strong>No third-party audit yet.</strong> No SOC 2 report exists. The controls above
            are our own and we will walk any reviewer through them.
          </li>
          {/* Counted from the register, like the paragraph in section 3, so
              the two can never disagree: this line once said "Two" while the
              register said three. */}
          {pending > 0 ? (
            <li>
              <strong>
                {pending === 1
                  ? "One of the agreements above is"
                  : `${WORDS[pending] ?? String(pending)} of the agreements above are`}{" "}
                not yet countersigned.
              </strong>{" "}
              Until every vendor in the patient-information path has signed, our operator moves no
              clinic to production. That is a check a person makes before switching a clinic over,
              not one the software enforces yet. The register says which agreements are
              outstanding.
            </li>
          ) : null}
        </ul>
      </Section>

      <Section id="contact" title="7. Who to ask">
        <p>
          Security questions, vulnerability reports and compliance questionnaires:{" "}
          <a href={`mailto:${ENTITY.privacyEmail}`} className="underline underline-offset-2">
            {ENTITY.privacyEmail}
          </a>
          . We answer within five business days and we do not pursue good-faith researchers.
        </p>
      </Section>
    </LegalPage>
  );
}
