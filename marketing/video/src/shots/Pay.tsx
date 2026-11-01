import React from "react";
import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";

import { accent, color, easeOut, font, shadow } from "../brand";
import { Notification, Tick } from "../components/ui";
import { CLINIC, LINES, money } from "../copy";
import { ease, Push, settle, Stage, useLayout } from "../layout";
import { CUES, shot } from "../timeline.mjs";

const { press, paid, notify } = CUES.pay;
const AMOUNT = money(CLINIC.deposit, true);

/**
 * Seven beats on Apple's light grey. The deposit page Aya sends in the chat:
 * the clinic, "Appointment deposit", $100.00 and one button, through Stripe.
 * It names no treatment: none reaches Stripe. The button is pressed on the
 * beat, it is paid on the next, and healdesk's alert drops in on the one
 * after, an amount and a pointer into the portal, nothing more.
 */
export const Pay: React.FC = () => {
  const frame = useCurrentFrame();
  const { wide } = useLayout();
  const { from, to } = shot("pay");
  const W = wide ? 1920 : 1080;
  const cardW = wide ? 820 : 940;
  const drop = interpolate(frame, [notify, notify + 14], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: easeOut });
  const bannerW = wide ? 900 : 1000;
  return (
    <AbsoluteFill style={{ background: color.surface }}>
      <Stage>
        <Push length={to - from} amount={0.035}>
          <div style={{ position: "absolute", left: (W - cardW) / 2, top: wide ? 230 : 380, width: cardW, ...settle(frame, -10, 18, 90) }}>
            <Card frame={frame} />
          </div>
        </Push>
        {frame >= notify ? (
          <div style={{ position: "absolute", left: (W - bannerW) / 2, width: bannerW, top: interpolate(drop, [0, 1], [-300, wide ? 36 : 90]), filter: "drop-shadow(0 30px 40px rgba(0,0,0,0.12))" }}>
            <Notification app="healdesk" title={`${LINES.depositAlert} · ${AMOUNT}`} body={LINES.depositAlertBody} s={1.5} />
          </div>
        ) : null}
      </Stage>
    </AbsoluteFill>
  );
};

const Card: React.FC<{ frame: number }> = ({ frame }) => {
  const pressing = frame >= press && frame < press + 5;
  const loading = frame >= press + 2 && frame < paid;
  const done = frame >= paid;
  return (
    <div style={{ borderRadius: 56, background: color.white, boxShadow: shadow, padding: "56px 64px 48px", fontFamily: font, color: color.ink }}>
      <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
        <div style={{ width: 64, height: 64, borderRadius: "50%", background: "linear-gradient(135deg, #E9DED6, #C9B8AC)", color: color.white, fontSize: 34, fontWeight: 600, display: "flex", alignItems: "center", justifyContent: "center" }}>
          {CLINIC.name[0]}
        </div>
        <span style={{ fontSize: 40, fontWeight: 600, letterSpacing: "-0.015em" }}>{CLINIC.name}</span>
      </div>
      <div style={{ fontSize: 44, fontWeight: 500, color: color.grey, marginTop: 44, letterSpacing: "-0.01em" }}>{LINES.deposit}</div>
      <div style={{ fontSize: 190, fontWeight: 600, letterSpacing: "-0.03em", lineHeight: 1.05, marginTop: 6, fontVariantNumeric: "tabular-nums" }}>{AMOUNT}</div>
      <div
        style={{
          marginTop: 50,
          height: 150,
          borderRadius: 32,
          background: done ? accent : color.ink,
          color: color.white,
          fontSize: 56,
          fontWeight: 600,
          letterSpacing: "-0.01em",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 18,
          transform: `scale(${pressing ? 0.97 : 1})`,
        }}
      >
        {done ? (
          <>
            <Tick size={60} p={ease(frame, paid, paid + 10)} />
            Paid
          </>
        ) : loading ? (
          <div style={{ width: 58, height: 58, borderRadius: "50%", border: "7px solid rgba(255,255,255,0.28)", borderTopColor: color.white, transform: `rotate(${frame * 30}deg)` }} />
        ) : (
          <>Pay {AMOUNT}</>
        )}
      </div>
      <div style={{ marginTop: 34, textAlign: "center", fontSize: 34, fontWeight: 500, color: color.faint }}>
        Powered by <b style={{ color: "#635BFF", fontWeight: 700, letterSpacing: "-0.03em" }}>stripe</b>
      </div>
    </div>
  );
};
