import React from "react";
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";

import { lerp, Shell, Stage, useLayout, useSnap } from "../motion";
import { Backdrop, Coin, Glass, Kinetic, Orb } from "../parts";
import { c, font, SNAP } from "../tokens";
import { coinRest } from "./S1Hook";

const BADGES = ["Built for medspas & aesthetic clinics", "We sign a BAA", "Never gives medical advice"];

/**
 * Scene 2, "Not on my watch", 150–240 (90 frames). The coin stops dead (the
 * catch), ivory floods out from it, and AYA arrives as the orb the coin
 * melts into. Her face is kept for the end.
 */
export const S2Arrival: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const { wide, scale, left, top } = useLayout();
  const rest = coinRest(wide);

  const catchPop = useSnap(2);
  const flood = lerp(frame, [3, 20], [0, 1]);
  const radius = interpolate(flood, [0, 1], [0, 2600]);

  const orbAt = wide ? { x: 1380, y: 520 } : { x: 540, y: 700 };
  const orbSize = wide ? 420 : 440;
  const orbIn = spring({ frame: frame - 8, fps, config: { damping: 11, stiffness: 140, mass: 0.9 } });
  const absorb = lerp(frame, [6, 20], [0, 1]);
  const coinX = interpolate(absorb, [0, 1], [rest.x, orbAt.x]);
  const coinY = interpolate(absorb, [0, 1], [rest.y, orbAt.y]) - Math.sin(absorb * Math.PI) * 120;
  const speaking = frame > 12 && frame < 80 ? 0.5 + 0.5 * Math.abs(Math.sin(frame * 0.45)) : 0;

  return (
    <>
      <AbsoluteFill style={{ clipPath: `circle(${radius * scale}px at ${left + rest.x * scale}px ${top + rest.y * scale}px)` }}>
        <Backdrop mood="ivory" />
      </AbsoluteFill>
      <Shell duration={90} push={0.05} enterBlur={false}>
        <AbsoluteFill style={{ clipPath: `circle(${radius * scale}px at ${left + rest.x * scale}px ${top + rest.y * scale}px)` }}>
          <Stage>
            <div style={{ position: "absolute", left: orbAt.x - orbSize / 2, top: orbAt.y - orbSize / 2, transform: `scale(${orbIn})` }}>
              <Orb size={orbSize} energy={speaking} />
            </div>

            <div style={{ position: "absolute", left: wide ? 120 : 60, top: wide ? 200 : 70, width: wide ? 960 : 960, textAlign: wide ? "left" : "center", color: c.plum }}>
              <Kinetic text="Not on my watch." at={12} stagger={3} style={{ fontWeight: 800, fontSize: wide ? 120 : 104, lineHeight: 1, letterSpacing: "-0.03em" }} />
              <Kinetic
                text="Hi, I'm AYA, your 24/7 assistant."
                at={28}
                stagger={2}
                highlight={["AYA"]}
                style={{ fontWeight: 600, fontSize: wide ? 58 : 54, lineHeight: 1.15, marginTop: 20, color: c.plumSoft }}
              />
            </div>

            {BADGES.map((b, i) => (
              <Badge key={b} text={b} at={44 + i * 6} index={i} wide={wide} orbAt={orbAt} />
            ))}
          </Stage>
        </AbsoluteFill>

        <Stage>
          {frame < 20 ? (
            <div style={{ position: "absolute", left: coinX - 55, top: coinY - 55, transform: `scale(${(1 + 0.25 * (1 - catchPop)) * (1 - absorb * 0.7)})`, opacity: 1 - lerp(frame, [14, 20], [0, 1]) }}>
              <Coin size={110} />
            </div>
          ) : null}
          {frame < 20 ? (
            <div
              style={{
                position: "absolute",
                left: rest.x - 100,
                top: rest.y - 100,
                width: 200,
                height: 200,
                borderRadius: "50%",
                border: `6px solid ${c.coral}`,
                transform: `scale(${0.4 + lerp(frame, [2, 18], [0, 1]) * 1.6})`,
                opacity: 1 - lerp(frame, [2, 18], [0, 1]),
              }}
            />
          ) : null}
        </Stage>
      </Shell>
    </>
  );
};

const Badge: React.FC<{ text: string; at: number; index: number; wide: boolean; orbAt: { x: number; y: number } }> = ({ text, at, index, wide, orbAt }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const p = spring({ frame: frame - at, fps, config: SNAP });
  // Each badge springs out from the orb to its place, then floats.
  const place = wide ? { x: 120, y: 560 + index * 120 } : [{ x: 60, y: 1000 }, { x: 600, y: 1080 }, { x: 160, y: 1160 }][index];
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
