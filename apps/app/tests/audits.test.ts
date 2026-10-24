import type { FakeGoogleCalendar } from "@healdesk/connectors";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import type { AuditCheckOutcome } from "@/db/schema";
import { CHECKS, checksFor, localNoon } from "@/lib/audits/checks";
import {
  auditQueuedChanges,
  fingerprintMoved,
  runClinicAuditsHourly,
  runQueuedAudits,
} from "@/lib/audits/jobs";
import { AUDITS_KEPT, runAuditPack, worstOf } from "@/lib/audits/run";
import { voiceOutsideCoverage } from "@/lib/billing/answering";
import { recordClinicChange } from "@/lib/clinic/change-events";
import { clinicLocalDate } from "@/lib/clinic/closures";
import { withTenant } from "@/lib/tenant";
import { AUDIT_HISTORY_MAX, auditOverall, opClinicAudits, opRunClinicAudit, __setAuditDepsForTests } from "@/lib/ops/audit-ops";
import { opAcknowledgeClinicChange, opListClinicChanges } from "@/lib/ops/change-ops";
import type { Operator } from "@/lib/ops/api";
import { saveKnowledge } from "@/lib/portal/knowledge";

import { closePools, getMigratorPool, hasTestDatabase, runMigrations, truncateAll } from "./setup/db";
import {
  assistantHold,
  DESK_TZ,
  deskLocation,
  deskTime,
  freshGoogle,
  installGoogleEnv,
  phoneRequest,
  restoreGoogleEnv,
  type DeskLocation,
} from "./setup/desk-calendar";
import { inTenant, seedClinic, seedPortalUser } from "./setup/factories";

/**
 * Lane B, E3-1 to E3-4: the ops audits. Each check yields pass, warn or fail
 * on a synthetic clinic; a closed day gets no times from the booking
 * engine's core and stays in what AYA is told (F1, fixed in Phase 1); a
 * booking on a newly closed day is a warning with a count; a check that
 * cannot finish is `error` and the pack still stores; 20 runs are kept per
 * pack; six changes are one audit two minutes after the last; an edit no
 * writer recorded moves the fingerprint; the operator's run is once a minute
 * and names them; and nothing stored holds a name, a time, an address or
 * anything the clinic typed.
 */

const describeDb = hasTestDatabase ? describe : describe.skip;
const SLOW = 180_000;
const OPERATOR: Operator = { email: "ops@healdesk.test", request: { requestId: "req-audit-test" } };
const EVERY_DAY = Object.fromEntries(
  ["sun", "mon", "tue", "wed", "thu", "fri", "sat"].map((d) => [d, [["08:00", "20:00"]]]),
);
const LABEL = "Staff training at 12 Main Street";

describe("the audit's pure parts", () => {
  test("the overall rule: a change being audited is running; one nobody will audit is audits_off; else the worst, error read as fail; never with none", () => {
    expect(auditOverall({ checking: true, unaudited: true, latest: ["fail"] })).toBe("running");
    expect(auditOverall({ checking: false, unaudited: true, latest: ["pass"] })).toBe("audits_off");
    expect(auditOverall({ checking: false, unaudited: false, latest: [] })).toBe("never");
    expect(auditOverall({ checking: false, unaudited: false, latest: ["pass", "warn"] })).toBe("warn");
    expect(auditOverall({ checking: false, unaudited: false, latest: ["pass", "error", "warn"] })).toBe("fail");
    expect(auditOverall({ checking: false, unaudited: false, latest: ["pass", "pass"] })).toBe("pass");
  });

  test("the worst result wins: error, fail, warn, pass", () => {
    expect(worstOf([])).toBe("pass");
    expect(worstOf(["pass", "warn"])).toBe("warn");
    expect(worstOf(["warn", "fail", "pass"])).toBe("fail");
    expect(worstOf(["fail", "error"])).toBe("error");
  });

  test("noon on a local date is noon on the clinic's clock, either side of daylight saving", () => {
    for (const date of ["2026-07-04", "2026-12-25"]) {
      const at = localNoon(date, DESK_TZ);
      expect(clinicLocalDate(at, DESK_TZ)).toBe(date);
      expect(
        new Intl.DateTimeFormat("en-US", { timeZone: DESK_TZ, hour: "numeric", hourCycle: "h23" }).format(at),
      ).toBe("12");
    }
  });

  test("the answer gate's coverage rule, exported unchanged: only After hours only passes a call through, and never on a closed day", () => {
    expect(voiceOutsideCoverage({ coverageMode: "after_hours_only", openNow: true, closedToday: false })).toBe(true);
    expect(voiceOutsideCoverage({ coverageMode: "after_hours_only", openNow: true, closedToday: true })).toBe(false);
    expect(voiceOutsideCoverage({ coverageMode: "after_hours_only", openNow: false, closedToday: false })).toBe(false);
    expect(voiceOutsideCoverage({ coverageMode: "all_calls", openNow: true, closedToday: false })).toBe(false);
  });

  test("the availability pack has the design's ten checks, and every check id is unique", () => {
    expect(checksFor("availability").map((c) => c.id)).toEqual([
      "hours_valid",
      "closures_stored",
      "booking_mode",
      "calendar_reachable",
      "slots_honour_closures",
      "bookings_on_closed_days",
      "voice_answers_closed_days",
      "voice_agent_current",
      "web_chat_live",
      "assistant_knows_closures",
    ]);
    expect(new Set(CHECKS.map((c) => c.id)).size).toBe(CHECKS.length);
  });
});

