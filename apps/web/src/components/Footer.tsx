import { WordmarkGlyphs } from "@/components/Wordmark";
import { TRADEMARKS } from "@/lib/integrations";
import { ENTITY } from "@/lib/legal";
import { portalSignInUrl, SIGN_IN_LABEL } from "@/lib/portal-link";
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
 *   (Pricing came back on 13 October 2026 with the step pricing, as the first
 *   footer link; site.footerLinks.)
 * - The trademark line is the last and quietest thing on the page, below the
 *   copyright, rather than beside it.
 *
 * And on 12 October 2026 the sentence after the copyright, "Pricing figures
 * shown in demos are approximate industry ranges, not quotes.", went at the
 * owner's request. The contact page still carries its own version of it.
 *
 * ## Its size (owner, 12 October 2026)
 *
 * It was set in the page's own text sizes, which run a fifth larger than
 * Tailwind's (globals.css, `--text-sm` is 16.8px), with the navbar's 28px
 * wordmark and 48px of padding a side: about 300px tall on a desktop and
 * nearly 600px on a phone, a section rather than a footer. It is now in fixed
 * small sizes, 14px links and 12.5px small print, with a 22px wordmark: the
 * mark and the line on the left and the links on the right, then one rule and
 * the copyright, the address and the trademark line under it.
 */
export function Footer() {
  return (
    <footer className="border-line border-t">
      <div className="mx-auto flex max-w-[1240px] flex-col gap-5 px-5 pt-8 pb-6 sm:px-8 md:flex-row md:items-start md:justify-between md:gap-10 lg:px-14">
        <div className="max-w-[46ch]">
          <a href="/" aria-label={`${site.name} home`} className="inline-block [&_img]:h-[22px]">
            <WordmarkGlyphs />
          </a>
          <p className="text-muted mt-2.5 text-[13.5px] leading-[1.5] font-medium">
            An AI front desk for high-ticket elective clinics. Every call, chat
            and DM answered, and the appointment booked.
          </p>
        </div>

        {/* The site's secondary navigation. The navbar carries one link and
            the calls to action, so this is where contact and the legal pages
            live. */}
        <nav className="flex flex-wrap gap-x-6 gap-y-2 md:max-w-[560px] md:justify-end md:pt-0.5" aria-label="Footer">
          {site.footerLinks.map((item) => (
            <a
              key={item.href}
              href={item.href}
              className="text-muted hover:text-ink text-[14px] leading-6 font-semibold transition-colors"
            >
              {item.label}
            </a>
          ))}
          {/* The clinic portal's sign-in, once NEXT_PUBLIC_PORTAL_URL is set; nothing until then. */}
          {portalSignInUrl() ? (
            <a
              href={portalSignInUrl()!}
              className="text-muted hover:text-ink text-[14px] leading-6 font-semibold transition-colors"
            >
              {SIGN_IN_LABEL}
            </a>
          ) : null}
          <a
            href={`mailto:${site.email}`}
            className="text-muted hover:text-ink text-[14px] leading-6 font-semibold transition-colors"
          >
            {site.email}
          </a>
        </nav>
      </div>

      <div className="mx-auto max-w-[1240px] px-5 pb-6 sm:px-8 lg:px-14">
        <div className="border-line space-y-1.5 border-t pt-4">
          <div className="text-muted flex flex-wrap gap-x-3 gap-y-1 text-[12.5px] leading-[1.5]">
            <p>
              © {new Date().getFullYear()} {site.name}.
            </p>
            <address className="not-italic">{ENTITY.postalAddress}</address>
          </div>
          {/* The homepage's hero carries these logos; lib/integrations.ts keeps
              this line in step with them. Google's brand guidelines and Stripe's
              terms ask for it, so it stays, but as the page's finest print. */}
          <p className="text-muted/70 text-[11px] leading-[1.5]">{TRADEMARKS}</p>
        </div>
      </div>
    </footer>
  );
}
