/**
 * Where the system map puts things, and how its lines run.
 *
 * ## One line per pair of categories, not one per bridge
 *
 * Forty bridges drawn one by one were forty lines crossing each other. The
 * map now draws a line per pair of things that talk (a hub or a category
 * card), with one lane for each direction the information travels, so the
 * patient side, the shop side and what they share read at a glance. Every
 * bridge is still there, one click away, with its own key and direction.
 *
 * ## The stage
 *
 * Everything is placed on a fixed 1400 × 1000 stage that SystemMap scales to
 * the screen, so the cards (HTML, for real typography) and the lines (SVG)
 * stay aligned at any width. Places are rounded to a hundredth so the
 * server's markup and the browser's agree to the digit.
 *
 * Pure arithmetic, shared by the map (which draws it) and map-layout.test.ts
 * (which checks no card overlaps another and no line runs through a card it
 * does not join).
 */

import { BRIDGES, GROUPS, TOOLS, type Band, type BridgeStatus, type GroupId } from "./system-map";

export type Point = { x: number; y: number };
export type Rect = { x: number; y: number; w: number; h: number };

export const STAGE = { width: 1400, height: 1000 } as const;

/** The three bands, top to bottom. Their labels sit in the first 40 units. */
export const BANDS: Record<Band, Rect & { title: string; note: string }> = {
  patient: {
    x: 16,
    y: 16,
    w: 1368,
    h: 420,
    title: "Patient side",
    note: "Patient data lives only here: our AWS account, under business associate agreements.",
  },
  shared: { x: 16, y: 448, w: 1368, h: 170, title: "Shared by both sides", note: "Both apps use these. No patient data goes through them." },
  shop: { x: 16, y: 630, w: 1368, h: 360, title: "Shop side", note: "healdesk.io on Vercel. It never holds patient data." },
};

export type HubId = "app" | "web";
export type NodeId = HubId | GroupId;

export const HUB_SIZE = { w: 280, h: 112 } as const;

/** Each hub's centre. */
export const HUB_AT: Record<HubId, Point> = {
  app: { x: 785, y: 230 },
  web: { x: 785, y: 760 },
};

/** Each category card's centre, width and how many chips sit side by side. */
export const GROUP_AT: Record<GroupId, Point & { w: number; cols: number }> = {
  "patient-people": { x: 145, y: 212, w: 240, cols: 1 },
  "front-doors": { x: 455, y: 130, w: 210, cols: 1 },
  vault: { x: 455, y: 338, w: 330, cols: 2 },
  brain: { x: 1045, y: 100, w: 210, cols: 1 },
  bookings: { x: 1240, y: 240, w: 260, cols: 1 },
  "phase-two": { x: 1260, y: 380, w: 220, cols: 1 },
  deploys: { x: 628, y: 533, w: 240, cols: 1 },
  payments: { x: 910, y: 533, w: 190, cols: 1 },
  email: { x: 1120, y: 533, w: 190, cols: 1 },
  "shop-people": { x: 145, y: 745, w: 240, cols: 1 },
  selling: { x: 460, y: 905, w: 540, cols: 3 },
  records: { x: 1150, y: 780, w: 240, cols: 1 },
};

/** A category card's parts, in stage units. */
export const CARD = { head: 46, chip: 36, gap: 8, pad: 12 } as const;

const round = (value: number) => Math.round(value * 100) / 100;

export function toolsIn(group: GroupId): string[] {
  return TOOLS.filter((tool) => tool.category === group).map((tool) => tool.id);
}

export function cardHeight(group: GroupId): number {
  const rows = Math.ceil(toolsIn(group).length / GROUP_AT[group].cols);
  return CARD.head + rows * CARD.chip + (rows - 1) * CARD.gap + CARD.pad;
}

export function nodeRect(id: NodeId): Rect {
  if (id === "app" || id === "web") {
    const at = HUB_AT[id];
    return { x: at.x - HUB_SIZE.w / 2, y: at.y - HUB_SIZE.h / 2, w: HUB_SIZE.w, h: HUB_SIZE.h };
  }
  const at = GROUP_AT[id];
  const h = cardHeight(id);
  return { x: at.x - at.w / 2, y: at.y - h / 2, w: at.w, h };
}

export const NODES: readonly NodeId[] = ["app", "web", ...GROUPS.map((group) => group.id)];

