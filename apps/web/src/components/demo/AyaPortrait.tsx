"use client";

import { useEffect, useState } from "react";

/**
 * AYA's face on the voice panel, looking at the visitor.
 *
 * ## A living loop when there is one, her own frames until then
 *
 * With `videoSrc` (a short looping clip: eyes on camera, natural blinks, a
 * slight professional smile) the portrait plays it, muted and inline. Without
 * one it is built from her front-facing frames in public/hero-frames-2
 * (g_19 to g_21, the same render as the homepage's AYA): it rests on the one
 * looking straight at you and now and then drifts to a neighbour, the small
 * head movements a person makes while listening, with slow breathing under
 * it. That set has no usable blink (the "blink" frames roll the eyes up),
 * so this version does not blink; the clip is what adds it.
 *
 * During a call `level` (0 to 1, from the call's audio) swells the ring, so
 * she visibly speaks. Motion is dropped for visitors who ask for less.
 */

const FRAMES = ["/hero-frames-2/g_20.webp", "/hero-frames-2/g_19.webp", "/hero-frames-2/g_21.webp"] as const;
const REST = 0;

export function AyaPortrait({
  size = 132,
  level = 0,
  live = false,
  videoSrc = null,
}: {
  size?: number;
  level?: number;
  live?: boolean;
  videoSrc?: string | null;
}) {
  const [frame, setFrame] = useState(REST);

  useEffect(() => {
    if (videoSrc) return;
    if (typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let timer: number;
    const schedule = () => {
      // Mostly at rest, looking at you; a glance-sized drift every few seconds.
      timer = window.setTimeout(() => {
        setFrame((current) => (current === REST ? 1 + Math.floor(Math.random() * 2) : REST));
        schedule();
      }, frame === REST ? 2_800 + Math.random() * 3_200 : 900 + Math.random() * 900);
    };
    schedule();
    return () => window.clearTimeout(timer);
  }, [frame, videoSrc]);

  return (
    <div className="relative grid place-items-center" style={{ width: size + 28, height: size + 28 }}>
      <span
        aria-hidden
        className="absolute inset-0 rounded-full transition-transform duration-100"
        style={{
          background: "var(--clinic)",
          opacity: live ? 0.22 : 0.1,
          transform: `scale(${1 + (live ? level * 0.35 : 0)})`,
        }}
      />
      <div
        className="aya-breathe relative overflow-hidden rounded-full bg-white shadow-[0_8px_30px_-8px_rgb(23_42_58/0.35)] ring-4 ring-white"
        style={{ width: size, height: size }}
      >
        {videoSrc ? (
          <video
            src={videoSrc}
            poster={FRAMES[REST]}
            autoPlay
            muted
            loop
            playsInline
            aria-label="AYA, the AI assistant"
            className="size-full object-cover"
            style={{ objectPosition: "50% 30%" }}
          />
        ) : (
          FRAMES.map((src, i) => (
            <img
              key={src}
              src={src}
              alt={i === REST ? "AYA, the AI assistant" : ""}
              aria-hidden={i !== REST}
              className="absolute inset-0 size-full object-cover transition-opacity duration-[900ms] ease-in-out"
              style={{ objectPosition: "50% 30%", opacity: frame === i ? 1 : 0 }}
            />
          ))
        )}
      </div>
      <style>{`
        @keyframes aya-breathe { 0%, 100% { transform: scale(1); } 50% { transform: scale(1.012) translateY(-0.5px); } }
        .aya-breathe { animation: aya-breathe 4.6s ease-in-out infinite; }
        @media (prefers-reduced-motion: reduce) { .aya-breathe { animation: none; } }
      `}</style>
    </div>
  );
}
