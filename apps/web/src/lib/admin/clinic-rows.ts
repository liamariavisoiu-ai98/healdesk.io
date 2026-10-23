import type { ClinicCards, ClinicHealth, OpsClinics, OpsResult } from "@/lib/admin/ops-client";
import type { ChannelLevel, ClinicStripRow, Tone } from "@/lib/admin/strip-types";

/**
 * The rows of /admin/clinics, one per signed clinic, from two sources laid
 * over each other (E1 §2, steps 1 and 2):
 *
 *   - the reads the console already had (listClinics, listClinicCards,
 *     listClinicHealth) give the name, whether it is synthetic, the stage as
 *     far as the channel states say it, the channels, the blocker and, for a
 *     clinic under sixty days live, its usage;
 *   - the strip (`listClinicStrip`, lane A2, read through
 *     lib/admin/clinic-strip.ts) gives the rest: availability, calendar,
 *     voice agent, transcripts, the last reminder, usage for every clinic,
 *     and the stage with its day.
 *
 * A column the strip has not filled is `null` and is DRAWN AS "not measured
 * yet", never as a good or bad state: the strip's own types say so for
 * `availability` and `lastReminder`, and this file says it for the rest while
 * the strip is not read at all. Nothing here is a patient: names, ids,
 * enums, counts and dates.
 *
 * Pure: the page composes, the table draws, the test feeds fixtures.
 */

export type RowStage = {
  kind: "setup" | "live" | "paused" | "offboarding" | "closed";
  /** Setup only: the day of the thirty, or null when the strip has not said. */
  day: number | null;
  of: number | null;
  deadlineAt: string | null;
  /** The other kinds: since when, or null when not known. */
  since: string | null;
};

export type ClinicRow = {
  clinicId: string;
  name: string;
  specialty: string | null;
  synthetic: boolean;
  stage: RowStage | null;
  channels: { web: ChannelLevel; meta: ChannelLevel; voice: ChannelLevel } | null;
  availability: ClinicStripRow["availability"];
  calendar: ClinicStripRow["calendar"] | null;
  voice: ClinicStripRow["voice"] | null;
  transcripts: ClinicStripRow["transcripts"] | null;
  /** The worst meter's share, whole percent; `meter: null` with a percent means the reads did not say which. */
  usage: { percent: number | null; meter: "voice" | "web" | "meta" | "chat" | null } | null;
  lastReminder: ClinicStripRow["lastReminder"];
  blocking: string | null;
  /** A blocker below `blocked`, or a chip in a warning tone: the Attention filter. */
  attention: boolean;
};

export type ClinicFilter = "all" | "setup" | "live" | "paused" | "attention" | "synthetic";
export const CLINIC_FILTERS: readonly { id: ClinicFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "setup", label: "Setting up" },
  { id: "live", label: "Live" },
  { id: "paused", label: "Paused" },
  { id: "attention", label: "Attention" },
  { id: "synthetic", label: "Synthetic" },
];

export function clinicFilter(raw: string | string[] | undefined): ClinicFilter {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return CLINIC_FILTERS.some((f) => f.id === value) ? (value as ClinicFilter) : "all";
}

type CardChannel = ClinicCards["cards"][number]["channels"][number];

function levelOf(status: CardChannel["status"]): ChannelLevel {
  if (status === "live") return "live";
  if (status === "waiting" || status === "setting_up") return "waiting";
  return "off";
}

/** The stage the card's channel states can say, with no day: live, paused, or setting up. */
function stageFromCard(card: ClinicCards["cards"][number] | undefined, health: ClinicHealth | undefined): RowStage | null {
  if (health) return { kind: "live", day: null, of: null, deadlineAt: null, since: health.wentLiveOn };
  if (!card) return null;
  const bought = card.channels;
  if (bought.some((c) => c.status === "live")) return { kind: "live", day: null, of: null, deadlineAt: null, since: null };
  if (bought.length > 0 && bought.every((c) => c.status === "paused")) {
    return { kind: "paused", day: null, of: null, deadlineAt: null, since: null };
  }
  return { kind: "setup", day: null, of: null, deadlineAt: null, since: null };
}

