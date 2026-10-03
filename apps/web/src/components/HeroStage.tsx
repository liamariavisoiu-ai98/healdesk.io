"use client";

import { BuyButton, useBuy } from "@/components/BuyModal";
import { site } from "@/lib/site";

/**
 * The banner: the claim, one supporting line, and the two ways in.
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
 * serif heading, one supporting paragraph and two buttons, centred because
 * there is no second column to balance it. The heading and paragraph are
 * `site.tagline` and `site.subtitle`, which the <title> and the share card
 * also use, so the page and its preview always make the same claim.
 */
export function HeroStage() {
  const buy = useBuy();

  return (
    <section
      aria-labelledby="hero-heading"
      className="mx-auto max-w-[1240px] px-5 pt-10 pb-10 text-center sm:px-8 sm:pt-16 lg:px-14 lg:pt-24 lg:pb-16"
    >
      {/* The announcement bar, after jasper.ai: a small tag, one bold line,
          and the way in. Outside the copy column so it can run as one line
          on a desktop. The link opens the purchase flow in place where the
          provider exists and falls back to the standalone route. */}
      <div className="border-line mb-8 inline-flex max-w-full flex-wrap items-center gap-x-3 gap-y-1.5 rounded-[6px] border bg-white py-1.5 pr-3.5 pl-1.5 text-[14.5px] shadow-[0_10px_28px_-18px_rgb(23_42_58/0.4)] lg:mb-10 lg:flex-nowrap">
        <span className="bg-tint-mint text-ink rounded-[3px] px-2 py-1 font-mono text-[11.5px] font-semibold tracking-[0.06em] uppercase">
          {site.announcement.tag}
        </span>
        <span className="text-ink font-semibold">{site.announcement.text}</span>
        {buy ? (
          <button
            type="button"
            onClick={() => buy.open()}
            className="text-red-deep hover:text-red inline-flex items-center gap-1 font-semibold transition-colors"
          >
            {site.announcement.cta}
            <span aria-hidden>→</span>
          </button>
        ) : (
          <a
            href={site.cta.primary.href}
            className="text-red-deep hover:text-red inline-flex items-center gap-1 font-semibold transition-colors"
          >
            {site.announcement.cta}
            <span aria-hidden>→</span>
          </a>
        )}
      </div>

      <div className="mx-auto max-w-[760px]">
        <h1
          id="hero-heading"
          className="font-display text-ink text-[clamp(40px,4.9vw,68px)] leading-[1.04] font-normal tracking-[-0.03em] text-balance"
        >
          {site.tagline}
        </h1>

        <p className="text-muted mx-auto mt-6 max-w-[60ch] text-[clamp(17px,1.3vw,19.5px)] leading-[1.55] font-medium">
          {site.subtitle}
        </p>

        <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
          <BuyButton className="px-6 py-3.5 text-base" />
          <a href={site.cta.secondary.href} className="btn-outline px-6 py-3.5 text-base">
            {site.cta.secondary.label}
            <span aria-hidden className="text-[0.85em] opacity-60">
              ↓
            </span>
          </a>
        </div>
      </div>
    </section>
  );
}
