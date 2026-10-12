import { randomUUID } from "node:crypto";

import {
  GOOGLE_CALENDAR_PROVIDER,
  probeGoogleToken,
  type ConnectorContext,
  type ConnectorError,
} from "@healdesk/connectors";
import { and, eq, lt, sql } from "drizzle-orm";

import { unsafeDb } from "@/db";
import { clinics, googleOauthStates, providerConnections } from "@/db/schema";
import { recordSecurityEvent, type ActorContext } from "@/lib/audit";
import {
  calendarBreakOf,
  claimBreakageAlertWithin,
  googleCalendarConnection,
  googleOAuthClient,
  markCalendarBrokenWithin,
  revokeGoogleGrantIfUnused,
  sweepCalendarTerms,
  type CalendarBreak,
  type CalendarSweepResult,
} from "@/lib/connections/google-calendar";
import { withCredentials } from "@/lib/connections/store";
import { describeError, log } from "@/lib/log";
import { notifyOps, type OpsFields } from "@/lib/ops/notify";
import { withTenant, type TenantTx } from "@/lib/tenant";

import { JOB_CALENDAR_WATCH, runJob, type JobOutcome } from "./jobs";

/**
 * The calendar watch (plan §9, owner decision 5): every five minutes, from
 * its own pg-boss queue (QUEUE_CALENDAR_WATCH, src/workers/index.ts), behind
 * the `calendar-watch` job row's switch, which ships off.
 *
 * One run, in order:
 *
 *   1. The work list: app_calendar_connections() (drizzle/0057), every
 *      Google Calendar connection that is not revoked, and a revoked one
 *      whose breakage the clinic has not been told about, on clinics whose
 *      data is not destroyed.
 *   2. The terms, before any token is opened: sweepCalendarTerms
 *      disconnects every location whose terms no longer cover a calendar,
 *      whose account kind no longer matches them, or that is offboarding,
 *      without asking Google anything first. A location whose check threw
 *      is not probed this run: nobody knows its terms still cover a
 *      calendar, so its token stays sealed.
 *   3. The probe of every `active` and `degraded` connection, exactly as
 *      decision 5 says: one refresh-token exchange forced on every run, never
 *      a cached access token, then one free/busy query on the connection's
 *      calendar (probeGoogleToken), and nothing else. The token is opened in
 *      a short, audited transaction (purpose `calendar_watch`), Google is
 *      asked outside any transaction, and a second transaction records the
 *      answer, but only while the row still holds the token Google answered
 *      about.
 *   4. The alert pass: a breakage the clinic has not been told about is
 *      claimed and told, once (claimBreakageAlertWithin).
 *   5. Google OAuth states older than a day are purged.
 *
 * What an answer does to the connection. Its health is stored and the
 * booking mode is derived from it (plan §9.3), so whatever moves it out of
 * `active` takes the location to booking requests from that moment:
 *
 *   - ok: `active`, `last_verified_at` now, the miss count back to 0. A
 *     degraded connection recovers here.
 *   - definitive (calendarBreakOf: invalid_grant, admin_policy_enforced or a
 *     lost scope at the refresh; 401 with that fresh token; 403 or 404 on
 *     the calendar): markCalendarBrokenWithin, at once, in a transaction of
 *     the watch's own. The clinic is told once (notifyCalendarState, in the
 *     transaction that claims the alert), and ops once, in the run's one
 *     `calendar_broken` alert.
 *   - ours (oauth_client, api_disabled): the same for every clinic, and
 *     never a reason to take a clinic's token, so the connection is
 *     `degraded` with last_error `healdesk_config`. Ops only.
 *   - anything else is a miss (timeouts, the network, 5xx, 429 and the
 *     rate-limit 403s). Never a flip on one miss: the third in a row
 *     degrades the connection. Ops only.
 *
 * Ops hears through notifyOps once per run for each kind of change,
 * breakages included, counted, with the ids when exactly one connection
 * changed: a Google outage that degrades every connection at once is one
 * email, not one per clinic, which would also spend the day's email
 * allowance that the clinics' sign-in links need. Each change is a log line
 * with its ids, each degraded episode a security event, and each breakage
 * the `calendar_broken` event claimBreakageAlertWithin records.
 *
 * Every run has an id (`runId`), which its change alerts carry as `jobId`,
 * its log lines too, and its `calendar_watch` security event. It is what an
 * operator looks up to list the connections a counted alert is about, and
 * it is those alerts' identity: notifyOps sends an identical alert once an
 * hour, and without the run's id a second wave of degradations, or a
 * connection that degrades again after recovering, would be "identical" and
 * silent. The alerts about a state that persists rather than a change
 * (healdesk's Google setup refused, a run out of time, a run whose steps
 * threw) carry no run id, and mail at most once an hour while it lasts.
 *
 * Failure. Each probe, each location's terms check and each told breakage
 * that throws is logged and counted, and the run goes on; anything else
 * that throws ends the run's work there. Either way the report still goes
 * out, because the changes it reports have committed and the next run will
 * not see them as changes. A run with anything counted failed raises
 * `calendar_watch_failed` and is recorded as failed, and pg-boss does not
 * re-run it at once (CALENDAR_WATCH_RETRY_LIMIT): a re-run forces every
 * refresh again and counts another miss for each connection Google was
 * slow for, so one blip could degrade a connection inside one cycle. The
 * next five-minute fire is the retry.
 *
 * A `calendar_watch` security event every run, with its counts and id (plan
 * §9.2 step 4), even when nothing changed: 288 rows a day, fewer than the
 * decrypt audit rows the probes already write, and a gap in them is the
 * evidence that the watch did not run.
 *
 * Capacity (plan §9.2): sixteen probes at a time, each bounded by the
 * adapter's timeouts (3 s for the refresh, 3 s for free/busy), and no probe
 * launched after four minutes, so a run ends inside its five and well
 * inside the ten-minute lock. A run that leaves connections unprobed counts
 * them, tells ops, and probes them first next time (`launchOrder`).
 *
 * C12 and C13 add their sweeps here (unconfirmed desk writes, holds, owed
 * desk notices; plan §9.2 step 5).
 *
 * Deferred, not built: plan §9.2 step 5's one-off "reconnect to accept the
 * updated notice" email to a clinic whose connection was accepted under a
 * disclosure version no longer in GOOGLE_CALENDAR_DISCLOSURE_COMPATIBLE,
 * deduplicated by an audit row per version. Until it exists, the Google
 * disclosure's version (packages/catalog google-calendar-disclosure.ts) may
 * not be bumped out of that list: lib/booking/mode.ts already sends such a
 * connection to requests (`calendar_disclosure_outdated`), so a bump would
 * silently put every connected location on booking requests and tell no
 * clinic why. Only version /1 exists.
 */

