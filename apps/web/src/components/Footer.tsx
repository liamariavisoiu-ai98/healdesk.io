import { WordmarkGlyphs } from "@/components/Wordmark";
import { TRADEMARKS } from "@/lib/integrations";
import { ENTITY } from "@/lib/legal";
import { site } from "@/lib/site";

/**
 * The footer: the mark, one line on what healdesk is, the links, the address,
 * and the small print.
 *
 * ## What left it on 9 October 2026, and where it went
 *
 * The owner cut it back that day:
 *
 * - The logo is the simple wordmark the navbar uses. The lockup with the
 *   strapline under it is no longer used anywhere.
 * - "How we handle patient data", the five commitments that sat here on
 *   every page, is the homepage FAQ's answer to "How do you handle patient
 *   data?" (KnowMore.tsx), word for word apart from "the Calendar you
 *   connect". Its last line, that no third party has audited healdesk, went
 *   with it: the FAQ says the same, and Footer.tsx's old reasoning, why
 *   commitments and not trust badges, holds there unchanged. No badge, seal
 *   or "HIPAA compliant" claim may take its place.
 * - The line naming the operating entity, "healdesk is a service of Viixi
 *   FZC…", prints on the Terms and Privacy pages only. Meta's Business
 *   Verification, which is what put it here, cleared on 4 October 2026, and
 *   the name is still on the site.
 * - The mailing address is the address alone, without its "correspondence
 *   only" label; the legal pages still label it.
 * - Pricing, Subprocessors and Trust are no longer links: there is no pricing
 *   page, no public vendor list, and Trust is the closing annex of the Terms.
 * - The trademark line is the last and quietest thing on the page, below the
 *   copyright, rather than beside it.
 *
 * And on 12 October 2026 the sentence after the copyright, "Pricing figures
 * shown in demos are approximate industry ranges, not quotes.", went at the
 * owner's request. The contact page still carries its own version of it.
 */
export function Footer() {
  return (
    <footer className="border-line border-t">
      <div className="mx-auto flex max-w-[1240px] flex-col gap-8 px-5 py-12 sm:px-8 md:flex-row md:items-start md:justify-between lg:px-14">
        <div className="max-w-[34ch]">
          <a href="/" aria-label={`${site.name} home`} className="inline-block">
            <WordmarkGlyphs />
          </a>
          <p className="text-muted mt-4 text-sm font-medium">
            An AI front desk for high-ticket elective clinics. Every call, chat
            and DM answered, and the appointment booked.
          </p>
        </div>

        <div className="flex flex-col gap-4">
          {/* The site's secondary navigation. The navbar carries one link and
              the calls to action, so this is where contact and the legal
              pages live. */}
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
          <address className="text-muted text-xs not-italic">{ENTITY.postalAddress}</address>
        </div>
      </div>

      <div className="border-line mx-auto max-w-[1240px] space-y-2 border-t px-5 py-6 sm:px-8 lg:px-14">
        <p className="text-muted text-xs">
          © {new Date().getFullYear()} {site.name}.
        </p>
        {/* The homepage's hero carries these logos; lib/integrations.ts keeps
            this line in step with them. Google's brand guidelines and Stripe's
            terms ask for it, so it stays, but as the page's finest print. */}
        <p className="text-muted/70 text-[11px] leading-relaxed">{TRADEMARKS}</p>
      </div>
    </footer>
  );
}
