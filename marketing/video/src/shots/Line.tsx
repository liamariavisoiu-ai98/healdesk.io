import React from "react";
import { AbsoluteFill } from "remotion";

import { accentText, display } from "../brand";
import { LINES } from "../copy";
import { Push, Reveal, useLayout } from "../layout";
import { CUES, shot } from "../timeline.mjs";

/**
 * Six beats, back on black: the line, large. The clinic's half in white, Aya's
 * half in healdesk's colours, a beat and a half behind it.
 */
export const Line: React.FC = () => {
  const { wide } = useLayout();
  const { from, to } = shot("line");
  const { second } = CUES.line;
  // Each line with its cue and whether it is Aya's half.
  const lines: [string, number, boolean][] = wide
    ? [
        [LINES.lineWide[0], -6, false],
        [LINES.lineWide[1], second, true],
      ]
    : [
        [LINES.line[0], -6, false],
        [LINES.line[1], -3, false],
        [LINES.line[2], second, true],
        [LINES.line[3], second + 3, true],
      ];
  return (
    <AbsoluteFill style={{ background: "#000" }}>
      <Push length={to - from} amount={0.05}>
        <AbsoluteFill style={{ justifyContent: "center", alignItems: "center" }}>
          <div style={{ ...display, fontSize: wide ? 150 : 160, letterSpacing: "-0.04em", color: "#F5F5F7", textAlign: "center" }}>
            {lines.map(([text, at, aya], i) => (
              <div key={text} style={{ marginTop: !wide && i === 2 ? 40 : 0 }}>
                <Reveal at={at}>
                  <span style={aya ? accentText : undefined}>{text}</span>
                </Reveal>
              </div>
            ))}
          </div>
        </AbsoluteFill>
      </Push>
    </AbsoluteFill>
  );
};
