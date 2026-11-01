import React from "react";
import { spring, useVideoConfig } from "remotion";

import { CLINIC, LINES, money } from "../copy";
import { Shell, Stage, tilt, useFrame, useLayout } from "../motion";
import { Backdrop, ClinicMark, Glass, Kinetic, Orb, Tick } from "../parts";
import { c, font, SNAP, tracked } from "../tokens";

const TYPE_FROM = 128;
const TYPE_STEP = 2.4;
const LEARNED = 186;

/**
 * 0:15–0:25. On frosted white the orb that stands for Aya floats up and
 * breathes. "Hi, I'm Aya, your 24/7 assistant." Two badges. Then a website
 * box fills itself in with bellaskinstudio.com, and what she learned from it
 * settles underneath.
 */
export const Hello: React.FC = () => {
  const frame = useFrame();
  const { fps } = useVideoConfig();
  const { wide } = useLayout();

  const orb = wide ? { x: 480, y: 520, s: 440 } : { x: 540, y: 330, s: 380 };
  const float = spring({ frame, fps, config: { damping: 22, stiffness: 60, mass: 1.2 } });
  const typed = Math.max(0, Math.min(CLINIC.url.length, Math.floor((frame - TYPE_FROM) / TYPE_STEP)));
  const done = typed === CLINIC.url.length;
  const speaking = frame > 26 && frame < 110 ? 0.4 + 0.4 * Math.abs(Math.sin(frame * 0.4)) : 0.15;

  const col: React.CSSProperties = wide
    ? { position: "absolute", left: 860, top: 170, width: 960, textAlign: "left" }
    : { position: "absolute", left: 60, top: 600, width: 960, textAlign: "center" };

  return (
    <>
      <Backdrop mood="white" />
      <Shell duration={300} push={0.03} enterBlur={false}>
        <Stage>
          <div style={{ position: "absolute", left: orb.x - orb.s / 2, top: orb.y - orb.s / 2 + (1 - float) * 420 + Math.sin(frame / 34) * 8, opacity: Math.min(1, float * 1.3) }}>
            <Orb size={orb.s} energy={speaking} />
          </div>

          <div style={{ ...col, fontFamily: font, color: c.plum }}>
            <Kinetic text="Hi, I'm Aya," at={26} stagger={4} highlight={["Aya"]} style={{ fontWeight: 600, fontSize: wide ? 104 : 96, letterSpacing: tracked, lineHeight: 1.02 }} />
            <Kinetic text="your 24/7 assistant." at={44} stagger={4} style={{ fontWeight: 500, fontSize: wide ? 60 : 56, letterSpacing: tracked, lineHeight: 1.15, marginTop: 12, color: c.plumSoft }} />

            <div style={{ display: "flex", gap: 16, justifyContent: wide ? "flex-start" : "center", marginTop: wide ? 40 : 44 }}>
              {LINES.badges.map((b, i) => (
                <Badge key={b} text={b} at={84 + i * 10} />
              ))}
            </div>

            <div style={{ marginTop: wide ? 50 : 56, ...tilt(frame, 112, 14) }}>
              <Glass style={{ height: 124, display: "flex", alignItems: "center", padding: "0 34px", background: "rgba(255,255,255,0.75)", justifyContent: "flex-start" }}>
                <svg width="40" height="40" viewBox="0 0 24 24" style={{ marginRight: 16, flexShrink: 0 }}>
                  <circle cx="12" cy="12" r="9" fill="none" stroke={c.mist} strokeWidth="2" />
                  <path d="M3 12h18M12 3c3 3.5 3 14.5 0 18M12 3c-3 3.5-3 14.5 0 18" fill="none" stroke={c.mist} strokeWidth="1.6" />
                </svg>
                <span style={{ fontSize: 50, fontWeight: 500, letterSpacing: tracked, color: typed ? c.plum : c.mist }}>{typed ? CLINIC.url.slice(0, typed) : "yourwebsite.com"}</span>
                {!done ? <span style={{ width: 4, height: 52, background: c.coral, marginLeft: 4, borderRadius: 2, opacity: Math.floor(frame / 8) % 2 === 0 || typed > 0 ? 1 : 0 }} /> : null}
                <div style={{ flex: 1 }} />
                {done ? (
                  <div style={{ width: 56, height: 56, borderRadius: "50%", background: c.coral, display: "flex", alignItems: "center", justifyContent: "center", transform: `scale(${spring({ frame: frame - (TYPE_FROM + CLINIC.url.length * TYPE_STEP), fps, config: SNAP })})` }}>
                    <Tick size={32} />
                  </div>
                ) : null}
              </Glass>
            </div>

            {/* What she learned from the site. */}
            <div style={{ display: "flex", gap: 14, flexWrap: "wrap", justifyContent: wide ? "flex-start" : "center", marginTop: 26 }}>
              <Chip at={LEARNED}>
                <ClinicMark size={34} /> {CLINIC.name}
              </Chip>
              {CLINIC.treatments.map((t, i) => (
                <Chip key={t.name} at={LEARNED + 8 + i * 6}>
                  {t.name} <b style={{ color: c.coral }}>{money(t.price)}</b>
                </Chip>
              ))}
            </div>
          </div>
        </Stage>
      </Shell>
    </>
  );
};

const Badge: React.FC<{ text: string; at: number }> = ({ text, at }) => {
  const frame = useFrame();
  const { fps } = useVideoConfig();
  const p = spring({ frame: frame - at, fps, config: SNAP });
  return (
    <div style={{ transform: `scale(${0.7 + 0.3 * p}) translateY(${(1 - p) * 20}px)`, opacity: Math.min(1, p * 1.4), filter: `blur(${Math.max(0, 1 - p) * 8}px)` }}>
      <Glass style={{ padding: "16px 28px", fontWeight: 600, fontSize: 34, letterSpacing: tracked, display: "flex", alignItems: "center", gap: 12, background: "rgba(255,255,255,0.75)" }}>
        <span style={{ width: 12, height: 12, borderRadius: "50%", background: c.coral, boxShadow: `0 0 12px ${c.coral}` }} />
        {text}
      </Glass>
    </div>
  );
};

const Chip: React.FC<{ at: number; children: React.ReactNode }> = ({ at, children }) => {
  const frame = useFrame();
  const { fps } = useVideoConfig();
  const p = spring({ frame: frame - at, fps, config: SNAP });
  if (frame < at) return null;
  return (
    <div style={{ transform: `translateY(${(1 - p) * 24}px)`, opacity: Math.min(1, p * 1.4) }}>
      <Glass style={{ padding: "12px 20px", fontWeight: 600, fontSize: 28, letterSpacing: tracked, display: "flex", alignItems: "center", gap: 10, background: "rgba(255,255,255,0.7)" }}>{children}</Glass>
    </div>
  );
};

