import React from "react";
import { interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";

import { CHECKOUT, CLINIC, money } from "../copy";
import { lerp, Shell, Stage, tilt, useLayout } from "../motion";
import { Backdrop, Bubble, DollarBurst, Glass, Icon, Lock, Notification, Tick } from "../parts";
import { c, font, SNAP } from "../tokens";
import { ClinicMark } from "./S3UrlBuild";

const STRIPE = "#635BFF";
const TAP = 22;
const SHEET = 26;
const PAY = 64;
const PAID = 76;
const NOTIFY = 84;
const SHEET_OUT = 94;

/**
 * Scene 5, the deposit, 120 frames. In the website chat Aya sends
 * the clinic's own payment link; the patient pays $100.00 on Stripe's
 * checkout; the money lands. The checkout shows only the clinic, an amount,
 * a generic descriptor and a reference: the treatment never reaches Stripe.
 */
export const S5Deposit: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const { wide } = useLayout();

  const chat = wide ? { x: 140, y: 150, w: 780, h: 780 } : { x: 70, y: 150, w: 940, h: 1060 };
  const sheetBox = wide ? { x: 1000, y: 110, w: 780, h: 860 } : { x: 70, y: 330, w: 940, h: 900 };
  const sheetIn = spring({ frame: frame - SHEET, fps, config: { damping: 16, stiffness: 130 } });
  const sheetOut = lerp(frame, [SHEET_OUT, SHEET_OUT + 14], [0, 1]);
  const paid = frame >= PAID;

  return (
    <>
      <Backdrop mood="ivory" />
      <Shell duration={120} push={0.04}>
        <Stage>
          {/* The website chat. */}
          <div style={{ position: "absolute", left: chat.x, top: chat.y, width: chat.w, height: chat.h, ...tilt(frame, 0, 10), transformOrigin: "50% 0" }}>
            <Glass style={{ width: "100%", height: "100%", borderRadius: 36, overflow: "hidden", display: "flex", flexDirection: "column", filter: !wide && sheetIn > 0.05 && sheetOut < 1 ? `blur(${4 * Math.min(1, sheetIn) * (1 - sheetOut)}px)` : undefined }}>
              <div style={{ background: c.sage, padding: "20px 28px", display: "flex", alignItems: "center", gap: 16 }}>
                <ClinicMark size={54} light />
                <div style={{ fontFamily: font, color: c.white }}>
                  <div style={{ fontWeight: 800, fontSize: 30 }}>{CLINIC.name}</div>
                  <div style={{ fontWeight: 500, fontSize: 22, opacity: 0.9 }}>Website chat · Aya · AI assistant</div>
                </div>
              </div>
              <div style={{ flex: 1, padding: 28, display: "flex", flexDirection: "column", gap: 16 }}>
                <Bubble from="patient" size={30} tint={c.sageDeep}>First time. Can I book a HydraFacial?</Bubble>
                <Bubble from="aya" size={30}>It's {money(199)}. Monday 10:30 AM? Booked ✓</Bubble>
                <Appear at={4}>
                  <Bubble from="aya" size={30}>A {money(CLINIC.deposit)} deposit holds your spot. Here's the clinic's secure link:</Bubble>
                </Appear>
                <Appear at={10}>
                  <PayLink frame={frame} paid={paid && sheetOut > 0.5} />
                </Appear>
              </div>
            </Glass>
          </div>

          {/* Stripe's checkout slides up over the chat. */}
          {frame >= SHEET && sheetOut < 1 ? (
            <div
              style={{
                position: "absolute",
                left: sheetBox.x,
                top: sheetBox.y,
                width: sheetBox.w,
                height: sheetBox.h,
                transform: wide
                  ? `perspective(1800px) translateX(${(1 - sheetIn) * 300 + sheetOut * 200}px) rotateY(${(1 - sheetIn) * -25}deg)`
                  : `translateY(${(1 - sheetIn) * 900 + sheetOut * 1100}px)`,
                opacity: Math.min(1, sheetIn * 1.5) * (1 - sheetOut),
                zIndex: 20,
              }}
            >
              <Checkout frame={frame} />
            </div>
          ) : null}

          <DollarBurst at={PAID} x={wide ? 1390 : 540} y={wide ? 330 : 560} count={16} />

          {frame >= NOTIFY ? <Banner frame={frame} wide={wide} /> : null}
        </Stage>
      </Shell>
    </>
  );
};

const Appear: React.FC<{ at: number; children: React.ReactNode }> = ({ at, children }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const p = spring({ frame: frame - at, fps, config: SNAP });
  if (frame < at) return null;
  return <div style={{ display: "flex", flexDirection: "column", transform: `scale(${0.85 + 0.15 * p})`, transformOrigin: "0 100%", opacity: Math.min(1, p) }}>{children}</div>;
};

