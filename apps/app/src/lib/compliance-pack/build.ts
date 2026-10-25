import { sql } from "drizzle-orm";

import { unsafeDb } from "@/db";
import type { ActorContext } from "@/lib/audit";
import { isDemoClinic } from "@/lib/booking/terms";
import { isVendorSubject, PLATFORM_SUBJECTS, type PlatformSubject } from "@/lib/compliance/subjects";
import { describeError, log } from "@/lib/log";
import { listClinics } from "@/lib/ops/clinics";
import { clockState } from "@/lib/rights/clocks";
import { collectRights, type RightsRow } from "@/lib/rights/tracker";
import { addLocalDays } from "@/lib/scheduler/summary-clock";
import { withTenant, type TenantTx } from "@/lib/tenant";

import { packWeek, PACK_TIME_ZONE, type PackWeek } from "./week";

/**
 * The weekly compliance pack (ops automation lane P6h; design E6 item 18;
 * owner decision D20): one week's answer to "are we keeping our promises?",
 * read from the database and nothing else. Counts, ids (uuids), dates,
 * versions and closed words: never a patient, never a name, never anything a
 * person typed (an incident's summary, an attestation's document reference,
 * a job's note), never an address.
 *
 * Each section says whether its read worked. A section that could not be
 * read, wholly or for one clinic, says `could_not_read` and carries no
 * numbers, so a failed read never prints as a zero. The five headline
 * numbers are null for a section that could not be read.
 *
 * A pure function of the database and the week: every count is bounded by
 * the week's two instants (New York midnight to New York midnight, see
 * ./week.ts), and a state "at the end of the week" is worked out from each
 * row's own timestamps, so a pack built late for a past week reads the same
 * as one built on its Monday, except where a row's history is not kept (each
 * such number says so in its name: `...Now`). Demo clinics are left out of
 * every per-clinic count, as the console lists leave them out.
 *
 * Where each number comes from (verified against the code on 25 October 2026):
 *   - agreements: baa_acceptances (the register searchAgreements reads),
 *     agreement_resigns (the re-signs; listOpenResigns is lane P6f's and not
 *     on main), and audit_review_queue rows of kind agreement_kind (the
 *     reviews listAgreementReviews lists);
 *   - vendors: platform_compliance, the latest row of each subject recorded
 *     before the week ended (readPlatformCompliance's rule, at that instant);
 *   - incidents: incidents (listIncidentRegister's rows), with its two clocks:
 *     notify_by, the internal 24-hour target, and agreement_notify_by;
 *   - rights: the patient-rights tracker (collectRights, every kind and
 *     source), its clocks at the week's last day;
 *   - dataLifecycle: transcript_emails (transcriptDeliveries' receipts), the
 *     retention-purge, transcript-emails and offboarding-destroy job rows,
 *     and the ops alerts those jobs raise when they fail;
 *   - access: security_events, by event name;
 *   - approvals: ops_approval_events and ops_approvals;
 *   - launch promises: LAUNCH_PROMISES lives in apps/web, which apps/app
 *     cannot read; the pack carries the `launch_promises` attestation under
 *     vendors, and the printed page (lane P6j) adds the list from apps/web.
 */

export const PACK_SCHEMA = 1;

const ACTOR: ActorContext = { type: "service", serviceName: "compliance-pack" };
const DAY_MS = 86_400_000;
/** Transcript copies are never kept past 30 days (owner, 14 October 2026; BAA 1.5.0). */
const TRANSCRIPT_COPY_DAYS = 30;
/** An attestation that lapses within this many days of the week's end is called out. */
const EXPIRY_HORIZON_DAYS = 30;
/** An open incident whose agreement deadline falls within this many days of the week's end is at risk. */
const INCIDENT_RISK_DAYS = 14;

type CouldNotRead = { status: "could_not_read"; unreadClinics?: number };
type Section<T> = ({ status: "ok" } & T) | CouldNotRead;

