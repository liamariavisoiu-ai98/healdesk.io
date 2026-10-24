import React from "react";
import { AbsoluteFill, interpolate, interpolateColors, useCurrentFrame } from "remotion";

import { CLINIC } from "../copy";
import { breathe, enter, enterStyle, exit, lerp, Stage, useLayout, useSnap } from "../motion";
import { Aya, Bubble, Glass } from "../parts";
import { c, font } from "../tokens";

const OPENER = `Hi! I'm AYA, ${CLINIC.name}'s AI assistant. Looking for Botox pricing, or would you like to book a consult?`;

/**
 * Scene 3, "Built from your URL", frames 270–450. A URL types in, the box
 * dissolves, and the clinic's logo, colours, treatments and a chat in its
 * colours build themselves.
 */
export const S3UrlBuild: React.FC = () => {
  const frame = useCurrentFrame();
  const { wide } = useLayout();

  const ayaOut = lerp(frame, [270, 286], [0, 1]);
  const typed = Math.max(0, Math.min(CLINIC.url.length, Math.floor((frame - 285) / 1.8)));
  const press = frame >= 316 && frame < 322 ? 3 : 0;
  const buttonIn = enter(frame, 300, 12);
  const shimmer = lerp(frame, [320, 342], [-0.3, 1.3], (t) => t);
  const boxGone = exit(frame, 334, 10);
  const wash = lerp(frame, [330, 352], [0, 1]);

  const boxW = wide ? 1100 : 900;
  const boxTop = wide ? 360 : 520;
  const W = wide ? 1920 : 1080;

  return (
    <>
      <AbsoluteFill style={{ background: interpolateColors(wash, [0, 1], [c.ivory, c.cream]) }} />
      <AbsoluteFill style={{ background: `radial-gradient(circle at 70% 20%, rgba(127,156,134,${0.35 * wash}) 0%, rgba(127,156,134,0) 55%)` }} />
      <Stage>
        {/* AYA steps aside. */}
        {frame < 288 ? (
          <div
            style={{
              position: "absolute",
              left: (wide ? 760 : -210) + ayaOut * 700,
              top: wide ? 300 : 320,
              opacity: 1 - ayaOut,
              WebkitMaskImage: "linear-gradient(180deg, #000 72%, transparent 96%)",
              maskImage: "linear-gradient(180deg, #000 72%, transparent 96%)",
            }}
          >
            <Aya width={wide ? 1150 : 1500} />
          </div>
        ) : null}

        {/* The URL box. */}
        {frame < 346 ? (
          <div style={{ position: "absolute", left: (W - boxW) / 2, top: boxTop, width: boxW, opacity: boxGone, transform: `scale(${0.96 + 0.04 * enter(frame, 272, 14) + (1 - boxGone) * 0.08})` }}>
            <div style={{ fontFamily: font, fontWeight: 800, fontSize: wide ? 64 : 60, color: c.plum, textAlign: "center", marginBottom: 34, letterSpacing: "-0.02em", ...enterStyle(enter(frame, 276, 14)) }}>
              Give me your website.
            </div>
            <Glass style={{ height: 150, display: "flex", alignItems: "center", padding: "0 40px", position: "relative", overflow: "hidden", background: "rgba(255,255,255,0.8)" }}>
              <span style={{ fontSize: 56, fontWeight: 500, color: typed ? c.plum : c.mist }}>{typed ? CLINIC.url.slice(0, typed) : "yourwebsite.com"}</span>
              <span style={{ width: 4, height: 54, background: c.plum, marginLeft: 4, opacity: Math.floor(frame / 8) % 2 === 0 || (frame > 285 && frame < 322) ? 1 : 0 }} />
              <div
                style={{
                  position: "absolute",
                  top: 0,
                  bottom: 0,
                  width: "40%",
                  left: `${shimmer * 100 - 20}%`,
                  background: `linear-gradient(90deg, rgba(255,122,89,0) 0%, rgba(255,122,89,0.55) 50%, rgba(255,122,89,0) 100%)`,
                }}
              />
            </Glass>
            <div style={{ display: "flex", justifyContent: "center", marginTop: 34, ...enterStyle(buttonIn) }}>
              <div
                style={{
                  background: c.coral,
                  color: c.white,
                  fontFamily: font,
                  fontWeight: 800,
                  fontSize: 40,
                  padding: "22px 48px",
                  borderRadius: 999,
                  transform: `translateY(${press}px)`,
                  boxShadow: press ? "0 4px 10px rgba(255,122,89,0.35)" : "0 14px 30px rgba(255,122,89,0.35)",
                }}
              >
                Build my AYA →
              </div>
            </div>
          </div>
        ) : null}

        <Particles frame={frame} cx={W / 2} cy={boxTop + 160} />

        {frame >= 334 ? <Built frame={frame} wide={wide} /> : null}
      </Stage>
    </>
  );
};

const Particles: React.FC<{ frame: number; cx: number; cy: number }> = ({ frame, cx, cy }) => {
  if (frame < 334 || frame > 362) return null;
  const t = lerp(frame, [334, 362], [0, 1]);
  return (
    <>
      {Array.from({ length: 28 }).map((_, i) => {
        const a = (i / 28) * Math.PI * 2 + i;
        const r = 40 + t * (260 + (i % 5) * 70);
        return (
          <div
            key={i}
            style={{
              position: "absolute",
              left: cx + Math.cos(a) * r * 1.6,
              top: cy + Math.sin(a) * r * 0.7,
              width: 12 + (i % 3) * 6,
              height: 12 + (i % 3) * 6,
              borderRadius: i % 2 ? "50%" : 4,
              background: i % 3 === 0 ? c.coral : i % 3 === 1 ? c.sage : c.gold,
              opacity: 1 - t,
            }}
          />
        );
      })}
    </>
  );
};

