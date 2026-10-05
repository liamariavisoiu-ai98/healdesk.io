"use client";

import { useEffect, useRef, useState, type RefObject } from "react";

import { HealdeskSoul } from "@/components/HealdeskSoul";
import { LABEL, RING } from "@/lib/integrations";

/**
 * The hero's right-hand side: AYA's soul, with the tools she works through
 * floating round it, each tied to her by a hairline. The logos, their label
 * and their trademark line are in lib/integrations.ts; the geometry and the
 * motion are in globals.css under "The hero orbit".
 *
 * ## What is on the ring
 *
 * The logos the owner chose on 5 October 2026: the four places a patient
 * writes in (website chat, Instagram, Messenger, WhatsApp) and the five
 * places her work lands (Google Calendar; Cal.com, Calendly and HighLevel;
 * Stripe).
 *
 * Cal.com, Calendly and HighLevel are there as calendars that read Google's,
 * never as ones she writes into: v1 writes bookings to the clinic's Google
 * Calendar and nothing else, and a clinic on one of them links the two in
 * that system's own settings, which the spec calls "a setting in their
 * system, not a Healdesk integration" (docs/v1-product-spec.md, "Where
 * bookings are written"). The spec's table ("What the hub model does and
 * does not guarantee") has all three reading Google's calendar for
 * conflicts, HighLevel through a "conflict calendar" that blocks any slot
 * holding an event marked busy, as hers are. The owner kept all three on the
 * ring after the review said so, and the label says they work through that
 * calendar.
 * Stripe is the gateway a clinic connects to take deposits in chat, and
 * deposits stay off until it does.
 *
 * ## Evenly spaced, and in an order
 *
 * A ninth of a turn apart, the first at twelve o'clock, so the ring is
 * symmetrical about its vertical axis. Clockwise from the top: Google
 * Calendar, the one calendar she writes; the calendars that read it and
 * Stripe down the right; then the four channels back up the left. The two
 * kinds never interleave, and no two blues sit side by side.
 *
 * ## The pause button
 *
 * The ring and the soul loop for as long as the page is open, beside the
 * heading and the buttons, and WCAG 2.2.2 asks for a way to stop motion like
 * that which does not depend on an operating-system setting. It sits outside
 * the image, because a role="img" hides its children from screen readers,
 * and it holds everything where it is rather than snapping back to rest.
 * Under reduced motion nothing moves, so it is not shown.
 *
 * ## Resting out of view
 *
 * Away from the hero the orbit rests, held the same way, so a reader deep in
 * the page is not paying for the clip and every loop while none of it is in
 * sight (see useResting). The button only ever shows the reader's own choice.
 */

/**
 * Whether the orbit may rest: more than a screen from the viewport and not
 * being headed back to.
 *
 * The hero is the top of the page, so heading back is going up. Any scroll
 * upwards wakes it at once, however far down, and so do the keys that jump
 * up a page or to the top, on the key press, before the first frame of the
 * scroll they start. A screen of margin means a reader on the way back finds
 * it already moving. An upward nudge that stops for two seconds while still
 * out of reach was not a way back, and it rests again.
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
 * Seconds per swing and per bounce, and a head start, for logo `i`.
 *
 * Every logo gets its own pair of periods, so no two move together and the
 * ring never visibly repeats, and the negative delay starts each one partway
 * through its cycle, so nothing sets off in step on load either. The values
 * step by the golden ratio, which spreads them evenly and never lands two
 * logos on the same one, however many the ring holds; whole-number steps
 * taken modulo the ring's size had handed the eighth and ninth logos the
 * first two's rhythm.
 */
const GOLDEN = 0.6180339887;

function drift(i: number) {
  return {
    sway: 4.1 + ((i * GOLDEN) % 1) * 2.2,
    bounce: 4.6 + ((i * GOLDEN + 0.5) % 1) * 1.6,
    delay: -((i * GOLDEN + 0.25) % 1) * 4.3,
  };
}

/**
 * The spoke swings, the node is where the logo sits and what a pointer
 * hovers, the reach slides the logo out along its bearing on hover, and the
 * bounce is its hop at rest; each is its own element because each needs its
 * own transform.
 */
export function HeroOrbit({ className = "" }: { className?: string }) {
  const [paused, setPaused] = useState(false);
  const stage = useRef<HTMLDivElement>(null);
  const resting = useResting(stage);
  const held = paused || resting;

  return (
    <div ref={stage} className={`relative ${className}`}>
      <div role="img" aria-label={LABEL} className="orbit" data-paused={held || undefined}>
        {/* Hidden as well as presentational: an image's children should not
            be read, but accessibility tools still listed an empty list item
            per logo under the label. */}
        <div className="orbit__core" aria-hidden>
          <HealdeskSoul size="var(--orbit-soul)" clip="hero" paused={held} />
        </div>

        <ul className="orbit__ring" aria-hidden>
          {RING.map((logo, i) => {
            const { sway, bounce, delay } = drift(i);
            return (
              <li
                key={logo.name}
                className="orbit__spoke"
                style={{
                  ["--angle" as string]: `${((360 / RING.length) * i).toFixed(3)}deg`,
                  ["--sway-time" as string]: `${sway.toFixed(2)}s`,
                  ["--bounce-time" as string]: `${bounce.toFixed(2)}s`,
                  ["--drift-delay" as string]: `${delay.toFixed(2)}s`,
                  ...(logo.disc ? { ["--disc" as string]: String(logo.disc) } : {}),
                }}
              >
                <span className="orbit__arm">
                  <span className="orbit__line" />
                </span>
                <span className="orbit__node">
                  <span className="orbit__reach">
                    <span
                      className={logo.disc ? "orbit__bounce orbit__bounce--disc" : "orbit__bounce"}
                    >
                      <img
                        src={logo.src}
                        alt=""
                        width={192}
                        height={192}
                        decoding="async"
                        draggable={false}
                        className="orbit__logo"
                      />
                    </span>
                  </span>
                </span>
              </li>
            );
          })}
        </ul>
      </div>

      <button
        type="button"
        onClick={() => setPaused((p) => !p)}
        aria-pressed={paused}
        aria-label="Pause the animation"
        className="border-line text-muted hover:text-ink absolute right-0 bottom-0 grid size-8 place-items-center rounded-full border bg-white/90 shadow-[0_6px_16px_-10px_rgb(23_42_58/0.5)] transition-colors motion-reduce:hidden"
      >
        {paused ? (
          <svg aria-hidden width="12" height="12" viewBox="0 0 12 12" fill="currentColor">
            <path d="M3 1.8v8.4a.6.6 0 0 0 .9.5l7-4.2a.6.6 0 0 0 0-1L3.9 1.3a.6.6 0 0 0-.9.5Z" />
          </svg>
        ) : (
          <svg aria-hidden width="12" height="12" viewBox="0 0 12 12" fill="currentColor">
            <rect x="2.25" y="1.5" width="2.5" height="9" rx="0.75" />
            <rect x="7.25" y="1.5" width="2.5" height="9" rx="0.75" />
          </svg>
        )}
      </button>
    </div>
  );
}
