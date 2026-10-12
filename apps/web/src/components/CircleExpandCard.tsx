"use client";

import { useCallback, useEffect, useRef } from "react";

import { REDUCED_MOTION } from "@/lib/use-media-query";

/**
 * A card whose corner icon floods the tile on hover, revealing footage beneath.
 *
 * The interaction is the one from the Framer community component
 * `CircleExpandCard` (framer.com/m/CircleExpandCard-Hwe1Cb.js). This is a
 * reimplementation rather than that module: it imports `framer`'s
 * `addPropertyControls` and `framer-motion`, neither of which exists in this
 * app, and it is a minified bundle served from framerusercontent.com, so
 * shipping it would put a third-party host on the critical path of our own
 * marketing page.
 *
 * ## Layers, bottom to top
 *
 *   blur    the still at 16px, blurred, until the still has loaded
 *   still   the poster frame, always painted
 *   video   cross-fades in on hover and plays; identical crop to the still, so
 *           the handoff reveals nothing
 *   flood   the icon's own circle, scaled up to cover the tile, the logo's
 *           orange at half strength
 *   mask    a bottom-up ink gradient, so the copy survives a bright frame
 *   copy    title on the floor of the card, description opening under it,
 *           and the arrow that never moves
 *
 * ## Two things that are not stylistic
 *
 * The flood animates `transform: scale`, not width and height as the original
 * does. Growing a box every frame is layout plus paint where a transform is
 * neither, and this runs inside a deck that is already springing five other
 * cards on every move. The transition itself lives in globals.css, a Tailwind `scale-100`
 * to `scale-[18]` pair produces two different value types for one property and
 * silently does not interpolate.
 *
 * Only the front card mounts a <video> at all, so the deck holds one decoder
 * rather than six. That card preloads metadata only: the body of the clip is
 * not fetched until a hover asks for it, but the element is ready enough that
 * the first play is not a cold start.
 */

const ARROW = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M7 17 17 7" />
    <path d="M8 7h9v9" />
  </svg>
);

/**
 * How far the 44px puck must grow to cover the tile from its own corner.
 *
 * The circle is centred 42px in from the top-right, so the farthest point is
 * the bottom-left corner: on a 320x440 card that is hypot(278, 398), about
 * 485px of radius, which is a scale of 22 on an 11px radius. Rounded up, so
 * the corners fill before the transition ends rather than exactly as it does,
 * otherwise a pale wedge shows in the corner for the last few frames.
 */
const FLOOD_SCALE = 24;

/**
 * How the footage comes up to speed, and comes to rest.
 *
 * It used to start at full speed the instant a pointer landed, which read as
 * abrupt (owner, 12 October 2026). Now it starts at a fifth of its speed and
 * eases up to full over RISE_MS while it fades in, slowly at first, as a
 * camera move gathers itself; and on the way out it slows while it fades,
 * and only once it has gone is it paused and rewound. The fade and a slight
 * push-in on the picture are globals.css's ("Niche card").
 */
const SLOW_RATE = 0.2;
const RISE_MS = 1800;
/** The fade out's length (--duration-slow, globals.css), so the rewind happens once the footage is no longer seen. */
const SETTLE_MS = 480;

/** A rate some browser refuses leaves the footage at the last one it took. */
function setRate(el: HTMLVideoElement, rate: number) {
  try {
    el.playbackRate = rate;
  } catch {
    /* kept at the last rate */
  }
}

