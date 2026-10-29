import React from "react";
import { interpolate, spring, useVideoConfig } from "remotion";

import { BOOKED_VALUE, CHANNELS, Channel, CLINIC, money } from "../copy";
import { lerp, Shell, Stage, useLayout, useFrame } from "../motion";
import { Backdrop, Bubble, Glass, Icon, Notification, Orb } from "../parts";
import { c, font, SNAP } from "../tokens";

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const BURST = 8;
const RESOLVE = 48;
const STEP = 16;
const NOTIFY = 138;

const resolveAt = (i: number) => RESOLVE + i * STEP;
const landAt = (i: number) => resolveAt(i) + 20;

/**
 * Scene 4, "Every channel, at once", 180 frames. The orb pulses and
 * five glass conversations burst out of it; each resolves, flies into the
 * week as a booking with its value, the booked value counts up, and
 * healdesk's notification lands.
 */
export const S4Channels: React.FC = () => {
  const frame = useFrame();
  const { wide } = useLayout();

  const W = wide ? 1920 : 1080;
  const orbAt = wide ? { x: 960, y: 120 } : { x: 540, y: 110 };
  const cards = layout(wide);
  const cal = wide ? { x: 115, y: 700, w: 1690, h: 200 } : { x: 40, y: 1060, w: 1000, h: 200 };

  // Booked value counts up as each tile lands.
  const landed = CHANNELS.reduce((sum, ch, i) => sum + ch.value * lerp(frame, [landAt(i), landAt(i) + 12], [0, 1]), 0);

  return (
    <>
      <Backdrop mood="ivory" />
      <Shell duration={180} push={0.035}>
        <Stage>
          {/* The orb, small now, at the top: everything comes out of it. */}
          <div style={{ position: "absolute", left: orbAt.x - 60, top: orbAt.y - 60, zIndex: 5 }}>
            <Orb size={120} energy={frame < 20 ? 1 - frame / 20 : 0.3 * Math.abs(Math.sin(frame * 0.3))} />
          </div>
          {frame < 24 ? (
            <div style={{ position: "absolute", left: orbAt.x - 80, top: orbAt.y - 80, width: 160, height: 160, borderRadius: "50%", border: `5px solid ${c.coral}`, transform: `scale(${1 + lerp(frame, [0, 24], [0, 1]) * 3})`, opacity: 1 - lerp(frame, [0, 24], [0, 1]) }} />
          ) : null}

          {/* Booked value, the one figure v1 may claim: bookings times the clinic's own prices. */}
          <div style={{ position: "absolute", right: wide ? 70 : 40, top: (wide ? 70 : 60) + lerp(frame, [NOTIFY, NOTIFY + 12], [0, wide ? 0 : 120]), opacity: lerp(frame, [40, 52], [0, 1]) * (wide ? 1 - lerp(frame, [NOTIFY, NOTIFY + 8], [0, 1]) : 1), transform: `translateY(${(1 - lerp(frame, [40, 52], [0, 1])) * -20}px)`, zIndex: 50 }}>
            <Glass style={{ padding: "14px 24px", textAlign: "right" }}>
              <div style={{ fontSize: 20, fontWeight: 700, letterSpacing: "0.08em", color: c.plumSoft }}>BOOKED VALUE</div>
              <div style={{ fontSize: 50, fontWeight: 800, letterSpacing: "-0.02em", color: landed > 0 ? c.coral : c.plum, fontVariantNumeric: "tabular-nums" }}>{money(Math.round(landed))}</div>
            </Glass>
          </div>

          <Week frame={frame} {...cal} />

          {CHANNELS.map((ch, i) => (
            <ChannelCard key={ch.key} ch={ch} i={i} frame={frame} box={cards[i]} orbAt={orbAt} cal={cal} />
          ))}

          {/* healdesk tells the clinic what happened. */}
          <HealdeskBanner frame={frame} W={W} wide={wide} />
        </Stage>
      </Shell>
    </>
  );
};

type Box = { x: number; y: number; w: number; h: number };

