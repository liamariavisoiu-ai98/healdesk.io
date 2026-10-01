import type { Metadata } from "next";

import { LegalPage, Section } from "@/components/LegalPage";
import { ENTITY, POLICY } from "@/lib/legal";
import { SUBPROCESSORS, type BaaStatus, type Subprocessor } from "@/lib/subprocessors";

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
 *
 * The "How to read this" text describes three kinds of row, not two, since
 * Meta and Stripe sit in the patient's path with no agreement possible
 * (docs/v1-product-spec.md, "Where the chain is complete, and where it is
 * not"). It no longer says every patient-information vendor is pinned to a US
 * region: that is not confirmed for Retell, and the region column now says so
 * where it is not.
 *
 * DRAFT pending counsel review (2026-09-30): the BAA points at this page, so
 * counsel should read the three-kind wording and the Meta and Stripe rows
 * before the first clinic signs.
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
          one of three kinds.
        </p>
        <ul className="list-disc space-y-3 pl-6">
          <li>
            <strong>Yes.</strong> The vendor receives information that HIPAA protects and works
            under a Business Associate Agreement with us. The <em>Agreement</em> column says
            whether that agreement is signed or still to be executed; no patient information goes
            to a vendor until it is signed.
          </li>
          <li>
            <strong>Kept out by design.</strong> The vendor sits in the patient&apos;s path but
            signs no agreement, so the product keeps clinical content away from it. Meta carries
            the messages a patient sends to your Instagram, Messenger or WhatsApp, and the
            assistant keeps those conversations non-clinical. Stripe takes a deposit with only an
            amount, a generic descriptor and an opaque reference.
          </li>
          <li>
            <strong>No.</strong> The vendor never receives patient information: it hosts or
            measures this website, places a demo call a visitor asked for, or sends email that
            carries none, and the row says which.
          </li>
        </ul>
        <p>
          Bookings are written into your own Google Calendar. That calendar is yours, held under
          your own agreement with Google, so it is not a vendor of ours and has no row here. (The
          Google row below is this website&apos;s own lead register, which never holds patient
          information.)
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

function handles(vendor: Subprocessor): string {
  if (vendor.handlesPhi) return "Yes";
  return vendor.baa.state === "none-by-design" ? "Kept out by design" : "No";
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
    case "none-by-design":
      return `None, and none available — ${status.because}`;
  }
}
