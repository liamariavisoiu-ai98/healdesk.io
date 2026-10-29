import React from "react";
import { AbsoluteFill, Img, interpolate, staticFile, useCurrentFrame, useVideoConfig } from "remotion";

import { VO } from "./copy";
import { useLayout } from "./motion";
import { c, font, radius, shadow } from "./tokens";

/**
 * Frosted glass: every card, sheet and bubble. A lit top edge and a faint
 * inner rim sell the depth; the blur needs a colour field behind it, which
 * is what <Backdrop> provides.
 */
export const Glass: React.FC<{ children?: React.ReactNode; style?: React.CSSProperties; dark?: boolean }> = ({ children, style, dark }) => (
  <div
    style={{
      background: dark ? "rgba(30,20,40,0.42)" : c.glass,
      backdropFilter: "blur(30px) saturate(160%)",
      WebkitBackdropFilter: "blur(30px) saturate(160%)",
      borderRadius: radius,
      boxShadow: `${shadow}, inset 0 1px 0 rgba(255,255,255,${dark ? 0.18 : 0.9}), inset 0 0 0 1px rgba(255,255,255,${dark ? 0.1 : 0.45})`,
      fontFamily: font,
      color: dark ? c.white : c.plum,
      ...style,
    }}
  >
    {children}
  </div>
);

/**
 * The colour field behind the glass: large soft blobs that drift, so every
 * frosted surface has something moving through it.
 */
export const Backdrop: React.FC<{ mood: "night" | "ivory" | "sage" | "dusk" | "dawn"; mix?: number; to?: "night" | "ivory" | "sage" | "dusk" | "dawn" }> = ({
  mood,
  mix = 0,
  to,
}) => {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const set = MOODS[mood];
  const next = to ? MOODS[to] : set;
  const m = (a: string, b: string) => (mix <= 0 ? a : mix >= 1 ? b : blend(a, b, mix));
  return (
    <AbsoluteFill style={{ background: m(set.ground, next.ground), overflow: "hidden" }}>
      {set.blobs.map((col, i) => {
        const r = Math.max(width, height) * (0.42 + 0.08 * (i % 2));
        const x = width * (0.15 + 0.35 * i) + Math.sin(frame / (70 + i * 13) + i) * width * 0.12;
        const y = height * (0.2 + 0.28 * ((i * 7) % 3)) + Math.cos(frame / (90 + i * 11) + i * 2) * height * 0.08;
        return (
          <div
            key={i}
            style={{
              position: "absolute",
              left: x - r / 2,
              top: y - r / 2,
              width: r,
              height: r,
              borderRadius: "50%",
              background: `radial-gradient(circle, ${m(col, next.blobs[i] ?? col)} 0%, rgba(0,0,0,0) 68%)`,
              opacity: 0.9,
            }}
          />
        );
      })}
      {/* Film grain is too heavy for a render; a faint vignette does the depth instead. */}
      <AbsoluteFill style={{ background: "radial-gradient(ellipse at 50% 45%, rgba(0,0,0,0) 55%, rgba(0,0,0,0.12) 100%)" }} />
    </AbsoluteFill>
  );
};

const MOODS = {
  night: { ground: "#14101A", blobs: ["rgba(75,46,85,0.75)", "rgba(42,22,48,0.9)", "rgba(60,50,90,0.55)"] },
  ivory: { ground: "#FAF6F0", blobs: ["rgba(255,122,89,0.30)", "rgba(201,164,92,0.28)", "rgba(160,120,190,0.22)"] },
  sage: { ground: "#F3EBDD", blobs: ["rgba(127,156,134,0.45)", "rgba(201,164,92,0.25)", "rgba(127,156,134,0.30)"] },
  dusk: { ground: "#141A30", blobs: ["rgba(75,46,85,0.8)", "rgba(40,60,120,0.7)", "rgba(255,122,89,0.18)"] },
  dawn: { ground: "#2A1E34", blobs: ["rgba(255,122,89,0.55)", "rgba(201,164,92,0.5)", "rgba(160,120,190,0.45)"] },
} as const;

function blend(a: string, b: string, t: number): string {
  const pa = parse(a);
  const pb = parse(b);
  const mix = pa.map((v, i) => v + (pb[i] - v) * t);
  return `rgba(${Math.round(mix[0])},${Math.round(mix[1])},${Math.round(mix[2])},${mix[3].toFixed(3)})`;
}
function parse(col: string): number[] {
  if (col.startsWith("#")) {
    const n = parseInt(col.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 1];
  }
  const p = col.match(/[\d.]+/g)!.map(Number);
  return [p[0], p[1], p[2], p[3] ?? 1];
}

export const Icon: React.FC<{ name: string; size: number; style?: React.CSSProperties }> = ({ name, size, style }) => (
  <Img src={staticFile(name)} style={{ width: size, height: size, borderRadius: size * 0.24, flexShrink: 0, ...style }} />
);

