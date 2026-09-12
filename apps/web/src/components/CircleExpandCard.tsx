"use client";

import { useCallback, useRef } from "react";

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
 *   still   the poster frame, always painted
 *   video   cross-fades in on hover and plays; identical crop to the still, so
 *           the handoff reveals nothing
 *   flood   the icon's own circle, scaled up to cover the tile, 72% red
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

export function CircleExpandCard({
  title,
  body,
  still,
  video,
  onActivate,
  tabIndex,
  active = true,
  interactive = true,
}: {
  title: string;
  body: string;
  /** Poster frame. Must be the same crop as the video's first frame. */
  still: string;
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
}) {
  const videoRef = useRef<HTMLVideoElement>(null);

  /**
   * Start the footage.
   *
   * The rewind happens on the way OUT, not on the way in. Seeking to zero
   * before the first play means setting currentTime on an element whose
   * readyState is still HAVE_NOTHING, because preload is off until someone
   * hovers, and browsers disagree about what that does to the play() that
   * follows. Rewinding on leave puts the element back at the start while it
   * has data, so the next hover is a plain play() on a ready element.
   */
  const enter = useCallback(() => {
    if (!interactive) return;
    // Autoplay policy allows this because the element is muted. The rejection
    // is still caught: a blocked play() is an unhandled promise rejection, and
    // the still underneath is a perfectly good fallback.
    void videoRef.current?.play().catch(() => {});
  }, [interactive]);

  const leave = useCallback(() => {
    const el = videoRef.current;
    if (!el) return;
    el.pause();
    // Back to the top, so the next hover replays the push-in from the start
    // rather than picking it up halfway.
    el.currentTime = 0;
  }, []);

  return (
    <button
      type="button"
      tabIndex={tabIndex}
      onClick={onActivate}
      onMouseEnter={enter}
      onMouseLeave={leave}
      onFocus={enter}
      onBlur={leave}
      style={{ ["--flood" as string]: FLOOD_SCALE }}
      className={[
        "niche-card absolute inset-0 flex cursor-pointer flex-col justify-end",
        "isolate overflow-hidden rounded-[24px] p-6 text-left",
        interactive ? "niche-card--ready group" : "",
      ].join(" ")}
    >
      <img
        src={still}
        alt=""
        loading="lazy"
        decoding="async"
        className="absolute inset-0 size-full object-cover"
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

      <span className="font-display relative block text-[31.2px] leading-[1.08] font-medium tracking-[-0.025em] text-white">
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
        className="relative grid grid-rows-[0fr] transition-[grid-template-rows] duration-[450ms] ease-panel group-hover:grid-rows-[1fr] group-focus-visible:grid-rows-[1fr]"
      >
        <span className="overflow-hidden">
          <span className="mt-2 block text-[16.2px] leading-[1.45] font-medium text-white/85 opacity-0 transition-opacity duration-300 group-hover:opacity-100 group-focus-visible:opacity-100">
            {body}
          </span>
        </span>
      </span>
    </button>
  );
}
