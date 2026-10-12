"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { flushSync } from "react-dom";

import { englishLocale, hourCycleOf, lockDate, lockTime, noteTimes } from "@/lib/lock-clock";
import { OUTCOMES, type Outcome } from "@/lib/outcomes";
import { REDUCED_MOTION } from "@/lib/use-media-query";

/**
 * What changes in month one: the eight outcomes, as the notifications on a
 * clinic owner's lock screen.
 *
 * ## The shape, and where it came from
 *
 * Until 9 October 2026 this was a ledger beside a deck of photographs. The
 * owner then picked a notification wall "that looks more like iOS": a
 * blurred wallpaper, the date and a large clock, the eight outcomes as iOS
 * notifications from healdesk, newest first, each with its photograph as the
 * thumbnail iOS gives a notification with an image, and the flashlight and
 * camera at the foot. The titles say what just happened in as few words as
 * make sense (lib/outcomes.ts).
 *
 * On 12 October 2026 it became a phone pinned beside the eight items, and the
 * same day the owner kept that for phones only, without the phone: so there
 * are two renders of one lock screen, split at 1024px.
 *
 * ## On a desktop: the wall
 *
 * A lock screen as wide as the page, all eight notifications on it at once,
 * in three columns (two below 1100px): eight claims that belong together,
 * readable without a touch. When it scrolls into view the screen wakes (the
 * wallpaper comes up, the clock fades in) and the notifications rise into it
 * one after another, as iOS brings them: from below, out of a soft blur,
 * smoothly, oldest first, so "now" arrives last at the top. They are visible
 * by default and
 * hidden only once the script has armed them, below the fold, so no script,
 * or a visitor who asks for less motion, simply has them.
 *
 * ## Below 1024px: the whole screen is the lock screen
 *
 * The section is a tall track and the lock screen is pinned in it under the
 * navbar, edge to edge and as tall as what is left of the screen, so it reads
 * as the visitor's own phone rather than a picture of one. As the track is
 * scrolled, the notifications arrive one by one, oldest first, each rising in
 * at the foot of the stack, as on iOS, and pushing the older ones up; those
 * that no longer fit tuck behind the top one, and scrolling back takes them
 * off again. How many fit is measured
 * (`--fit`), because a small phone holds fewer than a tablet. Without script,
 * and with reduced motion, there is no track: the lock screen simply lists all
 * eight.
 *
 * ## The visitor's clock (owner, 12 October 2026)
 *
 * The date and time on the screen are the visitor's own, and tick, and the
 * notifications' times are read against them (lib/lock-clock.ts). The server
 * has no clock of the visitor's, so the page is written with the screen's old
 * Friday and 9:41, and the browser puts its own in as soon as it runs, long
 * before a visitor scrolls this far.
 *
 * ## It opens (the owner, 12 October 2026)
 *
 * Pressing a notification opens it the way iOS opens one pressed hard: it
 * grows into a large card, its photograph enlarged, and says in practice how
 * that outcome works in a clinic, with one plain example (`detail` in
 * lib/outcomes.ts). The growth is the browser's view transition where it has
 * one, which morphs the notification into the card and its thumbnail into
 * the photograph, and a short pop where it has not. Escape, the Close button
 * or a press outside closes it back into place. On a desktop the card opens
 * inside the lock screen, over its dimmed wall; below 1024px over the page.
 *
 * It is not a native <dialog>: a dialog's backdrop is not part of what a view
 * transition captures, so the scrim would pop in after the card had grown.
 * Instead this is its own overlay, with the roles a dialog gets (modal,
 * named, focus kept inside it and returned to the notification), and the
 * screen behind it made inert.
 *
 * The notifications are the section's buttons, for a keyboard and a screen
 * reader too. On the narrow screen one still on its way, or tucked into the
 * stack, scrolls the track to where it is on top when it takes focus.
 */

/** What the server writes, before the visitor's own clock is known: the Friday the owner chose this, at 9:41. */
const DATE = "Friday, October 9";
const TIME = "9:41";

/** The wide render, the wall, from here. */
const WIDE = "(min-width: 1024px)";

/** The narrow track's length, in steps: one per notification and a little to rest on the last. */
const STEPS = OUTCOMES.length + 0.6;
/** How far into its step a notification arrives, so the first one is there as the screen pins. */
const LEAD = 0.05;

type Phase = "idle" | "armed" | "in";

/** Names the browser morphs between: the notification and the card, and the picture in each. */
const CARD = "notif";
const PHOTO = "notif-photo";

function prefersReducedMotion(): boolean {
  return window.matchMedia(REDUCED_MOTION).matches;
}

/** The minute, on the visitor's clock; null on the server. Ticks on the minute, and on coming back to the tab. */
function subscribeMinute(onChange: () => void) {
  let timer = 0;
  const arm = () => {
    timer = window.setTimeout(
      () => {
        onChange();
        arm();
      },
      60_000 - (Date.now() % 60_000) + 20,
    );
  };
  arm();
  document.addEventListener("visibilitychange", onChange);
  return () => {
    window.clearTimeout(timer);
    document.removeEventListener("visibilitychange", onChange);
  };
}

