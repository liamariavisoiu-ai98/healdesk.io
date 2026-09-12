"use client";

import { usePathname } from "next/navigation";
import { motion, useMotionValue, useTransform } from "motion/react";

import {
  HANDOFF_FROM,
  HANDOFF_TO,
  ramp,
  useHeroMark,
} from "@/components/HeroMark";
import { BuyButton } from "@/components/BuyModal";
import { WordmarkGlyphs } from "@/components/Wordmark";
import { site } from "@/lib/site";

/**
 * The navbar logo, and the receiving half of the hero wordmark's hand-off.
 *
 * Inside HeroMarkProvider it starts invisible and scales up into place as the
 * giant mark behind AVA shrinks past it. Outside the provider (the footer,
 * /pricing, /contact) `useHeroMark()` returns null, the fallback pins the
 * shared value at 1, and this renders exactly as it always did.
 *
 * Both halves read the same HANDOFF_FROM/HANDOFF_TO window from opposite
 * directions, so they are complementary by construction rather than by two
 * constants happening to agree.
 */
export function Brand({ className = "" }: { className?: string }) {
  const ctx = useHeroMark();
  // A constant source when there is no provider, so the hooks below are called
  // unconditionally and in the same order on every render.
  const settled = useMotionValue(1);
  const source = ctx?.markScale ?? settled;

  const handoff = useTransform(source, (s) =>
    1 - ramp(s, HANDOFF_FROM, HANDOFF_TO),
  );
  const scale = useTransform(handoff, (h) => 0.86 + 0.14 * h);

  return (
    <a
      href="/"
      className={`inline-flex items-center leading-none ${className}`}
      aria-label={`${site.name} home`}
    >
      {/* The scale stays applied even at rest (identity 1). Transformed text
          renders with greyscale antialiasing and untransformed text with
          subpixel AA, so a mark that only gains a transform mid-animation
          would visibly change weight at the hand-off. */}
      <motion.span
        ref={ctx?.navMarkRef}
        className="nav-mark inline-block"
        style={{ opacity: handoff, scale, transformOrigin: "left center" }}
      >
        <WordmarkGlyphs />
      </motion.span>
    </a>
  );
}

/**
 * Wordmark on the left, two calls to action on the right, nothing in between.
 *
 * There is still no link list, pricing and contact live in the footer. What
 * changed is that the navbar now carries the purchase flow as its PRIMARY
 * action, with the demo demoted to secondary. Until this existed the homepage
 * had no path to checkout at all: AVA's own prompt told her to point at a
 * "Make It Yours" button that only exists on /pricing, so a prospect she had
 * just convinced had to find the footer to buy.
 *
 * Client component for two reasons: the wordmark hand-off above, and the fact
 * that both CTAs behave differently by route.
 */
export function Nav() {
  const pathname = usePathname();
  const onHome = pathname === "/";
  // A bare "#ava" on /pricing scrolls to nothing, and a "/#ava" on the homepage
  // makes Next run a route transition instead of letting CSS smooth-scroll do it.
  const demoHref = onHome ? site.cta.secondary.href : `/${site.cta.secondary.href}`;

  return (
    <header className="border-line/60 bg-paper/85 sticky top-0 z-50 border-b backdrop-blur-md">
      <div className="mx-auto flex max-w-[1240px] items-center gap-3 px-5 py-4 sm:gap-5 sm:px-8 lg:px-14">
        <Brand />

        {/* Secondary. Hidden on the narrowest screens rather than wrapped: the
            demo is a scroll away on the homepage regardless, so the row stays
            two items wide on a phone instead of three cramped ones. */}
        <a
          href={demoHref}
          className="text-muted hover:text-ink ml-auto hidden text-[16.8px] font-semibold transition-colors sm:inline-flex sm:items-center sm:gap-1.5"
        >
          {site.cta.secondary.label}
          <span aria-hidden className="text-[0.85em] opacity-60">
            ↓
          </span>
        </a>

        <BuyButton className="ml-auto sm:ml-0" />
      </div>
    </header>
  );
}