export type AgreementsSection = Section<{
  signed: { kind: string; version: string; count: number }[];
  resigns: {
    openedThisWeek: number;
    signedThisWeek: number;
    withdrawnThisWeek: number;
    openAtWeekEnd: number;
    /** Open at the week's end with the version in force below today's floor. */
    belowFloorAtWeekEnd: number;
  };
  reviews: { openedThisWeek: number; decidedThisWeek: number; openAtWeekEnd: number };
}>;

export type VendorState = "in_force" | "lapsed" | "withdrawn" | "not_attested";

export type VendorsSection = Section<{
  subjects: {
    subject: PlatformSubject;
    kind: "vendor" | "readiness";
    state: VendorState;
    effectiveOn: string | null;
    expiresOn: string | null;
    expiresWithin30Days: boolean;
  }[];
  recordedThisWeek: number;
}>;

export type IncidentsSection = Section<{
  openedThisWeek: number;
  openedByClass: { class: string; count: number }[];
  notifiedThisWeek: number;
  reportedThisWeek: number;
  notReportableThisWeek: number;
  resolvedThisWeek: number;
  openAtWeekEnd: number;
  /** Past the internal 24-hour target with no notice, or noticed after it, by the week's end. */
  targetMissed: { clinicId: string; incidentId: string }[];
  /** Open at the week's end, no notice recorded, the agreement's deadline within 14 days or past. */
  agreementDeadlineAtRisk: { clinicId: string; incidentId: string; agreementNotifyBy: string }[];
}>;

export type RightsSection = Section<{
  receivedThisWeek: number;
  receivedByKind: { kind: string; count: number }[];
  closedThisWeek: number;
  closedOnTimeThisWeek: number;
  closedLateThisWeek: number;
  openAtWeekEnd: number;
  overdueAtWeekEnd: number;
  dueSoonAtWeekEnd: number;
  /** Open, with no route to run on the host yet. */
  blockedNow: number;
}>;

export type JobState = {
  job: string;
  enabled: boolean;
  lastRunAt: string | null;
  lastRunStatus: string | null;
};

export type DataLifecycleSection = Section<{
  transcripts: {
    queuedThisWeek: number;
    deliveredThisWeek: number;
    /** Copies still held, queued more than 30 days before the week's end. */
    copiesPast30DaysNow: number;
  };
  jobs: JobState[];
  failureAlertsThisWeek: { event: string; count: number }[];
}>;

export type AccessSection = Section<{
  events: { event: string; count: number }[];
  freshCodeSteps: { approvalDecisions: number; platformAttestations: number; deviceRecoveriesIssued: number };
  /** The console's sign-in is checked on Vercel (CLAUDE.md, case 3) and is not recorded on the host. */
  operatorSignIns: "not_recorded_on_the_host";
}>;

export type ApprovalsSection = Section<{
  approvedThisWeek: number;
  rejectedThisWeek: number;
  executedThisWeek: number;
  failedThisWeek: number;
  expiredThisWeek: number;
  /** Median minutes from proposal to the owner's decision, over this week's decisions; null with none. */
  medianMinutesToDecide: number | null;
  waitingAtWeekEnd: number;
}>;

export type Headline = {
  incidentsOpen: number | null;
  rightsOverdue: number | null;
  resignsOpen: number | null;
  vendorsNeedingAttention: number | null;
  transcriptCopiesPast30Days: number | null;
};

export type CompliancePack = {
  schema: typeof PACK_SCHEMA;
  week: { start: string; lastDay: string; timeZone: string; from: string; to: string };
  headline: Headline;
  agreements: AgreementsSection;
  vendors: VendorsSection;
  incidents: IncidentsSection;
  rights: RightsSection;
  dataLifecycle: DataLifecycleSection;
  access: AccessSection;
  approvals: ApprovalsSection;
  launchPromises: { status: "read_on_the_console" };
};

