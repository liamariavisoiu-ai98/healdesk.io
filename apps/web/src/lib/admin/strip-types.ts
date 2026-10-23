/**
 * The two read shapes the redone admin is built on (ops automation, Phase 2).
 *
 * `listClinicStrip` fills the Clinics table: one row per clinic, ids, enums, counts and dates only. `opsInbox`
 * fills Home: one row per thing that needs the operator today. apps/app builds both (apps/app/src/lib/ops/strip.ts
 * and inbox.ts mirror these types by hand, as the rest of the ops envelope does) and apps/web only draws them, so
 * a screen can be built from fixtures before the operation exists.
 *
 * A field that a later lane fills is `null` until then, and the screen must draw `null` as "not measured yet",
 * never as a good or bad state:
 *   - `availability` is filled by the audits lane (clinic_audits, clinic_change_events);
 *   - `lastReminder` is filled by the lifecycle lane (lifecycle_waves).
 *
 * Types only: this file is imported by client components, so it must stay free of values and server imports.
 */

/** Five tones, one meaning each. Red (`bad`) is for blocking only. */
export type Tone = "ok" | "warn" | "bad" | "info" | "muted";

export type ChannelLevel = "live" | "waiting" | "off";

export type ClinicStage =
  | { kind: "setup"; day: number; of: number; deadlineAt: string | null }
  | { kind: "live"; since: string }
  | { kind: "paused"; since: string | null }
  | { kind: "offboarding"; since: string | null }
  | { kind: "closed"; since: string | null };

export type AuditLevel = "pass" | "warn" | "fail" | "running" | "never";

export interface ClinicStripRow {
  clinicId: string;
  /** The clinic's own name: business data, shown in admin and allowed in Slack and ops mail. */
  name: string;
  synthetic: boolean;
  stage: ClinicStage;
  channels: { web: ChannelLevel; meta: ChannelLevel; voice: ChannelLevel };
  /** null = the audits lane has not landed or nothing was measured. */
  availability: {
    changedAt: string | null;
    audit: AuditLevel;
  } | null;
  calendar: "healthy" | "degraded" | "broken" | "none";
  voice: "ok" | "drift" | "failed" | "not_provisioned";
  /** Last 30 days: copies still waiting and copies that bounced. Counts only. */
  transcripts: { waiting: number; bounced: number };
  /** The worst meter's share of what the plan includes, whole percent; null when no meter applies. */
  usage: { percent: number | null; meter: "voice" | "web" | "meta" | null };
  /** null = the lifecycle lane has not landed. `day` is the setup-window day of the last reminder, or null. */
  lastReminder: { day: number | null } | null;
  /** The first blocker's message, already worded for the operator; null when nothing blocks. */
  blocking: string | null;
}

export type InboxButton =
  | { label: string; kind: "link"; href: string }
  /** A typed ops operation the screen calls; `args` are ids and enums only. */
  | { label: string; kind: "op"; op: string; args: Record<string, string | number | boolean> };

export interface InboxRow {
  /** Stable per source+subject, so a row keeps its place and its anchor between reads. */
  id: string;
  /** Closed list owned by apps/app (`INBOX_KINDS`); the screen switches on it only for the icon-less tone. */
  kind: string;
  count: number;
  /** One sentence for the operator. No repetition of the clinic's name, no prose about the product. */
  sentence: string;
  clinic: { id: string; name: string } | null;
  button: InboxButton;
  tone: Tone;
  /** Ordering: earliest deadline first, then tone severity. ISO or null. */
  dueAt: string | null;
}

export interface OpsInbox {
  rows: InboxRow[];
  /** When the read ran (ISO). The empty state prints it: "Nothing needs you. Last checked 09:12." */
  checkedAt: string;
  /** Sources that could not be read. The screen prints "Could not read X" for each, never a zero. */
  unreadable: { source: string; reason: string }[];
}
