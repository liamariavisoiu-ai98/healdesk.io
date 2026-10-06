"use client";

import { usePathname } from "next/navigation";

import { BuyButton } from "@/components/BuyModal";
import { GetInTouch } from "@/components/GetInTouch";
import { WordmarkGlyphs } from "@/components/Wordmark";
import { site } from "@/lib/site";

/**
 * The navbar logo.
 *
 * It used to be the receiving half of a hand-off: the giant wordmark behind
 * AYA in the hero shrank into this one as you scrolled, and this one faded in
 * as that one faded out. The hero is static now (see HeroStage.tsx), so the
 * logo is simply always here, at one size, on every route.
 */
export function Brand({ className = "" }: { className?: string }) {
  return (
    <a
      href="/"
      className={`inline-flex items-center leading-none ${className}`}
      aria-label={`${site.name} home`}
    >
      <span className="inline-block">
        <WordmarkGlyphs />
      </span>
    </a>
  );
}

/**
 * Wordmark on the left, one link and two calls to action on the right.
 *
 * Pricing and contact still live in the footer; "Why wait?" is the one link
 * that earned a place here, because the page behind it is the argument for
 * buying now and the calculator it holds used to interrupt the homepage. The
 * navbar carries the purchase flow as its PRIMARY action, with the demo as
 * secondary. Until this existed the homepage had no path to checkout at all:
 * AYA's own prompt told her to point at a "Make It Yours" button that only
 * exists on /pricing, so a prospect she had just convinced had to find the
 * footer to buy.
 *
 * "Get in touch" (6 October 2026, the owner's) sits beside it as the outlined
 * secondary button, opening a call booking over the page (GetInTouch.tsx).
 * It shows from 700px. At 640px, where the text links appear, a row with it
 * in is exactly full, so a font that sets a little wider wraps both buttons
 * onto two lines; at 700 there are about 60px to spare.
 *
 * Client component because both CTAs behave differently by route.
 */
export function Nav() {
  const pathname = usePathname();
  const onHome = pathname === "/";
  // A bare "#aya" on /pricing scrolls to nothing, and a "/#aya" on the homepage
  // makes Next run a route transition instead of letting CSS smooth-scroll do it.
  const demoHref = onHome ? site.cta.secondary.href : `/${site.cta.secondary.href}`;

  return (
    <header className="border-line/60 bg-paper/85 sticky top-0 z-50 border-b backdrop-blur-md">
      <div className="mx-auto flex max-w-[1240px] items-center gap-3 px-5 py-4 sm:gap-5 sm:px-8 lg:px-14">
        <Brand />

        {/* Text links are hidden on the narrowest screens rather than wrapped:
            the row stays two items wide on a phone instead of four cramped
            ones, and both destinations are one scroll or one footer away. */}
        {site.navLinks.map((item) => (
          <a
            key={item.href}
            href={item.href}
            className="text-muted hover:text-ink ml-auto hidden text-[16.8px] font-semibold transition-colors sm:inline-flex"
          >
            {item.label}
          </a>
        ))}
        <a
          href={demoHref}
          className="text-muted hover:text-ink hidden text-[16.8px] font-semibold transition-colors sm:inline-flex sm:items-center sm:gap-1.5"
        >
          {site.cta.secondary.label}
          <span aria-hidden className="text-[0.85em] opacity-60">
            ↓
          </span>
        </a>

        <GetInTouch className="hidden min-[700px]:inline-flex" />
        <BuyButton className="ml-auto sm:ml-0" />
      </div>
    </header>
  );
}
