import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";

import { unsafeDb } from "@/db";
import {
  clinicChangeEvents,
  scheduledJobs,
  type ClinicChangeActor,
  type ClinicChangeKind,
  type ClinicChangeSource,
  type ClinicChangeSummary,
} from "@/db/schema";
import type { ActorContext } from "@/lib/audit";
import { describeError, log } from "@/lib/log";
import { notifyOpsOrThrow, raiseOpsAlertKeyed } from "@/lib/ops/notify";
import { withTenant, type TenantTx } from "@/lib/tenant";

import { clinicLocalDate } from "./closures";
import { DAY_KEYS, parseOpeningHours, type OpeningHours } from "./opening-hours";
import { SETTING_ENTRIES, SETTING_VALUE_WORDS } from "./setting-words";

/**
 * A clinic's changes to when and with whom AYA books, for ops (ops
 * automation design E4, 23 October 2026): its weekly hours, its closed days,
 * a location's hours, its named providers and their services.
 *
 * Each writer records its change here, in the save's own transaction
 * (`recordClinicChange`), so a save that is refused or rolls back leaves
 * nothing behind. A change made any other way (an ops change file through
 * db-apply, an edit in psql) is recorded by the database's own trigger as a
 * count-only `direct` row (drizzle/0114), which no setting turns off.
 *
 * Ops hears of each change once, after it committed, from the minute sweep
 * (`runClinicChangeAlerts`): clinic_availability_changed, through notifyOps,
 * one alert per clinic and kind an hour, so six closed days added in an
 * evening are one email and one Slack post. The alert carries the clinic's
 * id and name, the kind and counts; never a date, a label, a name or a
 * calendar. The audit of a change (lib/audits) runs two minutes after the
 * clinic's last one, and only while the `clinic-audits` job is switched on.
 *
 * A clinic's Settings changes are recorded here too, as kind `setting`
 * (./setting-changes.ts; owner, 28 October 2026), and each is told to ops on
 * its own, by email and in Slack, keyed on its row: the clinic, the switch,
 * before and after as closed words, and who.
 *
 * Business data about the practice, never a patient.
 */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_DATES = 60;

/** The audits' job: a change waits for one only while it is on. */
export const JOB_CLINIC_AUDITS = "clinic-audits";

export type ClinicChangeInput = {
  kind: ClinicChangeKind;
  source: ClinicChangeSource;
  /** Who, coarsely: never the device's own label, which staff typed. */
  actor: ClinicChangeActor;
  /** The location whose hours changed; omitted for the main location. */
  locationId?: string | null;
  summary: ClinicChangeSummary;
};

/** Who saved a change, for the writers that take it from their caller. */
export type ChangeOrigin = { source: ClinicChangeSource; actor: ClinicChangeActor };

/** lib/portal/actor.ts SIGN_IN_ACTOR_LABEL: the label a session with no passkey device acts under. */
const SIGN_IN_LABEL = "the clinic's sign-in";

/**
 * The service a support action acts as (lane D's support drafter, carrying
 * out a clinic's emailed request): recorded as source support_action, actor
 * support.
 */
export const SUPPORT_ACTION_SERVICE = "support-action";

/** A signed-in person's change: from one of the clinic's devices, or from its sign-in alone. */
export function clinicActorOf(label: string | null | undefined): ClinicChangeActor {
  return !label || label === SIGN_IN_LABEL ? "clinic_signin" : "clinic_device";
}

/**
 * Who saved a change, from the actor of its transaction, for a writer whose
 * caller does not say: a person signed in to the clinic is the portal, with
 * their device's label; the ops console acts as a service named by the
 * operator's address and is recorded as `ops`; anything else is the portal's.
 */
