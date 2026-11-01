import React from "react";
import { AbsoluteFill, interpolate, useVideoConfig } from "remotion";

import { LINES } from "../copy";
import { lerp, useFrame, useLayout } from "../motion";
import { Backdrop, Coin } from "../parts";
import { c, font, tracked } from "../tokens";

const DROP = 12;
const HIT = 40;
const WORDS = 58;

/**
 * 0:10–0:15. The screen goes dark. One coin falls through the black, the
 * loss, and the instant it lands the frame flashes to pure frosted white.
 * "Not on my watch." eases in, its ink shading into healdesk's orange and red.
 */
export const Interrupt: React.FC = () => {
  const frame = useFrame();
  const { wide } = useLayout();
  const { width, height } = useVideoConfig();

  const fall = lerp(frame, [DROP, HIT], [0, 1], (t) => t * t);
  const coinY = interpolate(fall, [0, 1], [-200, height * 0.5]);
  const flash = interpolate(frame, [HIT, HIT + 4, HIT + 16], [0, 1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const white = frame >= HIT + 3;

  const ease = (t: number) => 1 - Math.pow(1 - t, 4);
  const inP = interpolate(frame, [WORDS, WORDS + 34], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: ease });
  const sweep = interpolate(frame, [WORDS + 14, WORDS + 70], [120, 52], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: ease });

  return (
    <>
      <AbsoluteFill style={{ background: "#000" }} />
      {frame >= DROP && !white ? (
        <div style={{ position: "absolute", left: width / 2 - 70, top: coinY - 70, transform: `rotate(${frame * 6}deg)` }}>
          <Coin size={140} spin={frame * 0.4} />
        </div>
      ) : null}
      {white ? <Backdrop mood="white" /> : null}
      <AbsoluteFill style={{ background: "#fff", opacity: flash }} />

      {white ? (
        <AbsoluteFill style={{ justifyContent: "center", alignItems: "center", transform: `scale(${1 + 0.03 * lerp(frame, [WORDS, 150], [0, 1], (t) => t)})` }}>
          <div
            style={{
              fontFamily: font,
              fontWeight: 600,
              fontSize: wide ? 140 : 120,
              letterSpacing: tracked,
              lineHeight: 1.04,
              textAlign: "center",
              padding: "0 40px",
              backgroundImage: `linear-gradient(100deg, ${c.plum} 0%, ${c.plum} ${sweep - 34}%, ${c.healdeskOrange} ${sweep}%, ${c.healdeskRed} ${sweep + 34}%)`,
              WebkitBackgroundClip: "text",
              backgroundClip: "text",
              color: "transparent",
              opacity: inP,
              filter: `blur(${(1 - inP) * 14}px)`,
              transform: `translateY(${(1 - inP) * 30}px)`,
            }}
          >
            {wide ? LINES.interrupt : (<>Not on my<br />watch.</>)}
          </div>
        </AbsoluteFill>
      ) : null}
    </>
  );
};
