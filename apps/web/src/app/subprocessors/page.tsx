import type { Metadata } from "next";

import { LegalPage, Section } from "@/components/LegalPage";
import { ENTITY, POLICY } from "@/lib/legal";
import { SUBPROCESSORS, type BaaStatus } from "@/lib/subprocessors";

export const metadata: Metadata = {
  title: "Subprocessors",
  description:
    "Every company that processes data for healdesk, what each receives, where it runs, and whether it handles patient information under a signed agreement.",
};

/**
 * The page the Business Associate Agreement promises: "a current list of
 * these subcontractors at healdesk.io/subprocessors". The list itself lives
 * in src/lib/subprocessors.ts so the agreement, this page and the compliance
 * file all read one source.
 */
export default function SubprocessorsPage() {
  return (
    <LegalPage
      title="Subprocessors"
      intro="Every company that processes data on our behalf, what it receives, and whether a signed agreement covers patient information."
    >
      <Section id="how-to-read" title="How to read this">
        <p>
          <strong>Handles patient information</strong> is the column that matters. A vendor marked
          Yes receives information that HIPAA protects, and works under a Business Associate
          Agreement with us — the <em>Agreement</em> column says whether that agreement is signed
          or still being executed. A vendor marked No never receives patient information: it bills
          the clinic, sends an invitation email, or measures this website, and the row says which.
        </p>
        <p>
          Every vendor that handles patient information is pinned to a United States region; the
          agreement's US-infrastructure promise depends on that staying true, and it is reviewed
          quarterly.
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
                  <td className="py-2.5 pr-3">{v.region}</td>
                  <td className="py-2.5 pr-3">{v.handlesPhi ? "Yes" : "No"}</td>
                  <td className="py-2.5">{describe(v.baa)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      <Section id="notice" title="Notice of changes">
        <p>
          Before a new vendor handles patient information we email the billing and clinical
          contacts of every customer at least {POLICY.subprocessorNoticeDays} days in advance,
          naming the vendor, what it will receive and why. A customer that objects may terminate
          without penalty within that period. Vendors that do not handle patient information are
          added to this page without notice.
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

function describe(status: BaaStatus): string {
  switch (status.state) {
    case "signed":
      return `BAA signed ${status.on}`;
    case "requested":
      return `BAA requested ${status.on}; no patient information is sent until it is signed`;
    case "not-needed":
      return `Not required — ${status.because}`;
  }
}
