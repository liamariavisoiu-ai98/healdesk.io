import React from "react";
import { AbsoluteFill, Audio, Sequence, staticFile } from "remotion";

import { DURATION, Hook, SCENES } from "./copy";
import { Speed, Stage } from "./motion";
import { Backdrop, Captions } from "./parts";
import { S1Hook } from "./scenes/S1Hook";
import { S2Arrival } from "./scenes/S2Arrival";
import { S3UrlBuild } from "./scenes/S3UrlBuild";
import { S4Channels } from "./scenes/S4Channels";
import { S5Deposit } from "./scenes/S5Deposit";
import { S6Night } from "./scenes/S6Night";
import { S7Close } from "./scenes/S7Close";
import { SInterrupt } from "./scenes/SInterrupt";
import { c, font } from "./tokens";

export type AdProps = { hook: Hook } & Record<string, unknown>;

const span = (s: { from: number; to: number }) => ({ from: s.from, durationInFrames: s.to - s.from });

/**
 * The hero cut, about 45 seconds. Each scene counts its own frames from 0; the
 * timeline, with each scene's speed, is src/timeline.json. Scenes 2 to 5 run
 * at three quarters speed, so a viewer has time to read the panels.
 */
export const Ad: React.FC<AdProps> = ({ hook }) => (
  <AbsoluteFill style={{ background: c.night, fontFamily: font, overflow: "hidden" }}>
    <Sequence {...span(SCENES.hook)} layout="none">
      <Backdrop mood="night" />
    </Sequence>
    <Sequence {...span(SCENES.hook)} layout="none">
      <S1Hook hook={hook} />
    </Sequence>
    <Sequence {...span(SCENES.interrupt)} layout="none">
      <SInterrupt />
    </Sequence>
    <Sequence {...span(SCENES.aya)} layout="none">
      <Speed value={SCENES.aya.speed}>
        <S2Arrival />
      </Speed>
    </Sequence>
    <Sequence {...span(SCENES.url)} layout="none">
      <Speed value={SCENES.url.speed}>
        <S3UrlBuild />
      </Speed>
    </Sequence>
    <Sequence {...span(SCENES.channels)} layout="none">
      <Speed value={SCENES.channels.speed}>
        <S4Channels />
      </Speed>
    </Sequence>
    <Sequence {...span(SCENES.deposit)} layout="none">
      <Speed value={SCENES.deposit.speed}>
        <S5Deposit />
      </Speed>
    </Sequence>
    <Sequence {...span(SCENES.night)} layout="none">
      <S6Night />
    </Sequence>
    <Sequence {...span(SCENES.close)} layout="none">
      <S7Close />
    </Sequence>
    <Sequence from={0} durationInFrames={DURATION} layout="none">
      <Stage>
        <Captions />
      </Stage>
    </Sequence>
    <Audio src={staticFile("soundtrack.wav")} />
  </AbsoluteFill>
);
