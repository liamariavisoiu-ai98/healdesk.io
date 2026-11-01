import React from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";

import { accent, accentText, color, display, font, shadow } from "../brand";
import { AyaAvatar, Tick } from "../components/ui";
import { CLINIC, LINES, money } from "../copy";
import { ease, Push, Reveal, settle, Stage, useLayout } from "../layout";
import { CUES, shot } from "../timeline.mjs";

const { typeFrom, typeTo, learned, treatments } = CUES.website;
const ADDRESS = CLINIC.url;

/**
 * Ten beats on Apple's light grey. "Just add your website.": the address
 * types itself in, Aya reads the site, and what she learned settles in one
 * card: the clinic, its treatments and its own prices.
 */
export const Website: React.FC = () => {
  const frame = useCurrentFrame();
  const { wide } = useLayout();
  const { from, to } = shot("website");
  const W = wide ? 1920 : 1080;
  const boxW = wide ? 1240 : 1000;
  return (
    <AbsoluteFill style={{ background: color.surface }}>
      <Stage>
        <Push length={to - from} amount={0.035}>
          <div style={{ position: "absolute", left: (W - boxW) / 2, width: boxW, top: wide ? 150 : 215, fontFamily: font, color: color.ink }}>
            <div style={{ ...display, fontSize: wide ? 124 : 128, textAlign: "center" }}>
              {wide ? (
                <Reveal at={-6}>
                  {LINES.website[0]} <span style={accentText}>{LINES.website[1]}</span>
                </Reveal>
              ) : (
                <>
                  <Reveal at={-6}>{LINES.website[0]}</Reveal>
                  <Reveal at={-2}>
                    <span style={accentText}>{LINES.website[1]}</span>
                  </Reveal>
                </>
              )}
            </div>
            <div style={{ marginTop: wide ? 56 : 64, ...settle(frame, -8, 18, 60) }}>
              <Field frame={frame} />
            </div>
            <div style={{ marginTop: wide ? 48 : 60, ...settle(frame, learned, 18, 60) }}>
              <Learned frame={frame} wide={wide} />
            </div>
          </div>
        </Push>
      </Stage>
    </AbsoluteFill>
  );
};

/** The address field: typed on the beat, sent, read, ticked. */
const Field: React.FC<{ frame: number }> = ({ frame }) => {
  const step = (typeTo - typeFrom) / ADDRESS.length;
  const typed = Math.max(0, Math.min(ADDRESS.length, Math.floor((frame - typeFrom) / step) + 1));
  const typing = frame >= typeFrom;
  const reading = frame >= typeTo && frame < learned;
  const done = frame >= learned;
  const caret = !done && (typing ? frame < typeTo : Math.floor(frame / 8) % 2 === 0);
  const press = Math.sin(ease(frame, typeTo, typeTo + 8) * Math.PI);
  return (
    <div style={{ height: 170, borderRadius: 999, background: color.white, boxShadow: shadow, display: "flex", alignItems: "center", padding: "0 20px 0 56px" }}>
      {caret && !typing ? <Caret /> : null}
      <span style={{ fontSize: 64, fontWeight: 500, letterSpacing: "-0.02em", color: typing ? color.ink : color.faint, whiteSpace: "nowrap" }}>{typing ? ADDRESS.slice(0, typed) : "yourwebsite.com"}</span>
      {caret && typing ? <Caret /> : null}
      <div style={{ flex: 1 }} />
      <div
        style={{
          width: 130,
          height: 130,
          borderRadius: "50%",
          flexShrink: 0,
          background: done ? accent : reading ? color.ink : color.surface,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          transform: `scale(${1 - 0.08 * press})`,
        }}
      >
        {done ? (
          <Tick size={62} p={ease(frame, learned, learned + 10)} />
        ) : reading ? (
          <div style={{ width: 56, height: 56, borderRadius: "50%", border: "6px solid rgba(255,255,255,0.25)", borderTopColor: color.white, transform: `rotate(${frame * 24}deg)` }} />
        ) : (
          <svg width="56" height="56" viewBox="0 0 24 24">
            <path d="M5 12h13M13 6l6 6-6 6" fill="none" stroke={color.grey} strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
      </div>
    </div>
  );
};

const Caret: React.FC = () => <span style={{ width: 5, height: 74, margin: "0 4px", borderRadius: 3, background: color.orange, flexShrink: 0 }} />;

/** What Aya learned, as one card: the clinic, then a row for each treatment and its price. */
const Learned: React.FC<{ frame: number; wide: boolean }> = ({ frame, wide }) => (
  <div style={{ borderRadius: 44, background: color.white, boxShadow: shadow, overflow: "hidden" }}>
    <div style={{ display: "flex", alignItems: "center", gap: 22, padding: "30px 44px" }}>
      <AyaAvatar size={92} ring />
      <span style={{ fontSize: 48, fontWeight: 500, color: color.grey, letterSpacing: "-0.015em", whiteSpace: "nowrap" }}>
        {LINES.learned} <b style={{ color: color.ink, fontWeight: 600 }}>{CLINIC.name}</b>
      </span>
    </div>
    <div style={{ display: wide ? "flex" : "block", borderTop: `1px solid ${color.line}` }}>
      {CLINIC.treatments.map((t, i) => {
        const p = ease(frame, treatments[i], treatments[i] + 12);
        const rule = i ? `1px solid ${color.line}` : undefined;
        return (
          <div key={t.name} style={{ position: "relative", ...(wide ? { flex: 1, padding: "30px 44px", borderLeft: rule } : { padding: "30px 48px", borderTop: rule }) }}>
            {p < 1 ? <Skeleton frame={frame} wide={wide} opacity={1 - p} /> : null}
            <div style={{ opacity: p, transform: `translateY(${(1 - p) * 18}px)`, display: wide ? "block" : "flex", justifyContent: "space-between", alignItems: "baseline" }}>
              <div style={{ fontSize: wide ? 46 : 52, fontWeight: 600, letterSpacing: "-0.02em" }}>{t.name}</div>
              <div style={{ fontSize: wide ? 56 : 52, fontWeight: 600, letterSpacing: "-0.02em", ...accentText }}>{money(t.price)}</div>
            </div>
          </div>
        );
      })}
    </div>
  </div>
);

/** A row still being read: grey bars with light passing over them, until the row's words arrive. */
const Skeleton: React.FC<{ frame: number; wide: boolean; opacity: number }> = ({ frame, wide, opacity }) => {
  const bar = (width: number, height: number): React.CSSProperties => ({
    width,
    height,
    borderRadius: height / 2,
    backgroundImage: "linear-gradient(90deg, #EDEDF0 0%, #EDEDF0 35%, #F8F8FA 50%, #EDEDF0 65%, #EDEDF0 100%)",
    backgroundSize: "300% 100%",
    backgroundPosition: `${100 - ((frame * 4) % 200)}% 0`,
  });
  return (
    <div style={{ position: "absolute", inset: wide ? "30px 44px" : "30px 48px", opacity, display: "flex", flexDirection: wide ? "column" : "row", justifyContent: wide ? "center" : "space-between", alignItems: wide ? "flex-start" : "center", gap: 16 }}>
      <div style={bar(wide ? 190 : 240, 30)} />
      <div style={bar(wide ? 120 : 110, 30)} />
    </div>
  );
};
