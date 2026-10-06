"use client";

import { useEffect, useRef, useState } from "react";

/**
 * The soul: the orb that stands in for the agent in each demo panel header.
 *
 * It replaced a chat-bubble glyph and a telephone glyph, which were two marks
 * for one thing. There is exactly one of these per panel and it lives in the
 * header, never in the thread: an orb inside a message bubble is a piece of
 * chrome pretending to be a message, and it moved the reader's eye to the wrong
 * place every time she started composing.
 *
 * ## It is always alive
 *
 * The heartbeat and the rotation run from first paint and never stop, whether
 * or not anybody has touched the panel. That is the point of it. A status light
 * that only lights up once you have interacted is a status light that tells
 * you nothing on arrival, which is the moment that matters.
 *
 * ## What changes is the tempo, and it is measured rather than guessed
 *
 * `beatMs` is the length of one heartbeat, and the two panels compute it from
 * what is actually happening:
 *
 *   chat   the rolling average gap between streamed chunks, so the orb races
 *          when the answer pours in and settles when it trickles
 *   voice  the current line's word count against the time it is on screen, so
 *          a dense sentence beats faster than a short one
 *
 * Neither is a decorative loop set to "fast". If the answer stalls, so does
 * the orb, which is more honest than a spinner and reads the same way.
 *
 * ## Four layers, because one element cannot hold two transforms
 *
 *   __aura    a flowing body around the sphere, breathing a beat behind it
 *   __beat    the heartbeat, scaling
 *   __orb     the artwork, rotating inside it
 *   __sheen   a fixed highlight, which does not move at all
 *
 * The beat and the sheen both carry `__edge`, the radial mask that fades the
 * sphere out before its own rim. Both, not one: masking the artwork and
 * leaving the highlight sharp draws a crisp ring over a soft ball.
 *
 * The sheen is what makes the rotation read as a sphere turning under a lamp
 * rather than as a picture being spun. Take it away and the whole thing looks
 * like a loading GIF.
 */

export type SoulMode = "idle" | "typing" | "voice";

const MODE_CLASS: Record<SoulMode, string> = {
  idle: "soul--idle",
  typing: "soul--typing",
  voice: "soul--voice",
};

/**
 * Two encodes of one clip, the same artwork played forward and back.
 *
 * `panel` is 384px and about 40KB, right for the demo headers. `hero` is
 * 640px, cut from the 2886px source the panel clip was made from, because the
 * orb plays at 1.35x its box: a 384px clip covers a box of about 140 CSS px
 * on a retina screen, and the hero's box is wider than that, where the panel
 * clip's compression blocking shows (the complaint in the 29 September
 * commit).
 *
 * The hero cut also fixes three things the panel clip still has. It runs at
 * the source's own 30fps, where dropping to 24 left every fourth step twice
 * the size. It starts four source frames later, past the end of the fade in
 * from white that made the panel loop pale for an instant each time round.
 * And it starts at its far turnaround, the fullest orb, so its first frame
 * is its poster and the swap from the still is seamless; the panel's poster
 * is that same full orb, but the panel clip opens on its palest frame.
 */
const CLIPS = {
  panel: {
    poster: "/brand/healdesk-soul.png",
    webm: "/brand/healdesk-soul.webm",
    mp4: "/brand/healdesk-soul.mp4",
  },
  hero: {
    poster: "/brand/healdesk-soul-hero.webp",
    webm: "/brand/healdesk-soul-hero.webm",
    mp4: "/brand/healdesk-soul-hero.mp4",
  },
} as const;

