import React from "react";
import { Img, OffthreadVideo, Sequence, spring, staticFile, useCurrentFrame, useVideoConfig } from "remotion";

import { CLOSE } from "../copy";
import { enter, enterStyle, Stage, tilt, useLayout } from "../motion";
import { Backdrop, Glass, Kinetic } from "../parts";
import { c, font } from "../tokens";

const CLIP_FRAMES = 99;
const HOLD = 135;

/**
 * Scene 7, the close, 150 frames. The only time Aya's face is shown: her own
 * brand clip, multiplied over the ivory so its white ground drops away. She
 * says the closing line, the URL box waits for the viewer's website, and the
 * last 15 frames hold still so the address reads.
 *
 * Nothing here is blurred or faded as a group: that would isolate the clip,
 * and its white ground would show before the multiply takes.
 */
export const S7Close: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const { wide } = useLayout();
  const f = Math.min(frame, HOLD);

  const clipIn = spring({ frame, fps, config: { damping: 16 } });
  const clipW = wide ? 1500 : 1500;
  const clipLeft = wide ? 520 : -450;
  const clipTop = wide ? 110 : -20;
  // The clip is a 16:9 frame: an oval mask around Aya hides its edges.
  const mask = "radial-gradient(ellipse 34% 52% at 66% 44%, #000 62%, transparent 100%)";

  const col: React.CSSProperties = wide
    ? { position: "absolute", left: 120, top: 190, width: 860, textAlign: "left" }
    : { position: "absolute", left: 60, top: 760, width: 960, textAlign: "center" };

  const button = spring({ frame: frame - 62, fps, config: { damping: 12, stiffness: 180, mass: 0.8 } });
  const pulse = f > 80 && f < HOLD ? 1 + 0.03 * Math.sin((f - 80) / 5) : 1;
  const caret = f < HOLD ? Math.floor(f / 9) % 2 === 0 : true;

  return (
    <>
      <Backdrop mood="ivory" />
      <Stage>
        <div
          style={{
            position: "absolute",
            left: clipLeft,
            top: clipTop + (1 - clipIn) * 80,
            width: clipW,
            WebkitMaskImage: mask,
            maskImage: mask,
            // The clip is shot on white: multiplied over ivory, its ground disappears.
            mixBlendMode: "multiply",
          }}
        >
          {frame < CLIP_FRAMES ? (
            <Sequence layout="none">
              <OffthreadVideo src={staticFile("aya-gesture-720.mp4")} muted style={{ width: clipW, display: "block" }} />
            </Sequence>
          ) : (
            <Img src={staticFile("aya-gesture-end.webp")} style={{ width: clipW, display: "block" }} />
          )}
        </div>

        <div style={{ ...col, fontFamily: font, color: c.plum }}>
          <Kinetic text={CLOSE.line} at={8} stagger={3} highlight={["now"]} style={{ fontWeight: 800, fontSize: wide ? 92 : 104, lineHeight: 1, letterSpacing: "-0.03em", whiteSpace: "nowrap" }} />
          <Kinetic text={CLOSE.sub} at={26} stagger={1.6} style={{ fontWeight: 600, fontSize: wide ? 46 : 44, lineHeight: 1.2, marginTop: 22, color: c.plumSoft }} />

          <div style={{ marginTop: wide ? 50 : 40, ...tilt(f, 46, 16) }}>
            <Glass style={{ height: 120, display: "flex", alignItems: "center", padding: "0 34px", background: "rgba(255,255,255,0.72)", justifyContent: wide ? "flex-start" : "center" }}>
              <svg width="40" height="40" viewBox="0 0 24 24" style={{ marginRight: 16, flexShrink: 0 }}>
                <circle cx="12" cy="12" r="9" fill="none" stroke={c.mist} strokeWidth="2" />
                <path d="M3 12h18M12 3c3 3.5 3 14.5 0 18M12 3c-3 3.5-3 14.5 0 18" fill="none" stroke={c.mist} strokeWidth="1.6" />
              </svg>
              <span style={{ fontSize: 48, fontWeight: 500, color: c.mist }}>{CLOSE.url}</span>
              <span style={{ width: 4, height: 50, background: c.coral, marginLeft: 6, borderRadius: 2, opacity: caret ? 1 : 0 }} />
            </Glass>
          </div>

          <div style={{ display: "flex", justifyContent: wide ? "flex-start" : "center", marginTop: 30 }}>
            <div
              style={{
                background: c.coral,
                color: c.white,
                fontWeight: 800,
                fontSize: 44,
                padding: "24px 54px",
                borderRadius: 999,
                transform: `scale(${Math.max(0, button) * pulse})`,
                boxShadow: "0 20px 44px rgba(255,122,89,0.45), inset 0 1px 0 rgba(255,255,255,0.4)",
              }}
            >
              {CLOSE.button}
            </div>
          </div>

          <Img src={staticFile("healdesk-logo.png")} style={{ width: wide ? 420 : 440, marginTop: wide ? 56 : 50, ...enterStyle(enter(f, 76, 14)) }} />
        </div>
      </Stage>
    </>
  );
};
