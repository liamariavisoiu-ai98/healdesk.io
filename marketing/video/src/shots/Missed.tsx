import React from "react";
import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";

import { accentText, color, font } from "../brand";
import { IPhone } from "../components/IPhone";
import { AppIcon, Notification } from "../components/ui";
import { CALLER, type Channel, DMS, LINES } from "../copy";
import { ease, Stage, useLayout } from "../layout";
import { CUES, shot } from "../timeline.mjs";

const { callEnd, calls, swap, dms, exit } = CUES.missed;
const LENGTH = shot("missed").to;

/** Each DM in the pile-up, on its cue. */
const PILE = dms.map((at: number, i: number) => ({ at, ...DMS[i % DMS.length] }));

/**
 * 0:00–0:09. A real-looking iPhone on black, its wallpaper healdesk's embers,
 * already ringing on frame 0. The call goes unanswered; the missed calls
 * stack, one on each beat, and the Phone icon's badge counts them. "calls?"
 * rolls to "DMs?", the messages pour in faster and faster, each app's icon
 * counting too, and the camera flies into the screen.
 */
export const Missed: React.FC = () => {
  const frame = useCurrentFrame();
  const { wide } = useLayout();

  const phoneW = wide ? 470 : 700;
  const phoneX = wide ? 1060 : (1080 - phoneW) / 2;
  const phoneY = wide ? 40 : 370;
  const s = phoneW / 600;

  const out = interpolate(frame, [exit, LENGTH], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: (t) => t * t });
  const punch = Math.sin(ease(frame, swap, swap + 12) * Math.PI);
  const scale = 1 + 0.06 * (frame / LENGTH) + 0.02 * punch + out * 0.9;
  const turn = interpolate(frame, [0, LENGTH], [-8, 6]);

  const ringing = frame < callEnd;
  const lastEvent = [...calls, ...dms].filter((t) => t <= frame).pop() ?? -99;
  const buzz = (ringing && frame % 16 < 9) || frame - lastEvent < 5 ? Math.sin(frame * 3.3) : 0;

  return (
    <AbsoluteFill style={{ background: color.black }}>
      {/* healdesk's warm light behind the phone. */}
      <AbsoluteFill style={{ background: "radial-gradient(60% 45% at 55% 62%, rgba(230,38,39,0.22) 0%, rgba(255,118,30,0.08) 45%, rgba(0,0,0,0) 75%)" }} />
      <Stage>
        <Title frame={frame} wide={wide} out={out} />
        <div
          style={{
            position: "absolute",
            left: phoneX,
            top: phoneY,
            transformOrigin: "50% 40%",
            transform: `perspective(2400px) scale(${scale}) rotateY(${turn}deg) rotateX(${2 + Math.sin(frame / 50)}deg) rotateZ(${buzz * 0.6}deg) translateX(${buzz * 3}px)`,
            filter: out > 0 ? `blur(${out * 18}px)` : undefined,
          }}
        >
          <IPhone width={phoneW}>{ringing ? <IncomingCall frame={frame} s={s} /> : <LockScreen frame={frame} s={s} />}</IPhone>
        </div>
        <Icons frame={frame} wide={wide} phoneX={phoneX} phoneY={phoneY} phoneW={phoneW} out={out} />
      </Stage>
    </AbsoluteFill>
  );
};

/** "Is your clinic missing calls?", the last word rolling to "DMs?" in a mask. */
const Title: React.FC<{ frame: number; wide: boolean; out: number }> = ({ frame, wide, out }) => {
  const size = wide ? 110 : 100;
  const lh = size * 1.12;
  const roll = ease(frame, swap, swap + 14);
  const box: React.CSSProperties = wide
    ? { position: "absolute", left: 160, top: 360, width: 820, textAlign: "left" }
    : { position: "absolute", left: 0, right: 0, top: 44, textAlign: "center" };
  const accentWord = (text: string) => <div style={{ height: lh, ...accentText }}>{text}</div>;
  return (
    <div style={{ ...box, fontFamily: font, fontWeight: 700, fontSize: size, letterSpacing: "-0.02em", lineHeight: `${lh}px`, color: "#F5F5F7", opacity: 1 - out }}>
      <div>{LINES.calls[0]}</div>
      <div style={{ display: "flex", justifyContent: wide ? "flex-start" : "center", gap: size * 0.26 }}>
        <div>{LINES.calls[1]}</div>
        <div style={{ height: lh, overflow: "hidden" }}>
          <div style={{ transform: `translateY(${-roll * lh}px)` }}>
            {accentWord(LINES.calls[2])}
            {accentWord(LINES.dms)}
          </div>
        </div>
      </div>
    </div>
  );
};

