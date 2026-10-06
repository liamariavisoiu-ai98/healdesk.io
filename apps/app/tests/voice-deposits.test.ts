import { fixtureAdapter } from "@healdesk/connectors";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

import type { AnswerDecision } from "@/lib/billing/answering";

/**
 * Deposits on the phone (BD27, R25), through the direct-booking tool routes:
 * voice never collects, so "Book by phone without a deposit" decides between
 * booking with the deposit left to the desk and booking nothing; the gate
 * runs after the replay and outside any transaction; the desk's FYI reads
 * the appointment, not the policy.
 */

const state = vi.hoisted(() => ({
  gate: { decision: "answer" } as AnswerDecision,
  gateCalls: 0,
  alerts: [] as Array<{ clinicId: string; kind: string; ref: Record<string, string> }>,
}));

vi.mock("@healdesk/catalog", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@healdesk/catalog")>();
  return {
    ...actual,
    currentDirectBookingAddendum: () => ({
      ...actual.currentDirectBookingAddendum(),
      approvedByCounsel: true,
    }),
  };
});
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
import { markVerified, saveConnection } from "@/lib/connections/store";
import { approveAgentConfig, updateAgentConfig } from "@/lib/onboarding/agent-config";
import { setPhoneSettings } from "@/lib/onboarding/phone";
import type { DeliveryTarget, EmailTransport, OutgoingEmail } from "@/lib/reporting/deliver";
import { withTenant } from "@/lib/tenant";
import { ingestCall } from "@/lib/voice/ingest";
import {
  __resetVoiceToolLimitsForTests,
  __setVoiceToolRuntimeForTests,
  callRefOf,
} from "@/lib/voice/tools";

import {
  closePools,
  getMigratorPool,
  hasTestDatabase,
  runMigrations,
  truncateAll,
} from "./setup/db";
import { inTenant, seedClinic } from "./setup/factories";

const describeDb = hasTestDatabase ? describe : describe.skip;
/** Several transactions and Stripe round trips a test: generous on a loaded machine. */
const DB_TEST_OPTIONS = { timeout: 30_000 };
const ACTOR = { type: "service", serviceName: "test" } as const;
const SECRET = "voice-tools-secret-for-deposit-tests";
const TZ = "America/New_York";