export function changeOriginOf(actor: ActorContext | undefined): ChangeOrigin {
  if (actor?.type === "user") return { source: "portal", actor: clinicActorOf(actor.label) };
  if (actor?.type === "service" && actor.serviceName === SUPPORT_ACTION_SERVICE) {
    return { source: "support_action", actor: "support" };
  }
  if (actor?.type === "service" && actor.serviceName.includes("@")) {
    return { source: "ops_console", actor: "ops" };
  }
  return { source: "portal", actor: "clinic_signin" };
}

/**
 * Weekly hours in one spelling, whatever order the days or keys were stored
 * in, or null when they do not parse: two saves of the same hours compare
 * equal, so an unchanged save records nothing.
 */
export function canonicalHours(raw: unknown): string | null {
  let parsed: OpeningHours;
  try {
    parsed = parseOpeningHours(raw);
  } catch {
    return null;
  }
  return JSON.stringify(DAY_KEYS.map((day) => [day, parsed[day] ?? []]));
}

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function dates(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return [...new Set(value.filter((d): d is string => typeof d === "string" && ISO_DATE.test(d)))]
    .sort()
    .slice(0, MAX_DATES);
}

/** Only the summary's own keys, each of its own shape: counts, dates and a flag. */
export function cleanSummary(summary: ClinicChangeSummary): ClinicChangeSummary {
  const out: ClinicChangeSummary = {};
  if (typeof summary.weeklyChanged === "boolean") out.weeklyChanged = summary.weeklyChanged;
  const added = dates(summary.closuresAdded);
  if (added) out.closuresAdded = added;
  const removed = dates(summary.closuresRemoved);
  if (removed) out.closuresRemoved = removed;
  for (const key of ["closuresUpcoming", "providersActive", "servicesMapped", "holdsReleased", "rows"] as const) {
    const n = count(summary[key]);
    if (n !== undefined) out[key] = n;
  }
  // A setting change: its key on the closed list, and its value tokens only
  // as a pair, each on the closed list too (./setting-words.ts).
  if (typeof summary.setting === "string" && Object.hasOwn(SETTING_ENTRIES, summary.setting)) {
    out.setting = summary.setting;
    const { before, after } = summary;
    if (
      typeof before === "string" &&
      typeof after === "string" &&
      Object.hasOwn(SETTING_VALUE_WORDS, before) &&
      Object.hasOwn(SETTING_VALUE_WORDS, after)
    ) {
      out.before = before;
      out.after = after;
    }
  }
  return out;
}

/**
 * Record a change in the caller's transaction. The change waits for its
 * audit only while the audits are switched on. Returns the row's id.
 */
export async function recordClinicChange(
  tx: TenantTx,
  input: ClinicChangeInput,
  now: Date = new Date(),
): Promise<string> {
  const [job] = await tx.db
    .select({ enabled: scheduledJobs.enabled })
    .from(scheduledJobs)
    .where(eq(scheduledJobs.name, JOB_CLINIC_AUDITS))
    .limit(1);
  const [row] = await tx.db
    .insert(clinicChangeEvents)
    .values({
      clinicId: tx.clinicId,
      locationId: input.locationId ?? null,
      kind: input.kind,
      source: input.source,
      actorKind: input.actor,
      summary: cleanSummary(input.summary),
      changedAt: now,
      auditStatus: job?.enabled && input.kind !== "setting" ? "queued" : null,
    })
    .returning({ id: clinicChangeEvents.id });
  return row!.id;
}

// -----------------------------------------------------------------------------
// What the clinic sees: one status line under the card it changed
// -----------------------------------------------------------------------------

export type ChangeStatus = { changedAt: Date };

/** The newest change of these kinds. Null when there is none. */
export async function latestChangeStatus(
  tx: TenantTx,
  kinds: readonly ClinicChangeKind[],
): Promise<ChangeStatus | null> {
  const [row] = await tx.db
    .select({ changedAt: clinicChangeEvents.changedAt })
    .from(clinicChangeEvents)
    .where(and(eq(clinicChangeEvents.clinicId, tx.clinicId), inArray(clinicChangeEvents.kind, [...kinds])))
    .orderBy(desc(clinicChangeEvents.changedAt))
    .limit(1);
  return row ? { changedAt: row.changedAt } : null;
}

