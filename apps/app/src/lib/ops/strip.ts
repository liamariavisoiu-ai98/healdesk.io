import { getPlan, SETUP_REMINDER_EVERY_DAYS, type Channel } from "@healdesk/catalog";
import { GOOGLE_CALENDAR_PROVIDER } from "@healdesk/connectors";
import { and, eq, gte, sql } from "drizzle-orm";

import {
  clinicChannels,
  clinics,
  clinicSettings,
  providerConnections,
  transcriptEmails,
  voiceAgents,
  type Entitlements,
} from "@/db/schema";
import { getEntitlements } from "@/lib/billing/entitlements";
import { usageSnapshot } from "@/lib/billing/usage";
import { isPaused, channelStatus } from "@/lib/channels/state";
import { clinicLocalDate } from "@/lib/clinic/closures";
import { setupWindowStart } from "@/lib/clinic/setup-window";
import { describeError, log } from "@/lib/log";
import { withTenant, type TenantTx } from "@/lib/tenant";

import { ok, opsProblem, type OpsOutcome } from "./api";
import { auditOverall, clinicAuditsOn, readClinicAuditFacts, type AuditOverall } from "./audit-ops";
import { blockersFor, listClinics, type ClinicOverview } from "./clinics";

/**
 * `listClinicStrip`: the redone admin's Clinics table, one row per clinic in
 * one envelope (ops automation Phase 2, design E1 §2, lane A2).
 *
 * The shape is apps/web's `lib/admin/strip-types.ts`, mirrored here by hand
 * as the rest of the ops envelope is: ids, enums, counts and dates, and the
 * clinic's own name. Nothing a clinic typed, no patient field, no vendor
 * call. `availability` and `lastReminder` read the audits lane's and the
 * lifecycle lane's tables (lane A4, wave 2).
 *
 * How it reads. The clinic list comes from app_clinics_overview(), one
 * statement across tenants. Everything else is a tenant table under forced
 * row-level security, so each clinic is read in its own transaction
 * (withTenant), as listClinicHealth, the digest and voiceAgentStatus read
 * theirs. There is no cross-tenant definer for these columns, and adding one
 * is a migration this lane may not make, so the read is one transaction per
 * clinic, each a FIXED seven statements (STRIP_STATEMENTS_PER_CLINIC):
 *
 *   1. the clinic's row joined to its settings (the pause), its voice agent
 *      and its Google Calendar connection, with app_clinic_is_demo();
 *   2. its entitlements row (getEntitlements, the one the usage emails read);
 *   3. its clinic_channels rows;
 *   4. its transcript outbox counted by status over the last 30 days;
 *   5, 6. its audit facts (readClinicAuditFacts, the two statements the
 *      console's audits card reads): each pack's newest result, and its
 *      newest change with whether one still waits for an audit;
 *   7. whether the lifecycle watch has a row for it, and its newest numbered
 *      setup reminder in the ledger (lifecycle_waves).
 *
 * Plus one statement for the whole read: whether the clinic-audits job is
 * on (clinicAuditsOn). So the statement count is linear in clinics with a
 * constant slope, never a per-row fan-out inside a clinic
 * (tests/ops-strip.test.ts counts them).
 */

// --- The contract, mirrored from apps/web/src/lib/admin/strip-types.ts ---

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
  name: string;
  synthetic: boolean;
  stage: ClinicStage;
  channels: { web: ChannelLevel; meta: ChannelLevel; voice: ChannelLevel };
  availability: { changedAt: string | null; audit: AuditLevel } | null;
  calendar: "healthy" | "degraded" | "broken" | "none";
  voice: "ok" | "drift" | "failed" | "not_provisioned";
  transcripts: { waiting: number; bounced: number };
  usage: { percent: number | null; meter: "voice" | "web" | "meta" | null };
  lastReminder: { day: number | null } | null;
  blocking: string | null;
}

// --- Reading ---

/** The setup window's length, as the strip prints it ("day n of 30"). */
export const SETUP_WINDOW_OF = 30;

/** How far back the transcript counts look. */
export const STRIP_TRANSCRIPT_DAYS = 30;

