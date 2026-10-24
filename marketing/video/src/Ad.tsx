import React from "react";
import { AbsoluteFill, Audio, staticFile, useCurrentFrame } from "remotion";

import { Hook } from "./copy";
import { Stage } from "./motion";
import { Captions } from "./parts";
import { S1Hook } from "./scenes/S1Hook";
import { S2Arrival } from "./scenes/S2Arrival";
import { S3UrlBuild } from "./scenes/S3UrlBuild";
import { S4Channels } from "./scenes/S4Channels";
import { S5Dream } from "./scenes/S5Dream";
import { S6Dare } from "./scenes/S6Dare";
import { c, font } from "./tokens";

export type AdProps = { hook: Hook } & Record<string, unknown>;

/**
 * The 36-second hero cut. Scenes are switched on the global frame rather
 * than wrapped in <Sequence>, so every timing in the code is the frame
 * number SCRIPT.md gives.
 */
export const Ad: React.FC<AdProps> = ({ hook }) => {
  const frame = useCurrentFrame();
  return (
    <AbsoluteFill style={{ background: c.night, fontFamily: font, overflow: "hidden" }}>
      {frame < 150 ? <S1Hook hook={hook} /> : null}
      {frame >= 150 && frame < 270 ? <S2Arrival /> : null}
      {frame >= 270 && frame < 450 ? <S3UrlBuild /> : null}
      {frame >= 450 && frame < 690 ? <S4Channels /> : null}
      {frame >= 690 && frame < 900 ? <S5Dream /> : null}
      {frame >= 900 ? <S6Dare /> : null}
      {frame < 1040 ? (
        <Stage>
          <Captions />
        </Stage>
      ) : null}
      <Audio src={staticFile("soundtrack.wav")} />
    </AbsoluteFill>
  );
};
