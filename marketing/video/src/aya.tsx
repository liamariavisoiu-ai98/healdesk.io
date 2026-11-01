import React from "react";
import { Img, OffthreadVideo, Sequence, staticFile } from "remotion";

import { useFrame } from "./motion";

// The brand clip is 79 frames at 24 fps: a smile, a hand rising, then a thumb
// pointing to her right (the viewer's left). At 30 fps it lasts 99 frames.
const CLIP_FRAMES_30 = 99;
// The cut-out keeps the right 1440 × 1080 of the 1920 × 1080 clip; in it her
// face sits at these fractions of the width and height.
const ASPECT = 1080 / 1440;
const FACE_X = 0.547;

/**
 * Aya, the real person from healdesk's site, cut cleanly out of her own
 * footage, frame by frame (aya-cut.webm carries an alpha channel), so she
 * stands in the ad's white with no box, oval or studio haze. She stands on
 * `bottom`, normally the frame's own bottom edge, so where the footage ends
 * is never seen. Plays from `from` seconds at `rate`, then holds her last
 * frame.
 */
export const AyaFigure: React.FC<{ width: number; faceX: number; bottom: number; from?: number; rate?: number }> = ({ width, faceX, bottom, from = 0, rate = 1 }) => {
  const frame = useFrame();
  const height = width * ASPECT;
  const plays = (CLIP_FRAMES_30 - from * 30) / rate;
  const left = faceX - width * FACE_X;
  return (
    <div style={{ position: "absolute", left, top: bottom - height, width, height }}>
      {/* A soft contact shadow where she meets the floor of the frame. */}
      <div style={{ position: "absolute", left: "18%", right: "8%", bottom: -40, height: 120, borderRadius: "50%", background: "radial-gradient(ellipse, rgba(0,0,0,0.10) 0%, rgba(0,0,0,0) 70%)" }} />
      {frame < plays - 1 ? (
        <Sequence layout="none">
          <OffthreadVideo src={staticFile("aya-cut.webm")} transparent startFrom={Math.round(from * 30)} playbackRate={rate} muted style={{ width, height, display: "block", position: "relative" }} />
        </Sequence>
      ) : (
        <Img src={staticFile("aya-cut-end.webp")} style={{ width, height, display: "block", position: "relative" }} />
      )}
    </div>
  );
};

/** Aya's face in a circle, from her portrait, for the interface. */
export const AyaAvatar: React.FC<{ size: number; ring?: boolean; style?: React.CSSProperties }> = ({ size, ring = false, style }) => (
  <div
    style={{
      width: size,
      height: size,
      borderRadius: "50%",
      overflow: "hidden",
      flexShrink: 0,
      boxShadow: ring ? `0 0 0 ${size * 0.05}px #fff, 0 0 0 ${size * 0.09}px #FF761E` : "0 4px 14px rgba(0,0,0,0.12)",
      ...style,
    }}
  >
    <Img src={staticFile("aya.webp")} style={{ width: "200%", height: "auto", marginLeft: "-50%" }} />
  </div>
);
