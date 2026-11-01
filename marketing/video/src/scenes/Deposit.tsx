import React from "react";
import { interpolate, spring, useVideoConfig } from "remotion";

import { CHECKOUT, CLINIC, LINES, money } from "../copy";
import { lerp, Shell, Stage, useFrame, useLayout } from "../motion";
import { Backdrop, ClinicMark, DollarBurst, Kinetic, Notification, Tick } from "../parts";
import { c, font, SNAP, tracked } from "../tokens";

const STRIPE = "#635BFF";
const TYPE = 22;
const PAY = 46;
const PAID = 58;
const NOTIFY = 74;
const LINE = 84;

/**
 * 0:35–0:40. Stripe's checkout slides down: a $100.00 deposit, paid. The
 * page shows only the clinic, "Appointment deposit", the amount and a
 * reference, because no treatment name may reach Stripe. healdesk's
 * notification pops: "Deposit received · $100.00". Then the line.
 */
export const Deposit: React.FC = () => {
  const frame = useFrame();
  const { fps } = useVideoConfig();
  const { wide } = useLayout();

  const sheetIn = spring({ frame, fps, config: { damping: 20, stiffness: 120 } });
  const sheetBack = lerp(frame, [NOTIFY - 6, NOTIFY + 12], [0, 1]);
  const sheet = wide ? { x: 160, y: 120, w: 760, h: 840 } : { x: 120, y: 160, w: 840, h: 900 };

  return (
    <>
      <Backdrop mood="white" />
      <Shell duration={150} push={0.03}>
        <Stage>
          <div
            style={{
              position: "absolute",
              left: sheet.x,
              top: sheet.y,
              width: sheet.w,
              height: sheet.h,
              transform: `translateY(${(1 - sheetIn) * -1100}px) scale(${1 - sheetBack * (wide ? 0.06 : 0.1)})`,
              transformOrigin: "50% 0",
              opacity: 1 - sheetBack * 0.25,
              filter: sheetBack > 0 ? `blur(${sheetBack * 3}px)` : undefined,
            }}
          >
            <Checkout frame={frame} />
          </div>

          <DollarBurst at={PAID} x={sheet.x + sheet.w / 2} y={sheet.y + sheet.h - 120} count={16} />

          {frame >= NOTIFY ? <Banner frame={frame} wide={wide} /> : null}

          <div
            style={
              wide
                ? { position: "absolute", left: 1000, top: 360, width: 800, textAlign: "left" }
                : { position: "absolute", left: 40, top: 1110, width: 1000, textAlign: "center" }
            }
          >
            <Kinetic
              text={LINES.deposit}
              at={LINE}
              stagger={3}
              highlight={["Aya", "handles", "the", "rush."]}
              style={{ fontWeight: 600, fontSize: wide ? 84 : 72, letterSpacing: tracked, lineHeight: 1.08, color: c.plum }}
            />
          </div>
        </Stage>
      </Shell>
    </>
  );
};

