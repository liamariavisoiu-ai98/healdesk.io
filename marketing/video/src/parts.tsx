import React from "react";
import { Img, interpolate, staticFile, useCurrentFrame } from "remotion";

import { VO } from "./copy";
import { useLayout } from "./motion";
import { c, font, radius, shadow } from "./tokens";

/** Frosted glass: every card and bubble in the ad. */
export const Glass: React.FC<{ children?: React.ReactNode; style?: React.CSSProperties }> = ({ children, style }) => (
  <div
    style={{
      background: c.glass,
      backdropFilter: "blur(24px)",
      WebkitBackdropFilter: "blur(24px)",
      borderRadius: radius,
      boxShadow: shadow,
      border: "1px solid rgba(255,255,255,0.7)",
      fontFamily: font,
      color: c.plum,
      ...style,
    }}
  >
    {children}
  </div>
);

export const Icon: React.FC<{ name: string; size: number; style?: React.CSSProperties }> = ({ name, size, style }) => (
  <Img src={staticFile(name)} style={{ width: size, height: size, borderRadius: size * 0.24, flexShrink: 0, ...style }} />
);

/** The gold coin: a disc with a rim and a "$". Spin is a horizontal squash. */
export const Coin: React.FC<{ size: number; spin?: number; label?: string; style?: React.CSSProperties }> = ({
  size,
  spin = 0,
  label = "$",
  style,
}) => (
  <div
    style={{
      width: size,
      height: size,
      borderRadius: "50%",
      background: `radial-gradient(circle at 35% 30%, ${c.goldLight} 0%, ${c.gold} 55%, #9C7A3A 100%)`,
      boxShadow: `inset 0 0 0 ${size * 0.07}px rgba(255,255,255,0.25), 0 ${size * 0.12}px ${size * 0.3}px rgba(0,0,0,0.35)`,
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      fontFamily: font,
      fontWeight: 800,
      fontSize: label.length > 2 ? size * 0.22 : size * 0.5,
      color: "#7A5A22",
      transform: `scaleX(${Math.max(0.08, Math.abs(Math.cos(spin)))})`,
      ...style,
    }}
  >
    {label}
  </div>
);

/** AYA, cut out of her brand portrait. `width` is the cut-out's width. */
export const Aya: React.FC<{ width: number; style?: React.CSSProperties }> = ({ width, style }) => (
  <Img src={staticFile("aya-cutout.webp")} style={{ width, height: "auto", display: "block", ...style }} />
);

