import React from "react";
import { interpolate } from "remotion";

import { AyaAvatar } from "../aya";
import { BOOKED_VALUE, beats, CHANNELS, LINES, money } from "../copy";
import { Drift, lerp, Reveal, Stage, useFrame, useLayout } from "../motion";
import { Backdrop, Icon } from "../parts";
import { accent, accentText, c, font } from "../tokens";
import { rise } from "./Hello";

// The hard cut to the counter on the sixth beat of the scene. The first
// booking lands on the cut itself, so the counter is never seen empty.
const CUT = beats(6);
const STEP = beats(2);
const landAt = (i: number) => CUT + i * STEP;
const LENGTH = beats(19);

/**
 * 0:19.8–0:29.1. One idea per shot. First: "Calls, DMs, chats. All at once."
 * over the five channels. Then, on the beat, the booked value alone and huge,
 * already rolling: each channel flies into it and its price lands beside it,
 * up to $1,648, bookings at the clinic's own prices, never "revenue".
 */
export const Dashboard: React.FC = () => {
  const frame = useFrame();
  const { wide } = useLayout();
  return (
    <>
      <Backdrop mood="white" />
      <Stage>{frame < CUT ? <Channels frame={frame} wide={wide} /> : <Counter frame={frame} wide={wide} />}</Stage>
    </>
  );
};

const Channels: React.FC<{ frame: number; wide: boolean }> = ({ frame, wide }) => {
  const W = wide ? 1920 : 1080;
  const lines = wide ? [LINES.channels[0]] : ["Calls, DMs,", "chats."];
  return (
    <Drift length={CUT} amount={0.05}>
      <div style={{ position: "absolute", left: 0, width: W, top: wide ? 220 : 330, textAlign: "center", fontFamily: font }}>
        <div style={{ fontSize: wide ? 170 : 168, fontWeight: 600, letterSpacing: "-0.04em", lineHeight: 1.0, color: c.ink }}>
          {lines.map((l, i) => (
            <Reveal key={l} at={2 + i * 5}>{l}</Reveal>
          ))}
          <Reveal at={2 + lines.length * 5}>
            <span style={accentText}>{LINES.channels[1]}</span>
          </Reveal>
        </div>
        <div style={{ display: "flex", justifyContent: "center", gap: wide ? 44 : 30, marginTop: wide ? 90 : 120 }}>
          {CHANNELS.map((ch, i) => (
            <div key={ch.key} style={rise(frame, 26 + i * 4)}>
              <Icon name={ch.icon} size={wide ? 150 : 162} style={{ borderRadius: 38, boxShadow: "0 18px 36px rgba(0,0,0,0.12)" }} />
            </div>
          ))}
        </div>
      </div>
    </Drift>
  );
};

const Counter: React.FC<{ frame: number; wide: boolean }> = ({ frame, wide }) => {
  const W = wide ? 1920 : 1080;
  const H = wide ? 1080 : 1500;
  const cx = W / 2;
  const cy = wide ? 520 : 700;
  const value = CHANNELS.reduce((sum, ch, i) => sum + ch.value * lerp(frame, [landAt(i), landAt(i) + 12], [0, 1]), 0);
  const booked = CHANNELS.filter((_, i) => frame >= landAt(i)).length;
  const numberSize = wide ? 330 : 300;
  return (
    <Drift length={LENGTH - CUT} amount={0.04}>
      <div style={{ position: "absolute", left: 0, width: W, top: cy - numberSize * 0.95, textAlign: "center", fontFamily: font, color: c.grey, fontSize: 60, fontWeight: 600 }}>Booked value</div>
      <div
        style={{
          position: "absolute",
          left: 0,
          width: W,
          top: cy - numberSize * 0.62,
          textAlign: "center",
          fontFamily: font,
          fontWeight: 600,
          fontSize: numberSize,
          letterSpacing: "-0.045em",
          lineHeight: 1,
          fontVariantNumeric: "tabular-nums",
          color: c.ink,
        }}
      >
        {money(Math.round(value))}
      </div>
      <div style={{ position: "absolute", left: cx - 340, top: cy + numberSize * 0.48, width: 680, height: 10, borderRadius: 5, background: c.paper2 }}>
        <div style={{ width: `${(value / BOOKED_VALUE) * 100}%`, height: "100%", borderRadius: 5, background: accent }} />
      </div>
      <div style={{ position: "absolute", left: 0, width: W, top: cy + numberSize * 0.62, display: "flex", justifyContent: "center", alignItems: "center", gap: 20, fontFamily: font, fontSize: 54, fontWeight: 500, color: c.grey }}>
        <AyaAvatar size={84} />
        <span>
          <b style={{ color: c.ink, fontWeight: 600 }}>
            {booked} {booked === 1 ? "booking" : "bookings"}
          </b>{" "}
          {LINES.bookedBy}
        </span>
      </div>

      {CHANNELS.map((ch, i) => (
        <Flyer key={ch.key} i={i} frame={frame} cx={cx} cy={cy} W={W} H={H} wide={wide} icon={ch.icon} value={ch.value} numberSize={numberSize} />
      ))}
    </Drift>
  );
};

/** One channel flying into the counter; its price lands beside the number and rises off. */
const Flyer: React.FC<{ i: number; frame: number; cx: number; cy: number; W: number; H: number; wide: boolean; icon: string; value: number; numberSize: number }> = ({ i, frame, cx, cy, W, H, wide, icon, value, numberSize }) => {
  const start = landAt(i) - 18;
  const t = lerp(frame, [start, landAt(i)], [0, 1]);
  const from = [
    { x: W * 0.14, y: H * 0.16 },
    { x: W * 0.86, y: H * 0.18 },
    { x: W * 0.12, y: H * 0.86 },
    { x: W * 0.88, y: H * 0.84 },
    { x: W * 0.5, y: H * 0.97 },
  ][i];
  const size = wide ? 130 : 140;
  const x = interpolate(t, [0, 1], [from.x, cx]);
  const y = interpolate(t, [0, 1], [from.y, cy]);
  const tag = lerp(frame, [landAt(i), landAt(i) + beats(2)], [0, 1], (v) => v);
  const right = i % 2 === 0;
  return (
    <>
      {frame >= start && t < 1 ? (
        <div style={{ position: "absolute", left: x - size / 2, top: y - size / 2, transform: `scale(${1 - 0.55 * t})`, opacity: t < 0.1 ? t / 0.1 : 1 - Math.max(0, t - 0.85) / 0.15 }}>
          <Icon name={icon} size={size} style={{ borderRadius: size * 0.24, boxShadow: "0 16px 32px rgba(0,0,0,0.14)" }} />
        </div>
      ) : null}
      {frame >= landAt(i) && tag < 1 ? (
        <div
          style={{
            position: "absolute",
            left: right ? cx + (wide ? 380 : 230) : undefined,
            right: right ? undefined : W - cx + (wide ? 380 : 230),
            top: cy - numberSize * 0.95 - tag * 70,
            opacity: tag < 0.12 ? tag / 0.12 : 1 - Math.max(0, tag - 0.6) / 0.4,
            padding: "14px 30px",
            borderRadius: 999,
            background: accent,
            color: "#fff",
            fontFamily: font,
            fontWeight: 600,
            fontSize: 60,
            boxShadow: "0 14px 30px rgba(230,38,39,0.3)",
          }}
        >
          +{money(value)}
        </div>
      ) : null}
    </>
  );
};
