import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  FAKE_GOOGLE_CLIENT,
  fakeGoogleCalendar,
  resetGoogleTokenCache,
  setGoogleFetch,
  setGoogleTimeouts,
  type FakeGoogleCalendar,
} from "@healdesk/connectors";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

import { unsafeDb } from "@/db";
import { effectiveBookingMode } from "@/lib/booking/mode";
import { chooseCalendar } from "@/lib/connections/google-calendar";
import { withCredentials } from "@/lib/connections/store";
import { QUEUE_CALENDAR_WATCH, QUEUES, startGuardedClock, type ClockBoss } from "@/lib/queue/boss";
import {
  CALENDAR_WATCH_CRON,
  CALENDAR_WATCH_RETRY_LIMIT,
  DEGRADE_AFTER_MISSES,
  HEALDESK_CONFIG,
  runCalendarWatchJob,
  watchCalendars,
} from "@/lib/scheduler/calendar-watch";
import { getJob, JOB_CALENDAR_WATCH } from "@/lib/scheduler/jobs";
import { withTenant } from "@/lib/tenant";

import { insertGoogleConnection } from "./setup/calendar-db";
import {
  closePools,
  getMigratorPool,
  hasTestDatabase,
  runMigrations,
  truncateAll,
} from "./setup/db";
import { inTenant, seedCalendarTerms, seedClinic, seedGoogleConnection } from "./setup/factories";

/**
 * The calendar watch (plan §9, owner decision 5) against the in-memory
 * Google: what each run asks Google, how each answer moves a connection,
 * and who is told. Never a live call: the global fetch throws.
 *
 * What the clinic and ops are told is captured. The clinic's email is the
 * funnel's notifyCalendarState, asked here whether the alert it is sent for
 * is already claimed in the transaction it was given and not yet outside
 * it: the addendum's "in the SAME transaction that claims broken_alerted_at".
 * Ops alerts also reach the real notifyOps when a test sets `realOps`, to
 * see what its hourly dedupe lets through; and a location in `failTerms` has
 * a terms check that throws.
 */
const notices = vi.hoisted(() => ({
  realOps: false,
  failTerms: new Set<string>(),
  calendar: [] as {
    clinicId: string;
    state: string;
    dedupeKey: string;
    claimedInside: boolean;
    claimedOutside: boolean;
  }[],
  ops: [] as { event: string; fields: Record<string, unknown> }[],
}));
vi.mock("@/lib/notices/calendar-state", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/notices/calendar-state")>();
  return {
    ...actual,
    notifyCalendarState: async (
      tx: import("@/db").Transaction,
      clinicId: string,
      state: "stopped" | "reconnected",
      opts: { dedupeKey: string },
    ) => {
      const { sql } = await import("drizzle-orm");
      const { inTenant: outside } = await import("./setup/factories");
      const inside = await tx.execute<{ claimed: boolean }>(
        sql`select broken_alerted_at is not null as claimed
              from provider_connections
             where clinic_id = ${clinicId}::uuid and provider = 'google_calendar'`,
      );
      const committed = await outside(clinicId, async (client) => {
        const result = await client.query<{ claimed: boolean }>(
          `select broken_alerted_at is not null as claimed
             from provider_connections
            where clinic_id = $1 and provider = 'google_calendar'`,
          [clinicId],
        );
        return result.rows;
      });
      notices.calendar.push({
        clinicId,
        state,
        dedupeKey: opts.dedupeKey,
        claimedInside: inside.rows[0]?.claimed === true,
        claimedOutside: committed[0]?.claimed === true,
      });
    },
  };
});
vi.mock("@/lib/ops/notify", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ops/notify")>();
  return {
    ...actual,
    notifyOps: async (event: string, fields: Record<string, unknown>) => {
      notices.ops.push({ event, fields });
      if (notices.realOps) await actual.notifyOps(event as never, fields as never);
    },
  };
});
vi.mock("@/lib/booking/terms", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/booking/terms")>();
  return {
    ...actual,
    calendarTermsFor: async (tx: import("@/lib/tenant").TenantTx) => {
      if (notices.failTerms.has(tx.clinicId)) throw new Error("terms unreadable (test)");
      return actual.calendarTermsFor(tx);
    },
  };
});

const describeDb = hasTestDatabase ? describe : describe.skip;
/** Every DB test seeds and seals over many round trips; a loaded runner needs room. */
const SLOW = 120_000;
const ACTOR = { type: "service", serviceName: "test" } as const;
const EVENTS_OWNED = "https://www.googleapis.com/auth/calendar.events.owned";

