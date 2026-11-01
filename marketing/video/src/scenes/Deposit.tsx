import React from "react";
import { interpolate, spring, useVideoConfig } from "remotion";

import { beats, CHECKOUT, CLINIC, LINES, money } from "../copy";
import { Drift, lerp, Reveal, Stage, useFrame, useLayout } from "../motion";
import { Backdrop, Notification, Tick } from "../parts";
import { accent, accentText, c, font, shadow, SNAP } from "../tokens";

// The hard cut to the line on the seventh beat of the scene.
const CUT = beats(7);
const PAY = beats(2);
const PAID = beats(3);
const NOTIFY = beats(4);
const LENGTH = beats(12);

/**
 * 0:29.1–0:35. One card: a $100.00 appointment deposit, one button, paid
 * through Stripe. The page names no treatment, as CLAUDE.md requires, and the
 * price simply is there: it does not roll. healdesk's notification lands.
 * Then, cut on the beat, the line, large.
 */
export const Deposit: React.FC = () => {
  const frame = useFrame();
  const { wide } = useLayout();
  return (
    <>
      <Backdrop mood="white" />
      <Stage>{frame < CUT ? <Pay frame={frame} wide={wide} /> : <Line frame={frame} wide={wide} />}</Stage>
    </>
  );
};

const Pay: React.FC<{ frame: number; wide: boolean }> = ({ frame, wide }) => {
  const W = wide ? 1920 : 1080;
  const cardW = wide ? 860 : 980;
  const cardIn = lerp(frame, [0, 16], [0, 1]);
  const pressing = frame >= PAY && frame < PAY + 4;
  const loading = frame >= PAY + 2 && frame < PAID;
  const done = frame >= PAID;
  return (
    <Drift length={CUT} amount={0.04}>
      <div
        style={{
          position: "absolute",
          left: (W - cardW) / 2,
          top: wide ? 210 : 420,
          width: cardW,
          padding: wide ? "56px 64px" : "64px 70px",
          borderRadius: 56,
          background: c.paper,
          boxShadow: shadow,
          border: `1px solid ${c.line}`,
          fontFamily: font,
          color: c.ink,
          opacity: cardIn,
          transform: `translateY(${(1 - cardIn) * 140}px)`,
        }}
      >
        <div style={{ fontSize: 50, fontWeight: 600, color: c.grey }}>{CHECKOUT.descriptor}</div>
        <div style={{ fontSize: wide ? 190 : 210, fontWeight: 600, letterSpacing: "-0.045em", lineHeight: 1, marginTop: 14 }}>{money(CLINIC.deposit, true)}</div>
        <div
          style={{
            marginTop: 60,
            height: 156,
            borderRadius: 36,
            background: done ? accent : c.ink,
            color: "#fff",
            fontSize: 62,
            fontWeight: 600,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 20,
            transform: `scale(${pressing ? 0.97 : 1})`,
          }}
        >
          {done ? (
            <>
              <Tick size={64} p={lerp(frame, [PAID, PAID + 10], [0, 1])} />
              Paid
            </>
          ) : loading ? (
            <div style={{ width: 60, height: 60, borderRadius: "50%", border: "7px solid rgba(255,255,255,0.3)", borderTopColor: "#fff", transform: `rotate(${frame * 30}deg)` }} />
          ) : (
            <>Pay {money(CLINIC.deposit, true)}</>
          )}
        </div>
        <div style={{ marginTop: 34, textAlign: "center", fontSize: 40, color: c.grey, fontWeight: 500 }}>
          {CLINIC.name} · <b style={{ color: "#635BFF", fontWeight: 700, letterSpacing: "-0.02em" }}>stripe</b>
        </div>
      </div>
      {frame >= NOTIFY ? <Banner frame={frame} wide={wide} /> : null}
    </Drift>
  );
};

const Banner: React.FC<{ frame: number; wide: boolean }> = ({ frame, wide }) => {
  const { fps } = useVideoConfig();
  const p = spring({ frame: frame - NOTIFY, fps, config: SNAP });
  const width = wide ? 980 : 1000;
  const W = wide ? 1920 : 1080;
  return (
    <div style={{ position: "absolute", left: (W - width) / 2, top: interpolate(p, [0, 1], [-260, wide ? 24 : 90]), zIndex: 60 }}>
      <Notification app="healdesk" title={`Deposit received · ${money(CLINIC.deposit, true)}`} body="Open your portal for details" time="now" width={width} scale={1.5} style={{ background: "rgba(255,255,255,0.95)", color: c.ink }} />
    </div>
  );
};

const Line: React.FC<{ frame: number; wide: boolean }> = ({ wide }) => {
  const lines = wide ? [[LINES.deposit[0], false], [LINES.deposit[1], true]] : [["You do the", false], ["treatments.", false], ["Aya handles", true], ["the rush.", true]];
  return (
    <Drift length={LENGTH - CUT} amount={0.05}>
      <div style={{ position: "absolute", left: 0, right: 0, top: wide ? 330 : 360, textAlign: "center", fontFamily: font, fontWeight: 600, fontSize: wide ? 150 : 158, letterSpacing: "-0.04em", lineHeight: 1.02, color: c.ink }}>
        {lines.map(([text, hot], i) => (
          <Reveal key={String(text)} at={CUT + 2 + i * 4}>
            <span style={hot ? accentText : undefined}>{text}</span>
          </Reveal>
        ))}
      </div>
    </Drift>
  );
};