/** Every five minutes, in UTC. */
export const CALENDAR_WATCH_CRON = "*/5 * * * *";
/** A failed run is not re-run at once; the next fire is the retry (see Failure, above). */
export const CALENDAR_WATCH_RETRY_LIMIT = 0;
/** A crashed run blocks the watch for at most this long (plan §9.1), not runJob's hour. */
export const CALENDAR_WATCH_STALE_LOCK_MS = 10 * 60_000;
/** Misses in a row that degrade a connection: never a flip on one miss. */
export const DEGRADE_AFTER_MISSES = 3;
/** What a connection degraded by healdesk's own Google setup stores as last_error. */
export const HEALDESK_CONFIG = "healdesk_config";

const PROBE_CONCURRENCY = 16;
const PROBE_LAUNCH_BUDGET_MS = 240_000;
/** transient_failures is a smallint: a long outage counts up to here and stays. */
const MISS_COUNT_CAP = 32_767;
/** A state lives fifteen minutes; its row is kept a day for the trail (google_oauth_states). */
const OAUTH_STATE_KEEP_MS = 86_400_000;
const PROBED: ReadonlySet<string> = new Set(["active", "degraded"]);
const WATCH_ACTOR: ActorContext = { type: "service", serviceName: "calendar-watch" };
const WATCH_LABEL = "calendar-watch";

export type CalendarWatchOptions = {
  now?: Date;
  /** Test seams for plan §9.2's sixteen probes at a time and four-minute launch budget. */
  concurrency?: number;
  launchBudgetMs?: number;
};