/** The security events the access section counts, by name; each counted, zero or not. */
export const ACCESS_EVENTS = [
  "approval_approved",
  "approval_rejected",
  "device_recovery_issued",
  "device_recovery_claimed",
  "device_recovery_used",
  "device_recovery_refused",
  "device_recovery_revoked",
  "passkey_added",
  "passkey_removed",
  "totp_enrolled",
  "backup_codes_generated",
  "factor_locked_out",
  "step_up_granted",
  "sign_in_help_link_sent",
  "sign_in_address_changed",
  "operator_signed_out",
] as const;

/** The jobs whose last run the data-lifecycle section shows. */
export const LIFECYCLE_JOBS = ["retention-purge", "transcript-emails", "offboarding-destroy"] as const;

/** The ops alerts a failed data-lifecycle run raises, counted by the week they were raised in. */
export const LIFECYCLE_FAILURE_EVENTS = [
  "retention_purge_failed",
  "transcript_undelivered",
  "export_undelivered_before_destruction",
] as const;

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

const n = (value: unknown): number => Number(value ?? 0);

function iso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return new Date(value as string | Date).toISOString();
}

async function readOr<T>(name: string, read: () => Promise<T>): Promise<T | CouldNotRead> {
  try {
    return await read();
  } catch (error) {
    log.error("compliance pack: a section could not be read", { hint: name, error: describeError(error) });
    return { status: "could_not_read" };
  }
}

type Clinic = { id: string };

/**
 * Every clinic in service that is not a demo clinic, each read in its own
 * transaction. One failed clinic makes the whole section unreadable: its
 * numbers would otherwise be counted as nothing.
 */
async function perClinic<T>(
  name: string,
  clinics: readonly Clinic[],
  read: (tx: TenantTx) => Promise<T>,
): Promise<{ ok: true; rows: T[] } | { ok: false; unread: number }> {
  const rows: T[] = [];
  let unread = 0;
  for (const clinic of clinics) {
    try {
      const row = await withTenant({ clinicId: clinic.id, actor: ACTOR }, async (tx) =>
        (await isDemoClinic(tx)) ? null : read(tx),
      );
      if (row !== null) rows.push(row);
    } catch (error) {
      unread += 1;
      log.error("compliance pack: a clinic could not be read", { clinicId: clinic.id, hint: name, error: describeError(error) });
    }
  }
  return unread > 0 ? { ok: false, unread } : { ok: true, rows };
}

function sorted<T extends { count: number }>(rows: T[], key: (row: T) => string): T[] {
  return rows.filter((r) => r.count > 0).sort((a, b) => key(a).localeCompare(key(b)));
}

function tally(into: Map<string, number>, key: string, add: number): void {
  into.set(key, (into.get(key) ?? 0) + add);
}

/** The middle of the list (the mean of the two middles, rounded), or null when empty. */
export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid]! : Math.round((s[mid - 1]! + s[mid]!) / 2);
}

// -----------------------------------------------------------------------------
// Sections
// -----------------------------------------------------------------------------

