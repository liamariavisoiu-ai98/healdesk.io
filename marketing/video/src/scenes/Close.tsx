import React from "react";
import { AbsoluteFill, Img, staticFile } from "remotion";

import { beats, LINES } from "../copy";
import { Drift, Reveal, useFrame, useLayout } from "../motion";
import { Backdrop } from "../parts";
import { accent, c, font, serif } from "../tokens";
import { rise } from "./Hello";

/** The end card moves until here, then holds still so the address reads. */
const HOLD = beats(10) - 15;

/**
 * 0:35–0:40. healdesk's end card and nothing else: the wordmark (its ".io" is
 * the address, so it is not printed twice), the site's line in Fraunces, and
 * "Try Aya free", the Aya built from a clinic's website (healdesk has no free
 * trial). The last 15 frames hold still.
 */
export const Close: React.FC = () => {
  const live = useFrame();
  const frame = Math.min(live, HOLD);
  const { wide } = useLayout();
  return (
    <>
      <Backdrop mood="white" />
      <Drift length={HOLD} amount={0.04}>
        <AbsoluteFill style={{ justifyContent: "center", alignItems: "center", fontFamily: font }}>
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", textAlign: "center" }}>
            <div style={rise(frame, 2, 18)}>
              <Img src={staticFile("healdesk-logo.png")} style={{ width: wide ? 900 : 880 }} />
            </div>
            <Reveal at={14} dur={18}>
              <div style={{ fontFamily: serif, fontSize: wide ? 72 : 64, fontWeight: 400, color: c.ink, marginTop: 30, letterSpacing: "-0.01em", padding: "0 40px" }}>{LINES.tagline}</div>
            </Reveal>
            <div style={{ marginTop: 70, padding: "36px 86px", borderRadius: 999, background: accent, color: "#fff", fontSize: 66, fontWeight: 600, boxShadow: "0 24px 50px rgba(230,38,39,0.28)", ...rise(frame, 28, 16) }}>{LINES.close}</div>
          </div>
        </AbsoluteFill>
      </Drift>
    </>
  );
};