export type CalendarWatchSummary = {
  /** This run's id: `jobId` on its change alerts, log lines and security event. */
  runId: string;
  /** Connections on the work list. */
  connections: number;
  sweep: CalendarSweepResult;
  /** Connections checked: a token opened (or found unreadable) and Google asked. */
  probed: number;
  ok: number;
  recovered: number;
  broken: number;
  /** Transient misses, an unreadable token among them. */
  missed: number;
  /** Probes that met healdesk's own Google setup refused. */
  ours: number;
  /** Connections moved to `degraded` by this run, for either reason. */
  degraded: number;
  /** Connections not probed because the run ran out of time. */
  skipped: number;
  /** Probes or told breakages that threw, or the run itself; each is logged. */
  failed: number;
  /** Breakages the alert pass told. */
  alerted: number;
  oauthStatesPurged: number;
};

/**
 * The watch, behind its switch and its ten-minute lock. The job's note is the
 * run's summary, and a run in which anything failed is recorded as failed.
 */
export async function runCalendarWatchJob(options: CalendarWatchOptions = {}): Promise<JobOutcome> {
  const now = options.now ?? new Date();
  return runJob(
    JOB_CALENDAR_WATCH,
    async () => {
      const summary = await watchCalendars({ ...options, now });
      const note = noteOf(summary);
      if (summary.failed > 0 || summary.sweep.failed > 0) throw new Error(note);
      return note;
    },
    now,
    { staleLockMs: CALENDAR_WATCH_STALE_LOCK_MS },
  );
}

/** One run of the watch, without the switch or the lock (runCalendarWatchJob has both). */
export async function watchCalendars(
  options: CalendarWatchOptions = {},
): Promise<CalendarWatchSummary> {
  const now = options.now ?? new Date();
  const summary: CalendarWatchSummary = {
    runId: randomUUID(),
    connections: 0,
    sweep: { checked: 0, disconnected: 0, failed: 0, failedClinicIds: [] },
    probed: 0,
    ok: 0,
    recovered: 0,
    broken: 0,
    missed: 0,
    ours: 0,
    degraded: 0,
    skipped: 0,
    failed: 0,
    alerted: 0,
    oauthStatesPurged: 0,
  };
  const changes: Changes = {
    broken: [],
    degraded: [],
    recovered: [],
    ours: new Map(),
    oursDegraded: 0,
  };
  const run: RunState = { summary, changes, options };

  try {
    const rows = await calendarConnections();
    summary.connections = rows.length;

    const live = rows.filter((row) => row.status !== "revoked").map((row) => row.clinicId);
    summary.sweep = await sweepCalendarTerms(live, { actor: WATCH_ACTOR });
    const unchecked = new Set(summary.sweep.failedClinicIds);

    const due = launchOrder(
      rows.filter(
        (row) => PROBED.has(row.status) && row.brokenAt === null && !unchecked.has(row.clinicId),
      ),
    );
    await probeAll(due, run);

    for (const row of rows) {
      if (row.brokenAt !== null && row.brokenAlertedAt === null) await alertUntold(row, run);
    }

    summary.oauthStatesPurged = await purgeOAuthStates(now);
  } catch (error) {
    // The work list, or the purge: each step between them counts its own.
    summary.failed += 1;
    log.error("calendar watch run stopped before its end", {
      jobId: summary.runId,
      error: describeError(error),
    });
  }

  await report(summary, changes);
  return summary;
}

// -----------------------------------------------------------------------------
// The work list, and the order it is probed in
// -----------------------------------------------------------------------------

type WatchRow = {
  clinicId: string;
  connectionId: string;
  status: string;
  lastVerifiedAt: Date | null;
  brokenAt: Date | null;
  brokenAlertedAt: Date | null;
};

async function calendarConnections(): Promise<WatchRow[]> {
  const result = await unsafeDb.execute<{
    clinic_id: string;
    connection_id: string;
    status: string;
    last_verified_at: Date | string | null;
    broken_at: Date | string | null;
    broken_alerted_at: Date | string | null;
  }>(
    sql`select clinic_id, connection_id, status, last_verified_at, broken_at, broken_alerted_at
          from app_calendar_connections()`,
  );
  return result.rows.map((row) => ({
    clinicId: row.clinic_id,
    connectionId: row.connection_id,
    status: row.status,
    lastVerifiedAt: dateOf(row.last_verified_at),
    brokenAt: dateOf(row.broken_at),
    brokenAlertedAt: dateOf(row.broken_alerted_at),
  }));
}

