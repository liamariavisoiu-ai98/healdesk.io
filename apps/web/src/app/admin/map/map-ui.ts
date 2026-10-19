import type { BridgeStatus, BridgeView, KeyState, RotationState, Theme } from "@/lib/admin/system-map";

import type { AnyIcon } from "./icons";

/**
 * The map's visual vocabulary, in one place: one colour per status, told
 * apart by a symbol as well as a hue (so the map reads in greyscale and for
 * colour-blind eyes), the words for each, and which bridges a lens keeps lit.
 */

export type StatusStyle = {
  /** The line and the dot. */
  stroke: string;
  /** A soft fill behind a pill or a tile. */
  tint: string;
  /** Text on the tint. */
  ink: string;
  /** Dashes for statuses that are not live, so colour is never the only cue. */
  dash?: string;
  icon: AnyIcon;
};

export const STATUS_STYLE: Record<BridgeStatus, StatusStyle> = {
  working: { stroke: "#1f9d5c", tint: "#e4f5ea", ink: "#125f37", icon: "check" },
  "needs-key": { stroke: "#d4860b", tint: "#fff2d9", ink: "#7a4b00", icon: "key" },
  off: { stroke: "#3f7fc6", tint: "#e3eefb", ink: "#1f4f86", dash: "7 6", icon: "pause" },
  broken: { stroke: "#dc2626", tint: "#fde4e4", ink: "#9b1213", icon: "alert" },
  unknown: { stroke: "#94a3b3", tint: "#eef1f5", ink: "#475569", dash: "2 6", icon: "question" },
  "to-build": { stroke: "#8b6fd6", tint: "#efeafc", ink: "#4b3a8a", dash: "3 7", icon: "wrench" },
  parked: { stroke: "#b8c1cc", tint: "#f2f4f7", ink: "#5b6878", dash: "1 7", icon: "dot" },
  "not-checked": { stroke: "#64748b", tint: "#eef1f5", ink: "#475569", dash: "6 5", icon: "question" },
};

/** What each colour means, in the owner's words. */
export const STATUS_MEANING: Record<BridgeStatus, string> = {
  working: "Every key it needs is in place (or, if it says so, all but an optional one). A tick means it was tested live as the page loaded.",
  "needs-key": "Built and ready: it is waiting for you to add a key.",
  off: "Built, and switched off: on purpose until something else is done first, or an optional key not added.",
  broken: "A live check failed, or two copies of a key disagree. Fix these first.",
  unknown: "Lives on the AWS host, which did not answer (usually standby) or runs a version too old to say.",
  "to-build": "Not built yet, or only half built.",
  parked: "Phase two: kept in the code, fenced out of v1.",
  "not-checked": "Its keys live where this page cannot look: your computer, GitHub, or AWS's one-off jobs.",
};

export const LEGEND_ORDER: readonly BridgeStatus[] = ["working", "needs-key", "broken", "off", "to-build", "unknown", "not-checked", "parked"];

export const KEY_STATE: Record<KeyState, { word: string; tint: string; ink: string }> = {
  "in-place": { word: "In place", tint: "#e4f5ea", ink: "#125f37" },
  missing: { word: "Missing", tint: "#fff2d9", ink: "#7a4b00" },
  waiting: { word: "Waiting on purpose", tint: "#e3eefb", ink: "#1f4f86" },
  "optional-off": { word: "Optional, not added", tint: "#f2f4f7", ink: "#475569" },
  unknown: { word: "Can't check now", tint: "#eef1f5", ink: "#475569" },
  broken: { word: "Not working", tint: "#fde4e4", ink: "#9b1213" },
  "not-checked": { word: "Not checked here", tint: "#eef1f5", ink: "#475569" },
  "per-clinic": { word: "One per clinic", tint: "#efeafc", ink: "#4b3a8a" },
};

export const ROTATION_STATE: Record<RotationState, { word: string; tint: string; ink: string } | null> = {
  ok: { word: "Rotation up to date", tint: "#e4f5ea", ink: "#125f37" },
  "due-soon": { word: "Rotate soon", tint: "#fff2d9", ink: "#7a4b00" },
  overdue: { word: "Rotation overdue", tint: "#fde4e4", ink: "#9b1213" },
  unrecorded: { word: "No rotation recorded", tint: "#f2f4f7", ink: "#475569" },
  never: { word: "Never rotate", tint: "#fde4e4", ink: "#9b1213" },
  "only-if": { word: "Rotate only if needed", tint: "#f2f4f7", ink: "#475569" },
  public: null,
  "not-yet": null,
};

/** What the map can be narrowed to. */
export type Lens = "all" | Theme | "attention";

export const LENSES: readonly { id: Lens; label: string }[] = [
  { id: "all", label: "Everything" },
  { id: "serving", label: "Serving patients" },
  { id: "selling", label: "Selling healdesk" },
  { id: "running", label: "Running the business" },
  { id: "attention", label: "Needs attention" },
];

const ATTENTION: ReadonlySet<BridgeStatus> = new Set(["broken", "needs-key", "to-build", "unknown"]);

export function inLens(bridge: BridgeView, lens: Lens, status: BridgeStatus | null): boolean {
  if (status && bridge.status !== status) return false;
  if (lens === "all") return true;
  if (lens === "attention") return ATTENTION.has(bridge.status);
  return bridge.theme === lens;
}

/** Steady speed for the moving dots, in stage units per second: calm, never busy. */
export const FLOW_SPEED = 46;
