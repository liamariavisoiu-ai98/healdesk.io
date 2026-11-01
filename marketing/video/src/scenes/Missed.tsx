import React from "react";
import { spring, useVideoConfig } from "remotion";

import { LINES } from "../copy";
import { lerp, Stage, useFrame, useLayout } from "../motion";
import { Backdrop, Glass, Icon, Kinetic, Notification, Phone, Stars } from "../parts";
import { font, SNAP, tracked } from "../tokens";

type Note = { at: number; app: string; icon: string; title: string; body: string; time: string };

// Made-up 555 numbers and everyday questions: nothing clinical, and no
// treatment named in a Meta message.
const CALLS: Note[] = [
  { at: 44, app: "Phone", icon: "phone-line.svg", title: "Missed call", body: "(480) 555-0136", time: "6:42 PM" },
  { at: 58, app: "Phone", icon: "phone-line.svg", title: "Missed call", body: "(602) 555-0119", time: "6:44 PM" },
  { at: 72, app: "Phone", icon: "phone-line.svg", title: "Missed call", body: "(480) 555-0187", time: "6:47 PM" },
  { at: 86, app: "Phone", icon: "phone-line.svg", title: "Missed call", body: "(623) 555-0142", time: "6:51 PM" },
  { at: 100, app: "Phone", icon: "phone-line.svg", title: "3 missed calls", body: "(480) 555-0136", time: "6:58 PM" },
];
const DM_POOL = [
  { app: "Instagram", icon: "instagram.webp", body: "Hi! Any openings this week?" },
  { app: "WhatsApp", icon: "whatsapp.webp", body: "I'd like to book 🙂" },
  { app: "Messenger", icon: "messenger.svg", body: "How much is a consultation?" },
  { app: "Website", icon: "website-chat.webp", body: "Are you open Saturday?" },
  { app: "Instagram", icon: "instagram.webp", body: "do u have anything saturday?" },
  { app: "WhatsApp", icon: "whatsapp.webp", body: "Can I come Thursday after work?" },
  { app: "Messenger", icon: "messenger.svg", body: "Any time next Wednesday?" },
  { app: "Website", icon: "website-chat.webp", body: "Is parking available?" },
];
const DMS: Note[] = Array.from({ length: 12 }).map((_, i) => {
  const d = DM_POOL[i % DM_POOL.length];
  const minutes = 5 + i * 4;
  return { at: 166 + i * 8, app: d.app, icon: d.icon, title: "New message", body: d.body, time: `7:${String(minutes).padStart(2, "0")} PM` };
});
const ALL = [...CALLS, ...DMS];

const DMS_AT = 150;

/**
 * 0:00–0:10. Deep space; one phone scales in. "Missed calls?" while the
 * calls stack up on its lock screen, each with a buzz; "Missed DMs?" while
 * WhatsApp, Instagram, Messenger and website chat multiply, on the screen
 * and around it.
 */
