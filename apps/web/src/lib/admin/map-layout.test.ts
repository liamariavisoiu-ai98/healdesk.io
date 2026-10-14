import { describe, expect, test } from "vitest";

import { BANDS, bezier, layoutBundles, NODES, nodeOfTool, nodeRect, STAGE, worst, type Rect } from "./map-layout";
import { BRIDGES, GROUPS } from "./system-map";

/**
 * The map's layout: cards never touch, each sits in its own band, every line
 * runs clear of the cards it does not join, and every bridge is drawn
 * exactly once (or listed inside its card when both ends share one).
 */

const inside = (p: { x: number; y: number }, r: Rect, pad = 4) =>
  p.x > r.x - pad && p.x < r.x + r.w + pad && p.y > r.y - pad && p.y < r.y + r.h + pad;

describe("the stage", () => {
  test("every card is on the stage, inside its band, and clear of every other card", () => {
    const rects = NODES.map((id) => ({ id, rect: nodeRect(id) }));
    for (const { id, rect } of rects) {
      expect(rect.x, id).toBeGreaterThanOrEqual(0);
      expect(rect.y, id).toBeGreaterThanOrEqual(0);
      expect(rect.x + rect.w, id).toBeLessThanOrEqual(STAGE.width);
      expect(rect.y + rect.h, id).toBeLessThanOrEqual(STAGE.height);
      const band = id === "app" ? BANDS.patient : id === "web" ? BANDS.shop : BANDS[GROUPS.find((g) => g.id === id)!.band];
      expect(rect.y, `${id} top`).toBeGreaterThan(band.y);
      expect(rect.y + rect.h, `${id} bottom`).toBeLessThan(band.y + band.h);
    }
    for (let i = 0; i < rects.length; i += 1) {
      for (let j = i + 1; j < rects.length; j += 1) {
        const a = rects[i]!.rect;
        const b = rects[j]!.rect;
        const gap = 16;
        const close = a.x < b.x + b.w + gap && b.x < a.x + a.w + gap && a.y < b.y + b.h + gap && b.y < a.y + a.h + gap;
        expect(close, `${rects[i]!.id} and ${rects[j]!.id}`).toBe(false);
      }
    }
  });

  test("the bands are stacked top to bottom without overlapping", () => {
    expect(BANDS.patient.y + BANDS.patient.h).toBeLessThan(BANDS.shared.y);
    expect(BANDS.shared.y + BANDS.shared.h).toBeLessThan(BANDS.shop.y);
    expect(BANDS.shop.y + BANDS.shop.h).toBeLessThanOrEqual(STAGE.height);
  });
});

describe("the lines", () => {
  const { bundles, internal } = layoutBundles();

  test("every bridge is drawn in exactly one bundle, or listed inside its card", () => {
    const drawn = bundles.flatMap((b) => b.bridges);
    const inner = Object.values(internal).flat();
    expect(new Set(drawn).size).toBe(drawn.length);
    expect([...drawn, ...inner].sort()).toEqual(BRIDGES.map((b) => b.id).sort());
    for (const id of inner) {
      const bridge = BRIDGES.find((b) => b.id === id)!;
      expect(nodeOfTool(bridge.from)).toBe(nodeOfTool(bridge.to));
    }
  });

  test("each lane points the way its bridges carry information", () => {
    for (const bundle of bundles) {
      for (const lane of bundle.lanes) {
        for (const id of lane.bridges) {
          const bridge = BRIDGES.find((b) => b.id === id)!;
          const forward = nodeOfTool(bridge.from) === lane.from && nodeOfTool(bridge.to) === lane.to;
          const back = Boolean(bridge.both) && nodeOfTool(bridge.to) === lane.from && nodeOfTool(bridge.from) === lane.to;
          expect(forward || back, `${id} on ${lane.id}`).toBe(true);
        }
      }
      expect(bundle.lanes.length).toBeLessThanOrEqual(2);
    }
  });

  test("no line runs through a card it does not join, and no two labels sit together", () => {
    for (const bundle of bundles) {
      for (const lane of bundle.lanes) {
        for (let step = 1; step < 60; step += 1) {
          const p = bezier(lane, step / 60);
          for (const id of NODES) {
            if (id === lane.from || id === lane.to) continue;
            expect(inside(p, nodeRect(id)), `${lane.id} runs through ${id} at ${Math.round(p.x)},${Math.round(p.y)}`).toBe(false);
          }
        }
      }
    }
    for (let i = 0; i < bundles.length; i += 1) {
      for (let j = i + 1; j < bundles.length; j += 1) {
        const a = bundles[i]!.middle;
        const b = bundles[j]!.middle;
        expect(Math.hypot(a.x - b.x, a.y - b.y), `${bundles[i]!.id} and ${bundles[j]!.id}`).toBeGreaterThan(36);
      }
    }
  });

  test("a line starts and ends just outside its cards", () => {
    for (const bundle of bundles) {
      for (const lane of bundle.lanes) {
        expect(inside(lane.start, nodeRect(lane.from), 0), lane.id).toBe(false);
        expect(inside(lane.end, nodeRect(lane.to), 0), lane.id).toBe(false);
        expect(inside(lane.start, nodeRect(lane.from), 12), lane.id).toBe(true);
        expect(inside(lane.end, nodeRect(lane.to), 14), lane.id).toBe(true);
      }
    }
  });
});

describe("worst", () => {
  test("a broken bridge outranks everything, and an empty list has no colour", () => {
    expect(worst(["working", "broken", "needs-key"])).toBe("broken");
    expect(worst(["working", "parked"])).toBe("parked");
    expect(worst(["working"])).toBe("working");
    expect(worst([])).toBeNull();
  });
});