const PHONE_GLYPH =
  "M6.6 10.8c1.4 2.8 3.8 5.1 6.6 6.6l2.2-2.2c.3-.3.7-.4 1-.2 1.1.4 2.3.6 3.6.6.6 0 1 .4 1 1V20c0 .6-.4 1-1 1C10.6 21 3 13.4 3 4c0-.6.4-1 1-1h3.5c.6 0 1 .4 1 1 0 1.3.2 2.5.6 3.6.1.3 0 .7-.2 1L6.6 10.8z";

/** iOS's full-screen incoming call: the caller, and "slide to answer" shimmering. */
const IncomingCall: React.FC<{ frame: number; s: number }> = ({ frame, s }) => {
  const fade = 1 - ease(frame, callEnd - 6, callEnd);
  const shimmer = ((frame * 2.4) % 140) - 20;
  const button = (size: number, fill: string, glyph: string) => (
    <div style={{ width: size * s, height: size * s, borderRadius: "50%", background: fill, display: "flex", alignItems: "center", justifyContent: "center" }}>
      <svg width={size * 0.45 * s} height={size * 0.45 * s} viewBox="0 0 24 24">
        <path fill={glyph} d={PHONE_GLYPH} />
      </svg>
    </div>
  );
  return (
    <AbsoluteFill style={{ color: color.white, textAlign: "center", opacity: fade, background: "rgba(0,0,0,0.25)", backdropFilter: "blur(30px)" }}>
      <div style={{ marginTop: 200 * s, fontSize: 30 * s, fontWeight: 500, opacity: 0.75 }}>mobile</div>
      <div style={{ fontSize: 54 * s, fontWeight: 600, marginTop: 6 * s, whiteSpace: "nowrap" }}>{CALLER}</div>
      {[0, 1, 2].map((k) => {
        const t = ((frame + k * 10) % 30) / 30;
        return <div key={k} style={{ position: "absolute", left: "50%", top: 640 * s, width: 160 * s, height: 160 * s, marginLeft: -80 * s, borderRadius: "50%", border: `${3 * s}px solid rgba(52,199,89,${0.6 * (1 - t)})`, transform: `scale(${1 + t * 1.6})` }} />;
      })}
      <div style={{ position: "absolute", left: "50%", top: 640 * s, marginLeft: -80 * s, boxShadow: "0 0 40px rgba(52,199,89,0.6)", borderRadius: "50%" }}>{button(160, "#34C759", "#fff")}</div>
      <div style={{ position: "absolute", left: 50 * s, right: 50 * s, bottom: 130 * s, height: 110 * s, borderRadius: 999, background: "rgba(255,255,255,0.16)", display: "flex", alignItems: "center", padding: 10 * s }}>
        {button(90, "#fff", "#34C759")}
        <div
          style={{
            flex: 1,
            fontSize: 34 * s,
            fontWeight: 500,
            backgroundImage: `linear-gradient(90deg, rgba(255,255,255,0.45) ${shimmer - 20}%, #fff ${shimmer}%, rgba(255,255,255,0.45) ${shimmer + 20}%)`,
            WebkitBackgroundClip: "text",
            backgroundClip: "text",
            color: "transparent",
          }}
        >
          slide to answer
        </div>
      </div>
    </AbsoluteFill>
  );
};

