import React from "react";
import { interpolate } from "remotion";

import { AyaAvatar } from "../aya";
import { BOOKED_VALUE, CHANNELS, LINES, money } from "../copy";
import { lerp, Stage, useFrame, useLayout } from "../motion";
import { Backdrop, Icon } from "../parts";
import { accent, accentText, c, font } from "../tokens";
import { rise } from "./Hello";

// Hard cut to the counter on the sixth beat of the scene (128 BPM).
const CUT = 84;
const LAND = 104;
const STEP = 30;
const landAt = (i: number) => LAND + i * STEP;

/**
 * 0:20–0:29. One idea per shot. First: "Calls, DMs, chats. All at once.",
 * with the five channels beneath. Then, cut on the beat, the booked value
 * alone and huge, each channel flying into it with its booking's price, from
 * $0 to $1,648: bookings at the clinic's own prices, never "revenue".
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
  return (
    <div style={{ position: "absolute", left: 0, width: W, top: wide ? 250 : 600, textAlign: "center", fontFamily: font }}>
      <div style={{ fontSize: wide ? 150 : 124, fontWeight: 600, letterSpacing: "-0.035em", lineHeight: 1.02, color: c.ink }}>
        <div style={rise(frame, 2)}>{LINES.channels[0]}</div>
        <div style={{ ...rise(frame, 14), ...accentText }}>{LINES.channels[1]}</div>
      </div>
      <div style={{ display: "flex", justifyContent: "center", gap: wide ? 40 : 28, marginTop: wide ? 90 : 110 }}>
        {CHANNELS.map((ch, i) => (
          <div key={ch.key} style={rise(frame, 30 + i * 5)}>
            <Icon name={ch.icon} size={wide ? 132 : 140} style={{ borderRadius: 32, boxShadow: "0 14px 30px rgba(0,0,0,0.12)" }} />
          </div>
        ))}
      </div>
    </div>
  );
};

const Counter: React.FC<{ frame: number; wide: boolean }> = ({ frame, wide }) => {
  const W = wide ? 1920 : 1080;
  const H = wide ? 1080 : 1500;
  const cx = W / 2;
  const cy = wide ? 520 : 700;
  const value = CHANNELS.reduce((sum, ch, i) => sum + ch.value * lerp(frame, [landAt(i), landAt(i) + 14], [0, 1]), 0);
  const booked = CHANNELS.filter((_, i) => frame >= landAt(i)).length;
  return (
    <>
      <div style={{ position: "absolute", left: 0, width: W, top: cy - (wide ? 300 : 330), textAlign: "center", fontFamily: font, color: c.grey, fontSize: 44, fontWeight: 600, letterSpacing: "0.02em", ...rise(frame, CUT + 2) }}>
        Booked value
      </div>
      <div
        style={{
          position: "absolute",
          left: 0,
          width: W,
          top: cy - (wide ? 210 : 230),
          textAlign: "center",
          fontFamily: font,
          fontWeight: 600,
          fontSize: wide ? 300 : 250,
          letterSpacing: "-0.04em",
          lineHeight: 1,
          fontVariantNumeric: "tabular-nums",
          color: c.ink,
          ...rise(frame, CUT + 4),
        }}
      >
        {money(Math.round(value))}
      </div>
      {/* A thin accent line fills as the value grows. */}
      <div style={{ position: "absolute", left: cx - 300, top: cy + (wide ? 130 : 70), width: 600, height: 8, borderRadius: 4, background: c.paper2, ...rise(frame, CUT + 8) }}>
        <div style={{ width: `${(value / BOOKED_VALUE) * 100}%`, height: "100%", borderRadius: 4, background: accent }} />
      </div>
      <div style={{ position: "absolute", left: 0, width: W, top: cy + (wide ? 175 : 120), display: "flex", justifyContent: "center", alignItems: "center", gap: 16, fontFamily: font, fontSize: 40, fontWeight: 500, color: c.grey, ...rise(frame, CUT + 10) }}>
        <AyaAvatar size={64} />
        <span>
          <b style={{ color: c.ink, fontWeight: 600 }}>{booked} {booked === 1 ? "appointment" : "appointments"}</b> {LINES.bookedBy}
        </span>
      </div>

      {CHANNELS.map((ch, i) => (
        <Flyer key={ch.key} i={i} frame={frame} cx={cx} cy={cy} W={W} H={H} wide={wide} icon={ch.icon} value={ch.value} />
      ))}
    </>
  );
};

/** One channel flying into the counter; its price rises off it as it lands. */
const Flyer: React.FC<{ i: number; frame: number; cx: number; cy: number; W: number; H: number; wide: boolean; icon: string; value: number }> = ({ i, frame, cx, cy, W, H, wide, icon, value }) => {
  const start = landAt(i) - 22;
  if (frame < start) return null;
  const t = lerp(frame, [start, landAt(i)], [0, 1]);
  const from = [
    { x: W * 0.12, y: H * 0.18 },
    { x: W * 0.88, y: H * 0.2 },
    { x: W * 0.1, y: H * 0.82 },
    { x: W * 0.9, y: H * 0.8 },
    { x: W * 0.5, y: H * 0.95 },
  ][i];
  const size = wide ? 110 : 120;
  const x = interpolate(t, [0, 1], [from.x, cx]);
  const y = interpolate(t, [0, 1], [from.y, cy - 60]);
  const tag = lerp(frame, [landAt(i), landAt(i) + 26], [0, 1], (v) => v);
  return (
    <>
      {t < 1 ? (
        <div style={{ position: "absolute", left: x - size / 2, top: y - size / 2, transform: `scale(${1 - 0.6 * t})`, opacity: t < 0.08 ? t / 0.08 : 1 - Math.max(0, t - 0.85) / 0.15 }}>
          <Icon name={icon} size={size} style={{ borderRadius: size * 0.24, boxShadow: "0 14px 30px rgba(0,0,0,0.14)" }} />
        </div>
      ) : null}
      {frame >= landAt(i) && tag < 1 ? (
        <div
          style={{
            position: "absolute",
            // Above the label, clear of the figures.
            left: cx - 110,
            top: cy - (wide ? 380 : 420) - tag * 80,
            opacity: tag < 0.15 ? tag / 0.15 : 1 - Math.max(0, tag - 0.6) / 0.4,
            padding: "12px 26px",
            borderRadius: 999,
            background: accent,
            color: "#fff",
            fontFamily: font,
            fontWeight: 600,
            fontSize: 44,
            boxShadow: "0 12px 26px rgba(230,38,39,0.3)",
          }}
        >
          +{money(value)}
        </div>
      ) : null}
    </>
  );
};