async function readAgreements(week: PackWeek, clinics: readonly Clinic[]): Promise<AgreementsSection> {
  const signed = await readOr("agreements.signed", async () => {
    const result = await unsafeDb.execute<{ kind: string; version: string; n: number }>(sql`
      select agreement_kind as kind, document_version as version, count(*)::int as n
        from baa_acceptances
       where accepted_at >= ${week.from} and accepted_at < ${week.to}
       group by agreement_kind, document_version`);
    return result.rows.map((r) => ({ kind: r.kind, version: r.version, count: n(r.n) }));
  });
  if (!Array.isArray(signed)) return signed;

  const resigns = await perClinic("agreements.resigns", clinics, async (tx) => {
    const result = await tx.db.execute<Record<string, number>>(sql`
      select
        count(*) filter (where r.started_at >= ${week.from} and r.started_at < ${week.to})::int as opened,
        count(*) filter (where r.signed_at >= ${week.from} and r.signed_at < ${week.to})::int as signed,
        count(*) filter (where r.status = 'withdrawn' and r.resolved_at >= ${week.from} and r.resolved_at < ${week.to})::int as withdrawn,
        count(*) filter (where r.started_at < ${week.to}
                           and (r.signed_at is null or r.signed_at >= ${week.to})
                           and not (r.status = 'withdrawn' and r.resolved_at < ${week.to}))::int as open_at_end,
        count(*) filter (where r.started_at < ${week.to}
                           and (r.signed_at is null or r.signed_at >= ${week.to})
                           and not (r.status = 'withdrawn' and r.resolved_at < ${week.to})
                           and r.reason = 'baa_version'
                           and a.document_version is not null
                           and not app_baa_version_acceptable(a.document_version))::int as below_floor
        from agreement_resigns r
        left join baa_acceptances a on a.id = r.from_agreement_id
       where r.clinic_id = ${tx.clinicId}::uuid`);
    return result.rows[0] ?? {};
  });
  if (!resigns.ok) return { status: "could_not_read", unreadClinics: resigns.unread };

  const reviews = await perClinic("agreements.reviews", clinics, async (tx) => {
    const result = await tx.db.execute<Record<string, number>>(sql`
      select
        count(*) filter (where created_at >= ${week.from} and created_at < ${week.to})::int as opened,
        count(*) filter (where decided_at >= ${week.from} and decided_at < ${week.to})::int as decided,
        count(*) filter (where created_at < ${week.to} and (decided_at is null or decided_at >= ${week.to})
                           and status <> 'superseded')::int as open_at_end
        from audit_review_queue
       where clinic_id = ${tx.clinicId}::uuid and kind = 'agreement_kind'`);
    return result.rows[0] ?? {};
  });
  if (!reviews.ok) return { status: "could_not_read", unreadClinics: reviews.unread };

  const sum = (rows: Record<string, number>[], key: string) => rows.reduce((total, r) => total + n(r[key]), 0);
  return {
    status: "ok",
    signed: signed.filter((s) => s.count > 0).sort((a, b) => a.kind.localeCompare(b.kind) || a.version.localeCompare(b.version)),
    resigns: {
      openedThisWeek: sum(resigns.rows, "opened"),
      signedThisWeek: sum(resigns.rows, "signed"),
      withdrawnThisWeek: sum(resigns.rows, "withdrawn"),
      openAtWeekEnd: sum(resigns.rows, "open_at_end"),
      belowFloorAtWeekEnd: sum(resigns.rows, "below_floor"),
    },
    reviews: {
      openedThisWeek: sum(reviews.rows, "opened"),
      decidedThisWeek: sum(reviews.rows, "decided"),
      openAtWeekEnd: sum(reviews.rows, "open_at_end"),
    },
  };
}

async function readVendors(week: PackWeek): Promise<VendorsSection> {
  const read = await readOr("vendors", async () => {
    const latest = await unsafeDb.execute<{
      subject: string;
      action: string;
      effective_on: string;
      expires_on: string | null;
    }>(sql`
      select distinct on (subject) subject, action, effective_on::text as effective_on, expires_on::text as expires_on
        from platform_compliance
       where recorded_at < ${week.to}
       order by subject, recorded_at desc, id desc`);
    const [counted] = (
      await unsafeDb.execute<{ n: number }>(sql`
        select count(*)::int as n from platform_compliance
         where recorded_at >= ${week.from} and recorded_at < ${week.to}`)
    ).rows;
    return { latest: latest.rows, recorded: n(counted?.n) };
  });
  if ("status" in read) return read;
  const byPlatform = new Map(read.latest.map((r) => [r.subject, r]));
  const horizon = addLocalDays(week.lastDay, EXPIRY_HORIZON_DAYS);
  return {
    status: "ok",
    subjects: PLATFORM_SUBJECTS.map((subject) => {
      const row = byPlatform.get(subject);
      let state: VendorState = "not_attested";
      if (row?.action === "withdrawn") state = "withdrawn";
      else if (row?.action === "attested") {
        // The day it lapses counts as in force, as decidePlatform reads it.
        state = row.expires_on !== null && row.expires_on < week.lastDay ? "lapsed" : "in_force";
      }
      const expiresOn = row?.expires_on ?? null;
      return {
        subject,
        kind: isVendorSubject(subject) ? ("vendor" as const) : ("readiness" as const),
        state,
        effectiveOn: row?.effective_on ?? null,
        expiresOn,
        expiresWithin30Days: state === "in_force" && expiresOn !== null && expiresOn <= horizon,
      };
    }),
    recordedThisWeek: read.recorded,
  };
}

