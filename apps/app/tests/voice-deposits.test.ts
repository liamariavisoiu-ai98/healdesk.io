import type { FakeGoogleCalendar } from "@healdesk/connectors";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

import type { AnswerDecision } from "@/lib/billing/answering";

/**
 * Deposits on the phone (BD27, R25), through the voice tool routes: voice
 * never collects, so "Book by phone without a deposit" decides what the
 * context's deposit line tells a caller before anything is chosen, and what
 * a booking says. The booking goes through the engine (C13) for healdesk's
 * demo clinic only (C14), which applies D's deposit decision and says the
 * deposit with depositLine, never a link; every other clinic's `book` is
 * parked and takes nothing whatever the deposit settings say. The answer
 * gate comes first, and for a booking after its replay.
 */

const state = vi.hoisted(() => ({
  gate: { decision: "answer" } as AnswerDecision,
  gateCalls: 0,
  alerts: [] as Array<{ clinicId: string; kind: string; ref: Record<string, string> }>,
}));

vi.mock("@/lib/billing/answering", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/billing/answering")>()),
  voiceAnswerDecision: async () => {
    state.gateCalls += 1;
    return state.gate;
  },
}));
vi.mock("@/lib/notices/booking-alerts", () => ({
  notifyBookingAlert: async (
    tx: { clinicId: string },
    kind: string,
    ref: Record<string, string>,
  ) => {
    state.alerts.push({ clinicId: tx.clinicId, kind, ref });
  },
}));

import { POST as bookTool } from "@/app/api/voice/tools/[clinicId]/book/route";
import { POST as contextTool } from "@/app/api/voice/tools/[clinicId]/context/route";
import { POST as slotsTool } from "@/app/api/voice/tools/[clinicId]/slots/route";
import type { AgentService, DepositPolicy } from "@/db/schema";
import { DEPOSIT_REQUEST_LINE, MANUAL_BOOKING_LINE } from "@/lib/booking/lines";
import { approveAgentConfig, updateAgentConfig } from "@/lib/onboarding/agent-config";
import { setPhoneSettings } from "@/lib/onboarding/phone";
import type { DeliveryTarget, EmailTransport, OutgoingEmail } from "@/lib/reporting/deliver";
import { withTenant } from "@/lib/tenant";
import { spokenSlot } from "@/lib/voice/spoken";
import {
  __resetVoiceToolLimitsForTests,
  __setVoiceToolRuntimeForTests,
  callRefOf,
  depositLine,
} from "@/lib/voice/tools";

import {
  closePools,
  getMigratorPool,
  hasTestDatabase,
  runMigrations,
  truncateAll,
} from "./setup/db";
import { freshGoogle, installGoogleEnv, restoreGoogleEnv } from "./setup/desk-calendar";
import {
  inTenant,
  seedCalendarTerms,
  seedClinic,
  seedGoogleConnection,
  seedLegacyDemoClinic,
} from "./setup/factories";

const describeDb = hasTestDatabase ? describe : describe.skip;
/** Several transactions and Stripe round trips a test: generous on a loaded machine. */
const DB_TEST_OPTIONS = { timeout: 30_000 };
const ACTOR = { type: "service", serviceName: "test" } as const;
const SECRET = "voice-tools-secret-for-deposit-tests";
const TZ = "America/New_York";
const WEEKDAYS =
  '{"sun":[],"mon":[["09:00","17:00"]],"tue":[["09:00","17:00"]],"wed":[["09:00","17:00"]],"thu":[["09:00","17:00"]],"fri":[["09:00","17:00"]],"sat":[]}';