describe("the calendar watch's clock", () => {
  test("runs every five minutes on a queue of its own, which queue:install creates, as the job its migration seeds off", () => {
    expect(QUEUE_CALENDAR_WATCH).toBe("calendar-watch");
    expect(QUEUES).toContain(QUEUE_CALENDAR_WATCH);
    expect(CALENDAR_WATCH_CRON).toBe("*/5 * * * *");
    expect(JOB_CALENDAR_WATCH).toBe("calendar-watch");

    // Read migration A, whatever number it carries after a renumbering, not
    // the table: truncateAll() reseeds scheduled_jobs from tests/setup/db.ts.
    const drizzle = fileURLToPath(new URL("../drizzle/", import.meta.url));
    const file = readdirSync(drizzle).find((name) => /^\d{4}_google_calendar\.sql$/.test(name));
    expect(file, "migration A").toBeDefined();
    const insert = readFileSync(`${drizzle}${file}`, "utf8").match(
      /INSERT INTO scheduled_jobs[\s\S]*?ON CONFLICT \(name\) DO NOTHING;/i,
    )?.[0];
    const row = /\(\s*'([a-z-]+)'\s*,\s*'(?:[^']|'')*'\s*,\s*(true|false)\s*\)/gi;
    expect([...insert!.matchAll(row)].map((m) => [m[1], m[2]!.toLowerCase()])).toEqual([
      [JOB_CALENDAR_WATCH, "false"],
    ]);
  });

  test("a worker whose queue was never installed logs the fix and starts without it", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const boss: ClockBoss = {
        schedule: vi.fn(async () => {
          throw new Error("Queue calendar-watch not found");
        }),
        work: vi.fn(async () => "worker"),
      };
      await expect(
        startGuardedClock(boss, QUEUE_CALENDAR_WATCH, CALENDAR_WATCH_CRON, async () => {}),
      ).resolves.toBe(false);
      expect(boss.work).not.toHaveBeenCalled();
      expect(error).toHaveBeenCalledTimes(1);
      const line = String(error.mock.calls[0]![0]);
      expect(line).toMatch(/queue:install.*then restart the worker/);
      expect(line).toMatch(/calendar-watch/);
    } finally {
      error.mockRestore();
    }

    // And the worker registers the watch through that guard, every five
    // minutes, so a missing queue never takes the hourly tick down with it.
    const worker = readFileSync(
      fileURLToPath(new URL("../src/workers/index.ts", import.meta.url)),
      "utf8",
    );
    expect(worker).toMatch(
      /startGuardedClock\(\s*boss,\s*QUEUE_CALENDAR_WATCH,\s*CALENDAR_WATCH_CRON,\s*async \(\) => \{\s*const outcome = await runCalendarWatchJob\(\);[\s\S]*?\},\s*\{ retryLimit: CALENDAR_WATCH_RETRY_LIMIT \},\s*\);/,
    );
  });

  test("a failed run is never re-run at once by pg-boss: the next five-minute fire is the retry", async () => {
    // pg-boss's own default is two immediate retries, each forcing every
    // refresh again and counting another miss.
    expect(CALENDAR_WATCH_RETRY_LIMIT).toBe(0);
    const boss: ClockBoss = {
      schedule: vi.fn(async () => {}),
      work: vi.fn(async () => "worker"),
    };
    await expect(
      startGuardedClock(boss, QUEUE_CALENDAR_WATCH, CALENDAR_WATCH_CRON, async () => {}, {
        retryLimit: CALENDAR_WATCH_RETRY_LIMIT,
      }),
    ).resolves.toBe(true);
    expect(boss.schedule).toHaveBeenCalledWith(
      QUEUE_CALENDAR_WATCH,
      CALENDAR_WATCH_CRON,
      {},
      {
        tz: "UTC",
        retryLimit: 0,
      },
    );
  });
});

