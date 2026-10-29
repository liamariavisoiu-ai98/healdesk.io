import React from "react";
import { interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";

import { HOOK_COPY, Hook } from "../copy";
import { lerp, Shell, Stage, useLayout, useSnap } from "../motion";
import { Coin, Glass, Icon, Kinetic, Notification, Phone } from "../parts";
import { c, font, SNAP } from "../tokens";

// What piles up on the clinic's phone after six. Made-up 555 numbers and
// everyday questions: nothing clinical, no treatment named in a Meta message.
const MISSED = [
  { app: "Phone", icon: "phone-line.svg", title: "Missed call", body: "(480) 555-0136", time: "6:42 PM" },
  { app: "Instagram", icon: "instagram.webp", title: "New message", body: "Hi! Any openings this week?", time: "6:51 PM" },
  { app: "Messenger", icon: "messenger.svg", title: "New message", body: "How much is a consultation?", time: "7:05 PM" },
  { app: "WhatsApp", icon: "whatsapp.webp", title: "New message", body: "I'd like to book 🙂", time: "7:18 PM" },
  { app: "Website", icon: "website-chat.webp", title: "Chat waiting", body: "Are you open Saturday?", time: "7:33 PM" },
  { app: "Phone", icon: "phone-line.svg", title: "2 missed calls", body: "(602) 555-0119", time: "7:40 PM" },
];

/**
 * Scene 1, "The call that got away", 0–150. Night and mist only, no coral
 * before AYA. The clinic's phone rings out, the after-hours messages pile up
 * on its lock screen, and then they leave for the clinic down the street.
 */
export const S1Hook: React.FC<{ hook: Hook }> = ({ hook }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const { wide, W } = useLayout();
  const copy = HOOK_COPY[hook];

  // The slam reads on frame 0, then settles to the top.
  const slam = useSnap(-3);
  const settle = lerp(frame, [10, 42], [0, 1]);
  const big = copy.slam.length > 4 ? (wide ? 260 : 210) : 300;
  const slamSize = interpolate(settle, [0, 1], [big, wide ? 110 : 120]);
  const slamY = interpolate(settle, [0, 1], wide ? [470, 110] : [640, 90]);
  const slamX = wide ? interpolate(settle, [0, 1], [W / 2, 460]) : W / 2;
  const flipped = copy.flip && frame >= 108;
  const flipTurn = copy.flip ? Math.abs(Math.cos(lerp(frame, [100, 116], [0, Math.PI]))) : 1;

  const phoneW = wide ? 440 : 470;
  const phoneX = wide ? 1240 : (1080 - phoneW) / 2;
  const phoneY = wide ? 70 : 330;
  const phoneIn = spring({ frame: frame - 6, fps, config: { damping: 16, mass: 1 } });

  // Two rings, then the call is missed.
  const ringing = frame >= 12 && frame < 44;
  const shake = ringing && frame % 16 < 10 ? Math.sin(frame * 2.4) * 5 : 0;
  const missed = frame >= 44;

  // The pile-up flies off toward the competitor from 100.
  const leave = lerp(frame, [100, 128], [0, 1]);
  const compIn = lerp(frame, [96, 108], [0, 1]);

  const lineBox: React.CSSProperties = wide
    ? { position: "absolute", left: 120, top: 260, width: 900 }
    : { position: "absolute", left: 60, top: 190, width: 960 };

  return (
    <Shell duration={150} push={0.03} enterBlur={false}>
      <Stage>
        <div
          style={{
            position: "absolute",
            left: phoneX,
            top: phoneY + (1 - phoneIn) * 200,
            opacity: Math.min(1, phoneIn * 1.5),
            transform: `perspective(1800px) rotateX(${(1 - phoneIn) * 25 + Math.sin(frame / 40) * 2}deg) rotateY(${wide ? -8 : 0}deg) translateX(${shake}px)`,
          }}
        >
          <Phone width={phoneW} screen="linear-gradient(180deg, #241A30 0%, #120D18 100%)">
            <div style={{ position: "absolute", top: phoneW * 0.16, width: "100%", textAlign: "center", fontFamily: font, color: "#EDE7F0" }}>
              <div style={{ fontSize: phoneW * 0.05, fontWeight: 600, opacity: 0.7 }}>Tuesday, October 28</div>
              <div style={{ fontSize: phoneW * 0.22, fontWeight: 800, letterSpacing: "-0.03em", lineHeight: 1 }}>{frame < 60 ? "6:42" : "7:40"}</div>
            </div>
            {/* The incoming call, then the missed one. */}
            <div style={{ position: "absolute", left: phoneW * 0.05, right: phoneW * 0.05, top: phoneW * 0.62 }}>
              {!missed ? (
                <Glass dark style={{ padding: 20, display: "flex", alignItems: "center", gap: 16, transform: `scale(${1 + 0.03 * Math.sin(frame)})` }}>
                  <Icon name="phone-line.svg" size={60} />
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 20, opacity: 0.7, fontWeight: 600 }}>INCOMING CALL</div>
                    <div style={{ fontSize: 28, fontWeight: 800 }}>(480) 555-0136</div>
                  </div>
                  {[0, 1, 2].map((k) => (
                    <div key={k} style={{ position: "absolute", right: 30, top: "50%", width: 40, height: 40, marginTop: -20, borderRadius: "50%", border: `3px solid ${c.mist}`, opacity: ringing ? 1 - (((frame + k * 8) % 24) / 24) : 0, transform: `scale(${1 + (((frame + k * 8) % 24) / 24) * 2})` }} />
                  ))}
                </Glass>
              ) : null}
              {missed
                ? MISSED.map((n, i) => {
                    const at = 44 + i * 9;
                    const p = spring({ frame: frame - at, fps, config: SNAP });
                    if (frame < at) return null;
                    const shown = Math.min(MISSED.length, Math.floor((frame - 44) / 9) + 1);
                    const slot = shown - 1 - i;
                    // Toward the "Clinic down the street" pill below the phone.
                    const flyX = leave * (wide ? -120 : 200);
                    const flyY = leave * (wide ? 760 : 820 - slot * phoneW * 0.235);
                    return (
                      <div
                        key={i}
                        style={{
                          position: "absolute",
                          left: 0,
                          right: 0,
                          top: slot * (phoneW * 0.235),
                          transform: `translate(${flyX}px, ${(1 - p) * -60 + flyY}px) scale(${(0.9 + 0.1 * p) * (1 - leave * 0.5)})`,
                          opacity: Math.min(1, p) * (1 - leave),
                          filter: leave > 0 ? `blur(${leave * 8}px)` : undefined,
                          zIndex: 10 + i,
                        }}
                      >
                        <Notification dark app={n.app} icon={n.icon} title={n.title} body={n.body} time={n.time} width={phoneW * 0.9} scale={phoneW / 560} />
                      </div>
                    );
                  })
                : null}
            </div>
          </Phone>
        </div>

        {/* The competitor, where the pile-up goes. */}
        <div
          style={{
            position: "absolute",
            left: wide ? 1100 : 560,
            top: wide ? 900 : 1170,
            opacity: compIn * (1 - lerp(frame, [134, 146], [0, 0.6])),
            transform: `scale(${0.9 + 0.1 * compIn})`,
          }}
        >
          <Glass dark style={{ padding: "16px 26px", fontSize: 28, fontWeight: 600, display: "flex", gap: 12, alignItems: "center", color: "#FFDDB0" }}>
            <span style={{ width: 14, height: 14, borderRadius: "50%", background: "#FFC98A", boxShadow: "0 0 18px #FFC98A" }} />
            Clinic down the street
          </Glass>
        </div>

        {/* The scroll-stopper. */}
        <div
          style={{
            position: "absolute",
            left: slamX,
            top: slamY,
            transform: `translate(-50%, -50%) scale(${0.8 + 0.2 * slam}) scaleY(${flipTurn})`,
            fontFamily: font,
            fontWeight: 800,
            fontSize: slamSize,
            letterSpacing: "-0.03em",
            color: c.mist,
            whiteSpace: "nowrap",
            lineHeight: 1,
            zIndex: 30,
            textShadow: "0 20px 60px rgba(0,0,0,0.5)",
          }}
        >
          {flipped ? copy.flip : copy.slam}
        </div>

        <div style={{ ...lineBox, zIndex: 40 }}>
          <div style={{ position: "absolute", top: 0, opacity: 1 - lerp(frame, [100, 108], [0, 1]) }}>
            <Kinetic text={copy.line1} at={56} stagger={2.6} style={{ fontWeight: 800, fontSize: wide ? 64 : 58, lineHeight: 1.1, letterSpacing: "-0.02em", color: "#EDE7F0" }} />
          </div>
          <div style={{ position: "absolute", top: 0, opacity: 1 - lerp(frame, [132, 138], [0, 1]) }}>
            <Kinetic text={copy.line2} at={106} stagger={2} style={{ fontWeight: 800, fontSize: wide ? 64 : 58, lineHeight: 1.1, letterSpacing: "-0.02em", color: "#EDE7F0" }} />
          </div>
          <div style={{ position: "absolute", top: 0 }}>
            <Kinetic text={copy.line3} at={136} stagger={1.6} style={{ fontWeight: 800, fontSize: wide ? 84 : 84, lineHeight: 1.05, letterSpacing: "-0.02em", color: c.white }} />
          </div>
        </div>

        {/* The coin drops out of the dark and rolls toward the centre. */}
        {frame >= 134 ? <FallingCoin frame={frame} wide={wide} label={hook === "stat" ? "$1,500" : "$"} /> : null}

        {copy.smallPrint && frame >= 56 ? (
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
  const t = lerp(frame, [134, 150], [0, 1], (x) => x);
  const x = interpolate(t, [0, 1], [rest.x + (wide ? 420 : 300), rest.x]);
  const y = interpolate(t, [0, 0.55, 0.75, 1], [rest.y - 520, rest.y, rest.y - 70, rest.y]);
  return <Coin size={label.length > 2 ? 130 : 110} label={label} style={{ position: "absolute", left: x - 55, top: y - 55, transform: `rotate(${frame * 14}deg)`, zIndex: 50 }} />;
};
