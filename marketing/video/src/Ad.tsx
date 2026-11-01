import React from "react";
import { AbsoluteFill, Audio, Sequence, staticFile } from "remotion";

import { DURATION, SCENES } from "./copy";
import { Speed, Stage } from "./motion";
import { Captions } from "./parts";
import { Close } from "./scenes/Close";
import { Dashboard } from "./scenes/Dashboard";
import { Deposit } from "./scenes/Deposit";
import { Hello } from "./scenes/Hello";
import { Interrupt } from "./scenes/Interrupt";
import { Missed } from "./scenes/Missed";
import { c, font } from "./tokens";

const span = (s: { from: number; to: number }) => ({ from: s.from, durationInFrames: s.to - s.from });

const SCENE_COMPONENTS: Record<keyof typeof SCENES, React.FC> = {
  missed: Missed,
  interrupt: Interrupt,
  aya: Hello,
  dashboard: Dashboard,
  deposit: Deposit,
  close: Close,
};

/**
 * The 44-second cut, to the owner's Apple-style storyboard. Each scene counts
 * its own frames from 0; the timeline, with each scene's speed, is
 * src/timeline.json, which the soundtrack reads too.
 */
export const Ad: React.FC = () => (
  <AbsoluteFill style={{ background: c.night, fontFamily: font, overflow: "hidden" }}>
    {(Object.keys(SCENES) as (keyof typeof SCENES)[]).map((key) => {
      const Scene = SCENE_COMPONENTS[key];
      return (
        <Sequence key={key} {...span(SCENES[key])} layout="none">
          <Speed value={SCENES[key].speed}>
            <Scene />
          </Speed>
        </Sequence>
      );
    })}
    <Sequence from={0} durationInFrames={DURATION} layout="none">
      <Stage>
        <Captions />
      </Stage>
    </Sequence>
    <Audio src={staticFile("soundtrack.wav")} />
  </AbsoluteFill>
);
