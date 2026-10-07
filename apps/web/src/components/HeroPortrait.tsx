"use client";

import { useEffect, useRef, useState, type RefObject } from "react";

import { HERO_LOGOS, LABEL, type HeroLogo } from "@/lib/integrations";

/**
 * The hero's picture: AYA in profile, wearing the healdesk headset with the
 * soul glowing in her chest, and the logos of the tools she works through
 * floating down her left side. The logos, their label and their trademark
 * line are in lib/integrations.ts; the sizes and the motion are in
 * globals.css under "The hero portrait".
 *
 * ## The photo replaced the soul
 *
 * On 7 October 2026 the owner swapped the animated soul, with the logos on a
 * ring round it, for this photo, the logos moved to her left side, "not all
 * at the same distance from her, but alternating distances". The hairlines
 * that tied each logo to the soul went with the ring: drawn to the soul in
 * her chest now, the upper ones would cross her face.
 *
 * ## Where the logos sit
 *
 * Her outline was measured on the photo row by row: the first pixel from the
 * left that is not the white ground. Each logo is set at an even step down
 * the photo, from her crown to below her shoulder, and a fixed distance left
 * of the furthest-left point of her outline within 60 pixels above or below,
 * so a stray curl never ends up under a logo: about 120 photo pixels for one
 * logo, about 265 for the next, and so on alternately (the wisps of hair
 * round her face make the exact figure depend on where the ground is taken
 * to end). The places are in lib/integrations.ts as percentages of the
 * photo, so the composition holds at every size, and a test keeps them on
 * the photo, clear of her and of each other, and alternating.
 *
 * ## In an order
 *
 * The four places a patient writes in come first, beside her headset
 * (website chat, Instagram, Messenger, WhatsApp), then the calendars, then
 * Stripe. No two blues sit together.
 *
 * Cal.com, Calendly and HighLevel are there as calendars that read Google's,
 * never as ones she writes into: v1 writes bookings to the clinic's Google
 * Calendar and nothing else, and a clinic on one of them links the two in
 * that system's own settings, which the spec calls "a setting in their
 * system, not a Healdesk integration" (docs/v1-product-spec.md, "Where
 * bookings are written"). The spec's table ("What the hub model does and
 * does not guarantee") has all three reading Google's calendar for
 * conflicts, HighLevel through a "conflict calendar" that blocks any slot
 * holding an event marked busy, as hers are. The label says they work
 * through that calendar. Stripe is the gateway a clinic connects to take
 * deposits in chat, and deposits stay off until it does.
 *
 * ## Motion
 *
 * Each logo hops now and then, never in step with its neighbours, and on
 * hover slides away from her along its own bearing. Away from the hero they
 * rest (see useResting), and the operating system's reduce-motion setting
 * stills them.
 */

/**
 * Whether the logos may rest: more than a screen from the viewport and not
 * being headed back to.
 *
 * The hero is the top of the page, so heading back is going up. Any scroll
 * upwards wakes them at once, however far down, and so do the keys that jump
 * up a page or to the top, on the key press, before the first frame of the
 * scroll they start. A screen of margin means a reader on the way back finds
 * them already moving. An upward nudge that stops for two seconds while
 * still out of reach was not a way back, and they rest again.
 */
const OUT_OF_REACH = "100% 0px";
const INTENT_LAPSES_MS = 2000;

