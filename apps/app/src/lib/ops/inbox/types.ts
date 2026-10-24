import type { ActorContext, RequestContext } from "@/lib/audit";

import type { Operator } from "../api";

/**
 * `opsInbox`: the redone admin's Home, one row per thing that needs the
 * operator today (ops automation Phase 2, design E1 §2 "Home", lane A2).
 *
 * The shape is apps/web's `lib/admin/strip-types.ts`, mirrored here by hand
 * as the rest of the ops envelope is. Ids, enums, counts, dates, the
 * clinic's own name and a sentence written here, never anything a clinic or
 * a patient typed.
 */

export type Tone = "ok" | "warn" | "bad" | "info" | "muted";

export type InboxButton =
  | { label: string; kind: "link"; href: string }
  | { label: string; kind: "op"; op: string; args: Record<string, string | number | boolean> };

export interface InboxRow {
  id: string;
  kind: InboxKind;
  count: number;
  sentence: string;
  clinic: { id: string; name: string } | null;
  button: InboxButton;
  tone: Tone;
  dueAt: string | null;
}

export interface OpsInbox {
  rows: InboxRow[];
  checkedAt: string;
  unreadable: { source: string; reason: string }[];
}

/**
 * Every row kind, closed. A source that adds a kind adds it here, in the
 * same commit as its file and its line in sources.ts.
 */
export const INBOX_KINDS = [
  "ops_alert",
  "queue",
  "health_flag",
  "practice_review",
  "support_reply",
  "recording_alert",
  "site_read",
  "availability",
  "decision",
] as const;

export type InboxKind = (typeof INBOX_KINDS)[number];

/** What every source is handed: one clock, the operator, and the clinic names read once. */
export type InboxContext = {
  now: Date;
  operator: Operator;
  actor: ActorContext;
  request: RequestContext;
  /** Clinic id → the clinic's own name, from app_clinics_overview(), read at most once per run. */
  clinicNames(): Promise<ReadonlyMap<string, string>>;
};

/**
 * What a source read. `partial` names what it could not read while still
 * returning the rest (a clinic whose tenant read failed, say): the runner
 * reports it in `unreadable` beside the rows, never as a zero.
 */
export type InboxSourceResult = { rows: InboxRow[]; partial?: string };

/**
 * One source of rows. Throwing is allowed and expected: the runner catches
 * per source, logs it and reports the source in `unreadable`.
 */
export type InboxSource = {
  /** Stable, short, operator-readable: "Could not read <name>". */
  name: string;
  read(ctx: InboxContext): Promise<InboxSourceResult>;
};
