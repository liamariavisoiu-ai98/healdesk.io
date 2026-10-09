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
 * for when the two differ (Facebook's "f" for Messenger), that the logos sit
 * in their three groups all around her as the owner asked, and that the
 * places on the photo keep every logo on it, on the wall clear of her, and
 * clear of its neighbours.
 */

const PUBLIC = fileURLToPath(new URL("../../public", import.meta.url));

/** The hero photo, in pixels; the logos' places are percentages of it. */
const PHOTO = { width: 1672, height: 941 };

/**
 * A logo at its largest share of the photo: 5% of its width, or the 20px
 * floor where that is more, and it is most on a 320px phone, where the photo
 * is the screen's width (globals.css, "The hero portrait"). Hover, and so the
 * slide out, happens only on a desktop, where a logo is 5%.
 */
const LOGO = Math.max(0.05, 20 / 320) * PHOTO.width;
const DESKTOP_LOGO = 0.05 * PHOTO.width;

/**
 * Her outline: in each band of 47 rows of the photo, top to bottom, the first
 * pixel from the left and from the right that is hers rather than the wall.
 * Measured on the 9 October 2026 photo; a pixel is hers when its luminance is
 * under 150, which leaves out the wall's shadow on the left.
 */
const BAND = 47;
const OUTLINE: readonly (readonly [number, number])[] = [
  [433, 1117], [418, 1135], [363, 1190], [361, 1214], [338, 1221], [312, 1267], [308, 1278],
  [312, 1296], [277, 1308], [244, 1299], [242, 1311], [264, 1343], [260, 1352], [229, 1313],
  [205, 1305], [150, 1305], [92, 1309], [101, 1336], [75, 1381], [47, 1373], [46, 1189],
];

const GROUPS = ["messages", "bookings", "payments"] as const;

const centre = (at: { x: number; y: number }) => ({
  x: (at.x / 100) * PHOTO.width,
  y: (at.y / 100) * PHOTO.height,
});

/**
 * From a logo's nearer edge to her outline, over its own rows and a band
 * either side: positive when the logo is wholly on the wall beside her.
 */
function clearance(at: { x: number; y: number }) {
  const { x, y } = centre(at);
  const top = y - LOGO / 2 - BAND;
  const bottom = y + LOGO / 2 + BAND;
  const rows = OUTLINE.filter((_, i) => i * BAND + BAND > top && i * BAND < bottom);
  return x < PHOTO.width / 2
    ? Math.min(...rows.map(([left]) => left)) - (x + LOGO / 2)
    : x - LOGO / 2 - Math.max(...rows.map(([, right]) => right));
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
    "%s: wholly on the photo, and on the wall clear of her",
    (_name, logo) => {
      const { x, y } = centre(logo.at);
      expect(x - LOGO / 2).toBeGreaterThan(0);
      expect(x + LOGO / 2).toBeLessThan(PHOTO.width);
      expect(y - LOGO / 2).toBeGreaterThan(0);
      expect(y + LOGO / 2).toBeLessThan(PHOTO.height);
      expect(clearance(logo.at)).toBeGreaterThan(0);
    },
  );

  test("all around her by group: messages on her left, bookings and payments on her right", () => {
    for (const logo of HERO_LOGOS) {
      const left = logo.at.x < 50;
      expect(left, logo.name).toBe(logo.group === "messages");
    }
    const order = HERO_LOGOS.map((logo) => GROUPS.indexOf(logo.group));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(new Set(order).size).toBe(GROUPS.length);
    for (const side of [true, false]) {
      const ys = HERO_LOGOS.filter((logo) => logo.at.x < 50 === side).map((logo) => logo.at.y);
      expect(ys).toEqual([...ys].sort((a, b) => a - b));
    }
  });

  test("no two logos touch, with room for one to slide out on hover", () => {
    for (const [i, a] of HERO_LOGOS.entries()) {
      for (const b of HERO_LOGOS.slice(i + 1)) {
        const p = centre(a.at);
        const q = centre(b.at);
        expect(Math.hypot(p.x - q.x, p.y - q.y), `${a.name} and ${b.name}`).toBeGreaterThan(
          Math.max(1.5 * DESKTOP_LOGO, 1.05 * LOGO),
        );
      }
    }
  });
});
