import React from "react";
import { Img, staticFile } from "remotion";

import { AyaFilm } from "../aya";
import { LINES } from "../copy";
import { Stage, useFrame, useLayout } from "../motion";
import { Backdrop } from "../parts";
import { accent, c, font, serif } from "../tokens";
import { rise } from "./Hello";

const HOLD = 127;

/**
 * 0:35–0:39.5. The end card, healdesk's lockup: Aya, still moving, points
 * to it; the healdesk wordmark, its line in Fraunces, "Try Aya free" and the
 * address. "Free" is the Aya built from a clinic's website (healdesk has no
 * free trial). The last 15 frames hold still so the address reads.
 */
export const Close: React.FC = () => {
  const live = useFrame();
  const frame = Math.min(live, HOLD);
  const { wide } = useLayout();
  const film = wide ? { width: 1500, left: 560, top: 70 } : { width: 1600, left: -516, top: -30 };
  const col: React.CSSProperties = wide
    ? { position: "absolute", left: 140, top: 250, width: 820, alignItems: "flex-start", textAlign: "left" }
    : { position: "absolute", left: 0, right: 0, top: 860, alignItems: "center", textAlign: "center" };
  return (
    <>
      <Backdrop mood="white" />
      <Stage>
        {/* Her own footage, from the moment she starts to point, slowed a little so she keeps moving. */}
        <AyaFilm {...film} from={1} rate={0.75} push={0.03} />
        <div style={{ ...col, display: "flex", flexDirection: "column", fontFamily: font }}>
          <Img src={staticFile("healdesk-logo.png")} style={{ width: wide ? 620 : 640, ...rise(frame, 6, 18) }} />
          <div style={{ fontFamily: serif, fontSize: wide ? 54 : 50, fontWeight: 400, color: c.ink, marginTop: 26, letterSpacing: "-0.01em", ...rise(frame, 18, 18) }}>{LINES.tagline}</div>
          <div style={{ marginTop: 52, padding: "30px 64px", borderRadius: 999, background: accent, color: "#fff", fontSize: 54, fontWeight: 600, boxShadow: "0 20px 44px rgba(230,38,39,0.28)", ...rise(frame, 32, 16) }}>{LINES.close}</div>
          <div style={{ marginTop: 34, fontSize: 44, fontWeight: 500, color: c.grey, letterSpacing: "0.01em", ...rise(frame, 44, 16) }}>{LINES.domain}</div>
        </div>
      </Stage>
    </>
  );
};