/** Burned-in captions, word by word: each word fades up in 4 frames, the current one in coral. */
export const Captions: React.FC = () => {
  const frame = useCurrentFrame();
  const { wide, W, H } = useLayout();
  const line = VO.find((l) => frame >= l.from - 2 && frame < l.to + 10);
  if (!line) return null;

  const words = line.text.split(" ");
  const per = (line.to - line.from) / words.length;
  const spoken = Math.floor((frame - line.from) / per);

  // Chunks of up to five words, broken after punctuation, shown one at a time.
  const chunks: number[][] = [];
  let current: number[] = [];
  words.forEach((w, i) => {
    current.push(i);
    if (current.length >= 5 || /[.?!,]$/.test(w)) {
      chunks.push(current);
      current = [];
    }
  });
  if (current.length) chunks.push(current);
  const at = Math.min(words.length - 1, Math.max(0, spoken));
  const chunk = chunks.find((ch) => ch.includes(at)) ?? chunks[0];
  const fadeOut = interpolate(frame, [line.to + 4, line.to + 10], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });

  return (
    <div
      style={{
        position: "absolute",
        left: 0,
        width: W,
        top: wide ? H - 150 : 1300,
        display: "flex",
        justifyContent: "center",
        opacity: fadeOut,
        zIndex: 100,
      }}
    >
      <div
        style={{
          background: "rgba(42,22,48,0.85)",
          borderRadius: 28,
          padding: "14px 30px",
          fontFamily: font,
          fontWeight: 600,
          fontSize: wide ? 46 : 52,
          color: c.white,
          maxWidth: wide ? 1300 : 960,
          textAlign: "center",
          lineHeight: 1.25,
        }}
      >
        {chunk.map((i) => {
          const start = line.from + i * per;
          const o = interpolate(frame, [start, start + 4], [0.25, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
          const isCurrent = i === spoken;
          return (
            <span key={i} style={{ opacity: o, color: isCurrent ? c.coral : c.white }}>
              {words[i]}{" "}
            </span>
          );
        })}
      </div>
    </div>
  );
};

/** One rounded figure: a head and shoulders. */
export const Caller: React.FC<{ size: number; colour?: string; style?: React.CSSProperties }> = ({ size, colour = c.mist, style }) => (
  <div style={{ width: size, height: size * 1.6, position: "relative", ...style }}>
    <div style={{ position: "absolute", left: size * 0.25, top: 0, width: size * 0.5, height: size * 0.5, borderRadius: "50%", background: colour }} />
    <div
      style={{
        position: "absolute",
        left: 0,
        top: size * 0.58,
        width: size,
        height: size * 1.02,
        borderRadius: `${size * 0.5}px ${size * 0.5}px ${size * 0.12}px ${size * 0.12}px`,
        background: colour,
      }}
    />
  </div>
);

/** A chat bubble. AYA's sit left in white; the patient's sit right, tinted. */
export const Bubble: React.FC<{
  from: "aya" | "patient";
  children: React.ReactNode;
  tint?: string;
  size?: number;
  style?: React.CSSProperties;
}> = ({ from, children, tint = c.plum, size = 30, style }) => (
  <div
    style={{
      alignSelf: from === "aya" ? "flex-start" : "flex-end",
      maxWidth: "86%",
      background: from === "aya" ? c.white : tint,
      color: from === "aya" ? c.plum : c.white,
      borderRadius: 26,
      borderBottomLeftRadius: from === "aya" ? 8 : 26,
      borderBottomRightRadius: from === "aya" ? 26 : 8,
      padding: "14px 20px",
      fontFamily: font,
      fontWeight: 500,
      fontSize: size,
      lineHeight: 1.3,
      boxShadow: "0 6px 16px rgba(42,22,48,0.08)",
      ...style,
    }}
  >
    {children}
  </div>
);

/** A small text pill. */
export const Pill: React.FC<{ children: React.ReactNode; bg?: string; colour?: string; size?: number; style?: React.CSSProperties }> = ({
  children,
  bg = c.plum,
  colour = c.white,
  size = 28,
  style,
}) => (
  <div
    style={{
      display: "inline-flex",
      alignItems: "center",
      gap: 12,
      padding: `${size * 0.4}px ${size * 0.9}px`,
      borderRadius: 999,
      background: bg,
      color: colour,
      fontFamily: font,
      fontWeight: 600,
      fontSize: size,
      whiteSpace: "nowrap",
      ...style,
    }}
  >
    {children}
  </div>
);

export const Lock: React.FC<{ size: number; colour?: string }> = ({ size, colour = c.plum }) => (
  <svg width={size} height={size} viewBox="0 0 24 24">
    <rect x="4.5" y="10.5" width="15" height="10.5" rx="2.5" fill={colour} />
    <path d="M8 10.5V7.5a4 4 0 0 1 8 0v3" fill="none" stroke={colour} strokeWidth="2.4" />
  </svg>
);

export const Tick: React.FC<{ size: number; colour?: string }> = ({ size, colour = c.white }) => (
  <svg width={size} height={size} viewBox="0 0 24 24">
    <path d="M4 12.5l5 5L20 6.5" fill="none" stroke={colour} strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

/** AYA's mark: three bars of a sound wave, drawn on by `p` (0..1). */
export const WaveMark: React.FC<{ size: number; p?: number; colour?: string }> = ({ size, p = 1, colour = c.gold }) => {
  const bars = [0.5, 1, 0.68];
  return (
    <svg width={size} height={size} viewBox="0 0 30 30">
      {bars.map((h, i) => {
        const grow = Math.min(1, Math.max(0, p * 3 - i));
        const len = 24 * h * grow;
        return <line key={i} x1={6 + i * 9} x2={6 + i * 9} y1={15 - len / 2} y2={15 + len / 2} stroke={colour} strokeWidth="5" strokeLinecap="round" />;
      })}
    </svg>
  );
};