function useMinute(): number | null {
  return useSyncExternalStore(
    subscribeMinute,
    () => Math.floor(Date.now() / 60_000),
    () => null,
  );
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
 * The lock screen's motion. On a desktop, `phase`: armed below the fold, in
 * once the wall is in view. Below 1024px, `step`: how many notifications the
 * track has been scrolled past, as the index of the last one in the order
 * they happened (-1 before the first), and `fit`, how many the screen holds
 * one under another. `live` says the narrow track is running: without script
 * and with reduced motion it never is, and every notification is simply there.
 */
function useLockScreen(track: React.RefObject<HTMLDivElement | null>) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [step, setStep] = useState(OUTCOMES.length - 1);
  const [fit, setFit] = useState(4);
  const [live, setLive] = useState(false);

  useEffect(() => {
    const el = track.current;
    if (!el || prefersReducedMotion()) return;
    const screen = el.querySelector<HTMLElement>(".lockscreen");
    const wall = el.querySelector<HTMLElement>(".lockscreen__wall");
    if (!screen || !wall) return;
    const media = window.matchMedia(WIDE);
    let stop = () => {};

    const wide = () => {
      setLive(false);
      setStep(OUTCOMES.length - 1);
      if (typeof IntersectionObserver === "undefined") return () => {};
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
      setPhase((now) => (now === "idle" && screen.getBoundingClientRect().top > window.innerHeight ? "armed" : now));
      observer.observe(screen);
      return () => observer.disconnect();
    };

    const narrow = () => {
      setLive(true);
      let frame = 0;
      const read = () => {
        frame = 0;
        // How far the pinned screen has travelled down its track, in steps.
        // Both from the same rectangles, so the site's zoom cancels out.
        const box = el.getBoundingClientRect();
        const pinned = screen.getBoundingClientRect();
        const range = box.height - pinned.height;
        if (range <= 0) return;
        const steps = ((pinned.top - box.top) / range) * STEPS;
        setStep(Math.max(-1, Math.min(OUTCOMES.length - 1, Math.floor(steps - LEAD))));
      };
      const onScroll = () => {
        if (!frame) frame = requestAnimationFrame(read);
      };
      // How many notifications fit one under another, from the wall's height
      // and one notification's.
      const measure = () => {
        const note = wall.querySelector<HTMLElement>(".lockscreen__note");
        if (!note) return;
        const gap = parseFloat(getComputedStyle(wall).getPropertyValue("--note-gap")) || 8;
        setFit(Math.max(1, Math.floor((wall.clientHeight + gap) / (note.offsetHeight + gap))));
        read();
      };
      const resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
      resize?.observe(wall);
      window.addEventListener("scroll", onScroll, { passive: true });
      window.addEventListener("resize", onScroll);
      // Once the track has its height: `live` is what gives it one.
      frame = requestAnimationFrame(measure);
      return () => {
        cancelAnimationFrame(frame);
        resize?.disconnect();
        window.removeEventListener("scroll", onScroll);
        window.removeEventListener("resize", onScroll);
      };
    };

    const start = () => {
      stop();
      stop = media.matches ? wide() : narrow();
    };
    start();
    media.addEventListener("change", start);
    return () => {
      stop();
      media.removeEventListener("change", start);
    };
  }, [track]);

  return { phase, step, fit, live };
}

