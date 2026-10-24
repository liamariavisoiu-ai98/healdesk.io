import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

import { setupLastDay } from "@/lib/clinic/setup-window";
import { IGNORED_RECOMMENDATION } from "@/lib/lifecycle/recommend";
import { watchLifecycles } from "@/lib/lifecycle/watch";
import { isMutating, runOperation, type Operator } from "@/lib/ops/api";
import { collectDigest } from "@/lib/ops/digest";
import { opsAlertsSource } from "@/lib/ops/inbox/ops-alerts";
import { readOpsInbox } from "@/lib/ops/inbox/run";
import { reconcileBilling } from "@/lib/billing/reconcile";
import { runConnectionHealthJob } from "@/lib/scheduler/connection-health";
import { JOB_CONNECTION_HEALTH, setJobEnabled } from "@/lib/scheduler/jobs";
import { SETUP_SCREENS } from "@/lib/setup/screen-ids";

import { closePools, getAppPool, getMigratorPool, hasTestDatabase, runMigrations, truncateAll } from "./setup/db";
import { seedLifecycleRow } from "./setup/audit-lifecycle-seeds";
import { inTenant } from "./setup/factories";
import { provisionPortalClinic, type PortalClinic } from "./setup/portal-clinic";

/**
 * Lane P5d: the lifecycle watch's ignore list (healdesk's own test accounts)
 * and "Extend the setup window" stamping the lifecycle row. An ignored
 * clinic is absent from the watch, its waves, Home's decision rows, the
 * digest's Lifecycle block and the recommendation, and its real problems
 * still alert; taking it off the list restores it. An extension clears the
 * "decision owed" row at once, with the watch never run. Resend is stubbed;
 * the clock is the test's.
 */

// The race of finding 6: a hook run inside the watch's transaction, right
// after it read the setup state and before it locks the lifecycle row.
const race = vi.hoisted(() => ({ afterStateRead: null as null | (() => Promise<void>) }));
vi.mock("@/lib/setup/state", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/setup/state")>();
  return {
    ...actual,
    readSetupState: async (...args: Parameters<typeof actual.readSetupState>) => {
      const state = await actual.readSetupState(...args);
      const hook = race.afterStateRead;
      race.afterStateRead = null;
      if (hook) await hook();
      return state;
    },
  };
});

// N2: the clinic list fails for the next read only (the ignore list's), so
// the alerts source's own name lookup still works.
const clinicList = vi.hoisted(() => ({ failNext: false }));
vi.mock("@/lib/ops/clinics", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ops/clinics")>();
  return {
    ...actual,
    listClinics: async (...args: Parameters<typeof actual.listClinics>) => {
      if (clinicList.failNext) {
        clinicList.failNext = false;
        throw new Error("synthetic read failure");
      }
      return actual.listClinics(...args);
    },
  };
});

const send = vi.fn();
vi.mock("resend", () => ({
  Resend: class {
    emails = { send };
  },
}));

const describeDb = hasTestDatabase ? describe : describe.skip;
const OPERATOR: Operator = { email: "ops@healdesk.test", request: {} };
const DAY = 86_400_000;
const HOUR = 3_600_000;
const NOON = new Date("2026-10-20T16:00:00Z");
const ZONE = "America/New_York";
const ENV = ["HEALDESK_EMAIL_TRANSPORT", "RESEND_API_KEY", "HEALDESK_EMAIL_FROM", "HEALDESK_OPS_EMAIL", "BETTER_AUTH_URL", "HEALDESK_CONSOLE_ORIGIN", "SLACK_WEBHOOK_URL"] as const;
const SAVED: Record<string, string | undefined> = {};

/** The deadline that makes noon in New York fall on window day `day`. */
const deadlineFor = (day: number) => new Date(NOON.getTime() + (31 - day) * DAY - 11 * HOUR);

