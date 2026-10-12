"use client";

import { useSyncExternalStore } from "react";

/**
 * Whether a media query matches, kept current as it changes.
 *
 * A store rather than an effect that copies `matches` into state: the store
 * is read during render, so the first client render already has the answer
 * and nothing renders once with the wrong one. The server has no screen, so
 * it answers false, which every caller here treats as "assume the plain
 * case": full motion, no hover, the stacked layout.
 */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const list = window.matchMedia(query);
      list.addEventListener("change", onChange);
      return () => list.removeEventListener("change", onChange);
    },
    () => window.matchMedia(query).matches,
    () => false,
  );
}

export const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";
