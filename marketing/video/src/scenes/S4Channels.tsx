import React from "react";
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";

import { CLINIC } from "../copy";
import { drift, enter, enterStyle, lerp, Stage, useLayout, useSnap } from "../motion";
import { Aya, Bubble, Glass, Icon, Lock, Pill, Tick } from "../parts";
import { c, font, SNAP } from "../tokens";

type Channel = {
  key: string;
  icon: string;
  title: string;
  meta: string;
  ask: string | null;
  reply: string;
  day: number;
  slot: string;
};

// No treatment is named in the WhatsApp or Instagram messages: Meta never
// signs a BAA, so those channels carry nothing clinical.
const CHANNELS: readonly Channel[] = [
  { key: "phone", icon: "phone-line.svg", title: "Phone call", meta: "0:14", ask: null, reply: "Friday at 2:00 PM. You're booked.", day: 4, slot: "Fri 2:00 PM" },
  { key: "whatsapp", icon: "whatsapp.webp", title: "WhatsApp", meta: "6:58 PM", ask: "Can I come Thursday after work?", reply: "Thursday 5:30 PM is yours ✓", day: 3, slot: "Thu 5:30 PM" },
  { key: "instagram", icon: "instagram.webp", title: "Instagram DM", meta: "11:48 PM", ask: "do u have anything saturday?", reply: "Saturday 11:00 AM, booked ✓", day: 5, slot: "Sat 11:00 AM" },
  { key: "web", icon: "website-chat.webp", title: "Website chat", meta: "Now", ask: "First time, what's a consult like?", reply: "Relaxed, about 30 min. Monday 10:30 AM? Booked ✓", day: 0, slot: "Mon 10:30 AM" },
];

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const OPEN = 465;
const RESOLVE = 520;
const DEPOSIT = 600;

/** Scene 4, "Every channel, at once, deposit taken", frames 450–690. */
export const S4Channels: React.FC = () => {
  const frame = useCurrentFrame();
  const { wide } = useLayout();

  const cardW = wide ? 400 : 490;
  const cardH = wide ? 330 : 390;
  const pos = (i: number) =>
    wide ? { x: 115 + i * 430, y: 290 } : { x: 40 + (i % 2) * 510, y: 250 + Math.floor(i / 2) * 420 };
  const cal = wide ? { x: 115, y: 660, w: 1690, h: 230 } : { x: 40, y: 1090, w: 1000, h: 190 };

  const spark = lerp(frame, [452, 466], [0, 1]);
  const ayaSmall = lerp(frame, [462, 480], [0, 1]);
  const forward = lerp(frame, [DEPOSIT, DEPOSIT + 14], [0, 1]);
  const linkPill = enter(frame, 630, 12);

  return (
    <>
      <AbsoluteFill style={{ background: c.ivory }} />
      <Stage>
        {/* AYA snaps, then settles small in the corner. */}
        <div
          style={{
            position: "absolute",
            left: interpolate(ayaSmall, [0, 1], wide ? [560, 20] : [130, -30]),
            top: interpolate(ayaSmall, [0, 1], wide ? [200, 10] : [300, 0]),
            WebkitMaskImage: "linear-gradient(180deg, #000 70%, transparent 95%)",
            maskImage: "linear-gradient(180deg, #000 70%, transparent 95%)",
            opacity: 1 - forward * 0.6,
          }}
        >
          <Aya width={interpolate(ayaSmall, [0, 1], wide ? [800, 400] : [820, 380])} />
        </div>
        {frame < 470 ? (
          <div style={{ position: "absolute", left: wide ? 900 : 420, top: wide ? 560 : 640, width: 0, height: 0 }}>
            {Array.from({ length: 8 }).map((_, i) => {
              const a = (i / 8) * Math.PI * 2;
              const r = 20 + spark * 70;
              return (
                <div
                  key={i}
                  style={{
                    position: "absolute",
                    left: Math.cos(a) * r - 4,
                    top: Math.sin(a) * r - 14,
                    width: 8,
                    height: 28,
                    borderRadius: 4,
                    background: c.coral,
                    transform: `rotate(${(a * 180) / Math.PI + 90}deg)`,
                    opacity: 1 - spark,
                  }}
                />
              );
            })}
          </div>
        ) : null}

        <Week frame={frame} {...cal} />

        {CHANNELS.map((ch, i) => (
          <ChannelCard key={ch.key} ch={ch} i={i} frame={frame} {...pos(i)} w={cardW} h={cardH} wide={wide} forward={forward} cal={cal} />
        ))}

        <div style={{ position: "absolute", right: wide ? 60 : 40, top: wide ? 40 : 60, ...enterStyle(linkPill, 16) }}>
          <Pill bg={c.coral} size={30}>
            ↓ Link below
          </Pill>
        </div>
      </Stage>
    </>
  );
};

