import React from "react";
import { AbsoluteFill, Audio, Sequence, staticFile } from "remotion";

import { color, font } from "./brand";
import { Channels } from "./shots/Channels";
import { Close } from "./shots/Close";
import { Interrupt } from "./shots/Interrupt";
import { Line } from "./shots/Line";
import { Meet } from "./shots/Meet";
import { Missed } from "./shots/Missed";
import { Pay } from "./shots/Pay";
import { Value } from "./shots/Value";
import { Website } from "./shots/Website";
import { SHOTS } from "./timeline.mjs";

const SHOT: Record<string, React.FC> = {
  missed: Missed,
  interrupt: Interrupt,
  meet: Meet,
  website: Website,
  channels: Channels,
  value: Value,
  pay: Pay,
  line: Line,
  close: Close,
};

/**
 * The ad: nine shots cut on the beat of its own track. Each shot counts its
 * frames from 0; where each starts and ends is src/timeline.mjs, which the
 * soundtrack is built from too.
 */
export const Ad: React.FC = () => (
  <AbsoluteFill style={{ background: color.black, fontFamily: font, overflow: "hidden" }}>
    {SHOTS.map(({ id, from, to }) => {
      const Shot = SHOT[id];
      return (
        <Sequence key={id} from={from} durationInFrames={to - from} layout="none">
          <Shot />
        </Sequence>
      );
    })}
    <Audio src={staticFile("soundtrack.wav")} />
  </AbsoluteFill>
);
