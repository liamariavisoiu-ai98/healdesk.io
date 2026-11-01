import React from "react";
import { interpolate, spring, useVideoConfig } from "remotion";

import { IPhone, wallpaper } from "../iphone";
import { lerp, Stage, useFrame, useLayout } from "../motion";
import { Backdrop, Icon, Stars } from "../parts";
import { font, SNAP } from "../tokens";

// The call rings until CALL_END, then the missed calls group into one stack.
const CALL_END = 40;
const CALLS = [40, 60, 80, 98, 114];
const SWAP = 132;
const EXIT = 256;

type Dm = { at: number; app: string; icon: string; key: "instagram" | "whatsapp" | "messenger" | "web"; sender: string; body: string };

// Made-up first names and everyday questions: nothing clinical, and no
// treatment named in a Meta message. They arrive faster and faster.
const DM_TIMES = [146, 160, 172, 183, 193, 202, 210, 217, 223, 229, 234, 239, 244, 248];
const DM_POOL: Omit<Dm, "at">[] = [
  { app: "Instagram", icon: "instagram.webp", key: "instagram", sender: "jess.miller", body: "Hi! Any openings this week?" },
  { app: "WhatsApp", icon: "whatsapp.webp", key: "whatsapp", sender: "Mia", body: "I'd like to book 🙂" },
  { app: "Messenger", icon: "messenger.svg", key: "messenger", sender: "Daniel R.", body: "How much is a consultation?" },
  { app: "Website chat", icon: "website-chat.webp", key: "web", sender: "Visitor", body: "Are you open Saturday?" },
  { app: "Instagram", icon: "instagram.webp", key: "instagram", sender: "sophie.k", body: "do u have anything saturday?" },
  { app: "WhatsApp", icon: "whatsapp.webp", key: "whatsapp", sender: "Olivia", body: "Can I come Thursday after work?" },
  { app: "Messenger", icon: "messenger.svg", key: "messenger", sender: "Ava T.", body: "Any time next Wednesday?" },
];
const DMS: Dm[] = DM_TIMES.map((at, i) => ({ at, ...DM_POOL[i % DM_POOL.length] }));

/**
 * 0:00–0:09. A real-looking iPhone, already ringing on frame 0. The call
 * goes unanswered; the missed calls stack up into one climbing count. Then
 * the DMs pour in, faster and faster, while the apps' icons pop up around the
 * phone with red badges counting. The camera pushes in throughout and
 * punches in on the swap, and the scene leaves by flying into the screen.
 */
export const Missed: React.FC = () => {
  const frame = useFrame();
  const { fps } = useVideoConfig();
  const { wide } = useLayout();

  const phoneW = wide ? 470 : 700;
  const phoneX = wide ? 1060 : (1080 - phoneW) / 2;
  const phoneY = wide ? 40 : 230;
  const s = phoneW / 600;

  const punch = spring({ frame: frame - SWAP, fps, config: { damping: 12, stiffness: 200 } });
  const exit = lerp(frame, [EXIT, 270], [0, 1], (t) => t * t);
  const push = 1 + 0.06 * (frame / 270) + 0.025 * Math.sin(Math.min(1, Math.max(0, punch)) * Math.PI) + exit * 0.9;
  const turn = interpolate(frame, [0, 270], [-9, 7]);

  const ringing = frame < CALL_END;
  const lastBuzz = [...CALLS, ...DMS.map((d) => d.at)].filter((t) => t <= frame).pop() ?? -99;
  const buzz = (ringing && frame % 16 < 9) || frame - lastBuzz < 5 ? Math.sin(frame * 3.3) : 0;

  return (
    <>
      <Backdrop mood="space" />
      <Stars count={40} opacity={0.45} />
      <Stage>
        {/* Warm light behind the phone, healdesk's colour. */}
        <div
          style={{
            position: "absolute",
            left: phoneX + phoneW / 2 - 600,
            top: phoneY + phoneW * 1.03 - 600,
            width: 1200,
            height: 1200,
            borderRadius: "50%",
            background: "radial-gradient(circle, rgba(255,118,30,0.28) 0%, rgba(230,38,39,0.12) 35%, rgba(0,0,0,0) 65%)",
            opacity: 0.7 + 0.3 * Math.sin(frame / 20),
          }}
        />

        <Title frame={frame} wide={wide} exit={exit} />

        <div
          style={{
            position: "absolute",
            left: phoneX,
            top: phoneY,
            transformOrigin: "50% 40%",
            transform: `perspective(2400px) scale(${push}) rotateY(${turn}deg) rotateX(${2 + Math.sin(frame / 50)}deg) rotateZ(${buzz * 0.6}deg) translateX(${buzz * 3}px)`,
            filter: exit > 0 ? `blur(${exit * 18}px)` : undefined,
            zIndex: 20,
          }}
        >
          <IPhone width={phoneW} wallpaper={wallpaper(frame)} glare={frame / 270}>
            {ringing ? <IncomingCall frame={frame} s={s} /> : <LockScreen frame={frame} s={s} />}
          </IPhone>
        </div>

        {/* The apps, badges climbing. */}
        <AppIcons frame={frame} wide={wide} phoneX={phoneX} phoneY={phoneY} phoneW={phoneW} exit={exit} />
      </Stage>
    </>
  );
};

