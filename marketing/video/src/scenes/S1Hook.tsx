import React from "react";
import { interpolate, useCurrentFrame } from "remotion";

import { HOOK_COPY, Hook } from "../copy";
import { Desk, deskTop } from "../desk";
import { enter, enterStyle, exit, lerp, Stage, useLayout, useSnap } from "../motion";
import { Caller, Coin, Pill } from "../parts";
import { c, easeExit, font } from "../tokens";

const CALLERS = 20;
const GONE = 17;

/**
 * Scene 1, "The call that got away", frames 0–150. Night and mist only:
 * no coral before AYA arrives.
 */
export const S1Hook: React.FC<{ hook: Hook }> = ({ hook }) => {
  const frame = useCurrentFrame();
  const { wide, W } = useLayout();
  const copy = HOOK_COPY[hook];

  // The slam: a snap on frame 0, so the first frame already reads.
  const slam = useSnap(-3);
  const settle = lerp(frame, [8, 45], [0, 1]);
  const big = copy.slam.length > 4 ? (wide ? 260 : 200) : 300;
  const small = wide ? 120 : 130;
  const slamSize = interpolate(settle, [0, 1], [big, small]);
  const slamY = interpolate(settle, [0, 1], wide ? [380, 70] : [620, 90]);
  const slamX = wide ? interpolate(settle, [0, 1], [W / 2, 120 + 160]) : W / 2;
  const flipped = copy.flip && frame >= 108;
  const flipTurn = copy.flip ? Math.abs(Math.cos(lerp(frame, [100, 116], [0, Math.PI]))) : 1;

  // Two rings, each with a 6 px shake, then the screen greys out.
  const ring = (frame >= 10 && frame < 22) || (frame >= 28 && frame < 40);
  const shake = ring ? Math.sin(frame * 2.6) * 6 : 0;
  const glow = ring ? 1 : frame < 45 ? 0.35 : 0;
  const grey = lerp(frame, [45, 52], [0, 1]);
  const missed = enter(frame, 46, 12);

  // Line 1 types on word by word from frame 60, then lines 2 and 3 replace it.
  const line1Words = copy.line1.split(" ");
  const typed = Math.max(0, Math.min(line1Words.length, Math.floor((frame - 60) / 2.6)));
  const line1Out = exit(frame, 100, 8);
  const line2In = enter(frame, 104, 14);
  const line2Out = exit(frame, 134, 8);
  const line3In = enter(frame, 136, 12);

  const deskY = deskTop(wide);
  const doorX = wide ? 1640 : 880;
  const doorClose = lerp(frame, [130, 140], [0, 1], easeExit);

  // The coin rolls out from under the door toward the centre, wobbling.
  const coinT = lerp(frame, [138, 150], [0, 1], (t) => t);
  const coinX = interpolate(coinT, [0, 1], [doorX, wide ? 1250 : 700]);
  const coinY = deskY - 70;

  const headlineBox: React.CSSProperties = wide
    ? { position: "absolute", left: 120, top: 220, width: 960 }
    : { position: "absolute", left: 70, top: 250, width: 940 };

  return (
    <Stage>
      <Desk light={0} phoneGlow={glow} phoneGrey={grey} lamp={-1}>
        {/* The competitor's door, warmly lit, on the back wall. */}
        <div style={{ position: "absolute", left: doorX - 110, top: deskY - 330, width: 220, height: 330, opacity: lerp(frame, [6, 18], [0, 1]) }}>
          <div style={{ position: "absolute", inset: 0, background: "#FFC98A", boxShadow: "0 0 80px rgba(255,190,110,0.45)", borderRadius: "10px 10px 0 0" }} />
          <div
            style={{
              position: "absolute",
              top: 0,
              bottom: 0,
              left: 0,
              width: `${interpolate(doorClose, [0, 1], [35, 100])}%`,
              background: "#3B2F2A",
              borderRadius: "10px 0 0 0",
            }}
          />
          <div
            style={{
              position: "absolute",
              left: -60,
              right: -60,
              top: -64,
              textAlign: "center",
              fontFamily: font,
              fontWeight: 600,
              fontSize: 24,
              color: "#FFDDB0",
            }}
          >
            Clinic down the street
          </div>
        </div>
      </Desk>

      {/* The desk phone shakes on its rings. */}
      <div style={{ position: "absolute", left: wide ? 470 : 200, top: deskY - 230, transform: `translateX(${shake}px)`, opacity: missed, ...enterStyle(missed, 12) }}>
        <Pill bg="rgba(154,154,162,0.18)" colour={c.mist} size={28}>
          Missed call · 6:42 PM
        </Pill>
      </div>

      {/* Callers: 17 of 20 fade out, then walk off to the door. */}
      {Array.from({ length: CALLERS }).map((_, i) => {
        const size = wide ? 34 : 38;
        const gap = wide ? 46 : 48;
        const startX = wide ? 120 : 60;
        const x0 = startX + i * gap;
        const goes = i < GONE;
        const fade = goes ? lerp(frame, [60 + i * 2, 66 + i * 2], [1, 0.28]) : 1;
        const walk = goes ? lerp(frame, [100 + i * 0.8, 128 + i * 0.8], [0, 1]) : 0;
        const x = interpolate(walk, [0, 1], [x0, doorX - size / 2]);
        const vanish = goes ? lerp(frame, [124 + i * 0.6, 132 + i * 0.6], [1, 0]) : 1;
        return (
          <Caller
            key={i}
            size={size}
            style={{
              position: "absolute",
              left: x,
              top: deskY + (wide ? 150 : 110),
              opacity: fade * vanish * interpolate(frame, [52, 60], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }),
            }}
          />
        );
      })}

      {/* The scroll-stopper. */}
      <div
        style={{
          position: "absolute",
          left: slamX,
          top: slamY,
          transform: `translate(-50%, -50%) scale(${0.8 + 0.2 * slam}) scaleY(${flipTurn})`,
          fontFamily: font,
          fontWeight: 800,
          fontSize: slamSize,
          letterSpacing: "-0.02em",
          color: c.mist,
          fontVariantNumeric: "tabular-nums",
          whiteSpace: "nowrap",
          lineHeight: 1,
        }}
      >
        {flipped ? copy.flip : copy.slam}
      </div>

      {/* The three lines. */}
      <div style={headlineBox}>
        <div style={{ position: "absolute", top: 0, opacity: line1Out, fontFamily: font, fontWeight: 800, fontSize: wide ? 64 : 76, lineHeight: 1.1, letterSpacing: "-0.02em", color: "#EDE7F0" }}>
          {line1Words.map((w, i) => (
            <span key={i} style={{ opacity: i < typed ? 1 : 0 }}>
              {w}{" "}
            </span>
          ))}
        </div>
        <div style={{ position: "absolute", top: 0, fontFamily: font, fontWeight: 800, fontSize: wide ? 64 : 76, lineHeight: 1.1, letterSpacing: "-0.02em", color: "#EDE7F0", ...enterStyle(line2In * line2Out) }}>
          {copy.line2}
        </div>
        <div style={{ position: "absolute", top: 0, fontFamily: font, fontWeight: 800, fontSize: wide ? 84 : 100, lineHeight: 1.05, letterSpacing: "-0.02em", color: c.white, ...enterStyle(line3In) }}>
          {copy.line3}
        </div>
      </div>

      {frame >= 136 ? (
        <Coin
          size={wide ? 96 : 104}
          spin={frame * 0.5}
          label={hook === "stat" ? "$1,500" : "$"}
          style={{ position: "absolute", left: coinX - 52, top: coinY - 52 + Math.sin(frame * 0.9) * 4, transform: `rotate(${frame * 9}deg)` }}
        />
      ) : null}

      {copy.smallPrint && frame >= 60 ? (
        <div style={{ position: "absolute", left: wide ? 120 : 60, top: wide ? 1040 : 1440, fontFamily: font, fontWeight: 500, fontSize: 22, color: c.mist }}>
          {copy.smallPrint}
        </div>
      ) : null}
    </Stage>
  );
};