/** The payment link Aya sends, and what it becomes once paid. */
const PayLink: React.FC<{ frame: number; paid: boolean }> = ({ frame, paid }) => {
  const ripple = lerp(frame, [TAP, TAP + 14], [0, 1]);
  return (
    <div style={{ position: "relative", alignSelf: "flex-start", width: "88%" }}>
      <div
        style={{
          background: paid ? c.coral : "rgba(255,255,255,0.95)",
          color: paid ? c.white : c.plum,
          borderRadius: 24,
          padding: "18px 22px",
          fontFamily: font,
          boxShadow: "0 12px 28px rgba(42,22,48,0.12)",
          display: "flex",
          alignItems: "center",
          gap: 16,
        }}
      >
        {paid ? (
          <>
            <Tick size={40} />
            <div style={{ fontWeight: 800, fontSize: 32 }}>Deposit received · {money(CLINIC.deposit, true)}</div>
          </>
        ) : (
          <>
            <Icon name="stripe.webp" size={56} style={{ borderRadius: "50%" }} />
            <div style={{ flex: 1 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, fontWeight: 800, fontSize: 28 }}>
                <Lock size={24} /> Secure deposit · {money(CLINIC.deposit, true)}
              </div>
              <div style={{ fontWeight: 500, fontSize: 20, color: c.plumSoft }}>checkout.stripe.com · {CLINIC.name}</div>
            </div>
            <span style={{ background: STRIPE, color: c.white, fontWeight: 700, fontSize: 24, padding: "10px 18px", borderRadius: 999 }}>Pay</span>
          </>
        )}
      </div>
      {frame >= TAP && frame < TAP + 14 ? (
        <div style={{ position: "absolute", right: 46, top: "50%", width: 70, height: 70, marginRight: -35, marginTop: -35, borderRadius: "50%", background: "rgba(99,91,255,0.25)", border: `3px solid ${STRIPE}`, transform: `scale(${0.3 + ripple * 1.5})`, opacity: 1 - ripple }} />
      ) : null}
    </div>
  );
};

/** Stripe-style checkout: clinic, descriptor, amount, card, pay. */
const Checkout: React.FC<{ frame: number }> = ({ frame }) => {
  const { fps } = useVideoConfig();
  const amount = lerp(frame, [SHEET + 4, SHEET + 22], [0, CLINIC.deposit]);
  const card = "•••• •••• •••• 4242";
  const typed = Math.max(0, Math.min(card.length, Math.floor((frame - 40) * 1.4)));
  const expiry = frame >= 56;
  const pressing = frame >= PAY && frame < PAY + 4;
  const loading = frame >= PAY + 2 && frame < PAID;
  const done = frame >= PAID;
  const check = spring({ frame: frame - PAID, fps, config: SNAP });

  return (
    <div style={{ width: "100%", height: "100%", borderRadius: 36, overflow: "hidden", background: "rgba(255,255,255,0.94)", boxShadow: "0 40px 90px rgba(42,22,48,0.28), inset 0 1px 0 #fff", fontFamily: font, color: "#1A1F36", display: "flex", flexDirection: "column", padding: "34px 40px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
        <ClinicMark size={46} />
        <div style={{ fontWeight: 700, fontSize: 28 }}>{CLINIC.name}</div>
      </div>
      <div style={{ marginTop: 34, fontSize: 26, fontWeight: 600, color: "#697386" }}>{CHECKOUT.descriptor}</div>
      <div style={{ fontSize: 104, fontWeight: 800, letterSpacing: "-0.03em", lineHeight: 1.05, fontVariantNumeric: "tabular-nums" }}>{money(Math.round(amount), true)}</div>

      <Field label="Email" value={CHECKOUT.email} />
      <div style={{ marginTop: 22, fontSize: 22, fontWeight: 600, color: "#697386" }}>Card information</div>
      <div style={{ marginTop: 8, border: "2px solid #E3E8EE", borderRadius: 14, overflow: "hidden" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "16px 18px", fontSize: 30, fontWeight: 500, borderBottom: "2px solid #E3E8EE", minHeight: 40 }}>
          <span style={{ letterSpacing: "0.04em" }}>{card.slice(0, typed)}{frame >= 40 && typed < card.length ? <span style={{ color: STRIPE }}>|</span> : null}</span>
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
          height: 92,
          borderRadius: 16,
          background: done ? "#1EA672" : STRIPE,
          color: "#fff",
          fontSize: 34,
          fontWeight: 700,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 14,
          transform: `scale(${pressing ? 0.97 : 1})`,
          boxShadow: "0 12px 26px rgba(99,91,255,0.35), inset 0 1px 0 rgba(255,255,255,0.35)",
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
    <div style={{ marginTop: 26, fontSize: 22, fontWeight: 600, color: "#697386" }}>{label}</div>
    <div style={{ marginTop: 8, border: "2px solid #E3E8EE", borderRadius: 14, padding: "16px 18px", fontSize: 30, fontWeight: 500 }}>{value}</div>
  </>
);

const Banner: React.FC<{ frame: number; wide: boolean }> = ({ frame, wide }) => {
  const { fps } = useVideoConfig();
  const p = spring({ frame: frame - NOTIFY, fps, config: { damping: 14, stiffness: 160 } });
  const width = wide ? 820 : 900;
  const W = wide ? 1920 : 1080;
  return (
    <div style={{ position: "absolute", left: (W - width) / 2, top: interpolate(p, [0, 1], [-200, wide ? 30 : 20]), zIndex: 60, filter: p < 0.9 ? `blur(${(1 - p) * 8}px)` : undefined }}>
      <Notification app="healdesk" title={`Deposit received · ${money(CLINIC.deposit, true)}`} body="Paid through Stripe · open your portal for details" time="now" width={width} />
    </div>
  );
};