/** healdesk's app icon, as it would sit in a notification. */
export const HealdeskIcon: React.FC<{ size: number }> = ({ size }) => (
  <Img
    src={staticFile("healdesk-icon.png")}
    style={{ width: size, height: size, borderRadius: size * 0.24, flexShrink: 0, boxShadow: "0 2px 8px rgba(0,0,0,0.12)" }}
  />
);

/** A system-style notification banner in glass. */
export const Notification: React.FC<{
  app: string;
  icon?: string;
  title: string;
  body?: string;
  time: string;
  width: number;
  dark?: boolean;
  scale?: number;
  style?: React.CSSProperties;
}> = ({ app, icon, title, body, time, width, dark, scale = 1, style }) => (
  <Glass
    dark={dark}
    style={{
      width,
      borderRadius: 30 * scale,
      padding: `${18 * scale}px ${22 * scale}px`,
      display: "flex",
      gap: 18 * scale,
      alignItems: "center",
      background: dark ? "rgba(40,30,50,0.55)" : "rgba(255,255,255,0.72)",
      ...style,
    }}
  >
    {icon ? <Icon name={icon} size={64 * scale} /> : <HealdeskIcon size={64 * scale} />}
    <div style={{ flex: 1, minWidth: 0 }}>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 21 * scale, fontWeight: 600, opacity: 0.7, textTransform: "uppercase", letterSpacing: "0.04em" }}>
        <span>{app}</span>
        <span style={{ textTransform: "none", letterSpacing: 0 }}>{time}</span>
      </div>
      <div style={{ fontSize: 28 * scale, fontWeight: 800, marginTop: 2 * scale, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{title}</div>
      {body ? <div style={{ fontSize: 24 * scale, fontWeight: 500, opacity: 0.85, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{body}</div> : null}
    </div>
  </Glass>
);

/**
 * AYA, until the end card shows her face: a living orb of the ad's warm
 * colours that breathes, and swells when she speaks or acts.
 */
export const Orb: React.FC<{ size: number; energy?: number; style?: React.CSSProperties }> = ({ size, energy = 0, style }) => {
  const frame = useCurrentFrame();
  const t = frame / 30;
  const swell = 1 + 0.03 * Math.sin(t * 2.2) + 0.06 * energy;
  const layers = [
    { col: c.coral, x: 0.35 + 0.12 * Math.sin(t * 1.3), y: 0.35 + 0.1 * Math.cos(t * 1.1), r: 0.75 },
    { col: c.gold, x: 0.65 + 0.12 * Math.cos(t * 0.9), y: 0.45 + 0.12 * Math.sin(t * 1.4), r: 0.7 },
    { col: "#B06BD6", x: 0.5 + 0.14 * Math.sin(t * 1.7 + 1), y: 0.7 + 0.08 * Math.cos(t * 1.2), r: 0.6 },
    { col: "#FF4D6D", x: 0.45 + 0.1 * Math.cos(t * 2.1), y: 0.55 + 0.1 * Math.sin(t * 0.8), r: 0.45 },
  ];
  return (
    <div style={{ width: size, height: size, position: "relative", transform: `scale(${swell})`, ...style }}>
      <div
        style={{
          position: "absolute",
          inset: -size * 0.25,
          borderRadius: "50%",
          background: `radial-gradient(circle, rgba(255,122,89,${0.35 + 0.25 * energy}) 0%, rgba(255,122,89,0) 65%)`,
          filter: `blur(${size * 0.06}px)`,
        }}
      />
      <div style={{ position: "absolute", inset: 0, borderRadius: "50%", overflow: "hidden", background: "#FFE3D3", boxShadow: `inset 0 0 ${size * 0.12}px rgba(255,255,255,0.8)` }}>
        {layers.map((l, i) => (
          <div
            key={i}
            style={{
              position: "absolute",
              left: (l.x - l.r / 2) * size,
              top: (l.y - l.r / 2) * size,
              width: l.r * size,
              height: l.r * size,
              borderRadius: "50%",
              background: l.col,
              filter: `blur(${size * 0.11}px)`,
              opacity: 0.9,
              mixBlendMode: "multiply",
            }}
          />
        ))}
        {/* The glass: a specular highlight and a rim. */}
        <div style={{ position: "absolute", left: "18%", top: "10%", width: "44%", height: "26%", borderRadius: "50%", background: "linear-gradient(180deg, rgba(255,255,255,0.75), rgba(255,255,255,0))", filter: `blur(${size * 0.02}px)` }} />
        <div style={{ position: "absolute", inset: 0, borderRadius: "50%", boxShadow: "inset 0 0 0 2px rgba(255,255,255,0.6)" }} />
      </div>
    </div>
  );
};

/**
 * Kinetic type: words rise and come into focus one after another, the way
 * an After Effects text animator would set them.
 */
export const Kinetic: React.FC<{
  text: string;
  at: number;
  stagger?: number;
  style?: React.CSSProperties;
  highlight?: string[];
  highlightColour?: string;
}> = ({ text, at, stagger = 2.2, style, highlight = [], highlightColour = c.coral }) => {
  const frame = useCurrentFrame();
  const words = text.split(" ");
  return (
    <div style={{ fontFamily: font, ...style }}>
      {words.map((w, i) => {
        const p = interpolate(frame, [at + i * stagger, at + i * stagger + 14], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: (t) => 1 - Math.pow(1 - t, 3) });
        const hot = highlight.some((h) => w.replace(/[.,?!]/g, "") === h);
        return (
          <span
            key={i}
            style={{
              display: "inline-block",
              marginRight: "0.26em",
              opacity: p,
              transform: `translateY(${(1 - p) * 0.5}em) scale(${0.92 + 0.08 * p})`,
              filter: `blur(${(1 - p) * 10}px)`,
              color: hot ? highlightColour : undefined,
            }}
          >
            {w}
          </span>
        );
      })}
    </div>
  );
};

/** The gold coin: a disc with a rim and a "$". */
export const Coin: React.FC<{ size: number; label?: string; style?: React.CSSProperties }> = ({ size, label = "$", style }) => (
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
      ...style,
    }}
  >
    {label}
  </div>
);

