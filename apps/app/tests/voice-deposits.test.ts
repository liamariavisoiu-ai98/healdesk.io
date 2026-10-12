import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

import type { AnswerDecision } from "@/lib/billing/answering";

/**
 * Deposits on the phone (BD27, R25), through the voice tool routes: voice
 * never collects, so "Book by phone without a deposit" decides what the
 * context's deposit line tells a caller before anything is chosen. The
 * booking itself is parked with the rest of the Synthflow harness (plan
 * §7.13, C12): the engine applies the deposit decision when it is wired
 * (C13, C14), so `book` takes nothing whatever the deposit settings say,
 * and the answer gate still comes first.
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
import { approveAgentConfig, updateAgentConfig } from "@/lib/onboarding/agent-config";
import { setPhoneSettings } from "@/lib/onboarding/phone";
import type { DeliveryTarget, EmailTransport, OutgoingEmail } from "@/lib/reporting/deliver";
import { withTenant } from "@/lib/tenant";
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

  test("whatever the deposit settings, the parked book takes nothing, alerts nobody and mails nobody", async () => {
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
      expect(await booked.json()).toMatchObject({ error: "manual_booking" });
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

  test("the parked book asks the gate once, outside any transaction, and a refused call hears only that the service is unavailable", async () => {
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
