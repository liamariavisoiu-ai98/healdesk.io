"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";

import { OUTCOMES, type Outcome } from "@/lib/outcomes";
import { REDUCED_MOTION } from "@/lib/use-media-query";

/**
 * What changes in month one: the eight outcomes, as the notifications that
 * arrive on a clinic owner's phone over the month.
 *
 * ## The shape, and where it came from
 *
 * Until 9 October 2026 this was a ledger beside a deck of photographs. The
 * owner then picked a notification wall "that looks more like iOS", which
 * became a lock screen as wide as the page: all eight notifications at once,
 * three columns of them on a desktop, with one empty cell, and on a phone two
 * screens of blurred wallpaper.
 *
 * ## A real phone (owner, 12 October 2026)
 *
 * Now it is a phone in portrait, pinned beside the eight items: on a desktop
 * the phone stays in the right-hand column while the items scroll past on
 * the left; on a phone it stays at the top of the screen and each item rises
 * into the space beneath it. As each item is scrolled past (the middle of the
 * screen on a desktop, just under the phone on a phone), its notification
 * drops onto the lock screen on iOS's spring, the newest on top, and the
 * older ones move down and tuck into a stack after the fourth, as a phone
 * stacks them. Scrolling back takes them off again.
 *
 * They arrive in the order they happened, the oldest first, so the stack
 * ends as the lock screen always read: "now" on top, "Monday" at the foot.
 * The items on the left are in the same order, each with its time, title and
 * line (lib/outcomes.ts), and the one being told is the one at full ink.
 *
 * Without script, before the section is reached, and with reduced motion,
 * every notification is simply there, the newest four showing.
 *
 * ## It opens (the owner, 12 October 2026)
 *
 * Pressing a notification, or an item's "See it in practice", opens it the
 * way iOS opens one pressed hard: it grows into a large card, its photograph
 * enlarged, and says in practice how that outcome works in a clinic, with one
 * plain example (`detail` in lib/outcomes.ts). The growth is the browser's
 * view transition where it has one, which morphs the notification into the
 * card and its thumbnail into the photograph, and a short pop where it has
 * not. Escape, the Close button or a press outside closes it back into place.
 *
 * On a desktop the card opens inside the phone, over its dimmed screen. Below
 * 1024px the phone is too small to read a card in, so the card opens over the
 * page instead (globals.css). The items' buttons are what a keyboard and a
 * screen reader use; the phone is a picture of them, its notifications
 * pressable with a pointer but out of the tab order and hidden from assistive
 * technology, so nothing is announced twice.
 *
 * It is not a native <dialog>: a dialog's backdrop is not part of what a view
 * transition captures, so the scrim would pop in after the card had grown.
 * Instead this is its own overlay, with the roles a dialog gets (modal,
 * named, focus kept inside it and returned to what opened it), and the
 * screen behind it made inert.
 *
 * The section header is unchanged: centred eyebrow, the gradient hairline,
 * a serif heading, as the specialties have.
 */

/** The lock screen's date, the Friday of the clock's 9:41: the day the owner chose this. */
const DATE = "Friday, October 9";

/** The items in the order they happen: the oldest first. */
const STEPS: readonly Outcome[] = [...OUTCOMES].reverse();

/** Names the browser morphs between: the notification and the card, and the picture in each. */
const CARD = "notif";
const PHOTO = "notif-photo";

/**
 * Where an item counts as scrolled past: a line across the screen. The middle
 * on a desktop, where the phone sits beside the items; on a narrow screen,
 * just under the pinned phone, read from where its column actually ends.
 */
const WIDE = "(min-width: 1024px)";

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
 * before it starts; `after` runs once it is done. While it runs the root
 * carries `notif-morph`, which keeps the page itself from cross-fading under
 * the morph (globals.css): the cross-fade is for going between pages.
 */
function transition(change: () => void, steps: { set?: () => void; after?: () => void } = {}): void {
  if (typeof document.startViewTransition !== "function" || prefersReducedMotion()) {
    flushSync(change);
    steps.after?.();
    return;
  }
  steps.set?.();
  const root = document.documentElement;
  root.classList.add("notif-morph");
  const run = document.startViewTransition(() => {
    flushSync(change);
  });
  void run.finished.finally(() => {
    root.classList.remove("notif-morph");
    steps.after?.();
  });
}

