"use client";

import { usePathname } from "next/navigation";

import { BuyButton } from "@/components/BuyModal";
import { GetInTouch } from "@/components/GetInTouch";
import { NAV_WORDMARK_HEIGHT, WordmarkGlyphs } from "@/components/Wordmark";
import { site } from "@/lib/site";

/**
 * The navbar logo.
 *
 * It used to be the receiving half of a hand-off: the giant wordmark behind
 * AYA in the hero shrank into this one as you scrolled, and this one faded in
 * as that one faded out. The hero is static now (see HeroStage.tsx), so the
 * logo is simply always here, at one size, on every route. The navbar asks
 * for its larger size (Wordmark.tsx); the pages without a navbar keep 28px.
 */
export function Brand({ className = "", height }: { className?: string; height?: number }) {
  return (
    <a
      href="/"
      className={`inline-flex items-center leading-none ${className}`}
      aria-label={`${site.name} home`}
    >
      <span className="inline-block min-w-0">
        <WordmarkGlyphs height={height} />
      </span>
    </a>
  );
}

/**
 * Wordmark on the left, two links and two calls to action on the right.
 *
 * Contact lives in the footer; "Why wait?" is the one page link
 * that earned a place here, because the page behind it is the argument for
 * buying now and the calculator it holds used to interrupt the homepage. The
 * navbar carries the purchase flow as its PRIMARY action, with the demo as
 * secondary. Until this existed the homepage had no path to checkout at all:
 * AYA's own prompt told her to point at a "Make It Yours" button that only
 * existed on the old /pricing page, so a prospect she had just convinced had
 * to find the footer to buy.
 *
 * "Get in touch" (6 October 2026, the owner's) sits beside it as the outlined
 * secondary button, opening a call booking over the page (GetInTouch.tsx).
 * It shows at every width: a calendar icon on a phone, its words from 480px.
 *
 * The text links wait until 700px. At 640, where they used to appear, a row
 * that also holds "Get in touch" is exactly full; at 700 there are about 60px
 * to spare. Nothing in the row wraps or shrinks except the wordmark, which
 * scales down on a phone narrower than about 360px rather than push the
 * buttons off the edge.
 *
 * Client component because both CTAs behave differently by route.
 */
export function Nav() {
  const pathname = usePathname();
  const onHome = pathname === "/";
  // A bare "#aya" on /why-wait scrolls to nothing, and a "/#aya" on the homepage
  // makes Next run a route transition instead of letting CSS smooth-scroll do it.
  const demoHref = onHome ? site.cta.secondary.href : `/${site.cta.secondary.href}`;

  return (
    <header className="border-line/60 bg-paper/85 sticky top-0 z-50 border-b backdrop-blur-md">
      <div className="mx-auto flex max-w-[1240px] items-center gap-2 px-5 py-4 min-[480px]:gap-3 sm:gap-5 sm:px-8 lg:px-14">
        <Brand className="min-w-0" height={NAV_WORDMARK_HEIGHT} />

        {/* Text links are hidden on the narrower screens rather than wrapped:
            a phone's row holds the wordmark and the two buttons instead of
            five cramped items, and both destinations are one scroll or one
            footer away. */}
        {site.navLinks.map((item) => (
          <a
            key={item.href}
            href={item.href}
            className="text-muted hover:text-ink ml-auto hidden text-[16.8px] font-semibold whitespace-nowrap transition-colors min-[700px]:inline-flex"
          >
            {item.label}
          </a>
        ))}
        {/* A hairline between the two text links (owner, 9 October 2026),
            shown wherever they are. */}
        <span aria-hidden className="bg-line-strong hidden h-5 w-px shrink-0 min-[700px]:block" />
        <a
          href={demoHref}
          className="text-muted hover:text-ink hidden text-[16.8px] font-semibold whitespace-nowrap transition-colors min-[700px]:inline-flex"
        >
          {site.cta.secondary.label}
        </a>

        <GetInTouch className="ml-auto min-[700px]:ml-0" />
        <BuyButton className="shrink-0 whitespace-nowrap" />
      </div>
    </header>
  );
}