/** Stripe-style checkout: clinic, descriptor, amount, card, pay. */
const Checkout: React.FC<{ frame: number }> = ({ frame }) => {
  const { fps } = useVideoConfig();
  const amount = lerp(frame, [4, 20], [0, CLINIC.deposit]);
  const card = "•••• •••• •••• 4242";
  const typed = Math.max(0, Math.min(card.length, Math.floor((frame - TYPE) * 1.4)));
  const expiry = frame >= TYPE + 14;
  const pressing = frame >= PAY && frame < PAY + 4;
  const loading = frame >= PAY + 2 && frame < PAID;
  const done = frame >= PAID;
  const check = spring({ frame: frame - PAID, fps, config: SNAP });

  return (
    <div style={{ width: "100%", height: "100%", borderRadius: 40, overflow: "hidden", background: "rgba(255,255,255,0.92)", backdropFilter: "blur(30px)", boxShadow: "0 50px 100px rgba(42,22,48,0.22), inset 0 1px 0 #fff", fontFamily: font, color: "#1A1F36", display: "flex", flexDirection: "column", padding: "36px 42px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
        <ClinicMark size={46} />
        <div style={{ fontWeight: 600, fontSize: 28, letterSpacing: tracked }}>{CLINIC.name}</div>
      </div>
      <div style={{ marginTop: 34, fontSize: 26, fontWeight: 500, color: "#697386" }}>{CHECKOUT.descriptor}</div>
      <div style={{ fontSize: 110, fontWeight: 600, letterSpacing: "-0.03em", lineHeight: 1.05, fontVariantNumeric: "tabular-nums" }}>{money(Math.round(amount), true)}</div>

      <Field label="Email" value={CHECKOUT.email} />
      <div style={{ marginTop: 22, fontSize: 22, fontWeight: 500, color: "#697386" }}>Card information</div>
      <div style={{ marginTop: 8, border: "2px solid #E3E8EE", borderRadius: 14, overflow: "hidden" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "16px 18px", fontSize: 30, fontWeight: 500, borderBottom: "2px solid #E3E8EE", minHeight: 40 }}>
          <span style={{ letterSpacing: "0.04em" }}>
            {card.slice(0, typed)}
            {frame >= TYPE && typed < card.length ? <span style={{ color: STRIPE }}>|</span> : null}
          </span>
          <span style={{ background: "#1A1F71", color: "#fff", fontWeight: 800, fontStyle: "italic", fontSize: 20, padding: "4px 10px", borderRadius: 6, opacity: typed > 4 ? 1 : 0.2 }}>VISA</span>
        </div>
        <div style={{ display: "flex", fontSize: 30, fontWeight: 500 }}>
          <div style={{ flex: 1, padding: "16px 18px", borderRight: "2px solid #E3E8EE", color: expiry ? "#1A1F36" : "#A3ACB9" }}>{expiry ? "12 / 28" : "MM / YY"}</div>
          <div style={{ flex: 1, padding: "16px 18px", color: expiry ? "#1A1F36" : "#A3ACB9" }}>{expiry ? "•••" : "CVC"}</div>
        </div>
      </div>

      <div style={{ flex: 1 }} />
      <div
        style={{
          height: 96,
          borderRadius: 18,
          background: done ? "#1EA672" : STRIPE,
          color: "#fff",
          fontSize: 34,
          fontWeight: 600,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 14,
          transform: `scale(${pressing ? 0.97 : 1})`,
          boxShadow: "0 14px 30px rgba(99,91,255,0.32), inset 0 1px 0 rgba(255,255,255,0.35)",
        }}
      >
        {done ? (
          <>
            <span style={{ transform: `scale(${check})`, display: "inline-flex" }}>
              <Tick size={40} p={Math.min(1, check)} />
            </span>
            Paid {money(CLINIC.deposit, true)}
          </>
        ) : loading ? (
          <div style={{ width: 38, height: 38, borderRadius: "50%", border: "5px solid rgba(255,255,255,0.35)", borderTopColor: "#fff", transform: `rotate(${frame * 30}deg)` }} />
        ) : (
          <>Pay {money(CLINIC.deposit, true)}</>
        )}
      </div>
      <div style={{ marginTop: 18, display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 20, color: "#697386" }}>
        <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
          Powered by <b style={{ color: STRIPE, fontSize: 26, letterSpacing: "-0.02em" }}>stripe</b>
        </span>
        <span>{CHECKOUT.reference}</span>
      </div>
    </div>
  );
};

const Field: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <>
    <div style={{ marginTop: 26, fontSize: 22, fontWeight: 500, color: "#697386" }}>{label}</div>
    <div style={{ marginTop: 8, border: "2px solid #E3E8EE", borderRadius: 14, padding: "16px 18px", fontSize: 30, fontWeight: 500 }}>{value}</div>
  </>
);

const Banner: React.FC<{ frame: number; wide: boolean }> = ({ frame, wide }) => {
  const { fps } = useVideoConfig();
  const p = spring({ frame: frame - NOTIFY, fps, config: { damping: 14, stiffness: 170 } });
  const width = wide ? 820 : 920;
  const W = wide ? 1920 : 1080;
  return (
    <div style={{ position: "absolute", left: (W - width) / 2, top: interpolate(p, [0, 1], [-220, wide ? 30 : 40]), zIndex: 60, filter: p < 0.9 ? `blur(${(1 - p) * 8}px)` : undefined }}>
      <Notification app="healdesk" title={`Deposit received · ${money(CLINIC.deposit, true)}`} body="Paid through Stripe · open your portal for details" time="now" width={width} />
    </div>
  );
};
