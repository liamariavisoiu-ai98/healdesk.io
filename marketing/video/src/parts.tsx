import React from "react";
import { AbsoluteFill, Img, interpolate, staticFile, useCurrentFrame, useVideoConfig } from "remotion";

import { VO } from "./copy";
import { useLayout, useFrame } from "./motion";
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
export const Backdrop: React.FC<{ mood: Mood; mix?: number; to?: Mood }> = ({
  mood,
  mix = 0,
  to,
}) => {
  const frame = useFrame();
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
      {/* A faint vignette for depth on the dark grounds only: on white it reads as dirt. */}
      {mood === "white" ? null : <AbsoluteFill style={{ background: "radial-gradient(ellipse at 50% 45%, rgba(0,0,0,0) 55%, rgba(0,0,0,0.12) 100%)" }} />}
    </AbsoluteFill>
  );
};

export type Mood = keyof typeof MOODS;

const MOODS = {
  // Black with healdesk's ember, so even the opening is in the brand's colours.
  space: { ground: "#000000", blobs: ["rgba(230,38,39,0.16)", "rgba(255,118,30,0.09)", "rgba(90,20,10,0.22)"] },
  // Pure white, as Apple sets it: no tinted blobs, nothing to read as grey.
  white: { ground: "#FFFFFF", blobs: ["rgba(255,255,255,0)", "rgba(255,255,255,0)", "rgba(255,255,255,0)"] },
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
 * Aya, until the closing scene shows her face: a living orb of the ad's warm
 * colours that breathes, and swells when she speaks or acts.
 */
export const Orb: React.FC<{ size: number; energy?: number; style?: React.CSSProperties }> = ({ size, energy = 0, style }) => {
  const frame = useFrame();
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
  const frame = useFrame();
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

/** A field of faint stars that drift and twinkle, for the deep-space ground. */
export const Stars: React.FC<{ count?: number; opacity?: number }> = ({ count = 90, opacity = 1 }) => {
  const frame = useFrame();
  const { width, height } = useVideoConfig();
  return (
    <AbsoluteFill style={{ opacity }}>
      {Array.from({ length: count }).map((_, i) => {
        const x = ((i * 7919) % 1000) / 1000;
        const y = ((i * 104729) % 1000) / 1000;
        const s = 1 + ((i * 31) % 3);
        const tw = 0.35 + 0.65 * Math.abs(Math.sin(frame / (25 + (i % 7) * 6) + i));
        return <div key={i} style={{ position: "absolute", left: x * width, top: (y * height + frame * 0.15 * s) % height, width: s, height: s, borderRadius: "50%", background: "#fff", opacity: tw * 0.7 }} />;
      })}
    </AbsoluteFill>
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

/**
 * The gold coin, minted rather than flat: a milled rim, a bevel lit from the
 * top left, an engraved serif "$", and a highlight that sweeps across as it
 * turns. `spin` (radians) turns it on its vertical axis.
 */
export const Coin: React.FC<{ size: number; label?: string; spin?: number; style?: React.CSSProperties }> = ({ size, label = "$", spin = 0, style }) => {
  const turn = Math.cos(spin);
  const edge = Math.abs(Math.sin(spin));
  const sweep = ((spin / (Math.PI * 2)) % 1 + 1) % 1;
  return (
    <div style={{ width: size, height: size, position: "relative", transform: `scaleX(${Math.max(0.12, Math.abs(turn))})`, filter: `drop-shadow(0 ${size * 0.14}px ${size * 0.18}px rgba(0,0,0,0.45))`, ...style }}>
      {/* The edge, seen as the coin turns. */}
      <div style={{ position: "absolute", inset: 0, borderRadius: "50%", background: "#7A5A22", transform: `translateX(${(turn > 0 ? 1 : -1) * edge * size * 0.05}px)` }} />
      {/* Milled rim. */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          borderRadius: "50%",
          background: `repeating-conic-gradient(from 0deg, #F3DC9A 0deg 3deg, #B8893A 3deg 6deg)`,
        }}
      />
      {/* Bevel. */}
      <div style={{ position: "absolute", inset: size * 0.045, borderRadius: "50%", background: "linear-gradient(135deg, #FFF1C4 0%, #D9B060 40%, #8A6526 100%)" }} />
      {/* Face. */}
      <div
        style={{
          position: "absolute",
          inset: size * 0.1,
          borderRadius: "50%",
          background: "radial-gradient(circle at 38% 32%, #F6E2A6 0%, #D7AE5C 45%, #A57B33 100%)",
          boxShadow: `inset 0 ${size * 0.02}px ${size * 0.04}px rgba(255,255,255,0.55), inset 0 -${size * 0.03}px ${size * 0.05}px rgba(90,60,20,0.45)`,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          overflow: "hidden",
        }}
      >
        {/* A fine inner ring, as struck coins have. */}
        <div style={{ position: "absolute", inset: size * 0.05, borderRadius: "50%", boxShadow: "inset 0 0 0 1.5px rgba(122,90,34,0.55), 0 0 0 1px rgba(255,241,196,0.5)" }} />
        <span
          style={{
            fontFamily: "Georgia, 'Times New Roman', serif",
            fontWeight: 700,
            fontSize: label.length > 2 ? size * 0.2 : size * 0.46,
            color: "#B88A3C",
            textShadow: `-1px -1px 0 rgba(255,244,205,0.9), 1px 1px 0 rgba(96,66,22,0.85), 0 ${size * 0.01}px ${size * 0.03}px rgba(96,66,22,0.4)`,
            transform: `scaleX(${turn < 0 ? -1 : 1})`,
            letterSpacing: label.length > 2 ? "-0.02em" : 0,
          }}
        >
          {label}
        </span>
        {/* The light sweeping across as it turns. */}
        <div
          style={{
            position: "absolute",
            top: "-20%",
            bottom: "-20%",
            width: "35%",
            left: `${-40 + sweep * 140}%`,
            background: "linear-gradient(90deg, rgba(255,255,255,0) 0%, rgba(255,250,230,0.55) 50%, rgba(255,255,255,0) 100%)",
            transform: "rotate(20deg)",
          }}
        />
      </div>
    </div>
  );
};

/** A burst of coins and sparkles rising from a point, for money landing. */
export const DollarBurst: React.FC<{ at: number; x: number; y: number; count?: number }> = ({ at, x, y, count = 14 }) => {
  const frame = useFrame();
  const t = (frame - at) / 34;
  if (t < 0 || t > 1) return null;
  return (
    <>
      {Array.from({ length: count }).map((_, i) => {
        const a = -Math.PI / 2 + ((i / (count - 1)) - 0.5) * 2.4;
        const dist = (180 + (i % 4) * 70) * (1 - Math.pow(1 - t, 3));
        const isCoin = i % 2 === 0;
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
              <Coin size={48} spin={t * 9 + i} />
            ) : (
              <Sparkle size={30 + (i % 3) * 8} colour={i % 2 ? c.goldLight : "#FFFFFF"} />
            )}
          </div>
        );
      })}
    </>
  );
};

