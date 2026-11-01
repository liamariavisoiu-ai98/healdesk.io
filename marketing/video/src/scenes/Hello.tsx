import React from "react";

import { AyaAvatar, AyaFilm } from "../aya";
import { CLINIC, LINES, money } from "../copy";
import { lerp, Stage, useFrame, useLayout } from "../motion";
import { Backdrop, Tick } from "../parts";
import { accent, accentText, c, font, shadow, tracked } from "../tokens";

// Hard cut to the second shot on the ninth beat of the scene (128 BPM).
const CUT = 127;
const TYPE_FROM = 150;
const TYPE_STEP = 2.6;
const LEARNED = 212;

/** A line rising into place, no bounce. */
export function rise(frame: number, at: number, dur = 14): React.CSSProperties {
  const p = lerp(frame, [at, at + dur], [0, 1]);
  return { opacity: p, transform: `translateY(${(1 - p) * 26}px)` };
}

/**
 * 0:10–0:20. Aya herself, the real person from healdesk's site: she smiles
 * and points to her name. Then, cut on the beat, one idea: just add your
 * website. It types itself in, Aya reads it, and the treatments and prices
 * she learned sit underneath.
 */
export const Hello: React.FC = () => {
  const frame = useFrame();
  const { wide } = useLayout();
  return (
    <>
      <Backdrop mood="white" />
      <Stage>{frame < CUT ? <Meet frame={frame} wide={wide} /> : <Website frame={frame} wide={wide} />}</Stage>
    </>
  );
};

const Meet: React.FC<{ frame: number; wide: boolean }> = ({ frame, wide }) => {
  const film = wide ? { width: 1500, left: 560, top: 70 } : { width: 1600, left: -516, top: -30 };
  const col: React.CSSProperties = wide
    ? { position: "absolute", left: 140, top: 330, width: 820, textAlign: "left" }
    : { position: "absolute", left: 0, right: 0, top: 880, textAlign: "center" };
  return (
    <>
      <AyaFilm {...film} />
      <div style={{ ...col, fontFamily: font, color: c.ink }}>
        <div style={{ fontSize: wide ? 140 : 132, fontWeight: 600, letterSpacing: "-0.03em", lineHeight: 1, ...rise(frame, 14) }}>
          Hi, I'm <span style={accentText}>Aya.</span>
        </div>
        <div style={{ fontSize: wide ? 56 : 54, fontWeight: 500, letterSpacing: tracked, color: c.grey, marginTop: 20, ...rise(frame, 28) }}>{LINES.helloSub}</div>
        <div style={{ display: "flex", gap: 16, justifyContent: wide ? "flex-start" : "center", marginTop: 44 }}>
          {LINES.badges.map((b, i) => (
            <div key={b} style={{ ...rise(frame, 54 + i * 8), padding: "16px 28px", borderRadius: 999, background: c.paper2, fontSize: 36, fontWeight: 600, display: "flex", alignItems: "center", gap: 12 }}>
              <span style={{ width: 12, height: 12, borderRadius: "50%", background: accent }} />
              {b}
            </div>
          ))}
        </div>
      </div>
    </>
  );
};

const Website: React.FC<{ frame: number; wide: boolean }> = ({ frame, wide }) => {
  const typed = Math.max(0, Math.min(CLINIC.url.length, Math.floor((frame - TYPE_FROM) / TYPE_STEP)));
  const done = typed === CLINIC.url.length;
  const doneAt = TYPE_FROM + CLINIC.url.length * TYPE_STEP;
  const W = wide ? 1920 : 1080;
  const boxW = wide ? 1240 : 980;
  const top = wide ? 300 : 600;
  return (
    <div style={{ position: "absolute", left: (W - boxW) / 2, top, width: boxW, fontFamily: font, color: c.ink, textAlign: "center" }}>
      <div style={{ fontSize: wide ? 96 : 84, fontWeight: 600, letterSpacing: "-0.025em", lineHeight: 1.05, ...rise(frame, CUT + 2) }}>
        Just add your <span style={accentText}>website.</span>
      </div>
      <div
        style={{
          marginTop: 56,
          height: 156,
          borderRadius: 999,
          background: c.paper,
          boxShadow: shadow,
          border: `1px solid ${c.line}`,
          display: "flex",
          alignItems: "center",
          padding: "0 18px 0 48px",
          ...rise(frame, CUT + 10),
        }}
      >
        <span style={{ fontSize: 60, fontWeight: 500, letterSpacing: tracked, color: typed ? c.ink : c.mist }}>{typed ? CLINIC.url.slice(0, typed) : "yourwebsite.com"}</span>
        {!done ? <span style={{ width: 4, height: 64, background: c.healdeskOrange, marginLeft: 4, borderRadius: 2, opacity: Math.floor(frame / 8) % 2 === 0 || typed > 0 ? 1 : 0 }} /> : null}
        <div style={{ flex: 1 }} />
        <div style={{ width: 118, height: 118, borderRadius: "50%", background: done ? accent : c.paper2, display: "flex", alignItems: "center", justifyContent: "center", transition: "none" }}>
          {done ? <Tick size={56} p={lerp(frame, [doneAt, doneAt + 10], [0, 1])} /> : (
            <svg width="50" height="50" viewBox="0 0 24 24">
              <path d="M5 12h13M13 6l6 6-6 6" fill="none" stroke={c.grey} strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          )}
        </div>
      </div>

      {/* Aya reads it. */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 18, marginTop: 48, ...rise(frame, doneAt + 4) }}>
        <AyaAvatar size={84} ring />
        <span style={{ fontSize: 40, fontWeight: 500, color: c.grey }}>
          Aya learned <b style={{ color: c.ink, fontWeight: 600 }}>{CLINIC.name}</b>
        </span>
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 18, justifyContent: "center", marginTop: 34 }}>
        {CLINIC.treatments.map((t, i) => (
          <div key={t.name} style={{ ...rise(frame, LEARNED + i * 7), padding: "20px 32px", borderRadius: 999, background: c.paper2, fontSize: 42, fontWeight: 600 }}>
            {t.name} <span style={accentText}>{money(t.price)}</span>
          </div>
        ))}
      </div>
    </div>
  );
};