/**
 * How many items have been scrolled past, as the index of the last one; -1
 * before the first. Starts with all of them, which is what a page without
 * script shows, and is put back to where the page actually is as soon as
 * this runs: nothing if the section is still below, so the notifications
 * arrive as it is read.
 */
function useStep(list: React.RefObject<HTMLOListElement | null>): { step: number; live: boolean } {
  const [step, setStep] = useState(STEPS.length - 1);
  /** Following the scroll: false without script and with reduced motion. */
  const [live, setLive] = useState(false);

  useEffect(() => {
    const el = list.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    if (prefersReducedMotion()) return;
    const items = [...el.querySelectorAll<HTMLElement>("[data-step]")];
    let observer: IntersectionObserver | null = null;

    const aside = el.parentElement?.querySelector<HTMLElement>(".month__aside");
    const watch = () => {
      observer?.disconnect();
      const wide = window.matchMedia(WIDE).matches;
      const height = window.innerHeight;
      // On a narrow screen: the pinned phone's foot, once it is pinned (its
      // top is the navbar's height, wherever the page is now). Each item is
      // as tall as the space under it (`--pinned`, globals.css) and is told
      // while it is across the middle of that space, so the one being told
      // is always the one in view under the phone.
      const pinned = aside ? Math.round(parseFloat(getComputedStyle(aside).top) + aside.getBoundingClientRect().height) : Math.round(height * 0.6);
      el.parentElement?.style.setProperty("--pinned", `${pinned}px`);
      const line = Math.round(wide ? height * 0.5 : pinned + (height - pinned) / 2);
      // Where the line is now, for the page as it stands: every item whose
      // top is above it has been passed.
      let passed = -1;
      items.forEach((item, i) => {
        if (item.getBoundingClientRect().top < line) passed = i;
      });
      setStep(passed);
      setLive(true);
      observer = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            const i = Number((entry.target as HTMLElement).dataset.step);
            if (entry.isIntersecting) setStep((now) => Math.max(now, i));
            // Gone back below the line: it, and everything after it, is untold.
            else if (entry.boundingClientRect.top > (entry.rootBounds?.top ?? 0)) setStep((now) => Math.min(now, i - 1));
          }
        },
        { rootMargin: `-${line}px 0px -${height - line - 1}px 0px` },
      );
      items.forEach((item) => observer!.observe(item));
    };

    watch();
    const media = window.matchMedia(WIDE);
    media.addEventListener("change", watch);
    // The line is in pixels, so a new screen height moves it.
    let resized = 0;
    const onResize = () => {
      window.clearTimeout(resized);
      resized = window.setTimeout(watch, 150);
    };
    window.addEventListener("resize", onResize);
    return () => {
      observer?.disconnect();
      media.removeEventListener("change", watch);
      window.removeEventListener("resize", onResize);
      window.clearTimeout(resized);
    };
  }, [list]);

  return { step, live };
}

