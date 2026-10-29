import React from "react";
import { AbsoluteFill, Img, OffthreadVideo, Sequence, staticFile, useCurrentFrame } from "remotion";

import { drift, enter, enterStyle, lerp, Shell, Stage, useLayout, useSnap } from "../motion";
import { Backdrop, Kinetic, Orb, Pill } from "../parts";
import { c, font } from "../tokens";

const CLIP_FROM = 6;
const CLIP_FRAMES = 99;
const END_CARD = 140;

/**
 * Scene 7, "The dare", 900–1080 (180 frames). The only time AYA's face is
 * shown: her own brand clip, multiplied over the ivory so its white ground
 * drops away. Then an arrow to the link, and the end card, where the orb
 * that stood for her all along sits over the healdesk wordmark.
 *
 * No blur on the way in: a blurred or faded group isolates the clip, and its
 * white ground would flash before the multiply takes.
 */
export const S7Dare: React.FC = () => {
  const frame = useCurrentFrame();
  const { wide } = useLayout();

  const snapIn = useSnap(0);
  const arrow = enter(frame, 60, 12);
  const card = lerp(frame, [END_CARD, END_CARD + 10], [0, 1]);
  const orb = useSnap(END_CARD + 2);
  const words = enter(frame, END_CARD + 14, 12);

  const clipW = wide ? 1500 : 1900;
  const clipLeft = wide ? 520 : -820;
  const clipTop = wide ? 120 : 300;
  // The clip is a 16:9 frame: an oval mask around AYA hides its edges.
  const mask = "radial-gradient(ellipse 34% 52% at 66% 44%, #000 62%, transparent 100%)";

  return (
    <>
      <Backdrop mood="ivory" />
      <Shell duration={180} push={0.03} enterBlur={false} exitBlur={false}>
      <Stage>
        <div
          style={{
            position: "absolute",
            left: clipLeft,
            top: clipTop,
            width: clipW,
            transform: `scale(${0.94 + 0.06 * snapIn})`,
            transformOrigin: "60% 40%",
            WebkitMaskImage: mask,
            maskImage: mask,
            // The clip is shot on white: multiplied over ivory, its ground disappears.
            mixBlendMode: "multiply",
          }}
        >
          {frame < CLIP_FROM + CLIP_FRAMES ? (
            <Sequence from={CLIP_FROM} layout="none">
              <OffthreadVideo src={staticFile("aya-gesture-720.mp4")} muted style={{ width: clipW, display: "block" }} />
            </Sequence>
          ) : (
            <Img src={staticFile("aya-gesture-end.webp")} style={{ width: clipW, display: "block" }} />
          )}
        </div>

        <div
          style={{
            position: "absolute",
            left: wide ? 120 : 60,
            top: wide ? 170 : 70,
            width: wide ? 900 : 960,
            textAlign: wide ? "left" : "center",
            fontFamily: font,
            fontWeight: 800,
            fontSize: wide ? 96 : 100,
            lineHeight: 1,
            letterSpacing: "-0.02em",
            color: c.plum,
          }}
        >
          <Kinetic text="Don't believe me?" at={12} stagger={3} />
        </div>

        {/* The arrow pulses three times toward the link button below the video. */}
        <div
          style={{
            position: "absolute",
            left: wide ? 120 : 0,
            width: wide ? 760 : 1080,
            top: wide ? 560 : 1060,
            display: "flex",
            flexDirection: "column",
            alignItems: wide ? "flex-start" : "center",
            gap: 18,
            ...enterStyle(arrow),
          }}
        >
          <Pill bg={c.coral} size={wide ? 38 : 36}>
            Build your free AYA from your URL ↓
          </Pill>
          <svg width="90" height="110" viewBox="0 0 90 110" style={{ transform: `translateY(${pulse(frame) * 22}px)`, marginLeft: wide ? 40 : 0 }}>
            <path d="M45 6v78M14 58l31 32 31-32" fill="none" stroke={c.coral} strokeWidth="12" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>
      </Stage>
      </Shell>

      {/* End card. Still for its last 15 frames, so the address reads. */}
      <AbsoluteFill style={{ opacity: card, justifyContent: "center", alignItems: "center" }}>
        <Backdrop mood="ivory" />
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 30, transform: `translateY(${frame < 165 ? drift(frame, 0, 3) : 0}px)` }}>
          <div style={{ transform: `scale(${orb})` }}>
            <Orb size={170} energy={0.3} />
          </div>
          <div style={{ fontFamily: font, fontWeight: 800, fontSize: wide ? 96 : 92, letterSpacing: "-0.02em", color: c.plum, textAlign: "center", lineHeight: 1.05, ...enterStyle(words) }}>
            Click below.
            <br />
            <span style={{ color: c.coral }}>Meet your AYA.</span>
          </div>
          <Img src={staticFile("healdesk-logo.png")} style={{ width: wide ? 520 : 560, marginTop: 10, ...enterStyle(enter(frame, END_CARD + 20, 12)) }} />
        </div>
      </AbsoluteFill>
    </>
  );
};

function pulse(frame: number): number {
  if (frame < 66 || frame > 120) return 0;
  return Math.max(0, Math.sin(((frame - 66) / 18) * Math.PI));
}