/** A four-point star of light. */
export const Sparkle: React.FC<{ size: number; colour?: string }> = ({ size, colour = "#FFFFFF" }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" style={{ filter: `drop-shadow(0 0 6px ${colour})` }}>
    <path d="M12 0c.8 6.4 4.6 10.6 12 12-7.4 1.4-11.2 5.6-12 12-.8-6.4-4.6-10.6-12-12 7.4-1.4 11.2-5.6 12-12z" fill={colour} />
  </svg>
);

/**
 * Burned-in subtitles, set the way Netflix sets them: plain white type, no
 * box, one or two balanced lines at a time, each phrase on screen for its
 * share of the line's time. Over the light scenes a hairline dark edge and a
 * soft shade rising from the bottom of the frame keep the white readable.
 */
export const Captions: React.FC = () => {
  const frame = useCurrentFrame();
  const { wide, W, H } = useLayout();
  const line = VO.find((l) => l.burn !== false && frame >= l.from && frame < l.to + 6);
  if (!line) return null;

  const cues = cueLines(line.text, wide ? 46 : 30);
  const per = (line.to - line.from) / line.text.split(" ").length;
  let start = line.from;
  const timed = cues.map((cue) => {
    const n = cue.join(" ").split(" ").length;
    const t = { cue, from: start, to: start + n * per };
    start = t.to;
    return t;
  });
  const now = timed.find((t) => frame >= t.from && frame < t.to) ?? timed[timed.length - 1];
  const last = now === timed[timed.length - 1];
  const fade = interpolate(frame, [now.from, now.from + 3, now.to + (last ? 2 : 0), now.to + (last ? 6 : 1)], [0, 1, 1, last ? 0 : 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const shade = interpolate(frame, [line.from, line.from + 8, line.to, line.to + 6], [0, 1, 1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const top = wide ? H - 200 : 1330;

  return (
    <>
      <div style={{ position: "absolute", left: -400, width: W + 800, top: top - 140, height: H - top + 600, background: "linear-gradient(180deg, rgba(10,6,14,0) 0%, rgba(10,6,14,0.46) 42%, rgba(10,6,14,0.62) 100%)", opacity: shade, zIndex: 99 }} />
      <div style={{ position: "absolute", left: 0, width: W, top, display: "flex", justifyContent: "center", zIndex: 100, opacity: fade }}>
        <div
          style={{
            fontFamily: font,
            fontWeight: 600,
            fontSize: wide ? 50 : 54,
            lineHeight: 1.22,
            color: "#FFFFFF",
            textAlign: "center",
            letterSpacing: "-0.005em",
            textShadow:
              "1px 0 1px rgba(0,0,0,0.9), -1px 0 1px rgba(0,0,0,0.9), 0 1px 1px rgba(0,0,0,0.9), 0 -1px 1px rgba(0,0,0,0.9), 0 3px 6px rgba(0,0,0,0.75), 0 6px 22px rgba(0,0,0,0.5)",
          }}
        >
          {now.cue.map((l, i) => (
            <div key={i}>{l}</div>
          ))}
        </div>
      </div>
    </>
  );
};

/**
 * Splits a voiceover line into subtitle cues of one or two lines of at most
 * `width` characters: by sentence, then by clause when a sentence would need
 * more than two lines, then two lines broken as evenly as the words allow.
 */
function cueLines(text: string, width: number): string[][] {
  const sentences = text.match(/[^.?!]+[.?!]*/g)?.map((x) => x.trim()).filter(Boolean) ?? [text];
  const chunks: string[] = [];
  for (const sentence of sentences) {
    if (sentence.length <= width * 2) {
      chunks.push(sentence);
      continue;
    }
    let current = "";
    for (const clause of sentence.split(/(?<=,)\s+/)) {
      if (current && (current + " " + clause).length > width * 2) {
        chunks.push(current);
        current = clause;
      } else current = current ? current + " " + clause : clause;
    }
    if (current) chunks.push(current);
  }
  return chunks.map((chunk) => {
    if (chunk.length <= width) return [chunk];
    const words = chunk.split(" ");
    let best = 1;
    let bestScore = Infinity;
    for (let i = 1; i < words.length; i++) {
      const a = words.slice(0, i).join(" ").length;
      const b = words.slice(i).join(" ").length;
      const score = Math.abs(a - b) + (a > width || b > width ? 1000 : 0);
      if (score < bestScore) {
        bestScore = score;
        best = i;
      }
    }
    return [words.slice(0, best).join(" "), words.slice(best).join(" ")];
  });
}

/** A chat bubble. Aya's sit left in white; the patient's sit right, tinted. */
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

/** Aya's mark: three bars of a sound wave, drawn on by `p` (0..1). */
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