const ChannelCard: React.FC<{
  ch: Channel;
  i: number;
  frame: number;
  x: number;
  y: number;
  w: number;
  h: number;
  wide: boolean;
  forward: number;
  cal: { x: number; y: number; w: number; h: number };
}> = ({ ch, i, frame, x, y, w, h, wide, forward, cal }) => {
  const { fps } = useVideoConfig();
  const burst = spring({ frame: frame - (OPEN + i * 12), fps, config: SNAP });
  const resolveAt = RESOLVE + i * 20;
  const reply = spring({ frame: frame - resolveAt, fps, config: SNAP });
  const isWeb = ch.key === "web";

  // The deposit moment brings the website chat forward and dims the rest.
  const stageW = wide ? 1920 : 1080;
  const fx = isWeb ? interpolate(forward, [0, 1], [x, (stageW - w * (wide ? 1.7 : 1.9)) / 2]) : x;
  const fy = isWeb ? interpolate(forward, [0, 1], [y, wide ? 150 : 300]) : y;
  const fscale = isWeb ? 1 + forward * (wide ? 0.7 : 0.9) : 1;

  // The reply flies out as a tile toward its day in the week.
  const fly = lerp(frame, [resolveAt + 6, resolveAt + 20], [0, 1]);
  const colW = cal.w / 7;
  const tileX = cal.x + ch.day * colW + colW / 2;
  const tileY = cal.y + cal.h * 0.62;

  return (
    <>
      <div
        style={{
          position: "absolute",
          left: fx,
          top: fy,
          width: w,
          height: h,
          transformOrigin: "0 0",
          transform: `translate(${(1 - burst) * (stageW / 2 - x - w / 2)}px, ${(1 - burst) * 120}px) scale(${(0.5 + 0.5 * Math.min(1, burst)) * fscale})`,
          opacity: Math.min(1, burst * 1.5) * (isWeb ? 1 : 1 - forward * 0.75),
          zIndex: isWeb ? 20 : 10,
        }}
      >
        <Glass style={{ width: "100%", height: "100%", background: "rgba(255,255,255,0.82)", padding: 22, display: "flex", flexDirection: "column", gap: 12, overflow: "hidden" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
            <Icon name={ch.icon} size={50} />
            <div style={{ fontWeight: 800, fontSize: 30, flex: 1 }}>{ch.title}</div>
            <div style={{ fontWeight: 500, fontSize: 22, color: c.plumSoft }}>{ch.meta}</div>
          </div>
          {ch.key === "phone" ? <PhoneCall frame={frame} /> : ch.ask ? <Bubble from="patient" size={27} tint={c.plumSoft}>{ch.ask}</Bubble> : null}
          {frame >= resolveAt && !(isWeb && frame >= DEPOSIT) ? (
            <Bubble from="aya" size={27} style={{ transform: `scale(${0.85 + 0.15 * reply})`, opacity: Math.min(1, reply), border: `2px solid ${c.coral}` }}>
              {ch.reply}
            </Bubble>
          ) : null}
          {isWeb && frame >= DEPOSIT ? <DepositCard frame={frame} /> : null}
        </Glass>
      </div>
      {fly > 0 && fly < 1 ? (
        <div
          style={{
            position: "absolute",
            left: interpolate(fly, [0, 1], [x + w / 2, tileX]) - 40,
            top: interpolate(fly, [0, 1], [y + h * 0.75, tileY]) - 14 - Math.sin(fly * Math.PI) * 80,
            width: 80,
            height: 28,
            borderRadius: 10,
            background: c.coral,
            opacity: 0.9,
            zIndex: 30,
          }}
        />
      ) : null}
    </>
  );
};

const PhoneCall: React.FC<{ frame: number }> = ({ frame }) => (
  <>
    <div style={{ display: "flex", alignItems: "center", gap: 5, height: 60 }}>
      {Array.from({ length: 26 }).map((_, k) => {
        const amp = 0.25 + 0.75 * Math.abs(Math.sin(frame * 0.35 + k * 0.7) * Math.sin(frame * 0.11 + k * 0.3));
        return <div key={k} style={{ width: 7, height: 10 + amp * 50, borderRadius: 4, background: c.coral }} />;
      })}
    </div>
    <div style={{ fontWeight: 500, fontSize: 21, lineHeight: 1.3, color: c.plumSoft, fontStyle: "italic" }}>
      "Hi, this is the AI assistant for {CLINIC.name}. This call is transcribed…"
    </div>
  </>
);

/** The payment card AYA sends in chat. It flips to "Deposit received ✓" on the tap. */
const DepositCard: React.FC<{ frame: number }> = ({ frame }) => {
  const appear = useSnap(DEPOSIT + 6);
  const tap = 622;
  const flip = lerp(frame, [tap + 4, tap + 18], [0, 1]);
  const back = flip > 0.5;
  const ripple = lerp(frame, [tap, tap + 14], [0, 1]);
  return (
    <div style={{ position: "relative", alignSelf: "flex-start", width: "92%", transform: `scale(${0.85 + 0.15 * appear}) rotateY(${flip * 180}deg)`, opacity: Math.min(1, appear), transformStyle: "preserve-3d" }}>
      <div
        style={{
          background: back ? c.coral : c.white,
          color: back ? c.white : c.plum,
          borderRadius: 22,
          padding: "16px 18px",
          boxShadow: "0 10px 24px rgba(42,22,48,0.12)",
          transform: back ? "rotateY(180deg)" : undefined,
          fontFamily: font,
        }}
      >
        {back ? (
          <div style={{ display: "flex", alignItems: "center", gap: 10, fontWeight: 800, fontSize: 24, height: 76 }}>
            <Tick size={30} /> Deposit received
          </div>
        ) : (
          <>
            <div style={{ display: "flex", alignItems: "center", gap: 10, fontWeight: 800, fontSize: 22 }}>
              <Lock size={24} /> Secure deposit · $100
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 8 }}>
              <span style={{ fontWeight: 500, fontSize: 15, color: c.plumSoft }}>Your clinic's own payment link</span>
              <span style={{ background: c.plum, color: c.white, fontWeight: 600, fontSize: 18, padding: "6px 14px", borderRadius: 999 }}>Pay now</span>
            </div>
          </>
        )}
      </div>
      {frame >= tap && frame < tap + 14 ? (
        <div
          style={{
            position: "absolute",
            right: 30,
            bottom: 10,
            width: 60,
            height: 60,
            marginRight: -30,
            marginBottom: -30,
            borderRadius: "50%",
            border: `4px solid ${c.coral}`,
            transform: `scale(${0.3 + ripple * 1.4})`,
            opacity: 1 - ripple,
          }}
        />
      ) : null}
    </div>
  );
};

