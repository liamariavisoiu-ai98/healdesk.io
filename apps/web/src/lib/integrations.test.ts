import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import { LABEL, RING, TRADEMARKS } from "@/lib/integrations";

/**
 * The hero orbit's logos, guarded where they can drift apart.
 *
 * The ring, the label a screen reader hears instead of it and the footer's
 * trademark line are three lists of the same things. Pinned here: that every
 * logo's file is served, that the label names every logo, and that the
 * footer attributes every mark on the ring, along with the channel name a
 * mark stands for when the two differ (Facebook's "f" for Messenger).
 */

const PUBLIC = fileURLToPath(new URL("../../public", import.meta.url));

describe("the hero orbit's logos", () => {
  test("an odd number, so one sits at twelve o'clock and the ring mirrors itself", () => {
    expect(RING.length % 2).toBe(1);
  });

  test("no logo twice", () => {
    expect(new Set(RING.map((logo) => logo.src)).size).toBe(RING.length);
  });

  test.each(RING.map((logo) => [logo.name, logo] as const))(
    "%s: the file is in public/",
    (_name, logo) => {
      expect(existsSync(PUBLIC + logo.src)).toBe(true);
    },
  );

  test.each(RING.map((logo) => [logo.name, logo] as const))(
    "%s: the label names it",
    (_name, logo) => {
      expect(LABEL).toContain(logo.name);
    },
  );

  test.each(RING.filter((logo) => logo.mark).map((logo) => [logo.name, logo] as const))(
    "%s: the footer names its mark and its channel",
    (_name, logo) => {
      expect(TRADEMARKS).toContain(logo.mark);
      expect(TRADEMARKS).toContain(logo.name);
    },
  );

  test.each(RING.filter((logo) => logo.disc !== undefined).map((logo) => [logo.name, logo] as const))(
    "%s: its disc stays inside the logo",
    (_name, logo) => {
      expect(logo.disc).toBeGreaterThan(0);
      expect(logo.disc).toBeLessThanOrEqual(1);
    },
  );
});