function usageFromHealth(health: ClinicHealth | undefined): ClinicRow["usage"] {
  if (!health?.usage) return null;
  const meters: { percent: number; meter: "voice" | "chat" }[] = [];
  if (health.usage.voicePercent !== null) meters.push({ percent: health.usage.voicePercent, meter: "voice" });
  if (health.usage.chatPercent !== null) meters.push({ percent: health.usage.chatPercent, meter: "chat" });
  if (meters.length === 0) return { percent: null, meter: null };
  return meters.reduce((worst, m) => (m.percent > worst.percent ? m : worst));
}

function stageFromStrip(stage: ClinicStripRow["stage"]): RowStage {
  if (stage.kind === "setup") return { kind: "setup", day: stage.day, of: stage.of, deadlineAt: stage.deadlineAt, since: null };
  return { kind: stage.kind, day: null, of: null, deadlineAt: null, since: stage.since };
}

/**
 * The rows, from whichever of the reads answered. A read that failed costs
 * its columns, which print "not measured yet"; the page prints the failure
 * once above the table. The strip wins where both say something: it is the
 * purpose-built read.
 */
export function composeClinicRows(input: {
  clinics: OpsResult<OpsClinics>;
  cards: OpsResult<ClinicCards> | undefined;
  health: OpsResult<ClinicHealth[]> | undefined;
  strip: OpsResult<ClinicStripRow[]> | null | undefined;
}): ClinicRow[] {
  if (!input.clinics.ok) return [];
  const cards = new Map((input.cards?.ok ? input.cards.data.cards : []).map((c) => [c.id, c]));
  const health = new Map((input.health?.ok ? input.health.data : []).map((h) => [h.clinicId, h]));
  const strip = new Map((input.strip?.ok ? input.strip.data : []).map((s) => [s.clinicId, s]));

  return input.clinics.data.clinics.map((clinic) => {
    const card = cards.get(clinic.id);
    const seen = health.get(clinic.id);
    const s = strip.get(clinic.id);
    const blocked = clinic.blockers.find((b) => b.level === "blocked")?.message ?? null;
    const row: ClinicRow = {
      clinicId: clinic.id,
      name: s?.name ?? clinic.name,
      specialty: clinic.specialty || null,
      synthetic: s?.synthetic ?? clinic.dataClassification === "synthetic",
      stage: s ? stageFromStrip(s.stage) : stageFromCard(card, seen),
      channels: s?.channels ?? (card ? { web: "off", meta: "off", voice: "off", ...Object.fromEntries(card.channels.map((c) => [c.channel, levelOf(c.status)])) } : null),
      availability: s?.availability ?? null,
      calendar: s?.calendar ?? null,
      voice: s?.voice ?? null,
      transcripts: s?.transcripts ?? null,
      usage: s ? s.usage : usageFromHealth(seen),
      lastReminder: s?.lastReminder ?? null,
      blocking: s?.blocking ?? blocked,
      attention: false,
    };
    row.attention =
      row.blocking !== null ||
      clinic.blockers.some((b) => b.level === "attention") ||
      [availabilityChip(row.availability), calendarChip(row.calendar), voiceChip(row.voice), transcriptsChip(row.transcripts), usageChip(row.usage)].some(
        (chip) => chip.tone === "warn" || chip.tone === "bad",
      );
    return row;
  });
}

/** Synthetic clinics are hidden behind their own filter (owner, 23 October 2026). */
export function filterClinicRows(rows: ClinicRow[], filter: ClinicFilter): ClinicRow[] {
  if (filter === "synthetic") return rows.filter((r) => r.synthetic);
  const real = rows.filter((r) => !r.synthetic);
  switch (filter) {
    case "setup":
      return real.filter((r) => r.stage?.kind === "setup");
    case "live":
      return real.filter((r) => r.stage?.kind === "live");
    case "paused":
      return real.filter((r) => r.stage?.kind === "paused");
    case "attention":
      return real.filter((r) => r.attention);
    default:
      return real;
  }
}