async function clinic(label: string, options: { day: number; screens?: number }): Promise<PortalClinic> {
  const c = await provisionPortalClinic(`${label}-${randomUUID().slice(0, 4)}`, { plan: "voice-metachat-1000-1000" });
  await getMigratorPool().query(`update clinics set timezone = $2 where id = $1`, [c.clinicId, ZONE]);
  await inTenant(c.clinicId, async (q) => {
    // A paying clinic in setup (its Stripe customer and subscription), as every real one is until it goes live.
    await q.query(
      `update entitlements set stripe_customer_id = $2, stripe_subscription_id = $3, setup_deadline_at = $4, status = 'active' where clinic_id = $1`,
      [c.clinicId, `cus_test_${randomUUID().slice(0, 8)}`, `sub_test_${randomUUID().slice(0, 8)}`, deadlineFor(options.day)],
    );
    for (const screen of SETUP_SCREENS.slice(0, options.screens ?? 0)) {
      await q.query(
        `insert into clinic_setup_screens (clinic_id, screen, outcome, at, actor_label) values ($1, $2, 'skipped', $3, 'test')`,
        [c.clinicId, screen, new Date(NOON.getTime() - 8 * DAY)],
      );
    }
  });
  return c;
}

async function lifecycleRow(c: PortalClinic) {
  return inTenant(c.clinicId, async (q) => (await q.query(`select * from clinic_lifecycle where clinic_id = $1`, [c.clinicId])).rows[0] ?? null);
}

async function waves(c: PortalClinic): Promise<number> {
  return inTenant(c.clinicId, async (q) => (await q.query(`select 1 from lifecycle_waves where clinic_id = $1`, [c.clinicId])).rows.length);
}

async function alertsFor(clinicId: string) {
  return (
    await getMigratorPool().query<{ event: string }>(`select event from ops_alerts where fields->>'clinicId' = $1 order by raised_at, id`, [clinicId])
  ).rows.map((r) => r.event);
}

async function op<T>(name: Parameters<typeof runOperation>[0], args: Record<string, unknown>, operator: Operator = OPERATOR) {
  const result = await runOperation(name, args, operator);
  return { status: result.status, data: (result.body as { data?: T }).data as T, body: result.body };
}

