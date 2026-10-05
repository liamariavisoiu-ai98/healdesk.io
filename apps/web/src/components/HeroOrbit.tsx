"use client";

import { useState } from "react";

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
 */

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

  return (
    <div className={`relative ${className}`}>
      <div role="img" aria-label={LABEL} className="orbit" data-paused={paused || undefined}>
        {/* Hidden as well as presentational: an image's children should not
            be read, but accessibility tools still listed an empty list item
            per logo under the label. */}
        <div className="orbit__core" aria-hidden>
          <HealdeskSoul size="var(--orbit-soul)" clip="hero" paused={paused} />
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
