import React from "react";
import { interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";

import { easeEnter, easeExit, SNAP } from "./tokens";

/**
 * Every scene is laid out on a logical stage, then scaled to the frame:
 * 1080 × 1500 for the tall cuts (9:16 and 4:5) and 1920 × 1080 for 16:9.
 * The tall stage is the script's centre safe area plus a margin, so the
 * 4:5 cut is a reframe of the 9:16 one rather than a redesign.
 */
export type Layout = { wide: boolean; W: number; H: number; scale: number; left: number; top: number };

export function useLayout(): Layout {
  const { width, height } = useVideoConfig();
  const wide = width > height;
  const W = wide ? 1920 : 1080;
  const H = wide ? 1080 : 1500;
  const scale = Math.min(width / W, height / H);
  const left = (width - W * scale) / 2;
  // In 9:16 the platform's own buttons cover the bottom 280 px, so the stage
  // sits higher than centre there.
  const spare = height - H * scale;
  const top = !wide && height / width > 1.7 ? Math.min(spare / 2, 150) : spare / 2;
  return { wide, W, H, scale, left, top };
}

/** The scaled stage. Children are positioned in stage coordinates. */
export const Stage: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { W, H, scale, left, top } = useLayout();
  return (
    <div
      style={{
        position: "absolute",
        left,
        top,
        width: W,
        height: H,
        transform: `scale(${scale})`,
        transformOrigin: "0 0",
      }}
    >
      {children}
    </div>
  );
};

/**
 * Scene time. A scene inside <Speed value={0.75}> plays at three quarters
 * speed: everything it animates, springs included, reads this instead of
 * Remotion's frame, so one number slows the whole scene without retiming it.
 * Outside a <Speed>, it is the frame.
 */
const SpeedContext = React.createContext(1);

export const Speed: React.FC<{ value: number; children: React.ReactNode }> = ({ value, children }) => (
  <SpeedContext.Provider value={value}>{children}</SpeedContext.Provider>
);

export function useFrame(): number {
  return useCurrentFrame() * React.useContext(SpeedContext);
}

/** A snap spring (overshoot ~6%) from 0 to 1, starting at `at`. */
export function useSnap(at: number): number {
  const frame = useFrame();
  const { fps } = useVideoConfig();
  return spring({ frame: frame - at, fps, config: SNAP });
}

/** The house enter: 0 → 1 over `dur` frames on the enter curve. */
export function enter(frame: number, at: number, dur = 15): number {
  return interpolate(frame, [at, at + dur], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: easeEnter,
  });
}

/** The house exit: 1 → 0 over `dur` frames on the exit curve. */
export function exit(frame: number, at: number, dur = 9): number {
  return interpolate(frame, [at, at + dur], [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: easeExit,
  });
}

/** Opacity, a 24 px rise and a 0.96 → 1 scale, driven by a 0..1 progress. */
export function enterStyle(p: number, distance = 24): React.CSSProperties {
  return {
    opacity: Math.min(1, Math.max(0, p)),
    transform: `translateY(${(1 - p) * distance}px) scale(${0.96 + 0.04 * p})`,
  };
}

/** Idle breathing, so nothing sits still for more than a second. */
export function breathe(frame: number, phase = 0): number {
  return 1 + 0.01 * Math.sin(((frame + phase) / 60) * Math.PI * 2);
}

export function drift(frame: number, phase = 0, amount = 4): number {
  return Math.sin(((frame + phase) / 90) * Math.PI * 2) * amount;
}

export function lerp(frame: number, input: number[], output: number[], ease = easeEnter): number {
  return interpolate(frame, input, output, { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: ease });
}

/**
 * A scene's camera, the After Effects way: it pushes in slowly through the
 * whole scene, arrives out of a blur, and leaves into one, scaled past the
 * lens, so cuts read as one continuous move.
 */
export const Shell: React.FC<{ duration: number; children: React.ReactNode; push?: number; enterBlur?: boolean; exitBlur?: boolean }> = ({
  duration,
  children,
  push = 0.04,
  enterBlur = true,
  exitBlur = true,
}) => {
  const frame = useFrame();
  const inP = enterBlur ? interpolate(frame, [0, 10], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: easeEnter }) : 1;
  const outP = exitBlur ? interpolate(frame, [duration - 9, duration], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: easeExit }) : 0;
  const scale = 1 + push * (frame / duration) + (1 - inP) * -0.06 + outP * 0.12;
  const blur = (1 - inP) * 14 + outP * 18;
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        transform: `scale(${scale})`,
        filter: blur > 0.2 ? `blur(${blur}px)` : undefined,
        opacity: Math.min(inP * 1.2, 1 - outP * 0.9),
      }}
    >
      {children}
    </div>
  );
};

/** A 3D tilt for a UI panel: it swings in from `from` degrees and then floats. */
export function tilt(frame: number, at: number, from = 18, phase = 0): React.CSSProperties {
  const p = interpolate(frame, [at, at + 20], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: easeEnter });
  const rx = (1 - p) * from + Math.sin((frame + phase) / 40) * 2.2;
  const ry = (1 - p) * -from * 0.6 + Math.cos((frame + phase) / 50) * 2.8;
  return { transform: `perspective(1800px) rotateX(${rx}deg) rotateY(${ry}deg) translateY(${(1 - p) * 60}px)`, opacity: Math.min(1, p * 1.4) };
}