/** One statement as the runtime role, in the clinic's tenant: row-level security and the grants apply. */
async function asApp(clinicId: string, text: string, values: unknown[] = []) {
  const client = await getAppPool().connect();
  try {
    await client.query("begin");
    await client.query(`select set_config('app.clinic_id', $1, true)`, [clinicId]);
    const result = await client.query(text, values);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

type ListRow = { clinicId: string; ignored: boolean; decisionOwed: boolean; recommendation: { action: string; days: number | null; reason: string } };

describeDb("the lifecycle ignore list and the extension's stamp (lane P5d)", () => {
  beforeAll(async () => {
    await runMigrations();
  }, 180_000);

  beforeEach(async () => {
    for (const key of ENV) SAVED[key] = process.env[key];
    process.env.HEALDESK_EMAIL_TRANSPORT = "resend";
    process.env.RESEND_API_KEY = "re_stub_p5d";
    process.env.HEALDESK_EMAIL_FROM = "healdesk <hello@healdesk.io>";
    process.env.HEALDESK_OPS_EMAIL = "ops@healdesk.test";
    process.env.BETTER_AUTH_URL = "https://app.healdesk.test";
    process.env.HEALDESK_CONSOLE_ORIGIN = "https://healdesk.test";
    delete process.env.SLACK_WEBHOOK_URL;
    send.mockReset();
    send.mockResolvedValue({ data: { id: "msg_ops" }, error: null, headers: {} });
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});
    await truncateAll();
    await getMigratorPool().query(`truncate ops_alerts, email_daily_quota`);
    // The console and the ops writes read the test's clock.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOON);
  }, 60_000);

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    for (const key of ENV) {
      if (SAVED[key] === undefined) delete process.env[key];
      else process.env[key] = SAVED[key];
    }
  });

  afterAll(async () => {
    race.afterStateRead = null;
    clinicList.failNext = false;
    await closePools();
  });

  async function raiseAlert(event: string, clinicId: string): Promise<void> {
    await getMigratorPool().query(
      `insert into ops_alerts (event, dedupe_key, fields, raised_at, last_raised_at) values ($1, $2, $3, now(), now())`,
      [event, `${event}|${randomUUID()}`, JSON.stringify({ clinicId })],
    );
  }

  test("Home leaves off every lifecycle wave of an ignored clinic, raised before it was ignored; a watched clinic's and the ignored one's real alerts stay", async () => {
    vi.useRealTimers();
    const internal = await clinic("waves-internal", { day: 23 });
    const real = await clinic("waves-real", { day: 23 });
    for (const c of [internal, real]) {
      for (const event of ["lifecycle_no_progress", "lifecycle_closing_soon", "lifecycle_decision_due", "lifecycle_reminders_unanswered"]) {
        await raiseAlert(event, c.clinicId);
      }
    }
    await raiseAlert("connection_broken", internal.clinicId);
    await op("setLifecycleIgnored", { clinicId: internal.clinicId, ignored: true, note: "internal_test_account" });

    const ids = (await readOpsInbox(OPERATOR)).rows.filter((r) => r.kind === "ops_alert").map((r) => r.id);
    for (const event of ["lifecycle_no_progress", "lifecycle_closing_soon", "lifecycle_reminders_unanswered"]) {
      expect(ids, event).not.toContain(`alert:${event}:${internal.clinicId}`);
      expect(ids, event).toContain(`alert:${event}:${real.clinicId}`);
    }
    expect(ids).toContain(`alert:connection_broken:${internal.clinicId}`);

    // Taken off the list: its waves are back.
    await op("setLifecycleIgnored", { clinicId: internal.clinicId, ignored: false });
    expect((await readOpsInbox(OPERATOR)).rows.map((r) => r.id)).toContain(`alert:lifecycle_no_progress:${internal.clinicId}`);
  }, 120_000);

  test("an unreadable clinic list leaves nothing ignored: every setup alert still shows, and Home says it is partial", async () => {
    vi.useRealTimers();
    const internal = await clinic("list-down", { day: 23 });
    await raiseAlert("lifecycle_no_progress", internal.clinicId);
    await raiseAlert("calendar_broken", internal.clinicId);
    await op("setLifecycleIgnored", { clinicId: internal.clinicId, ignored: true, note: "internal_test_account" });

    clinicList.failNext = true;
    const inbox = await readOpsInbox(OPERATOR, { sources: [opsAlertsSource] });
    expect(clinicList.failNext).toBe(false);
    const ids = inbox.rows.map((r) => r.id);
    expect(ids).toContain(`alert:calendar_broken:${internal.clinicId}`);
    expect(ids).toContain(`alert:lifecycle_no_progress:${internal.clinicId}`);
    expect(inbox.unreadable).toEqual([
      { source: "ops alerts", reason: "The lifecycle ignore list could not be read, so every clinic's setup alerts are shown." },
    ]);
  }, 120_000);

  test("the watch re-reads the deadline under its lock: an extension committed while a run is under way is not written back over", async () => {
    const c = await clinic("race", { day: 25, screens: 1 });
    const deadline = deadlineFor(25);
    await watchLifecycles(NOON);
    expect(await lifecycleRow(c)).toMatchObject({ deadline_at: deadline, decision: "none" });

    // The next run has read the setup state (the old deadline) when the
    // operator's extension commits and stamps the row; only then does the
    // run lock the row and write.
    let extended: Date | null = null;
    race.afterStateRead = async () => {
      const result = await op<{ status: string; setupDeadlineAt: string; lifecycle: string }>("extendSetupDeadline", {
        clinicId: c.clinicId,
        days: 14,
        fromDeadline: deadline.toISOString(),
      });
      expect(result.data).toMatchObject({ status: "extended", lifecycle: "recorded" });
      extended = new Date(result.data.setupDeadlineAt);
    };
    await watchLifecycles(new Date(NOON.getTime() + HOUR));
    expect(extended).not.toBeNull();
    const row = await lifecycleRow(c);
    expect(row).toMatchObject({ deadline_at: extended, decision: "extended", decided_by: OPERATOR.email });
    const lastDay = await inTenant(c.clinicId, (q) =>
      q.query<{ d: string }>(`select last_day::text as d from clinic_lifecycle where clinic_id = $1`, [c.clinicId]),
    );
    expect(lastDay.rows[0]!.d).toBe(setupLastDay(extended!, ZONE));
    // And the run after that sees no second extension.
    await watchLifecycles(new Date(NOON.getTime() + 2 * HOUR));
    expect(await lifecycleRow(c)).toMatchObject({ deadline_at: extended, decided_by: OPERATOR.email });
  }, 120_000);

  test("day 30 for an ignored account, as built today: no warning wave, and the billing reconcile still records its setup closure", async () => {
    // Documents the owner's open question: the ignore list silences the
    // watch only. The closure itself (reconcile's close_setup, carried out by
    // the setup-closure worker while its switch is on) does not read it.
    const c = await clinic("day30", { day: 30 });
    await op("setLifecycleIgnored", { clinicId: c.clinicId, ignored: true, note: "internal_test_account" });
    await watchLifecycles(NOON);
    expect(await waves(c)).toBe(0);
    expect(await alertsFor(c.clinicId)).toEqual([]);

    const pastDeadline = new Date(deadlineFor(30).getTime() + HOUR);
    vi.setSystemTime(pastDeadline);
    await reconcileBilling(pastDeadline);
    const requests = await inTenant(c.clinicId, (q) =>
      q.query<{ kind: string; reason: string }>(`select kind, reason from billing_requests where clinic_id = $1`, [c.clinicId]),
    );
    expect(requests.rows).toEqual([{ kind: "close_setup", reason: "deadline" }]);
    await watchLifecycles(pastDeadline);
    expect(await alertsFor(c.clinicId)).toEqual([]);
  }, 120_000);

  test("an ignored clinic is absent from the watch, its waves, Home's decisions, the digest and the recommendation; un-ignoring restores it", async () => {
    const internal = await clinic("internal", { day: 23, screens: 1 });
    const real = await clinic("real", { day: 23, screens: 1 });

    const set = await op<{ outcome: string; ignored: boolean; note: string | null; auditRecorded: boolean }>(
      "setLifecycleIgnored",
      { clinicId: internal.clinicId, ignored: true, note: "internal_test_account" },
    );
    expect(set.status).toBe(200);
    expect(set.data).toMatchObject({ outcome: "saved", ignored: true, note: "internal_test_account", auditRecorded: true });

    // The watch leaves it out entirely: no stage row, no ledger, no wave, no alert.
    const first = await watchLifecycles(NOON);
    expect(first).toMatchObject({ clinics: 1, ignored: 1, failures: 0 });
    expect(await lifecycleRow(internal)).toBeNull();
    expect(await waves(internal)).toBe(0);
    expect(await alertsFor(internal.clinicId)).toEqual([]);
    expect(await alertsFor(real.clinicId)).toContain("lifecycle_decision_due");

    // Off the list: the next run watches it like any other.
    expect((await op("setLifecycleIgnored", { clinicId: internal.clinicId, ignored: false })).status).toBe(200);
    await watchLifecycles(new Date(NOON.getTime() + HOUR));
    expect(await lifecycleRow(internal)).toMatchObject({ stage: "in_setup" });
    expect(await alertsFor(internal.clinicId)).toContain("lifecycle_decision_due");
    let inbox = await readOpsInbox(OPERATOR, { now: NOON });
    expect(inbox.rows.filter((r) => r.kind === "decision").map((r) => r.clinic?.id).sort()).toEqual(
      [internal.clinicId, real.clinicId].sort(),
    );

    // Back on the list, with its row and its ledger already there.
    await op("setLifecycleIgnored", { clinicId: internal.clinicId, ignored: true, note: "healdesk_staff_account" });
    const ledgerBefore = await waves(internal);
    const alertsBefore = await alertsFor(internal.clinicId);
    const later = new Date(NOON.getTime() + 5 * DAY);
    await watchLifecycles(later);
    expect(await waves(internal)).toBe(ledgerBefore);
    expect(await alertsFor(internal.clinicId)).toEqual(alertsBefore);

    // Home: no decision row for it; the real clinic's stays.
    inbox = await readOpsInbox(OPERATOR, { now: NOON });
    expect(inbox.rows.filter((r) => r.kind === "decision").map((r) => r.clinic?.id)).toEqual([real.clinicId]);

    // The digest's Lifecycle block counts the real clinic only.
    const digest = await collectDigest(new Date(NOON.getTime() + HOUR));
    expect(digest.decisionsOwedCount).toBe(1);
    expect(digest.lifecycleRows).toEqual([{ status: "in_setup", count: 1, oldestDays: expect.any(Number) }]);

    // The console's list still shows it, marked, owing nothing, recommending nothing.
    const list = await op<{ clinics: ListRow[] }>("listLifecycle", {});
    const mine = list.data.clinics.find((r) => r.clinicId === internal.clinicId)!;
    expect(mine).toMatchObject({ ignored: true, decisionOwed: false, recommendation: { ...IGNORED_RECOMMENDATION } });
    expect(list.data.clinics.find((r) => r.clinicId === real.clinicId)).toMatchObject({ ignored: false, decisionOwed: true });

    // The ignore list, read.
    const ignored = await op<{ clinics: { clinicId: string; note: string | null; setBy: string; setAt: string }[] }>("listLifecycleIgnored", {});
    expect(ignored.data.clinics).toEqual([
      { clinicId: internal.clinicId, clinicSlug: internal.clinicSlug, clinicName: expect.any(String), note: "healdesk_staff_account", setBy: OPERATOR.email, setAt: NOON.toISOString() },
    ]);
    expect((await op<{ clinics: unknown[] }>("listLifecycleIgnored", { clinicId: real.clinicId })).data.clinics).toEqual([]);

    // Taken off once more: restored on Home at once, from the row the watch already has.
    await op("setLifecycleIgnored", { clinicId: internal.clinicId, ignored: false });
    inbox = await readOpsInbox(OPERATOR, { now: NOON });
    expect(inbox.rows.some((r) => r.id === `decision:${internal.clinicId}`)).toBe(true);
    expect((await op<{ clinics: unknown[] }>("listLifecycleIgnored", {})).data.clinics).toEqual([]);
  }, 180_000);

  test("its real problems still alert: a broken connection of an ignored clinic is raised and on Home", async () => {
    const internal = await clinic("broken", { day: 10 });
    await op("setLifecycleIgnored", { clinicId: internal.clinicId, ignored: true, note: "internal_test_account" });
    const connectionId = await inTenant(internal.clinicId, async (q) => {
      const { rows } = await q.query<{ id: string }>(
        `insert into provider_connections (clinic_id, provider, status, ciphertext, iv, auth_tag, wrapped_dek, key_version, aad_version)
         values ($1, 'fixture', 'revoked', 'x', 'x', 'x', 'x', 'v1', 1) returning id`,
        [internal.clinicId],
      );
      return rows[0]!.id;
    });
    await setJobEnabled(JOB_CONNECTION_HEALTH, true, internal.userId);
    try {
      vi.useRealTimers();
      expect((await runConnectionHealthJob()).status).toBe("ok");
    } finally {
      await setJobEnabled(JOB_CONNECTION_HEALTH, false, internal.userId);
    }
    const raised = await getMigratorPool().query<{ fields: Record<string, unknown> }>(
      `select fields from ops_alerts where event = 'connection_broken' and fields->>'connectionId' = $1`,
      [connectionId],
    );
    expect(raised.rows).toHaveLength(1);
    const inbox = await readOpsInbox(OPERATOR);
    expect(inbox.rows.some((r) => r.kind === "ops_alert" && r.clinic?.id === internal.clinicId)).toBe(true);
  }, 120_000);

  test("the write: refused without an operator, a free-text or unknown reason, a non-boolean or an unknown clinic; recorded with an audit row and a security event", async () => {
    const c = await clinic("refuse", { day: 10 });
    const nobody: Operator = { email: "", request: {} };
    expect((await op("setLifecycleIgnored", { clinicId: c.clinicId, ignored: true }, nobody)).status).toBe(400);
    expect((await op("setLifecycleIgnored", { clinicId: c.clinicId, ignored: true, note: "just testing things" })).status).toBe(400);
    expect((await op("setLifecycleIgnored", { clinicId: c.clinicId, ignored: "yes" })).status).toBe(400);
    expect((await op("setLifecycleIgnored", { clinicId: c.clinicId })).status).toBe(400);
    expect((await op("setLifecycleIgnored", { clinicId: randomUUID(), ignored: true })).status).toBe(404);
    expect((await op("listLifecycleIgnored", { clinicId: "nope" })).status).toBe(400);
    const none = await inTenant(c.clinicId, (q) => q.query(`select 1 from lifecycle_ignored_clinics where clinic_id = $1`, [c.clinicId]));
    expect(none.rows).toHaveLength(0);
    expect((await getMigratorPool().query(`select 1 from security_events where event = 'lifecycle_ignored_set'`)).rowCount).toBe(0);

    expect((await op("setLifecycleIgnored", { clinicId: c.clinicId, ignored: true, note: null })).status).toBe(200);
    const events = await getMigratorPool().query<{ actor_label: string; metadata: Record<string, unknown> }>(
      `select actor_label, metadata from security_events where event = 'lifecycle_ignored_set'`,
    );
    expect(events.rows).toEqual([{ actor_label: OPERATOR.email, metadata: { clinicSlug: c.clinicSlug, ignored: true, reason: null } }]);
    const audit = await inTenant(c.clinicId, (q) =>
      q.query<{ action: string; actor_service_name: string; metadata: Record<string, unknown> }>(
        `select action, actor_service_name, metadata from audit_log where resource_type = 'lifecycle_ignored_clinics' and resource_id = $1`,
        [c.clinicId],
      ),
    );
    expect(audit.rows).toEqual([{ action: "update", actor_service_name: OPERATOR.email, metadata: { ignored: true, reason: null } }]);
  }, 120_000);

  test("the table: tenant-isolated, and the runtime role can neither delete a row nor move it to another clinic", async () => {
    const a = await clinic("rls-a", { day: 10 });
    const b = await clinic("rls-b", { day: 10 });
    await op("setLifecycleIgnored", { clinicId: a.clinicId, ignored: true });
    // b's tenant sees nothing of a's, and cannot write one for a.
    expect((await asApp(b.clinicId, `select clinic_id from lifecycle_ignored_clinics`)).rows).toEqual([]);
    expect((await asApp(a.clinicId, `select clinic_id from lifecycle_ignored_clinics`)).rows).toEqual([{ clinic_id: a.clinicId }]);
    await expect(
      asApp(b.clinicId, `insert into lifecycle_ignored_clinics (clinic_id, ignored, set_by, set_at) values ($1, true, 'x', now())`, [a.clinicId]),
    ).rejects.toThrow(/row-level security/);
    await expect(asApp(a.clinicId, `delete from lifecycle_ignored_clinics where clinic_id = $1`, [a.clinicId])).rejects.toThrow(/permission denied/);
    await expect(
      asApp(a.clinicId, `update lifecycle_ignored_clinics set clinic_id = $2 where clinic_id = $1`, [a.clinicId, b.clinicId]),
    ).rejects.toThrow(/permission denied/);
    await expect(
      asApp(a.clinicId, `update lifecycle_ignored_clinics set note = 'anything at all' where clinic_id = $1`, [a.clinicId]),
    ).rejects.toThrow(/lifecycle_ignored_clinics_note_check/);
    // The flip it is for: allowed.
    await asApp(a.clinicId, `update lifecycle_ignored_clinics set ignored = false where clinic_id = $1`, [a.clinicId]);
  }, 120_000);

  test("Extend the setup window stamps the lifecycle row: the decision row clears with the watch never run, and the watch later keeps the operator's label", async () => {
    const c = await clinic("extend", { day: 25, screens: 1 });
    const deadline = deadlineFor(25);
    // The row the watch keeps, seeded as it writes it: in setup, stalled, six days left, nothing decided.
    await seedLifecycleRow(c.clinicId, {
      stage: "in_setup",
      stageSince: new Date(NOON.getTime() - 20 * DAY),
      stepsLeft: 3,
      lastProgressAt: new Date(NOON.getTime() - 8 * DAY),
      deadlineAt: deadline,
    });
    await inTenant(c.clinicId, (q) =>
      q.query(`update clinic_lifecycle set last_day = $2 where clinic_id = $1`, [c.clinicId, setupLastDay(deadline, ZONE)]),
    );
    expect((await readOpsInbox(OPERATOR, { now: NOON })).rows.some((r) => r.id === `decision:${c.clinicId}`)).toBe(true);

    const extended = await op<{ status: string; setupDeadlineAt: string; lifecycle: string; auditRecorded: boolean }>("extendSetupDeadline", {
      clinicId: c.clinicId,
      days: 14,
      fromDeadline: deadline.toISOString(),
    });
    expect(extended.status).toBe(200);
    expect(extended.data).toMatchObject({ status: "extended", lifecycle: "recorded", auditRecorded: true });
    const moved = new Date(extended.data.setupDeadlineAt);
    expect(moved.getTime()).toBe(deadline.getTime() + 14 * DAY);

    const row = await lifecycleRow(c);
    expect(row).toMatchObject({
      decision: "extended",
      decided_by: OPERATOR.email,
      decided_at: NOON,
      deadline_at: moved,
    });
    const lastDay = await inTenant(c.clinicId, (q) =>
      q.query<{ d: string }>(`select last_day::text as d from clinic_lifecycle where clinic_id = $1`, [c.clinicId]),
    );
    expect(lastDay.rows[0]!.d).toBe(setupLastDay(moved, ZONE));
    // The watch never ran: no ledger row, and Home's decision row is gone.
    expect(await waves(c)).toBe(0);
    expect((await readOpsInbox(OPERATOR, { now: NOON })).rows.some((r) => r.id === `decision:${c.clinicId}`)).toBe(false);
    const list = await op<{ clinics: ListRow[] }>("listLifecycle", { clinicId: c.clinicId });
    expect(list.data.clinics[0]).toMatchObject({ decisionOwed: false });

    // The watch's next run does not read the stamped last day as a second extension, nor relabel it.
    await watchLifecycles(new Date(NOON.getTime() + HOUR));
    expect(await lifecycleRow(c)).toMatchObject({ decision: "extended", decided_by: OPERATOR.email, deadline_at: moved });
  }, 120_000);

  test("an extension of a clinic the watch has not seen creates no lifecycle row and says so", async () => {
    const c = await clinic("unseen", { day: 25 });
    const extended = await op<{ status: string; lifecycle: string }>("extendSetupDeadline", {
      clinicId: c.clinicId,
      days: 7,
      fromDeadline: deadlineFor(25).toISOString(),
    });
    expect(extended.data).toMatchObject({ status: "extended", lifecycle: "not_watched" });
    expect(await lifecycleRow(c)).toBeNull();
  }, 120_000);
});

