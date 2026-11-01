import React from "react";
import { Img, staticFile } from "remotion";

import { color, font } from "../brand";
import { ICONS, type Channel } from "../copy";

/** An app icon, iOS-shaped, with an optional red badge. */
export const AppIcon: React.FC<{ channel: Channel; size: number; badge?: number; bump?: number; shadow?: boolean }> = ({ channel, size, badge, bump = 0, shadow = true }) => (
  <div style={{ position: "relative", width: size, height: size, filter: shadow ? `drop-shadow(0 ${size * 0.12}px ${size * 0.2}px rgba(0,0,0,0.35))` : undefined }}>
    <Img src={staticFile(ICONS[channel])} style={{ width: size, height: size, borderRadius: size * 0.23, display: "block" }} />
    {badge ? (
      <div
        style={{
          position: "absolute",
          right: -size * 0.12,
          top: -size * 0.12,
          minWidth: size * 0.38,
          height: size * 0.38,
          padding: `0 ${size * 0.09}px`,
          borderRadius: 999,
          background: "#FF3B30",
          color: color.white,
          fontFamily: font,
          fontWeight: 700,
          fontSize: size * 0.21,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          transform: `scale(${1 + 0.12 * bump})`,
          boxShadow: "0 3px 10px rgba(255,59,48,0.45)",
        }}
      >
        {badge}
      </div>
    ) : null}
  </div>
);

/**
 * A notification as iOS draws it. `dark` is the frosted card on a lock
 * screen; light is the banner over white. `icon` is a channel, or healdesk's
 * own app icon when omitted.
 */
export const Notification: React.FC<{ title: string; body: string; app: string; channel?: Channel; dark?: boolean; s?: number }> = ({ title, body, app, channel, dark, s = 1 }) => (
  <div
    style={{
      borderRadius: 30 * s,
      padding: `${22 * s}px ${24 * s}px`,
      display: "flex",
      alignItems: "center",
      gap: 20 * s,
      fontFamily: font,
      color: dark ? color.white : color.ink,
      background: dark ? "rgba(255,255,255,0.18)" : "rgba(255,255,255,0.96)",
      backdropFilter: dark ? "blur(30px) saturate(180%)" : undefined,
      boxShadow: dark ? "inset 0 1px 0 rgba(255,255,255,0.22)" : "0 24px 50px rgba(0,0,0,0.12), 0 2px 6px rgba(0,0,0,0.05)",
      border: dark ? undefined : `1px solid ${color.line}`,
    }}
  >
    {channel ? (
      <Img src={staticFile(ICONS[channel])} style={{ width: 70 * s, height: 70 * s, borderRadius: 16 * s, flexShrink: 0 }} />
    ) : (
      <Img src={staticFile("healdesk-icon.png")} style={{ width: 70 * s, height: 70 * s, borderRadius: 16 * s, flexShrink: 0, boxShadow: "0 2px 8px rgba(0,0,0,0.12)" }} />
    )}
    <div style={{ flex: 1, minWidth: 0 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <span style={{ fontSize: 28 * s, fontWeight: 700, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{title}</span>
        <span style={{ fontSize: 22 * s, fontWeight: 500, opacity: 0.6, marginLeft: 12 * s }}>now</span>
      </div>
      <div style={{ fontSize: 26 * s, fontWeight: 500, opacity: 0.9, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{body}</div>
      <div style={{ fontSize: 20 * s, fontWeight: 600, opacity: 0.5, marginTop: 2 * s, letterSpacing: "0.02em" }}>{app}</div>
    </div>
  </div>
);

/** A check mark that draws itself as `p` runs 0 → 1. */
export const Tick: React.FC<{ size: number; p?: number }> = ({ size, p = 1 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24">
    <path d="M4 12.5l5 5L20 6.5" fill="none" stroke="#fff" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" pathLength={1} strokeDasharray={1} strokeDashoffset={1 - p} />
  </svg>
);

/** healdesk's wordmark, as the website draws it (its ".io" is the address). */
export const Logo: React.FC<{ height: number }> = ({ height }) => <Img src={staticFile("healdesk-logo.png")} style={{ height, display: "block" }} />;

/** Aya's face in a circle, from her portrait. */
export const AyaAvatar: React.FC<{ size: number; ring?: boolean }> = ({ size, ring = false }) => (
  <div
    style={{
      width: size,
      height: size,
      borderRadius: "50%",
      overflow: "hidden",
      flexShrink: 0,
      boxShadow: ring ? `0 0 0 ${size * 0.05}px #fff, 0 0 0 ${size * 0.09}px ${color.orange}` : "0 4px 14px rgba(0,0,0,0.12)",
    }}
  >
    <Img src={staticFile("aya.webp")} style={{ width: "200%", height: "auto", marginLeft: "-50%" }} />
  </div>
);