export function Outcomes() {
  const track = useRef<HTMLDivElement>(null);
  const sheet = useRef<HTMLDivElement>(null);
  const { phase, step, fit, live } = useLockScreen(track);
  const [openId, setOpenId] = useState<string | null>(null);
  /** The notification the card grew from, which is where it goes back to and where focus returns. */
  const source = useRef<HTMLButtonElement | null>(null);

  const minute = useMinute();
  const clock = useMemo(() => {
    if (minute === null) return null;
    // A clock that cannot be read leaves the screen as the server wrote it,
    // never the section broken.
    try {
      const now = new Date(minute * 60_000);
      const locale = englishLocale(navigator.languages ?? [navigator.language]);
      const cycle = hourCycleOf();
      return { date: lockDate(now, locale), time: lockTime(now, locale, cycle), notes: noteTimes(OUTCOMES, now, locale, cycle) };
    } catch {
      return null;
    }
  }, [minute]);

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

  /** On the narrow track, scroll to where notification `index` (in the order they happened) is on top. */
  const reach = useCallback((index: number) => {
    const mark = track.current?.querySelector<HTMLElement>(`[data-mark="${index}"]`);
    mark?.scrollIntoView({ block: "start", behavior: prefersReducedMotion() ? "auto" : "smooth" });
  }, []);

  // While the card is open: Escape closes, Tab stays inside, and focus goes in.
  useEffect(() => {
    if (!openId) return;
    const root = sheet.current;
    root?.querySelector<HTMLElement>("[data-initial-focus]")?.focus({ preventScroll: true });
    // On a desktop the lock screen may be only part-way into view, and the
    // card with it; bring in exactly as much as it needs (scroll-margin on
    // .notice keeps it clear of the navbar).
    const id = window.setTimeout(() => {
      if (window.matchMedia(WIDE).matches) root?.scrollIntoView({ block: "nearest", behavior: prefersReducedMotion() ? "auto" : "smooth" });
    }, 80);
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
    // A press anywhere outside the card, on the scrim or on the page beyond
    // it, puts it away, as it does on a phone.
    const onDown = (event: PointerEvent) => {
      if (root && !root.contains(event.target as Node)) close();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown);
    return () => {
      window.clearTimeout(id);
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onDown);
    };
  }, [openId, close]);

  const outcome = openId ? OUTCOMES.find((o) => o.id === openId) : undefined;
  const timeOf = (o: Outcome) => clock?.notes[o.id] ?? o.time;

  return (
    <section id="outcomes" aria-labelledby="outcomes-heading" className="scroll-mt-24 pt-16 sm:pt-24">
      {/* Centred header, the specialties section's own. */}
      <div data-reveal="stagger" className="mx-auto text-center">
        <p className="eyebrow-tag">What changes in month one</p>
        <h2 id="outcomes-heading" className="heading-section mx-auto mt-5">
          Eight things your desk stops losing
        </h2>
      </div>

      <div
        ref={track}
        className="month mt-10 sm:mt-14"
        data-state={phase}
        data-live={live || undefined}
        data-open={outcome ? "" : undefined}
        style={{ ["--fit" as string]: fit }}
      >
        {/* Where each notification is on top, for a keyboard to scroll to. */}
        {live
          ? OUTCOMES.map((o, i) => <span key={o.id} aria-hidden className="month__mark" data-mark={i} style={{ ["--at" as string]: i + 0.5 }} />)
          : null}

        <div className="lockscreen">
          <div aria-hidden className="lockscreen__wallpaper" />

          <p className="lockscreen__date">{clock?.date ?? DATE}</p>
          <p className="lockscreen__time" aria-hidden>
            {clock?.time ?? TIME}
          </p>

          <ol className="lockscreen__wall" aria-label="Notifications from healdesk in month one" inert={outcome ? true : undefined}>
            {OUTCOMES.map((o, j) => {
              // Its place in the order they happened, the oldest first (`--n`,
              // the wall's arrival order), and so its place in the stack from
              // the newest: the newest told is 0.
              const i = OUTCOMES.length - 1 - j;
              const pos = i <= step ? step - i : -1;
              const tucked = live && pos >= fit;
              return (
                <li
                  key={o.id}
                  className="lockscreen__note"
                  data-pos={live ? pos : undefined}
                  data-tucked={tucked || undefined}
                  style={{ ["--n" as string]: i, ["--pos" as string]: pos }}
                >
                  <button
                    type="button"
                    className="notification"
                    aria-haspopup="dialog"
                    onFocus={() => {
                      if (live && (pos < 0 || tucked)) reach(i);
                    }}
                    onClick={(event) => open(o, event.currentTarget)}
                  >
                    <img src="/icon.png" alt="" width={38} height={38} className="notification__icon" />
                    <span className="notification__text">
                      <span className="notification__head">
                        <span className="notification__title">{o.title}</span>
                        <span className="notification__time">{timeOf(o)}</span>
                      </span>
                      <span className="notification__body">{o.line}</span>
                    </span>
                    <img src={o.still} alt="" width={720} height={990} loading="lazy" decoding="async" className="notification__thumb" />
                  </button>
                </li>
              );
            })}
          </ol>

          {/* The foot of a lock screen: the flashlight, the camera, the home
              bar, and on a phone, where iOS says "Swipe up to open", how to
              open one of these. */}
          <div aria-hidden className="lockscreen__foot">
            <span className="lockscreen__button">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round">
                <path d="M8 2.5h8v4l-2 3v12h-4v-12l-2-3z" />
                <path d="M12 12.5v2.5" strokeLinecap="round" />
              </svg>
            </span>
            <span className="lockscreen__middle">
              <span className="lockscreen__hint">Tap a notification to open it</span>
              <span className="lockscreen__home" />
            </span>
            <span className="lockscreen__button">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round">
                <path d="M3.5 8h3.5l2-2.5h6l2 2.5h3.5v11h-17z" />
                <circle cx="12" cy="13" r="3.6" />
              </svg>
            </span>
          </div>

          {/* Inside the lock screen on a desktop, its scrim and its corners;
              over the page below 1024px. */}
          {outcome ? (
            <div className="notice-layer" data-pop={typeof document.startViewTransition === "function" ? undefined : ""}>
              <div className="notice-stage">
                <div ref={sheet} className="notice" role="dialog" aria-modal="true" aria-labelledby="notice-title" style={{ viewTransitionName: CARD }}>
                  <div className="notice__head">
                    <img src="/icon.png" alt="" width={30} height={30} className="notice__icon" />
                    <span className="notice__app">healdesk</span>
                    <span className="notice__time">{timeOf(outcome)}</span>
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
    </section>
  );
}
