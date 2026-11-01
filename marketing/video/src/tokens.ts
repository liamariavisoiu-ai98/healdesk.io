import "@fontsource-variable/inter";

import { Easing } from "remotion";

/**
 * The ad's palette (SCRIPT.md, "Global specification") and its type. Night
 * until Aya arrives, and coral only where she solves something.
 */
export const c = {
  ivory: "#FAF6F0",
  night: "#14101A",
  nightDesk: "#211A2A",
  plum: "#2A1630",
  plumSoft: "#4B2E55",
  mist: "#9A9AA2",
  coral: "#FF7A59",
  gold: "#C9A45C",
  goldLight: "#E8CF92",
  glass: "rgba(255,255,255,0.55)",
  white: "#FFFFFF",
  // The fictional clinic built from its URL in scene 3.
  sage: "#7F9C86",
  sageDeep: "#4E6B57",
  cream: "#F3EBDD",
  dusk: "#1E2742",
  // healdesk's own pair, off the logo (apps/web/src/app/globals.css).
  healdeskRed: "#E62627",
  healdeskOrange: "#FF761E",
} as const;

/**
 * Inter, the open face closest to Apple's SF Pro, which may not be used
 * outside Apple's platforms. Variable, so any weight renders exactly.
 */
export const font = "'Inter Variable', system-ui, sans-serif";

/** Apple-style tracking for the big centred lines: a touch open, never tight. */
export const tracked = "0.01em";

export const shadow = "0 24px 48px rgba(42,22,48,0.12)";
export const radius = 28;

/** Enter: cubic-bezier(0.22, 1, 0.36, 1). Exit: cubic-bezier(0.64, 0, 0.78, 0). */
export const easeEnter = Easing.bezier(0.22, 1, 0.36, 1);
export const easeExit = Easing.bezier(0.64, 0, 0.78, 0);

/** Snap: damping 12, stiffness 180, mass 0.8, which overshoots about 6% and settles. */
export const SNAP = { damping: 12, stiffness: 180, mass: 0.8 } as const;