function dateOf(value: Date | string | null): Date | null {
  if (value === null) return null;
  return value instanceof Date ? value : new Date(value);
}

/**
 * When this process last launched a probe of each connection, as a count of
 * launches. A run that runs out of time leaves the rest unprobed, and those
 * must go first next run (plan §9.2). Ordering by last_verified_at alone
 * does not do that: a probe that misses leaves last_verified_at where it
 * was, so through a long outage the same oldest rows would be launched first
 * every run and the rest never. In memory only, and that is enough: one
 * worker owns the clock, and after a restart the order starts again from
 * last_verified_at.
 */
const lastLaunch = new Map<string, number>();
let launches = 0;

/** Never launched by this process first, then least recently launched, then the oldest check. */
function launchOrder(rows: WatchRow[]): WatchRow[] {
  const listed = new Set(rows.map((row) => row.connectionId));
  for (const id of lastLaunch.keys()) if (!listed.has(id)) lastLaunch.delete(id);
  // A connection never verified sorts as verified at the epoch: first.
  return [...rows].sort(
    (a, b) =>
      (lastLaunch.get(a.connectionId) ?? 0) - (lastLaunch.get(b.connectionId) ?? 0) ||
      (a.lastVerifiedAt?.getTime() ?? 0) - (b.lastVerifiedAt?.getTime() ?? 0) ||
      a.connectionId.localeCompare(b.connectionId),
  );
}

// -----------------------------------------------------------------------------
// The probe
// -----------------------------------------------------------------------------

type Changes = {
  /** Breakages this run claimed the alert for: found by its probes, or told by its alert pass. */
  broken: { clinicId: string; connectionId: string; code: string }[];
  degraded: { clinicId: string; connectionId: string; code: string }[];
  recovered: { clinicId: string; connectionId: string }[];
  /** Probes that met healdesk's own setup refused, by code. */
  ours: Map<string, number>;
  /** Connections that refusal moved to `degraded`. */
  oursDegraded: number;
};

type RunState = {
  summary: CalendarWatchSummary;
  changes: Changes;
  options: CalendarWatchOptions;
};

/**
 * Sixteen lanes take the next connection until none is left or the launch
 * budget, counted from the first launch, is spent. Whatever was not launched
 * is counted as skipped.
 */
async function probeAll(due: WatchRow[], run: RunState): Promise<void> {
  const concurrency = Math.max(1, run.options.concurrency ?? PROBE_CONCURRENCY);
  const budgetMs = run.options.launchBudgetMs ?? PROBE_LAUNCH_BUDGET_MS;
  const started = Date.now();
  let next = 0;
  const lane = async (): Promise<void> => {
    while (next < due.length && Date.now() - started < budgetMs) {
      const row = due[next++]!;
      lastLaunch.set(row.connectionId, ++launches);
      await probeOne(row, run);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, due.length) }, lane));
  run.summary.skipped = due.length - next;
}

type Verdict =
  | { kind: "ok" }
  | { kind: "broken"; code: CalendarBreak }
  | { kind: "ours"; code: string }
  | { kind: "missed"; code: string };

/** One connection: open its token, ask Google, record the answer. Never throws. */
async function probeOne(row: WatchRow, run: RunState): Promise<void> {
  const ids = { clinicId: row.clinicId, connectionId: row.connectionId };
  try {
    const read = await readForProbe(row);
    // Swept, broken, disconnected or reconnected since the list was read.
    if (!read) return;
    run.summary.probed += 1;
    let verdict: Verdict;
    if (!read.context) {
      // A token this process cannot open now (the key, say) is a miss: three
      // in a row take the location to requests rather than to failing writes.
      verdict = { kind: "missed", code: "credential_unreadable" };
    } else {
      const answer = await probeGoogleToken(read.context);
      verdict = answer.ok ? { kind: "ok" } : verdictOf(answer.error);
    }
    await record(row, read.credentialVersion, verdict, run);
  } catch (error) {
    run.summary.failed += 1;
    log.error("calendar watch could not check a connection", {
      ...ids,
      error: describeError(error),
    });
  }
}

/** Owner decision 5's three classes, as calendarBreakOf and the adapter's reason words draw them. */
function verdictOf(error: ConnectorError): Verdict {
  const code = calendarBreakOf(error);
  if (code) return { kind: "broken", code };
  if (error.reason === "oauth_client" || error.reason === "api_disabled") {
    return { kind: "ours", code: error.reason };
  }
  const reason = error.reason;
  return {
    kind: "missed",
    code: reason && /^[A-Za-z0-9_]{1,40}$/.test(reason) ? reason : error.code,
  };
}

