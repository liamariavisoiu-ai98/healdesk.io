import React from "react";
import { AbsoluteFill, interpolate } from "remotion";

import { LINES } from "../copy";
import { lerp, useFrame, useLayout } from "../motion";
import { Backdrop } from "../parts";
import { c, font } from "../tokens";

const WORDS = 1;

/**
 * 0:09–0:10.5, one beat of the song. The camera has flown into the phone's
 * screen; it opens onto frosted white with a flash on the drop, and "Not on
 * my watch." lands hard, its ink shading into healdesk's orange and red, and
 * is gone a second and a half later.
 */
export const Interrupt: React.FC = () => {
  const frame = useFrame();
  const { wide } = useLayout();

  const flash = interpolate(frame, [0, 1, 8], [1, 1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const ease = (t: number) => 1 - Math.pow(1 - t, 4);
  const inP = interpolate(frame, [WORDS, WORDS + 9], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: ease });
  const sweep = interpolate(frame, [WORDS + 3, WORDS + 26], [120, 50], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: ease });

  return (
    <>
      <Backdrop mood="white" />
      <AbsoluteFill style={{ justifyContent: "center", alignItems: "center", transform: `scale(${1 + 0.05 * lerp(frame, [WORDS, 45], [0, 1], (t) => t)})` }}>
        <div
          style={{
            fontFamily: font,
            fontWeight: 700,
            fontSize: wide ? 150 : 128,
            letterSpacing: "-0.02em",
            lineHeight: 1.04,
            textAlign: "center",
            padding: "0 40px",
            backgroundImage: `linear-gradient(100deg, ${c.plum} 0%, ${c.plum} ${sweep - 34}%, ${c.healdeskOrange} ${sweep}%, ${c.healdeskRed} ${sweep + 34}%)`,
            WebkitBackgroundClip: "text",
            backgroundClip: "text",
            color: "transparent",
            opacity: inP,
            filter: `blur(${(1 - inP) * 10}px)`,
            transform: `scale(${1.18 - 0.18 * inP})`,
          }}
        >
          {wide ? LINES.interrupt : (<>Not on my<br />watch.</>)}
        </div>
      </AbsoluteFill>
      <AbsoluteFill style={{ background: "#fff", opacity: flash }} />
    </>
  );
};

