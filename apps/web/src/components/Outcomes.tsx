"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";

import { OUTCOMES, type Outcome } from "@/lib/outcomes";
import { REDUCED_MOTION } from "@/lib/use-media-query";

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
 * All eight are on screen at once and readable without a touch, which was
 * the point of the old ledger too: these are eight claims that belong
 * together. Three columns on a desktop, two on a tablet, one on a phone.
 *
 * ## It arrives, and it opens (the owner, 12 October 2026)
 *
 * When the lock screen scrolls into view the screen wakes (the wallpaper
 * comes up, the clock fades in) and the notifications drop in one after
 * another on a spring, the way they arrive on a phone. The cards are visible
 * by default and only hidden once the script has armed them, below the fold,
 * so no script, or a visitor who asks for less motion, simply has them.
 *
 * Pressing a notification opens it the way iOS opens one you press hard: it
 * grows into a large card over the dimmed, blurred screen, its photograph
 * enlarged, and says in practice how that outcome works in a clinic, with one
 * plain example (`detail` in lib/outcomes.ts). The growth is the browser's
 * view transition where it has one (every current Chrome, Edge and Safari,
 * and Firefox from 144), which morphs the notification into the card and its
 * thumbnail into the photograph, and a short pop where it has not. Escape,
 * the Close button or a press outside closes it back into place.
 *
 * It is not a native <dialog>: a dialog's backdrop is not part of what a view
 * transition captures, so the scrim would pop in after the card had grown.
 * Instead this is its own overlay, with the roles a dialog gets (modal, named,
 * focus kept inside it and returned to the notification), and the screen
 * behind it made inert.
 *
 * The section header is unchanged: centred eyebrow, the gradient hairline,
 * a serif heading, as the specialties have.
 */

/** The lock screen's date, the Friday of the clock's 9:41: the day the owner chose this. */
const DATE = "Friday, October 9";

type Phase = "idle" | "armed" | "in";

/** Names the browser morphs between: the notification and the card, and the picture in each. */
const CARD = "notif";
const PHOTO = "notif-photo";

function prefersReducedMotion(): boolean {
  return window.matchMedia(REDUCED_MOTION).matches;
}

/**
 * Run a change to the page inside a view transition where there is one, and
 * straight away where there is not.
 *
 * `set` names the elements the browser should morph from, before it looks at
 * the page as it is; `change` makes the new page, and must take those names
 * off the old elements, because two elements with one name end a transition
 * before it starts; `after` runs once it is done.
 */
function transition(change: () => void, steps: { set?: () => void; after?: () => void } = {}): void {
  if (typeof document.startViewTransition !== "function" || prefersReducedMotion()) {
    flushSync(change);
    steps.after?.();
    return;
  }
  steps.set?.();
  const run = document.startViewTransition(() => {
    flushSync(change);
  });
  void run.finished.finally(() => steps.after?.());
}

