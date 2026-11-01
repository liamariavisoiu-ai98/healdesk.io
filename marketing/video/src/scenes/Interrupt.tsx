import React from "react";
import { AbsoluteFill, interpolate } from "remotion";

import { Drift, Reveal, useFrame, useLayout } from "../motion";
import { Backdrop } from "../parts";
import { accentText, c, font } from "../tokens";

/**
 * 0:09–0:10.5, three beats of the song. The camera has flown into the
 * phone's screen; it opens onto white with a flash on the drop, and "Not on my
 * watch." rises out of a mask, the one key word in healdesk's colours.
 */
export const Interrupt: React.FC = () => {
  const frame = useFrame();
  const { wide } = useLayout();
  const flash = interpolate(frame, [0, 1, 8], [1, 1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const size = wide ? 170 : 150;
  return (
    <>
      <Backdrop mood="white" />
      <Drift length={44} amount={0.05}>
        <AbsoluteFill style={{ justifyContent: "center", alignItems: "center" }}>
          <div style={{ fontFamily: font, fontWeight: 600, fontSize: size, letterSpacing: "-0.035em", lineHeight: 1.02, color: c.ink, textAlign: "center" }}>
            {wide ? (
              <Reveal at={0} dur={10}>
                Not on my <span style={accentText}>watch.</span>
              </Reveal>
            ) : (
              <>
                <Reveal at={0} dur={10}>Not on my</Reveal>
                <Reveal at={3} dur={10}>
                  <span style={accentText}>watch.</span>
                </Reveal>
              </>
            )}
          </div>
        </AbsoluteFill>
      </Drift>
      <AbsoluteFill style={{ background: "#fff", opacity: flash }} />
    </>
  );
};