/** Statements each clinic's transaction runs, besides BEGIN, set_config and COMMIT. */
export const STRIP_STATEMENTS_PER_CLINIC = 7;

const DAY_MS = 24 * 60 * 60 * 1000;
const ACTOR = { type: "service", serviceName: "ops-strip" } as const;

/**
 * The contract's two counts (lib/admin/strip-types.ts): `waiting` is a copy
 * held and not yet delivered (pending, sent); `bounced` is a copy that did not
 * arrive (bounced, unconfirmed after 72 hours, expired after 30 days). An
 * `open` row is a web chat still in progress, and is neither.
 */
const WAITING_STATUSES: ReadonlySet<string> = new Set(["pending", "sent"]);
const BOUNCED_STATUSES: ReadonlySet<string> = new Set(["bounced", "unconfirmed", "expired"]);

/** What one clinic's tenant transaction reads. Exported for the pure tests. */
export type StripFacts = {
  accountClosedAt: Date | null;
  pausedAt: Date | null;
  pausedUntil: Date | null;
  demo: boolean;
  voiceStatus: string | null;
  voiceDriftFlaggedAt: Date | null;
  calendarStatus: string | null;
  calendarBrokenAt: Date | null;
  entitlements: Entitlements | null;
  channels: {
    channel: Channel;
    enabled: boolean;
    readyAt: Date | null;
    liveAt: Date | null;
  }[];
  transcripts: { waiting: number; bounced: number };
  /** The newest availability change and the audits' overall state (the console's rule, auditOverall). */
  audit: { changedAt: Date | null; overall: AuditOverall };
  /** Whether the lifecycle watch has a row for the clinic, and its newest numbered reminder's number. */
  lifecycle: { watched: boolean; reminder: number | null };
};

/** Every clinic's strip row, newest clinic first. Throws when a clinic cannot be read. */
export async function listClinicStrip(now: Date = new Date()): Promise<ClinicStripRow[]> {
  const overviews = await listClinics();
  const auditsOn = await clinicAuditsOn();
  const facts = new Map<string, StripFacts>();
  for (const clinic of overviews) {
    facts.set(
      clinic.id,
      await withTenant({ clinicId: clinic.id, actor: ACTOR }, (tx) => readStripFacts(tx, now, auditsOn)),
    );
  }
  const rows: ClinicStripRow[] = [];
  for (const clinic of overviews) {
    const own = facts.get(clinic.id)!;
    // A location has no entitlements row of its own: its billing state is
    // its billing clinic's row (lib/billing/billing-clinic.ts), so its stage
    // reads that one. Its usage counts against that clinic's pooled
    // allowance and is shown once, on that clinic's row.
    const billing =
      own.entitlements ??
      (clinic.billingClinicId && clinic.billingClinicId !== clinic.id
        ? (facts.get(clinic.billingClinicId)?.entitlements ?? null)
        : null);
    rows.push(stripRow(clinic, own, now, billing));
  }
  return rows.sort(
    (a, b) =>
      createdAtOf(overviews, b.clinicId) - createdAtOf(overviews, a.clinicId) ||
      a.clinicId.localeCompare(b.clinicId),
  );
}

function createdAtOf(overviews: ClinicOverview[], clinicId: string): number {
  return overviews.find((c) => c.id === clinicId)?.createdAt.getTime() ?? 0;
}

