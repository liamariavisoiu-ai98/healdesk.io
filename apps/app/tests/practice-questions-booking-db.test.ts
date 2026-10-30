import type { FakeGoogleCalendar } from "@healdesk/connectors";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { assistantFacts } from "@/lib/assistant/facts";
import { COVERAGE_VENDORS } from "@/lib/compliance/vendor-coverage";
import { readPracticeBookingFacts, practiceToolsLive } from "@/lib/engine/practice/booking";
import { runOnePracticeRun } from "@/lib/engine/practice/job";
import { runPracticeChannel } from "@/lib/engine/practice/runner";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { PRACTICE_CASES_VERSION } from "@/lib/engine/practice/cases";
import { practiceQuestionsGate, readPracticeInputs } from "@/lib/engine/practice/store";
import { approveAgentConfig, updateAgentConfig } from "@/lib/onboarding/agent-config";
import { saveSetupScreen, type SaveContext } from "@/lib/setup/save";
import { withTenant } from "@/lib/tenant";

import { closePools, getMigratorPool, hasTestDatabase, runMigrations, truncateAll } from "./setup/db";
import { deskLocation, freshGoogle, installGoogleEnv, restoreGoogleEnv } from "./setup/desk-calendar";
import { bindAgreementInEffect, inTenant } from "./setup/factories";
import { attestPlatform } from "./setup/platform";
import { provisionPortalClinic, type PortalClinic } from "./setup/portal-clinic";
import { practiceJudge, practiceModel } from "./setup/practice";

/**
 * The booking and deposit cases against the test database (Gate B piece 1,
 * 29 October 2026): the booking facts read from a real clinic's rows (its
 * calendar connection, terms, mode and deposit switches), the booking
 * switch turned on for the run alone through the read's seam, never the
 * environment, and the real tool layer driven by a scripted model (never
 * Anthropic) over the practice engine. Nothing a practice run does may reach
 * the clinic's calendar, its bookings, its requests, its holds or Stripe.
 * And a pass recorded before every case could be asked opens no channel,
 * in TypeScript and in SQL (drizzle/0137).
 */

const describeDb = hasTestDatabase ? describe : describe.skip;
const ACTOR = { type: "service", serviceName: "practice-booking-test" } as const;
const NOW = new Date("2026-10-13T15:00:00Z");
const SWITCH_ENV = ["HEALDESK_DIRECT_BOOKING_ENABLED", "HEALDESK_DIRECT_BOOKING_ADDENDUM"] as const;

/** Every row a booking could leave behind at the clinic. */
async function written(clinicId: string): Promise<Record<string, number>> {
  return inTenant(clinicId, async (c) => {
    const count = async (table: string) => Number((await c.query<{ n: string }>(`select count(*) as n from ${table}`)).rows[0]!.n);
    return {
      appointments: await count("appointments"),
      booking_requests: await count("booking_requests"),
      slot_holds: await count("slot_holds"),
      deposit_payments: await count("deposit_payments"),
    };
  });
}

const NOTHING = { appointments: 0, booking_requests: 0, slot_holds: 0, deposit_payments: 0 };