export function HealdeskSoul({
  mode = "idle",
  beatMs,
  size = 26,
  clip = "panel",
  paused = false,
  className = "",
  label,
}: {
  mode?: SoulMode;
  /**
   * One heartbeat, in milliseconds.
   *
   * Omitted in the idle state, where the CSS default is a calm resting rate.
   * Supplied while she is working, from whatever the panel can measure.
   */
  beatMs?: number;
  /**
   * Rendered size: a number of px, or any CSS length. The hero passes a
   * percentage of its orbit so the soul scales with the column. A length
   * leaves the aura's blur to the stylesheet (`--soul-aura-blur`), because a
   * blur cannot be a percentage.
   */
  size?: number | string;
  /** Which encode to play. See CLIPS. */
  clip?: keyof typeof CLIPS;
  /**
   * Hold the clip and every loop where they are, while the page has no use
   * for them: the hero's orbit rests its soul when it is scrolled out of view
   * (HeroOrbit.tsx). "Always alive" above means alive whenever it is seen.
   */
  paused?: boolean;
  className?: string;
  /**
   * What a screen reader should hear, if anything.
   *
   * Silent at rest: the heading beside it already says "Web chat" or "Phone
   * call", and an orb announcing itself as well is noise. It speaks up only
   * while she is composing or talking, which is a state nothing else on screen
   * reports now that the thread no longer shows a placeholder bubble.
   */
  label?: string;
}) {
  /**
   * Start on the still and swap to the clip after mount.
   *
   * Two reasons, and only one of them is reduced motion. The other is that the
   * server has no idea what the reader prefers, so rendering the <video> in
   * the markup would mean tearing it out again on hydration for anyone who
   * asked for less. The hero clip opens on its poster, so its swap is
   * invisible; the panel clip does not quite (see CLIPS).
   */
  const [still, setStill] = useState(true);

  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => setStill(query.matches);
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);

  /**
   * The CSS loops pause through the class; the clip has to be told. The
   * effect runs again when the clip mounts after hydration, so a reader who
   * paused before then does not get it starting behind their back.
   *
   * A browser that will not autoplay, as an iPhone in Low Power Mode will
   * not, leaves the clip on its first frame and draws its own play button
   * over it, which at hero size is a large dark disc on the orb. play()
   * rejects with NotAllowedError there, and the soul falls back to its still,
   * which has no button. Any other rejection, such as an aborted load, is
   * not a refusal and changes nothing.
   */
  const video = useRef<HTMLVideoElement>(null);
  const [refused, setRefused] = useState(false);

  useEffect(() => {
    const clipEl = video.current;
    if (!clipEl) return;
    if (paused) clipEl.pause();
    else
      clipEl.play().catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "NotAllowedError") setRefused(true);
      });
  }, [paused, still]);

  const media = CLIPS[clip];
  // The attributes only reserve space before the stylesheet arrives, and
  // they take pixels, so a CSS length leaves them to the stylesheet.
  const px = typeof size === "number" ? size : undefined;

  return (
    <span
      className={`soul ${MODE_CLASS[mode]} ${paused ? "soul--paused" : ""} ${className}`}
      style={{
        width: size,
        height: size,
        // Proportional, so the edge is equally soft at 26px and at 72px.
        ...(px === undefined
          ? {}
          : { ["--soul-aura-blur" as string]: `${Math.max(3, px * 0.16).toFixed(1)}px` }),
        ...(beatMs ? { ["--soul-beat" as string]: `${Math.round(beatMs)}ms` } : {}),
      }}
      role={label ? "status" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      {/* First in the markup so it paints under everything: `.soul` is a
          one-cell grid, so the stack is document order. */}
      <span className="soul__aura" />

      {/* The ring only the voice state makes visible. Always mounted, so
          changing state never adds a node mid-animation. */}
      <span className="soul__ring" />

      <span className="soul__beat soul__edge">
        {still || refused ? (
          <img
            src={media.poster}
            alt=""
            width={px}
            height={px}
            decoding="async"
            className="soul__orb"
          />
        ) : (
          <video
            ref={video}
            className="soul__orb"
            width={px}
            height={px}
            autoPlay
            muted
            loop
            playsInline
            preload="auto"
            poster={media.poster}
            aria-hidden
            tabIndex={-1}
          >
            <source src={media.webm} type="video/webm" />
            <source src={media.mp4} type="video/mp4" />
          </video>
        )}
      </span>

      <span className="soul__sheen soul__edge" />
    </span>
  );
}