export const Missed: React.FC = () => {
  const frame = useFrame();
  const { fps } = useVideoConfig();
  const { wide, W } = useLayout();

  const phoneW = wide ? 420 : 540;
  const phoneX = (W - phoneW) / 2;
  const phoneY = wide ? 200 : 280;
  const phoneIn = spring({ frame: frame - 2, fps, config: { damping: 20, stiffness: 90, mass: 1 } });

  const last = [...ALL].reverse().find((n) => frame >= n.at);
  const sinceBuzz = last ? frame - last.at : 99;
  const ringing = frame >= 14 && frame < 42;
  const buzz = (ringing && frame % 14 < 8) || sinceBuzz < 6 ? Math.sin(frame * 3.1) * 4 : 0;

  const shown = ALL.filter((n) => frame >= n.at).length;
  const dms = lerp(frame, [DMS_AT - 4, DMS_AT + 6], [0, 1]);
  const toDark = lerp(frame, [282, 300], [0, 1]);

  const title: React.CSSProperties = {
    fontWeight: 600,
    fontSize: wide ? 104 : 100,
    letterSpacing: tracked,
    lineHeight: 1,
    // Solid, not a gradient clipped to the text: each word moves on its own
    // layer, and a clipped background does not paint into those.
    color: "#F2F2F7",
    textShadow: "0 10px 40px rgba(120,140,255,0.25)",
    textAlign: "center",
  };

  return (
    <>
      <Backdrop mood="space" />
      <Stars />
      <Stage>
        <div style={{ position: "absolute", left: 0, right: 0, top: wide ? 50 : 70, fontFamily: font, opacity: 1 - toDark }}>
          <div style={{ position: "absolute", left: 0, right: 0, opacity: 1 - dms, filter: dms > 0 ? `blur(${dms * 12}px)` : undefined }}>
            <Kinetic text={LINES.calls} at={-20} stagger={0} style={title} />
          </div>
          <div style={{ position: "absolute", left: 0, right: 0 }}>
            {frame >= DMS_AT - 2 ? <Kinetic text={LINES.dms} at={DMS_AT} stagger={5} style={title} /> : null}
          </div>
        </div>

        {/* The swarm: from "Missed DMs?" on, messages multiply around the phone too. */}
        {DMS.map((n, i) => (
          <Swarm key={i} note={n} i={i} wide={wide} W={W} frame={frame} toDark={toDark} />
        ))}

        <div
          style={{
            position: "absolute",
            left: phoneX,
            top: phoneY,
            transform: `perspective(2000px) scale(${0.86 + 0.14 * phoneIn}) rotateX(${(1 - phoneIn) * 12 + Math.sin(frame / 60) * 1.5}deg) translateX(${buzz}px)`,
            opacity: Math.min(1, phoneIn * 1.6),
            zIndex: 20,
          }}
        >
          <Phone width={phoneW} screen="linear-gradient(180deg, #1A1830 0%, #07070F 100%)">
            <div style={{ position: "absolute", top: phoneW * 0.15, width: "100%", textAlign: "center", fontFamily: font, color: "#F2F2F7" }}>
              <div style={{ fontSize: phoneW * 0.048, fontWeight: 500, opacity: 0.7 }}>Tuesday, October 28</div>
              <div style={{ fontSize: phoneW * 0.22, fontWeight: 600, letterSpacing: "-0.02em", lineHeight: 1 }}>{(last?.time ?? "6:41 PM").replace(" PM", "")}</div>
            </div>
            <div style={{ position: "absolute", left: phoneW * 0.04, right: phoneW * 0.04, top: phoneW * 0.58 }}>
              {frame < 44 ? (
                <div style={{ opacity: lerp(frame, [12, 18], [0, 1]), transform: `scale(${1 + 0.02 * Math.sin(frame * 0.9)})` }}>
                  <Glass dark style={{ padding: 18, display: "flex", alignItems: "center", gap: 16, borderRadius: 28 }}>
                    <Icon name="phone-line.svg" size={phoneW * 0.11} />
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: phoneW * 0.034, opacity: 0.7, fontWeight: 600 }}>INCOMING CALL</div>
                      <div style={{ fontSize: phoneW * 0.05, fontWeight: 700 }}>(480) 555-0136</div>
                    </div>
                  </Glass>
                </div>
              ) : null}
              {ALL.map((n, i) => {
                if (frame < n.at) return null;
                const p = spring({ frame: frame - n.at, fps, config: SNAP });
                const slot = shown - 1 - i;
                if (slot > 7) return null;
                return (
                  <div
                    key={i}
                    style={{
                      position: "absolute",
                      left: 0,
                      right: 0,
                      top: slot * phoneW * 0.215,
                      transform: `translateY(${(1 - p) * -50}px) scale(${0.92 + 0.08 * Math.min(1, p)})`,
                      opacity: Math.min(1, p * 1.4) * (slot > 5 ? 0.5 : 1),
                      zIndex: 10 + i,
                    }}
                  >
                    <Notification dark app={n.app} icon={n.icon} title={n.title} body={n.body} time={n.time} width={phoneW * 0.92} scale={phoneW / 600} />
                  </div>
                );
              })}
            </div>
            {/* The screen goes dark at the cut. */}
            <div style={{ position: "absolute", inset: 0, background: "#000", opacity: toDark, zIndex: 50 }} />
          </Phone>
        </div>

        {/* The count, under the phone. */}
        <div style={{ position: "absolute", left: 0, right: 0, top: wide ? 1010 : 1410, display: "flex", justifyContent: "center", opacity: lerp(frame, [50, 60], [0, 1]) * (1 - toDark), zIndex: 30 }}>
          <Glass dark style={{ padding: "12px 26px", fontSize: 30, fontWeight: 600, letterSpacing: tracked, display: "flex", alignItems: "center", gap: 12, color: "#F2F2F7" }}>
            <span style={{ width: 12, height: 12, borderRadius: "50%", background: "#FF453A", boxShadow: "0 0 12px #FF453A" }} />
            {shown} unanswered
          </Glass>
        </div>
      </Stage>
    </>
  );
};

/** A message floating beside the phone, small and out of focus, as if behind it. */
const Swarm: React.FC<{ note: Note; i: number; wide: boolean; W: number; frame: number; toDark: number }> = ({ note, i, wide, W, frame, toDark }) => {
  const { fps } = useVideoConfig();
  const at = note.at + 4;
  if (frame < at) return null;
  const p = spring({ frame: frame - at, fps, config: { damping: 16 } });
  const side = i % 2 === 0 ? -1 : 1;
  const depth = 0.55 + ((i * 37) % 30) / 100;
  const x = W / 2 + side * (wide ? 420 + ((i * 53) % 260) : 300 + ((i * 41) % 160)) - 200;
  const y = (wide ? 160 : 260) + ((i * 131) % (wide ? 700 : 1000));
  return (
    <div
      style={{
        position: "absolute",
        left: x + Math.sin((frame + i * 30) / 50) * 10,
        top: y + (1 - p) * 40,
        transform: `scale(${depth * (0.8 + 0.2 * p)})`,
        opacity: Math.min(1, p) * (0.35 + depth * 0.5) * (1 - toDark),
        filter: `blur(${(1 - depth) * 6}px)`,
        zIndex: depth > 0.7 ? 25 : 5,
      }}
    >
      <Notification dark app={note.app} icon={note.icon} title={note.title} body={note.body} time={note.time} width={400} scale={0.8} />
    </div>
  );
};

