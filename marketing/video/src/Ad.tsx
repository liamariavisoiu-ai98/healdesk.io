import React from "react";
import { AbsoluteFill, Audio, Sequence, staticFile } from "remotion";

import { DURATION, Hook, SCENES } from "./copy";
import { Stage } from "./motion";
import { Backdrop, Captions } from "./parts";
import { S1Hook } from "./scenes/S1Hook";
import { S2Arrival } from "./scenes/S2Arrival";
import { S3UrlBuild } from "./scenes/S3UrlBuild";
import { S4Channels } from "./scenes/S4Channels";
import { S5Deposit } from "./scenes/S5Deposit";
import { S6Night } from "./scenes/S6Night";
import { S7Close } from "./scenes/S7Close";
import { c, font } from "./tokens";

export type AdProps = { hook: Hook } & Record<string, unknown>;

const span = (s: { from: number; to: number }) => ({ from: s.from, durationInFrames: s.to - s.from });

/**
 * The hero cut, about 37 seconds. Each scene counts its own frames from 0; the
 * timeline is SCENES in copy.ts. The night ground runs under scenes 1 and 2,
 * since scene 2 floods ivory out from the coin.
 */
export const Ad: React.FC<AdProps> = ({ hook }) => (
  <AbsoluteFill style={{ background: c.night, fontFamily: font, overflow: "hidden" }}>
    <Sequence {...span({ from: SCENES.hook.from, to: SCENES.aya.to })} layout="none">
      <Backdrop mood="night" />
    </Sequence>
    <Sequence {...span(SCENES.hook)} layout="none">
      <S1Hook hook={hook} />
    </Sequence>
    <Sequence {...span(SCENES.aya)} layout="none">
      <S2Arrival />
    </Sequence>
    <Sequence {...span(SCENES.url)} layout="none">
      <S3UrlBuild />
    </Sequence>
    <Sequence {...span(SCENES.channels)} layout="none">
      <S4Channels />
    </Sequence>
    <Sequence {...span(SCENES.deposit)} layout="none">
      <S5Deposit />
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
