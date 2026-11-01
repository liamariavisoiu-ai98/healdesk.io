import type React from "react";
import "@fontsource-variable/instrument-sans";
import "@fontsource-variable/fraunces";

import { Easing } from "remotion";

/**
 * healdesk's brand system for the ad: one accent, healdesk's orange running
 * into its red (the logo's two colours, apps/web/src/app/globals.css), on
 * pure white and near-black, with Apple-like greys. Instrument Sans for every
 * line, as on the website; Fraunces, the wordmark's serif, only for the end
 * card's line.
 */
export const color = {
  ink: "#1D1D1F",
  grey: "#6E6E73",
  faint: "#A1A1A6",
  surface: "#F5F5F7",
  line: "rgba(0,0,0,0.08)",
  white: "#FFFFFF",
  black: "#000000",
  orange: "#FF761E",
  red: "#E62627",
} as const;

export const accent = `linear-gradient(90deg, ${color.orange} 0%, ${color.red} 100%)`;

/** Text painted with the accent. Apply to the element that holds the text itself. */
export const accentText: React.CSSProperties = {
  backgroundImage: accent,
  WebkitBackgroundClip: "text",
  backgroundClip: "text",
  color: "transparent",
};

export const font = "'Instrument Sans Variable', system-ui, sans-serif";
export const serif = "'Fraunces Variable', Georgia, serif";

/** Headlines: semibold, tight, as Apple sets display type. */
export const display: React.CSSProperties = { fontFamily: font, fontWeight: 600, letterSpacing: "-0.035em", lineHeight: 1.02 };

export const shadow = "0 30px 60px rgba(0,0,0,0.08), 0 2px 6px rgba(0,0,0,0.04)";

/** Every entrance eases out on this curve; nothing overshoots. */
export const easeOut = Easing.bezier(0.22, 1, 0.36, 1);