async function readIncidents(week: PackWeek, clinics: readonly Clinic[]): Promise<IncidentsSection> {
  const riskBy = new Date(week.to.getTime() + INCIDENT_RISK_DAYS * DAY_MS);
  const found = await perClinic("incidents", clinics, async (tx) => {
    const result = await tx.db.execute<{
      id: string;
      class: string;
      discovered_at: Date | string;
      notify_by: Date | string;
      notified_at: Date | string | null;
      agreement_notify_by: Date | string | null;
      reported_at: Date | string | null;
      not_reportable_at: Date | string | null;
      resolved_at: Date | string | null;
    }>(sql`
      select id, class::text as class, discovered_at, notify_by, notified_at, agreement_notify_by,
             reported_at, not_reportable_at, resolved_at
        from incidents
       where clinic_id = ${tx.clinicId}::uuid and discovered_at < ${week.to}`);
    if (result.rows.length > 0) {
      tx.audit.record({
        action: "read",
        resourceType: "incident",
        resultCount: result.rows.length,
        metadata: { purpose: "compliance_pack" },
      });
    }
    return { clinicId: tx.clinicId, rows: result.rows };
  });
  if (!found.ok) return { status: "could_not_read", unreadClinics: found.unread };

  const from = week.from.getTime();
  const to = week.to.getTime();
  const t = (v: unknown) => (v === null || v === undefined ? null : new Date(v as string | Date).getTime());
  const inWeek = (v: unknown) => {
    const at = t(v);
    return at !== null && at >= from && at < to;
  };
  const byClass = new Map<string, number>();
  const section = {
    openedThisWeek: 0,
    notifiedThisWeek: 0,
    reportedThisWeek: 0,
    notReportableThisWeek: 0,
    resolvedThisWeek: 0,
    openAtWeekEnd: 0,
    targetMissed: [] as { clinicId: string; incidentId: string }[],
    agreementDeadlineAtRisk: [] as { clinicId: string; incidentId: string; agreementNotifyBy: string }[],
  };
  for (const clinic of found.rows) {
    for (const i of clinic.rows) {
      if (inWeek(i.discovered_at)) {
        section.openedThisWeek += 1;
        tally(byClass, i.class, 1);
      }
      if (inWeek(i.notified_at)) section.notifiedThisWeek += 1;
      if (inWeek(i.reported_at)) section.reportedThisWeek += 1;
      if (inWeek(i.not_reportable_at)) section.notReportableThisWeek += 1;
      if (inWeek(i.resolved_at)) section.resolvedThisWeek += 1;
      const resolved = t(i.resolved_at);
      const open = resolved === null || resolved >= to;
      if (open) section.openAtWeekEnd += 1;
      const notified = t(i.notified_at);
      const notifiedByEnd = notified !== null && notified < to ? notified : null;
      const decidedNotReportable = (() => {
        const at = t(i.not_reportable_at);
        return at !== null && at < to;
      })();
      const target = t(i.notify_by)!;
      if (!decidedNotReportable && target < to && (notifiedByEnd === null || notifiedByEnd > target)) {
        section.targetMissed.push({ clinicId: clinic.clinicId, incidentId: i.id });
      }
      const deadline = t(i.agreement_notify_by);
      if (open && notifiedByEnd === null && !decidedNotReportable && deadline !== null && deadline < riskBy.getTime()) {
        section.agreementDeadlineAtRisk.push({
          clinicId: clinic.clinicId,
          incidentId: i.id,
          agreementNotifyBy: iso(i.agreement_notify_by)!,
        });
      }
    }
  }
  const byId = (a: { incidentId: string }, b: { incidentId: string }) => a.incidentId.localeCompare(b.incidentId);
  section.targetMissed.sort(byId);
  section.agreementDeadlineAtRisk.sort(byId);
  return {
    status: "ok",
    ...section,
    openedByClass: sorted(
      [...byClass].map(([cls, count]) => ({ class: cls, count })),
      (r) => r.class,
    ),
  };
}

