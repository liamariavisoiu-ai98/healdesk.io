import React from "react";
import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";

import { accentText, color, display, font } from "../brand";
import { AppIcon, AyaAvatar } from "../components/ui";
import { BOOKINGS, LINES, money } from "../copy";
import { ease, Push, settle, Stage, useLayout } from "../layout";
import { CUES, shot } from "../timeline.mjs";

const { lands } = CUES.value;
/** After a booking lands, its price rises into the total, which rolls up as it arrives. */
const RISE = 14;

/**
 * Thirteen beats on white. "Booked value", from $0: under it the five
 * channels wait, greyed. On every other beat one books, lights up, and its
 * price rises into the number, which rolls to $1,648, the bookings at the
 * clinic's own prices. Never "revenue".
 */
export const Value: React.FC = () => {
  const frame = useCurrentFrame();
  const { wide } = useLayout();
  const { from, to } = shot("value");
  const W = wide ? 1920 : 1080;
  const value = BOOKINGS.reduce((sum, b, i) => sum + b.value * ease(frame, lands[i] + 6, lands[i] + RISE + 4), 0);
  const booked = lands.filter((t) => frame >= t).length;
  const lastLand = lands[booked - 1] ?? -99;
  const bump = Math.sin(ease(frame, lastLand + RISE - 2, lastLand + RISE + 10) * Math.PI);
  const size = wide ? 116 : 124;
  const gap = wide ? 52 : 40;
  const rowW = BOOKINGS.length * size + (BOOKINGS.length - 1) * gap;
  const top = wide ? 170 : 330;
  const numberTop = top + 96;
  const iconsTop = numberTop + (wide ? 400 : 380);

  return (
    <AbsoluteFill style={{ background: color.white }}>
      <Stage>
        <Push length={to - from} amount={0.03}>
          <div style={{ position: "absolute", left: 0, width: W, top, textAlign: "center", fontFamily: font, fontSize: 58, fontWeight: 600, letterSpacing: "-0.02em", color: color.grey, ...settle(frame, -10) }}>{LINES.bookedValue}</div>
          <div
            style={{
              position: "absolute",
              left: 0,
              width: W,
              top: numberTop,
              textAlign: "center",
              ...display,
              fontSize: wide ? 330 : 290,
              letterSpacing: "-0.05em",
              lineHeight: 1,
              fontVariantNumeric: "tabular-nums",
              color: color.ink,
              transform: `scale(${1 + 0.025 * bump})`,
              ...settle(frame, -8),
            }}
          >
            {money(Math.round(value))}
          </div>

          {BOOKINGS.map((b, i) => {
            const x = (W - rowW) / 2 + i * (size + gap);
            const on = ease(frame, lands[i], lands[i] + 8);
            const pulse = Math.sin(on * Math.PI);
            const rise = interpolate(frame, [lands[i], lands[i] + RISE], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
            return (
              <React.Fragment key={b.channel}>
                <div style={{ position: "absolute", left: x, top: iconsTop, transform: `scale(${1 + 0.12 * pulse})`, ...settle(frame, -6 + i * 2, 14, 30) }}>
                  <div style={{ filter: `grayscale(${1 - on})`, opacity: 0.3 + 0.7 * on }}>
                    <AppIcon channel={b.channel} size={size} shadow={on > 0.5} />
                  </div>
                </div>
                {frame >= lands[i] && rise < 1 ? (
                  <div
                    style={{
                      position: "absolute",
                      left: x + size / 2 - 150,
                      width: 300,
                      top: iconsTop - 70 - rise * (iconsTop - numberTop - 230),
                      textAlign: "center",
                      fontFamily: font,
                      fontSize: 54,
                      fontWeight: 600,
                      letterSpacing: "-0.02em",
                      opacity: rise < 0.2 ? rise / 0.2 : 1 - Math.max(0, rise - 0.55) / 0.45,
                      transform: `scale(${1 - 0.3 * rise})`,
                    }}
                  >
                    <span style={accentText}>+{money(b.value)}</span>
                  </div>
                ) : null}
              </React.Fragment>
            );
          })}

          <div style={{ position: "absolute", left: 0, width: W, top: iconsTop + size + (wide ? 70 : 90), display: "flex", justifyContent: "center", alignItems: "center", gap: 20, fontFamily: font, fontSize: 50, fontWeight: 500, letterSpacing: "-0.015em", color: color.grey, ...settle(frame, lands[0]) }}>
            <AyaAvatar size={80} />
            <span>
              <b style={{ color: color.ink, fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>
                {booked} {booked === 1 ? "booking" : "bookings"}
              </b>{" "}
              {LINES.atYourPrices}
            </span>
          </div>
        </Push>
      </Stage>
    </AbsoluteFill>
  );
};
