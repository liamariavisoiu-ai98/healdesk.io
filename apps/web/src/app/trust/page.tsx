import type { Metadata } from "next";

import { LegalPage, Section } from "@/components/LegalPage";
import { ENTITY, POLICY } from "@/lib/legal";
import { site } from "@/lib/site";
import { PHI_SUBPROCESSORS, SUBPROCESSORS } from "@/lib/subprocessors";

export const metadata: Metadata = {
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
            <strong>The AI says it is an AI, first.</strong> Every call opens with a disclosure that
            the caller is speaking to an AI and that the call is transcribed, and that no audio
            recording is kept. It is not configurable by the clinic, and it is the first line of
            every transcript.
          </li>
          <li>
            <strong>Encryption.</strong> At rest in the database and object store, in transit
            wherever we control both ends. Patient information is never sent over email; a report
            that would carry it fails rather than sends.
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
            <strong>No advertising platforms, anywhere.</strong> No pixel on the site, no
            conversion API in the product, no patient-level data to Meta or Google, and a browser
            policy on this site that blocks the connections outright.
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
          <a href="/subprocessors" className="underline underline-offset-2">/subprocessors</a>, and
          we tell every customer at least {POLICY.subprocessorNoticeDays} days before a vendor is
          added. {SUBPROCESSORS.length - PHI_SUBPROCESSORS.length} further vendors serve this
          website and billing and never receive patient information.
        </p>
      </Section>

      <Section id="breach" title="4. If something goes wrong">
        <p>
          We tell the clinic within five calendar days of discovering a breach of unsecured
          patient information — well inside the sixty days the rule allows, on purpose, so the
          clinic's own clock to notify its patients is not consumed by ours — and within five
          business days of any security incident, whether or not it turns out to be a breach. Who
          pays for what follows is in the agreement, not in small print: the cost of notifying
          patients and regulators sits with the clinic, and we carry no liability insurance. We say
          both plainly so a clinic can size its own cover.
        </p>
      </Section>

      <Section id="honest" title="5. What we do not claim">
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
              Until every vendor in the patient-information path has signed, no clinic is moved to
              production. The register says which.
            </li>
          ) : null}
        </ul>
      </Section>

      <Section id="contact" title="6. Who to ask">
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