describe("the ignore list is read only by the lifecycle watch and its consumers", () => {
  test("the write is a mutating operation, with an audit row; the reads are not", () => {
    expect(isMutating("setLifecycleIgnored")).toBe(true);
    expect(isMutating("listLifecycleIgnored")).toBe(false);
    expect(isMutating("listMachineQueues")).toBe(false);
  });

  // Its real problems still alert because nothing else reads the list: the
  // calendar, voice, billing and connection alerts never consult it.
  test("no file outside lib/lifecycle, the lifecycle operations and Home's decision source imports it", () => {
    const src = resolve(__dirname, "..", "src");
    const files = (function walk(dir: string): string[] {
      return readdirSync(dir).flatMap((name) => {
        const path = join(dir, name);
        return statSync(path).isDirectory() ? walk(path) : /\.tsx?$/.test(name) ? [path] : [];
      });
    })(src);
    const readers = files
      .filter((f) => /lifecycle\/ignore"|from "\.\/ignore"|lifecycleIgnoredClinics|lifecycle_ignored_clinics/.test(readFileSync(f, "utf8")))
      .map((f) => f.slice(src.length + 1))
      .sort();
    expect(readers).toEqual([
      "db/schema.ts",
      "lib/lifecycle/ignore.ts",
      "lib/lifecycle/watch.ts",
      "lib/offboarding/account-closure.ts",
      "lib/ops/inbox/go-live.ts",
      "lib/ops/inbox/ops-alerts.ts",
      "lib/ops/lifecycle-ops.ts",
      "lib/retention/purge.ts",
    ]);
  });
});
