import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import { HERO_LOGOS, LABEL, ORBIT_CENTRE, ORBITS, PHOTO, TRADEMARKS, onOrbit } from "@/lib/integrations";

/**
 * The hero's logos, guarded where they can drift apart.
 *
 * The logos, the label a screen reader hears instead of them and the
 * footer's trademark line are three lists of the same things. Pinned here:
 * that every logo's file is served, that the label names every logo, that
 * the footer attributes every mark, along with the channel name a mark stands
 * for when the two differ (Facebook's "f" for Messenger), that the logos sit
 * on their three orbits all around her as the owner asked, each group's
 * stretch starting at its chip, and that the places on the photo keep every
 * logo and chip on it, off her face, out of the copy's box at every desktop
 * size, and clear of each other.
 */

const PUBLIC = fileURLToPath(new URL("../../public", import.meta.url));

/**
 * A logo at its largest share of the photo: 5% of its width, or the 20px
 * floor where that is more, and it is most on a 320px phone, where the photo
 * is the screen's width (globals.css, "The hero portrait"). The chips and the
 * copy beside the photo exist only from 1280px, where a logo is 5%.
 */
const LOGO = Math.max(0.05, 20 / 320) * PHOTO.width;
const DESKTOP_LOGO = 0.05 * PHOTO.width;

/**
 * A chip at its largest share of the photo, at 1280px wide, where the photo
 * is about 1443 CSS pixels across: 172 by 40 CSS pixels.
 */
const CHIP = { width: 200, height: 46 };

/** Her face, from brow to chin and cheek to cheek, on the 9 October 2026 photo. Hair may be covered; skin may not. */
const FACE = { x: 835, y: 420, rx: 270, ry: 350 };

/** The headset and its microphone, which the photo is about. */
const HEADSET = { left: 1000, right: 1175, top: 260, bottom: 570 };

/**
 * The copy's box on the photo, the union over every desktop size measured on
 * 9 October 2026 (1280×720 to 2560×1440): from 10% to 48.5% across, and from
 * 42% down. The bottom 10% of the photo is cut off at 1280×720.
 */
const COPY = { left: 0.1 * PHOTO.width, right: 0.485 * PHOTO.width, top: 0.42 * PHOTO.height };
const VISIBLE_BOTTOM = 0.9 * PHOTO.height;

const GROUPS = ["messages", "bookings", "payments"] as const;

const px = (at: { x: number; y: number }) => ({
  x: (at.x / 100) * PHOTO.width,
  y: (at.y / 100) * PHOTO.height,
});

type Box = { x: number; y: number; w: number; h: number };

function onPhoto(box: Box) {
  return box.x - box.w / 2 > 0 && box.x + box.w / 2 < PHOTO.width && box.y - box.h / 2 > 0 && box.y + box.h / 2 < VISIBLE_BOTTOM;
}

/** Whether any part of a box is on her face: its corners, edge midpoints and centre. */
function onFace(box: Box) {
  const points = [-0.5, 0, 0.5].flatMap((i) => [-0.5, 0, 0.5].map((j) => [box.x + i * box.w, box.y + j * box.h] as const));
  return points.some(([x, y]) => ((x - FACE.x) / FACE.rx) ** 2 + ((y - FACE.y) / FACE.ry) ** 2 < 1);
}

function inCopy(box: Box) {
  return box.x + box.w / 2 > COPY.left && box.x - box.w / 2 < COPY.right && box.y + box.h / 2 > COPY.top;
}

function onHeadset(box: Box) {
  return box.x + box.w / 2 > HEADSET.left && box.x - box.w / 2 < HEADSET.right && box.y + box.h / 2 > HEADSET.top && box.y - box.h / 2 < HEADSET.bottom;
}

function overlaps(a: Box, b: Box) {
  return Math.abs(a.x - b.x) < (a.w + b.w) / 2 && Math.abs(a.y - b.y) < (a.h + b.h) / 2;
}