type ProbeRead = {
  /** The sealing of the token read, handed back with Google's answer. */
  credentialVersion: string;
  /** Null when the stored token could not be opened. */
  context: ConnectorContext | null;
};

/**
 * The connection's token and what the adapter needs, in one short tenant
 * transaction whose decrypt is audited with purpose `calendar_watch`. Null
 * when the row is no longer one to probe.
 */
async function readForProbe(target: WatchRow): Promise<ProbeRead | null> {
  return withTenant({ clinicId: target.clinicId, actor: WATCH_ACTOR }, async (tx) => {
    const row = await googleCalendarConnection(tx);
    if (
      !row ||
      row.id !== target.connectionId ||
      !PROBED.has(row.status) ||
      row.brokenAt !== null
    ) {
      return null;
    }
    tx.audit.record({
      action: "decrypt",
      resourceType: "credential",
      resourceId: row.id,
      metadata: { provider: GOOGLE_CALENDAR_PROVIDER, purpose: "calendar_watch" },
    });
    let refreshToken: string;
    try {
      refreshToken = await withCredentials(
        tx.db,
        { clinicId: tx.clinicId, connectionId: row.id },
        async (credentials) => credentials.refresh_token ?? "",
      );
    } catch (error) {
      log.error("calendar watch could not open a stored Google token", {
        clinicId: tx.clinicId,
        connectionId: row.id,
        error: describeError(error),
      });
      return { credentialVersion: row.credentialVersion, context: null };
    }
    return {
      credentialVersion: row.credentialVersion,
      context: {
        clinicId: tx.clinicId,
        connectionId: row.id,
        credentials: { refresh_token: refreshToken },
        metadata: row.metadata,
        oauthClient: googleOAuthClient(),
      },
    };
  });
}

// -----------------------------------------------------------------------------
// Recording an answer
// -----------------------------------------------------------------------------

async function record(
  row: WatchRow,
  credentialVersion: string,
  verdict: Verdict,
  run: RunState,
): Promise<void> {
  const { summary, changes } = run;
  const ids = { clinicId: row.clinicId, connectionId: row.connectionId };

  if (verdict.kind === "broken") {
    // Within a transaction of the watch's own, not markCalendarBroken, which
    // alerts ops once per breakage: the run's breakages are one alert (report).
    const code = verdict.code;
    const broken = await withTenant({ clinicId: row.clinicId, actor: WATCH_ACTOR }, (tx) =>
      markCalendarBrokenWithin(tx, {
        code,
        connectionId: row.connectionId,
        credentialVersion,
        actorLabel: WATCH_LABEL,
      }),
    );
    if (broken.status !== "broken") return;
    summary.broken += 1;
    if (broken.firstBreak) changes.broken.push({ ...ids, code });
    log.warn("calendar connection broken: the location takes booking requests", {
      ...ids,
      code,
      jobId: summary.runId,
    });
    if (broken.grant) {
      await revokeGoogleGrantIfUnused(broken.grant, { clinicId: row.clinicId, reason: code });
    }
    return;
  }

  const moved = await withTenant({ clinicId: row.clinicId, actor: WATCH_ACTOR }, async (tx) => {
    const current = await lockedConnection(tx, row.connectionId);
    // A row that was reconnected, disconnected or broken while Google was
    // being asked: the answer is about a token or a state it no longer has.
    if (
      !current ||
      current.credentialVersion !== credentialVersion ||
      !PROBED.has(current.status) ||
      current.brokenAt !== null
    ) {
      return null;
    }
    const where = and(
      eq(providerConnections.id, row.connectionId),
      eq(providerConnections.clinicId, tx.clinicId),
    );
    const at = new Date();

    if (verdict.kind === "ok") {
      await tx.db
        .update(providerConnections)
        .set({
          status: "active",
          lastVerifiedAt: at,
          transientFailures: 0,
          lastError: null,
          updatedAt: at,
        })
        .where(where);
      return { from: current.status, degraded: false, misses: 0 };
    }

    // Ours: degraded at once, the miss count left as it was. A miss: one
    // more, and the third in a row degrades. Once degraded, last_error
    // follows the latest word.
    const misses =
      verdict.kind === "missed"
        ? Math.min(current.transientFailures + 1, MISS_COUNT_CAP)
        : current.transientFailures;
    const degrades =
      current.status === "active" && (verdict.kind === "ours" || misses >= DEGRADE_AFTER_MISSES);
    const lastError = verdict.kind === "ours" ? HEALDESK_CONFIG : verdict.code;
    await tx.db
      .update(providerConnections)
      .set({
        transientFailures: misses,
        ...(degrades || current.status === "degraded"
          ? { status: "degraded" as const, lastError }
          : {}),
        updatedAt: at,
      })
      .where(where);
    if (degrades) await recordDegraded(tx, row.connectionId, verdict.code);
    return { from: current.status, degraded: degrades, misses };
  });
  if (!moved) return;

  if (verdict.kind === "ok") {
    summary.ok += 1;
    if (moved.from === "degraded") {
      summary.recovered += 1;
      changes.recovered.push(ids);
      log.info("calendar connection recovered", { ...ids, jobId: summary.runId });
    }
    return;
  }
  if (verdict.kind === "ours") {
    summary.ours += 1;
    changes.ours.set(verdict.code, (changes.ours.get(verdict.code) ?? 0) + 1);
  } else {
    summary.missed += 1;
  }
  if (!moved.degraded) return;
  summary.degraded += 1;
  // healdesk's own setup is one alert about every clinic (report), not one
  // per connection on top of it.
  if (verdict.kind === "ours") changes.oursDegraded += 1;
  else changes.degraded.push({ ...ids, code: verdict.code });
  log.warn("calendar connection degraded: the location takes booking requests", {
    ...ids,
    code: verdict.code,
    failures: moved.misses,
    jobId: summary.runId,
  });
}

