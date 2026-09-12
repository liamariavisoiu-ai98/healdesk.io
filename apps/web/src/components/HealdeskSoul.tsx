"use client";

import { useEffect, useState } from "react";

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

export function HealdeskSoul({
  mode = "idle",
  beatMs,
  size = 26,
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
  /** Rendered size in px. The asset is 160, so anything up to 80 is crisp. */
  size?: number;
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
   * asked for less. The poster is what the video would show anyway, so the
   * swap is invisible.
   */
  const [still, setStill] = useState(true);

  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => setStill(query.matches);
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);

  return (
    <span
      className={`soul ${MODE_CLASS[mode]} ${className}`}
      style={{
        width: size,
        height: size,
        // Proportional, so the edge is equally soft at 26px and at 72px.
        ["--soul-aura-blur" as string]: `${Math.max(3, size * 0.16).toFixed(1)}px`,
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
        {still ? (
          <img
            src="/brand/healdesk-soul.png"
            alt=""
            width={size}
            height={size}
            decoding="async"
            className="soul__orb"
          />
        ) : (
          <video
            className="soul__orb"
            width={size}
            height={size}
            autoPlay
            muted
            loop
            playsInline
            preload="auto"
            poster="/brand/healdesk-soul.png"
            aria-hidden
            tabIndex={-1}
          >
            <source src="/brand/healdesk-soul.webm" type="video/webm" />
            <source src="/brand/healdesk-soul.mp4" type="video/mp4" />
          </video>
        )}
      </span>

      <span className="soul__sheen soul__edge" />
    </span>
  );
}
