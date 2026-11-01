import React from "react";
import { Composition, continueRender, delayRender } from "remotion";

import { Ad } from "./Ad";
import { DURATION, FPS } from "./timeline.mjs";

// Wait for healdesk's two faces before any frame is taken.
const fontsReady = delayRender("Instrument Sans and Fraunces");
Promise.all([
  ...["400", "500", "600", "700"].map((w) => document.fonts.load(`${w} 40px "Instrument Sans Variable"`)),
  ...["400", "500", "600"].map((w) => document.fonts.load(`${w} 40px "Fraunces Variable"`)),
])
  .then(() => continueRender(fontsReady))
  .catch(() => continueRender(fontsReady));

/** 9:16 for Reels, Shorts and TikTok; 4:5 for the feeds; 16:9 for YouTube and the site. */
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
