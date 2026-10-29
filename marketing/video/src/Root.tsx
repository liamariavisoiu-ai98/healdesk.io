import React from "react";
import { Composition, continueRender, delayRender } from "remotion";

import { Ad, AdProps } from "./Ad";
import { DURATION } from "./copy";


const FPS = 30;

// Wait for the three weights of Plus Jakarta Sans before any frame is taken.
const fontsReady = delayRender("Plus Jakarta Sans");
Promise.all(["500", "600", "800"].map((w) => document.fonts.load(`${w} 40px "Plus Jakarta Sans"`)))
  .then(() => continueRender(fontsReady))
  .catch(() => continueRender(fontsReady));

const FORMATS = [
  { id: "AyaHero", width: 1080, height: 1920 },
  { id: "AyaFeed", width: 1080, height: 1350 },
  { id: "AyaWide", width: 1920, height: 1080 },
] as const;

export const Root: React.FC = () => (
  <>
    {FORMATS.map((f) => (
      <Composition
        key={f.id}
        id={f.id}
        component={Ad}
        durationInFrames={DURATION}
        fps={FPS}
        width={f.width}
        height={f.height}
        defaultProps={{ hook: "soft" }}
      />
    ))}
    {/* The 85% / 82% hook, for the hook test once its source is named. */}
    <Composition
      id="AyaHeroStat"
      component={Ad}
      durationInFrames={DURATION}
      fps={FPS}
      width={1080}
      height={1920}
      defaultProps={{ hook: "stat" }}
    />
  </>
);
