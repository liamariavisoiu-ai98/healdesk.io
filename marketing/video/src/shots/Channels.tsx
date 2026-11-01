import React from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";

import { accentText, display, font } from "../brand";
import { AppIcon } from "../components/ui";
import { type Channel, LINES } from "../copy";
import { ease, Push, Reveal, Stage, useLayout } from "../layout";
import { CUES, shot } from "../timeline.mjs";

const ORDER: Channel[] = ["phone", "instagram", "whatsapp", "messenger", "web"];

/**
 * Six beats, on black, the middle's one change of light. "Calls, DMs, chats.
 * All at once.", then the five channels land on eighths of the beat, each on
 * a glass floor with its reflection, like a product on Apple's black.
 */
export const Channels: React.FC = () => {
  const frame = useCurrentFrame();
  const { wide } = useLayout();
  const { from, to } = shot("channels");
  const lines = wide ? LINES.channelsWide : LINES.channels;
  const size = wide ? 150 : 156;
  const gap = wide ? 56 : 34;
  return (
    <AbsoluteFill style={{ background: "#000" }}>
      <AbsoluteFill style={{ background: "radial-gradient(70% 45% at 50% 78%, rgba(230,38,39,0.16) 0%, rgba(255,118,30,0.05) 45%, rgba(0,0,0,0) 75%)" }} />
      <Stage>
        <Push length={to - from} amount={0.05}>
          <div style={{ position: "absolute", left: 0, right: 0, top: wide ? 250 : 330, textAlign: "center", fontFamily: font }}>
            <div style={{ ...display, fontSize: wide ? 160 : 164, letterSpacing: "-0.04em", color: "#F5F5F7" }}>
              {lines.map((line, i) => (
                <Reveal key={line} at={i === lines.length - 1 ? 4 : -6 + i * 3}>
                  <span style={i === lines.length - 1 ? accentText : undefined}>{line}</span>
                </Reveal>
              ))}
            </div>
            <div style={{ display: "flex", justifyContent: "center", gap, marginTop: wide ? 100 : 130 }}>
              {ORDER.map((channel, i) => {
                const at = CUES.channels.icons[i];
                const p = ease(frame, at, at + 12);
                return (
                  <div key={channel} style={{ opacity: Math.min(1, p * 3), transform: `translateY(${(1 - p) * 50}px) scale(${0.86 + 0.14 * p})` }}>
                    <AppIcon channel={channel} size={size} shadow={false} />
                    <div style={{ marginTop: 10, height: size * 0.45, overflow: "hidden", opacity: 0.22, WebkitMaskImage: "linear-gradient(to bottom, #000, transparent 85%)", maskImage: "linear-gradient(to bottom, #000, transparent 85%)" }}>
                      <div style={{ transform: "scaleY(-1)", transformOrigin: "50% 50%", height: size, marginTop: 0 }}>
                        <AppIcon channel={channel} size={size} shadow={false} />
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </Push>
      </Stage>
    </AbsoluteFill>
  );
};
