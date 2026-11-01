import React from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";

import { accent, color, font, serif } from "../brand";
import { Logo } from "../components/ui";
import { LINES } from "../copy";
import { Push, Reveal, settle, useLayout } from "../layout";
import { CUES } from "../timeline.mjs";

const { tagline, button, hold } = CUES.close;

/**
 * Ten beats. healdesk's end card and nothing else, on white warmed from below
 * by the brand's light: the wordmark (its ".io" is the address, so it is not
 * printed twice), the site's line in Fraunces, and "Try Aya free", the Aya
 * built from a clinic's website (healdesk has no free trial). The last half
 * second holds still.
 */
export const Close: React.FC = () => {
  const frame = Math.min(useCurrentFrame(), hold);
  const { wide } = useLayout();
  return (
    <AbsoluteFill style={{ background: color.white }}>
      <AbsoluteFill style={{ background: "radial-gradient(90% 55% at 50% 118%, rgba(255,118,30,0.20) 0%, rgba(230,38,39,0.07) 45%, rgba(255,255,255,0) 72%)" }} />
      <Push length={hold} amount={0.035} hold={hold}>
        <AbsoluteFill style={{ justifyContent: "center", alignItems: "center", fontFamily: font }}>
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", textAlign: "center" }}>
            <div style={settle(frame, -10, 20, 50)}>
              <Logo height={wide ? 170 : 160} />
            </div>
            <div style={{ fontFamily: serif, fontSize: wide ? 70 : 62, fontWeight: 400, color: color.ink, marginTop: 34, letterSpacing: "-0.01em", padding: "0 40px" }}>
              <Reveal at={tagline} dur={18}>
                {LINES.tagline}
              </Reveal>
            </div>
            <div style={{ marginTop: 72, padding: "34px 84px", borderRadius: 999, background: accent, color: color.white, fontSize: 64, fontWeight: 600, letterSpacing: "-0.015em", boxShadow: "0 24px 50px rgba(230,38,39,0.28)", ...settle(frame, button, 16, 40) }}>
              {LINES.cta}
            </div>
          </div>
        </AbsoluteFill>
      </Push>
    </AbsoluteFill>
  );
};