/** The rights section from the tracker's rows (every kind and source), at the week's last day. Pure. */
export function rightsSection(rows: readonly RightsRow[], week: Pick<PackWeek, "start" | "lastDay">): RightsSection {
  const inWeek = (d: string | null) => d !== null && d >= week.start && d <= week.lastDay;
  const byKind = new Map<string, number>();
  const out = {
    receivedThisWeek: 0,
    closedThisWeek: 0,
    closedOnTimeThisWeek: 0,
    closedLateThisWeek: 0,
    openAtWeekEnd: 0,
    overdueAtWeekEnd: 0,
    dueSoonAtWeekEnd: 0,
    blockedNow: 0,
  };
  for (const row of rows) {
    if (inWeek(row.receivedOn)) {
      out.receivedThisWeek += 1;
      tally(byKind, row.kind, 1);
    }
    if (inWeek(row.closedOn)) {
      out.closedThisWeek += 1;
      if (row.closedOn! <= row.dueOn) out.closedOnTimeThisWeek += 1;
      else out.closedLateThisWeek += 1;
    }
    const openAtEnd = row.receivedOn <= week.lastDay && (row.closedOn === null || row.closedOn > week.lastDay);
    if (openAtEnd) {
      out.openAtWeekEnd += 1;
      const clock = clockState(week.lastDay, row.dueOn);
      if (clock === "overdue") out.overdueAtWeekEnd += 1;
      if (clock === "due_soon") out.dueSoonAtWeekEnd += 1;
    }
    if (row.state === "blocked") out.blockedNow += 1;
  }
  return {
    status: "ok",
    ...out,
    receivedByKind: sorted(
      [...byKind].map(([kind, count]) => ({ kind, count })),
      (r) => r.kind,
    ),
  };
}

async function readRights(week: PackWeek, clinics: readonly Clinic[]): Promise<RightsSection> {
  const read = await readOr("rights", async () => {
    // At the week's last instant, so each row's state is the one it had then.
    return collectRights({
      actor: ACTOR,
      operator: "",
      filter: "all",
      now: new Date(week.to.getTime() - 1),
      clinics: clinics.map((c) => ({ id: c.id, name: "" })),
    });
  });
  if ("status" in read) return read;
  if (read.unreadClinics > 0) return { status: "could_not_read", unreadClinics: read.unreadClinics };
  return rightsSection(read.rows, week);
}

