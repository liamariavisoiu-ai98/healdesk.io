import React from "react";
import { interpolate, useCurrentFrame, useVideoConfig } from "remotion";

import { easeOut } from "./brand";

/**
 * Every shot is laid out on a stage, then scaled to the frame: 1080 × 1500
 * for the tall cuts (9:16 and 4:5) and 1920 × 1080 for 16:9. In 9:16 the
 * stage sits 150 px down, so its edges keep text clear of the platforms' own
 * header and of the captions and buttons they lay over the bottom of a Reel
 * or a TikTok; the 4:5 cut is the same stage, scaled to fit.
 */
export function useLayout() {
  const { width, height } = useVideoConfig();
  const wide = width > height;
  const W = wide ? 1920 : 1080;
  const H = wide ? 1080 : 1500;
  const scale = Math.min(width / W, height / H);
  const left = (width - W * scale) / 2;
  const spare = height - H * scale;
  const top = !wide && height / width > 1.7 ? Math.min(spare / 2, 150) : spare / 2;
  return {
    wide,
    W,
    H,
    scale,
    left,
    top,
    /** The frame's top and bottom edges in stage coordinates (beyond the stage in 9:16). */
    frameTop: -top / scale,
    frameBottom: (height - top) / scale,
  };
}

/** The scaled stage. Children are positioned in stage coordinates. */
export const Stage: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { W, H, scale, left, top } = useLayout();
  return <div style={{ position: "absolute", left, top, width: W, height: H, transform: `scale(${scale})`, transformOrigin: "0 0" }}>{children}</div>;
};

/** 0 → 1 between two frames on the ease-out curve. */
export const ease = (frame: number, from: number, to: number) =>
  interpolate(frame, [from, to], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: easeOut });

/**
 * A line rising out of a mask, the way Apple sets a title. The mask reaches
 * below the line for descenders, and the line starts far enough below it
 * that not a pixel of a glyph shows before it moves. A negative `at` starts
 * the move before the cut, so the shot opens on a line already in motion.
 */
export const Reveal: React.FC<{ at: number; dur?: number; children: React.ReactNode }> = ({ at, dur = 14, children }) => {
  const p = ease(useCurrentFrame(), at, at + dur);
  return (
    <div style={{ overflow: "hidden", paddingBottom: "0.22em", marginBottom: "-0.22em" }}>
      <div style={{ transform: `translateY(calc(${(1 - p) * 100}% + ${(1 - p) * 0.35}em))` }}>{children}</div>
    </div>
  );
};

/** A block rising into place: it fades in over the first quarter of the move, then only its position changes. */
export function settle(frame: number, at: number, dur = 16, distance = 40): React.CSSProperties {
  const p = ease(frame, at, at + dur);
  return { transform: `translateY(${(1 - p) * distance}px)`, opacity: Math.min(1, 0.001 + p * 4) };
}

/** A slow push-in over the whole shot, so no frame is ever still. */
export const Push: React.FC<{ length: number; amount?: number; origin?: string; hold?: number; children: React.ReactNode }> = ({
  length,
  amount = 0.04,
  origin = "50% 45%",
  hold,
  children,
}) => {
  const frame = Math.min(useCurrentFrame(), hold ?? Infinity);
  const scale = 1 + amount * Math.min(1, frame / length);
  return <div style={{ position: "absolute", inset: 0, transform: `scale(${scale})`, transformOrigin: origin }}>{children}</div>;
};
