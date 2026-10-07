"use client";

import { BuyButton, useBuy } from "@/components/BuyModal";
import { HeroPortrait } from "@/components/HeroPortrait";
import { site } from "@/lib/site";

/**
 * The banner: the claim and the two ways in, over a photo of AYA with the
 * tools she works through down her left side.
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
 * From 1024px the photo is the background and the copy sits on its white
 * ground in the site's column; its right edge is the screen's up to a 1440px
 * screen, and on a wider one the hero stops growing so she stays beside the
 * copy (globals.css, "The hero portrait"). Below 1024px the copy comes first,
 * centred, and the photo follows, cropped to her. The copy is first in the
 * page either way, so a screen reader meets the claim before the picture.
 *
 * The heading is `site.tagline`, which the <title> and the share card also
 * use, so the page and its preview always make the same claim.
 */
export function HeroStage() {
  const buy = useBuy();

  return (
    <section aria-labelledby="hero-heading" className="hero">
      {/* Above the photo, and transparent to the pointer everywhere but its
          own content, so the logos under its empty right-hand side still
          take a hover. */}
      <div className="hero__copy pointer-events-none z-10 mx-auto w-full max-w-[1240px] px-5 pt-10 pb-8 text-center sm:px-8 sm:pt-16 lg:px-14 lg:py-12 lg:text-left">
        <div className="pointer-events-auto mx-auto max-w-[760px] lg:mx-0 lg:max-w-[min(600px,46%)]">
          {/* The announcement bar, after jasper.ai: a small tag, one bold
              line, and the way in. It wraps inside the copy's column (run out
              as one line on a desktop, it crossed the logos beside her), so it
              is one paragraph: the tag leads the first line and the rest flows
              after it, rather than each part taking a row of its own. The
              space after the tag is a real one, so a screen reader, a copy
              and the browser's find all get "New Instagram", not
              "NEWInstagram". The link opens the purchase flow in place where
              the provider exists and falls back to the standalone route. */}
          <p className="border-line mb-8 inline-block max-w-full rounded-[6px] border bg-white py-1.5 pr-3.5 pl-1.5 text-[14.5px] leading-[1.75] shadow-[0_10px_28px_-18px_rgb(23_42_58/0.4)]">
            <span className="bg-tint-mint text-ink mr-2 inline-block rounded-[3px] px-2 py-1 align-[1px] font-mono text-[11.5px] leading-none font-semibold tracking-[0.06em] uppercase">
              {site.announcement.tag}
            </span>{" "}
            <span className="text-ink font-semibold">{site.announcement.text}</span>{" "}
            {buy ? (
              <button
                type="button"
                onClick={() => buy.open()}
                className="text-red-deep hover:text-red ml-1.5 inline-flex items-center gap-1 font-semibold whitespace-nowrap transition-colors"
              >
                {site.announcement.cta}
                <span aria-hidden>→</span>
              </button>
            ) : (
              <a
                href={site.cta.primary.href}
                className="text-red-deep hover:text-red ml-1.5 inline-flex items-center gap-1 font-semibold whitespace-nowrap transition-colors"
              >
                {site.announcement.cta}
                <span aria-hidden>→</span>
              </a>
            )}
          </p>

          <h1
            id="hero-heading"
            className="font-display text-ink text-[clamp(40px,4.9vw,68px)] leading-[1.04] font-normal tracking-[-0.03em] text-balance"
          >
            {site.tagline}
          </h1>

          <div className="mt-8 flex flex-wrap items-center justify-center gap-3 lg:mt-10 lg:justify-start">
            <BuyButton className="px-6 py-3.5 text-base" />
            <a href={site.cta.secondary.href} className="btn-outline px-6 py-3.5 text-base">
              {site.cta.secondary.label}
              <span aria-hidden className="text-[0.85em] opacity-60">
                ↓
              </span>
            </a>
          </div>
        </div>
      </div>

      <div className="hero__frame">
        <HeroPortrait />
      </div>
    </section>
  );
}
