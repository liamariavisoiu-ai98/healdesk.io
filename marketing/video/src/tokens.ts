import "@fontsource-variable/instrument-sans";
import "@fontsource-variable/fraunces";

import { Easing } from "remotion";

/**
 * One brand system (owner, 1 November 2026): healdesk's red-to-orange is the
 * only accent, on pure white and near-black, with Apple-like greys. Everything
 * else that once coloured the ad (plum, coral, sage, ivory) is gone. A few
 * names stay as aliases so older parts keep compiling; they all resolve here.
 */
const ink = "#1D1D1F";
const grey = "#6E6E73";
export const c = {
  ink,
  grey,
  line: "rgba(0,0,0,0.08)",
  paper: "#FFFFFF",
  paper2: "#F5F5F7",
  night: "#000000",
  white: "#FFFFFF",
  healdeskRed: "#E62627",
  healdeskOrange: "#FF761E",
  gold: "#C9A45C",
  goldLight: "#E8CF92",
  // Aliases, so every older part draws in the one system.
  plum: ink,
  plumSoft: grey,
  mist: "#A1A1A6",
  coral: "#FF5A1F",
  ivory: "#FFFFFF",
  glass: "rgba(255,255,255,0.72)",
  sage: "#1D1D1F",
  sageDeep: "#1D1D1F",
  cream: "#F5F5F7",
  dusk: "#000000",
  nightDesk: "#111111",
} as const;

/** healdesk's gradient, the one accent: orange into red, as the logo runs. */
export const accent = `linear-gradient(90deg, ${c.healdeskOrange} 0%, ${c.healdeskRed} 100%)`;

/** Paint text with the accent gradient. */
export const accentText: Record<string, string> = {
  backgroundImage: accent,
  WebkitBackgroundClip: "text",
  backgroundClip: "text",
  color: "transparent",
};

/**
 * healdesk's own faces (apps/web/src/app/layout.tsx): Instrument Sans for
 * everything, Fraunces only where the wordmark's serif voice belongs, the
 * end card's line.
 */
export const font = "'Instrument Sans Variable', system-ui, sans-serif";
export const serif = "'Fraunces Variable', Georgia, serif";

/** Tracking for the big centred lines. */
export const tracked = "-0.01em";

export const shadow = "0 30px 60px rgba(0,0,0,0.08), 0 2px 6px rgba(0,0,0,0.04)";
export const radius = 28;

/** Enter: cubic-bezier(0.22, 1, 0.36, 1). Exit: cubic-bezier(0.64, 0, 0.78, 0). */
export const easeEnter = Easing.bezier(0.22, 1, 0.36, 1);
export const easeExit = Easing.bezier(0.64, 0, 0.78, 0);

/** Snap: settles without overshoot, as Apple's motion does. */
export const SNAP = { damping: 26, stiffness: 170, mass: 0.9 } as const;
