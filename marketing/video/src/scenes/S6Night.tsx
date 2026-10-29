import React from "react";
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";

import { CLINIC, money } from "../copy";
import { lerp, Shell, Stage, useLayout } from "../motion";
import { Backdrop, Kinetic, Notification, Phone } from "../parts";
import { c, font } from "../tokens";

const TIMES: readonly [number, string, string][] = [
  [0, "6:58", "Tuesday, October 28"],
  [30, "11:48", "Tuesday, October 28"],
  [58, "2:15", "Wednesday, October 29"],
  [86, "7:02", "Wednesday, October 29"],
];

// What healdesk tells the clinic about a single patient is a pointer into the
// portal: an amount and a channel, never a name, a time or a treatment (the
// spec's email rules). Only the morning summary adds up totals.
const OVERNIGHT = [
  { at: 32, title: `New booking · ${money(199)}`, body: "From Instagram · open your portal", time: "11:48 PM" },
  { at: 60, title: `Deposit received · ${money(CLINIC.deposit, true)}`, body: "From website chat · open your portal", time: "2:15 AM" },
  { at: 88, title: `3 new bookings overnight · ${money(300)} in deposits`, body: `Booked value ${money(697)}`, time: "7:02 AM" },
];

/**
 * Scene 6, the dream outcome, 150 frames. The clinic closes; the
 * night passes on the owner's lock screen; healdesk's notifications arrive
 * one by one, and the morning brings the summary.
 */
export const S6Night: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const { wide } = useLayout();

  const night = lerp(frame, [0, 22], [0, 1]);
  const dawn = lerp(frame, [80, 112], [0, 1]);
  const toIvory = lerp(frame, [138, 150], [0, 1]);

  const phoneW = wide ? 430 : 520;
  const phoneX = wide ? 1240 : (1080 - phoneW) / 2;
  const phoneY = wide ? 80 : 300;
  const phoneIn = spring({ frame: frame - 4, fps, config: { damping: 16 } });

  const step = [...TIMES].reverse().find(([at]) => frame >= at) ?? TIMES[0];
  const sinceStep = frame - step[0];
  const timeFocus = Math.min(1, sinceStep / 8);

  return (
    <>
      <Backdrop mood="dusk" to="dawn" mix={dawn} />
      <AbsoluteFill style={{ opacity: Math.max(1 - night, toIvory) }}>
        <Backdrop mood="ivory" />
      </AbsoluteFill>
      <Shell duration={150} push={0.05} enterBlur>
        <Stage>
          <div
            style={{
              position: "absolute",
              left: phoneX,
              top: phoneY,
              transform: `perspective(1800px) translateY(${(1 - phoneIn) * 300}px) rotateX(${(1 - phoneIn) * 30 + Math.sin(frame / 45) * 2}deg) rotateY(${(wide ? -10 : 0) + Math.cos(frame / 60) * 3}deg)`,
              opacity: Math.min(1, phoneIn * 1.4),
            }}
          >
            <Phone width={phoneW} screen={`linear-gradient(180deg, ${interpolateHex("#1D2442", "#5A3A55", dawn)} 0%, ${interpolateHex("#0E1020", "#E8A27A", dawn)} 100%)`}>
              <div style={{ position: "absolute", top: phoneW * 0.15, width: "100%", textAlign: "center", fontFamily: font, color: "#F4EEF6" }}>
                <div style={{ fontSize: phoneW * 0.05, fontWeight: 600, opacity: 0.75 }}>{step[2]}</div>
                <div style={{ fontSize: phoneW * 0.23, fontWeight: 800, letterSpacing: "-0.03em", lineHeight: 1, filter: `blur(${(1 - timeFocus) * 8}px)`, opacity: 0.4 + 0.6 * timeFocus }}>{step[1]}</div>
              </div>
              <div style={{ position: "absolute", left: phoneW * 0.04, right: phoneW * 0.04, top: phoneW * 0.62 }}>
                {OVERNIGHT.map((n, i) => {
                  const p = spring({ frame: frame - n.at, fps, config: { damping: 13, stiffness: 160 } });
                  if (frame < n.at) return null;
                  const newer = OVERNIGHT.filter((m) => frame >= m.at).length - 1 - i;
                  const last = i === OVERNIGHT.length - 1;
                  return (
                    <div
                      key={i}
                      style={{
                        position: "absolute",
                        left: 0,
                        right: 0,
                        top: newer * phoneW * 0.25,
                        transform: `translateY(${(1 - p) * -80}px) scale(${(0.85 + 0.15 * Math.min(1, p)) * (last ? 1.02 : 1)})`,
                        opacity: Math.min(1, p * 1.5),
                        filter: p < 0.9 ? `blur(${(1 - p) * 8}px)` : undefined,
                        zIndex: 10 + i,
                      }}
                    >
                      <Notification dark app="healdesk" title={n.title} body={n.body} time={n.time} width={phoneW * 0.92} scale={phoneW / 560} style={last ? { boxShadow: `0 0 0 2px ${c.coral}, 0 20px 50px rgba(255,122,89,0.45)` } : undefined} />
                    </div>
                  );
                })}
              </div>
            </Phone>
          </div>

          <div style={{ position: "absolute", left: wide ? 120 : 60, top: wide ? 330 : 90, width: wide ? 960 : 960, textAlign: wide ? "left" : "center" }}>
            <Kinetic
              text="You do the treatments. Aya handles the rush."
              at={98}
              stagger={1.8}
              highlight={["Aya", "handles", "the", "rush"]}
              style={{ fontWeight: 800, fontSize: wide ? 88 : 76, lineHeight: 1.05, letterSpacing: "-0.02em", color: c.white, textShadow: "0 10px 40px rgba(0,0,0,0.35)" }}
            />
          </div>
          {/* The lamp goes off: a warm glow that dies as the night comes in. */}
          <div style={{ position: "absolute", left: wide ? 300 : 140, top: wide ? -200 : -100, width: 800, height: 800, borderRadius: "50%", background: "radial-gradient(circle, rgba(255,214,150,0.55) 0%, rgba(255,214,150,0) 65%)", opacity: interpolate(frame, [0, 18, 24], [1, 1, 0], { extrapolateRight: "clamp" }), pointerEvents: "none" }} />
        </Stage>
      </Shell>
    </>
  );
};

function interpolateHex(a: string, b: string, t: number): string {
  const pa = [1, 3, 5].map((i) => parseInt(a.slice(i, i + 2), 16));
  const pb = [1, 3, 5].map((i) => parseInt(b.slice(i, i + 2), 16));
  return "#" + pa.map((v, i) => Math.round(v + (pb[i] - v) * t).toString(16).padStart(2, "0")).join("");
}