/** What the URL builds: logo, colours, three treatment cards and a chat in the clinic's colours. */
const Built: React.FC<{ frame: number; wide: boolean }> = ({ frame, wide }) => {
  const logo = useSnap(338);
  const chatIn = enter(frame, 352, 16);
  const openerChars = Math.max(0, Math.min(OPENER.length, Math.floor((frame - 366) * 2.6)));
  const ask = useSnap(416);
  const answer = useSnap(432);
  const pulse = frame >= 434 ? Math.max(0, 1 - Math.abs(frame - 440) / 8) : 0;

  const leftCol = wide ? { left: 120, top: 120, width: 640 } : { left: 60, top: 50, width: 960 };
  const chat = wide ? { left: 860, top: 110, width: 940, height: 800 } : { left: 50, top: 470, width: 980, height: 780 };

  return (
    <>
      <div style={{ position: "absolute", ...leftCol }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: wide ? "flex-start" : "center", gap: 24, transform: `scale(${0.9 + 0.1 * logo})`, opacity: Math.min(1, logo) }}>
          <ClinicMark size={wide ? 90 : 84} />
          <div style={{ fontFamily: "Georgia, 'Times New Roman', serif", fontSize: wide ? 60 : 58, color: c.sageDeep, letterSpacing: "0.01em" }}>{CLINIC.name}</div>
        </div>
        <div style={{ display: "flex", gap: 16, marginTop: 24, justifyContent: wide ? "flex-start" : "center" }}>
          {[c.sage, c.cream, c.sageDeep, c.gold].map((col, i) => {
            const p = useSnap(344 + i * 3);
            return <div key={col} style={{ width: 54, height: 54, borderRadius: "50%", background: col, border: "3px solid white", boxShadow: "0 6px 14px rgba(42,22,48,0.12)", transform: `scale(${p})` }} />;
          })}
        </div>
        <div style={{ display: "flex", flexDirection: wide ? "column" : "row", gap: wide ? 22 : 18, marginTop: wide ? 50 : 30 }}>
          {CLINIC.treatments.map((t, i) => {
            const p = useSnap(342 + i * 6);
            const hot = t.name === "Lip filler" ? pulse : 0;
            return (
              <Glass
                key={t.name}
                style={{
                  flex: wide ? undefined : 1,
                  padding: wide ? "24px 30px" : "20px 22px",
                  background: "rgba(255,255,255,0.8)",
                  transform: `translateX(${(1 - p) * -180}px) rotate(${(1 - p) * -12}deg) scale(${1 + hot * 0.06})`,
                  opacity: Math.min(1, p * 1.5),
                  boxShadow: hot ? `0 0 0 ${4 * hot}px ${c.coral}, 0 24px 48px rgba(42,22,48,0.12)` : undefined,
                  display: "flex",
                  flexDirection: wide ? "row" : "column",
                  justifyContent: "space-between",
                  alignItems: wide ? "center" : "flex-start",
                }}
              >
                <div style={{ fontWeight: 800, fontSize: wide ? 38 : 32 }}>{t.name}</div>
                <div style={{ fontWeight: 600, fontSize: wide ? 34 : 28, color: c.sageDeep, marginTop: wide ? 0 : 6 }}>{t.price}</div>
              </Glass>
            );
          })}
        </div>
      </div>

      <div style={{ position: "absolute", ...chat, ...enterStyle(chatIn, 40) }}>
        <div style={{ width: "100%", height: "100%", borderRadius: 34, overflow: "hidden", background: c.white, boxShadow: "0 30px 60px rgba(42,22,48,0.18)", display: "flex", flexDirection: "column", transform: `scale(${breathe(frame)})` }}>
          <div style={{ background: c.sage, padding: "22px 30px", display: "flex", alignItems: "center", gap: 18 }}>
            <ClinicMark size={58} light />
            <div style={{ fontFamily: font, color: c.white }}>
              <div style={{ fontWeight: 800, fontSize: 32 }}>{CLINIC.name}</div>
              <div style={{ fontWeight: 500, fontSize: 24, opacity: 0.9 }}>AYA · AI assistant · online</div>
            </div>
          </div>
          <div style={{ flex: 1, background: "#F6F2EA", padding: 30, display: "flex", flexDirection: "column", gap: 18 }}>
            {openerChars > 0 ? <Bubble from="aya" size={34}>{OPENER.slice(0, openerChars)}</Bubble> : null}
            {frame >= 416 ? (
              <Bubble from="patient" size={34} tint={c.sageDeep} style={{ transform: `scale(${0.9 + 0.1 * ask})`, opacity: Math.min(1, ask) }}>
                How much is lip filler?
              </Bubble>
            ) : null}
            {frame >= 432 ? (
              <Bubble from="aya" size={34} style={{ transform: `scale(${0.9 + 0.1 * answer})`, opacity: Math.min(1, answer) }}>
                Lip filler is <b>$650</b>. Want me to book you a consult?
              </Bubble>
            ) : null}
          </div>
        </div>
      </div>
    </>
  );
};

/** The fictional clinic's mark: a leaf in a circle. */
const ClinicMark: React.FC<{ size: number; light?: boolean }> = ({ size, light }) => (
  <div style={{ width: size, height: size, borderRadius: "50%", background: light ? c.white : c.sage, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
    <svg width={size * 0.56} height={size * 0.56} viewBox="0 0 24 24">
      <path d="M5 19C5 10 11 5 20 4c0 9-5 15-14 15z" fill={light ? c.sage : c.white} />
      <path d="M6 18c4-4 7-7 11-11" stroke={light ? c.white : c.sage} strokeWidth="1.6" fill="none" />
    </svg>
  </div>
);
