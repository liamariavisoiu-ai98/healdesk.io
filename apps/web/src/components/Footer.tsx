import { WordmarkSlogan } from "@/components/Wordmark";
import { ENTITY } from "@/lib/legal";
import { site } from "@/lib/site";

/**
 * Data commitments, not trust badges.
 *
 * Competitors run a "TRUSTED & VERIFIED BY" strip of SOC 2 / ISO 27001 / HIPAA
 * logos. We deliberately do not, for two reasons.
 *
 * The first is that we have earned none of them, and a badge asserting a third
 * party reviewed us is the exact theory the FTC charged in *In re SkyMed
 * International* (2021), a standalone deception count for displaying a "HIPAA
 * Compliance" seal, because it "signaled to consumers that a government agency
 * or other third party had reviewed Respondent's information practices" when
 * none had. There is no HIPAA certification: HHS says it "does not endorse or
 * otherwise recognize private organizations' 'certifications'". And the FTC
 * reaches B2B. Henry Schein paid $250,000 over claims made to dentists.
 *
 * The second is that these read BETTER to a clinic than badges would. Every
 * line is a fact we can be asked to demonstrate, and the disclosure at the end
 * turns the absence of an audit into candour rather than a gap. See
 * docs/blockers-runbook.md §10 for the sourcing and for what to change when an
 * audit does exist.
 *
 * ⚠️ Line 4 becomes FALSE the day the agent writes a booking back. Change the
 * string in the same commit as that feature, not afterwards.
 */
const COMMITMENTS = [
  "We sign a BAA with every clinic",
  "PHI stored in US-only AWS infrastructure under a signed AWS BAA",
  "We never use patient data to train models",
  "Read-only access to your practice management system",
  "Encrypted in transit and at rest with AWS KMS",
  "Delete any patient's data on request",
] as const;

export function Footer() {
  return (
    <footer className="border-line border-t">
      <div className="mx-auto flex max-w-[1240px] flex-col gap-8 px-5 py-12 sm:px-8 md:flex-row md:items-start md:justify-between lg:px-14">
        <div className="max-w-[34ch]">
          {/* The full lockup, strapline included, the only place on the site
              it appears. The navbar carries the mark alone, because the
              strapline is unreadable at navbar size. */}
          <a href="/" aria-label={`${site.name} home`} className="inline-block">
            <WordmarkSlogan />
          </a>
          <p className="text-muted mt-3 text-sm font-medium">
            An AI front desk for high-ticket elective clinics, and the only one
            that tells you which recovered call actually collected.
          </p>
        </div>

        <div className="flex flex-col gap-4">
          {/* The only navigation on the site. The navbar carries one CTA and no
              links, so this is where pricing and contact actually live. */}
          <nav className="flex flex-wrap gap-x-10 gap-y-3" aria-label="Footer">
            {site.footerLinks.map((item) => (
              <a
                key={item.href}
                href={item.href}
                className="text-muted hover:text-ink text-sm font-semibold transition-colors"
              >
                {item.label}
              </a>
            ))}
            <a
              href={`mailto:${site.email}`}
              className="text-muted hover:text-ink text-sm font-semibold transition-colors"
            >
              {site.email}
            </a>
          </nav>
          {/* The mailbox the marketing emails and the legal pages print, in the
              trade name's context only: no entity name here, and none in the
              layout metadata either. It is a registered-agent box for
              correspondence, not an office; the legal pages say so. */}
          <address className="text-muted text-xs not-italic">{ENTITY.postalAddress}</address>
        </div>
      </div>

      <div className="border-line mx-auto max-w-[1240px] border-t px-5 py-10 sm:px-8 lg:px-14">
        <h2 className="text-[13.2px] font-bold tracking-[0.14em] uppercase">
          How we handle patient data
        </h2>

        <ul className="mt-5 grid gap-x-8 gap-y-3 sm:grid-cols-2 lg:grid-cols-3">
          {COMMITMENTS.map((commitment) => (
            <li key={commitment} className="flex gap-2.5 text-sm font-medium">
              <span aria-hidden className="text-red-deep mt-px shrink-0">
                ✓
              </span>
              <span>{commitment}</span>
            </li>
          ))}
        </ul>

        {/* The most important element on the strip. It costs nothing to say,
            and it is the sentence that survives a procurement review. */}
        <p className="text-muted mt-6 max-w-[68ch] text-xs leading-relaxed">
          No third party has audited healdesk. These are our own commitments, and
          we will show you the architecture behind any of them. SOC&nbsp;2
          Type&nbsp;II is on our roadmap. We&rsquo;ll publish the report date
          when we have one.
        </p>
      </div>

      <div className="border-line mx-auto max-w-[1240px] border-t px-5 py-6 sm:px-8 lg:px-14">
        <p className="text-muted text-xs">
          © {new Date().getFullYear()} {site.name}. Pricing figures shown in demos
          are approximate industry ranges, not quotes.
        </p>
      </div>
    </footer>
  );
}
