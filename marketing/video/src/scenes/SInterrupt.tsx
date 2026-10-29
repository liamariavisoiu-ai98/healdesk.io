import React from "react";
import { AbsoluteFill, interpolate } from "remotion";

import { useFrame, useLayout } from "../motion";
import { font } from "../tokens";

// healdesk's own pair, off the logo (apps/web/src/app/globals.css).
const HEALDESK_RED = "#E62627";
const HEALDESK_ORANGE = "#FF761E";

/**
 * The pattern interrupt, 8–10 s: a hard cut to black, and one line coming
 * into focus in white the way Apple sets a keynote title, then shading from
 * the left into healdesk's orange and red.
 */
export const SInterrupt: React.FC = () => {
  const frame = useFrame();
  const { wide } = useLayout();

  const focus = interpolate(frame, [4, 22], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: (t) => 1 - Math.pow(1 - t, 3) });
  // The gradient's colour edge travels from beyond the right of the words to their middle.
  const sweep = interpolate(frame, [18, 52], [130, 55], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: (t) => 1 - Math.pow(1 - t, 2) });
  const glow = interpolate(frame, [24, 52], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });

  return (
    <AbsoluteFill style={{ background: "#000", justifyContent: "center", alignItems: "center" }}>
      <div
        style={{
          fontFamily: font,
          fontWeight: 800,
          fontSize: wide ? 150 : 128,
          letterSpacing: "-0.045em",
          lineHeight: 1.02,
          textAlign: "center",
          padding: "0 60px",
          backgroundImage: `linear-gradient(100deg, #FFFFFF 0%, #FFFFFF ${sweep - 30}%, ${HEALDESK_ORANGE} ${sweep}%, ${HEALDESK_RED} ${sweep + 30}%)`,
          WebkitBackgroundClip: "text",
          backgroundClip: "text",
          color: "transparent",
          opacity: focus,
          filter: `blur(${(1 - focus) * 16}px) drop-shadow(0 0 ${40 * glow}px rgba(255,118,30,${0.25 * glow}))`,
          transform: `scale(${1.06 - 0.06 * focus + 0.015 * (frame / 60)})`,
        }}
      >
        Not on my
        {wide ? " " : <br />}
        watch.
      </div>
    </AbsoluteFill>
  );
};
