import React from "react";
import { spring, useVideoConfig } from "remotion";

import { BOOKED_VALUE, CHANNELS, Channel, LINES, money } from "../copy";
import { lerp, Shell, Stage, tilt, useFrame, useLayout } from "../motion";
import { Backdrop, Glass, Icon, Kinetic, Orb } from "../parts";
import { c, font, SNAP, tracked } from "../tokens";

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const STREAM = 22;
const STREAM_STEP = 10;
const RESOLVE = 92;
const RESOLVE_STEP = 30;

export const streamAt = (i: number) => STREAM + i * STREAM_STEP;
export const resolveAt = (i: number) => RESOLVE + i * RESOLVE_STEP;

/**
 * 0:25–0:35. A split-screen dashboard. On one side, conversations stream in
 * from every channel at once; on the other, each one Aya books lands on the
 * week and the booked value ticks up in real time, $0 to $1,648.
 */
export const Dashboard: React.FC = () => {
  const frame = useFrame();
  const { wide } = useLayout();

  // The counter rolls up over 16 frames as each booking lands.
  const value = CHANNELS.reduce((sum, ch, i) => sum + ch.value * lerp(frame, [resolveAt(i), resolveAt(i) + 16], [0, 1]), 0);

  const feed = wide ? { x: 110, y: 190, w: 880, h: 790 } : { x: 40, y: 200, w: 1000, h: 650 };
  const dash = wide ? { x: 1030, y: 190, w: 780, h: 790 } : { x: 40, y: 880, w: 1000, h: 400 };

  return (
    <>
      <Backdrop mood="white" />
      <Shell duration={300} push={0.025}>
        <Stage>
          <div style={{ position: "absolute", left: 0, right: 0, top: wide ? 60 : 70, textAlign: "center" }}>
            <Kinetic text={LINES.channels} at={4} stagger={4} style={{ fontWeight: 600, fontSize: wide ? 84 : 66, letterSpacing: tracked, color: c.plum, lineHeight: 1.05 }} />
          </div>

          {/* The stream. */}
          <div style={{ position: "absolute", left: feed.x, top: feed.y, width: feed.w, height: feed.h, ...tilt(frame, 10, 10, 0) }}>
            <Glass style={{ width: "100%", height: "100%", padding: 26, display: "flex", flexDirection: "column", gap: 14, background: "rgba(255,255,255,0.6)" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 14, fontSize: 26, fontWeight: 600, letterSpacing: tracked, color: c.plumSoft }}>
                <Orb size={40} energy={0.4} /> Aya · live conversations
                <div style={{ flex: 1 }} />
                <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ width: 10, height: 10, borderRadius: "50%", background: "#34C759", boxShadow: "0 0 10px #34C759", opacity: 0.5 + 0.5 * Math.abs(Math.sin(frame / 8)) }} /> {CHANNELS.length} at once
                </span>
              </div>
              {CHANNELS.map((ch, i) => (
                <Row key={ch.key} ch={ch} i={i} wide={wide} />
              ))}
            </Glass>
          </div>

          {/* The dashboard. */}
          <div style={{ position: "absolute", left: dash.x, top: dash.y, width: dash.w, height: dash.h, ...tilt(frame, 18, 10, 30) }}>
            <Glass style={{ width: "100%", height: "100%", padding: wide ? 40 : 30, display: "flex", flexDirection: wide ? "column" : "row", gap: wide ? 36 : 30, background: "rgba(255,255,255,0.6)" }}>
              <div style={{ flexShrink: 0 }}>
                <div style={{ fontSize: 24, fontWeight: 600, letterSpacing: "0.08em", color: c.plumSoft }}>BOOKED VALUE</div>
                <div style={{ fontSize: wide ? 136 : 108, fontWeight: 600, letterSpacing: "-0.02em", color: value > 0 ? c.plum : c.mist, fontVariantNumeric: "tabular-nums", lineHeight: 1.05 }}>{money(Math.round(value))}</div>
                <div style={{ fontSize: 24, fontWeight: 500, color: c.plumSoft, marginTop: 6 }}>
                  {CHANNELS.filter((_, i) => frame >= resolveAt(i)).length} bookings · your own prices
                </div>
                <Spark frame={frame} wide={wide} />
              </div>
              <Week frame={frame} wide={wide} />
            </Glass>
          </div>
        </Stage>
      </Shell>
    </>
  );
};

