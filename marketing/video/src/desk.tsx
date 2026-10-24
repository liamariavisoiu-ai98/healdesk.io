import React from "react";
import { interpolateColors } from "remotion";

import { useLayout } from "./motion";
import { c } from "./tokens";

/**
 * The reception desk, drawn flat in three layers for parallax: the wall
 * (0.3×), the desk and its things (0.6×), and whatever the scene puts in
 * front (1×). `light` runs 0 = night, 1 = golden hour, 2 = dusk.
 */
export const deskTop = (wide: boolean): number => (wide ? 640 : 980);

export const Desk: React.FC<{
  light: number;
  phoneGlow?: number;
  phoneGrey?: number;
  lamp?: number;
  window?: boolean;
  camera?: number;
  children?: React.ReactNode;
}> = ({ light, phoneGlow = 0, phoneGrey = 0, lamp = 0, window = false, camera = 0, children }) => {
  const { wide, W, H } = useLayout();
  const wallTop = interpolateColors(light, [0, 1, 2], [c.night, "#F6DDBE", c.dusk]);
  const wallBottom = interpolateColors(light, [0, 1, 2], ["#1C1624", "#EFC9A0", "#2A3557"]);
  const deskTopColour = interpolateColors(light, [0, 1, 2], ["#2B2235", "#C99B72", "#3A3550"]);
  const deskFront = interpolateColors(light, [0, 1, 2], [c.nightDesk, "#B5845C", "#2C2942"]);
  const leaf = interpolateColors(light, [0, 1, 2], ["#2F4A3A", "#6E9A6A", "#334A45"]);

  const deskY = deskTop(wide);
  const phoneX = wide ? 520 : 250;
  const plantX = wide ? 300 : 90;

  return (
    <div style={{ position: "absolute", inset: 0 }}>
      {/* Wall, 0.3× */}
      <div
        style={{
          position: "absolute",
          left: -400,
          top: -400,
          width: W + 800,
          height: H + 800,
          background: `linear-gradient(180deg, ${wallTop} 0%, ${wallBottom} 100%)`,
          transform: `translateX(${camera * 0.3}px)`,
        }}
      />
      {window ? (
        <div
          style={{
            position: "absolute",
            left: wide ? 1150 : 560,
            top: wide ? 110 : 170,
            width: wide ? 560 : 400,
            height: wide ? 420 : 520,
            borderRadius: 24,
            background: interpolateColors(light, [0, 1, 2], ["#241C30", "#FFE7B8", "#3B4A78"]),
            boxShadow: `0 0 ${120 * Math.max(0, 1.5 - Math.abs(light - 1))}px rgba(255,200,120,${0.55 * Math.max(0, 1 - Math.abs(light - 1))})`,
            transform: `translateX(${camera * 0.3}px)`,
            overflow: "hidden",
          }}
        >
          <div style={{ position: "absolute", left: "50%", top: 0, bottom: 0, width: 12, marginLeft: -6, background: deskFront, opacity: 0.6 }} />
          <div style={{ position: "absolute", top: "50%", left: 0, right: 0, height: 12, marginTop: -6, background: deskFront, opacity: 0.6 }} />
        </div>
      ) : null}

      {/* Desk and its things, 0.6× */}
      <div style={{ position: "absolute", inset: 0, transform: `translateX(${camera * 0.6}px)` }}>
        <div style={{ position: "absolute", left: -300, width: W + 600, top: deskY, height: 34, background: deskTopColour, borderRadius: 8 }} />
        <div style={{ position: "absolute", left: -300, width: W + 600, top: deskY + 34, height: H, background: deskFront }} />

        {/* Plant */}
        <div style={{ position: "absolute", left: plantX, top: deskY - 70, width: 90, height: 74, background: deskFront, borderRadius: "10px 10px 20px 20px", filter: "brightness(1.3)" }} />
        {[
          [-30, -170, 70, 120, -20],
          [20, -200, 64, 140, 8],
          [55, -160, 60, 110, 30],
        ].map(([dx, dy, w, h, r], i) => (
          <div
            key={i}
            style={{
              position: "absolute",
              left: plantX + 15 + dx,
              top: deskY + dy,
              width: w,
              height: h,
              background: leaf,
              borderRadius: "50% 50% 50% 50% / 60% 60% 40% 40%",
              transform: `rotate(${r}deg)`,
            }}
          />
        ))}

        {/* Desk phone */}
        <div style={{ position: "absolute", left: phoneX, top: deskY - 120, width: 220, height: 124, background: "#3A3045", borderRadius: "22px 22px 8px 8px" }}>
          <div
            style={{
              position: "absolute",
              left: 22,
              top: 20,
              width: 110,
              height: 60,
              borderRadius: 8,
              background: phoneGrey > 0 ? interpolateColors(phoneGrey, [0, 1], ["#FFFFFF", "#55505C"]) : interpolateColors(phoneGlow, [0, 1], ["#55505C", "#FFFFFF"]),
              boxShadow: `0 0 ${60 * phoneGlow * (1 - phoneGrey)}px rgba(255,255,255,${0.7 * phoneGlow * (1 - phoneGrey)})`,
            }}
          />
          <div style={{ position: "absolute", left: 150, top: 22, width: 48, height: 80, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} style={{ background: "#544A60", borderRadius: 4 }} />
            ))}
          </div>
        </div>
        <div
          style={{
            position: "absolute",
            left: phoneX - 40,
            top: deskY - 150,
            width: 70,
            height: 150,
            background: "#3A3045",
            borderRadius: 30,
          }}
        />

        {/* Lamp */}
        {lamp >= 0 ? <Lamp x={wide ? 900 : 760} y={deskY} on={lamp} light={light} /> : null}
      </div>
      {children}
    </div>
  );
};

const Lamp: React.FC<{ x: number; y: number; on: number; light: number }> = ({ x, y, on, light }) => {
  const metal = interpolateColors(light, [0, 1, 2], ["#3A3045", "#5B4636", "#3E3B55"]);
  return (
    <>
      <div
        style={{
          position: "absolute",
          left: x - 260,
          top: y - 420,
          width: 520,
          height: 460,
          background: `radial-gradient(ellipse at 50% 20%, rgba(255,214,150,${0.55 * on}) 0%, rgba(255,214,150,0) 65%)`,
        }}
      />
      <div style={{ position: "absolute", left: x - 8, top: y - 260, width: 16, height: 260, background: metal }} />
      <div style={{ position: "absolute", left: x - 60, top: y - 14, width: 120, height: 16, background: metal, borderRadius: 8 }} />
      <div
        style={{
          position: "absolute",
          left: x - 90,
          top: y - 330,
          width: 180,
          height: 90,
          background: metal,
          borderRadius: "90px 90px 10px 10px",
        }}
      />
      <div
        style={{
          position: "absolute",
          left: x - 40,
          top: y - 246,
          width: 80,
          height: 26,
          borderRadius: "0 0 40px 40px",
          background: `rgba(255,226,170,${0.15 + 0.85 * on})`,
        }}
      />
    </>
  );
};
