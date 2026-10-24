import React from "react";
import { AbsoluteFill, interpolate, interpolateColors, useCurrentFrame } from "remotion";

import { Desk, deskTop } from "../desk";
import { breathe, enter, enterStyle, lerp, Stage, useLayout, useSnap } from "../motion";
import { Glass, Tick, WaveMark } from "../parts";
import { c, font } from "../tokens";

/**
 * Scene 5, "The dream outcome", frames 690–900. Golden hour at the same
 * desk; the lamp goes off; overnight, the phone lights up once.
 */
export const S5Dream: React.FC = () => {
  const frame = useCurrentFrame();
  const { wide } = useLayout();

  const camera = interpolate(frame, [690, 900], [40, -40]);
  const dusk = lerp(frame, [784, 812], [0, 1]);
  const light = 1 + dusk;
  const lampOn = frame < 790 ? 1 : 0;
  const softIn = lerp(frame, [690, 712], [0, 1]);

  const deskY = deskTop(wide);
  const stackX = wide ? 1240 : 470;
  const notif = useSnap(842);
  const glow = lerp(frame, [840, 848], [0, 1]);
  const headline = enter(frame, 866, 16);

  return (
    <>
      <AbsoluteFill style={{ background: interpolateColors(light, [1, 2], ["#F6DDBE", c.dusk]) }} />
      <Stage>
        <Desk light={light} lamp={lampOn} window camera={camera} />

        {/* Three booked tiles settle beside the phone. */}
        <div style={{ position: "absolute", left: stackX + camera * 0.6, top: deskY - 150, width: 230 }}>
          {[0, 1, 2].map((i) => (
            <BookedTile key={i} at={724 + i * 10} index={i} />
          ))}
        </div>

        {/* The owner's phone, face up on the desk, lights up overnight. */}
        <div
          style={{
            position: "absolute",
            left: (wide ? 1520 : 820) + camera * 0.6,
            top: deskY - 22,
            width: 170,
            height: 26,
            borderRadius: 8,
            background: interpolateColors(glow, [0, 1], ["#2A2638", "#FFF4E6"]),
            boxShadow: `0 0 ${80 * glow}px rgba(255,200,150,${0.8 * glow})`,
          }}
        />

        <div
          style={{
            position: "absolute",
            left: wide ? 300 : 90,
            top: wide ? 330 : 520,
            width: wide ? 800 : 900,
            transform: `translateY(${(1 - notif) * 60}px) scale(${(0.92 + 0.08 * notif) * breathe(frame)})`,
            opacity: Math.min(1, notif),
          }}
        >
          <Glass style={{ background: "rgba(255,255,255,0.88)", padding: "26px 30px", display: "flex", gap: 22, alignItems: "center" }}>
            <div style={{ width: 84, height: 84, borderRadius: 22, background: c.plum, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
              <WaveMark size={58} />
            </div>
            <div>
              <div style={{ display: "flex", justifyContent: "space-between", fontWeight: 600, fontSize: 24, color: c.plumSoft }}>
                <span>AYA</span>
                <span>7:02 AM</span>
              </div>
              <div style={{ fontWeight: 800, fontSize: wide ? 40 : 36, marginTop: 4, lineHeight: 1.15 }}>3 new bookings overnight · deposits in</div>
            </div>
          </Glass>
        </div>

        <div
          style={{
            position: "absolute",
            left: wide ? 120 : 60,
            top: wide ? 80 : 180,
            width: wide ? 1680 : 960,
            textAlign: "center",
            fontFamily: font,
            fontWeight: 800,
            fontSize: wide ? 72 : 84,
            lineHeight: 1.05,
            letterSpacing: "-0.02em",
            color: c.ivory,
            ...enterStyle(headline),
          }}
        >
          You do the treatments. <span style={{ color: c.coral }}>AYA handles the rush.</span>
        </div>
      </Stage>
      <AbsoluteFill style={{ background: c.ivory, opacity: 1 - softIn, pointerEvents: "none" }} />
    </>
  );
};

const BookedTile: React.FC<{ at: number; index: number }> = ({ at, index }) => {
  const p = useSnap(at);
  return (
    <div
      style={{
        position: "absolute",
        left: index * 6,
        top: -index * 34,
        width: 220,
        transform: `translateY(${(1 - p) * -120}px) rotate(${(index - 1) * 3}deg)`,
        opacity: Math.min(1, p),
        background: c.coral,
        color: c.white,
        borderRadius: 14,
        padding: "10px 14px",
        fontFamily: font,
        fontWeight: 800,
        fontSize: 24,
        display: "flex",
        alignItems: "center",
        gap: 8,
        boxShadow: "0 8px 18px rgba(42,22,48,0.18)",
      }}
    >
      <Tick size={24} /> Booked
    </div>
  );
};
