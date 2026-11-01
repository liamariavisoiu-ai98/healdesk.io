import React from "react";
import { Img, staticFile } from "remotion";

import { AyaAvatar, AyaFigure } from "../aya";
import { beats, CLINIC, LINES, money } from "../copy";
import { Drift, lerp, Reveal, Stage, useFrame, useFrameBottom, useLayout } from "../motion";
import { Backdrop, Tick } from "../parts";
import { accent, accentText, c, font, shadow, tracked } from "../tokens";

// The hard cut to the second shot, on the ninth beat of the scene.
const CUT = beats(9);
const TYPE_FROM = CUT + 22;
const TYPE_STEP = 2.4;
const LEARNED = TYPE_FROM + 19 * TYPE_STEP + 14;

/** A block rising into place, no bounce: for cards and pills; lines use <Reveal>. */
export function rise(frame: number, at: number, dur = 14): React.CSSProperties {
  const p = lerp(frame, [at, at + dur], [0, 1]);
  return { opacity: p, transform: `translateY(${(1 - p) * 26}px)` };
}

/**
 * 0:10.5–0:19.8. Aya herself, cut cleanly out of her own footage, standing
 * in the white: "Hi, I'm Aya", signed by healdesk. Then, cut on the beat, one
 * idea: just add your website. It types itself in, and what she learned from
 * it sits underneath, all at a size a phone can read.
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
  const bottom = useFrameBottom();
  const col: React.CSSProperties = wide
    ? { position: "absolute", left: 140, top: 300, width: 860, textAlign: "left" }
    : { position: "absolute", left: 0, right: 0, top: 70, textAlign: "center" };
  return (
    <Drift length={CUT} amount={0.035} origin={wide ? "70% 60%" : "50% 70%"}>
      <AyaFigure width={wide ? 1300 : 1320} faceX={wide ? 1380 : 560} bottom={bottom} />
      <div style={{ ...col, fontFamily: font, color: c.ink }}>
        <Reveal at={10}>
          <div style={{ fontSize: wide ? 170 : 150, fontWeight: 600, letterSpacing: "-0.035em", lineHeight: 1.02 }}>
            Hi, I'm <span style={accentText}>Aya.</span>
          </div>
        </Reveal>
        <Reveal at={22}>
          <div style={{ fontSize: wide ? 64 : 62, fontWeight: 500, letterSpacing: tracked, color: c.grey, marginTop: 14 }}>{LINES.helloSub}</div>
        </Reveal>
        {/* Her sign-off: Aya is healdesk's. */}
        <div style={{ display: "flex", alignItems: "center", gap: 18, justifyContent: wide ? "flex-start" : "center", marginTop: 28, ...rise(frame, 40) }}>
          <span style={{ fontSize: 48, fontWeight: 500, color: c.grey }}>{LINES.signature}</span>
          <Img src={staticFile("healdesk-logo.png")} style={{ height: 66 }} />
        </div>
        <div style={{ display: "flex", gap: 16, justifyContent: wide ? "flex-start" : "center", marginTop: 30, ...rise(frame, 54) }}>
          {LINES.badges.map((b) => (
            <span key={b} style={{ display: "inline-flex", alignItems: "center", gap: 12, padding: "14px 26px", borderRadius: 999, background: c.paper2, fontSize: 40, fontWeight: 600 }}>
              <span style={{ width: 12, height: 12, borderRadius: "50%", background: accent }} />
              {b}
            </span>
          ))}
        </div>
      </div>
    </Drift>
  );
};

const Website: React.FC<{ frame: number; wide: boolean }> = ({ frame, wide }) => {
  const typed = Math.max(0, Math.min(CLINIC.url.length, Math.floor((frame - TYPE_FROM) / TYPE_STEP)));
  const done = typed === CLINIC.url.length;
  const doneAt = TYPE_FROM + CLINIC.url.length * TYPE_STEP;
  const W = wide ? 1920 : 1080;
  const boxW = wide ? 1300 : 1000;
  const top = wide ? 170 : 300;
  return (
    <Drift length={beats(19) - CUT} amount={0.04}>
      <div style={{ position: "absolute", left: (W - boxW) / 2, top, width: boxW, fontFamily: font, color: c.ink, textAlign: "center" }}>
        <div style={{ fontSize: wide ? 130 : 128, fontWeight: 600, letterSpacing: "-0.035em", lineHeight: 1.02 }}>
          <Reveal at={CUT + 2}>Just add your</Reveal>
          <Reveal at={CUT + 7}>
            <span style={accentText}>website.</span>
          </Reveal>
        </div>
        <div
          style={{
            marginTop: 64,
            height: 176,
            borderRadius: 999,
            background: c.paper,
            boxShadow: shadow,
            border: `1px solid ${c.line}`,
            display: "flex",
            alignItems: "center",
            padding: "0 22px 0 54px",
            ...rise(frame, CUT + 14),
          }}
        >
          <span style={{ fontSize: 66, fontWeight: 500, letterSpacing: tracked, color: typed ? c.ink : c.mist, whiteSpace: "nowrap" }}>{typed ? CLINIC.url.slice(0, typed) : "yourwebsite.com"}</span>
          {!done ? <span style={{ width: 5, height: 72, background: c.healdeskOrange, marginLeft: 4, borderRadius: 2 }} /> : null}
          <div style={{ flex: 1 }} />
          <div style={{ width: 132, height: 132, borderRadius: "50%", background: done ? accent : c.paper2, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
            {done ? (
              <Tick size={62} p={lerp(frame, [doneAt, doneAt + 10], [0, 1])} />
            ) : (
              <svg width="56" height="56" viewBox="0 0 24 24">
                <path d="M5 12h13M13 6l6 6-6 6" fill="none" stroke={c.grey} strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            )}
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 20, marginTop: 70, ...rise(frame, doneAt + 4) }}>
          <AyaAvatar size={100} ring />
          <span style={{ fontSize: 52, fontWeight: 500, color: c.grey }}>
            {LINES.learned} <b style={{ color: c.ink, fontWeight: 600 }}>{CLINIC.name}</b>
          </span>
        </div>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 20, marginTop: 44 }}>
          {CLINIC.treatments.map((t, i) => (
            <div key={t.name} style={{ ...rise(frame, LEARNED + i * 6), display: "flex", justifyContent: "space-between", width: wide ? 760 : 820, padding: "26px 44px", borderRadius: 999, background: c.paper2, fontSize: 56, fontWeight: 600 }}>
              <span>{t.name}</span>
              <span style={accentText}>{money(t.price)}</span>
            </div>
          ))}
        </div>
      </div>
    </Drift>
  );
};