/** Every string anywhere in a stored audit, with its key. */
function strings(value: unknown, key = ""): [string, string][] {
  if (typeof value === "string") return [[key, value]];
  if (Array.isArray(value)) return value.flatMap((v) => strings(v, key));
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([k, v]) => strings(v, k));
  }
  return [];
}

describeDb("the clinic audits", () => {
  let google: FakeGoogleCalendar;
  let f: DeskLocation;
  let userId: string;
  let clinicName: string;

  const closeDay = (closedOn: string, now?: Date) =>
    saveKnowledge(
      { clinicId: f.clinicId, userId, actorLabel: "Front desk iPad" },
      "hours",
      { hours: EVERY_DAY, closures: [{ closedOn, label: LABEL.slice(0, 14) }] },
      now,
    );
  const byId = (row: { checks: AuditCheckOutcome[] }, id: string) => row.checks.find((c) => c.id === id)!;

  beforeAll(async () => {
    await runMigrations();
    await truncateAll();
    installGoogleEnv();
    process.env.BETTER_AUTH_URL = "https://app.healdesk.test";
    process.env.HEALDESK_ADMIN_EMAIL = "ops@healdesk.test";
  }, 60_000);

  beforeEach(async () => {
    google = freshGoogle();
    f = await deskLocation(google, `aud${Date.now() % 100000}`);
    userId = (await seedPortalUser(f.clinicId, "owner")).userId;
    clinicName = (
      await getMigratorPool().query<{ name: string }>(`select name from clinics where id = $1`, [f.clinicId])
    ).rows[0]!.name;
    await getMigratorPool().query(
      `update clinics set address = '12 Main Street, Austin, TX 78701', published_phone_e164 = '+15125550100' where id = $1`,
      [f.clinicId],
    );
    __setAuditDepsForTests({});
  }, 60_000);

  afterAll(async () => {
    __setAuditDepsForTests(undefined);
    await getMigratorPool().query(
      `update scheduled_jobs set enabled = false where name in ('clinic-audits', 'clinic-audits-hourly')`,
    );
    restoreGoogleEnv();
    await closePools();
  });

  test(
    "a clinic with its calendar, hours and no closed day passes; one with its time zone unconfirmed fails",
    async () => {
      const passing = await runAuditPack(f.clinicId, "availability", { trigger: "manual", requestedBy: "test" });
      expect(passing.result).toBe("pass");
      expect(passing.checks.every((c) => c.result === "pass")).toBe(true);
      expect(byId(passing, "slots_honour_closures").counts).toMatchObject({ onClosed: 0, outsideHours: 0 });

      await getMigratorPool().query(`update clinics set timezone_confirmed_at = null where id = $1`, [f.clinicId]);
      const failing = await runAuditPack(f.clinicId, "availability", { trigger: "manual", requestedBy: "test" });
      expect(failing.result).toBe("fail");
      expect(byId(failing, "hours_valid")).toMatchObject({ result: "fail" });
      expect(byId(failing, "hours_valid").hint).toMatch(/Time zone unconfirmed/);
    },
    SLOW,
  );

  test(
    "a closed day gets no times from the engine, is in what AYA is told, and a booking already on it is a warning with a count",
    async () => {
      const day = clinicLocalDate(deskTime(3, 10), DESK_TZ);
      const request = await phoneRequest(f.clinicId);
      await assistantHold(f.clinicId, {
        requestId: request.requestId,
        contactId: request.contactId,
        startsAt: deskTime(3, 10),
        status: "reserved",
      });
      expect(await closeDay(day)).toMatchObject({ ok: true });
      const row = await runAuditPack(f.clinicId, "availability", { trigger: "manual", requestedBy: "test" });
      expect(byId(row, "slots_honour_closures")).toMatchObject({
        result: "pass",
        counts: { closedDays: 1, onClosed: 0, outsideHours: 0 },
      });
      // F1, fixed in Phase 1: the closed day reaches the assistant's facts.
      expect(byId(row, "assistant_knows_closures")).toMatchObject({
        result: "pass",
        counts: { saved: 1, told: 1, lines: 1, missing: 0 },
      });
      expect(byId(row, "bookings_on_closed_days")).toMatchObject({
        result: "warn",
        counts: { bookings: 1, closedDays: 1 },
      });
      expect(byId(row, "voice_answers_closed_days").result).toBe("pass");
      expect(row.result).toBe("warn");

      // Nothing stored names anyone, says a time or a date, or repeats what the clinic typed.
      for (const [key, value] of strings(row.checks)) {
        expect(value, key).not.toContain(clinicName);
        expect(value, key).not.toMatch(/Staff training|Main Street|\d{4}-\d{2}-\d{2}|\d{1,2}:\d{2}|@|\+1\d{6,}/);
        expect(["id", "result", "hint", "code", "side"]).toContain(key);
      }
      for (const check of row.checks) {
        for (const n of Object.values(check.counts)) expect(Number.isInteger(n)).toBe(true);
      }
    },
    SLOW,
  );

  test(
    "a check that cannot finish is an error and the pack still stores; the last 20 per pack are kept",
    async () => {
      const slow = await runAuditPack(f.clinicId, "availability", { trigger: "manual", requestedBy: "test", budgetMs: 1 });
      expect(slow.result).toBe("error");
      expect(slow.checks.some((c) => c.result === "error")).toBe(true);
      expect(slow.checks).toHaveLength(10);

      for (let i = 0; i < AUDITS_KEPT + 2; i += 1) {
        await runAuditPack(f.clinicId, "transcripts", {
          trigger: "scheduled",
          requestedBy: "test",
          now: new Date(Date.now() + i * 1000),
        });
      }
      const kept = await inTenant(f.clinicId, async (c) =>
        (await c.query<{ n: number }>(`select count(*)::int as n from clinic_audits where pack = 'transcripts'`)).rows[0]!.n,
      );
      expect(kept).toBe(AUDITS_KEPT);
    },
    SLOW,
  );

  test(
    "six changes are one audit, two minutes after the last; each change then carries its outcome",
    async () => {
      await getMigratorPool().query(`update scheduled_jobs set enabled = true where name = 'clinic-audits'`);
      try {
        const t0 = new Date();
        for (let i = 0; i < 6; i += 1) {
          const days = Array.from({ length: i + 1 }, (_, j) => ({
            closedOn: clinicLocalDate(deskTime(20 + j, 10), DESK_TZ),
            label: "",
          }));
          const saved = await saveKnowledge(
            { clinicId: f.clinicId, userId, actorLabel: "Front desk iPad" },
            "hours",
            { hours: EVERY_DAY, closures: days },
            new Date(t0.getTime() + i * 10_000),
          );
          expect(saved).toMatchObject({ ok: true });
        }
        const last = new Date(t0.getTime() + 50_000);
        // A minute after the last change: not yet.
        expect(await runQueuedAudits(new Date(last.getTime() + 60_000))).toMatch(/^0 due/);
        // Two minutes after: one audit for all six.
        expect(await runQueuedAudits(new Date(last.getTime() + 120_000))).toMatch(/^1 due, 1 audited/);
        const state = await inTenant(f.clinicId, async (c) => ({
          audits: (await c.query<{ n: number }>(`select count(*)::int as n from clinic_audits where trigger = 'change'`)).rows[0]!.n,
          changes: (
            await c.query<{ audit_status: string; audit_id: string | null }>(
              `select audit_status, audit_id from clinic_change_events`,
            )
          ).rows,
        }));
        expect(state.audits).toBe(1);
        expect(state.changes).toHaveLength(6);
        expect(new Set(state.changes.map((c) => c.audit_status)).size).toBe(1);
        expect(["passed", "attention"]).toContain(state.changes[0]!.audit_status);
        expect(state.changes.every((c) => c.audit_id === state.changes[0]!.audit_id && c.audit_id)).toBe(true);
        // Nothing left: a second claim finds no change.
        expect(await auditQueuedChanges(f.clinicId)).toBe(false);
      } finally {
        await getMigratorPool().query(`update scheduled_jobs set enabled = false where name = 'clinic-audits'`);
      }
    },
    SLOW,
  );

  test(
    "an edit no writer recorded moves the fingerprint, and the hourly run audits it",
    async () => {
      await runAuditPack(f.clinicId, "availability", { trigger: "scheduled", requestedBy: "test" });
      expect(await fingerprintMoved(f.clinicId)).toBe(false);
      await inTenant(f.clinicId, (c) =>
        c.query(`insert into clinic_closures (clinic_id, closed_on) values ($1, $2)`, [
          f.clinicId,
          clinicLocalDate(deskTime(9, 10), DESK_TZ),
        ]),
      );
      expect(await fingerprintMoved(f.clinicId)).toBe(true);
      await getMigratorPool().query(`update scheduled_jobs set enabled = true where name = 'clinic-audits-hourly'`);
      try {
        const hour = new Date();
        hour.setUTCHours(hour.getUTCHours() === 4 ? 5 : hour.getUTCHours());
        expect(await runClinicAuditsHourly(hour)).toMatchObject({ status: "ok" });
      } finally {
        await getMigratorPool().query(`update scheduled_jobs set enabled = false where name = 'clinic-audits-hourly'`);
      }
      const detected = await inTenant(f.clinicId, async (c) =>
        (await c.query<{ pack: string }>(`select pack from clinic_audits where trigger = 'change_detected' order by pack`)).rows,
      );
      expect(detected.map((d) => d.pack)).toEqual(["availability", "roster"]);
      expect(await fingerprintMoved(f.clinicId)).toBe(false);
    },
    SLOW,
  );

  test(
    "the operator's run: every pack, a security event naming them, then a minute's cool-down; the summary reads it back",
    async () => {
      const ran = await opRunClinicAudit({ clinicId: f.clinicId }, OPERATOR);
      expect(ran.status).toBe(200);
      const data = (ran.body as { data: { status: string; audits: { pack: string }[]; auditRecorded: boolean } }).data;
      expect(data.status).toBe("ran");
      expect(data.audits.map((a) => a.pack)).toEqual(["availability", "roster", "golive", "transcripts"]);
      expect(data.auditRecorded).toBe(true);

      const again = await opRunClinicAudit({ clinicId: f.clinicId, pack: "roster" }, OPERATOR);
      expect((again.body as { data: { status: string; notBefore: string } }).data).toMatchObject({ status: "too_soon" });
      expect((await opRunClinicAudit({ clinicId: f.clinicId, pack: "nope" }, OPERATOR)).status).toBe(400);

      const events = await getMigratorPool().query<{ actor_label: string; metadata: Record<string, unknown> }>(
        `select actor_label, metadata from security_events where event = 'clinic_audit_run'`,
      );
      expect(events.rows.filter((e) => e.metadata.clinicId === f.clinicId)).toEqual([
        { actor_label: "ops@healdesk.test", metadata: expect.objectContaining({ clinicId: f.clinicId, pack: "all" }) },
      ]);

      const summary = await opClinicAudits({ clinicId: f.clinicId });
      const read = (summary.body as {
        data: { clinics: { clinicId: string; overall: string; packs: Record<string, { result: string }> }[]; history: unknown[] };
      }).data;
      expect(read.clinics).toHaveLength(1);
      expect(Object.keys(read.clinics[0]!.packs).sort()).toEqual(["availability", "golive", "roster", "transcripts"]);
      expect(["pass", "warn", "fail"]).toContain(read.clinics[0]!.overall);
      expect(read.history).toHaveLength(4);
    },
    SLOW,
  );

  test(
    "the changes list, and an acknowledgement once, naming the operator",
    async () => {
      expect(await closeDay(clinicLocalDate(deskTime(15, 10), DESK_TZ))).toMatchObject({ ok: true });
      const listed = await opListClinicChanges({ clinicId: f.clinicId });
      const changes = (listed.body as { data: { changes: { id: string; kind: string; clinicName: string; summary: object }[] } }).data
        .changes;
      expect(changes).toHaveLength(1);
      expect(changes[0]).toMatchObject({ kind: "closures", clinicName });
      expect(JSON.stringify(changes[0]!.summary)).not.toContain("Staff");

      const first = await opAcknowledgeClinicChange({ id: changes[0]!.id }, OPERATOR);
      expect((first.body as { data: { status: string } }).data.status).toBe("acknowledged");
      const second = await opAcknowledgeClinicChange({ id: changes[0]!.id, clinicId: f.clinicId }, OPERATOR);
      expect((second.body as { data: { status: string } }).data.status).toBe("already");
      expect(
        (await opAcknowledgeClinicChange({ id: "3fa85f64-5717-4562-b3fc-2c963f66afa6", clinicId: f.clinicId }, OPERATOR))
          .body,
      ).toEqual({ data: { status: "not_found" } });
      const acked = await getMigratorPool().query(
        `select 1 from security_events where event = 'clinic_change_acknowledged' and metadata->>'changeId' = $1`,
        [changes[0]!.id],
      );
      expect(acked.rows).toHaveLength(1);
    },
    SLOW,
  );

  test(
    "on a clinic that answers after hours only, a closed day today is read by the gate's own loader and AYA answers",
    async () => {
      await inTenant(f.clinicId, (c) =>
        c.query(
          `insert into clinic_settings (clinic_id, coverage_mode) values ($1, 'after_hours_only')
           on conflict (clinic_id) do update set coverage_mode = excluded.coverage_mode`,
          [f.clinicId],
        ),
      );
      await inTenant(f.clinicId, (c) =>
        c.query(`insert into clinic_closures (clinic_id, closed_on) values ($1, $2)`, [
          f.clinicId,
          clinicLocalDate(new Date(), DESK_TZ),
        ]),
      );
      const row = await runAuditPack(f.clinicId, "availability", { trigger: "manual", requestedBy: "test" });
      expect(byId(row, "voice_answers_closed_days")).toMatchObject({
        result: "pass",
        code: "after_hours_only",
        counts: { closedDays: 1 },
      });
    },
    SLOW,
  );

  test(
    "a change whose audit stopped part-way is claimed again after 15 minutes, and after three attempts is an error, never checking for ever",
    async () => {
      await getMigratorPool().query(`update scheduled_jobs set enabled = true where name = 'clinic-audits'`);
      try {
        expect(await closeDay(clinicLocalDate(deskTime(30, 10), DESK_TZ))).toMatchObject({ ok: true });
      } finally {
        await getMigratorPool().query(`update scheduled_jobs set enabled = false where name = 'clinic-audits'`);
      }
      const now = new Date();
      const setState = (attempts: number, startedMinutesAgo: number) =>
        inTenant(f.clinicId, (c) =>
          c.query(
            `update clinic_change_events set audit_status = 'running', audit_attempts = $1::int,
                    audit_started_at = $2::timestamptz`,
            [attempts, new Date(now.getTime() - startedMinutesAgo * 60_000)],
          ),
        );
      const status = async () =>
        (
          await inTenant(f.clinicId, (c) =>
            c.query<{ audit_status: string; audit_attempts: number }>(
              `select audit_status, audit_attempts from clinic_change_events`,
            ),
          )
        ).rows;

      // Running for five minutes: still another run's; nothing claimed.
      await setState(1, 5);
      expect(await auditQueuedChanges(f.clinicId, now)).toBe(false);
      // Stale after 15 minutes: claimed and audited again.
      await setState(1, 20);
      expect(await auditQueuedChanges(f.clinicId, now)).toBe(true);
      expect((await status())[0]).toMatchObject({ audit_attempts: 2 });
      expect(["passed", "attention"]).toContain((await status())[0]!.audit_status);
      // Stale on its third attempt: an error, and no audit.
      await setState(3, 20);
      expect(await auditQueuedChanges(f.clinicId, now)).toBe(false);
      expect((await status())[0]).toMatchObject({ audit_status: "error", audit_attempts: 4 });
    },
    SLOW,
  );

  test(
    "one minute's run audits three clinics at most; the rest wait for the next",
    async () => {
      await getMigratorPool().query(`update scheduled_jobs set enabled = true where name = 'clinic-audits'`);
      const ids: string[] = [];
      try {
        for (let i = 0; i < 4; i += 1) {
          const c = await seedClinic(`cap${i}${Date.now() % 100000}`);
          ids.push(c.clinicId);
          await withTenant({ clinicId: c.clinicId, actor: { type: "service", serviceName: "cap-test" } }, (tx) =>
            recordClinicChange(
              tx,
              { kind: "hours", source: "portal", actor: "clinic_signin", summary: { weeklyChanged: true } },
              new Date(Date.now() - 10 * 60_000),
            ),
          );
        }
      } finally {
        await getMigratorPool().query(`update scheduled_jobs set enabled = false where name = 'clinic-audits'`);
      }
      expect(await runQueuedAudits(new Date())).toMatch(/^3 due, 3 audited/);
      expect(await runQueuedAudits(new Date())).toMatch(/^1 due, 1 audited/);
    },
    SLOW,
  );

  test(
    "two manual runs at once: one runs, the other is busy; a claim left by a run that stopped is taken over after two minutes; a closed account is refused",
    async () => {
      const [first, second] = await Promise.all([
        opRunClinicAudit({ clinicId: f.clinicId, pack: "transcripts" }, OPERATOR),
        opRunClinicAudit({ clinicId: f.clinicId, pack: "transcripts" }, OPERATOR),
      ]);
      const statuses = [first, second].map((o) => (o.body as { data: { status: string } }).data.status).sort();
      // Exactly one runs. The other is refused as busy while the first holds
      // its claim, or as too soon when the first finished before it asked: a
      // fast run on a fast machine takes the second path, and either way the
      // pack ran once.
      expect(statuses.filter((status) => status === "ran")).toHaveLength(1);
      expect(statuses.filter((status) => status === "busy" || status === "too_soon")).toHaveLength(1);
      // The claim is gone after the run.
      const claims = async () =>
        (
          await inTenant(f.clinicId, (c) =>
            c.query<{ n: number }>(`select count(*)::int as n from clinic_audit_claims`),
          )
        ).rows[0]!.n;
      expect(await claims()).toBe(0);

      // A stale claim (a run that stopped three minutes ago) does not block; a fresh one does.
      await getMigratorPool().query(`delete from security_events where event = 'clinic_audit_run'`);
      await inTenant(f.clinicId, (c) =>
        c.query(`delete from clinic_audits where trigger = 'manual'`).then(() =>
          c.query(
            `insert into clinic_audit_claims (clinic_id, started_at, requested_by) values ($1, now() - interval '3 minutes', 'ops@healdesk.test')`,
            [f.clinicId],
          ),
        ),
      );
      expect(
        ((await opRunClinicAudit({ clinicId: f.clinicId, pack: "transcripts" }, OPERATOR)).body as { data: { status: string } })
          .data.status,
      ).toBe("ran");
      await inTenant(f.clinicId, (c) =>
        c.query(`insert into clinic_audit_claims (clinic_id, started_at, requested_by) values ($1, now(), 'ops@healdesk.test')`, [
          f.clinicId,
        ]),
      );
      expect((await opRunClinicAudit({ clinicId: f.clinicId, pack: "transcripts" }, OPERATOR)).body).toEqual({
        data: { status: "busy" },
      });
      await inTenant(f.clinicId, (c) => c.query(`delete from clinic_audit_claims`));

      await getMigratorPool().query(`update clinics set account_closed_at = now() where id = $1`, [f.clinicId]);
      const closed = await opRunClinicAudit({ clinicId: f.clinicId, pack: "transcripts" }, OPERATOR);
      expect(closed.body).toEqual({ data: { status: "closed" } });
    },
    SLOW,
  );

  test(
    "history: the newest first, capped at 50 and at `limit`, none with history false; the summary reads each pack's newest whatever the cap",
    async () => {
      // 60 stored audits, as the migrator, oldest first: the availability
      // pack's newest is the last one, a warn.
      const start = Date.now() - 60 * 60_000;
      for (let i = 0; i < 60; i++) {
        await inTenant(f.clinicId, (client) =>
          client.query(
            `insert into clinic_audits (clinic_id, pack, trigger, result, checks, requested_by, started_at)
             values ($1, $2, 'scheduled', $3, '[]'::jsonb, 'clinic-audits', $4)`,
            [f.clinicId, i === 0 ? "golive" : "availability", i === 59 ? "warn" : "pass", new Date(start + i * 60_000)],
          ),
        );
      }
      type Read = { data: { clinics: { overall: string; packs: Record<string, { result: string }> }[]; history: { startedAt: string; pack: string }[] | null } };
      const whole = (await opClinicAudits({ clinicId: f.clinicId })).body as Read;
      expect(whole.data.history).toHaveLength(AUDIT_HISTORY_MAX);
      const times = whole.data.history!.map((h) => Date.parse(h.startedAt));
      expect([...times].sort((a, b) => b - a)).toEqual(times);
      expect(whole.data.history!.some((h) => h.pack === "golive")).toBe(false);
      // The pack summary still has the oldest pack, which the history cap cut.
      expect(whole.data.clinics[0]!.packs).toMatchObject({ availability: { result: "warn" }, golive: { result: "pass" } });
      expect(whole.data.clinics[0]!.overall).toBe("warn");

      const five = (await opClinicAudits({ clinicId: f.clinicId, limit: 5 })).body as Read;
      expect(five.data.history).toHaveLength(5);
      const none = (await opClinicAudits({ clinicId: f.clinicId, history: false })).body as Read;
      expect(none.data.history).toBeNull();
      expect(none.data.clinics[0]!.packs).toEqual(whole.data.clinics[0]!.packs);

      for (const args of [
        { clinicId: f.clinicId, limit: 0 },
        { clinicId: f.clinicId, limit: 51 },
        { clinicId: f.clinicId, limit: 2.5 },
        { clinicId: f.clinicId, history: "no" },
        { history: false },
        { limit: 5 },
      ]) {
        expect((await opClinicAudits(args)).status, JSON.stringify(args)).toBe(400);
      }
    },
    SLOW,
  );

  test(
    "with the audits off a change is written unaudited (no status): audits_off until an availability audit runs after it; go-live never counts",
    async () => {
      await getMigratorPool().query(`update scheduled_jobs set enabled = false where name = 'clinic-audits'`);
      type Read = { data: { clinics: { overall: string }[] } };
      const overall = async () => ((await opClinicAudits({ clinicId: f.clinicId })).body as Read).data.clinics[0]!.overall;
      // An availability audit that passed an hour ago, and go-live failing (as for every clinic not in production).
      await inTenant(f.clinicId, (client) =>
        client.query(
          `insert into clinic_audits (clinic_id, pack, trigger, result, checks, requested_by, started_at)
           values ($1, 'availability', 'scheduled', 'pass', '[]'::jsonb, 'clinic-audits', now() - interval '1 hour'),
                  ($1, 'golive', 'scheduled', 'fail', '[]'::jsonb, 'clinic-audits', now() - interval '1 hour')`,
          [f.clinicId],
        ),
      );
      expect(await overall()).toBe("pass");
      expect(await closeDay(clinicLocalDate(deskTime(41, 10), DESK_TZ))).toMatchObject({ ok: true });
      const { rows } = await inTenant(f.clinicId, (client) =>
        client.query<{ audit_status: string | null }>(`select audit_status from clinic_change_events where clinic_id = $1`, [f.clinicId]),
      );
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((r) => r.audit_status === null)).toBe(true);
      expect(await overall()).toBe("audits_off");
      // An availability audit after the change has checked it.
      await inTenant(f.clinicId, (client) =>
        client.query(
          `insert into clinic_audits (clinic_id, pack, trigger, result, checks, requested_by, started_at)
           values ($1, 'availability', 'change_detected', 'pass', '[]'::jsonb, 'clinic-audits', now() + interval '1 second')`,
          [f.clinicId],
        ),
      );
      expect(await overall()).toBe("pass");
    },
    SLOW,
  );

  test(
    "changes left waiting while the audits are switched off read as audits_off, never running",
    async () => {
      await getMigratorPool().query(`update scheduled_jobs set enabled = true where name = 'clinic-audits'`);
      try {
        expect(await closeDay(clinicLocalDate(deskTime(40, 10), DESK_TZ))).toMatchObject({ ok: true });
        const on = (await opClinicAudits({ clinicId: f.clinicId })).body as { data: { clinics: { overall: string }[] } };
        expect(on.data.clinics[0]!.overall).toBe("running");
      } finally {
        await getMigratorPool().query(`update scheduled_jobs set enabled = false where name = 'clinic-audits'`);
      }
      const off = (await opClinicAudits({ clinicId: f.clinicId })).body as { data: { clinics: { overall: string }[] } };
      expect(off.data.clinics[0]!.overall).toBe("audits_off");
    },
    SLOW,
  );
});