/** The row as it is now, locked until this transaction ends. */
async function lockedConnection(tx: TenantTx, connectionId: string) {
  const [row] = await tx.db
    .select({
      status: providerConnections.status,
      credentialVersion: providerConnections.iv,
      brokenAt: providerConnections.brokenAt,
      transientFailures: providerConnections.transientFailures,
    })
    .from(providerConnections)
    .where(
      and(
        eq(providerConnections.id, connectionId),
        eq(providerConnections.clinicId, tx.clinicId),
        eq(providerConnections.provider, GOOGLE_CALENDAR_PROVIDER),
      ),
    )
    .limit(1)
    .for("update");
  return row ?? null;
}

/** One security event per degraded episode, in the transaction that degrades it. */
async function recordDegraded(tx: TenantTx, connectionId: string, code: string): Promise<void> {
  const [clinic] = await tx.db
    .select({ organizationId: clinics.organizationId })
    .from(clinics)
    .where(eq(clinics.id, tx.clinicId))
    .limit(1);
  await recordSecurityEvent(tx.db, {
    event: "calendar_degraded",
    actorLabel: WATCH_LABEL,
    organizationId: clinic?.organizationId ?? null,
    metadata: { clinicId: tx.clinicId, connectionId, code },
  });
}

// -----------------------------------------------------------------------------
// The alert pass, the purge and the report
// -----------------------------------------------------------------------------

/**
 * A breakage nobody has told the clinic about (plan §9.2 step 4): claimed
 * and told in one transaction, as markCalendarBrokenWithin tells its own;
 * ops hears of it in the run's `calendar_broken` alert. A row claimed
 * meanwhile, or reconnected, is left alone.
 */
async function alertUntold(row: WatchRow, run: RunState): Promise<void> {
  const { summary, changes } = run;
  const ids = { clinicId: row.clinicId, connectionId: row.connectionId };
  try {
    const code = await withTenant({ clinicId: row.clinicId, actor: WATCH_ACTOR }, async (tx) => {
      const current = await googleCalendarConnection(tx, { forUpdate: true });
      if (!current || current.id !== row.connectionId) return null;
      const word =
        current.lastError && /^[a-z_]{1,40}$/.test(current.lastError)
          ? current.lastError
          : "unknown";
      const claimed = await claimBreakageAlertWithin(tx, {
        connectionId: current.id,
        code: word,
        actorLabel: WATCH_LABEL,
      });
      return claimed ? word : null;
    });
    if (!code) return;
    summary.alerted += 1;
    changes.broken.push({ ...ids, code });
    log.warn("calendar breakage told: the location takes booking requests", {
      ...ids,
      code,
      jobId: summary.runId,
    });
  } catch (error) {
    summary.failed += 1;
    log.error("calendar watch could not tell a clinic its calendar broke", {
      ...ids,
      error: describeError(error),
    });
  }
}