export function Outcomes() {
  const steps = useRef<HTMLOListElement>(null);
  const sheet = useRef<HTMLDivElement>(null);
  const { step, live } = useStep(steps);
  const [openId, setOpenId] = useState<string | null>(null);
  /** What the card grew from, which is where it goes back to. */
  const source = useRef<HTMLElement | null>(null);
  /** Where focus goes when the card closes: the button that opened it. */
  const opener = useRef<HTMLElement | null>(null);

  /** The phone's notification for an outcome, if it is on the lock screen to grow from. */
  const noteFor = (id: string) => {
    const note = document.querySelector<HTMLElement>(`.phone [data-note="${id}"]`);
    return note && Number(note.dataset.pos) >= 0 && Number(note.dataset.pos) < 4 ? note : null;
  };

  const open = useCallback((outcome: Outcome, button: HTMLElement) => {
    opener.current = button;
    const from = noteFor(outcome.id) ?? button;
    source.current = from;
    const thumb = from.querySelector<HTMLElement>(".notification__thumb");
    const name = (on: boolean) => {
      from.style.viewTransitionName = on ? CARD : "";
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
    const from = source.current;
    const thumb = from?.querySelector<HTMLElement>(".notification__thumb");
    const name = (on: boolean) => {
      if (from) from.style.viewTransitionName = on ? CARD : "";
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
          opener.current?.focus({ preventScroll: true });
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
    // A press anywhere outside the card puts it away, as it does on a phone.
    const onDown = (event: PointerEvent) => {
      if (root && !root.contains(event.target as Node)) close();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onDown);
    };
  }, [openId, close]);

  const outcome = openId ? OUTCOMES.find((o) => o.id === openId) : undefined;

  return (
    <section id="outcomes" aria-labelledby="outcomes-heading" className="scroll-mt-24 pt-16 sm:pt-24">
      {/* Centred header, the specialties section's own. */}
      <div data-reveal="stagger" className="mx-auto max-w-[760px] text-center">
        <p className="eyebrow-tag">What changes in month one</p>
        <span
          aria-hidden
          className="bg-gradient-to-r from-transparent via-orange to-transparent mx-auto mt-5 block h-px w-full max-w-[200px]"
        />
        <h2 id="outcomes-heading" className="heading-section mx-auto mt-5">
          Eight things your desk stops losing
        </h2>
      </div>

      <div className="month mt-12 sm:mt-16" data-live={live || undefined} data-open={outcome ? "" : undefined}>
        {/* The phone, first so that on a narrow screen it is pinned above the
            items; on a desktop the grid puts it in the right-hand column. */}
        <div className="month__aside">
          <div className="phone">
            <div className="phone__screen">
              <div aria-hidden className="phone__wallpaper" />
              <span aria-hidden className="phone__island" />

              <div aria-hidden className="phone__clock">
                <p className="phone__date">{DATE}</p>
                <p className="phone__time">9:41</p>
              </div>

              <ol className="phone__notes" aria-hidden inert={outcome ? true : undefined}>
                {STEPS.map((o, i) => {
                  // From the top of the stack: the newest told is 0.
                  const pos = i <= step ? step - i : -1;
                  return (
                    <li key={o.id} className="phone__note" data-pos={pos} data-note={o.id}>
                      <button type="button" tabIndex={-1} className="notification" onClick={(event) => open(o, event.currentTarget)}>
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
                  );
                })}
              </ol>

              {/* The foot of a lock screen: the flashlight, the camera, the home bar. */}
              <div aria-hidden className="phone__foot">
                <span className="phone__button">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round">
                    <path d="M8 2.5h8v4l-2 3v12h-4v-12l-2-3z" />
                    <path d="M12 12.5v2.5" strokeLinecap="round" />
                  </svg>
                </span>
                <span className="phone__home" />
                <span className="phone__button">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round">
                    <path d="M3.5 8h3.5l2-2.5h6l2 2.5h3.5v11h-17z" />
                    <circle cx="12" cy="13" r="3.6" />
                  </svg>
                </span>
              </div>

              {/* Inside the phone on a desktop; over the page below 1024px. */}
              {outcome ? (
                <div className="notice-layer" data-pop={typeof document.startViewTransition === "function" ? undefined : ""}>
                  <div className="notice-stage">
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
                        <a href="#aya" className="notice__button notice__button--primary" onClick={() => setOpenId(null)}>
                          Talk to AYA
                        </a>
                        <button type="button" className="notice__button" data-initial-focus onClick={close}>
                          Close
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              ) : null}
            </div>
          </div>
        </div>

        <ol ref={steps} className="month__steps" aria-label="Month one, as it happens" inert={outcome ? true : undefined}>
          {STEPS.map((o, i) => (
            <li key={o.id} className="month__step" data-step={i} data-now={i === step || undefined}>
              <p className="month__when">{o.time}</p>
              <h3 className="month__title">{o.title}</h3>
              <p className="month__line">{o.line}</p>
              <button type="button" className="month__open" aria-haspopup="dialog" onClick={(event) => open(o, event.currentTarget)}>
                See it in practice
                <svg aria-hidden viewBox="0 0 16 16">
                  <path d="M3 8h9.5M8.5 4l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
