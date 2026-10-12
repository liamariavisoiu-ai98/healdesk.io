"use client";

import { useEffect, useRef, useState } from "react";

import { REDUCED_MOTION, useMediaQuery } from "@/lib/use-media-query";

/**
 * AYA's face on the voice card, in the place a phone icon would be, looking
 * at the visitor and showing where the call is.
 *
 * ## Her own frames, a clip when there is one, the hero photo until then
 *
 * The face is built from her front-facing render frames in public/hero-frames-2
 * (g_19 to g_21, the render the personalised demo was made with): it rests on
 * the one looking straight at you and now and then drifts to a neighbour, the
 * small head movements a person makes while listening, with slow breathing
 * under it. That set has no usable blink (its "blink" frames roll the eyes
 * up), so this version does not blink; a looping clip adds it, once one is
 * published at CLIP below.
 *
 * The frames were never committed with the demo that first used them; the
 * owner is adding them to main (9 October 2026). Until they are there, and
 * whenever one fails to load, the face is a round crop of the homepage's hero
 * photograph of her, so the card never shows a broken image. Which one shows
 * is decided in the browser, from the image itself, because a server check of
 * public/ is unreliable: on Vercel the static files are served from the CDN
 * and are not in the function's filesystem.
 *
 * ## The call, choreographed (the owner's M2, 9 October 2026)
 *
 *   - idle: breathing, and the glances above.
 *   - connecting: a light sweeps across her, again and again, until it answers.
 *   - listening: live, and she is quiet, so it is the caller's turn. A cool
 *     tint and two slow ripples.
 *   - speaking: live, and she is talking. The ring swells with the loudness
 *     of her voice (`level`, 0 to 1, from the call's audio).
 *
 * Visitors who ask for less motion get the same states without the movement.
 */

export type CallVisualState = "idle" | "connecting" | "listening" | "speaking";

const FRAMES = ["/hero-frames-2/g_20.webp", "/hero-frames-2/g_19.webp", "/hero-frames-2/g_21.webp"] as const;
const REST = 0;
/** Her looping clip, once one is published (eyes on camera, natural blinks, a slight smile). */
const CLIP: string | null = null;
/** The hero photograph, cropped round her face: 200% wide puts her face across the circle. */
const FALLBACK = "/brand/aya-hero.webp";

export function AyaPortrait({
  size = 132,
  level = 0,
  state = "idle",
}: {
  size?: number;
  level?: number;
  state?: CallVisualState;
}) {
  const [frame, setFrame] = useState(REST);
  const [fallback, setFallback] = useState(false);
  const restRef = useRef<HTMLImageElement>(null);
  const reduce = useMediaQuery(REDUCED_MOTION);

  // An image that failed before the page hydrated fired its error event with
  // no handler attached yet, so ask it directly once we are listening.
  useEffect(() => {
    const img = restRef.current;
    if (img && img.complete && img.naturalWidth === 0) setFallback(true);
  }, []);

  useEffect(() => {
    if (CLIP || fallback || reduce) return;
    // Mostly at rest, looking at you; a glance-sized drift every few seconds.
    const timer = window.setTimeout(
      () => setFrame((current) => (current === REST ? 1 + Math.floor(Math.random() * 2) : REST)),
      frame === REST ? 2_800 + Math.random() * 3_200 : 900 + Math.random() * 900,
    );
    return () => window.clearTimeout(timer);
  }, [fallback, frame, reduce]);

  const speaking = state === "speaking";
  const swell = speaking && !reduce ? 1 + Math.min(1, level) * 0.35 : 1;

  return (
    <div
      className="aya-portrait relative grid place-items-center"
      data-state={state}
      style={{ width: size + 28, height: size + 28 }}
    >
      {/* The halo: her colour while she speaks, cool while she listens. */}
      <span
        aria-hidden
        className="aya-halo absolute inset-0 rounded-full transition-[transform,opacity,background-color] duration-150"
        style={{ transform: `scale(${swell})` }}
      />
      <span aria-hidden className="aya-ripple absolute inset-[14px] rounded-full" />
      <span aria-hidden className="aya-ripple aya-ripple--late absolute inset-[14px] rounded-full" />

      <div
        className="aya-breathe relative overflow-hidden rounded-full bg-white shadow-[0_8px_30px_-8px_rgb(23_42_58/0.35)] ring-4 ring-white"
        style={{ width: size, height: size }}
      >
        {CLIP ? (
          <video
            src={CLIP}
            poster={FRAMES[REST]}
            autoPlay
            muted
            loop
            playsInline
            aria-label="AYA, the AI assistant"
            className="size-full object-cover"
            style={{ objectPosition: "50% 30%" }}
          />
        ) : fallback ? (
          <span
            role="img"
            aria-label="AYA, the AI assistant"
            className="absolute inset-0"
            style={{ backgroundImage: `url(${FALLBACK})`, backgroundSize: "200% auto", backgroundPosition: "51.6% 0%" }}
          />
        ) : (
          FRAMES.map((src, i) => (
            <img
              key={src}
              ref={i === REST ? restRef : undefined}
              src={src}
              alt={i === REST ? "AYA, the AI assistant" : ""}
              aria-hidden={i !== REST}
              onError={() => setFallback(true)}
              className="absolute inset-0 size-full object-cover transition-opacity duration-[900ms] ease-in-out"
              style={{ objectPosition: "50% 30%", opacity: frame === i ? 1 : 0 }}
            />
          ))
        )}
        {/* Connecting: a light passing across her. */}
        <span aria-hidden className="aya-sweep pointer-events-none absolute inset-0" />
        {/* Listening: the cool tint over her. */}
        <span aria-hidden className="aya-cool pointer-events-none absolute inset-0" />
      </div>
    </div>
  );
}