async function readDataLifecycle(week: PackWeek, clinics: readonly Clinic[]): Promise<DataLifecycleSection> {
  const copiesBefore = new Date(week.to.getTime() - TRANSCRIPT_COPY_DAYS * DAY_MS);
  const transcripts = await perClinic("dataLifecycle.transcripts", clinics, async (tx) => {
    const result = await tx.db.execute<Record<string, number>>(sql`
      select
        count(*) filter (where created_at >= ${week.from} and created_at < ${week.to})::int as queued,
        count(*) filter (where delivered_at >= ${week.from} and delivered_at < ${week.to})::int as delivered,
        count(*) filter (where sealed is not null and created_at < ${copiesBefore})::int as past_30
        from transcript_emails
       where clinic_id = ${tx.clinicId}::uuid`);
    const row = result.rows[0] ?? {};
    tx.audit.record({
      action: "read",
      resourceType: "transcript_email",
      resultCount: n(row.queued),
      metadata: { purpose: "compliance_pack" },
    });
    return row;
  });
  if (!transcripts.ok) return { status: "could_not_read", unreadClinics: transcripts.unread };

  const rest = await readOr("dataLifecycle.jobs", async () => {
    const jobs = await unsafeDb.execute<{
      name: string;
      enabled: boolean;
      last_run_at: Date | string | null;
      last_run_status: string | null;
    }>(sql`
      select name, enabled, last_run_at, last_run_status from scheduled_jobs
       where name in (${sql.join(LIFECYCLE_JOBS.map((j) => sql`${j}`), sql`, `)})`);
    const alerts = await unsafeDb.execute<{ event: string; n: number }>(sql`
      select event, count(*)::int as n from ops_alerts
       where raised_at >= ${week.from} and raised_at < ${week.to}
         and event in (${sql.join(LIFECYCLE_FAILURE_EVENTS.map((e) => sql`${e}`), sql`, `)})
       group by event`);
    return { jobs: jobs.rows, alerts: alerts.rows };
  });
  if ("status" in rest) return rest;

  const sum = (key: string) => transcripts.rows.reduce((total, r) => total + n(r[key]), 0);
  const byName = new Map(rest.jobs.map((j) => [j.name, j]));
  const byEvent = new Map(rest.alerts.map((a) => [a.event, n(a.n)]));
  return {
    status: "ok",
    transcripts: {
      queuedThisWeek: sum("queued"),
      deliveredThisWeek: sum("delivered"),
      copiesPast30DaysNow: sum("past_30"),
    },
    jobs: LIFECYCLE_JOBS.map((job) => {
      const row = byName.get(job);
      return {
        job,
        enabled: row?.enabled === true,
        lastRunAt: iso(row?.last_run_at ?? null),
        lastRunStatus: row?.last_run_status ?? null,
      };
    }),
    failureAlertsThisWeek: LIFECYCLE_FAILURE_EVENTS.map((event) => ({ event, count: byEvent.get(event) ?? 0 })),
  };
}

async function readAccess(week: PackWeek): Promise<AccessSection> {
  const read = await readOr("access", async () => {
    const events = await unsafeDb.execute<{ event: string; n: number }>(sql`
      select event, count(*)::int as n from security_events
       where occurred_at >= ${week.from} and occurred_at < ${week.to}
         and event in (${sql.join(ACCESS_EVENTS.map((e) => sql`${e}`), sql`, `)})
       group by event`);
    const [fresh] = (
      await unsafeDb.execute<{ n: number }>(sql`
        select count(*)::int as n from security_events
         where occurred_at >= ${week.from} and occurred_at < ${week.to}
           and event in ('approval_approved', 'approval_rejected')
           and metadata ->> 'freshCode' = 'true'`)
    ).rows;
    const [attested] = (
      await unsafeDb.execute<{ n: number }>(sql`
        select count(*)::int as n from platform_compliance
         where recorded_at >= ${week.from} and recorded_at < ${week.to}`)
    ).rows;
    return { events: events.rows, fresh: n(fresh?.n), attested: n(attested?.n) };
  });
  if ("status" in read) return read;
  const byEvent = new Map(read.events.map((e) => [e.event, n(e.n)]));
  return {
    status: "ok",
    events: ACCESS_EVENTS.map((event) => ({ event, count: byEvent.get(event) ?? 0 })),
    freshCodeSteps: {
      approvalDecisions: read.fresh,
      platformAttestations: read.attested,
      deviceRecoveriesIssued: byEvent.get("device_recovery_issued") ?? 0,
    },
    operatorSignIns: "not_recorded_on_the_host",
  };
}

