"use client";

import { useEffect, useRef, useState } from "react";
import { useAnimationFrame, useInView } from "motion/react";

import metaA from "../../public/hero-video/video.json";
import metaB from "../../public/hero-video-2/video.json";
import { useGazeRig } from "@/lib/useGazeRig";
import { usePointerField, type TiltControl } from "@/lib/usePointerField";

/**
 * The scrubbed renderer: gaze is a position in a re-ordered video.
 *
 * The frame-grid version quantised. Nine columns across a wide viewport is one
 * snap per ~160px of cursor travel, and smoothing upstream cannot hide it,
 * the renderer throws the smooth value away when it picks a cell. Going finer
 * as stills is not possible either: each decoded frame costs w x h x 4 bytes,
 * so a hundred of them is hundreds of megabytes of bitmap.
 *
 * A video solves both. The browser decodes on demand and manages the memory,
 * and every frame is an available gaze position, 133 here rather than 9. The
 * clip is re-encoded in gaze order by build-hero-video.py, so time in it *is*
 * gaze, and this only has to multiply.
 *
 * ## Seeks are coalesced, never queued
 *
 * `currentTime` is asynchronous. Assigning it every animation frame stacks
 * seeks the decoder cannot retire, and the picture falls behind the cursor and
 * then lurches to catch up, which looks far worse than a slightly stale
 * frame. So there is at most one seek in flight; the newest target replaces any
 * waiting one, and stale intermediate positions are simply dropped.
 */

/** Each entry is a clip already re-encoded in gaze order by
 *  build-hero-video.py, with its own framing and aspect. */
const SOURCES = {
  a: { meta: metaA, base: "/hero-video/" },
  b: { meta: metaB, base: "/hero-video-2/" },
} as const;

export type HeroVideoVariant = keyof typeof SOURCES;

export function HeroVideo({
  className = "",
  variant = "a",
  onTiltAvailable,
}: {
  className?: string;
  variant?: HeroVideoVariant;
  onTiltAvailable?: (tilt: TiltControl) => void;
}) {
  const { meta, base } = SOURCES[variant];
  const { src, frames, fps, width, height } = meta;
  const SRC = `${base}${src}`;
  // Ignore differences smaller than half a frame, below that a seek is a
  // no-op that still costs a decode.
  const EPSILON = 0.5 / fps;
  const stageRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const inView = useInView(stageRef, { margin: "150px" });
  const field = usePointerField(stageRef);
  // No gaze break here. The periodic look-away is only affordable for a renderer
  // that can hide both its onset and its return behind a blink painted over the
  // whole canvas, and this one has no blink frames at all. It reads gaze and head
  // and seeks a video. Left on, the break plays unmasked: she slides 0.34-0.50 to
  // one side, holds it for a second or more, and comes back, with nothing covering
  // either end and no cause the viewer can see.
  const { gazeX, headX } = useGazeRig(field, inView, {
    idleMotion: false,
    follow: "smooth",
    gazeBreak: false,
  });
  const [ready, setReady] = useState(false);

  const seeking = useRef(false);
  const pending = useRef<number | null>(null);

  useEffect(() => {
    onTiltAvailable?.(field.tilt);
  }, [field.tilt, onTiltAvailable]);

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;

    const onSeeked = () => {
      seeking.current = false;
      // Only the newest target matters; anything queued behind it is stale.
      if (pending.current !== null) {
        const t = pending.current;
        pending.current = null;
        seeking.current = true;
        v.currentTime = t;
      }
    };
    const onReady = () => {
      // Paused explicitly and on every state change. The element is a frame
      // store, not a movie: if anything ever starts it playing it walks the
      // whole gaze sequence on its own, which reads as her moving with no
      // cursor input at all.
      v.pause();
      // Park on the middle of the range so the first paint is her looking
      // straight ahead rather than at whichever extreme sorted first.
      v.currentTime = (Math.floor(frames / 2) + 0.5) / fps;
      setReady(true);
    };

    const keepPaused = () => v.pause();
    v.addEventListener("seeked", onSeeked);
    v.addEventListener("loadeddata", onReady);
    v.addEventListener("play", keepPaused);
    if (v.readyState >= 2) onReady();
    return () => {
      v.removeEventListener("seeked", onSeeked);
      v.removeEventListener("loadeddata", onReady);
      v.removeEventListener("play", keepPaused);
    };
  }, [frames, fps, SRC]);

  useAnimationFrame(() => {
    const v = videoRef.current;
    if (!v || !ready || !inView || field.reduced) return;

    // The head carries most of the visible turn and the eyes add the rest.
    const x = Math.max(-1, Math.min(1, headX.get() * 0.7 + gazeX.get() * 0.3));
    const index = Math.round(((x + 1) / 2) * (frames - 1));
    const t = (index + 0.5) / fps;

    if (Math.abs(v.currentTime - t) < EPSILON) return;
    if (seeking.current) {
      pending.current = t;
      return;
    }
    seeking.current = true;
    v.currentTime = t;
  });

  return (
    <div
      ref={stageRef}
      className={`relative select-none ${className}`}
      style={{ aspectRatio: `${width} / ${height}` }}
      role="img"
      aria-label="A receptionist looking towards you"
    >
      <video
        ref={videoRef}
        src={SRC}
        // Never played, only seeked. muted + playsInline keep mobile browsers
        // from treating it as media that needs a gesture, and preload="auto"
        // matters more than usual: an unbuffered region means a seek has to
        // fetch before it can decode.
        muted
        playsInline
        preload="auto"
        disablePictureInPicture
        aria-hidden
        className="absolute inset-0 h-full w-full object-cover"
        style={{ opacity: ready ? 1 : 0, transition: "opacity 200ms linear" }}
      />
    </div>
  );
}
