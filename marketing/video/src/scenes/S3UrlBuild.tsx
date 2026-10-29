import React from "react";
import { interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";

import { CLINIC, money } from "../copy";
import { exit, lerp, Shell, Stage, tilt, useLayout, useSnap } from "../motion";
import { Backdrop, Bubble, Glass, Kinetic, Orb } from "../parts";
import { c, font, SNAP } from "../tokens";

const OPENER = `Hi! I'm Aya, ${CLINIC.name}'s AI assistant. Looking for Botox pricing, or would you like to book a consult?`;

/**
 * Scene 3, "Built from your URL", 180 frames. The orb drops into a
 * glass URL box and becomes its cursor; a URL types in; the box shatters and
 * the clinic's logo, colours, treatments and a chat in its colours assemble.
 */
export const S3UrlBuild: React.FC = () => {
  const frame = useCurrentFrame();
  const { wide } = useLayout();

  const typed = Math.max(0, Math.min(CLINIC.url.length, Math.floor((frame - 15) / 1.6)));
  const press = frame >= 46 && frame < 52 ? 4 : 0;
  const shimmer = lerp(frame, [50, 72], [-0.3, 1.3], (t) => t);
  const boxGone = exit(frame, 64, 10);
  const wash = lerp(frame, [60, 82], [0, 1]);
  const washBack = lerp(frame, [160, 180], [0, 1]);

  const boxW = wide ? 1100 : 900;
  const boxTop = wide ? 360 : 520;
  const W = wide ? 1920 : 1080;

  // The orb shrinks into the box's left edge and turns into the caret.
  const orbT = lerp(frame, [0, 14], [0, 1]);
  const orbFrom = wide ? { x: 1380, y: 520, s: 420 } : { x: 540, y: 700, s: 440 };
  const orbTo = { x: (W - boxW) / 2 + 60, y: boxTop + 150, s: 40 };

  return (
    <>
      {/* The clinic's sage washes in with the build and out again before the cut. */}
      <Backdrop mood="ivory" to="sage" mix={wash * (1 - washBack)} />
      <Shell duration={180} push={0.04}>
        <Stage>
          {frame < 16 ? (
            <div
              style={{
                position: "absolute",
                left: interpolate(orbT, [0, 1], [orbFrom.x, orbTo.x]) - interpolate(orbT, [0, 1], [orbFrom.s, orbTo.s]) / 2,
                top: interpolate(orbT, [0, 1], [orbFrom.y, orbTo.y]) - interpolate(orbT, [0, 1], [orbFrom.s, orbTo.s]) / 2,
                zIndex: 20,
              }}
            >
              <Orb size={interpolate(orbT, [0, 1], [orbFrom.s, orbTo.s])} />
            </div>
          ) : null}

          {frame < 76 ? (
            <div style={{ position: "absolute", left: (W - boxW) / 2, top: boxTop, width: boxW, opacity: boxGone, transform: `scale(${1 + (1 - boxGone) * 0.1})`, filter: boxGone < 1 ? `blur(${(1 - boxGone) * 10}px)` : undefined }}>
              <Kinetic text="Give me your website." at={2} stagger={2.4} style={{ fontWeight: 800, fontSize: wide ? 68 : 62, color: c.plum, textAlign: "center", marginBottom: 34, letterSpacing: "-0.02em" }} />
              <div style={tilt(frame, 4, 14)}>
                <Glass style={{ height: 150, display: "flex", alignItems: "center", padding: "0 40px", position: "relative", overflow: "hidden", background: "rgba(255,255,255,0.7)" }}>
                  <svg width="44" height="44" viewBox="0 0 24 24" style={{ marginRight: 18, flexShrink: 0 }}>
                    <circle cx="12" cy="12" r="9" fill="none" stroke={c.mist} strokeWidth="2" />
                    <path d="M3 12h18M12 3c3 3.5 3 14.5 0 18M12 3c-3 3.5-3 14.5 0 18" fill="none" stroke={c.mist} strokeWidth="1.6" />
                  </svg>
                  <span style={{ fontSize: 56, fontWeight: 500, color: typed ? c.plum : c.mist }}>{typed ? CLINIC.url.slice(0, typed) : "yourwebsite.com"}</span>
                  <span style={{ width: 4, height: 56, background: c.coral, marginLeft: 4, borderRadius: 2, opacity: frame < 14 ? 0 : Math.floor(frame / 8) % 2 === 0 || (frame > 15 && frame < 52) ? 1 : 0 }} />
                  <div style={{ position: "absolute", top: 0, bottom: 0, width: "40%", left: `${shimmer * 100 - 20}%`, background: "linear-gradient(90deg, rgba(255,122,89,0) 0%, rgba(255,122,89,0.5) 50%, rgba(255,122,89,0) 100%)" }} />
                </Glass>
              </div>
              <div style={{ display: "flex", justifyContent: "center", marginTop: 34, opacity: lerp(frame, [28, 38], [0, 1]), transform: `translateY(${(1 - lerp(frame, [28, 38], [0, 1])) * 20}px)` }}>
                <div style={{ background: c.coral, color: c.white, fontFamily: font, fontWeight: 800, fontSize: 40, padding: "22px 48px", borderRadius: 999, transform: `translateY(${press}px) scale(${press ? 0.97 : 1})`, boxShadow: press ? "0 4px 10px rgba(255,122,89,0.35)" : "0 18px 40px rgba(255,122,89,0.45), inset 0 1px 0 rgba(255,255,255,0.4)" }}>
                  Build my Aya →
                </div>
              </div>
            </div>
          ) : null}

          <Shards frame={frame} cx={W / 2} cy={boxTop + 170} />
          {frame >= 64 ? <Built frame={frame} wide={wide} /> : null}
        </Stage>
      </Shell>
    </>
  );
};

/** The box breaks into glass shards that fly outward. */
const Shards: React.FC<{ frame: number; cx: number; cy: number }> = ({ frame, cx, cy }) => {
  if (frame < 64 || frame > 94) return null;
  const t = lerp(frame, [64, 94], [0, 1]);
  return (
    <>
      {Array.from({ length: 30 }).map((_, i) => {
        const a = (i / 30) * Math.PI * 2 + i;
        const r = 40 + t * (300 + (i % 5) * 80);
        const s = 18 + (i % 4) * 10;
        return (
          <div
            key={i}
            style={{
              position: "absolute",
              left: cx + Math.cos(a) * r * 1.6,
              top: cy + Math.sin(a) * r * 0.75,
              width: s,
              height: s * 0.7,
              borderRadius: 6,
              background: i % 4 === 0 ? c.coral : "rgba(255,255,255,0.75)",
              boxShadow: "inset 0 1px 0 rgba(255,255,255,0.9), 0 6px 14px rgba(42,22,48,0.12)",
              transform: `rotate(${i * 37 + t * 200}deg)`,
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
  const { fps } = useVideoConfig();
  const logo = useSnap(68);
  const openerChars = Math.max(0, Math.min(OPENER.length, Math.floor((frame - 96) * 2.8)));
  const ask = useSnap(140);
  const answer = useSnap(154);
  const pulse = frame >= 156 ? Math.max(0, 1 - Math.abs(frame - 162) / 8) : 0;

  const leftCol = wide ? { left: 120, top: 120, width: 640 } : { left: 60, top: 50, width: 960 };
  const chat = wide ? { left: 860, top: 110, width: 940, height: 800 } : { left: 50, top: 470, width: 980, height: 780 };

  return (
    <>
      <div style={{ position: "absolute", ...leftCol }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: wide ? "flex-start" : "center", gap: 24, transform: `scale(${0.85 + 0.15 * logo})`, opacity: Math.min(1, logo), filter: `blur(${Math.max(0, 1 - logo) * 10}px)` }}>
          <ClinicMark size={wide ? 90 : 84} />
          <div style={{ fontFamily: "Georgia, 'Times New Roman', serif", fontSize: wide ? 60 : 58, color: c.sageDeep, letterSpacing: "0.01em" }}>{CLINIC.name}</div>
        </div>
        <div style={{ display: "flex", gap: 16, marginTop: 24, justifyContent: wide ? "flex-start" : "center" }}>
          {[c.sage, c.cream, c.sageDeep, c.gold].map((col, i) => {
            const p = spring({ frame: frame - (74 + i * 3), fps, config: SNAP });
            return <div key={col} style={{ width: 54, height: 54, borderRadius: "50%", background: col, border: "3px solid white", boxShadow: "0 6px 14px rgba(42,22,48,0.12)", transform: `scale(${p})` }} />;
          })}
        </div>
        <div style={{ display: "flex", flexDirection: wide ? "column" : "row", gap: wide ? 22 : 18, marginTop: wide ? 50 : 30 }}>
          {CLINIC.treatments.map((t, i) => {
            const p = spring({ frame: frame - (72 + i * 6), fps, config: SNAP });
            const hot = t.name === "Lip filler" ? pulse : 0;
            return (
              <Glass
                key={t.name}
                style={{
                  flex: wide ? undefined : 1,
                  padding: wide ? "24px 30px" : "20px 22px",
                  transform: `perspective(1200px) rotateY(${(1 - p) * -70}deg) translateX(${(1 - p) * -120}px) scale(${1 + hot * 0.06})`,
                  opacity: Math.min(1, p * 1.5),
                  boxShadow: hot ? `0 0 0 ${4 * hot}px ${c.coral}, 0 24px 48px rgba(42,22,48,0.12)` : undefined,
                  display: "flex",
                  flexDirection: wide ? "row" : "column",
                  justifyContent: "space-between",
                  alignItems: wide ? "center" : "flex-start",
                }}
              >
                <div style={{ fontWeight: 800, fontSize: wide ? 38 : 32 }}>{t.name}</div>
                <div style={{ fontWeight: 700, fontSize: wide ? 34 : 30, color: c.sageDeep, marginTop: wide ? 0 : 6 }}>{money(t.price)}</div>
              </Glass>
            );
          })}
        </div>
      </div>

      <div style={{ position: "absolute", ...chat, ...tilt(frame, 82, 22, 20) }}>
        <Glass style={{ width: "100%", height: "100%", borderRadius: 36, overflow: "hidden", display: "flex", flexDirection: "column", background: "rgba(255,255,255,0.55)" }}>
          <div style={{ background: c.sage, padding: "22px 30px", display: "flex", alignItems: "center", gap: 18 }}>
            <ClinicMark size={58} light />
            <div style={{ fontFamily: font, color: c.white }}>
              <div style={{ fontWeight: 800, fontSize: 32 }}>{CLINIC.name}</div>
              <div style={{ fontWeight: 500, fontSize: 24, opacity: 0.9 }}>Aya · AI assistant · online</div>
            </div>
          </div>
          <div style={{ flex: 1, padding: 30, display: "flex", flexDirection: "column", gap: 18 }}>
            {openerChars > 0 ? <Bubble from="aya" size={34}>{OPENER.slice(0, openerChars)}</Bubble> : null}
            {frame >= 140 ? (
              <Bubble from="patient" size={34} tint={c.sageDeep} style={{ transform: `scale(${0.9 + 0.1 * ask})`, opacity: Math.min(1, ask), transformOrigin: "100% 100%" }}>
                How much is lip filler?
              </Bubble>
            ) : null}
            {frame >= 154 ? (
              <Bubble from="aya" size={34} style={{ transform: `scale(${0.9 + 0.1 * answer})`, opacity: Math.min(1, answer), transformOrigin: "0 100%" }}>
                Lip filler is <b>{money(650)}</b>. Want me to book you a consult?
              </Bubble>
            ) : null}
          </div>
        </Glass>
      </div>
    </>
  );
};

/** The fictional clinic's mark: a leaf in a circle. */
export const ClinicMark: React.FC<{ size: number; light?: boolean }> = ({ size, light }) => (
  <div style={{ width: size, height: size, borderRadius: "50%", background: light ? c.white : c.sage, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
    <svg width={size * 0.56} height={size * 0.56} viewBox="0 0 24 24">
      <path d="M5 19C5 10 11 5 20 4c0 9-5 15-14 15z" fill={light ? c.sage : c.white} />
      <path d="M6 18c4-4 7-7 11-11" stroke={light ? c.white : c.sage} strokeWidth="1.6" fill="none" />
    </svg>
  </div>
);
