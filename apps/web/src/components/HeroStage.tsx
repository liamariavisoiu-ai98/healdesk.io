"use client";

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
 * The owner asked for the hero to fill the screen on a desktop: it was as
 * tall as the photo, about 600px, and the next section showed under it. From
 * 1280px it is now the screen's height less the navbar's, with the photo as
 * its background, composed as supplied, and the logos all around her. As the
 * page opens a white gradient rises from the bottom, soft enough to reach her
 * face, and the copy rises with it to sit on it at the bottom left
 * (globals.css, "The hero portrait"). Below 1280px the copy comes first,
 * centred, and the photo follows. The copy is first in the page either way,
 * so a screen reader meets the claim before the picture.
 *
 * The three lines rise in order, slowly: CSS only, so nothing waits on script
 * and nothing shifts the layout, and reduced motion shows them in place.
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
  const buy = useBuy();

  return (
    <section aria-labelledby="hero-heading" className="hero">
      {/* Above the photo, and transparent to the pointer everywhere but its
          own content, so the logos beside her still take a hover. */}
      <div className="hero__copy pointer-events-none z-10 mx-auto w-full max-w-[1240px] px-5 pt-10 pb-8 text-center sm:px-8 sm:pt-16 lg:px-14 xl:pt-0 xl:pb-16 xl:text-left">
        <div className="pointer-events-auto mx-auto max-w-[760px] xl:mx-0 xl:max-w-[min(600px,46%)]">
          {/* The announcement bar, after jasper.ai: a small tag, one bold
              line, and the way in. It wraps inside the copy's column (run out
              as one line on a desktop, it crossed the logos beside her), so it
              is one paragraph: the tag leads the first line and the rest flows
              after it, rather than each part taking a row of its own. The
              space after the tag is a real one, so a screen reader, a copy
              and the browser's find all get "New Instagram", not
              "NEWInstagram". The link opens the purchase flow in place where
              the provider exists and falls back to the standalone route. */}
          <p className="hero-rise border-line mb-8 [--rise-delay:250ms] inline-block max-w-full rounded-[6px] border bg-white py-1.5 pr-3.5 pl-1.5 text-[14.5px] leading-[1.75] shadow-[0_10px_28px_-18px_rgb(23_42_58/0.4)]">
            <span className="bg-tint-mint text-ink mr-2 inline-block rounded-[3px] px-2 py-1 align-[1px] font-mono text-[11.5px] leading-none font-semibold tracking-[0.06em] uppercase">
              {site.announcement.tag}
            </span>{" "}
            <span className="text-ink font-semibold">{site.announcement.text}</span>{" "}
            {buy ? (
              <button
                type="button"
                onClick={() => buy.open()}
                className="text-red-deep hover:text-red ml-1.5 font-semibold whitespace-nowrap transition-colors"
              >
                {site.announcement.cta}
              </button>
            ) : (
              <a
                href={site.cta.primary.href}
                className="text-red-deep hover:text-red ml-1.5 font-semibold whitespace-nowrap transition-colors"
              >
                {site.announcement.cta}
              </a>
            )}
          </p>

          <h1
            id="hero-heading"
            className="hero-rise font-display text-ink text-[clamp(40px,4.9vw,68px)] leading-[1.04] font-normal tracking-[-0.03em] text-balance [--rise-delay:400ms]"
          >
            {site.tagline}
          </h1>

          {/* One column on a phone, two equal ones from 640px: the grid is
              what makes the buttons the same size whatever their labels. */}
          <div className="hero-rise mx-auto mt-8 grid w-full max-w-[480px] grid-cols-1 gap-3 [--rise-delay:550ms] sm:grid-cols-2 xl:mx-0 xl:mt-10">
            <BuyButton size="h-[54px] px-6 text-base" className="w-full whitespace-nowrap" />
            <a href={site.cta.secondary.href} className="btn-ink h-[54px] w-full px-6 text-base whitespace-nowrap">
              {site.cta.secondary.label}
            </a>
          </div>
        </div>
      </div>

      <div className="hero__frame">
        <HeroPortrait />
      </div>

      {/* The white the copy sits on, rising from the bottom as the page
          opens: over the photo, under the logos and the copy. */}
      <div aria-hidden className="hero__veil" />
    </section>
  );
}