const logoBox = (at: { x: number; y: number }, size = LOGO): Box => ({ ...px(at), w: size, h: size });
const chips = ORBITS.map((orbit) => ({ orbit, box: { ...px(onOrbit(orbit.group, orbit.chip)), w: CHIP.width, h: CHIP.height } }));

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
    "%s: on the photo, off her face and the headset, out of the copy's box",
    (_name, logo) => {
      expect(onPhoto(logoBox(logo.at))).toBe(true);
      expect(onFace(logoBox(logo.at))).toBe(false);
      expect(onHeadset(logoBox(logo.at, DESKTOP_LOGO))).toBe(false);
      expect(inCopy(logoBox(logo.at, DESKTOP_LOGO))).toBe(false);
    },
  );

  test.each(HERO_LOGOS.map((logo) => [logo.name, logo] as const))("%s: has a showcase", (_name, logo) => {
    expect(logo.showcase.length).toBeGreaterThan(0);
    if (logo.group === "messages" && logo.name !== "phone line") {
      expect(logo.showcase.map((line) => line.mark)).toEqual(["received", "replied"]);
    }
  });

  test("on their own orbits, all around her: Messages & Calls on her left, Bookings and Payments on her right", () => {
    for (const logo of HERO_LOGOS) {
      expect(logo.at).toEqual(onOrbit(logo.group, logo.angle));
      expect(logo.at.x < 50, logo.name).toBe(logo.group === "messages");
    }
    const order = HERO_LOGOS.map((logo) => GROUPS.indexOf(logo.group));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(new Set(order).size).toBe(GROUPS.length);
    // Concentric, the inner inside the outer all the way round.
    for (const [inner, outer] of [[ORBITS[0]!, ORBITS[1]!], [ORBITS[1]!, ORBITS[2]!]] as const) {
      expect(outer.rx).toBeGreaterThan(inner.rx);
      expect(outer.ry).toBeGreaterThan(inner.ry);
    }
    expect(ORBIT_CENTRE.x).toBeGreaterThan(FACE.x - FACE.rx);
    expect(ORBIT_CENTRE.x).toBeLessThan(FACE.x + FACE.rx);
  });

  test("each group's logos run along its orbit from its chip to the arc's tail, in order", () => {
    for (const orbit of ORBITS) {
      const angles = HERO_LOGOS.filter((logo) => logo.group === orbit.group).map((logo) => logo.angle);
      const away = angles.map((angle) => (angle - orbit.chip) * Math.sign(orbit.tail - orbit.chip));
      expect(away.every((d) => d > 0), orbit.group).toBe(true);
      expect(away).toEqual([...away].sort((a, b) => a - b));
      expect(Math.abs(orbit.tail - orbit.chip)).toBeGreaterThan(Math.max(...away));
    }
  });

  test.each(chips.map((chip) => [chip.orbit.title, chip] as const))(
    "the %s chip: on the photo, off her face, out of the copy's box, on no logo",
    (_title, { box }) => {
      expect(onPhoto(box)).toBe(true);
      expect(onFace(box)).toBe(false);
      expect(onHeadset(box)).toBe(false);
      expect(inCopy(box)).toBe(false);
      for (const logo of HERO_LOGOS) expect(overlaps(box, logoBox(logo.at, DESKTOP_LOGO)), logo.name).toBe(false);
    },
  );

  test("no two chips touch", () => {
    for (const [i, a] of chips.entries()) {
      for (const b of chips.slice(i + 1)) expect(overlaps(a.box, b.box)).toBe(false);
    }
  });

  test("no two logos touch, with room between them for a card's pointer", () => {
    for (const [i, a] of HERO_LOGOS.entries()) {
      for (const b of HERO_LOGOS.slice(i + 1)) {
        const p = px(a.at);
        const q = px(b.at);
        expect(Math.hypot(p.x - q.x, p.y - q.y), `${a.name} and ${b.name}`).toBeGreaterThan(
          Math.max(1.5 * DESKTOP_LOGO, 1.05 * LOGO),
        );
      }
    }
  });
});