describeDb("the practice questions' booking cases, against the database", { timeout: 120_000 }, () => {
  let google: FakeGoogleCalendar;
  const env: Record<string, string | undefined> = {};

  beforeAll(async () => {
    await runMigrations();
    await truncateAll();
    installGoogleEnv();
    await attestPlatform(COVERAGE_VENDORS);
    for (const key of SWITCH_ENV) env[key] = process.env[key];
  }, 300_000);

  beforeEach(() => {
    google = freshGoogle();
    // The switch is off in the environment, as shipped: only the seam turns it on.
    for (const key of SWITCH_ENV) delete process.env[key];
  });

  afterAll(async () => {
    restoreGoogleEnv();
    for (const key of SWITCH_ENV) {
      if (env[key] === undefined) delete process.env[key];
      else process.env[key] = env[key];
    }
    await closePools();
  });

  /** A location that books live once the switch is on: covered terms, Google connected, production, script approved, deposits on. */
  async function liveLocation(label: string): Promise<string> {
    const f = await deskLocation(google, label);
    await bindAgreementInEffect(f.clinicId);
    await getMigratorPool().query(
      `update clinics set data_classification = 'production', baa_signed_at = now(),
              stripe_connect_account_id = 'acct_practice', stripe_connect_connected_at = now()
        where id = $1`,
      [f.clinicId],
    );
    await withTenant({ clinicId: f.clinicId, actor: ACTOR }, async (tx) => {
      await updateAgentConfig(tx, {
        greeting: "Hi",
        services: [
          { name: "Consultation", priceFromUsd: 0, priceToUsd: 0, durationMinutes: 30 },
          { name: "Facial", priceFromUsd: 100, priceToUsd: 100, durationMinutes: 60, depositUsd: 25 },
        ],
        escalationPhone: null,
        escalationHours: "Weekdays 9 to 5",
        notes: null,
        depositPolicy: null,
      });
      await approveAgentConfig(tx, "Dr Chen");
    });
    await inTenant(f.clinicId, (c) =>
      c.query(
        `insert into clinic_settings (clinic_id, deposits_enabled) values ($1, true)
         on conflict (clinic_id) do update set deposits_enabled = true`,
        [f.clinicId],
      ),
    );
    return f.clinicId;
  }

  test("the switch read through the seam: off as the environment ships it, on for this run alone, and the environment untouched", async () => {
    const clinicId = await liveLocation("pq-seam");
    const off = await withTenant({ clinicId, actor: ACTOR }, (tx) => readPracticeBookingFacts(tx));
    expect(off.directOpen).toBe(false);
    expect(off.modeReasons).toEqual(["kill_switch_off"]);
    expect(practiceToolsLive(off)).toBe(false);
    const on = await withTenant({ clinicId, actor: ACTOR }, (tx) => readPracticeBookingFacts(tx, { directBookingOpen: () => true }));
    expect(on).toMatchObject({ directOpen: true, modeReasons: [] });
    expect(on.deposits).toMatchObject({ depositsEnabled: true, isConnected: true });
    expect(on.deposits.services).toContainEqual({ name: "Facial", depositUsd: 25 });
    expect(practiceToolsLive(on)).toBe(true);
    for (const key of SWITCH_ENV) expect(process.env[key]).toBeUndefined();
  });

  test("web chat and a call, the tools live: both booking cases pass through the real tool layer, and nothing is held, written, requested or linked", async () => {
    const clinicId = await liveLocation("pq-tools");
    const { facts, booking } = await withTenant({ clinicId, actor: ACTOR }, async (tx) => ({
      facts: (await assistantFacts(tx, { asApproved: true }))!,
      booking: await readPracticeBookingFacts(tx, { directBookingOpen: () => true }),
    }));
    const deps = { responder: practiceModel(), metaResponder: null, judge: practiceJudge("pass"), now: NOW };
    for (const channel of ["web", "voice"] as const) {
      const outcome = await runPracticeChannel({ channel, facts, booking }, { texts: {}, ownNeverSay: [] }, deps);
      for (const id of ["booking", "deposit_booking"]) {
        const kase = outcome.cases.find((c) => c.id === id)!;
        expect(kase.checks.filter((c) => !c.ok), `${channel} ${id}`).toEqual([]);
        expect(kase.status, `${channel} ${id}`).toBe("passed");
        expect(kase.sources, `${channel} ${id}`).toContain("tool");
      }
    }
    expect(await written(clinicId)).toEqual(NOTHING);
    // Nothing reached the clinic's calendar: the practice engine asks Google nothing.
    expect(google.requests).toEqual([]);
  });

  test("through the job, with the switch on for its run: every case asked (this clinic has no calendar, so the booking cases take requests), the run passes, and the clinic keeps no booking", async () => {
    const clinic: PortalClinic = await provisionPortalClinic("pq-job", { plan: "voice-webchat-1000-1000" });
    const ctx: SaveContext = { clinicId: clinic.clinicId, slug: clinic.clinicSlug, userId: clinic.userId, actorLabel: "Front desk Mac" };
    expect(
      await saveSetupScreen(ctx, "services", {
        services: [
          { name: "Signature facial", priceKind: "exact", price: 199, durationMinutes: 60 },
          { name: "Consultation", priceKind: null },
        ],
      }),
    ).toMatchObject({ ok: true });
    expect(
      await saveSetupScreen(ctx, "hours", {
        hours: { sun: [], mon: [["09:00", "17:00"]], tue: [["09:00", "17:00"]], wed: [], thu: [], fri: [], sat: [] },
        closures: [],
      }),
    ).toMatchObject({ ok: true });
    expect(await saveSetupScreen(ctx, "question", { question: "Is there parking?", answer: "Free parking behind the building." })).toMatchObject({ ok: true });
    expect(await saveSetupScreen(ctx, "direct_line", { directLine: "(415) 555-0123" })).toMatchObject({ ok: true });
    const [queued] = await inTenant(clinic.clinicId, async (c) =>
      (await c.query<{ id: string }>(`update practice_question_runs set run_after = now() - interval '1 second' where status = 'queued' returning id`)).rows,
    );
    const status = await runOnePracticeRun(clinic.clinicId, queued!.id, {
      responder: practiceModel(),
      metaResponder: null,
      judge: practiceJudge("pass"),
      directBookingOpen: () => true,
    });
    expect(status).toBe("passed");
    const results = await inTenant(clinic.clinicId, async (c) =>
      (await c.query<{ channel: string; status: string; cases: { id: string; status: string; notApplicable?: string }[] }>(
        `select channel, status, cases from practice_question_results order by channel`,
      )).rows,
    );
    expect(results.map((r) => [r.channel, r.status])).toEqual([["voice", "passed"], ["web", "passed"]]);
    for (const r of results) {
      expect(r.cases.filter((c) => c.id === "booking" || c.id === "deposit_booking").map((c) => c.status)).toEqual(["passed", "passed"]);
      expect(r.cases.some((c) => c.notApplicable === "runtime_has_no_tools")).toBe(false);
    }
    // The run read the booking facts with the switch on, as recorded in its input version.
    const read = await withTenant({ clinicId: clinic.clinicId, actor: ACTOR }, (tx) => readPracticeInputs(tx, new Date(), { directBookingOpen: () => true }));
    expect(read!.channels.every((ch) => ch.booking?.directOpen === true)).toBe(true);
    expect(await written(clinic.clinicId)).toEqual(NOTHING);
    for (const key of SWITCH_ENV) expect(process.env[key]).toBeUndefined();
  });

  test("a pass recorded while a case could not be asked opens no channel, in TypeScript and in the database; a pass of every case does", async () => {
    const clinic = await provisionPortalClinic("pq-old", { plan: "voice-webchat-1000-1000" });
    const record = (cases: unknown[], version: string = PRACTICE_CASES_VERSION) =>
      inTenant(clinic.clinicId, async (c) => {
        const { rows } = await c.query<{ id: string }>(
          `insert into practice_question_runs
             (clinic_id, status, reason, requested_at, run_after, started_at, finished_at, cases_version, input_version)
           values ($1, 'passed', 'ops', now(), now(), now(), clock_timestamp(), $3, $2)
           returning id`,
          [clinic.clinicId, "e".repeat(64), version],
        );
        await c.query(
          `insert into practice_question_results (clinic_id, run_id, channel, input_version, status, cases)
           values ($1, $2, 'web', $3, 'passed', $4::jsonb)`,
          [clinic.clinicId, rows[0]!.id, "e".repeat(64), JSON.stringify(cases)],
        );
      });
    const gate = () => withTenant({ clinicId: clinic.clinicId, actor: ACTOR }, (tx) => practiceQuestionsGate(tx, "web"));
    const sqlGate = async () =>
      (await inTenant(clinic.clinicId, (c) => c.query<{ open: boolean }>(`select app_practice_gate_open($1, 'web') as open`, [clinic.clinicId]))).rows[0]!.open;
    // Any run queued by provisioning is closed, as the fixture does.
    await inTenant(clinic.clinicId, (c) =>
      c.query(`update practice_question_runs set status = 'superseded', lease_until = null, finished_at = clock_timestamp() where status in ('queued', 'running')`),
    );

    const passed = { status: "passed", asked: [], answered: [], sources: [], checks: [] };
    await record([
      { ...passed, id: "listed_price" },
      { ...passed, id: "booking", status: "not_applicable", notApplicable: "runtime_has_no_tools" },
      { ...passed, id: "deposit_booking", status: "not_applicable", notApplicable: "runtime_has_no_tools" },
    ]);
    expect(await gate()).toEqual({ open: false, why: "channel_not_passed" });
    expect(await sqlGate()).toBe(false);

    await record([
      { ...passed, id: "listed_price" },
      { ...passed, id: "booking" },
      { ...passed, id: "deposit_booking" },
      { ...passed, id: "language", status: "not_applicable", notApplicable: "serves_english_only" },
    ]);
    expect(await gate()).toEqual({ open: true, why: "passed" });
    expect(await sqlGate()).toBe(true);

    // The same pass of every case, recorded against an older case set: a
    // bump of PRACTICE_CASES_VERSION cannot let it stand, in either gate.
    await record(
      [
        { ...passed, id: "listed_price" },
        { ...passed, id: "booking" },
        { ...passed, id: "deposit_booking" },
      ],
      "2026-10-19.2",
    );
    expect(await gate()).toEqual({ open: false, why: "channel_not_passed" });
    expect(await sqlGate()).toBe(false);
  });

  test("the database gate names the current case set, so a bump of the version needs a migration", () => {
    const sql = readFileSync(join(__dirname, "../drizzle/0137_practice_gate_askable_cases.sql"), "utf8");
    expect(sql).toContain(`r.cases_version IS NOT DISTINCT FROM '${PRACTICE_CASES_VERSION}'`);
  });
});