describeDb("deposits on the phone", DB_TEST_OPTIONS, () => {
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
  }, 60_000);

  beforeEach(() => {
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
    fixtureAdapter.reset();
    mailed.length = 0;
    delete process.env.HEALDESK_VOICE_TOOLS_SECRET;
    delete process.env.HEALDESK_DIRECT_BOOKING_ENABLED;
    __setVoiceToolRuntimeForTests(undefined);
  });

  afterAll(async () => {
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

  /** A live direct-booking clinic on the fixture calendar, with the deposit set-up asked for. */
  async function clinic(label: string, deposits: Deposits = {}) {
    const c = await seedClinic(label);
    await getMigratorPool().query(
      `update clinics set data_classification = 'production', baa_signed_at = now(), went_live_at = now(), timezone = $2,
              booking_mode = 'direct', direct_booking_elected_at = now(), direct_booking_elected_by_label = 'Dr Chen, Owner',
              direct_booking_clause_version = 'direct-booking-addendum/1.0.0', direct_booking_clause_hash = decode('ab', 'hex') where id = $1`,
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
      const id = await saveConnection(tx.db, {
        clinicId: c.clinicId,
        provider: "fixture",
        credentials: { apiKey: "fx-key" },
        metadata: { durationMinutes: 30 },
      });
      await markVerified(tx.db, { clinicId: c.clinicId, connectionId: id, capabilities: {} });
    });
    await inTenant(c.clinicId, (client) =>
      client.query(`update provider_connections set phi_basis = 'practice_account'`),
    );
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

  async function slot(
    clinicId: string,
    callId: string,
    index = 0,
  ): Promise<{ at: string; spoken: string }> {
    const { slots } = (await (await post("slots", clinicId, { call_id: callId })).json()) as {
      slots: { at: string; spoken: string }[];
    };
    return slots[index]!;
  }

  const appointments = (clinicId: string) =>
    inTenant(clinicId, (client) =>
      client.query<{ id: string; deposit_status: string; deposit_usd: string | null }>(
        `select id, deposit_status, deposit_usd from appointments order by created_at`,
      ),
    );

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

  test("On: books, leaves the service's own deposit to the desk, tells the caller, alerts staff, and the FYI says so", async () => {
    const c = await clinic("vd-on", { services: [peel, consult], policy });
    const first = await slot(c.clinicId, "call_on_1");
    const booked = await post("book", c.clinicId, {
      call_id: "call_on_1",
      first_name: "Ana",
      at: first.at,
      service: "chemical peel",
    });
    expect(booked.status).toBe(200);
    expect(await booked.json()).toEqual({
      booked: true,
      when_spoken: first.spoken,
      calendar: "written",
      deposit_line:
        "A deposit of 75 dollars is required to hold the appointment. The front desk will call you to take it; nothing is charged on this call.",
    });
    const [appointment] = (await appointments(c.clinicId)).rows;
    expect(appointment).toMatchObject({
      deposit_status: "pending_front_desk",
      deposit_usd: "75.00",
    });
    expect(state.alerts).toEqual([
      { clinicId: c.clinicId, kind: "deposit_to_collect", ref: { appointmentId: appointment!.id } },
    ]);
    expect(mailed[0]!.message.text).toMatch(/The assistant said a deposit is due/);

    // A service set to $0 asks for nothing, even with a clinic default.
    const second = await slot(c.clinicId, "call_on_2", 1);
    expect(
      await (
        await post("book", c.clinicId, {
          call_id: "call_on_2",
          first_name: "Ben",
          at: second.at,
          service: "Consultation",
        })
      ).json(),
    ).toEqual({ booked: true, when_spoken: second.spoken, calendar: "written" });
    expect((await appointments(c.clinicId)).rows[1]).toMatchObject({
      deposit_status: "none",
      deposit_usd: null,
    });
    expect(mailed[1]!.message.text).not.toMatch(/deposit/);

    // A service the clinic never listed gets the clinic default, not a guess.
    const third = await slot(c.clinicId, "call_on_3", 2);
    await post("book", c.clinicId, {
      call_id: "call_on_3",
      first_name: "Cy",
      at: third.at,
      service: "Something new",
    });
    expect((await appointments(c.clinicId)).rows[2]).toMatchObject({
      deposit_status: "pending_front_desk",
      deposit_usd: "100.00",
    });

    // The retry hears exactly what the first call heard, deposit line included.
    expect(
      await (
        await post("book", c.clinicId, { call_id: "call_on_1", first_name: "Ana", at: first.at })
      ).json(),
    ).toMatchObject({ deposit_line: expect.stringMatching(/^A deposit of 75 dollars/) });
  });

  test("Off: books nothing; the request goes to the desk with the alert, and a retry gets the same answer", async () => {
    const c = await clinic("vd-off", { bookVoiceWithoutDeposit: false, policy });
    const context = await (await post("context", c.clinicId, { call_id: "call_off_ctx" })).json();
    expect(context.deposit_line).toBe(
      "Appointments need a deposit of 100 dollars, so they can't be booked on this call. I'll pass your request to the team, who will call you to take the deposit and confirm a time; nothing is charged on this call.",
    );

    const chosen = await slot(c.clinicId, "call_off_1");
    const refused = await post("book", c.clinicId, {
      call_id: "call_off_1",
      first_name: "Dee",
      at: chosen.at,
      service: "Consultation",
    });
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ error: "deposit_required", request_taken: true });
    expect((await appointments(c.clinicId)).rows).toHaveLength(0);
    const requests = await inTenant(c.clinicId, (client) =>
      client.query<{
        id: string;
        status: string;
        vendor_call_id: string;
        appointment_id: string | null;
        booked_via: string;
      }>(`select id, status, vendor_call_id, appointment_id, booked_via from booking_requests`),
    );
    expect(requests.rows).toEqual([
      {
        id: expect.any(String),
        status: "requested",
        vendor_call_id: "call_off_1",
        appointment_id: null,
        booked_via: "desk",
      },
    ]);
    expect(state.alerts).toEqual([
      {
        clinicId: c.clinicId,
        kind: "deposit_to_collect",
        ref: { bookingRequestId: requests.rows[0]!.id },
      },
    ]);
    expect(mailed).toHaveLength(1);
    expect(mailed[0]!.message.subject).toMatch(/^New booking request via a phone call/);
    expect(fixtureAdapter.recordedWrites()).toHaveLength(0);

    const retried = await post("book", c.clinicId, {
      call_id: "call_off_1",
      first_name: "Dee",
      at: chosen.at,
    });
    expect(retried.status).toBe(403);
    expect(await retried.json()).toEqual({ error: "deposit_required", request_taken: true });
    expect(
      (await inTenant(c.clinicId, (client) => client.query(`select 1 from booking_requests`))).rows,
    ).toHaveLength(1);
    expect(mailed).toHaveLength(1);

    // The post-call webhook links its conversation to that request instead of opening another.
    const ingested = await ingestCall(
      {
        externalCallId: "call_off_1",
        clinicId: c.clinicId,
        callerPhone: "+14155550188",
        startedAt: new Date(),
        outcome: "booked",
        booking: { scheduledFor: new Date(chosen.at) },
      },
      ACTOR,
    );
    expect(ingested.bookingRequestId).toBe(requests.rows[0]!.id);
  });

  test("deposits off or not connected: no deposit, whatever the policy says, and the FYI reads the appointment", async () => {
    const off = await clinic("vd-disabled", { enabled: false, policy });
    expect(
      (await (await post("context", off.clinicId, { call_id: "call_dis_ctx" })).json())
        .deposit_line,
    ).toBe("");
    const chosen = await slot(off.clinicId, "call_dis_1");
    expect(
      await (
        await post("book", off.clinicId, {
          call_id: "call_dis_1",
          first_name: "Eve",
          at: chosen.at,
        })
      ).json(),
    ).toEqual({ booked: true, when_spoken: chosen.spoken, calendar: "written" });
    expect((await appointments(off.clinicId)).rows[0]).toMatchObject({ deposit_status: "none" });
    // The policy still says "required"; the appointment says no deposit was flagged, and the desk is told what is true.
    expect(mailed[0]!.message.text).not.toMatch(/deposit/);
    expect(state.alerts).toEqual([]);

    const loose = await clinic("vd-loose", { connected: false, policy });
    const looseSlot = await slot(loose.clinicId, "call_loose_1");
    await post("book", loose.clinicId, {
      call_id: "call_loose_1",
      first_name: "Fay",
      at: looseSlot.at,
    });
    expect((await appointments(loose.clinicId)).rows[0]).toMatchObject({ deposit_status: "none" });
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

  test("the gate runs after the replay: a booked call's retry still answers, a new call is refused", async () => {
    const c = await clinic("vd-gate");
    // Both slots are offered while the clinic still answers: Package B gates
    // `slots` too, so a slot can't be asked for once the gate refuses.
    const chosen = await slot(c.clinicId, "call_gate_1");
    const later = await slot(c.clinicId, "call_gate_2", 1);

    const beforeBook = state.gateCalls;
    const booked = await post("book", c.clinicId, {
      call_id: "call_gate_1",
      first_name: "Gus",
      at: chosen.at,
    });
    expect(booked.status).toBe(200);
    // A new booking asks the gate once.
    expect(state.gateCalls - beforeBook).toBe(1);

    state.gate = {
      decision: "pass_through",
      reason: "suspended",
      fallback: "direct_line",
      directLine: "+14155550100",
    };
    const beforeRetry = state.gateCalls;
    const retry = await post("book", c.clinicId, {
      call_id: "call_gate_1",
      first_name: "Gus",
      at: chosen.at,
    });
    expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({ booked: true, when_spoken: chosen.spoken });
    // The retry of a booking that already went through answers from the
    // replay, before the gate is asked anything.
    expect(state.gateCalls - beforeRetry).toBe(0);

    const refused = await post("book", c.clinicId, {
      call_id: "call_gate_2",
      first_name: "Hal",
      at: later.at,
    });
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ error: "service_unavailable" });
    expect((await appointments(c.clinicId)).rows).toHaveLength(1);
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
