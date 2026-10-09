"use client";

import { useEffect, useRef, useState } from "react";

import { OUTCOMES } from "@/lib/outcomes";

/**
 * What changes in month one: the eight outcomes, as the notifications on a
 * clinic owner's lock screen.
 *
 * ## The shape, and where it came from
 *
 * Until 9 October 2026 this was a ledger beside a deck of photographs, the
 * niche section's deck dealt with one clinic's pictures. The owner asked for
 * ten alternatives, never a carousel, and picked the notification wall,
 * "but make it look more like iOS". So it is a lock screen: a blurred
 * wallpaper, the date and a large 9:41, the eight outcomes stacked as iOS
 * notifications from healdesk, newest first, each with its photograph as the
 * thumbnail iOS gives a notification with an image, and the flashlight and
 * camera buttons at the foot. The titles are the owner's other ask: what
 * just happened, in as few words as make sense (lib/outcomes.ts).
 *
 * All eight are on screen at once and nothing needs a touch to be read,
 * which was the point of the old ledger too: these are eight claims that
 * belong together. Three columns on a desktop, two on a tablet, one on a
 * phone.
 *
 * ## The entrance
 *
 * When the lock screen scrolls into view the notifications drop in one after
 * another, the way they arrive on a phone. The cards are visible by default
 * and only hidden once the script has armed them, below the fold, so a page
 * without script, or a visitor who asks for less motion, simply has them.
 *
 * The section header is unchanged: centred eyebrow, the gradient hairline,
 * a serif heading, as the specialties have.
 */

/** The lock screen's date, the Friday of the clock's 9:41: the day the owner chose this. */
const DATE = "Friday, October 9";

export function Outcomes() {
  const screen = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<"idle" | "armed" | "in">("idle");

  useEffect(() => {
    const el = screen.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setState("in");
          observer.disconnect();
        }
      },
      { threshold: 0.2 },
    );
    // Armed only while out of view, so nothing a visitor is looking at hides.
    const box = el.getBoundingClientRect();
    if (box.top > window.innerHeight) {
      setState("armed");
    }
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <section id="outcomes" aria-labelledby="outcomes-heading" className="scroll-mt-24 pt-16 sm:pt-24">
      {/* Centred header, the specialties section's own. */}
      <div className="mx-auto max-w-[52ch] text-center">
        <p className="eyebrow-tag">What changes in month one</p>
        <span
          aria-hidden
          className="bg-gradient-to-r from-transparent via-orange to-transparent mx-auto mt-5 block h-px w-full max-w-[200px]"
        />
        <h2
          id="outcomes-heading"
          className="font-display mx-auto mt-5 text-[clamp(33.6px,4.8vw,55.2px)] leading-[1.06] font-medium tracking-[-0.026em] text-balance"
        >
          Eight things your desk stops losing
        </h2>
      </div>

      <div ref={screen} className="lockscreen mt-12" data-state={state}>
        <div aria-hidden className="lockscreen__wallpaper" />

        <p className="lockscreen__date">{DATE}</p>
        <p className="lockscreen__time" aria-hidden>
          9:41
        </p>

        <ol className="lockscreen__wall" aria-label="Notifications from healdesk in month one">
          {OUTCOMES.map((outcome, i) => (
            <li key={outcome.id} className="notification" style={{ ["--i" as string]: i }}>
              <img src="/icon.png" alt="" width={38} height={38} className="notification__icon" />
              <div className="notification__text">
                <p className="notification__head">
                  <span className="notification__title">{outcome.title}</span>
                  <span className="notification__time">{outcome.time}</span>
                </p>
                <p className="notification__body">{outcome.line}</p>
              </div>
              <img src={outcome.still} alt="" width={720} height={990} loading="lazy" decoding="async" className="notification__thumb" />
            </li>
          ))}
        </ol>

        {/* The foot of a lock screen: the flashlight, the camera, the home bar. */}
        <div aria-hidden className="lockscreen__foot">
          <span className="lockscreen__button">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round">
              <path d="M8 2.5h8v4l-2 3v12h-4v-12l-2-3z" />
              <path d="M12 12.5v2.5" strokeLinecap="round" />
            </svg>
          </span>
          <span className="lockscreen__home" />
          <span className="lockscreen__button">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round">
              <path d="M3.5 8h3.5l2-2.5h6l2 2.5h3.5v11h-17z" />
              <circle cx="12" cy="13" r="3.6" />
            </svg>
          </span>
        </div>
      </div>
    </section>
  );
}
