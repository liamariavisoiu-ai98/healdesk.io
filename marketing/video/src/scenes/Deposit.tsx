import React from "react";
import { interpolate, spring, useVideoConfig } from "remotion";

import { CHECKOUT, CLINIC, LINES, money } from "../copy";
import { lerp, Stage, useFrame, useLayout } from "../motion";
import { Backdrop, Notification, Tick } from "../parts";
import { accent, accentText, c, font, shadow, SNAP } from "../tokens";
import { rise } from "./Hello";

// Hard cut to the line on the seventh beat of the scene (128 BPM).
const CUT = 98;
const PAY = 34;
const PAID = 48;
const NOTIFY = 60;

/**
 * 0:29–0:35. One card: a $100.00 appointment deposit, one button, paid
 * through Stripe. The page names no treatment, as CLAUDE.md requires.
 * healdesk's notification lands. Then, cut on the beat, the line.
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
  const cardW = wide ? 760 : 880;
  const cardIn = lerp(frame, [0, 18], [0, 1]);
  const pressing = frame >= PAY && frame < PAY + 4;
  const loading = frame >= PAY + 2 && frame < PAID;
  const done = frame >= PAID;
  const amount = lerp(frame, [4, 24], [0, CLINIC.deposit]);
  return (
    <>
      <div
        style={{
          position: "absolute",
          left: (W - cardW) / 2,
          top: wide ? 190 : 380,
          width: cardW,
          padding: wide ? "48px 56px" : "56px 60px",
          borderRadius: 48,
          background: c.paper,
          boxShadow: shadow,
          border: `1px solid ${c.line}`,
          fontFamily: font,
          color: c.ink,
          opacity: cardIn,
          transform: `translateY(${(1 - cardIn) * 160}px)`,
        }}
      >
        <div style={{ fontSize: 34, fontWeight: 600, color: c.grey }}>{CLINIC.name}</div>
        <div style={{ fontSize: 40, fontWeight: 500, color: c.grey, marginTop: 30 }}>{CHECKOUT.descriptor}</div>
        <div style={{ fontSize: wide ? 150 : 168, fontWeight: 600, letterSpacing: "-0.04em", lineHeight: 1, marginTop: 8, fontVariantNumeric: "tabular-nums" }}>{money(Math.round(amount), true)}</div>
        <div
          style={{
            marginTop: 56,
            height: 132,
            borderRadius: 30,
            background: done ? accent : c.ink,
            color: "#fff",
            fontSize: 50,
            fontWeight: 600,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 18,
            transform: `scale(${pressing ? 0.97 : 1})`,
          }}
        >
          {done ? (
            <>
              <Tick size={54} p={lerp(frame, [PAID, PAID + 10], [0, 1])} />
              Paid
            </>
          ) : loading ? (
            <div style={{ width: 52, height: 52, borderRadius: "50%", border: "6px solid rgba(255,255,255,0.3)", borderTopColor: "#fff", transform: `rotate(${frame * 30}deg)` }} />
          ) : (
            <>Pay {money(CLINIC.deposit, true)}</>
          )}
        </div>
        <div style={{ marginTop: 26, display: "flex", justifyContent: "space-between", fontSize: 30, color: c.grey, fontWeight: 500 }}>
          <span>
            Powered by <b style={{ color: "#635BFF", fontWeight: 700, letterSpacing: "-0.02em" }}>stripe</b>
          </span>
          <span>{CHECKOUT.reference}</span>
        </div>
      </div>
      {frame >= NOTIFY ? <Banner frame={frame} wide={wide} /> : null}
    </>
  );
};

const Banner: React.FC<{ frame: number; wide: boolean }> = ({ frame, wide }) => {
  const { fps } = useVideoConfig();
  const p = spring({ frame: frame - NOTIFY, fps, config: SNAP });
  const width = wide ? 860 : 960;
  const W = wide ? 1920 : 1080;
  return (
    <div style={{ position: "absolute", left: (W - width) / 2, top: interpolate(p, [0, 1], [-220, wide ? 30 : 60]), zIndex: 60 }}>
      <Notification app="healdesk" title={`Deposit received · ${money(CLINIC.deposit, true)}`} body="Paid through Stripe · open your portal for details" time="now" width={width} scale={1.15} style={{ background: "rgba(255,255,255,0.92)", color: c.ink }} />
    </div>
  );
};

const Line: React.FC<{ frame: number; wide: boolean }> = ({ frame, wide }) => (
  <div style={{ position: "absolute", left: 0, right: 0, top: wide ? 380 : 560, textAlign: "center", fontFamily: font, fontWeight: 600, fontSize: wide ? 130 : 88, letterSpacing: "-0.035em", lineHeight: 1.08, color: c.ink }}>
    <div style={rise(frame, CUT + 2)}>{LINES.deposit[0]}</div>
    <div style={{ ...rise(frame, CUT + 14), ...accentText }}>{LINES.deposit[1]}</div>
  </div>
);
