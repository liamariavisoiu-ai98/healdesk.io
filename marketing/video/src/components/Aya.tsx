import React from "react";
import { Img, OffthreadVideo, staticFile, useCurrentFrame } from "remotion";

/**
 * Where things are in the cut-out (public/aya-cut.webm): the right 1440 × 1080
 * of Aya's brand clip, 79 frames at 24 fps, with an alpha channel. She smiles,
 * then raises her hand and points with her thumb to the viewer's left. As
 * fractions of the clip's width and height, measured on its frames: her face
 * (between the eyes and the mouth), and the tip of her thumb at its highest.
 * Her hair runs off the top of the footage and her body off the bottom.
 */
export const AYA = { aspect: 1080 / 1440, faceX: 0.65, faceY: 0.38, thumbX: 0.17 } as const;
/** The clip's length in frames at 30 fps. */
const CLIP_FRAMES = (79 / 24) * 30;

/**
 * Aya, the real person from healdesk's site, cut out of her own footage, so
 * she stands in the white with no box or studio haze. The clip is slowed by
 * at most a few percent to fill `length` frames exactly, so she is moving on
 * the shot's last frame and never freezes. Where her hair meets the top of
 * the footage, either the frame's own edge hides it or `fadeTop` dissolves it
 * into the white.
 */
export const Aya: React.FC<{ left: number; top: number; width: number; length: number; fadeTop?: boolean }> = ({ left, top, width, length, fadeTop = false }) => {
  const frame = useCurrentFrame();
  const height = width * AYA.aspect;
  const rate = Math.min(1, CLIP_FRAMES / length);
  const mask = fadeTop ? "linear-gradient(to bottom, transparent 0%, rgba(0,0,0,0.35) 5%, #000 13%)" : undefined;
  return (
    <div style={{ position: "absolute", left, top, width, height, WebkitMaskImage: mask, maskImage: mask }}>
      {(frame + 1) * rate < CLIP_FRAMES ? (
        <OffthreadVideo src={staticFile("aya-cut.webm")} transparent muted playbackRate={rate} style={{ width, height, display: "block" }} />
      ) : (
        <Img src={staticFile("aya-cut-end.webp")} style={{ width, height, display: "block" }} />
      )}
    </div>
  );
};