/** The seven statements, inside the clinic's tenant. */
export async function readStripFacts(tx: TenantTx, now: Date, auditsOn: boolean): Promise<StripFacts> {
  const c = tx.clinicId;

  const [row] = await tx.db
    .select({
      accountClosedAt: clinics.accountClosedAt,
      pausedAt: clinicSettings.aiPausedAt,
      pausedUntil: clinicSettings.aiPausedUntil,
      demo: sql<boolean>`app_clinic_is_demo(${clinics.id})`,
      voiceStatus: voiceAgents.status,
      voiceDriftFlaggedAt: voiceAgents.driftFlaggedAt,
      calendarStatus: providerConnections.status,
      calendarBrokenAt: providerConnections.brokenAt,
    })
    .from(clinics)
    .leftJoin(clinicSettings, eq(clinicSettings.clinicId, clinics.id))
    .leftJoin(voiceAgents, eq(voiceAgents.clinicId, clinics.id))
    .leftJoin(
      providerConnections,
      and(
        eq(providerConnections.clinicId, clinics.id),
        eq(providerConnections.provider, GOOGLE_CALENDAR_PROVIDER),
      ),
    )
    .where(eq(clinics.id, c))
    .limit(1);

  const entitlement = await getEntitlements(tx.db, c);

  const channels = await tx.db
    .select({
      channel: clinicChannels.channel,
      enabled: clinicChannels.enabled,
      readyAt: clinicChannels.readyAt,
      liveAt: clinicChannels.liveAt,
    })
    .from(clinicChannels)
    .where(eq(clinicChannels.clinicId, c));

  const byStatus = await tx.db
    .select({ status: transcriptEmails.status, n: sql<number>`count(*)::int` })
    .from(transcriptEmails)
    .where(
      and(
        eq(transcriptEmails.clinicId, c),
        gte(transcriptEmails.createdAt, new Date(now.getTime() - STRIP_TRANSCRIPT_DAYS * DAY_MS)),
      ),
    )
    .groupBy(transcriptEmails.status);

  const transcripts = { waiting: 0, bounced: 0 };
  for (const { status, n } of byStatus) {
    if (WAITING_STATUSES.has(status)) transcripts.waiting += Number(n);
    else if (BOUNCED_STATUSES.has(status)) transcripts.bounced += Number(n);
  }

  const audits = await readClinicAuditFacts(tx);

  // Only numbered reminders (setup_reminder:<n>, n from 1 to 6) have a day in
  // the setup window; the one-per-channel reminder after go-live has none.
  const lifecycle = await tx.db.execute<{ watched: boolean; wave: string | null }>(sql`
    select exists (select 1 from clinic_lifecycle l where l.clinic_id = ${c}) as watched,
           (select w.wave from lifecycle_waves w
             where w.clinic_id = ${c} and w.target = 'clinic_email' and w.wave ~ '^setup_reminder:[0-9]+$'
             order by w.queued_at desc, w.id desc
             limit 1) as wave
  `);
  const watched = lifecycle.rows[0]?.watched === true;
  const wave = lifecycle.rows[0]?.wave ?? null;
  const reminder = wave ? Number(wave.slice("setup_reminder:".length)) : null;

  return {
    accountClosedAt: row?.accountClosedAt ?? null,
    pausedAt: row?.pausedAt ?? null,
    pausedUntil: row?.pausedUntil ?? null,
    demo: row?.demo === true,
    voiceStatus: row?.voiceStatus ?? null,
    voiceDriftFlaggedAt: row?.voiceDriftFlaggedAt ?? null,
    calendarStatus: row?.calendarStatus ?? null,
    calendarBrokenAt: row?.calendarBrokenAt ?? null,
    entitlements: entitlement,
    channels,
    transcripts,
    audit: {
      changedAt: audits.change?.at ?? null,
      overall: auditOverall({ pending: audits.pending, auditsOn, latest: audits.latest.map((r) => r.result) }),
    },
    lifecycle: { watched, reminder: reminder !== null && Number.isFinite(reminder) ? reminder : null },
  };
}

// --- Deciding (pure) ---

/** One clinic's row from its overview and its facts. */
export function stripRow(
  clinic: ClinicOverview,
  facts: StripFacts,
  now: Date,
  billing: Entitlements | null = facts.entitlements,
): ClinicStripRow {
  return {
    clinicId: clinic.id,
    name: clinic.name,
    synthetic: facts.demo,
    stage: stageOf(clinic, facts, now, billing),
    channels: channelLevels(facts, now),
    availability: availabilityOf(facts),
    calendar: calendarOf(facts),
    voice: voiceOf(facts),
    transcripts: facts.transcripts,
    usage: usageOf(facts.entitlements, now),
    lastReminder: lastReminderOf(facts),
    blocking: blockersFor(clinic).find((b) => b.level === "blocked")?.message ?? null,
  };
}