function useResting(target: RefObject<HTMLElement | null>) {
  const [resting, setResting] = useState(false);

  useEffect(() => {
    const el = target.current;
    if (!el || typeof IntersectionObserver === "undefined") return;

    let inReach = true;
    let headingBack = false;
    let lastY = window.scrollY;
    let lapse: ReturnType<typeof setTimeout> | undefined;

    const sync = () => setResting(!inReach && !headingBack);
    const headBack = () => {
      headingBack = true;
      clearTimeout(lapse);
      lapse = setTimeout(() => {
        headingBack = false;
        sync();
      }, INTENT_LAPSES_MS);
      sync();
    };

    const observer = new IntersectionObserver(
      (entries) => {
        // A batch can hold more than one change; the last is where it is now.
        const latest = entries[entries.length - 1];
        if (!latest) return;
        inReach = latest.isIntersecting;
        sync();
      },
      { rootMargin: OUT_OF_REACH },
    );
    const onScroll = () => {
      const y = window.scrollY;
      if (y < lastY) headBack();
      else if (y > lastY && headingBack) {
        headingBack = false;
        clearTimeout(lapse);
        sync();
      }
      lastY = y;
    };
    const onKey = (event: KeyboardEvent) => {
      const toTop = event.key === "ArrowUp" && (event.metaKey || event.ctrlKey);
      if (event.key === "Home" || event.key === "PageUp" || toTop) headBack();
    };

    observer.observe(el);
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("keydown", onKey);
    return () => {
      observer.disconnect();
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("keydown", onKey);
      clearTimeout(lapse);
    };
  }, [target]);

  return resting;
}

/**
 * Seconds per bounce, and a head start, for logo `i`. Every logo gets its own
 * period, and the negative delay starts each one partway through its cycle,
 * so none move together and nothing sets off in step on load. The values step
 * by the golden ratio, which spreads them evenly however many logos there
 * are.
 */
const GOLDEN = 0.6180339887;

function drift(i: number) {
  return {
    bounce: 4.6 + ((i * GOLDEN + 0.5) % 1) * 1.6,
    delay: -((i * GOLDEN + 0.25) % 1) * 4.3,
  };
}

/**
 * The photo, in pixels, and the point each logo slides away from: on her
 * throat, under her chin, so the upper logos slide up and out and the lower
 * ones down and out.
 */
const PHOTO = { width: 1672, height: 941 };
const HER = { x: 1276, y: 470 };

/** The direction from her to a logo, the way it slides on hover. */
function bearing(at: HeroLogo["at"]) {
  const dx = (at.x / 100) * PHOTO.width - HER.x;
  const dy = (at.y / 100) * PHOTO.height - HER.y;
  const length = Math.hypot(dx, dy);
  return { dx: dx / length, dy: dy / length };
}

/**
 * The node is where the logo sits and what a pointer hovers, the reach
 * slides the logo away from her on hover, and the bounce is its hop at rest;
 * each is its own element because each needs its own transform.
 */
export function HeroPortrait() {
  const stage = useRef<HTMLDivElement>(null);
  const resting = useResting(stage);

  return (
    <div
      ref={stage}
      role="img"
      aria-label={LABEL}
      className="portrait"
      data-paused={resting || undefined}
    >
      <img
        src="/brand/aya-hero.webp"
        alt=""
        width={PHOTO.width}
        height={PHOTO.height}
        fetchPriority="high"
        draggable={false}
        className="portrait__photo"
      />

      {/* Hidden as well as presentational: an image's children should not
          be read, but accessibility tools still listed an empty list item
          per logo under the label. */}
      <ul className="portrait__logos" aria-hidden>
        {HERO_LOGOS.map((logo, i) => {
          const { bounce, delay } = drift(i);
          const { dx, dy } = bearing(logo.at);
          return (
            <li
              key={logo.name}
              className="portrait__node"
              style={{
                ["--x" as string]: `${logo.at.x}%`,
                ["--y" as string]: `${logo.at.y}%`,
                ["--dx" as string]: dx.toFixed(3),
                ["--dy" as string]: dy.toFixed(3),
                ["--bounce-time" as string]: `${bounce.toFixed(2)}s`,
                ["--drift-delay" as string]: `${delay.toFixed(2)}s`,
              }}
            >
              <span className="portrait__reach">
                <span className="portrait__bounce">
                  <img
                    src={logo.src}
                    alt=""
                    width={192}
                    height={192}
                    decoding="async"
                    draggable={false}
                    className="portrait__logo"
                  />
                </span>
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