/** The hub a tool is, or the category it sits in. */
export function nodeOfTool(toolId: string): NodeId {
  if (toolId === "app" || toolId === "web") return toolId;
  const tool = TOOLS.find((candidate) => candidate.id === toolId);
  if (!tool?.category) throw new Error(`${toolId} is neither a hub nor in a category`);
  return tool.category;
}

// -----------------------------------------------------------------------------
// Bundles: one line per pair, one lane per direction
// -----------------------------------------------------------------------------

type Side = "left" | "right" | "top" | "bottom";

const NORMAL: Record<Side, Point> = {
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
  top: { x: 0, y: -1 },
  bottom: { x: 0, y: 1 },
};

export type Lane = {
  id: string;
  from: NodeId;
  to: NodeId;
  /** The bridges whose information travels this way. */
  bridges: string[];
  /** A cubic curve in the direction of travel. */
  d: string;
  start: Point;
  c1: Point;
  c2: Point;
  end: Point;
  /** Roughly, in stage units, so motion can keep one speed everywhere. */
  length: number;
};

export type Bundle = {
  id: string;
  a: NodeId;
  b: NodeId;
  bridges: string[];
  lanes: Lane[];
  /** Halfway along, where its label sits. */
  middle: Point;
};

export type Layout = {
  bundles: Bundle[];
  /** Bridges between two tools in the same category, shown in its card's details. */
  internal: Partial<Record<NodeId, string[]>>;
};

function centre(rect: Rect): Point {
  return { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 };
}

/** Which side of `from` faces `to`, judged against the box's own proportions. */
function facing(from: Rect, to: Rect): Side {
  const a = centre(from);
  const b = centre(to);
  const dx = (b.x - a.x) / from.w;
  const dy = (b.y - a.y) / from.h;
  // A slight lean towards the sides: for a neighbour on the diagonal, leaving
  // sideways and arriving from above reads as one bend, where leaving from
  // the bottom towards a card at the same height doubles back on itself.
  if (Math.abs(dx) >= Math.abs(dy) * 0.9) return dx >= 0 ? "right" : "left";
  return dy >= 0 ? "bottom" : "top";
}

function pointOnSide(rect: Rect, side: Side, fraction: number): Point {
  switch (side) {
    case "left":
      return { x: rect.x, y: rect.y + rect.h * fraction };
    case "right":
      return { x: rect.x + rect.w, y: rect.y + rect.h * fraction };
    case "top":
      return { x: rect.x + rect.w * fraction, y: rect.y };
    case "bottom":
      return { x: rect.x + rect.w * fraction, y: rect.y + rect.h };
  }
}

export function bezier(lane: Pick<Lane, "start" | "c1" | "c2" | "end">, t: number): Point {
  const u = 1 - t;
  const { start: p0, c1, c2, end: p3 } = lane;
  return {
    x: u * u * u * p0.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * p3.x,
    y: u * u * u * p0.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * p3.y,
  };
}

/** How far a lane stands off its card: a hair at the start, room for the arrow at the end. */
const START_GAP = 3;
const END_GAP = 9;
/** Two lanes of one bundle run this far apart. */
const LANE_SPLIT = 5;