/** The week view the bookings snap into. */
const Week: React.FC<{ frame: number; x: number; y: number; w: number; h: number }> = ({ frame, x, y, w, h }) => {
  const appear = enter(frame, 500, 16);
  const colW = w / 7;
  return (
    <div style={{ position: "absolute", left: x, top: y + drift(frame, 0, 2), width: w, height: h, ...enterStyle(appear, 40) }}>
      <Glass style={{ position: "absolute", inset: 0, background: "rgba(255,255,255,0.7)" }} />
      {DAYS.map((d, i) => (
        <div key={d} style={{ position: "absolute", left: i * colW, top: 0, width: colW, height: h, borderLeft: i ? "1px solid rgba(75,46,85,0.12)" : undefined }}>
          <div style={{ fontFamily: font, fontWeight: 600, fontSize: 24, color: c.plumSoft, textAlign: "center", marginTop: 16 }}>{d}</div>
        </div>
      ))}
      {CHANNELS.map((ch, i) => {
        const at = RESOLVE + i * 20 + 20;
        return <Tile key={ch.key} at={at} frame={frame} left={ch.day * colW + 8} top={h * 0.36} width={colW - 16} slot={ch.slot} deposit={ch.key === "web"} />;
      })}
    </div>
  );
};

const Tile: React.FC<{ at: number; frame: number; left: number; top: number; width: number; slot: string; deposit: boolean }> = ({
  at,
  frame,
  left,
  top,
  width,
  slot,
  deposit,
}) => {
  const p = useSnap(at);
  const badge = useSnap(648);
  if (frame < at) return null;
  const [day, ...time] = slot.split(" ");
  return (
    <div style={{ position: "absolute", left, top, width, transform: `scale(${p})`, transformOrigin: "50% 50%" }}>
      <div style={{ background: c.coral, color: c.white, borderRadius: 14, padding: "10px 8px", fontFamily: font, textAlign: "center", boxShadow: "0 8px 18px rgba(255,122,89,0.35)" }}>
        <div style={{ fontWeight: 800, fontSize: 22 }}>{time.join(" ")}</div>
        <div style={{ fontWeight: 500, fontSize: 17, opacity: 0.9 }}>{day} · Booked</div>
      </div>
      {deposit && frame >= 648 ? (
        <div style={{ position: "absolute", left: "50%", top: -26, transform: `translateX(-50%) scale(${badge})`, background: c.white, color: c.coral, border: `2px solid ${c.coral}`, borderRadius: 999, fontFamily: font, fontWeight: 800, fontSize: 17, padding: "3px 10px", whiteSpace: "nowrap" }}>
          Deposit ✓
        </div>
      ) : null}
    </div>
  );
};
