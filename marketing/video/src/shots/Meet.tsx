import React from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";

import { accent, accentText, color, display, font } from "../brand";
import { Aya, AYA } from "../components/Aya";
import { Logo, Tick } from "../components/ui";
import { LINES } from "../copy";
import { Push, Reveal, settle, Stage, useLayout } from "../layout";
import { CUES, shot } from "../timeline.mjs";

const { sub, signature, badges } = CUES.meet;
/** The text block's height, for laying Aya out beneath it in the tall cuts. */
const TEXT_H = 450;

/**
 * Seven beats. Aya herself, cut out of her own footage, smiling, then
 * pointing at what she says: "Hi, I'm Aya.", her line, healdesk's signature
 * and the two facts a clinic owner asks first. In the tall cuts she stands on
 * the frame's bottom edge under the text, her face high enough to clear a
 * Reel's captions; in 16:9 she fills the frame's height on the right and
 * points at the text. The camera pushes in on her; the text stays still.
 */
export const Meet: React.FC = () => {
  const { wide, frameBottom } = useLayout();
  const { from, to } = shot("meet");
  const length = to - from;

  // Tall cuts: as large as the space under the text allows, the tip of her
  // thumb just inside the left edge when she points.
  const width = wide ? 1440 : Math.min(1350, (frameBottom - TEXT_H - 140) / AYA.aspect);
  const height = width * AYA.aspect;
  const top = wide ? 0 : frameBottom - height;
  const left = wide ? 680 : 20 - AYA.thumbX * width;
  const textTop = wide ? (1080 - TEXT_H) / 2 : Math.max(40, Math.min(150, top - TEXT_H - 90));

  return (
    <AbsoluteFill style={{ background: color.white }}>
      <Stage>
        <Push length={length} amount={0.05} origin={`${left + AYA.faceX * width}px ${top + AYA.faceY * height}px`}>
          <Aya left={left} top={top} width={width} length={length} fadeTop={!wide} />
        </Push>
        <Text top={textTop} wide={wide} />
      </Stage>
    </AbsoluteFill>
  );
};

const Text: React.FC<{ top: number; wide: boolean }> = ({ top, wide }) => {
  const frame = useCurrentFrame();
  const align = wide ? "flex-start" : "center";
  return (
    <div style={{ position: "absolute", top, left: wide ? 120 : 0, right: wide ? undefined : 0, textAlign: wide ? "left" : "center", fontFamily: font, color: color.ink }}>
      <div style={{ ...display, fontSize: wide ? 160 : 150 }}>
        <Reveal at={-6}>
          {LINES.hello[0]} <span style={accentText}>{LINES.hello[1]}</span>
        </Reveal>
      </div>
      <div style={{ fontSize: wide ? 58 : 60, fontWeight: 500, letterSpacing: "-0.015em", color: color.grey, marginTop: 16 }}>
        <Reveal at={sub}>{LINES.helloSub}</Reveal>
      </div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: align, gap: 16, marginTop: 30, ...settle(frame, signature) }}>
        <span style={{ fontSize: 46, fontWeight: 500, color: color.grey }}>{LINES.by}</span>
        <Logo height={64} />
      </div>
      <div style={{ display: "flex", gap: 16, justifyContent: align, marginTop: 34 }}>
        {LINES.badges.map((text, i) => (
          <div key={text} style={settle(frame, badges[i])}>
            <Badge text={text} />
          </div>
        ))}
      </div>
    </div>
  );
};

/** A fact, checked: an accent tick and the words, on Apple's light grey. */
const Badge: React.FC<{ text: string }> = ({ text }) => (
  <span style={{ display: "inline-flex", alignItems: "center", gap: 14, padding: "14px 28px 14px 16px", borderRadius: 999, background: color.surface, fontSize: 40, fontWeight: 600, letterSpacing: "-0.01em" }}>
    <span style={{ width: 44, height: 44, borderRadius: "50%", background: accent, display: "inline-flex", alignItems: "center", justifyContent: "center" }}>
      <Tick size={26} />
    </span>
    {text}
  </span>
);