function layout(wide: boolean): Box[] {
  if (wide) return CHANNELS.map((_, i) => ({ x: 115 + i * 342, y: 260, w: 322, h: 400 }));
  // Phone across the top, then two rows of two.
  return [
    { x: 40, y: 230, w: 1000, h: 250 },
    { x: 40, y: 505, w: 490, h: 260 },
    { x: 550, y: 505, w: 490, h: 260 },
    { x: 40, y: 785, w: 490, h: 260 },
    { x: 550, y: 785, w: 490, h: 260 },
  ];
}

const ChannelCard: React.FC<{ ch: Channel; i: number; frame: number; box: Box; orbAt: { x: number; y: number }; cal: Box }> = ({ ch, i, frame, box, orbAt, cal }) => {
  const { fps } = useVideoConfig();
  const { wide } = useLayout();
  const text = wide ? 22 : 26;
  const burst = spring({ frame: frame - (BURST + i * 6), fps, config: { damping: 13, stiffness: 150, mass: 0.9 } });
  const reply = spring({ frame: frame - resolveAt(i), fps, config: SNAP });
  const dx = (1 - burst) * (orbAt.x - box.x - box.w / 2);
  const dy = (1 - burst) * (orbAt.y - box.y - box.h / 2);

  // The reply lifts off as a tile toward its day.
  const fly = lerp(frame, [resolveAt(i) + 8, landAt(i)], [0, 1]);
  const colW = cal.w / 7;
  const tileX = cal.x + ch.day * colW + colW / 2;
  const tileY = cal.y + cal.h * 0.6;
  const done = frame >= landAt(i);

  return (
    <>
      <div
        style={{
          position: "absolute",
          left: box.x,
          top: box.y,
          width: box.w,
          height: box.h,
          transform: `translate(${dx}px, ${dy}px) scale(${0.3 + 0.7 * Math.min(1.04, burst)}) perspective(1400px) rotateX(${(1 - burst) * 30 + Math.sin((frame + i * 17) / 35) * 1.5}deg) rotateY(${Math.cos((frame + i * 23) / 45) * 2}deg)`,
          opacity: Math.min(1, burst * 1.6),
          filter: burst < 0.95 ? `blur(${(1 - Math.min(1, burst)) * 10}px)` : undefined,
          zIndex: 10,
        }}
      >
        <Glass style={{ width: "100%", height: "100%", padding: 22, display: "flex", flexDirection: "column", gap: 12, overflow: "hidden", boxShadow: done ? `0 0 0 3px ${c.coral}, 0 24px 48px rgba(42,22,48,0.12)` : undefined }}>
          <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
            <Icon name={ch.icon} size={52} />
            <div style={{ fontWeight: 800, fontSize: wide ? 26 : 30, flex: 1, whiteSpace: "nowrap" }}>{ch.title}</div>
            <div style={{ fontWeight: 500, fontSize: 22, color: c.plumSoft }}>{ch.meta}</div>
          </div>
          {ch.key === "phone" ? <PhoneCall frame={frame} /> : ch.ask ? <Bubble from="patient" size={text} tint={c.plumSoft}>{ch.ask}</Bubble> : null}
          {frame >= resolveAt(i) ? (
            <Bubble from="aya" size={text} style={{ transform: `scale(${0.85 + 0.15 * reply})`, transformOrigin: "0 100%", opacity: Math.min(1, reply), boxShadow: `inset 0 0 0 2px ${c.coral}` }}>
              {ch.reply}
            </Bubble>
          ) : null}
        </Glass>
      </div>
      {fly > 0 && fly < 1 ? (
        <div
          style={{
            position: "absolute",
            left: interpolate(fly, [0, 1], [box.x + box.w / 2, tileX]) - 50,
            top: interpolate(fly, [0, 1], [box.y + box.h * 0.8, tileY]) - 18 - Math.sin(fly * Math.PI) * 90,
            width: 100,
            height: 36,
            borderRadius: 12,
            background: c.coral,
            boxShadow: "0 10px 24px rgba(255,122,89,0.5)",
            transform: `scale(${1 - 0.2 * Math.sin(fly * Math.PI)}) rotate(${Math.sin(fly * Math.PI) * 8}deg)`,
            zIndex: 30,
            color: c.white,
            fontFamily: font,
            fontWeight: 800,
            fontSize: 20,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          {money(ch.value)}
        </div>
      ) : null}
    </>
  );
};

const PhoneCall: React.FC<{ frame: number }> = ({ frame }) => (
  <>
    <div style={{ display: "flex", alignItems: "center", gap: 5, height: 56 }}>
      {Array.from({ length: 40 }).map((_, k) => {
        const amp = 0.2 + 0.8 * Math.abs(Math.sin(frame * 0.35 + k * 0.7) * Math.sin(frame * 0.11 + k * 0.3));
        return <div key={k} style={{ width: 6, height: 8 + amp * 48, borderRadius: 3, background: `linear-gradient(180deg, ${c.coral}, ${c.gold})` }} />;
      })}
    </div>
    <div style={{ fontWeight: 500, fontSize: 22, lineHeight: 1.3, color: c.plumSoft, fontStyle: "italic" }}>
      "Hi, this is the AI assistant for {CLINIC.name}. This call is transcribed…"
    </div>
  </>
);

/** The week the bookings land in, each tile with its time and the clinic's price. */
const Week: React.FC<{ frame: number } & Box> = ({ frame, x, y, w, h }) => {
  const { fps } = useVideoConfig();
  const appear = spring({ frame: frame - 30, fps, config: { damping: 18 } });
  const colW = w / 7;
  return (
    <div style={{ position: "absolute", left: x, top: y, width: w, height: h, transform: `perspective(1600px) rotateX(${(1 - appear) * 40}deg) translateY(${(1 - appear) * 60}px)`, opacity: Math.min(1, appear * 1.4) }}>
      <Glass style={{ position: "absolute", inset: 0 }} />
      {DAYS.map((d, i) => (
        <div key={d} style={{ position: "absolute", left: i * colW, top: 0, width: colW, height: h, borderLeft: i ? "1px solid rgba(75,46,85,0.12)" : undefined }}>
          <div style={{ fontFamily: font, fontWeight: 700, fontSize: 22, color: c.plumSoft, textAlign: "center", marginTop: 14 }}>{d}</div>
        </div>
      ))}
      {CHANNELS.map((ch, i) => (
        <Tile key={ch.key} at={landAt(i)} left={ch.day * colW + 6} top={h * 0.3} width={colW - 12} ch={ch} />
      ))}
    </div>
  );
};

const Tile: React.FC<{ at: number; left: number; top: number; width: number; ch: Channel }> = ({ at, left, top, width, ch }) => {
  const frame = useFrame();
  const { fps } = useVideoConfig();
  const p = spring({ frame: frame - at, fps, config: SNAP });
  if (frame < at) return null;
  return (
    <div style={{ position: "absolute", left, top, width, transform: `scale(${p})` }}>
      <div style={{ background: c.coral, color: c.white, borderRadius: 14, padding: "10px 6px", fontFamily: font, textAlign: "center", boxShadow: "0 10px 22px rgba(255,122,89,0.4), inset 0 1px 0 rgba(255,255,255,0.4)" }}>
        <div style={{ fontWeight: 800, fontSize: 21 }}>{ch.time}</div>
        <div style={{ fontWeight: 800, fontSize: 26 }}>{money(ch.value)}</div>
      </div>
    </div>
  );
};

const HealdeskBanner: React.FC<{ frame: number; W: number; wide: boolean }> = ({ frame, W, wide }) => {
  const { fps } = useVideoConfig();
  const p = spring({ frame: frame - NOTIFY, fps, config: { damping: 14, stiffness: 160 } });
  if (frame < NOTIFY) return null;
  const width = wide ? 820 : 900;
  return (
    <div style={{ position: "absolute", left: (W - width) / 2, top: interpolate(p, [0, 1], [-200, wide ? 40 : 30]), zIndex: 60, filter: p < 0.9 ? `blur(${(1 - p) * 8}px)` : undefined }}>
      <Notification app="healdesk" title={`Aya booked 5 appointments · ${money(BOOKED_VALUE)}`} body="Calls, Instagram, Messenger, WhatsApp and web chat" time="now" width={width} />
    </div>
  );
};
