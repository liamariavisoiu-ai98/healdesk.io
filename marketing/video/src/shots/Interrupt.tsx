import React from "react";
import { AbsoluteFill } from "remotion";

import { accentText, color, display } from "../brand";
import { LINES } from "../copy";
import { Push, Reveal, useLayout } from "../layout";
import { shot } from "../timeline.mjs";

/**
 * The drop, three beats. A hard cut from the black phone to white, the line
 * already rising on the cut's first frame, "watch." in healdesk's colours.
 */
export const Interrupt: React.FC = () => {
  const { wide } = useLayout();
  const { from, to } = shot("interrupt");
  const [lead, word] = LINES.interrupt;
  return (
    <AbsoluteFill style={{ background: color.white }}>
      <Push length={to - from} amount={0.06}>
        <AbsoluteFill style={{ justifyContent: "center", alignItems: "center" }}>
          <div style={{ ...display, fontSize: wide ? 190 : 168, color: color.ink, textAlign: "center" }}>
            {wide ? (
              <Reveal at={-6} dur={12}>
                {lead} <span style={accentText}>{word}</span>
              </Reveal>
            ) : (
              <>
                <Reveal at={-6} dur={12}>{lead}</Reveal>
                <Reveal at={-3} dur={12}>
                  <span style={accentText}>{word}</span>
                </Reveal>
              </>
            )}
          </div>
        </AbsoluteFill>
      </Push>
    </AbsoluteFill>
  );
};
