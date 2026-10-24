import "@fontsource/plus-jakarta-sans/500.css";
import "@fontsource/plus-jakarta-sans/600.css";
import "@fontsource/plus-jakarta-sans/800.css";

import { Easing } from "remotion";

/**
 * The ad's own palette and type (SCRIPT.md, "Global specification"). It is
 * deliberately not the website's: night and mist until AYA arrives, and
 * coral only where she solves something.
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
} as const;

export const font = "'Plus Jakarta Sans', system-ui, sans-serif";

export const shadow = "0 24px 48px rgba(42,22,48,0.12)";
export const radius = 28;

/** Enter: cubic-bezier(0.22, 1, 0.36, 1). Exit: cubic-bezier(0.64, 0, 0.78, 0). */
export const easeEnter = Easing.bezier(0.22, 1, 0.36, 1);
export const easeExit = Easing.bezier(0.64, 0, 0.78, 0);

/** Snap: damping 12, stiffness 180, mass 0.8, which overshoots about 6% and settles. */
export const SNAP = { damping: 12, stiffness: 180, mass: 0.8 } as const;
