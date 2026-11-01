import React from "react";
import { spring, useVideoConfig } from "remotion";

import { LINES } from "../copy";
import { lerp, Stage, useFrame, useLayout } from "../motion";
import { Backdrop, Glass, Kinetic, Orb } from "../parts";
import { c, font, tracked } from "../tokens";

const HOLD = 105;

/**
 * 0:40–0:44. Back to the orb, glowing on a clean gradient, with one
 * minimal text box, "Try Aya free." and healdesk.io. "Free" is the AYA built
 * from a clinic's website (healdesk has no free trial). The last 15 frames
 * hold still so the address reads.
 */
export const Close: React.FC = () => {
  const live = useFrame();
  const frame = Math.min(live, HOLD);
  const { fps } = useVideoConfig();
  const { wide } = useLayout();

  const orbIn = spring({ frame, fps, config: { damping: 20, stiffness: 70 } });
  const box = spring({ frame: frame - 30, fps, config: { damping: 18 } });
  const domain = lerp(frame, [52, 70], [0, 1]);
  const caret = live < HOLD ? Math.floor(live / 9) % 2 === 0 : true;

  const orb = wide ? { x: 960, y: 300, s: 320 } : { x: 540, y: 470, s: 400 };

  return (
    <>
      <Backdrop mood="white" />
      <Stage>
        <div style={{ position: "absolute", left: orb.x - orb.s / 2, top: orb.y - orb.s / 2 + (1 - orbIn) * 60 + Math.sin(frame / 30) * 6, transform: `scale(${0.9 + 0.1 * orbIn})`, opacity: Math.min(1, orbIn * 1.3) }}>
          <Orb size={orb.s} energy={0.25} />
        </div>

        <div style={{ position: "absolute", left: 0, right: 0, top: wide ? 520 : 780, display: "flex", flexDirection: "column", alignItems: "center", fontFamily: font }}>
          <Kinetic text={LINES.close} at={10} stagger={5} highlight={["Aya"]} style={{ fontWeight: 600, fontSize: wide ? 120 : 116, letterSpacing: tracked, color: c.plum, lineHeight: 1 }} />

          <div style={{ marginTop: wide ? 46 : 56, transform: `translateY(${(1 - box) * 30}px)`, opacity: Math.min(1, box * 1.3) }}>
            <Glass style={{ width: wide ? 760 : 860, height: 112, borderRadius: 999, display: "flex", alignItems: "center", padding: "0 12px 0 40px", background: "rgba(255,255,255,0.8)" }}>
              <span style={{ fontSize: 42, fontWeight: 500, letterSpacing: tracked, color: c.mist }}>yourwebsite.com</span>
              <span style={{ width: 3, height: 46, background: c.coral, marginLeft: 6, borderRadius: 2, opacity: caret ? 1 : 0 }} />
              <div style={{ flex: 1 }} />
              <div style={{ width: 88, height: 88, borderRadius: "50%", background: c.coral, display: "flex", alignItems: "center", justifyContent: "center", boxShadow: "0 12px 26px rgba(255,122,89,0.45)" }}>
                <svg width="40" height="40" viewBox="0 0 24 24">
                  <path d="M5 12h13M13 6l6 6-6 6" fill="none" stroke="#fff" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </div>
            </Glass>
          </div>

          <div style={{ marginTop: wide ? 40 : 50, fontSize: wide ? 44 : 46, fontWeight: 600, letterSpacing: "0.02em", color: c.plumSoft, opacity: domain, transform: `translateY(${(1 - domain) * 12}px)` }}>{LINES.domain}</div>
        </div>
      </Stage>
    </>
  );
};
