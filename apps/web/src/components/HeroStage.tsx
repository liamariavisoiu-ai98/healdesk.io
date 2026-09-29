"use client";

import { useCallback, useState } from "react";
import { useMotionValue } from "motion/react";

import { BuyButton, useBuy } from "@/components/BuyModal";
import { HeroModel } from "@/components/HeroModel";
import { site } from "@/lib/site";
import type { TiltControl } from "@/lib/usePointerField";

/**
 * The banner: the claim on the left, AYA on the right.
 *
 * ## What it replaced, and why
 *
 * Until 23 September 2026 this was a 130svh sticky stage: a life-size head
 * over a giant wordmark, shrinking as you scrolled, with the wordmark flying
 * into the navbar and the headline fading out underneath. It was a piece of
 * craft and it is gone, for three reasons that all showed up in the same
 * render.
 *
 *   1. On a phone the composition did not survive: 600px of empty paper,
 *      then the wordmark, then her hair across the headline.
 *   2. Nothing on the page was above the fold except a face. A visitor had to
 *      scroll a full viewport to learn what healdesk does.
 *   3. The references the owner chose, reception.ai for structure and
 *      jasper.ai for identity, both do the opposite: a static hero, the
 *      claim in one serif heading with one supporting paragraph and two
 *      buttons, and the product's face in a calm panel beside it.
 *
 * So this is that. The heading and paragraph are `site.tagline` and
 * `site.subtitle`, which the <title> and the share card also use, so the
 * page and its preview always make the same claim.
 *
 * ## The panel
 *
 * She sits in a rounded field of `panel` grey, cut off at the bottom by the
 * model's own mask, which fades to transparent rather than to a colour, so
 * the panel can be any tone without re-baking anything. The panel is portrait
 * on a phone and on a desktop, landscape only in the tablet range where the
 * two columns have collapsed and a portrait card would be taller than the
 * viewport.
 *
 * The rig is unchanged: the head still follows the pointer, and on a phone
 * the tilt permission is offered where the device supports it. What is gone
 * is the scroll-driven downward glance, which existed to hand the visitor off
 * to the demo as the stage shrank. There is no shrink, so `gazeBiasY` is a
 * constant zero, kept as a prop so HeroModel needed no change.
 */
export function HeroStage() {
  const [tilt, setTilt] = useState<TiltControl | null>(null);
  const onTilt = useCallback((t: TiltControl) => setTilt(t), []);
  const gazeBiasY = useMotionValue(0);
  const buy = useBuy();

  return (
    <section
      aria-labelledby="hero-heading"
      className="mx-auto max-w-[1240px] px-5 pt-8 pb-6 sm:px-8 sm:pt-12 lg:px-14 lg:pt-16 lg:pb-10"
    >
  {/* The announcement bar, after jasper.ai: a small tag, one bold line,
      and the way in. Above the grid rather than inside the copy column so
      it can run as one line on a desktop; inside the 620px column it
      wrapped to three. The link opens the purchase flow in place where
      the provider exists and falls back to the standalone route. */}
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

      <div className="grid items-center gap-10 lg:grid-cols-2 lg:gap-16">
        <div className="max-w-[620px]">
          <h1
            id="hero-heading"
            className="font-display text-ink text-[clamp(40px,4.9vw,68px)] leading-[1.04] font-normal tracking-[-0.03em] text-balance"
          >
            {site.tagline}
          </h1>

          <p className="text-muted mt-6 max-w-[56ch] text-[clamp(17px,1.3vw,19.5px)] leading-[1.55] font-medium">
            {site.subtitle}
          </p>

          <div className="mt-8 flex flex-wrap items-center gap-3">
            <BuyButton className="px-6 py-3.5 text-base" />
            <a href={site.cta.secondary.href} className="btn-outline px-6 py-3.5 text-base">
              {site.cta.secondary.label}
              <span aria-hidden className="text-[0.85em] opacity-60">
                ↓
              </span>
            </a>
          </div>

          {/* Tilt is opt-in, never the mobile default: it needs a permission
              modal that cannot be re-shown after a refusal. Touch and pointer
              already work with no prompt at all. */}
          {tilt?.supported && tilt.needsPermission && !tilt.granted && !tilt.denied ? (
            <button
              type="button"
              onClick={tilt.request}
              className="border-line-strong text-muted hover:border-ink hover:text-ink mt-5 inline-flex items-center gap-2 rounded-full border px-4 py-2 text-[15px] font-semibold transition-colors"
            >
              Tilt your phone to look around
            </button>
          ) : null}
        </div>

        <div className="bg-panel relative flex aspect-[4/5] items-end justify-center overflow-hidden rounded-[28px] sm:aspect-[5/4] lg:aspect-[4/5]">
          {/* Sized by height, so anything that does not fit is lost from the
              sides rather than off the top: the bust ends square at the top
              of its canvas, and a fit that shows the whole image shows that
              as a straight edge across her hair. */}
          <HeroModel className="h-[94%] w-auto max-w-full" onTiltAvailable={onTilt} gazeBiasY={gazeBiasY} />

          {/* The way in. reception.ai puts "Start call" under its orb; ours
              points at the live demo a scroll away. */}
          <a
            href={site.cta.secondary.href}
            className="bg-paper/90 text-ink absolute bottom-5 left-1/2 inline-flex -translate-x-1/2 items-center gap-2 rounded-full px-4 py-2 text-sm font-semibold shadow-sm backdrop-blur"
          >
            <span aria-hidden className="bg-red inline-block h-2 w-2 rounded-full" />
            {site.cta.secondary.label}
          </a>
        </div>
      </div>
    </section>
  );
}
