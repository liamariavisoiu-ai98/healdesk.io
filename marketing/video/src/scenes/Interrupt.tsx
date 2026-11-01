import React from "react";
import { AbsoluteFill, interpolate } from "remotion";

import { LINES } from "../copy";
import { lerp, useFrame, useLayout } from "../motion";
import { Backdrop } from "../parts";
import { c, font } from "../tokens";

const WORDS = 6;

/**
 * 0:09–0:13. The camera has flown into the phone's screen; it opens onto
 * pure frosted white with a flash, on the downbeat where the music opens up.
 * "Not on my watch." eases in, its ink shading into healdesk's orange and red.
 */
export const Interrupt: React.FC = () => {
  const frame = useFrame();
  const { wide } = useLayout();

  const flash = interpolate(frame, [0, 2, 14], [1, 1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const ease = (t: number) => 1 - Math.pow(1 - t, 4);
  const inP = interpolate(frame, [WORDS, WORDS + 30], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: ease });
  const sweep = interpolate(frame, [WORDS + 12, WORDS + 64], [120, 52], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: ease });

  return (
    <>
      <Backdrop mood="white" />
      <AbsoluteFill style={{ justifyContent: "center", alignItems: "center", transform: `scale(${1 + 0.035 * lerp(frame, [WORDS, 120], [0, 1], (t) => t)})` }}>
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
            filter: `blur(${(1 - inP) * 14}px)`,
            transform: `translateY(${(1 - inP) * 30}px) scale(${1.04 - 0.04 * inP})`,
          }}
        >
          {wide ? LINES.interrupt : (<>Not on my<br />watch.</>)}
        </div>
      </AbsoluteFill>
      <AbsoluteFill style={{ background: "#fff", opacity: flash }} />
    </>
  );
};

