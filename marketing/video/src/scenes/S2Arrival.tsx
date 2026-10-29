import React from "react";
import { interpolate, spring, useVideoConfig } from "remotion";

import { Shell, Stage, useFrame, useLayout } from "../motion";
import { Backdrop, Glass, Kinetic, Orb } from "../parts";
import { c, font, SNAP } from "../tokens";

const BADGES = ["Built for medspas & aesthetic clinics", "We sign a BAA", "Never gives medical advice"];

/**
 * Scene 2, Aya arrives, 75 frames of scene time. Out of the black, ivory, and
 * the orb that stands for Aya blooms; she says who she is, and three badges
 * spring out of her. Her face is kept for the close.
 */
export const S2Arrival: React.FC = () => {
  const frame = useFrame();
  const { fps } = useVideoConfig();
  const { wide } = useLayout();

  const orbAt = wide ? { x: 1380, y: 520 } : { x: 540, y: 640 };
  const orbSize = wide ? 420 : 460;
  const orbIn = spring({ frame: frame - 2, fps, config: { damping: 11, stiffness: 140, mass: 0.9 } });
  const speaking = frame > 8 && frame < 60 ? 0.5 + 0.5 * Math.abs(Math.sin(frame * 0.45)) : 0;

  return (
    <>
      <Backdrop mood="ivory" />
      <Shell duration={75} push={0.05} enterBlur={false}>
        <Stage>
          <div style={{ position: "absolute", left: orbAt.x - orbSize / 2, top: orbAt.y - orbSize / 2, transform: `scale(${orbIn})` }}>
            <Orb size={orbSize} energy={speaking} />
          </div>

          <div style={{ position: "absolute", left: wide ? 120 : 60, top: wide ? 300 : 110, width: 960, textAlign: wide ? "left" : "center", color: c.plum }}>
            <Kinetic text="Hi, I'm Aya," at={8} stagger={3} highlight={["Aya"]} style={{ fontWeight: 800, fontSize: wide ? 120 : 108, lineHeight: 1, letterSpacing: "-0.03em" }} />
            <Kinetic text="your 24/7 assistant." at={20} stagger={3} style={{ fontWeight: 600, fontSize: wide ? 64 : 60, lineHeight: 1.15, marginTop: 16, color: c.plumSoft }} />
          </div>

          {BADGES.map((b, i) => (
            <Badge key={b} text={b} at={34 + i * 6} index={i} wide={wide} orbAt={orbAt} />
          ))}
        </Stage>
      </Shell>
    </>
  );
};

const Badge: React.FC<{ text: string; at: number; index: number; wide: boolean; orbAt: { x: number; y: number } }> = ({ text, at, index, wide, orbAt }) => {
  const frame = useFrame();
  const { fps } = useVideoConfig();
  const p = spring({ frame: frame - at, fps, config: SNAP });
  // Each badge springs out from the orb to its place, then floats.
  const place = wide ? { x: 120, y: 560 + index * 120 } : [{ x: 60, y: 960 }, { x: 560, y: 1050 }, { x: 160, y: 1140 }][index];
  const x = interpolate(Math.min(p, 1.06), [0, 1], [orbAt.x - 200, place.x]);
  const y = interpolate(Math.min(p, 1.06), [0, 1], [orbAt.y, place.y]) + Math.sin((frame + index * 20) / 18) * 4;
  return (
    <div style={{ position: "absolute", left: x, top: y, transform: `scale(${0.6 + 0.4 * p})`, opacity: Math.min(1, p * 1.4), filter: `blur(${Math.max(0, 1 - p) * 8}px)` }}>
      <Glass style={{ padding: "18px 30px", fontWeight: 700, fontSize: wide ? 36 : 34, display: "flex", alignItems: "center", gap: 14, fontFamily: font }}>
        <span style={{ width: 14, height: 14, borderRadius: "50%", background: c.coral, boxShadow: `0 0 12px ${c.coral}` }} />
        {text}
      </Glass>
    </div>
  );
};
