import React from "react";
import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";

import { Desk, deskTop } from "../desk";
import { breathe, drift, enter, enterStyle, lerp, Stage, useLayout, useSnap } from "../motion";
import { Aya, Coin, Glass } from "../parts";
import { c, font } from "../tokens";

const BADGES = ["Built for medspas & aesthetic clinics", "We sign a BAA", "Never gives medical advice"];

/**
 * Scene 2, "Not on my watch", frames 150–270. The coin stops dead mid-roll
 * (the catch), ivory floods out from it, and AYA rises into frame.
 */
export const S2Arrival: React.FC<{ exitAt?: number }> = () => {
  const frame = useCurrentFrame();
  const { wide, scale, left, top } = useLayout();

  const deskY = deskTop(wide);
  const catchX = wide ? 1250 : 700;
  const catchY = deskY - 70;
  // Rolling until 154, then a hard stop.
  const rollX = lerp(frame, [150, 154], [catchX, catchX - 30], (t) => t);
  const caught = frame >= 154;
  const catchPop = useSnap(154);

  const flood = lerp(frame, [154, 172], [0, 1]);
  const radius = interpolate(flood, [0, 1], [0, 2600]);

  const ayaIn = useSnap(168);
  // After the catch the coin flies to AYA and tucks away near her collar.
  const pocket = lerp(frame, [158, 170], [0, 1]);
  const ayaWidth = wide ? 1150 : 1500;
  const ayaLeft = wide ? 760 : -210;
  const ayaTop = wide ? 300 : 320;
  const pocketX = wide ? ayaLeft + ayaWidth * 0.3 : ayaLeft + ayaWidth * 0.3;
  const pocketY = wide ? ayaTop + 640 : ayaTop + 700;
  const coinX = caught ? interpolate(pocket, [0, 1], [rollX - 30, pocketX]) : rollX;
  const coinY = caught ? interpolate(pocket, [0, 1], [catchY, pocketY]) - Math.sin(pocket * Math.PI) * 140 : catchY;

  const hello = enter(frame, 178, 14);
  const name = enter(frame, 196, 14);

  return (
    <>
      <AbsoluteFill style={{ background: c.night }}>
        <Stage>
          <Desk light={0} phoneGrey={1} lamp={-1} />
        </Stage>
      </AbsoluteFill>

      {/* Ivory floods out from the coin. */}
      <AbsoluteFill style={{ clipPath: `circle(${radius * scale}px at ${left + catchX * scale}px ${top + catchY * scale}px)`, background: c.ivory }}>
        <Stage>
          <div
            style={{
              position: "absolute",
              left: ayaLeft,
              top: ayaTop + (1 - ayaIn) * 260,
              opacity: Math.min(1, ayaIn * 1.4),
              transform: `scale(${breathe(frame)}) translateY(${drift(frame)}px)`,
              transformOrigin: "50% 100%",
              WebkitMaskImage: "linear-gradient(180deg, #000 72%, transparent 96%)",
              maskImage: "linear-gradient(180deg, #000 72%, transparent 96%)",
            }}
          >
            <Aya width={ayaWidth} />
          </div>

          <div
            style={{
              position: "absolute",
              left: wide ? 120 : 60,
              top: wide ? 150 : 70,
              width: wide ? 1040 : 960,
              fontFamily: font,
              fontWeight: 800,
              letterSpacing: "-0.02em",
              color: c.plum,
              textAlign: wide ? "left" : "center",
            }}
          >
            <div style={{ fontSize: wide ? 110 : 108, lineHeight: 1, ...enterStyle(hello) }}>Not on my watch.</div>
            <div style={{ fontSize: wide ? 58 : 56, lineHeight: 1.15, marginTop: 22, fontWeight: 600, color: c.plumSoft, ...enterStyle(name) }}>
              Hi, I'm AYA, your 24/7 assistant.
            </div>
          </div>

          {BADGES.map((b, i) => (
            <Badge key={b} text={b} at={210 + i * 6} index={i} wide={wide} frame={frame} />
          ))}
        </Stage>
      </AbsoluteFill>

      <Stage>
        {frame < 172 ? (
          <div
            style={{
              position: "absolute",
              left: coinX - 52,
              top: coinY - 52,
              transform: `scale(${caught ? (1 + 0.25 * (1 - catchPop)) * interpolate(pocket, [0, 1], [1, 0.3]) : 1}) rotate(${caught ? 0 : frame * 9}deg)`,
              opacity: interpolate(pocket, [0.8, 1], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }),
            }}
          >
            <Coin size={104} />
          </div>
        ) : null}
        {caught && frame < 172 ? (
          <div
            style={{
              position: "absolute",
              left: rollX - 30 - 90,
              top: catchY - 90,
              width: 180,
              height: 180,
              borderRadius: "50%",
              border: `6px solid ${c.coral}`,
              transform: `scale(${0.4 + lerp(frame, [154, 170], [0, 1]) * 1.4})`,
              opacity: 1 - lerp(frame, [154, 170], [0, 1]),
            }}
          />
        ) : null}
      </Stage>
    </>
  );
};

const Badge: React.FC<{ text: string; at: number; index: number; wide: boolean; frame: number }> = ({ text, at, index, wide, frame }) => {
  const p = useSnap(at);
  const pos = wide
    ? { left: 120, top: 480 + index * 120 }
    : [
        { left: 40, top: 1000 },
        { left: 560, top: 1090 },
        { left: 140, top: 1180 },
      ][index];
  return (
    <div style={{ position: "absolute", ...pos, transform: `translateY(${(1 - p) * 30 + drift(frame, index * 30, 3)}px) scale(${0.9 + 0.1 * p})`, opacity: Math.min(1, p) }}>
      <Glass style={{ padding: "18px 30px", fontWeight: 600, fontSize: wide ? 36 : 34, display: "flex", alignItems: "center", gap: 14, background: "rgba(255,255,255,0.72)" }}>
        <span style={{ width: 14, height: 14, borderRadius: "50%", background: c.coral }} />
        {text}
      </Glass>
    </div>
  );
};