/** "Missed calls?" rolling to "Missed DMs?", set in a mask the way Apple reveals a line. */
const Title: React.FC<{ frame: number; wide: boolean; exit: number }> = ({ frame, wide, exit }) => {
  const { fps } = useVideoConfig();
  const size = wide ? 140 : 108;
  const lh = size * 1.12;
  const roll = spring({ frame: frame - SWAP, fps, config: { damping: 15, stiffness: 140 } });
  // Fully set on frame 0, so the first frame already reads.
  const rise = spring({ frame: frame + 24, fps, config: { damping: 18 } });
  const box: React.CSSProperties = wide
    ? { position: "absolute", left: 200, top: 330, width: 820, textAlign: "left" }
    : { position: "absolute", left: 0, right: 0, top: 40, textAlign: "center" };
  return (
    <div style={{ ...box, fontFamily: font, fontWeight: 700, fontSize: size, letterSpacing: "-0.015em", lineHeight: `${lh}px`, color: "#F5F5F7", opacity: 1 - exit, zIndex: 30, textShadow: "0 10px 50px rgba(120,120,255,0.25)" }}>
      <div style={{ display: wide ? "block" : "inline-flex", alignItems: "flex-start", gap: size * 0.28, overflow: "hidden", height: wide ? lh * 2 : lh }}>
        <div style={{ transform: `translateY(${(1 - rise) * lh}px)` }}>Missed</div>
        <div style={{ height: lh, overflow: "hidden" }}>
          <div style={{ transform: `translateY(${(1 - rise) * lh - roll * lh}px)` }}>
            <div style={{ height: lh }}>calls?</div>
            <div style={{ height: lh }}>DMs?</div>
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
  const fade = lerp(frame, [CALL_END - 6, CALL_END], [1, 0]);
  const shimmer = ((frame * 2.4) % 140) - 20;
  return (
    <div style={{ position: "absolute", inset: 0, color: "#fff", textAlign: "center", opacity: fade, background: "rgba(0,0,0,0.25)", backdropFilter: "blur(30px)" }}>
      <div style={{ marginTop: 200 * s, fontSize: 30 * s, fontWeight: 500, opacity: 0.75 }}>mobile</div>
      <div style={{ fontSize: 54 * s, fontWeight: 600, letterSpacing: "-0.01em", marginTop: 6 * s, whiteSpace: "nowrap" }}>+1 (480) 555-0136</div>
      {[0, 1, 2].map((k) => {
        const t = ((frame + k * 10) % 30) / 30;
        return <div key={k} style={{ position: "absolute", left: "50%", top: 640 * s, width: 160 * s, height: 160 * s, marginLeft: -80 * s, borderRadius: "50%", border: `${3 * s}px solid rgba(52,199,89,${0.6 * (1 - t)})`, transform: `scale(${1 + t * 1.6})` }} />;
      })}
      <div style={{ position: "absolute", left: "50%", top: 640 * s, width: 160 * s, height: 160 * s, marginLeft: -80 * s, borderRadius: "50%", background: "#34C759", display: "flex", alignItems: "center", justifyContent: "center", boxShadow: "0 0 40px rgba(52,199,89,0.6)" }}>
        <svg width={70 * s} height={70 * s} viewBox="0 0 24 24">
          <path fill="#fff" d={PHONE_GLYPH} />
        </svg>
      </div>
      <div style={{ position: "absolute", left: 50 * s, right: 50 * s, bottom: 130 * s, height: 110 * s, borderRadius: 999, background: "rgba(255,255,255,0.16)", display: "flex", alignItems: "center", padding: 10 * s }}>
        <div style={{ width: 90 * s, height: 90 * s, borderRadius: "50%", background: "#fff", display: "flex", alignItems: "center", justifyContent: "center" }}>
          <svg width={44 * s} height={44 * s} viewBox="0 0 24 24">
            <path fill="#34C759" d={PHONE_GLYPH} />
          </svg>
        </div>
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
    </div>
  );
};

/** The lock screen: date, clock, and the notifications piling up. */
const LockScreen: React.FC<{ frame: number; s: number }> = ({ frame, s }) => {
  const { fps } = useVideoConfig();
  const inP = lerp(frame, [CALL_END, CALL_END + 8], [0, 1]);
  const calls = CALLS.filter((t) => frame >= t).length;
  const lastCall = CALLS[calls - 1] ?? CALL_END;
  const bump = spring({ frame: frame - lastCall, fps, config: SNAP });
  const dms = DMS.filter((d) => frame >= d.at);
  const minutes = 41 + calls * 3 + dms.length * 4;
  const clock = `${6 + Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}`;
  const cardH = 132 * s;
  const gap = 12 * s;

  return (
    <div style={{ position: "absolute", inset: 0, color: "#fff", opacity: inP }}>
      <div style={{ position: "absolute", top: 120 * s, width: "100%", textAlign: "center" }}>
        <div style={{ fontSize: 30 * s, fontWeight: 600, opacity: 0.85 }}>Tuesday, October 28</div>
        <div style={{ fontSize: 190 * s, fontWeight: 700, letterSpacing: "-0.03em", lineHeight: 1, marginTop: 4 * s, textShadow: "0 4px 30px rgba(0,0,0,0.25)" }}>{clock}</div>
      </div>
      <div style={{ position: "absolute", left: 22 * s, right: 22 * s, top: 470 * s }}>
        {/* Newest DMs on top. */}
        {dms
          .slice()
          .reverse()
          .slice(0, 6)
          .map((d, i) => {
            const p = spring({ frame: frame - d.at, fps, config: { damping: 14, stiffness: 190 } });
            return (
              <div key={d.at} style={{ position: "absolute", left: 0, right: 0, top: i * (cardH + gap), transform: `translateY(${(1 - p) * -40 * s}px) scale(${0.94 + 0.06 * Math.min(1, p)})`, opacity: Math.min(1, p * 1.6) * (i > 4 ? 0.45 : 1) }}>
                <Card s={s} icon={d.icon} title={d.sender} app={d.app} body={d.body} />
              </div>
            );
          })}
        {/* The missed calls: one stack whose count climbs. */}
        {calls > 0 ? (
          <div style={{ position: "absolute", left: 0, right: 0, top: Math.min(dms.length, 6) * (cardH + gap), transform: `scale(${1 + 0.04 * Math.sin(Math.min(1, bump) * Math.PI)})` }}>
            {calls > 1 ? <div style={{ position: "absolute", left: 22 * s, right: 22 * s, top: 20 * s, height: cardH, borderRadius: 30 * s, background: "rgba(255,255,255,0.10)" }} /> : null}
            {calls > 2 ? <div style={{ position: "absolute", left: 44 * s, right: 44 * s, top: 34 * s, height: cardH, borderRadius: 30 * s, background: "rgba(255,255,255,0.06)" }} /> : null}
            <Card s={s} icon="phone-line.svg" title={calls > 1 ? `${calls} Missed Calls` : "Missed Call"} app="Phone" body={calls > 1 ? "+1 (480) 555-0136 and others" : "+1 (480) 555-0136"} />
          </div>
        ) : null}
      </div>
    </div>
  );
};

/** An iOS lock-screen notification: frosted, white type, the app's icon. */
const Card: React.FC<{ s: number; icon: string; title: string; app: string; body: string }> = ({ s, icon, title, app, body }) => (
  <div
    style={{
      height: 132 * s,
      borderRadius: 30 * s,
      background: "rgba(255,255,255,0.20)",
      backdropFilter: "blur(30px) saturate(180%)",
      WebkitBackdropFilter: "blur(30px) saturate(180%)",
      boxShadow: "inset 0 1px 0 rgba(255,255,255,0.25), 0 8px 24px rgba(0,0,0,0.18)",
      display: "flex",
      alignItems: "center",
      gap: 18 * s,
      padding: `0 ${22 * s}px`,
      color: "#fff",
      fontFamily: font,
      position: "relative",
    }}
  >
    <Icon name={icon} size={66 * s} style={{ borderRadius: 16 * s }} />
    <div style={{ flex: 1, minWidth: 0 }}>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 26 * s, fontWeight: 700 }}>
        <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{title}</span>
        <span style={{ fontSize: 22 * s, fontWeight: 500, opacity: 0.7 }}>now</span>
      </div>
      <div style={{ fontSize: 25 * s, fontWeight: 500, opacity: 0.92, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{body}</div>
      <div style={{ fontSize: 19 * s, fontWeight: 600, opacity: 0.55, marginTop: 2 * s, letterSpacing: "0.02em" }}>{app}</div>
    </div>
  </div>
);

/** The four apps' icons pop up around the phone; their red badges count up with every DM. */
const AppIcons: React.FC<{ frame: number; wide: boolean; phoneX: number; phoneY: number; phoneW: number; exit: number }> = ({ frame, wide, phoneX, phoneY, phoneW, exit }) => {
  const { fps } = useVideoConfig();
  const h = phoneW * 2.06;
  const size = wide ? 130 : 170;
  const spots = [
    { key: "instagram", icon: "instagram.webp", at: SWAP + 4, x: phoneX - size * 0.62, y: phoneY + h * 0.3 },
    { key: "whatsapp", icon: "whatsapp.webp", at: SWAP + 10, x: phoneX + phoneW - size * 0.38, y: phoneY + h * 0.4 },
    { key: "messenger", icon: "messenger.svg", at: SWAP + 16, x: phoneX - size * 0.5, y: phoneY + h * 0.62 },
    { key: "web", icon: "website-chat.webp", at: SWAP + 22, x: phoneX + phoneW - size * 0.5, y: phoneY + h * 0.74 },
  ] as const;
  return (
    <>
      {spots.map((sp, i) => {
        if (frame < sp.at) return null;
        const p = spring({ frame: frame - sp.at, fps, config: { damping: 10, stiffness: 170, mass: 0.8 } });
        // Each DM from this app adds to its badge; the count runs ahead, as a flood does.
        const count = DMS.filter((d) => d.key === sp.key && frame >= d.at).length * 3 + 1;
        const last = [...DMS].reverse().find((d) => d.key === sp.key && frame >= d.at);
        const tick = last ? spring({ frame: frame - last.at, fps, config: SNAP }) : 1;
        return (
          <div
            key={sp.key}
            style={{
              position: "absolute",
              left: sp.x,
              top: sp.y + Math.sin((frame + i * 25) / 22) * 8,
              transform: `perspective(1200px) scale(${p * (1 + exit * 0.6)}) rotate(${(1 - Math.min(1, p)) * (i % 2 ? 25 : -25)}deg) rotateY(${Math.sin((frame + i * 40) / 40) * 8}deg)`,
              opacity: Math.min(1, p * 1.5) * (1 - exit),
              zIndex: 25,
              filter: "drop-shadow(0 24px 40px rgba(0,0,0,0.5))",
            }}
          >
            <Icon name={sp.icon} size={size} style={{ borderRadius: size * 0.23 }} />
            <div
              style={{
                position: "absolute",
                right: -size * 0.12,
                top: -size * 0.12,
                minWidth: size * 0.36,
                height: size * 0.36,
                padding: `0 ${size * 0.08}px`,
                borderRadius: 999,
                background: "#FF3B30",
                color: "#fff",
                fontFamily: font,
                fontWeight: 700,
                fontSize: size * 0.2,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                boxShadow: "0 4px 12px rgba(255,59,48,0.5)",
                transform: `scale(${1 + 0.25 * Math.sin(Math.min(1, tick) * Math.PI)})`,
              }}
            >
              {count}
            </div>
          </div>
        );
      })}
    </>
  );
};