describeDb("the calendar watch", () => {
  const ENV = ["GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET"] as const;
  const saved: Record<string, string | undefined> = {};
  let google: FakeGoogleCalendar;
  let accounts = 0;

  beforeAll(async () => {
    await runMigrations();
    for (const key of ENV) saved[key] = process.env[key];
    process.env.GOOGLE_OAUTH_CLIENT_ID = FAKE_GOOGLE_CLIENT.clientId;
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = FAKE_GOOGLE_CLIENT.clientSecret;
    vi.stubGlobal("fetch", () => {
      throw new Error("live call attempted from the calendar watch tests");
    });
  }, 60_000);

  beforeEach(async () => {
    // Each test owns the whole work list: the watch walks every clinic.
    await truncateAll();
    notices.calendar.length = 0;
    notices.ops.length = 0;
    notices.realOps = false;
    notices.failTerms.clear();
    google = fakeGoogleCalendar();
    setGoogleFetch(google.fetch);
    resetGoogleTokenCache();
  }, 60_000);

  afterEach(() => {
    setGoogleFetch(undefined);
    setGoogleTimeouts(undefined);
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    for (const key of ENV) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    await closePools();
  });

  /** A location the watch probes: covered terms, and a live connection whose token the fake Google knows. */
  async function connectedLocation(label: string) {
    const clinic = await seedClinic(label);
    await seedCalendarTerms(clinic);
    const sub = `1${Date.now() % 1_000_000_000}${String(++accounts).padStart(6, "0")}`;
    google.addAccount({ sub, email: `${label}@radiance.test`, hd: "radiance.test" });
    const { refreshToken } = google.grant({ sub });
    const seeded = await seedGoogleConnection(clinic.clinicId, {
      refreshToken,
      accountRef: createHash("sha256").update(`google:${sub}`).digest("hex"),
    });
    return { ...clinic, ...seeded, sub, refreshToken };
  }

  async function connectionRow(clinicId: string) {
    return inTenant(clinicId, async (client) => {
      const { rows } = await client.query<{
        id: string;
        status: string;
        last_error: string | null;
        account_ref: string | null;
        transient_failures: number;
        last_verified_at: Date | null;
        broken_at: Date | null;
        broken_alerted_at: Date | null;
      }>(
        `select id, status, last_error, account_ref, transient_failures, last_verified_at,
                broken_at, broken_alerted_at
           from provider_connections where clinic_id = $1 and provider = 'google_calendar'`,
        [clinicId],
      );
      return rows[0]!;
    });
  }

  function bagOf(clinicId: string, connectionId: string) {
    return withTenant({ clinicId, actor: ACTOR }, (tx) =>
      withCredentials(tx.db, { clinicId, connectionId }, async (bag) => bag),
    );
  }

  async function securityEvents(event: string): Promise<Record<string, unknown>[]> {
    const { rows } = await getMigratorPool().query<{ metadata: Record<string, unknown> }>(
      `select metadata from security_events where event = $1 order by occurred_at`,
      [event],
    );
    return rows.map((row) => row.metadata);
  }

  async function decryptPurposes(clinicId: string, connectionId: string): Promise<unknown[]> {
    return inTenant(clinicId, async (client) => {
      const result = await client.query<{ purpose: unknown }>(
        `select metadata ->> 'purpose' as purpose from audit_log
          where clinic_id = $1 and action = 'decrypt' and resource_type = 'credential'
            and resource_id = $2
          order by occurred_at`,
        [clinicId, connectionId],
      );
      return result.rows.map((row) => row.purpose);
    });
  }

  /** The refresh tokens of the token requests made, in order. */
  function refreshesSent(): (string | null | undefined)[] {
    return google.requests
      .filter((request) => request.endpoint === "token")
      .map((request) => request.form?.get("refresh_token"));
  }

  async function modeReasons(clinicId: string): Promise<string[]> {
    return (await effectiveBookingMode(clinicId)).reasons.map((reason) => reason.code);
  }

  async function switchWatch(enabled: boolean, runningSince: Date | null = null): Promise<void> {
    await getMigratorPool().query(
      `update scheduled_jobs set enabled = $2, running_since = $3 where name = $1`,
      [JOB_CALENDAR_WATCH, enabled, runningSince],
    );
  }

  test(
    "switched off, it does nothing and asks Google nothing; on, a lock older than ten minutes is a crashed run's",
    async () => {
      await connectedLocation("watch-off");
      expect(await runCalendarWatchJob()).toEqual({ status: "disabled" });
      expect(google.requests).toEqual([]);
      expect((await getJob(JOB_CALENDAR_WATCH))?.lastRunStatus).toBe("disabled");

      // A run that started five minutes ago may still be running.
      await switchWatch(true, new Date(Date.now() - 5 * 60_000));
      expect((await runCalendarWatchJob()).status).toBe("already-running");
      expect(google.requests).toEqual([]);

      // Eleven minutes is past the watch's ten-minute lock, not runJob's hour.
      await switchWatch(true, new Date(Date.now() - 11 * 60_000));
      const outcome = await runCalendarWatchJob();
      expect(outcome).toMatchObject({ status: "ok", note: expect.stringMatching(/^1 connection/) });
      expect(google.tokenCalls).toBe(1);
      const job = await getJob(JOB_CALENDAR_WATCH);
      expect(job).toMatchObject({ lastRunStatus: "ok", runningSince: null });
    },
    SLOW,
  );

  test(
    "every run forces one refresh and one free/busy per connection, warm cache or not, and asks nothing else, not even the calendar's role",
    async () => {
      const a = await connectedLocation("watch-a");
      const b = await connectedLocation("watch-b");
      // verify() would refuse a calendar the account is not owner of; the
      // probe never asks.
      google.setAccessRole(b.sub, "freeBusyReader");
      await switchWatch(true);

      let before = (await connectionRow(a.clinicId)).last_verified_at!;
      for (const run of [1, 2]) {
        google.clearRequests();
        // The second run finds the first run's access tokens cached, and
        // refreshes anyway.
        expect(await runCalendarWatchJob(), `run ${run}`).toMatchObject({ status: "ok" });
        expect(google.requests.map((request) => request.endpoint).sort(), `run ${run}`).toEqual([
          "freeBusy",
          "freeBusy",
          "token",
          "token",
        ]);
        expect(
          google.requests
            .filter((request) => request.endpoint === "token")
            .map((request) => request.form?.get("grant_type")),
        ).toEqual(["refresh_token", "refresh_token"]);
        expect(refreshesSent().sort()).toEqual([a.refreshToken, b.refreshToken].sort());

        const row = await connectionRow(a.clinicId);
        expect(row).toMatchObject({ status: "active", transient_failures: 0, last_error: null });
        expect(row.last_verified_at!.getTime()).toBeGreaterThan(before.getTime());
        before = row.last_verified_at!;
        expect(await connectionRow(b.clinicId)).toMatchObject({ status: "active" });
      }
      expect(google.eventsListCalls + google.calendarListCalls + google.getCalls).toBe(0);
      // Every token the watch opened, it opened on the record, and for this.
      expect(await decryptPurposes(a.clinicId, a.connectionId)).toEqual([
        "calendar_watch",
        "calendar_watch",
      ]);
      expect(notices.calendar).toEqual([]);
      expect(notices.ops).toEqual([]);
      // A run that changed nothing still leaves its security event, each with
      // its own run id.
      const runs = await securityEvents("calendar_watch");
      expect(runs).toHaveLength(2);
      expect(runs[0]).toMatchObject({ connections: 2, probed: 2, ok: 2, failed: 0 });
      expect(new Set(runs.map((run) => run.jobId)).size).toBe(2);
    },
    SLOW,
  );

  test(
    "each definitive answer of decision 5 takes the location to requests within one run, and the clinic and ops are told once",
    async () => {
      const cases: {
        code: string;
        breakIt: (location: Awaited<ReturnType<typeof connectedLocation>>) => void;
        tokenLevel: boolean;
      }[] = [
        {
          code: "invalid_grant",
          breakIt: (l) => google.revokeRefreshToken(l.refreshToken),
          tokenLevel: true,
        },
        {
          code: "admin_policy_enforced",
          breakIt: (l) => google.restrictByAdmin(l.sub),
          tokenLevel: true,
        },
        {
          code: "scope_lost",
          breakIt: (l) => google.dropScope(l.refreshToken, EVENTS_OWNED),
          tokenLevel: true,
        },
        // 401 to a token minted for this very probe.
        {
          code: "access_denied",
          breakIt: () => google.failNext({ on: "freeBusy", status: 401 }),
          tokenLevel: false,
        },
        {
          code: "insufficient_permissions",
          breakIt: () => google.failNext({ on: "freeBusy", status: 403, reason: "forbidden" }),
          tokenLevel: false,
        },
        {
          code: "calendar_not_found",
          breakIt: () => google.failNext({ on: "freeBusy", status: 404, reason: "notFound" }),
          tokenLevel: false,
        },
        // Free/busy answers 200 and says, of the calendar, notFound.
        {
          code: "calendar_not_found",
          breakIt: () => google.failNext({ on: "freeBusy", calendarError: "notFound" }),
          tokenLevel: false,
        },
      ];

      const broken: string[] = [];
      for (const [index, { code, breakIt, tokenLevel }] of cases.entries()) {
        // Every earlier case's location is broken by now, so this run probes
        // this one location and no other.
        const location = await connectedLocation(`watch-break-${index}`);
        expect(await modeReasons(location.clinicId)).not.toContain("calendar_broken");
        breakIt(location);
        const opsBefore = notices.ops.length;
        const noticesBefore = notices.calendar.length;

        const summary = await watchCalendars();
        expect(summary, code).toMatchObject({ probed: 1, broken: 1, ok: 0, degraded: 0 });

        const row = await connectionRow(location.clinicId);
        expect(row, code).toMatchObject({
          status: tokenLevel ? "revoked" : "error",
          last_error: code,
          account_ref: location.accountRef,
        });
        expect(row.broken_at, code).toBeInstanceOf(Date);
        expect(row.broken_alerted_at, code).toBeInstanceOf(Date);
        // A token-level answer erases the token; a calendar's refusal keeps it.
        expect(await bagOf(location.clinicId, location.connectionId), code).toEqual(
          tokenLevel ? {} : { refresh_token: location.refreshToken },
        );
        expect((await effectiveBookingMode(location.clinicId)).mode, code).toBe("requests");
        expect(await modeReasons(location.clinicId), code).toContain(
          tokenLevel ? "calendar_not_connected" : "calendar_broken",
        );

        const dedupeKey = `calendar-stopped:${location.connectionId}:${row.broken_at!.getTime()}`;
        expect(notices.calendar.slice(noticesBefore), code).toEqual([
          {
            clinicId: location.clinicId,
            state: "stopped",
            dedupeKey,
            claimedInside: true,
            claimedOutside: false,
          },
        ]);
        expect(notices.ops.slice(opsBefore), code).toEqual([
          {
            event: "calendar_broken",
            fields: {
              clinicId: location.clinicId,
              connectionId: location.connectionId,
              code,
              count: 1,
              jobId: summary.runId,
            },
          },
        ]);
        broken.push(location.refreshToken);
      }

      // A grant that lost a scope is revoked at Google, since no location
      // holds it live any more; a grant Google already ended needs nothing.
      const scopeLost = cases.findIndex((c) => c.code === "scope_lost");
      expect(google.grantOf(broken[scopeLost]!)?.revoked).toBe(true);
      expect(google.revokeCalls).toBe(1);
      expect(await securityEvents("calendar_broken")).toHaveLength(cases.length);

      // The next run asks Google nothing about them and tells nobody again.
      google.clearRequests();
      const again = await watchCalendars();
      expect(again).toMatchObject({ probed: 0, broken: 0, alerted: 0 });
      expect(google.requests).toEqual([]);
      expect(notices.calendar).toHaveLength(cases.length);
      expect(notices.ops).toHaveLength(cases.length);
    },
    SLOW,
  );

  test(
    "one or two misses leave the location live; the third degrades it, with ops told and the clinic not; the first good answer brings it back",
    async () => {
      const location = await connectedLocation("watch-miss");
      const ids = { clinicId: location.clinicId, connectionId: location.connectionId };

      google.failNext({ on: "token", status: 503 });
      expect(await watchCalendars()).toMatchObject({ probed: 1, missed: 1, degraded: 0 });
      expect(await connectionRow(location.clinicId)).toMatchObject({
        status: "active",
        transient_failures: 1,
        last_error: null,
      });

      google.failNext({ on: "freeBusy", status: 429, reason: "rateLimitExceeded" });
      expect(await watchCalendars()).toMatchObject({ missed: 1, degraded: 0 });
      expect(await connectionRow(location.clinicId)).toMatchObject({
        status: "active",
        transient_failures: 2,
      });
      expect(notices.ops).toEqual([]);
      expect(await modeReasons(location.clinicId)).not.toContain("calendar_degraded");

      // The third miss in a row: a refresh that never answers.
      setGoogleTimeouts({ refresh: 50 });
      google.hangNext("token");
      const third = await watchCalendars();
      expect(third).toMatchObject({ missed: 1, degraded: 1 });
      expect(await connectionRow(location.clinicId)).toMatchObject({
        status: "degraded",
        transient_failures: DEGRADE_AFTER_MISSES,
        last_error: "timeout",
      });
      expect(await modeReasons(location.clinicId)).toContain("calendar_degraded");
      expect(notices.ops).toEqual([
        {
          event: "calendar_degraded",
          fields: { ...ids, code: "timeout", count: 1, jobId: third.runId },
        },
      ]);
      expect(notices.calendar).toEqual([]);
      expect(await securityEvents("calendar_degraded")).toEqual([{ ...ids, code: "timeout" }]);
      // Still holding its token: a miss is never a reason to erase one.
      expect(await bagOf(location.clinicId, location.connectionId)).toEqual({
        refresh_token: location.refreshToken,
      });

      // Missing again while degraded tells nobody again.
      google.failNext({ on: "freeBusy", status: 500 });
      expect(await watchCalendars()).toMatchObject({ missed: 1, degraded: 0 });
      expect(await connectionRow(location.clinicId)).toMatchObject({
        status: "degraded",
        transient_failures: 4,
      });
      expect(notices.ops).toHaveLength(1);

      const back = await watchCalendars();
      expect(back).toMatchObject({ ok: 1, recovered: 1 });
      expect(await connectionRow(location.clinicId)).toMatchObject({
        status: "active",
        transient_failures: 0,
        last_error: null,
      });
      expect(await modeReasons(location.clinicId)).not.toContain("calendar_degraded");
      expect(notices.ops.slice(1)).toEqual([
        { event: "calendar_recovered", fields: { ...ids, count: 1, jobId: back.runId } },
      ]);
      expect(notices.calendar).toEqual([]);
    },
    SLOW,
  );

  test(
    "healdesk's own Google setup refused degrades at once, keeps every token, and tells ops alone, once a run",
    async () => {
      const first = await connectedLocation("watch-ours-a");
      google.failNext({ on: "freeBusy", status: 403, reason: "accessNotConfigured" });
      expect(await watchCalendars()).toMatchObject({ ours: 1, degraded: 1, broken: 0 });
      expect(await connectionRow(first.clinicId)).toMatchObject({
        status: "degraded",
        last_error: HEALDESK_CONFIG,
        transient_failures: 0,
      });
      expect(notices.ops).toEqual([
        { event: "google_oauth_client_rejected", fields: { code: "api_disabled", count: 1 } },
      ]);

      // The OAuth client deleted in Google Cloud: every probe meets it.
      const second = await connectedLocation("watch-ours-b");
      google.deleteClient();
      expect(await watchCalendars()).toMatchObject({ ours: 2, degraded: 1 });
      for (const location of [first, second]) {
        expect(await connectionRow(location.clinicId)).toMatchObject({
          status: "degraded",
          last_error: HEALDESK_CONFIG,
        });
        expect(await bagOf(location.clinicId, location.connectionId)).toEqual({
          refresh_token: location.refreshToken,
        });
      }
      expect(notices.ops.slice(1)).toEqual([
        { event: "google_oauth_client_rejected", fields: { code: "oauth_client", count: 2 } },
      ]);
      expect(notices.calendar).toEqual([]);
      // One security event per run that degraded someone, and one degraded
      // episode for each location.
      expect(await securityEvents("google_oauth_client_rejected")).toEqual([
        { codes: "api_disabled", degraded: 1 },
        { codes: "oauth_client", degraded: 1 },
      ]);
      expect((await securityEvents("calendar_degraded")).map((m) => m.code)).toEqual([
        "api_disabled",
        "oauth_client",
      ]);
    },
    SLOW,
  );

  test(
    "terms that no longer cover a calendar, a changed account kind, or offboarding: disconnected before any token is opened",
    async () => {
      // No agreement in effect.
      const none = await seedClinic("watch-terms-none");
      await seedGoogleConnection(none.clinicId);
      // A booking system that does not read Google: the clause is not_used.
      const notUsed = await seedClinic("watch-terms-not-used");
      await seedCalendarTerms(notUsed, { bookingSystem: "mindbody" });
      await seedGoogleConnection(notUsed.clinicId);
      // A legacy signer, who has elected nothing.
      const legacy = await seedClinic("watch-terms-legacy");
      await getMigratorPool().query(
        `insert into baa_acceptances
           (id, organization_id, document_version, document_hash, rendered_text, variables,
            assent_label, accepted_by_name, accepted_by_email, accepted_at, bound_at)
         values ($1, $2, '1.2.1', $3, 'BAA (synthetic)',
                 '{"appliedClauses":["parties"],"clinicLegalName":"Radiance Synthetic LLC"}'::jsonb,
                 'I agree', 'Alex Chen', 'alex@radiance.test', now(), now())`,
        [randomUUID(), legacy.organizationId, randomBytes(32).toString("hex")],
      );
      await seedGoogleConnection(legacy.clinicId);
      // Covered terms, but a personal account.
      const mismatch = await seedClinic("watch-terms-mismatch");
      await seedCalendarTerms(mismatch);
      await seedGoogleConnection(mismatch.clinicId, { managed: false });
      // Leaving.
      const leaving = await seedClinic("watch-terms-leaving");
      await seedCalendarTerms(leaving);
      await seedGoogleConnection(leaving.clinicId);
      await getMigratorPool().query(
        `update clinics set offboarding_started_at = now() where id = $1`,
        [leaving.clinicId],
      );

      const summary = await watchCalendars();
      expect(summary).toMatchObject({
        connections: 5,
        sweep: { checked: 5, disconnected: 5, failed: 0 },
        probed: 0,
      });
      for (const [clinic, reason] of [
        [none, "terms_ended"],
        [notUsed, "terms_ended"],
        [legacy, "terms_ended"],
        [mismatch, "election_changed"],
        [leaving, "offboarding"],
      ] as const) {
        expect(await connectionRow(clinic.clinicId), reason).toMatchObject({
          status: "revoked",
          last_error: reason,
          broken_at: null,
        });
      }
      // Nothing was refreshed or probed; the only calls were the revocations
      // of grants no location holds any more.
      expect(google.tokenCalls + google.freeBusyCalls).toBe(0);
      expect(new Set(google.requests.map((request) => request.endpoint))).toEqual(
        new Set(["revoke"]),
      );
      // Taken away on purpose: nobody is told Google took it.
      expect(notices.calendar).toEqual([]);
      expect(notices.ops).toEqual([]);
    },
    SLOW,
  );

  test(
    "with more connections than run at once every one is probed; out of time, the rest are counted, reported and go first next run",
    async () => {
      const locations = [];
      for (const n of [1, 2, 3, 4, 5]) locations.push(await connectedLocation(`watch-many-${n}`));

      const all = await watchCalendars({ concurrency: 2 });
      expect(all).toMatchObject({ probed: 5, ok: 5, skipped: 0 });
      expect(google.tokenCalls).toBe(5);
      expect(google.freeBusyCalls).toBe(5);

      // The first two refreshes hang past their timeout, and the run stops
      // launching before they give up.
      google.clearRequests();
      setGoogleTimeouts({ refresh: 300 });
      google.hangNext("token", 2);
      const cut = await watchCalendars({ concurrency: 2, launchBudgetMs: 150 });
      expect(cut).toMatchObject({ probed: 2, missed: 2, skipped: 3 });
      const launched = new Set(refreshesSent());
      expect(launched.size).toBe(2);
      expect(notices.ops).toEqual([{ event: "calendar_watch_incomplete", fields: { count: 3 } }]);
      expect(await securityEvents("calendar_watch_incomplete")).toEqual([{ skipped: 3 }]);

      // The three left out go first next time.
      google.clearRequests();
      setGoogleTimeouts(undefined);
      expect(await watchCalendars({ concurrency: 1 })).toMatchObject({ probed: 5, ok: 5 });
      const order = refreshesSent();
      const skipped = locations
        .map((location) => location.refreshToken)
        .filter((token) => !launched.has(token));
      expect(new Set(order.slice(0, 3))).toEqual(new Set(skipped));
    },
    SLOW,
  );

  test(
    "a breakage nobody told the clinic about is told once, by the alert pass, in the transaction that claims it",
    async () => {
      const clinic = await seedClinic("watch-untold");
      const brokenAt = new Date(Date.now() - 60_000);
      const { id } = await insertGoogleConnection(clinic.clinicId, {
        managed: true,
        status: "revoked",
        brokenAt,
      });
      await inTenant(clinic.clinicId, async (client) => {
        await client.query(
          `update provider_connections set last_error = 'invalid_grant' where id = $1`,
          [id],
        );
      });

      const told = await watchCalendars();
      expect(told).toMatchObject({ connections: 1, probed: 0, alerted: 1 });
      expect(notices.calendar).toEqual([
        {
          clinicId: clinic.clinicId,
          state: "stopped",
          dedupeKey: `calendar-stopped:${id}:${brokenAt.getTime()}`,
          claimedInside: true,
          claimedOutside: false,
        },
      ]);
      expect(notices.ops).toEqual([
        {
          event: "calendar_broken",
          fields: {
            clinicId: clinic.clinicId,
            connectionId: id,
            code: "invalid_grant",
            count: 1,
            jobId: told.runId,
          },
        },
      ]);
      expect(await securityEvents("calendar_broken")).toEqual([
        { clinicId: clinic.clinicId, connectionId: id, code: "invalid_grant" },
      ]);
      expect((await connectionRow(clinic.clinicId)).broken_alerted_at).toBeInstanceOf(Date);
      expect(google.requests).toEqual([]);

      // Told: off the work list.
      expect(await watchCalendars()).toMatchObject({ connections: 0, alerted: 0 });
      expect(notices.calendar).toHaveLength(1);
      expect(notices.ops).toHaveLength(1);
    },
    SLOW,
  );

  test(
    "a location whose calendar is whole again is watched as new, and its next breakage is a new episode, told again",
    async () => {
      const location = await connectedLocation("watch-again");
      google.failNext({ on: "freeBusy", status: 403, reason: "forbidden" });
      await watchCalendars();
      const first = await connectionRow(location.clinicId);
      expect(first).toMatchObject({ status: "error", last_error: "insufficient_permissions" });

      // The clinic chooses its calendar again, which passes verify(): whole.
      expect(await chooseCalendar(location.clinicId, "primary")).toMatchObject({
        status: "chosen",
      });
      expect(await connectionRow(location.clinicId)).toMatchObject({
        status: "active",
        broken_at: null,
        broken_alerted_at: null,
      });
      expect(notices.calendar.map((notice) => notice.state)).toEqual(["stopped", "reconnected"]);

      expect(await watchCalendars()).toMatchObject({ probed: 1, ok: 1 });
      expect(notices.calendar).toHaveLength(2);

      google.revokeRefreshToken(location.refreshToken);
      await watchCalendars();
      const second = await connectionRow(location.clinicId);
      expect(second).toMatchObject({ status: "revoked", last_error: "invalid_grant" });
      expect(notices.calendar.map((notice) => notice.state)).toEqual([
        "stopped",
        "reconnected",
        "stopped",
      ]);
      expect(notices.calendar[2]!.dedupeKey).toBe(
        `calendar-stopped:${location.connectionId}:${second.broken_at!.getTime()}`,
      );
      expect(notices.calendar[2]!.dedupeKey).not.toBe(notices.calendar[0]!.dedupeKey);
      expect(notices.ops.map((alert) => alert.event)).toEqual([
        "calendar_broken",
        "calendar_broken",
      ]);
    },
    SLOW,
  );

  test(
    "Google sign-in states older than a day are purged, and fresh ones kept",
    async () => {
      const clinic = await seedClinic("watch-states");
      const insertState = (age: string) =>
        getMigratorPool().query(
          `insert into google_oauth_states
             (state_hash, target_clinic_id, initiated_via, user_id, return_to,
              browser_binding_hash, disclosure_version, disclosure_sha256, disclosure_accepted_at,
              created_at, expires_at)
           values ($1, $2, 'portal', $3, 'portal', $4, 'google-calendar-disclosure/1', $5,
                   now() - $6::interval, now() - $6::interval,
                   now() - $6::interval + interval '15 minutes')`,
          [
            randomBytes(32),
            clinic.clinicId,
            clinic.staffUserId,
            randomBytes(32),
            randomBytes(32),
            age,
          ],
        );
      await insertState("2 days");
      await insertState("10 minutes");

      expect(await watchCalendars()).toMatchObject({ oauthStatesPurged: 1 });
      const { rows } = await getMigratorPool().query<{ n: number }>(
        `select count(*)::int as n from google_oauth_states where target_clinic_id = $1`,
        [clinic.clinicId],
      );
      expect(rows[0]!.n).toBe(1);
    },
    SLOW,
  );

  test(
    "breakages found and told in one run are one counted alert to ops, and each clinic is told its own",
    async () => {
      const revoked = await connectedLocation("watch-batch-revoked");
      const forbidden = await connectedLocation("watch-batch-forbidden");
      const untold = await seedClinic("watch-batch-untold");
      await insertGoogleConnection(untold.clinicId, {
        managed: true,
        status: "revoked",
        brokenAt: new Date(Date.now() - 60_000),
      });
      google.revokeRefreshToken(revoked.refreshToken);
      // The only free/busy asked: the revoked grant never gets past its refresh.
      google.failNext({ on: "freeBusy", status: 403, reason: "forbidden" });

      const summary = await watchCalendars();
      expect(summary).toMatchObject({ probed: 2, broken: 2, alerted: 1 });
      // One email for the run, not one per clinic; its log lines name each.
      expect(notices.ops).toEqual([
        { event: "calendar_broken", fields: { count: 3, jobId: summary.runId } },
      ]);
      expect(notices.calendar.map((notice) => notice.clinicId).sort()).toEqual(
        [revoked.clinicId, forbidden.clinicId, untold.clinicId].sort(),
      );
      for (const notice of notices.calendar) {
        expect(notice).toMatchObject({
          state: "stopped",
          claimedInside: true,
          claimedOutside: false,
        });
      }
      expect(await securityEvents("calendar_broken")).toHaveLength(3);
    },
    SLOW,
  );

  test(
    "a run that throws after its probes still tells ops what changed, is recorded failed, and is not re-run",
    async () => {
      const location = await connectedLocation("watch-throws");
      google.revokeRefreshToken(location.refreshToken);
      await switchWatch(true);
      // The last step, the purge, throws: the breakage before it has committed,
      // and the next run will not see it as a change.
      const purge = vi.spyOn(unsafeDb, "delete").mockImplementation(() => {
        throw new Error("purge failed (test)");
      });
      const outcome = await runCalendarWatchJob().finally(() => purge.mockRestore());

      expect(outcome).toMatchObject({
        status: "failed",
        note: expect.stringMatching(/1 broken[\s\S]*1 failed/),
      });
      expect((await getJob(JOB_CALENDAR_WATCH))?.lastRunStatus).toBe("failed");
      expect(notices.ops).toEqual([
        {
          event: "calendar_broken",
          fields: {
            clinicId: location.clinicId,
            connectionId: location.connectionId,
            code: "invalid_grant",
            count: 1,
            jobId: expect.any(String),
          },
        },
        { event: "calendar_watch_failed", fields: { count: 1 } },
      ]);
      expect(notices.calendar).toHaveLength(1);
      expect(await securityEvents("calendar_watch")).toEqual([
        expect.objectContaining({ broken: 1, failed: 1 }),
      ]);
    },
    SLOW,
  );

  test(
    "a location whose terms check throws is not probed, its token left sealed, and the run fails with ops told",
    async () => {
      const unreadable = await connectedLocation("watch-terms-throw");
      const fine = await connectedLocation("watch-terms-fine");
      notices.failTerms.add(unreadable.clinicId);

      const summary = await watchCalendars();
      expect(summary).toMatchObject({
        sweep: { checked: 1, disconnected: 0, failed: 1, failedClinicIds: [unreadable.clinicId] },
        probed: 1,
        ok: 1,
      });
      expect(refreshesSent()).toEqual([fine.refreshToken]);
      expect(await decryptPurposes(unreadable.clinicId, unreadable.connectionId)).toEqual([]);
      expect(await connectionRow(unreadable.clinicId)).toMatchObject({
        status: "active",
        transient_failures: 0,
      });
      expect(notices.ops).toEqual([{ event: "calendar_watch_failed", fields: { count: 1 } }]);

      // Through the job, such a run is recorded failed…
      await switchWatch(true);
      expect(await runCalendarWatchJob()).toMatchObject({
        status: "failed",
        note: expect.stringMatching(/1 failed, not probed/),
      });
      expect((await getJob(JOB_CALENDAR_WATCH))?.lastRunStatus).toBe("failed");

      // …until the check reads again, and both are probed.
      notices.failTerms.clear();
      google.clearRequests();
      expect(await runCalendarWatchJob()).toMatchObject({ status: "ok" });
      expect(refreshesSent().sort()).toEqual([unreadable.refreshToken, fine.refreshToken].sort());
    },
    SLOW,
  );

  test(
    "a second wave of degradations, or a connection degrading again after it recovered, is a new ops alert inside the hour",
    async () => {
      // The real notifyOps, which sends an identical alert once an hour; no
      // ops address, so nothing is mailed.
      vi.stubEnv("HEALDESK_OPS_EMAIL", "");
      vi.stubEnv("HEALDESK_ADMIN_EMAIL", "");
      vi.spyOn(console, "error").mockImplementation(() => {});
      vi.spyOn(console, "warn").mockImplementation(() => {});
      await getMigratorPool().query(`truncate ops_alerts`);
      notices.realOps = true;
      try {
        const missedTwice = (...locations: { clinicId: string; connectionId: string }[]) =>
          Promise.all(
            locations.map((location) =>
              inTenant(location.clinicId, (client) =>
                client.query(
                  `update provider_connections set transient_failures = 2 where id = $1`,
                  [location.connectionId],
                ),
              ),
            ),
          );
        const first = await connectedLocation("watch-wave-a");
        // One connection: degraded, recovered, degraded again.
        for (let round = 0; round < 2; round += 1) {
          await missedTwice(first);
          google.failNext({ on: "token", status: 503 });
          expect(await watchCalendars(), `round ${round}`).toMatchObject({ degraded: 1 });
          expect(await watchCalendars(), `round ${round}`).toMatchObject({ recovered: 1 });
        }
        // Two connections, in two waves.
        const second = await connectedLocation("watch-wave-b");
        for (let round = 0; round < 2; round += 1) {
          await missedTwice(first, second);
          google.failNext({ on: "token", status: 503, times: 2 });
          expect(await watchCalendars(), `wave ${round}`).toMatchObject({ degraded: 2 });
          expect(await watchCalendars(), `wave ${round}`).toMatchObject({ recovered: 2 });
        }

        const { rows } = await getMigratorPool().query<{ event: string; repeats: number }>(
          `select event, repeats from ops_alerts
            where event in ('calendar_degraded', 'calendar_recovered')
            order by raised_at, id`,
        );
        const pair = [
          { event: "calendar_degraded", repeats: 0 },
          { event: "calendar_recovered", repeats: 0 },
        ];
        expect(rows).toEqual([...pair, ...pair, ...pair, ...pair]);
      } finally {
        notices.realOps = false;
        vi.unstubAllEnvs();
        vi.restoreAllMocks();
        await getMigratorPool().query(`truncate ops_alerts`);
      }
    },
    SLOW,
  );
});
