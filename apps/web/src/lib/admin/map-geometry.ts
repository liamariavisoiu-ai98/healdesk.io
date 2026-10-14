/**
 * Where the system map's boxes and curves go, in the diagram's own units.
 *
 * Pure arithmetic, shared by SystemMap.tsx (which draws it) and
 * system-map.test.ts (which checks no two boxes overlap and every curve
 * starts and ends outside the boxes it joins). Places are rounded to a
 * hundredth so the server's HTML and the browser's render agree to the
 * digit, as lib/integrations.ts does for the same reason.
 */

import { BOX, type ToolDef } from "./system-map";

export type Point = { x: number; y: number };
export type Rect = { x: number; y: number; w: number; h: number };

const round = (value: number) => Math.round(value * 100) / 100;

export function boxOf(tool: Pick<ToolDef, "group" | "x" | "y">): Rect {
  const { w, h } = BOX[tool.group];
  return { x: tool.x - w / 2, y: tool.y - h / 2, w, h };
}

/** Whether two boxes touch, with `gap` units of air required between them. */
export function overlaps(a: Rect, b: Rect, gap = 0): boolean {
  return a.x < b.x + b.w + gap && b.x < a.x + a.w + gap && a.y < b.y + b.h + gap && b.y < a.y + a.h + gap;
}

/**
 * Where a ray from a box's centre toward `toward` leaves the box, pushed out
 * by `pad` so an arrowhead sits just outside the border rather than on it.
 */
export function exitPoint(box: Rect, toward: Point, pad = 6): Point {
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  const dx = toward.x - cx;
  const dy = toward.y - cy;
  if (dx === 0 && dy === 0) return { x: cx, y: cy };
  const halfW = box.w / 2 + pad;
  const halfH = box.h / 2 + pad;
  const scale = Math.min(dx === 0 ? Infinity : halfW / Math.abs(dx), dy === 0 ? Infinity : halfH / Math.abs(dy));
  return { x: round(cx + dx * scale), y: round(cy + dy * scale) };
}

export type Curve = {
  /** The SVG path: one quadratic curve. */
  d: string;
  start: Point;
  end: Point;
  control: Point;
  /** The curve's halfway point, where its number sits. */
  middle: Point;
};

/**
 * A quadratic curve from one box to another, bowing to the left of the
 * direction of travel by `bend` times its length (negative bows right). Two
 * bridges between the same pair in opposite directions with the same bend
 * therefore bow to opposite sides and never sit on top of each other.
 */
export function curveBetween(from: Rect, to: Rect, bend = 0): Curve {
  const a = { x: from.x + from.w / 2, y: from.y + from.h / 2 };
  const b = { x: to.x + to.w / 2, y: to.y + to.h / 2 };
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = Math.hypot(dx, dy) || 1;
  const control = {
    x: round((a.x + b.x) / 2 + (dy / length) * bend * length),
    y: round((a.y + b.y) / 2 - (dx / length) * bend * length),
  };
  const start = exitPoint(from, control);
  const end = exitPoint(to, control);
  const middle = {
    x: round(0.25 * start.x + 0.5 * control.x + 0.25 * end.x),
    y: round(0.25 * start.y + 0.5 * control.y + 0.25 * end.y),
  };
  return { d: `M ${start.x} ${start.y} Q ${control.x} ${control.y} ${end.x} ${end.y}`, start, end, control, middle };
}

/** A point on the curve at t in [0, 1]. */
export function pointOn(curve: Curve, t: number): Point {
  const u = 1 - t;
  return {
    x: u * u * curve.start.x + 2 * u * t * curve.control.x + t * t * curve.end.x,
    y: u * u * curve.start.y + 2 * u * t * curve.control.y + t * t * curve.end.y,
  };
}