async function readApprovals(week: PackWeek): Promise<ApprovalsSection> {
  const read = await readOr("approvals", async () => {
    const counts = await unsafeDb.execute<{ event: string; n: number }>(sql`
      select event, count(*)::int as n from ops_approval_events
       where at >= ${week.from} and at < ${week.to}
         and event in ('approved', 'rejected', 'executed', 'failed', 'expired')
       group by event`);
    const decided = await unsafeDb.execute<{ minutes: number }>(sql`
      select round(extract(epoch from (e.at - a.proposed_at)) / 60)::int as minutes
        from ops_approval_events e
        join ops_approvals a on a.id = e.approval_id
       where e.at >= ${week.from} and e.at < ${week.to}
         and e.event in ('approved', 'rejected')`);
    const [waiting] = (
      await unsafeDb.execute<{ n: number }>(sql`
        select count(*)::int as n from ops_approvals
         where proposed_at < ${week.to} and (decided_at is null or decided_at >= ${week.to})`)
    ).rows;
    return { counts: counts.rows, minutes: decided.rows.map((r) => n(r.minutes)), waiting: n(waiting?.n) };
  });
  if ("status" in read) return read;
  const c = new Map(read.counts.map((r) => [r.event, n(r.n)]));
  return {
    status: "ok",
    approvedThisWeek: c.get("approved") ?? 0,
    rejectedThisWeek: c.get("rejected") ?? 0,
    executedThisWeek: c.get("executed") ?? 0,
    failedThisWeek: c.get("failed") ?? 0,
    expiredThisWeek: c.get("expired") ?? 0,
    medianMinutesToDecide: median(read.minutes),
    waitingAtWeekEnd: read.waiting,
  };
}

// -----------------------------------------------------------------------------
// The pack
// -----------------------------------------------------------------------------

/** The five numbers the pointer email carries; null for a section that could not be read. */
export function headlineOf(pack: Omit<CompliancePack, "headline">): Headline {
  const vendors = pack.vendors;
  return {
    incidentsOpen: pack.incidents.status === "ok" ? pack.incidents.openAtWeekEnd : null,
    rightsOverdue: pack.rights.status === "ok" ? pack.rights.overdueAtWeekEnd : null,
    resignsOpen: pack.agreements.status === "ok" ? pack.agreements.resigns.openAtWeekEnd : null,
    vendorsNeedingAttention:
      vendors.status === "ok"
        ? vendors.subjects.filter((s) => s.kind === "vendor" && (s.state !== "in_force" || s.expiresWithin30Days)).length
        : null,
    transcriptCopiesPast30Days:
      pack.dataLifecycle.status === "ok" ? pack.dataLifecycle.transcripts.copiesPast30DaysNow : null,
  };
}

/** Whether any section could not be read: the job stores the pack anyway, and says so. */
export function unreadSections(pack: CompliancePack): string[] {
  const sections = ["agreements", "vendors", "incidents", "rights", "dataLifecycle", "access", "approvals"] as const;
  return sections.filter((name) => pack[name].status === "could_not_read");
}

/** Build one week's pack. Reads only. Throws only if the clinic list cannot be read. */
export async function buildCompliancePack(weekStart: string): Promise<CompliancePack> {
  const week = packWeek(weekStart);
  const clinics = (await listClinics()).map((c) => ({ id: c.id }));
  const body = {
    schema: PACK_SCHEMA,
    week: {
      start: week.start,
      lastDay: week.lastDay,
      timeZone: PACK_TIME_ZONE,
      from: week.from.toISOString(),
      to: week.to.toISOString(),
    },
    agreements: await readAgreements(week, clinics),
    vendors: await readVendors(week),
    incidents: await readIncidents(week, clinics),
    rights: await readRights(week, clinics),
    dataLifecycle: await readDataLifecycle(week, clinics),
    access: await readAccess(week),
    approvals: await readApprovals(week),
    launchPromises: { status: "read_on_the_console" as const },
  } satisfies Omit<CompliancePack, "headline">;
  return { ...body, headline: headlineOf(body) };
}