/** The lock screen: the date, the clock, a "Front desk closed" Focus, and the pile-up. */
const LockScreen: React.FC<{ frame: number; s: number }> = ({ frame, s }) => {
  const missed = calls.filter((t: number) => frame >= t).length;
  const lastCall = calls[missed - 1] ?? callEnd;
  const bump = Math.sin(ease(frame, lastCall, lastCall + 10) * Math.PI);
  const shown = PILE.filter((d) => frame >= d.at);
  const minutes = 41 + missed * 3 + shown.length * 4;
  const clock = `${6 + Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}`;
  const cardH = 150 * s;
  const gap = 12 * s;
  return (
    <AbsoluteFill style={{ color: color.white, opacity: ease(frame, callEnd, callEnd + 8) }}>
      <div style={{ position: "absolute", top: 120 * s, width: "100%", textAlign: "center" }}>
        <div style={{ fontSize: 30 * s, fontWeight: 600, opacity: 0.85 }}>Tuesday, October 28</div>
        <div style={{ fontSize: 190 * s, fontWeight: 700, letterSpacing: "-0.03em", lineHeight: 1, marginTop: 4 * s }}>{clock}</div>
        <div style={{ display: "inline-flex", alignItems: "center", gap: 10 * s, marginTop: 14 * s, padding: `${8 * s}px ${18 * s}px`, borderRadius: 999, background: "rgba(255,255,255,0.18)", fontSize: 24 * s, fontWeight: 600 }}>
          <svg width={24 * s} height={24 * s} viewBox="0 0 24 24">
            <path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z" fill="#A99BFF" />
          </svg>
          {LINES.focus}
        </div>
      </div>
      <div style={{ position: "absolute", left: 22 * s, right: 22 * s, top: 520 * s }}>
        {shown
          .slice()
          .reverse()
          .slice(0, 6)
          .map((d, i) => {
            const p = ease(frame, d.at, d.at + 8);
            return (
              <div key={d.at} style={{ position: "absolute", left: 0, right: 0, top: i * (cardH + gap), transform: `translateY(${(1 - p) * -36 * s}px) scale(${0.95 + 0.05 * p})`, opacity: p * (i > 4 ? 0.45 : 1) }}>
                <Notification dark s={s} channel={d.channel} title={d.sender} body={d.body} app={d.app} />
              </div>
            );
          })}
        {missed > 0 ? (
          <div style={{ position: "absolute", left: 0, right: 0, top: Math.min(shown.length, 6) * (cardH + gap), transform: `scale(${1 + 0.035 * bump})` }}>
            {missed > 1 ? <div style={{ position: "absolute", left: 22 * s, right: 22 * s, top: 22 * s, height: cardH, borderRadius: 30 * s, background: "rgba(255,255,255,0.10)" }} /> : null}
            {missed > 2 ? <div style={{ position: "absolute", left: 44 * s, right: 44 * s, top: 38 * s, height: cardH, borderRadius: 30 * s, background: "rgba(255,255,255,0.06)" }} /> : null}
            <Notification dark s={s} channel="phone" title={missed > 1 ? `${missed} Missed Calls` : "Missed Call"} body={missed > 1 ? `${CALLER} and others` : CALLER} app="Phone" />
          </div>
        ) : null}
      </div>
    </AbsoluteFill>
  );
};

/**
 * The apps' icons around the phone, each arriving with its first missed call
 * or message, their badges counting. They overlap only the phone's frame,
 * never a notification on its screen.
 */
const Icons: React.FC<{ frame: number; wide: boolean; phoneX: number; phoneY: number; phoneW: number; out: number }> = ({ frame, wide, phoneX, phoneY, phoneW, out }) => {
  const h = phoneW * 2.06;
  const size = wide ? 120 : 150;
  const left = phoneX - size * 0.9;
  const right = phoneX + phoneW - size * 0.1;
  const spots: { channel: Channel; x: number; y: number }[] = [
    { channel: "phone", x: left, y: phoneY + h * 0.24 },
    { channel: "whatsapp", x: right, y: phoneY + h * 0.33 },
    { channel: "instagram", x: left, y: phoneY + h * 0.47 },
    { channel: "messenger", x: right, y: phoneY + h * 0.58 },
    { channel: "web", x: left, y: phoneY + h * 0.7 },
  ];
  return (
    <>
      {spots.map((spot, i) => {
        const events = spot.channel === "phone" ? calls : PILE.filter((d) => d.channel === spot.channel).map((d) => d.at);
        const count = events.filter((t: number) => frame >= t).length;
        if (count === 0) return null;
        const first = events[0];
        const last = events[count - 1];
        const p = ease(frame, first, first + 12);
        // A DM counts as several: by the time one is read, more have come in.
        const badge = spot.channel === "phone" ? count : count * 3 + 1;
        return (
          <div
            key={spot.channel}
            style={{
              position: "absolute",
              left: spot.x,
              top: spot.y + Math.sin((frame + i * 25) / 26) * 6,
              transform: `translateY(${(1 - p) * 30}px) scale(${(0.88 + 0.12 * p) * (1 + out * 0.6)})`,
              opacity: p * (1 - out),
            }}
          >
            <AppIcon channel={spot.channel} size={size} badge={badge} bump={Math.sin(ease(frame, last, last + 10) * Math.PI)} />
          </div>
        );
      })}
    </>
  );
};
