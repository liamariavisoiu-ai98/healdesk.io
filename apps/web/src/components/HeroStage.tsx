"use client";

import { useRef } from "react";

import { BuyButton, useBuy } from "@/components/BuyModal";
import { HeroPortrait } from "@/components/HeroPortrait";
import { site } from "@/lib/site";

/**
 * The banner: the claim and the two ways in, over a photo of AYA with the
 * tools she works through beside her.
 *
 * ## What it replaced, and why
 *
 * Until 23 September 2026 this was a 130svh sticky stage: a life-size head
 * over a giant wordmark, shrinking as you scrolled, with the wordmark flying
 * into the navbar. That became a two-column banner with AYA rendered in 3D in
 * a panel beside the copy. On 3 October 2026 the owner removed the render
 * entirely, along with the three.js model, the layered and frame-grid
 * renderers behind it, and their build scripts; git history has all of it.
 *
 * What is left follows the references the owner chose, reception.ai for
 * structure and jasper.ai for identity: an announcement bar, the claim in one
 * serif heading and two buttons. On 5 October 2026 the owner removed the
 * supporting paragraph that sat under the heading, and put a second column
 * back with the soul in it and the integrations on a ring round it. On 7
 * October 2026 the photo took the soul's place (HeroPortrait).
 *
 * ## Full screen, from 9 October 2026
 *
 * The owner asked for the hero to fill the screen on a desktop: from 1280px it
 * is the screen's height less the navbar's, with the photo as its background,
 * composed as supplied, and the logos on their orbits all around her. Below
 * 1280px the copy comes first, centred, and the photo follows. The copy is
 * first in the page either way, so a screen reader meets the claim before the
 * picture.
 *
 * ## The copy is there from the start (owner, 12 October 2026)
 *
 * From 9 October 2026 the copy waited below the fold of the photo on a
 * desktop with a mouse: it rose, line by line on a white veil, when the
 * cursor came into the hero's bottom third, and an arrowhead jumping at the
 * hero's foot said so. The owner asked for both to go: the headline, the
 * pill and the buttons are on screen as the page opens, on every device,
 * with the veil under them from 1280px. git history has the reveal.
 *
 * The page still opens in one movement round her (globals.css, "The hero
 * portrait"): the photo settles, the orbits draw in and the logos fan out
 * along them. The copy plays no part in it. The logos' cards still play on
 * their own, one after another (owner, 12 October 2026: they had stopped
 * with the reveal); one that would cover the copy at the screen's size is
 * skipped, and a hover, a focus, a tap or a chip still plays any of them
 * (HeroPortrait's `autoplay` and `avoid`).
 *
 * ## The two buttons
 *
 * The same size, side by side (owner, 9 October 2026), and both without
 * arrows. "Try AYA for free" is ink at rest and outlined on hover, the
 * outline button's colours the other way round (`btn-ink`).
 *
 * The heading is `site.tagline`, which the <title> and the share card also
 * use, so the page and its preview always make the same claim.
 */
export function HeroStage() {
  const copyRef = useRef<HTMLDivElement>(null);
  return (
    <section aria-labelledby="hero-heading" className="hero">
      {/* Above the photo, and transparent to the pointer everywhere but its
          own content, so the logos beside her still take a hover. */}
      <div className="hero__copy pointer-events-none z-10 mx-auto w-full min-w-0 max-w-[1240px] px-5 pt-10 pb-8 text-center sm:px-8 sm:pt-16 lg:px-14 xl:pt-0 xl:pb-16 xl:text-left">
        <div ref={copyRef} className="pointer-events-auto mx-auto max-w-[760px] xl:mx-0 xl:max-w-[min(600px,46%)]">
          {/* The announcement, as one pill on one line (owner, 12 October
              2026): "NEW · Now on Instagram, Messenger and WhatsApp →", the
              whole of it the way in. It used to be a bar with a "Get AYA"
              link at its end, which wrapped onto a line of its own beside her
              and repeated the red button under it. The pill opens the
              purchase flow in place where the provider exists and falls back
              to the standalone route. Its name is the sentence and where it
              goes, so a screen reader hears "New: now on Instagram,
              Messenger and WhatsApp. Get AYA" rather than an arrow. */}
          <AnnouncementPill />

          <h1
            id="hero-heading"
            className="font-display text-ink text-[clamp(40px,4.9vw,68px)] leading-[1.04] font-normal tracking-[-0.03em] text-balance"
          >
            {site.tagline}
          </h1>

          {/* One column on a phone, two equal ones from 640px: the grid is
              what makes the buttons the same size whatever their labels. */}
          <div className="mx-auto mt-8 grid w-full max-w-[480px] grid-cols-1 gap-3 sm:grid-cols-2 xl:mx-0 xl:mt-10">
            <BuyButton size="h-[54px] px-6 text-base" className="w-full whitespace-nowrap" />
            <a href={site.cta.secondary.href} className="btn-ink h-[54px] w-full px-6 text-base whitespace-nowrap">
              {site.cta.secondary.label}
            </a>
          </div>
        </div>
      </div>

      <div className="hero__frame">
        <HeroPortrait autoplay avoid={copyRef} />
      </div>

      {/* The white the copy sits on, from 1280px: over the photo, under the
          logos and the copy. */}
      <div aria-hidden className="hero__veil" />
    </section>
  );
}

/**
 * The announcement pill. One line at every width: the type steps down on a
 * narrow phone, and if the sentence still cannot fit, it ends in an ellipsis
 * rather than wrapping under the tag.
 */
function AnnouncementPill() {
  const buy = useBuy();
  const { tag, text, cta } = site.announcement;
  const label = `${tag}: ${text}. ${cta}`;
  const className =
    "hero-pill group mb-8 inline-flex max-w-full items-center gap-2 rounded-full border border-line bg-white py-1.5 pr-3.5 pl-1.5 text-[clamp(12.5px,3.4vw,14.5px)] leading-none whitespace-nowrap shadow-sm transition-[border-color,box-shadow] duration-fast hover:border-line-strong hover:shadow-md";
  const inner = (
    <>
      <span className="bg-tint-mint text-ink rounded-full px-2 py-1 text-[0.78em] font-semibold tracking-[0.06em] uppercase">{tag}</span>
      <span aria-hidden className="text-muted">·</span>
      <span className="text-ink min-w-0 overflow-hidden font-semibold text-ellipsis">{text}</span>
      <svg aria-hidden viewBox="0 0 16 16" className="text-red-deep size-[1.05em] shrink-0 transition-transform duration-fast ease-out group-hover:translate-x-0.5">
        <path d="M3 8h9.5M8.5 4l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </>
  );
  return buy ? (
    <button type="button" onClick={() => buy.open()} aria-label={label} className={className}>
      {inner}
    </button>
  ) : (
    <a href={site.cta.primary.href} aria-label={label} className={className}>
      {inner}
    </a>
  );
}