/** A burst of "$" glyphs and coins rising from a point, for money landing. */
export const DollarBurst: React.FC<{ at: number; x: number; y: number; count?: number }> = ({ at, x, y, count = 14 }) => {
  const frame = useCurrentFrame();
  const t = (frame - at) / 34;
  if (t < 0 || t > 1) return null;
  return (
    <>
      {Array.from({ length: count }).map((_, i) => {
        const a = -Math.PI / 2 + ((i / (count - 1)) - 0.5) * 2.4;
        const dist = (180 + (i % 4) * 70) * (1 - Math.pow(1 - t, 3));
        const isCoin = i % 3 === 0;
        return (
          <div
            key={i}
            style={{
              position: "absolute",
              left: x + Math.cos(a) * dist - 24,
              top: y + Math.sin(a) * dist + t * t * 120 - 24,
              opacity: 1 - t,
              transform: `rotate(${(i % 2 ? 1 : -1) * t * 120}deg) scale(${0.6 + 0.6 * (1 - t)})`,
            }}
          >
            {isCoin ? (
              <Coin size={44} />
            ) : (
              <span style={{ fontFamily: font, fontWeight: 800, fontSize: 52, color: i % 2 ? c.coral : c.gold, textShadow: "0 4px 12px rgba(0,0,0,0.15)" }}>$</span>
            )}
          </div>
        );
      })}
    </>
  );
};

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
          background: "rgba(42,22,48,0.78)",
          backdropFilter: "blur(16px)",
          WebkitBackdropFilter: "blur(16px)",
          borderRadius: 28,
          padding: "14px 30px",
          fontFamily: font,
          fontWeight: 600,
          fontSize: wide ? 46 : 52,
          color: c.white,
          maxWidth: wide ? 1300 : 960,
          textAlign: "center",
          lineHeight: 1.25,
          boxShadow: "inset 0 1px 0 rgba(255,255,255,0.15)",
        }}
      >
        {chunk.map((i) => {
          const start = line.from + i * per;
          const o = interpolate(frame, [start, start + 4], [0.25, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
          return (
            <span key={i} style={{ opacity: o, color: i === spoken ? c.coral : c.white }}>
              {words[i]}{" "}
            </span>
          );
        })}
      </div>
    </div>
  );
};

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
      maxWidth: "88%",
      background: from === "aya" ? "rgba(255,255,255,0.92)" : tint,
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

export const Tick: React.FC<{ size: number; colour?: string; p?: number }> = ({ size, colour = c.white, p = 1 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24">
    <path d="M4 12.5l5 5L20 6.5" fill="none" stroke={colour} strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round" pathLength={1} strokeDasharray={1} strokeDashoffset={1 - p} />
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

/** A phone: a thin glass bezel around a screen. Children draw the screen. */
export const Phone: React.FC<{ width: number; children: React.ReactNode; style?: React.CSSProperties; screen?: string }> = ({ width, children, style, screen }) => {
  const height = width * 2.05;
  return (
    <div
      style={{
        width,
        height,
        borderRadius: width * 0.16,
        padding: width * 0.03,
        background: "linear-gradient(145deg, rgba(255,255,255,0.35), rgba(255,255,255,0.08))",
        boxShadow: "0 40px 80px rgba(0,0,0,0.35), inset 0 0 0 2px rgba(255,255,255,0.35)",
        flexShrink: 0,
        ...style,
      }}
    >
      <div style={{ width: "100%", height: "100%", borderRadius: width * 0.135, overflow: "hidden", position: "relative", background: screen ?? "#1B1424" }}>
        <div style={{ position: "absolute", left: "50%", top: width * 0.03, width: width * 0.3, height: width * 0.075, marginLeft: -width * 0.15, borderRadius: 999, background: "#000", zIndex: 5 }} />
        {children}
      </div>
    </div>
  );
};