/** One conversation: the patient's message streams in, then Aya's booking. */
const Row: React.FC<{ ch: Channel; i: number; wide: boolean }> = ({ ch, i, wide }) => {
  const frame = useFrame();
  const { fps } = useVideoConfig();
  const p = spring({ frame: frame - streamAt(i), fps, config: SNAP });
  const r = spring({ frame: frame - resolveAt(i), fps, config: SNAP });
  if (frame < streamAt(i)) return <div style={{ height: wide ? 128 : 104 }} />;
  const typing = frame < resolveAt(i);
  return (
    <div
      style={{
        height: wide ? 128 : 104,
        display: "flex",
        alignItems: "center",
        gap: 16,
        padding: "0 18px",
        borderRadius: 22,
        background: frame >= resolveAt(i) ? "rgba(255,122,89,0.08)" : "rgba(255,255,255,0.55)",
        boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.8)",
        transform: `translateX(${(1 - p) * -60}px)`,
        opacity: Math.min(1, p * 1.4),
        fontFamily: font,
      }}
    >
      <Icon name={ch.icon} size={wide ? 60 : 54} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 20, fontWeight: 600, color: c.plumSoft, letterSpacing: tracked }}>
          {ch.title} · {ch.meta}
        </div>
        <div style={{ fontSize: wide ? 28 : 25, fontWeight: 500, color: c.plum, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          {ch.ask ?? '"Hi, this is the AI assistant for Bella Skin Studio…"'}
        </div>
      </div>
      {typing ? (
        <div style={{ display: "flex", gap: 6, padding: "12px 16px", borderRadius: 20, background: "rgba(42,22,48,0.06)" }}>
          {[0, 1, 2].map((k) => (
            <span key={k} style={{ width: 9, height: 9, borderRadius: "50%", background: c.plumSoft, opacity: 0.3 + 0.7 * Math.abs(Math.sin((frame + k * 5) / 6)) }} />
          ))}
        </div>
      ) : (
        <div style={{ display: "flex", alignItems: "center", gap: 10, transform: `scale(${0.8 + 0.2 * r})`, opacity: Math.min(1, r * 1.4) }}>
          <span style={{ fontSize: wide ? 24 : 22, fontWeight: 600, color: c.plum, whiteSpace: "nowrap" }}>Booked {DAYS[ch.day]} {ch.time}</span>
          <span style={{ fontSize: wide ? 26 : 24, fontWeight: 700, color: c.white, background: c.coral, padding: "6px 12px", borderRadius: 999 }}>+{money(ch.value)}</span>
        </div>
      )}
    </div>
  );
};

/** A small rising line under the counter, drawn as the bookings land. */
const Spark: React.FC<{ frame: number; wide: boolean }> = ({ frame, wide }) => {
  const w = wide ? 700 : 380;
  const h = wide ? 120 : 90;
  let acc = 0;
  const pts = [[0, h]];
  CHANNELS.forEach((ch, i) => {
    acc += ch.value;
    pts.push([((i + 1) / CHANNELS.length) * w, h - (acc / BOOKED_VALUE) * (h - 10)]);
  });
  const d = pts.map((p, i) => `${i ? "L" : "M"}${p[0]},${p[1]}`).join(" ");
  const draw = lerp(frame, [resolveAt(0), resolveAt(CHANNELS.length - 1) + 16], [0, 1], (t) => t);
  return (
    <svg width={w} height={h} style={{ marginTop: 18, overflow: "visible" }}>
      <defs>
        <linearGradient id="spark" x1="0" x2="1">
          <stop offset="0" stopColor={c.coral} stopOpacity="0.4" />
          <stop offset="1" stopColor={c.healdeskRed} />
        </linearGradient>
      </defs>
      <path d={d} fill="none" stroke="url(#spark)" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" pathLength={1} strokeDasharray={1} strokeDashoffset={1 - draw} />
    </svg>
  );
};

const Week: React.FC<{ frame: number; wide: boolean }> = ({ frame, wide }) => {
  const { fps } = useVideoConfig();
  return (
    <div style={{ flex: 1, display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 8, minHeight: wide ? 300 : 0 }}>
      {DAYS.map((d, di) => (
        <div key={d} style={{ display: "flex", flexDirection: "column", gap: 8, borderRadius: 16, background: "rgba(42,22,48,0.035)", padding: "10px 4px" }}>
          <div style={{ fontSize: 20, fontWeight: 600, color: c.plumSoft, textAlign: "center" }}>{d}</div>
          {CHANNELS.map((ch, i) => {
            if (ch.day !== di || frame < resolveAt(i) + 6) return null;
            const p = spring({ frame: frame - resolveAt(i) - 6, fps, config: SNAP });
            return (
              <div key={ch.key} style={{ transform: `scale(${p})`, background: c.coral, color: c.white, borderRadius: 12, padding: "8px 2px", textAlign: "center", boxShadow: "0 8px 18px rgba(255,122,89,0.35)" }}>
                <div style={{ fontSize: wide ? 18 : 15, fontWeight: 600 }}>{ch.time}</div>
                <div style={{ fontSize: wide ? 22 : 18, fontWeight: 700 }}>{money(ch.value)}</div>
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
};