// -----------------------------------------------------------------------------
// Each column as one chip: a tone and one or two words. Null is "not
// measured yet" in the muted tone, everywhere, so a column the strip has not
// filled can never read as good or bad.
// -----------------------------------------------------------------------------

export type ChipWords = { tone: Tone; words: string };

export const NOT_MEASURED: ChipWords = { tone: "muted", words: "not measured yet" };

export function stageChip(stage: RowStage | null): ChipWords {
  if (!stage) return NOT_MEASURED;
  switch (stage.kind) {
    case "setup":
      return { tone: "info", words: stage.day !== null ? `setup day ${stage.day}${stage.of !== null ? `/${stage.of}` : ""}` : "setting up" };
    case "live":
      return { tone: "ok", words: stage.since ? `live since ${stage.since.slice(0, 10)}` : "live" };
    case "paused":
      return { tone: "warn", words: "paused" };
    case "offboarding":
      return { tone: "warn", words: "offboarding" };
    case "closed":
      return { tone: "muted", words: "closed" };
  }
}

export function channelChip(level: ChannelLevel): Tone {
  return level === "live" ? "ok" : level === "waiting" ? "warn" : "muted";
}

export function availabilityChip(availability: ClinicRow["availability"]): ChipWords {
  if (!availability) return NOT_MEASURED;
  const changed = availability.changedAt !== null;
  switch (availability.audit) {
    case "pass":
      return { tone: "ok", words: changed ? "changed, audit ✓" : "unchanged" };
    case "warn":
      return { tone: "warn", words: "changed, audit ⚠" };
    case "fail":
      return { tone: "bad", words: "changed, audit ✗" };
    case "running":
      return { tone: "info", words: "audit running" };
    case "never":
      return changed ? { tone: "warn", words: "changed, not audited" } : { tone: "ok", words: "unchanged" };
  }
}

export function calendarChip(calendar: ClinicRow["calendar"]): ChipWords {
  if (!calendar) return NOT_MEASURED;
  switch (calendar) {
    case "healthy":
      return { tone: "ok", words: "healthy" };
    case "degraded":
      return { tone: "warn", words: "degraded" };
    case "broken":
      return { tone: "bad", words: "broken" };
    case "none":
      return { tone: "muted", words: "none" };
  }
}

export function voiceChip(voice: ClinicRow["voice"]): ChipWords {
  if (!voice) return NOT_MEASURED;
  switch (voice) {
    case "ok":
      return { tone: "ok", words: "ok" };
    case "drift":
      return { tone: "warn", words: "drift" };
    case "failed":
      return { tone: "bad", words: "failed" };
    case "not_provisioned":
      return { tone: "muted", words: "not provisioned" };
  }
}

export function transcriptsChip(transcripts: ClinicRow["transcripts"]): ChipWords {
  if (!transcripts) return NOT_MEASURED;
  if (transcripts.bounced > 0) return { tone: "bad", words: `${transcripts.bounced} bounced` + (transcripts.waiting > 0 ? `, ${transcripts.waiting} waiting` : "") };
  if (transcripts.waiting > 0) return { tone: "warn", words: `${transcripts.waiting} waiting` };
  return { tone: "ok", words: "none waiting" };
}

export function usageChip(usage: ClinicRow["usage"]): ChipWords {
  if (!usage) return NOT_MEASURED;
  if (usage.percent === null) return { tone: "muted", words: "no meter" };
  const which = usage.meter ? ` ${usage.meter}` : "";
  if (usage.percent >= 100) return { tone: "bad", words: `${usage.percent}%${which}` };
  if (usage.percent >= 90) return { tone: "warn", words: `${usage.percent}%${which}` };
  return { tone: "ok", words: `${usage.percent}%${which}` };
}

export function reminderChip(lastReminder: ClinicRow["lastReminder"]): ChipWords {
  if (!lastReminder) return NOT_MEASURED;
  if (lastReminder.day === null) return { tone: "muted", words: "none" };
  return { tone: "info", words: `day ${lastReminder.day}` };
}