export function Outcomes() {
  const screen = useRef<HTMLDivElement>(null);
  const sheet = useRef<HTMLDivElement>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [openId, setOpenId] = useState<string | null>(null);
  /** The notification the card grew from, which is where it goes back to and where focus returns. */
  const source = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    const el = screen.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    if (window.matchMedia(REDUCED_MOTION).matches) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setPhase("in");
          observer.disconnect();
        }
      },
      { threshold: 0.2 },
    );
    // Armed only while out of view, so nothing a visitor is looking at hides.
    const box = el.getBoundingClientRect();
    if (box.top > window.innerHeight) setPhase("armed");
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const open = useCallback((outcome: Outcome, button: HTMLButtonElement) => {
    source.current = button;
    const thumb = button.querySelector<HTMLElement>(".notification__thumb");
    const name = (on: boolean) => {
      button.style.viewTransitionName = on ? CARD : "";
      if (thumb) thumb.style.viewTransitionName = on ? PHOTO : "";
    };
    transition(
      () => {
        setOpenId(outcome.id);
        // The card has the names now.
        name(false);
      },
      { set: () => name(true) },
    );
  }, []);

  const close = useCallback(() => {
    const button = source.current;
    const thumb = button?.querySelector<HTMLElement>(".notification__thumb");
    const name = (on: boolean) => {
      if (button) button.style.viewTransitionName = on ? CARD : "";
      if (thumb) thumb.style.viewTransitionName = on ? PHOTO : "";
    };
    // The card is named while it is open (below); on the way back the
    // notification takes the names, so the browser morphs one into the other.
    transition(
      () => {
        setOpenId(null);
        name(true);
      },
      {
        after: () => {
          name(false);
          // The screen behind the card is inert until it has gone.
          button?.focus({ preventScroll: true });
        },
      },
    );
  }, []);

  // While the card is open: Escape closes, Tab stays inside, and focus goes in.
  useEffect(() => {
    if (!openId) return;
    const root = sheet.current;
    root?.querySelector<HTMLElement>("[data-initial-focus]")?.focus({ preventScroll: true });
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close();
        return;
      }
      if (event.key !== "Tab" || !root) return;
      const stops = [...root.querySelectorAll<HTMLElement>("button, a[href]")];
      if (stops.length === 0) return;
      const first = stops[0]!;
      const last = stops[stops.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [openId, close]);

  const outcome = openId ? OUTCOMES.find((o) => o.id === openId) : undefined;

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

      <div ref={screen} className="lockscreen mt-12" data-state={phase} data-open={outcome ? "" : undefined}>
        <div aria-hidden className="lockscreen__wallpaper" />

        <p className="lockscreen__date">{DATE}</p>
        <p className="lockscreen__time" aria-hidden>
          9:41
        </p>

        <ol className="lockscreen__wall" aria-label="Notifications from healdesk in month one" inert={outcome ? true : undefined}>
          {OUTCOMES.map((o, i) => (
            <li key={o.id}>
              <button
                type="button"
                className="notification"
                style={{ ["--i" as string]: i }}
                aria-haspopup="dialog"
                onClick={(event) => open(o, event.currentTarget)}
              >
                <img src="/icon.png" alt="" width={38} height={38} className="notification__icon" />
                <span className="notification__text">
                  <span className="notification__head">
                    <span className="notification__title">{o.title}</span>
                    <span className="notification__time">{o.time}</span>
                  </span>
                  <span className="notification__body">{o.line}</span>
                </span>
                <img src={o.still} alt="" width={720} height={990} loading="lazy" decoding="async" className="notification__thumb" />
              </button>
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

      {outcome ? (
        <div
          className="notice-layer"
          data-pop={typeof document.startViewTransition === "function" ? undefined : ""}
          onPointerDown={(event) => event.target === event.currentTarget && close()}
        >
          <div ref={sheet} className="notice" role="dialog" aria-modal="true" aria-labelledby="notice-title" style={{ viewTransitionName: CARD }}>
            <div className="notice__head">
              <img src="/icon.png" alt="" width={30} height={30} className="notice__icon" />
              <span className="notice__app">healdesk</span>
              <span className="notice__time">{outcome.time}</span>
            </div>
            <img
              src={outcome.still}
              alt=""
              width={720}
              height={990}
              className="notice__photo"
              style={{ viewTransitionName: PHOTO }}
            />
            <div className="notice__body">
              <h3 id="notice-title" className="notice__title">
                {outcome.title}
              </h3>
              <p className="notice__line">{outcome.line}</p>
              <p className="notice__detail">{outcome.detail}</p>
            </div>
            <div className="notice__actions">
              <a
                href="#aya"
                className="notice__button notice__button--primary"
                onClick={() => setOpenId(null)}
              >
                Talk to AYA
              </a>
              <button type="button" className="notice__button" data-initial-focus onClick={close}>
                Close
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