/**
 * The Availability column: the newest change's time and the audits' overall
 * state, by the console's own rule (auditOverall). The contract's AuditLevel
 * has no `audits_off`: a change waiting while the clinic-audits job is off is
 * `never` (not audited), which the table draws as "changed, not audited"
 * because `changedAt` is set. Never null: every clinic has been measured.
 */
export function availabilityOf(facts: Pick<StripFacts, "audit">): ClinicStripRow["availability"] {
  const { changedAt, overall } = facts.audit;
  return { changedAt: changedAt ? changedAt.toISOString() : null, audit: overall === "audits_off" ? "never" : overall };
}

/**
 * The Last reminder column: the setup-window day of the newest numbered
 * reminder the watch recorded (reminder n goes on day n × 5), `{day: null}`
 * for a watched clinic with none yet, and null for a clinic the watch has no
 * row for (a location, healdesk's demo clinic, or one it has not seen yet),
 * which the table draws as "not measured yet" rather than "none".
 */
export function lastReminderOf(facts: Pick<StripFacts, "lifecycle">): ClinicStripRow["lastReminder"] {
  if (!facts.lifecycle.watched) return null;
  const n = facts.lifecycle.reminder;
  return { day: n === null ? null : n * SETUP_REMINDER_EVERY_DAYS };
}

/**
 * Where the clinic stands, first match wins: closed (its account closed, its
 * data destroyed, or its billing ended), offboarding, paused (the clinic's
 * own Pause AI, or billing paused or suspended), live (marked production or
 * a channel live), else setting up.
 */
export function stageOf(
  clinic: ClinicOverview,
  facts: StripFacts,
  now: Date,
  billing: Entitlements | null = facts.entitlements,
): ClinicStage {
  const status = billing?.status ?? null;
  const closedAt = facts.accountClosedAt ?? clinic.destroyedAt;
  if (closedAt) return { kind: "closed", since: closedAt.toISOString() };
  if (status === "canceled" || status === "purged") return { kind: "closed", since: null };
  if (clinic.offboardingStartedAt) {
    return { kind: "offboarding", since: clinic.offboardingStartedAt.toISOString() };
  }
  if (isPaused({ pausedAt: facts.pausedAt, pausedUntil: facts.pausedUntil }, now)) {
    return { kind: "paused", since: facts.pausedAt!.toISOString() };
  }
  if (status === "paused" || status === "suspended") return { kind: "paused", since: null };

  const liveTimes = [clinic.wentLiveAt, ...facts.channels.map((ch) => ch.liveAt)]
    .filter((t): t is Date => t !== null)
    .map((t) => t.getTime());
  if (liveTimes.length > 0) return { kind: "live", since: new Date(Math.min(...liveTimes)).toISOString() };

  const deadline = billing?.setupDeadlineAt ?? null;
  return {
    kind: "setup",
    day: setupDay(clinic, deadline, now),
    of: SETUP_WINDOW_OF,
    deadlineAt: deadline ? deadline.toISOString() : null,
  };
}

/**
 * The day of the setup window, counted as the setup reminders count it
 * (lib/setup/reminders.ts): whole days on the clinic's calendar since the
 * window's start, so day 30 is the window's last day, the day the account
 * closes at the end of. Past the deadline it keeps counting (31 of 30). A
 * location reads its billing clinic's deadline; a clinic with no deadline
 * at all counts from the day it was created.
 */
export function setupDay(clinic: Pick<ClinicOverview, "createdAt" | "timezone">, deadline: Date | null, now: Date): number {
  const zone = validZone(clinic.timezone);
  const start = deadline ? setupWindowStart(deadline, zone) : clinicLocalDate(clinic.createdAt, zone);
  const today = clinicLocalDate(now, zone);
  const days = Math.round((Date.parse(`${today}T12:00:00Z`) - Date.parse(`${start}T12:00:00Z`)) / DAY_MS);
  return Number.isFinite(days) ? Math.max(0, days) : 0;
}

function validZone(zone: string): string {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return zone;
  } catch {
    return "UTC";
  }
}

