import React from "react";

import { useFrame } from "./motion";
import { font } from "./tokens";

/**
 * An iPhone drawn to read as the real thing at a glance: a brushed titanium
 * band with side buttons, a black bezel, the Dynamic Island, a status bar, a
 * lit wallpaper, and a glare that slides across the glass. `width` is the
 * outer width; children draw the screen.
 */
export const IPhone: React.FC<{ width: number; children?: React.ReactNode; wallpaper?: string; glare?: number; style?: React.CSSProperties }> = ({
  width,
  children,
  wallpaper,
  glare = 0,
  style,
}) => {
  const frame = useFrame();
  const height = width * 2.06;
  const band = width * 0.016;
  const bezel = width * 0.024;
  const r = width * 0.165;
  return (
    <div style={{ width, height, position: "relative", flexShrink: 0, ...style }}>
      {/* Side buttons. */}
      {[
        { side: "left", top: 0.2, h: 0.05 },
        { side: "left", top: 0.28, h: 0.09 },
        { side: "left", top: 0.39, h: 0.09 },
        { side: "right", top: 0.31, h: 0.14 },
      ].map((b, i) => (
        <div
          key={i}
          style={{
            position: "absolute",
            [b.side]: -width * 0.008,
            top: height * b.top,
            width: width * 0.014,
            height: height * b.h,
            borderRadius: width * 0.01,
            background: "linear-gradient(90deg, #6E727B, #C9CDD4 50%, #5A5E66)",
          }}
        />
      ))}
      {/* Titanium band. */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          borderRadius: r,
          padding: band,
          background: "linear-gradient(135deg, #D7DAE0 0%, #7D828C 18%, #3A3D44 40%, #9EA3AC 62%, #4A4E56 80%, #C4C8CF 100%)",
          boxShadow: "0 60px 120px rgba(0,0,0,0.55), 0 20px 40px rgba(0,0,0,0.35)",
        }}
      >
        {/* Bezel. */}
        <div style={{ width: "100%", height: "100%", borderRadius: r - band, background: "#050506", padding: bezel, boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.08)" }}>
          {/* Screen. */}
          <div
            style={{
              width: "100%",
              height: "100%",
              borderRadius: r - band - bezel * 0.6,
              overflow: "hidden",
              position: "relative",
              background: wallpaper ?? "#000",
              fontFamily: font,
            }}
          >
            {children}
            <StatusBar width={width} />
            <div style={{ position: "absolute", left: "50%", top: width * 0.03, width: width * 0.31, height: width * 0.09, marginLeft: -width * 0.155, borderRadius: 999, background: "#000", zIndex: 40 }} />
            {/* Glare across the glass. */}
            <div
              style={{
                position: "absolute",
                inset: "-20%",
                background: `linear-gradient(115deg, rgba(255,255,255,0) ${30 + glare * 30}%, rgba(255,255,255,0.10) ${40 + glare * 30}%, rgba(255,255,255,0) ${52 + glare * 30}%)`,
                zIndex: 45,
                pointerEvents: "none",
                transform: `translateX(${Math.sin(frame / 90) * 2}%)`,
              }}
            />
          </div>
        </div>
      </div>
    </div>
  );
};

const StatusBar: React.FC<{ width: number }> = ({ width }) => {
  const s = width / 600;
  return (
    <div style={{ position: "absolute", top: width * 0.045, left: width * 0.09, right: width * 0.08, display: "flex", justifyContent: "space-between", alignItems: "center", color: "#fff", fontSize: 24 * s, fontWeight: 600, zIndex: 41 }}>
      <span />
      <span style={{ display: "flex", alignItems: "center", gap: 8 * s }}>
        <svg width={30 * s} height={20 * s} viewBox="0 0 30 20">
          {[0, 1, 2, 3].map((i) => (
            <rect key={i} x={i * 8} y={14 - i * 4} width="5.5" height={6 + i * 4} rx="1.5" fill="#fff" />
          ))}
        </svg>
        <svg width={28 * s} height={20 * s} viewBox="0 0 28 20">
          <path d="M14 18l3.5-4a5 5 0 0 0-7 0L14 18zm-7-7.5a10 10 0 0 1 14 0l2.6-3a14 14 0 0 0-19.2 0L7 10.5zM1.2 4.7a18.5 18.5 0 0 1 25.6 0L28 3.3a20.5 20.5 0 0 0-28 0z" fill="#fff" />
        </svg>
        <span style={{ display: "inline-flex", alignItems: "center" }}>
          <span style={{ width: 42 * s, height: 20 * s, borderRadius: 6 * s, border: `${2 * s}px solid rgba(255,255,255,0.5)`, padding: 2 * s, display: "inline-flex" }}>
            <span style={{ width: "72%", height: "100%", borderRadius: 3 * s, background: "#fff" }} />
          </span>
          <span style={{ width: 3 * s, height: 7 * s, borderRadius: 2 * s, background: "rgba(255,255,255,0.5)", marginLeft: 2 * s }} />
        </span>
      </span>
    </div>
  );
};

/** A lock-screen wallpaper: near-black, with healdesk's orange and red rising from below like embers. */
export function wallpaper(frame: number): string {
  const a = 50 + Math.sin(frame / 80) * 8;
  const b = 40 + Math.cos(frame / 70) * 10;
  return [
    `radial-gradient(120% 62% at ${a}% 108%, rgba(255,118,30,0.95) 0%, rgba(230,38,39,0.65) 30%, rgba(230,38,39,0) 60%)`,
    `radial-gradient(80% 50% at ${b}% 12%, rgba(255,118,30,0.14) 0%, rgba(255,118,30,0) 60%)`,
    "linear-gradient(180deg, #0B0807 0%, #120A09 50%, #2A0B08 100%)",
  ].join(", ");
}