/** Spent and abandoned sign-ins: single-use states with no clinic RLS (google_oauth_states). */
async function purgeOAuthStates(now: Date): Promise<number> {
  const purged = await unsafeDb
    .delete(googleOauthStates)
    .where(lt(googleOauthStates.createdAt, new Date(now.getTime() - OAUTH_STATE_KEEP_MS)))
    .returning({ clinicId: googleOauthStates.targetClinicId });
  return purged.length;
}

/**
 * A change alert's fields: with one connection, its ids; with more, how many
 * (the run's log lines name each one under the same `jobId`). The run's id
 * makes it this run's alert (see the module comment).
 */
function counted(list: readonly Record<string, string>[], runId: string): OpsFields {
  const about = list.length === 1 ? { ...list[0]!, count: 1 } : { count: list.length };
  return { ...about, jobId: runId };
}

/**
 * Ops once per run for each kind of change, and the security events that
 * belong to the run rather than to one connection. notifyOps never throws,
 * and an event that cannot be recorded is logged and left: the run's work is
 * done by now.
 */
async function report(summary: CalendarWatchSummary, changes: Changes): Promise<void> {
  const runId = summary.runId;
  if (changes.broken.length > 0) {
    await notifyOps("calendar_broken", counted(changes.broken, runId));
  }
  if (changes.degraded.length > 0) {
    await notifyOps("calendar_degraded", counted(changes.degraded, runId));
  }
  if (changes.recovered.length > 0) {
    await notifyOps("calendar_recovered", counted(changes.recovered, runId));
  }
  for (const [code, count] of changes.ours) {
    await notifyOps("google_oauth_client_rejected", { code, count });
  }
  if (summary.skipped > 0) {
    await notifyOps("calendar_watch_incomplete", { count: summary.skipped });
  }
  const failed = summary.failed + summary.sweep.failed;
  if (failed > 0) {
    await notifyOps("calendar_watch_failed", { count: failed });
  }

  const events: { event: string; metadata: Record<string, unknown> }[] = [];
  if (changes.oursDegraded > 0) {
    events.push({
      event: "google_oauth_client_rejected",
      metadata: { codes: [...changes.ours.keys()].join(","), degraded: changes.oursDegraded },
    });
  }
  if (summary.skipped > 0) {
    events.push({ event: "calendar_watch_incomplete", metadata: { skipped: summary.skipped } });
  }
  // Every run, changed or not (see the module comment).
  const { sweep, runId: jobId, ...counts } = summary;
  events.push({
    event: "calendar_watch",
    metadata: { ...counts, disconnected: sweep.disconnected, sweepFailed: sweep.failed, jobId },
  });
  for (const { event, metadata } of events) {
    try {
      await recordSecurityEvent(unsafeDb, { event, actorLabel: WATCH_LABEL, metadata });
    } catch (error) {
      log.error("calendar watch could not record a security event", {
        event,
        error: describeError(error),
      });
    }
  }

  log.info("calendar watch", {
    count: summary.connections,
    status: noteOf(summary),
    jobId: runId,
  });
}

function noteOf(s: CalendarWatchSummary): string {
  const parts = [
    `${s.connections} connection(s)`,
    `terms sweep disconnected ${s.sweep.disconnected}` +
      (s.sweep.failed ? ` (${s.sweep.failed} failed, not probed)` : ""),
    `probed ${s.probed}: ${s.ok} ok (${s.recovered} recovered), ${s.broken} broken, ` +
      `${s.missed} missed, ${s.ours} refused healdesk's Google setup; ${s.degraded} degraded`,
  ];
  if (s.skipped) parts.push(`${s.skipped} skipped, out of time`);
  if (s.failed) parts.push(`${s.failed} failed`);
  parts.push(`${s.alerted} breakage(s) told`, `${s.oauthStatesPurged} OAuth state(s) purged`);
  return `${parts.join("; ")}. Run ${s.runId}.`;
}