/**
 * The clinic's status line (design E4 §3.D): "In use since 2:14 pm.", from
 * the change's own time (the day instead of the time when it was not today,
 * in the clinic's zone). A change is in use the moment it is saved. Nothing
 * here depends on ops' audit, which tells the clinic nothing (owner's
 * decision). Null with no change.
 */
export function changeStatusLine(
  status: ChangeStatus | null,
  timeZone: string,
  now: Date = new Date(),
): string | null {
  if (!status) return null;
  let when: string;
  try {
    if (clinicLocalDate(status.changedAt, timeZone) === clinicLocalDate(now, timeZone)) {
      when = new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit" })
        .format(status.changedAt)
        .replace(/\s?AM$/, " am")
        .replace(/\s?PM$/, " pm");
    } else {
      when = new Intl.DateTimeFormat("en-GB", { timeZone, day: "numeric", month: "short" }).format(
        status.changedAt,
      );
    }
  } catch {
    return null;
  }
  return `In use since ${when}.`;
}

// -----------------------------------------------------------------------------
// Ops hears of it: the minute sweep
// -----------------------------------------------------------------------------

const ALERT_ACTOR = { type: "service", serviceName: "clinic-changes" } as const;

/** Per clinic with work: changes waiting for their alert, and for their audit (app_clinic_change_work). */
export type ClinicChangeWork = {
  clinicId: string;
  unalerted: number;
  queued: number;
  lastQueuedAt: Date | null;
};

export async function clinicChangeWork(): Promise<ClinicChangeWork[]> {
  const result = await unsafeDb.execute<{
    clinic_id: string;
    unalerted: number;
    queued: number;
    last_queued_at: Date | string | null;
  }>(sql`select clinic_id, unalerted, queued, last_queued_at from app_clinic_change_work()`);
  return result.rows.map((row) => ({
    clinicId: String(row.clinic_id),
    unalerted: Number(row.unalerted),
    queued: Number(row.queued),
    lastQueuedAt: row.last_queued_at === null ? null : new Date(row.last_queued_at),
  }));
}

/** The alert's fields for one clinic and kind: ids and counts under lib/log.ts's keys. */
export function changeAlertFields(
  clinicId: string,
  kind: ClinicChangeKind,
  rows: readonly { summary: ClinicChangeSummary }[],
): Record<string, string | number> {
  const fields: Record<string, string | number> = { clinicId, section: kind, count: rows.length };
  if (kind === "closures") {
    // `written`: closed days added; `deleted`: closed days taken off. Both
    // counted across the changes, never the dates themselves, and each sent
    // only when above 0, so a removal-only change never reads "It added 0
    // closed days" (lane N3).
    const written = rows.reduce((n, r) => n + (r.summary.closuresAdded?.length ?? 0), 0);
    const deleted = rows.reduce((n, r) => n + (r.summary.closuresRemoved?.length ?? 0), 0);
    if (written > 0) fields.written = written;
    if (deleted > 0) fields.deleted = deleted;
  }
  return fields;
}

/**
 * Raise clinic_availability_changed for every change not yet told, one
 * alert per clinic and kind, then mark those changes told (alerted_at). The
 * alert is recorded first and the rows marked after, so a sweep that stops
 * between the two tells ops again next minute, where notifyOps' one-hour
 * dedupe folds it into the first; one that cannot record the alert leaves
 * the rows for the next sweep. Not a switched job: it only tells ops. Never
 * throws for one clinic; returns how many alerts it raised.
 */