/** Live (or paused while live), waiting (on the clinic or on us), or off (switched off or not bought). */
export function channelLevels(facts: StripFacts, now: Date): ClinicStripRow["channels"] {
  const pause = { pausedAt: facts.pausedAt, pausedUntil: facts.pausedUntil };
  const levels: ClinicStripRow["channels"] = { web: "off", meta: "off", voice: "off" };
  for (const row of facts.channels) {
    const status = channelStatus(row, pause, now);
    levels[row.channel] = status === "live" || status === "paused" ? "live" : status === "off" ? "off" : "waiting";
  }
  return levels;
}

/**
 * The Google Calendar connection: broken once Google took access away
 * (`broken_at`, kept on the revoked row) or the row is in error; none when
 * there is no row, it was disconnected on purpose (revoked with no
 * breakage) or it is still pending (a connect that has not finished);
 * degraded when degraded; healthy when active.
 */
export function calendarOf(facts: Pick<StripFacts, "calendarStatus" | "calendarBrokenAt">): ClinicStripRow["calendar"] {
  if (facts.calendarStatus === null) return "none";
  if (facts.calendarBrokenAt !== null || facts.calendarStatus === "error") return "broken";
  if (facts.calendarStatus === "revoked" || facts.calendarStatus === "pending") return "none";
  if (facts.calendarStatus === "active") return "healthy";
  return "degraded";
}

/**
 * The voice agent, from its row alone (the same facts voiceAgentStatus
 * shows, no call to Retell): failed, drift left for a person, ok once
 * ready, and not provisioned for no row or a set-up not finished or released.
 */
export function voiceOf(facts: Pick<StripFacts, "voiceStatus" | "voiceDriftFlaggedAt">): ClinicStripRow["voice"] {
  if (facts.voiceStatus === null) return "not_provisioned";
  if (facts.voiceStatus === "failed") return "failed";
  // A released or releasing agent is gone, whatever drift it had.
  if (facts.voiceStatus === "released" || facts.voiceStatus === "deprovisioning") return "not_provisioned";
  if (facts.voiceDriftFlaggedAt !== null) return "drift";
  if (facts.voiceStatus === "ready") return "ok";
  return "not_provisioned";
}

/**
 * The worst meter's whole percent of what the plan includes, counted by
 * usageSnapshot as the allowance emails count it. Chat is named by the
 * package: `meta` when it includes the Meta bot (which includes website
 * chat), else `web`. Null with no billing row of its own (a location), no
 * allowance window open (the plan starts at the first answer, so a clinic
 * still setting up has none), or no meter that applies.
 */
export function usageOf(row: Entitlements | null, now: Date): ClinicStripRow["usage"] {
  if (!row) return { percent: null, meter: null };
  const [voice, chat] = usageSnapshot(row, now);
  const plan = getPlan(row.boughtPlanId ?? row.planCode);
  const chatMeter: "web" | "meta" = (plan?.channels.meta ?? row.channelsEnabled.meta) ? "meta" : "web";
  let worst: ClinicStripRow["usage"] = { percent: null, meter: null };
  for (const [meter, snap] of [["voice", voice], [chatMeter, chat]] as const) {
    const percent = snap?.isWindowOpen ? snap.percent : null;
    if (percent === null) continue;
    if (worst.percent === null || percent > worst.percent) worst = { percent, meter };
  }
  return worst;
}

// --- The operation ---

/**
 * The ops operation: no arguments, and any argument is refused rather than
 * ignored, so a console that thinks it can filter here learns it cannot. A
 * read: no audit row, nothing written but the tenant transactions' own.
 * One clinic that cannot be read fails the whole read, never a row with a
 * guessed state.
 */
export async function opListClinicStrip(args: Record<string, unknown>): Promise<OpsOutcome> {
  if (Object.keys(args).length > 0) return opsProblem("listClinicStrip takes no arguments.", 400, "invalid_args");
  try {
    return ok({ clinics: await listClinicStrip() });
  } catch (error) {
    log.error("clinic strip not read", { error: describeError(error) });
    return opsProblem("The clinics could not be read.", 500, "failed");
  }
}