describeDb("deposits on the phone", DB_TEST_OPTIONS, () => {
  let google: FakeGoogleCalendar;
  const mailed: { target: DeliveryTarget; message: OutgoingEmail }[] = [];
  const transport: EmailTransport = {
    name: "capture",
    async send(target, message) {
      mailed.push({ target, message });
      return { status: "sent", messageId: `m-${mailed.length}` };
    },
  };

  beforeAll(async () => {
    await runMigrations();
    await truncateAll();
    installGoogleEnv();
  }, 60_000);

  beforeEach(() => {
    google = freshGoogle();
    process.env.BETTER_AUTH_URL = "https://app.healdesk.test";
    process.env.HEALDESK_VOICE_TOOLS_SECRET = SECRET;
    process.env.HEALDESK_DIRECT_BOOKING_ENABLED = "true";
    state.gate = { decision: "answer" };
    state.gateCalls = 0;
    state.alerts.length = 0;
    __setVoiceToolRuntimeForTests({ transport });
    __resetVoiceToolLimitsForTests();
  });

  afterEach(() => {
    mailed.length = 0;
    delete process.env.HEALDESK_VOICE_TOOLS_SECRET;
    delete process.env.HEALDESK_DIRECT_BOOKING_ENABLED;
    __setVoiceToolRuntimeForTests(undefined);
  });

  afterAll(async () => {
    restoreGoogleEnv();
    await closePools();
  });

  type Tool = "context" | "slots" | "book";
  const handlers = { context: contextTool, slots: slotsTool, book: bookTool } as const;
  function post(tool: Tool, clinicId: string, body: Record<string, unknown>): Promise<Response> {
    const request = new Request(`http://app.test/api/voice/tools/${clinicId}/${tool}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${SECRET}` },
      body: JSON.stringify({ user_phone_number: "(415) 555-0188", ...body }),
    });
    return handlers[tool](request, { params: Promise.resolve({ clinicId }) });
  }

  type Deposits = {
    enabled?: boolean;
    connected?: boolean;
    bookVoiceWithoutDeposit?: boolean;
    policy?: DepositPolicy | null;
    services?: AgentService[];
  };

  /** A live clinic with the deposit set-up asked for. */
  async function clinic(label: string, deposits: Deposits = {}) {
    const c = await seedClinic(label);
    await getMigratorPool().query(
      `update clinics set data_classification = 'production', baa_signed_at = now(), went_live_at = now(), timezone = $2 where id = $1`,
      [c.clinicId, TZ],
    );
    await inTenant(c.clinicId, (client) =>
      client.query(
        `insert into report_recipients (clinic_id, email, added_by) values ($1, $2, 'test')`,
        [c.clinicId, "desk@example-clinic.test"],
      ),
    );
    await withTenant({ clinicId: c.clinicId, actor: ACTOR }, async (tx) => {
      await setPhoneSettings(tx, { publishedPhoneE164: "+14155550199" });
      await updateAgentConfig(tx, {
        greeting: "Hi",
        services: deposits.services ?? [
          { name: "Consultation", priceFromUsd: 0, priceToUsd: 0, durationMinutes: 30 },
        ],
        escalationPhone: null,
        escalationHours: null,
        notes: null,
        depositPolicy: deposits.policy ?? null,
      });
      await approveAgentConfig(tx, "Dr Chen");
    });
    if (deposits.connected !== false) {
      await getMigratorPool().query(
        `update clinics set stripe_connect_account_id = 'acct_1Voice', stripe_connect_connected_at = now() where id = $1`,
        [c.clinicId],
      );
    }
    await inTenant(c.clinicId, (client) =>
      client.query(
        `insert into clinic_settings (clinic_id, deposits_enabled, book_voice_without_deposit) values ($1, $2, $3)`,
        [c.clinicId, deposits.enabled !== false, deposits.bookVoiceWithoutDeposit !== false],
      ),
    );
    return c;
  }

  const peel: AgentService = {
    name: "Chemical peel",
    priceFromUsd: 150,
    priceToUsd: 250,
    durationMinutes: 60,
    depositUsd: 75,
  };
  const consult: AgentService = {
    name: "Consultation",
    priceFromUsd: 0,
    priceToUsd: 0,
    durationMinutes: 30,
    depositUsd: 0,
  };
  const policy: DepositPolicy = { required: true, amountUsd: 100, collection: "front_desk" };

  /**
   * healdesk's demo clinic with the deposit set-up asked for, ready to book
   * live: calendar terms that write, a healthy connection to an account in
   * the in-memory Google, weekday hours and a confirmed zone, its script
   * approved, and a desk to mail. The answer gate is this file's mock.
   */
  async function demoClinic(label: string, deposits: Deposits = {}) {
    const demo = await seedLegacyDemoClinic(label);
    await getMigratorPool().query(
      `update clinics set timezone = $2, timezone_confirmed_at = now(), opening_hours = $3::jsonb,
              stripe_connect_account_id = 'acct_1VoiceDemo', stripe_connect_connected_at = now()
        where id = $1`,
      [demo.clinicId, TZ, WEEKDAYS],
    );
    await withTenant({ clinicId: demo.clinicId, actor: ACTOR }, async (tx) => {
      await updateAgentConfig(tx, {
        greeting: "Hi",
        services: deposits.services ?? [
          { name: "Consultation", priceFromUsd: 0, priceToUsd: 0, durationMinutes: 30 },
        ],
        escalationPhone: null,
        escalationHours: null,
        notes: null,
        depositPolicy: deposits.policy ?? null,
      });
      await approveAgentConfig(tx, "Dr Chen");
    });
    await inTenant(demo.clinicId, (client) =>
      client.query(
        `insert into clinic_settings (clinic_id, deposits_enabled, book_voice_without_deposit) values ($1, true, $2)
         on conflict (clinic_id) do update set deposits_enabled = true, book_voice_without_deposit = $2`,
        [demo.clinicId, deposits.bookVoiceWithoutDeposit !== false],
      ),
    );
    // A desk to mail, so a check that nothing was mailed is not a clinic with nowhere to send.
    await inTenant(demo.clinicId, (client) =>
      client.query(
        `insert into report_recipients (clinic_id, email, added_by) values ($1, $2, 'test')`,
        [demo.clinicId, "desk@example-clinic.test"],
      ),
    );
    await seedCalendarTerms(demo);
    const sub = `5${Date.now()}${Math.floor(Math.random() * 1e6)}`;
    google.addAccount({ sub, email: `demo-${sub}@radiance.test`, hd: "radiance.test" });
    const { refreshToken } = google.grant({ sub });
    await seedGoogleConnection(demo.clinicId, { managed: true, refreshToken });
    return { ...demo, sub };
  }

  test("the demo clinic books with its deposit line, and never a link", async () => {
    const demo = await demoClinic("vd-demo-flag", { policy });
    const offered = (await (
      await post("slots", demo.clinicId, { call_id: "call_demo_flag", service: "Consultation" })
    ).json()) as { slots: { at: string }[] };
    const at = offered.slots[0]!.at;
    const booked = await post("book", demo.clinicId, {
      call_id: "call_demo_flag",
      first_name: "Ana",
      service: "Consultation",
      at,
    });
    expect(booked.status).toBe(200);
    const when = spokenSlot(new Date(at), TZ);
    const line = depositLine({ action: "book_and_flag", amountUsd: 100, scope: "booking" });
    expect(line).toMatch(/^A deposit of 100 dollars is required to hold the appointment\./);
    expect(await booked.json()).toEqual({
      booked: true,
      at,
      when_spoken: when,
      service: "Consultation",
      say: `You're booked for ${when} for Consultation. It's in the clinic's calendar. ${line}`,
    });
    expect(google.events(demo.sub)).toHaveLength(1);
    const appointment = await inTenant(demo.clinicId, (client) =>
      client.query<{ id: string; deposit_status: string; deposit_usd: string | null }>(
        `select id, deposit_status, deposit_usd from appointments`,
      ),
    );
    expect(appointment.rows).toEqual([
      expect.objectContaining({ deposit_status: "pending_front_desk", deposit_usd: "100.00" }),
    ]);
    // D's L10 alert, ids only; no email, and no payment link anywhere.
    expect(state.alerts).toEqual([
      {
        clinicId: demo.clinicId,
        kind: "deposit_to_collect",
        ref: expect.objectContaining({ appointmentId: appointment.rows[0]!.id }),
      },
    ]);
    expect(mailed).toEqual([]);
    const links = await inTenant(demo.clinicId, (client) =>
      client.query(`select 1 from deposit_payments`),
    );
    expect(links.rows).toEqual([]);
  });

  test("the demo clinic with phone deposits off: no times, and a booking is a request said with its deposit line", async () => {
    const demo = await demoClinic("vd-demo-decline", { policy, bookVoiceWithoutDeposit: false });
    const slots = await post("slots", demo.clinicId, { call_id: "call_demo_decline" });
    expect(slots.status).toBe(409);
    expect(await slots.json()).toEqual({ error: "deposit_required", say: DEPOSIT_REQUEST_LINE });
    const asked = await post("book", demo.clinicId, {
      call_id: "call_demo_decline",
      first_name: "Ana",
      service: "Consultation",
      at: new Date(Date.now() + 3 * 86_400_000).toISOString(),
    });
    expect(asked.status).toBe(200);
    expect(await asked.json()).toEqual({
      booked: false,
      request_taken: true,
      say: depositLine({ action: "decline_and_alert", amountUsd: 100, scope: "booking" }),
    });
    expect(google.events(demo.sub)).toHaveLength(0);
    const request = await inTenant(demo.clinicId, (client) =>
      client.query<{ id: string; status: string }>(`select id, status from booking_requests`),
    );
    expect(request.rows).toEqual([expect.objectContaining({ status: "requested" })]);
    expect(state.alerts).toEqual([
      {
        clinicId: demo.clinicId,
        kind: "deposit_to_collect",
        ref: { bookingRequestId: request.rows[0]!.id },
      },
    ]);
  });

  test("the demo clinic asks the gate after the replay: a refused call books nothing, and a retry of a booking hears it still", async () => {
    const demo = await demoClinic("vd-demo-gate");
    const offered = (await (
      await post("slots", demo.clinicId, { call_id: "call_demo_gate" })
    ).json()) as { slots: { at: string }[] };
    const at = offered.slots[0]!.at;
    const body = { call_id: "call_demo_gate", first_name: "Hal", at, service: "Consultation" };
    state.gate = {
      decision: "pass_through",
      reason: "suspended",
      fallback: "direct_line",
      directLine: "+14155550100",
    };
    const refused = await post("book", demo.clinicId, body);
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ error: "service_unavailable" });
    expect(google.events(demo.sub)).toHaveLength(0);

    state.gate = { decision: "answer" };
    expect((await post("book", demo.clinicId, body)).status).toBe(200);
    // Refused now, but the booking went through: the retry hears it, and the
    // gate is not asked for an answer already given.
    state.gate = {
      decision: "pass_through",
      reason: "suspended",
      fallback: "direct_line",
      directLine: "+14155550100",
    };
    const before = state.gateCalls;
    const retried = await post("book", demo.clinicId, body);
    expect(retried.status).toBe(200);
    expect(await retried.json()).toMatchObject({ booked: true, at });
    expect(state.gateCalls).toBe(before);
    const audit = await inTenant(demo.clinicId, (client) =>
      client.query<{ metadata: Record<string, unknown> }>(
        `select metadata from audit_log where resource_type = 'voice_tool_book' order by occurred_at`,
      ),
    );
    expect(audit.rows.map((r) => r.metadata)).toEqual([
      {
        callRef: callRefOf("call_demo_gate"),
        outcome: "refused",
        reason: "service_unavailable",
        decision: "suspended",
      },
      { callRef: callRefOf("call_demo_gate"), outcome: "booked", replayed: false },
      { callRef: callRefOf("call_demo_gate"), outcome: "booked", replayed: true },
    ]);
  });

  test("a clinic that is not the demo clinic: whatever the deposit settings, book takes nothing, alerts nobody and mails nobody", async () => {
    const cases: [string, Deposits][] = [
      ["vd-on", { services: [peel, consult] }],
      ["vd-off", { policy, bookVoiceWithoutDeposit: false }],
    ];
    for (const [label, deposits] of cases) {
      const c = await clinic(label, deposits);
      const booked = await post("book", c.clinicId, {
        call_id: `call_${label}`,
        first_name: "Ana",
        service: "Chemical peel",
        at: new Date(Date.now() + 3 * 86_400_000).toISOString(),
      });
      expect(booked.status).toBe(403);
      expect(await booked.json()).toEqual({ error: "manual_booking", say: MANUAL_BOOKING_LINE });
      const rows = await inTenant(c.clinicId, async (client) => ({
        appointments: (await client.query(`select 1 from appointments`)).rows.length,
        requests: (await client.query(`select 1 from booking_requests`)).rows.length,
      }));
      expect(rows).toEqual({ appointments: 0, requests: 0 });
    }
    expect(state.alerts).toEqual([]);
    expect(mailed).toEqual([]);
  });

  test("the context line covers services with their own deposit when there is no clinic default", async () => {
    const on = await clinic("vd-some-on", { services: [peel, consult] });
    expect(
      (await (await post("context", on.clinicId, { call_id: "call_some_1" })).json()).deposit_line,
    ).toBe(
      "Some appointments need a deposit to hold them. If yours does, the front desk will call you to take it; nothing is charged on this call.",
    );
    const off = await clinic("vd-some-off", {
      services: [peel, consult],
      bookVoiceWithoutDeposit: false,
    });
    expect(
      (await (await post("context", off.clinicId, { call_id: "call_some_2" })).json()).deposit_line,
    ).toMatch(/^Some appointments need a deposit and can't be booked on this call\./);
  });

  test("a parked book asks the gate once, outside any transaction, and a refused call hears only that the service is unavailable", async () => {
    const c = await clinic("vd-gate");
    state.gate = {
      decision: "pass_through",
      reason: "suspended",
      fallback: "direct_line",
      directLine: "+14155550100",
    };
    const before = state.gateCalls;
    const refused = await post("book", c.clinicId, {
      call_id: "call_gate_2",
      first_name: "Hal",
      at: new Date(Date.now() + 3 * 86_400_000).toISOString(),
    });
    expect(state.gateCalls - before).toBe(1);
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ error: "service_unavailable" });
    const audit = await inTenant(c.clinicId, (client) =>
      client.query<{ metadata: Record<string, unknown> }>(
        `select metadata from audit_log where resource_type = 'voice_tool_book' and metadata->>'reason' = 'service_unavailable'`,
      ),
    );
    expect(audit.rows).toEqual([
      {
        metadata: {
          callRef: callRefOf("call_gate_2"),
          outcome: "refused",
          reason: "service_unavailable",
          decision: "suspended",
        },
      },
    ]);
  });
});
