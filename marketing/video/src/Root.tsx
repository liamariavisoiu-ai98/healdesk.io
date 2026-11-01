import React from "react";
import { Composition, continueRender, delayRender } from "remotion";

import { Ad } from "./Ad";
import { DURATION } from "./copy";

const FPS = 30;

// Wait for Inter at every weight the ad uses before any frame is taken.
const fontsReady = delayRender("Inter");
Promise.all(["400", "500", "600", "700", "800"].map((w) => document.fonts.load(`${w} 40px "Inter Variable"`)))
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
      <Composition key={f.id} id={f.id} component={Ad} durationInFrames={DURATION} fps={FPS} width={f.width} height={f.height} />
    ))}
  </>
);