export function CircleExpandCard({
  title,
  body,
  still,
  placeholder,
  video,
  onActivate,
  tabIndex,
  active = true,
  interactive = true,
  compact = false,
  floodScale = FLOOD_SCALE,
  expanded = false,
  live = true,
}: {
  title: string;
  body: string;
  /** Poster frame. Must be the same crop as the video's first frame. */
  still: string;
  /**
   * A tiny inline copy of the still, painted blurred under it until it has
   * loaded, so a card is never a flat grey box (lib/niche-media.ts).
   */
  placeholder?: string;
  /** Sources without extensions, `.webm` and `.mp4` are both offered. */
  video?: string;
  onActivate: () => void;
  tabIndex?: number;
  /**
   * Whether this card is the one in front.
   *
   * Only the active card mounts a <video> at all. In a stack of six that is
   * the difference between one decoder and six, and the five behind it are
   * scaled to 70% under a 30%-opacity veil where nobody could see it move.
   */
  active?: boolean;
  /**
   * Whether the card has finished moving.
   *
   * A card becomes the front card the instant the index changes, while the
   * spring is still carrying it into place, so without this the flood could be
   * triggered by a pointer the card slid underneath. Withholding the `group`
   * class is what disables the Tailwind hover variants; the modifier class
   * below does the same for the hand-written ones in globals.css.
   */
  interactive?: boolean;
  /**
   * Smaller type and padding, for a tile in the specialties mosaic, a quarter
   * of the section wide, rather than a deck's 340px card.
   */
  compact?: boolean;
  /**
   * How far the puck grows to cover the tile. The default covers a 320x440
   * card; a bento's big tile is wider than that, and needs more.
   */
  floodScale?: number;
  /**
   * Open without a pointer on it: the description showing, the footage
   * playing, the title at its large size. The bento keeps one card open at a
   * time (the one a visitor is on, and none until they are on one); the
   * colour flood and the turned arrow stay the pointer's own.
   */
  expanded?: boolean;
  /**
   * Whether an open card may fetch and play its footage: false until the
   * bento is near the screen, so a card opened by focus while it is still
   * off screen fetches nothing.
   */
  live?: boolean;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  /** A pointer is on the card, which keeps its footage running whatever `expanded` says. */
  const pointed = useRef(false);
  /** `expanded`, for the pointer's handlers, which must not close footage an open card is playing. */
  const expandedRef = useRef(expanded);
  /** Whether the footage should be running: a pending play or a pending rest checks it before acting. */
  const wanted = useRef(false);
  const glide = useRef(0);
  const park = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(
    () => () => {
      cancelAnimationFrame(glide.current);
      clearTimeout(park.current);
    },
    [],
  );

  /** Ease the footage's speed to `to` over `ms`, gently at both ends. */
  const ease = useCallback((el: HTMLVideoElement, to: number, ms: number) => {
    cancelAnimationFrame(glide.current);
    const from = el.playbackRate;
    const began = performance.now();
    const tick = (now: number) => {
      const k = Math.min(1, (now - began) / ms);
      setRate(el, from + (to - from) * k * k * (3 - 2 * k));
      if (k < 1) glide.current = requestAnimationFrame(tick);
    };
    glide.current = requestAnimationFrame(tick);
  }, []);

  /**
   * Start the footage, slowly (SLOW_RATE above).
   *
   * The rewind happens on the way OUT, not on the way in. Seeking to zero
   * before the first play means setting currentTime on an element whose
   * readyState is still HAVE_NOTHING, because preload is off until someone
   * hovers, and browsers disagree about what that does to the play() that
   * follows. Rewinding once it has gone puts the element back at the start
   * while it has data, so the next hover is a plain play() on a ready element.
   *
   * The speed eases up only once play() has resolved, which is when frames
   * are actually moving: a clip still buffering would otherwise be at full
   * speed by the time it showed anything. Coming back to a card whose
   * footage is still slowing on its way out picks it up where it is.
   */
  const start = useCallback(() => {
    const el = videoRef.current;
    if (!el) return;
    wanted.current = true;
    clearTimeout(park.current);
    const calm = !window.matchMedia(REDUCED_MOTION).matches;
    if (el.paused) setRate(el, calm ? SLOW_RATE : 1);
    // Autoplay policy allows this because the element is muted. The rejection
    // is still caught: a blocked play() is an unhandled promise rejection, and
    // the still underneath is a perfectly good fallback.
    void el
      .play()
      .then(() => {
        if (wanted.current && calm) ease(el, 1, RISE_MS);
      })
      .catch(() => {});
  }, [ease]);

  /** Slow it while it fades, then pause and rewind it, so the next start replays the push-in from the top. */
  const stop = useCallback(() => {
    const el = videoRef.current;
    if (!el) return;
    wanted.current = false;
    clearTimeout(park.current);
    if (el.paused) return;
    const rest = () => {
      cancelAnimationFrame(glide.current);
      el.pause();
      el.currentTime = 0;
    };
    if (window.matchMedia(REDUCED_MOTION).matches) {
      rest();
      return;
    }
    ease(el, SLOW_RATE, SETTLE_MS);
    park.current = setTimeout(() => {
      if (!wanted.current) rest();
    }, SETTLE_MS);
  }, [ease]);

  const enter = useCallback(() => {
    pointed.current = true;
    if (!interactive) return;
    start();
  }, [interactive, start]);

  const leave = useCallback(() => {
    pointed.current = false;
    if (expandedRef.current) return;
    stop();
  }, [stop]);

  // An open card plays its footage; one that closes puts it back at the start.
  useEffect(() => {
    expandedRef.current = expanded;
    if (expanded && live) start();
    else if (!pointed.current) stop();
  }, [expanded, live, start, stop]);

  return (
    <button
      type="button"
      tabIndex={tabIndex}
      onClick={onActivate}
      onMouseEnter={enter}
      onMouseLeave={leave}
      onFocus={enter}
      onBlur={leave}
      data-expanded={expanded ? "" : undefined}
      style={{ ["--flood" as string]: floodScale }}
      className={[
        "niche-card absolute inset-0 flex cursor-pointer flex-col justify-end",
        "isolate overflow-hidden rounded-lg text-left",
        compact && !expanded ? "p-4 sm:p-5" : "p-6",
        interactive ? "niche-card--ready group" : "",
      ].join(" ")}
    >
      {placeholder ? (
        <span aria-hidden className="niche-card__blur" style={{ backgroundImage: `url("${placeholder}")` }} />
      ) : null}

      <img
        src={still}
        alt=""
        loading="lazy"
        decoding="async"
        className="niche-card__still absolute inset-0 size-full object-cover"
      />

      {video && active ? (
        <video
          ref={videoRef}
          className="niche-card__video absolute inset-0 size-full object-cover"
          muted
          loop
          playsInline
          preload="metadata"
          poster={still}
          aria-hidden
          tabIndex={-1}
        >
          <source src={`${video}.webm`} type="video/webm" />
          <source src={`${video}.mp4`} type="video/mp4" />
        </video>
      ) : null}

      <span aria-hidden className="niche-card__flood" />

      {/* The arrow rides on top of the puck and never moves. */}
      <span
        aria-hidden
        className="niche-card__arrow pointer-events-none absolute top-5 right-5 grid size-11 place-items-center text-white [&_svg]:size-[18px]"
      >
        {ARROW}
      </span>

      <span aria-hidden className="niche-card__mask pointer-events-none absolute inset-0" />

      <span
        className={[
          "font-display relative block leading-[1.08] font-medium tracking-[-0.025em] text-white transition-[font-size] duration-slow ease-out",
          compact && !expanded ? "text-[19px] sm:text-[24px]" : "text-[26px] sm:text-[31.2px]",
        ].join(" ")}
      >
        {title}
      </span>

      {/*
        The description opens beneath the title rather than being reserved
        above it, so the title sits on the floor of the card at rest and lifts
        only as far as the copy needs.

        Animated with grid-template-rows 0fr to 1fr rather than a max-height
        guess: it interpolates smoothly to the copy's real height, so a longer
        line for one niche cannot get clipped by a cap chosen for another.
      */}
      <span
        aria-hidden={false}
        className="relative grid grid-rows-[0fr] transition-[grid-template-rows] duration-slow ease-out group-hover:grid-rows-[1fr] group-focus-visible:grid-rows-[1fr] group-data-[expanded]:grid-rows-[1fr]"
      >
        <span className="overflow-hidden">
          <span
            className={[
              "mt-2 block leading-[1.45] font-medium text-white/85 opacity-0 transition-opacity duration-base group-hover:opacity-100 group-focus-visible:opacity-100 group-data-[expanded]:opacity-100",
              compact && !expanded ? "text-[15.6px]" : "text-[16.2px]",
            ].join(" ")}
          >
            {body}
          </span>
        </span>
      </span>
    </button>
  );
}
