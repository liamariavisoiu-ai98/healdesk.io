import React from "react";
import { interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";

import { HOOK_COPY, Hook } from "../copy";
import { lerp, Shell, Stage, useLayout } from "../motion";
import { Coin, Glass, Icon, Kinetic, Notification, Phone } from "../parts";
import { c, font, SNAP } from "../tokens";

// What piles up on the clinic's phone after six. Made-up 555 numbers and
// everyday questions: nothing clinical, no treatment named in a Meta message.
const CALLS = [
  { at: 50, app: "Phone", icon: "phone-line.svg", title: "Missed call", body: "(480) 555-0136", time: "6:42 PM" },
  { at: 62, app: "Phone", icon: "phone-line.svg", title: "2 missed calls", body: "(602) 555-0119", time: "6:55 PM" },
];
const DMS = [
  { at: 86, app: "Instagram", icon: "instagram.webp", title: "New message", body: "Hi! Any openings this week?", time: "7:05 PM" },
  { at: 98, app: "Messenger", icon: "messenger.svg", title: "New message", body: "How much is a consultation?", time: "7:18 PM" },
  { at: 110, app: "WhatsApp", icon: "whatsapp.webp", title: "New message", body: "I'd like to book 🙂", time: "7:26 PM" },
  { at: 122, app: "Website", icon: "website-chat.webp", title: "Chat waiting", body: "Are you open Saturday?", time: "7:33 PM" },
];
const PILE = [...CALLS, ...DMS];

// The beats, each held long enough to read.
const CALLS_TITLE = 0;
const DMS_TITLE = 74;
const LINE = 140;
const LEAVE = 168;
const LOSS = 196;
const COIN = 214;

/**
 * Scene 1, 0–240 (8 s). Night and mist only, no coral before Aya. Two
 * questions on screen: "Missed calls?" while the phone rings out, "Missed
 * DMs?" while the messages pile up. Then the line, the pile leaves for the
 * clinic down the street, and the loss.
 */
export const S1Hook: React.FC<{ hook: Hook }> = ({ hook }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const { wide } = useLayout();
  const copy = HOOK_COPY[hook];

  const phoneW = wide ? 440 : 560;
  const phoneX = wide ? 1240 : (1080 - phoneW) / 2;
  const phoneY = wide ? 70 : 300;
  const phoneIn = spring({ frame: frame + 6, fps, config: { damping: 16, mass: 1 } });

  // Two rings, then the call is missed.
  const ringing = frame >= 8 && frame < 46;
  const shake = ringing && frame % 18 < 10 ? Math.sin(frame * 2.4) * 5 : 0;
  const missed = frame >= 46;

  const leave = lerp(frame, [LEAVE, LEAVE + 26], [0, 1]);
  const compIn = lerp(frame, [LEAVE - 6, LEAVE + 6], [0, 1]);
  const shown = PILE.filter((n) => frame >= n.at).length;

  const text: React.CSSProperties = { fontWeight: 800, letterSpacing: "-0.03em", lineHeight: 1.02 };
  const titleSize = wide ? 120 : 112;
  const lineBox: React.CSSProperties = wide
    ? { position: "absolute", left: 120, top: 300, width: 960 }
    : { position: "absolute", left: 60, top: 90, width: 960, textAlign: "center" };

  // Each beat fades out as the next arrives, blurring as it goes.
  const out = (from: number) => {
    const t = lerp(frame, [from, from + 8], [0, 1]);
    return { opacity: 1 - t, filter: t > 0 ? `blur(${t * 10}px)` : undefined };
  };

  return (
    <Shell duration={240} push={0.03} enterBlur={false}>
      <Stage>
        <div
          style={{
            position: "absolute",
            left: phoneX,
            top: phoneY + (1 - phoneIn) * 200,
            opacity: Math.min(1, phoneIn * 1.5),
            transform: `perspective(1800px) rotateX(${(1 - phoneIn) * 25 + Math.sin(frame / 50) * 2}deg) rotateY(${wide ? -8 : 0}deg) translateX(${shake}px)`,
          }}
        >
          <Phone width={phoneW} screen="linear-gradient(180deg, #241A30 0%, #120D18 100%)">
            <div style={{ position: "absolute", top: phoneW * 0.16, width: "100%", textAlign: "center", fontFamily: font, color: "#EDE7F0" }}>
              <div style={{ fontSize: phoneW * 0.05, fontWeight: 600, opacity: 0.7 }}>Tuesday, October 28</div>
              <div style={{ fontSize: phoneW * 0.22, fontWeight: 800, letterSpacing: "-0.03em", lineHeight: 1 }}>{PILE.filter((n) => frame >= n.at).at(-1)?.time.replace(" PM", "") ?? "6:42"}</div>
            </div>
            <div style={{ position: "absolute", left: phoneW * 0.05, right: phoneW * 0.05, top: phoneW * 0.62 }}>
              {!missed ? (
                <Glass dark style={{ padding: 20, display: "flex", alignItems: "center", gap: 16, transform: `scale(${1 + 0.02 * Math.sin(frame * 0.8)})` }}>
                  <Icon name="phone-line.svg" size={60} />
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 20, opacity: 0.7, fontWeight: 600 }}>INCOMING CALL</div>
                    <div style={{ fontSize: 28, fontWeight: 800 }}>(480) 555-0136</div>
                  </div>
                </Glass>
              ) : null}
              {PILE.map((n, i) => {
                const p = spring({ frame: frame - n.at, fps, config: SNAP });
                if (frame < n.at) return null;
                const slot = shown - 1 - i;
                // Toward the "Clinic down the street" pill below the phone.
                const fly = Math.max(0, Math.min(1, leave * 1.4 - i * 0.07));
                return (
                  <div
                    key={i}
                    style={{
                      position: "absolute",
                      left: 0,
                      right: 0,
                      top: slot * (phoneW * 0.235),
                      transform: `translate(${fly * (wide ? -120 : 200)}px, ${(1 - p) * -60 + fly * (wide ? 760 : 900 - slot * phoneW * 0.235)}px) scale(${(0.9 + 0.1 * p) * (1 - fly * 0.5)})`,
                      opacity: Math.min(1, p) * (1 - fly),
                      filter: fly > 0 ? `blur(${fly * 8}px)` : undefined,
                      zIndex: 10 + i,
                    }}
                  >
                    <Notification dark app={n.app} icon={n.icon} title={n.title} body={n.body} time={n.time} width={phoneW * 0.9} scale={phoneW / 560} />
                  </div>
                );
              })}
            </div>
          </Phone>
        </div>

        {/* Where the pile goes. */}
        <div style={{ position: "absolute", left: wide ? 1110 : 300, top: wide ? 920 : 1250, opacity: compIn * (1 - lerp(frame, [LOSS + 10, LOSS + 24], [0, 0.6])), transform: `scale(${0.9 + 0.1 * compIn})` }}>
          <Glass dark style={{ padding: "16px 26px", fontSize: 30, fontWeight: 600, display: "flex", gap: 12, alignItems: "center", color: "#FFDDB0" }}>
            <span style={{ width: 14, height: 14, borderRadius: "50%", background: "#FFC98A", boxShadow: "0 0 18px #FFC98A" }} />
            Clinic down the street
          </Glass>
        </div>

        <div style={{ ...lineBox, color: "#EDE7F0", zIndex: 40 }}>
          <div style={{ position: "absolute", top: 0, left: 0, right: 0, ...out(DMS_TITLE - 6) }}>
            <Kinetic text="Missed calls?" at={CALLS_TITLE - 30} stagger={0} style={{ ...text, fontSize: titleSize, color: c.mist }} />
          </div>
          <div style={{ position: "absolute", top: 0, left: 0, right: 0, ...out(LINE - 6) }}>
            {frame >= DMS_TITLE - 2 ? <Kinetic text="Missed DMs?" at={DMS_TITLE} stagger={4} style={{ ...text, fontSize: titleSize, color: c.mist }} /> : null}
          </div>
          <div style={{ position: "absolute", top: 0, left: 0, right: 0, ...out(LOSS - 6) }}>
            {frame >= LINE - 2 ? <Kinetic text={copy.line} at={LINE} stagger={2.2} style={{ ...text, fontSize: wide ? 68 : 62, lineHeight: 1.1 }} /> : null}
          </div>
          <div style={{ position: "absolute", top: 0, left: 0, right: 0 }}>
            {frame >= LOSS - 2 ? <Kinetic text={copy.loss} at={LOSS} stagger={3} style={{ ...text, fontSize: wide ? 96 : 92, color: c.white }} /> : null}
          </div>
        </div>

        {/* The coin drops out of the dark and rolls toward the centre. */}
        {frame >= COIN ? <FallingCoin frame={frame} wide={wide} label={hook === "stat" ? "$1,500" : "$"} /> : null}

        {copy.smallPrint && frame >= LINE ? (
          <div style={{ position: "absolute", left: wide ? 120 : 60, top: wide ? 1040 : 1440, fontFamily: font, fontWeight: 500, fontSize: 22, color: c.mist }}>{copy.smallPrint}</div>
        ) : null}
      </Stage>
    </Shell>
  );
};

/** Where the coin is at the cut; scene 2 picks it up from here. */
export const coinRest = (wide: boolean) => (wide ? { x: 960, y: 640 } : { x: 540, y: 820 });

const FallingCoin: React.FC<{ frame: number; wide: boolean; label: string }> = ({ frame, wide, label }) => {
  const rest = coinRest(wide);
  const t = lerp(frame, [COIN, 240], [0, 1], (x) => x);
  const x = interpolate(t, [0, 1], [rest.x + (wide ? 420 : 300), rest.x]);
  const y = interpolate(t, [0, 0.55, 0.75, 1], [rest.y - 560, rest.y, rest.y - 80, rest.y]);
  const size = label.length > 2 ? 150 : 130;
  return <Coin size={size} label={label} spin={frame * 0.35} style={{ position: "absolute", left: x - size / 2, top: y - size / 2, zIndex: 50 }} />;
};
