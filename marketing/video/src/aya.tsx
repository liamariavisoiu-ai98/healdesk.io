import React from "react";
import { Img, OffthreadVideo, Sequence, staticFile } from "remotion";

import { useFrame } from "./motion";

// The brand clip is 79 frames at 24 fps: a smile, a hand rising, then a thumb
// pointing to her right (the viewer's left). At 30 fps it lasts 99 frames.
const CLIP_FRAMES_30 = 99;

/**
 * Aya, the real person from healdesk's site, in her own footage. The clip is
 * shot on white, so multiplied over the ad's pure white its ground vanishes
 * and only she remains; an oval mask hides the frame's edges. Plays from
 * `from` seconds at `rate`, then holds on her last frame.
 *
 * Nothing above this may blur or fade as a group: that would isolate the
 * clip and its white ground would show.
 */
export const AyaFilm: React.FC<{ width: number; left: number; top: number; from?: number; rate?: number; push?: number }> = ({
  width,
  left,
  top,
  from = 0,
  rate = 1,
  push = 0.04,
}) => {
  const frame = useFrame();
  const plays = (CLIP_FRAMES_30 - from * 30) / rate;
  const scale = 1 + push * Math.min(1, frame / 150);
  const mask = "radial-gradient(ellipse 33% 50% at 66% 44%, #000 64%, transparent 100%)";
  return (
    <div
      style={{
        position: "absolute",
        left,
        top,
        width,
        transform: `scale(${scale})`,
        transformOrigin: "66% 40%",
        WebkitMaskImage: mask,
        maskImage: mask,
        mixBlendMode: "multiply",
      }}
    >
      {frame < plays - 1 ? (
        <Sequence layout="none">
          <OffthreadVideo src={staticFile("aya-clip.mp4")} startFrom={Math.round(from * 30)} playbackRate={rate} muted style={{ width, display: "block" }} />
        </Sequence>
      ) : (
        <Img src={staticFile("aya-clip-end.webp")} style={{ width, display: "block" }} />
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
