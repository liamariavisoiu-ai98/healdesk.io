import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import { HERO_LOGOS, LABEL, TRADEMARKS } from "@/lib/integrations";

/**
 * The hero's logos, guarded where they can drift apart.
 *
 * The logos, the label a screen reader hears instead of them and the
 * footer's trademark line are three lists of the same things. Pinned here:
 * that every logo's file is served, that the label names every logo, that
 * the footer attributes every mark, along with the channel name a mark stands
 * for when the two differ (Facebook's "f" for Messenger), and that the places
 * on the photo keep every logo on it, clear of AYA, clear of its neighbours,
 * and alternately close to her and further out, as the owner asked.
 */

const PUBLIC = fileURLToPath(new URL("../../public", import.meta.url));

/** The hero photo, in pixels; the logos' places are percentages of it. */
const PHOTO = { width: 1672, height: 941 };

/**
 * A logo at its largest share of the photo: 5% of its width, or the 24px
 * floor where that is more, and it is most on a 320px phone, where the photo
 * is 457.6px wide (globals.css, "The hero portrait").
 */
const LOGO = Math.max(0.05, 24 / 457.6) * PHOTO.width;

/**
 * Her outline: in each band of 20 rows of the photo, top to bottom, the
 * furthest left that any row's first pixel off the white ground reaches.
 * Measured on the original PNG; a pixel is hers when its luminance is under
 * 236 or its channels spread by more than 28, and so is the one 3px right of
 * it.
 */
const OUTLINE = [
  1672, 1297, 1236, 1178, 1166, 1158, 1132, 1122, 1120, 1112, 1115, 1099, 1083, 1113, 1096, 1089,
  1091, 1101, 1112, 1149, 1150, 1155, 1186, 1176, 1156, 1148, 1140, 1098, 1081, 1073, 1059, 1053,
  1039, 1039, 1021, 1019, 1019, 1016, 985, 984, 1011, 1009, 1016, 995, 1034, 1048, 1042, 1042,
];
const BAND = 20;

const centre = (at: { x: number; y: number }) => ({
  x: (at.x / 100) * PHOTO.width,
  y: (at.y / 100) * PHOTO.height,
});

/** From a logo's right edge to her outline, over its own rows and a band either side. */
function clearance(at: { x: number; y: number }) {
  const { x, y } = centre(at);
  const top = y - LOGO / 2 - BAND;
  const bottom = y + LOGO / 2 + BAND;
  const edge = Math.min(...OUTLINE.filter((_, i) => i * BAND + BAND > top && i * BAND < bottom));
  return edge - (x + LOGO / 2);
}

describe("the hero's logos", () => {
  test("no logo twice", () => {
    expect(new Set(HERO_LOGOS.map((logo) => logo.src)).size).toBe(HERO_LOGOS.length);
  });

  test.each(HERO_LOGOS.map((logo) => [logo.name, logo] as const))(
    "%s: the file is in public/",
    (_name, logo) => {
      expect(existsSync(PUBLIC + logo.src)).toBe(true);
    },
  );

  test.each(HERO_LOGOS.map((logo) => [logo.name, logo] as const))(
    "%s: the label names it",
    (_name, logo) => {
      expect(LABEL).toContain(logo.name);
    },
  );

  test.each(HERO_LOGOS.filter((logo) => logo.mark).map((logo) => [logo.name, logo] as const))(
    "%s: the footer names its mark and its channel",
    (_name, logo) => {
      expect(TRADEMARKS).toContain(logo.mark);
      expect(TRADEMARKS).toContain(logo.name);
    },
  );

  test.each(HERO_LOGOS.map((logo) => [logo.name, logo] as const))(
    "%s: wholly on the photo, and on the white ground clear of her",
    (_name, logo) => {
      const { x, y } = centre(logo.at);
      expect(x - LOGO / 2).toBeGreaterThan(0);
      expect(y - LOGO / 2).toBeGreaterThan(0);
      expect(y + LOGO / 2).toBeLessThan(PHOTO.height);
      expect(clearance(logo.at)).toBeGreaterThan(40);
    },
  );

  test("alternately close to her and further out, starting close", () => {
    const pattern = HERO_LOGOS.map((logo) => (clearance(logo.at) < 120 ? "close" : "out"));
    expect(pattern).toEqual(HERO_LOGOS.map((_, i) => (i % 2 === 0 ? "close" : "out")));
    for (const logo of HERO_LOGOS.filter((_, i) => i % 2 === 1)) {
      expect(clearance(logo.at), logo.name).toBeGreaterThan(180);
    }
  });

  test("no two logos touch, with room for one to slide out on hover", () => {
    for (const [i, a] of HERO_LOGOS.entries()) {
      for (const b of HERO_LOGOS.slice(i + 1)) {
        const p = centre(a.at);
        const q = centre(b.at);
        expect(Math.hypot(p.x - q.x, p.y - q.y), `${a.name} and ${b.name}`).toBeGreaterThan(
          1.5 * LOGO,
        );
      }
    }
  });
});