export async function runClinicChangeAlerts(now: Date = new Date()): Promise<{ alerts: number; failures: number }> {
  let alerts = 0;
  let failures = 0;
  const work = (await clinicChangeWork()).filter((w) => w.unalerted > 0);
  for (const { clinicId } of work) {
    try {
      const waiting = await withTenant({ clinicId, actor: ALERT_ACTOR }, (tx) =>
        tx.db
          .select({
            id: clinicChangeEvents.id,
            kind: clinicChangeEvents.kind,
            actorKind: clinicChangeEvents.actorKind,
            summary: clinicChangeEvents.summary,
          })
          .from(clinicChangeEvents)
          .where(and(eq(clinicChangeEvents.clinicId, tx.clinicId), isNull(clinicChangeEvents.alertedAt))),
      );
      const byKind = new Map<ClinicChangeKind, { id: string; summary: ClinicChangeSummary }[]>();
      for (const row of waiting) {
        if (row.kind === "setting") {
          // One alert per settings change, never folded: keyed on the row, so
          // a sweep that stops before marking it raises nothing twice.
          const alertId = await raiseOpsAlertKeyed(
            "clinic_availability_changed",
            settingAlertFields(clinicId, row.actorKind, row.summary),
            { key: `setting_change:${row.id}`, email: true },
          );
          if (!alertId) {
            failures += 1;
            continue;
          }
          alerts += 1;
          await markAlerted(clinicId, [row.id], now);
          continue;
        }
        byKind.set(row.kind, [...(byKind.get(row.kind) ?? []), row]);
      }
      for (const [kind, rows] of byKind) {
        await notifyOpsOrThrow("clinic_availability_changed", changeAlertFields(clinicId, kind, rows));
        alerts += 1;
        await markAlerted(
          clinicId,
          rows.map((r) => r.id),
          now,
        );
      }
    } catch (error) {
      failures += 1;
      log.warn("clinic change alerts not raised", { clinicId, error: describeError(error) });
    }
  }
  return { alerts, failures };
}

/** Mark these changes told. */
async function markAlerted(clinicId: string, ids: readonly string[], now: Date): Promise<void> {
  await withTenant({ clinicId, actor: ALERT_ACTOR }, (tx) =>
    tx.db
      .update(clinicChangeEvents)
      .set({ alertedAt: now })
      .where(
        and(
          eq(clinicChangeEvents.clinicId, tx.clinicId),
          inArray(clinicChangeEvents.id, [...ids]),
          isNull(clinicChangeEvents.alertedAt),
        ),
      ),
  );
}

/**
 * A settings change's alert fields: the clinic's id, `section` setting, the
 * switch's key, its closed tokens before and after when it has them, and who
 * made it, coarsely. Every value is a closed word (lib/ops/alert-wording/
 * words.ts), so the email and the Slack copy print it and nothing else.
 */
export function settingAlertFields(
  clinicId: string,
  actorKind: ClinicChangeActor,
  summary: ClinicChangeSummary,
): Record<string, string> {
  const clean = cleanSummary(summary);
  return {
    clinicId,
    section: "setting",
    ...(clean.setting ? { setting: clean.setting } : {}),
    ...(clean.before && clean.after ? { before: clean.before, after: clean.after } : {}),
    actor: actorKind,
  };
}

/**
 * The status line for the newest change of these kinds, read in its own
 * transaction: for a card that shows one (Knowledge's Hours card, Settings'
 * Booking detail). Null when there is no change, or the line could not be
 * read: a courtesy, never a reason a page fails.
 */
export async function readChangeStatusLine(
  clinicId: string,
  actor: ActorContext,
  kinds: readonly ClinicChangeKind[],
  timeZone: string,
  now: Date = new Date(),
): Promise<string | null> {
  try {
    const status = await withTenant({ clinicId, actor }, (tx) => latestChangeStatus(tx, kinds));
    return changeStatusLine(status, timeZone, now);
  } catch (error) {
    log.warn("change status line not read", { clinicId, error: describeError(error) });
    return null;
  }
}