export function layoutBundles(
  bridges: readonly { id: string; from: string; to: string; both?: boolean }[] = BRIDGES,
): Layout {
  const byPair = new Map<string, { a: NodeId; b: NodeId; bridges: string[]; lanes: Map<string, string[]> }>();
  const internal: Partial<Record<NodeId, string[]>> = {};

  for (const bridge of bridges) {
    const from = nodeOfTool(bridge.from);
    const to = nodeOfTool(bridge.to);
    if (from === to) {
      internal[from] = [...(internal[from] ?? []), bridge.id];
      continue;
    }
    const [a, b] = NODES.indexOf(from) < NODES.indexOf(to) ? [from, to] : [to, from];
    const key = `${a}~${b}`;
    const entry = byPair.get(key) ?? { a, b, bridges: [], lanes: new Map<string, string[]>() };
    entry.bridges.push(bridge.id);
    const ways = bridge.both ? [`${from}>${to}`, `${to}>${from}`] : [`${from}>${to}`];
    for (const way of ways) entry.lanes.set(way, [...(entry.lanes.get(way) ?? []), bridge.id]);
    byPair.set(key, entry);
  }

  // Which side of each card every bundle leaves from, then where along it:
  // ends on one side are spread out, in the order of where they are going,
  // so lines leave a card side by side instead of from one point.
  const ends = new Map<string, { bundle: string; other: Point }[]>();
  const sides = new Map<string, Side>();
  for (const [key, entry] of byPair) {
    for (const [self, other] of [
      [entry.a, entry.b],
      [entry.b, entry.a],
    ] as const) {
      const side = facing(nodeRect(self), nodeRect(other));
      sides.set(`${key}@${self}`, side);
      const slot = `${self}:${side}`;
      ends.set(slot, [...(ends.get(slot) ?? []), { bundle: key, other: centre(nodeRect(other)) }]);
    }
  }
  const fractionOf = new Map<string, number>();
  for (const [slot, list] of ends) {
    const side = slot.split(":")[1] as Side;
    const along = side === "left" || side === "right" ? (p: Point) => p.y : (p: Point) => p.x;
    list.sort((p, q) => along(p.other) - along(q.other));
    list.forEach((end, index) => {
      const self = slot.split(":")[0];
      fractionOf.set(`${end.bundle}@${self}`, 0.18 + (0.64 * (index + 1)) / (list.length + 1));
    });
  }

  const bundles: Bundle[] = [];
  for (const [key, entry] of byPair) {
    const lanes: Lane[] = [];
    const ways = [...entry.lanes.entries()];
    ways.forEach(([way, ids], index) => {
      const [from, to] = way.split(">") as [NodeId, NodeId];
      const offset = ways.length === 1 ? 0 : index === 0 ? -LANE_SPLIT : LANE_SPLIT;
      const anchor = (self: NodeId, gap: number) => {
        const side = sides.get(`${key}@${self}`)!;
        const rect = nodeRect(self);
        const base = pointOnSide(rect, side, fractionOf.get(`${key}@${self}`)!);
        const normal = NORMAL[side];
        // The split runs across the line, the same way at both ends, so the
        // two lanes stay parallel rather than crossing.
        const across = { x: Math.abs(normal.y), y: Math.abs(normal.x) };
        return {
          side,
          point: { x: round(base.x + normal.x * gap + across.x * offset), y: round(base.y + normal.y * gap + across.y * offset) },
        };
      };
      const start = anchor(from, START_GAP);
      const end = anchor(to, END_GAP);
      const distance = Math.hypot(end.point.x - start.point.x, end.point.y - start.point.y);
      // How far each end leaves its card before turning: generous when the
      // other card is far off in that direction, short when it is close, so
      // two cards near each other are joined by a gentle bend, not a loop.
      const reach = (from: Point, side: Side, to: Point) => {
        const ahead = (to.x - from.x) * NORMAL[side].x + (to.y - from.y) * NORMAL[side].y;
        return Math.min(170, Math.max(28, ahead * 0.55, distance * 0.22));
      };
      const out = reach(start.point, start.side, end.point);
      const back = reach(end.point, end.side, start.point);
      const c1 = { x: round(start.point.x + NORMAL[start.side].x * out), y: round(start.point.y + NORMAL[start.side].y * out) };
      const c2 = { x: round(end.point.x + NORMAL[end.side].x * back), y: round(end.point.y + NORMAL[end.side].y * back) };
      const lane = { start: start.point, c1, c2, end: end.point };
      let length = 0;
      let previous = lane.start;
      for (let step = 1; step <= 24; step += 1) {
        const next = bezier(lane, step / 24);
        length += Math.hypot(next.x - previous.x, next.y - previous.y);
        previous = next;
      }
      lanes.push({
        id: `${key}:${from}>${to}`,
        from,
        to,
        bridges: ids,
        d: `M ${start.point.x} ${start.point.y} C ${c1.x} ${c1.y} ${c2.x} ${c2.y} ${end.point.x} ${end.point.y}`,
        ...lane,
        length: round(length),
      });
    });
    const half = bezier(lanes[0]!, 0.5);
    const otherHalf = lanes[1] ? bezier(lanes[1], 0.5) : half;
    bundles.push({
      id: key,
      a: entry.a,
      b: entry.b,
      bridges: entry.bridges,
      lanes,
      middle: { x: round((half.x + otherHalf.x) / 2), y: round((half.y + otherHalf.y) / 2) },
    });
  }

  return { bundles, internal };
}

// -----------------------------------------------------------------------------
// Rolling statuses up
// -----------------------------------------------------------------------------

/** Worst first: the colour a card or a line takes when its bridges disagree. */
export const STATUS_RANK: readonly BridgeStatus[] = ["broken", "needs-key", "unknown", "to-build", "off", "not-checked", "parked", "working"];

export function worst(statuses: readonly BridgeStatus[]): BridgeStatus | null {
  return STATUS_RANK.find((status) => statuses.includes(status)) ?? null;
}
