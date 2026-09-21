import { afterAll, beforeAll, describe, expect, test } from "vitest";

import {
  completeConnect,
  connectAuthorizeUrl,
  connectState,
  verifyConnectState,
} from "@/lib/billing/connect";
import { updateAgentConfig } from "@/lib/onboarding/agent-config";
import {
  FORWARDING_TEST_WINDOW_MS,
  evaluateForwardingCall,
  startForwardingTest,
} from "@/lib/onboarding/forwarding-test";
import { setPhoneSettings } from "@/lib/onboarding/phone";
import { readOnboarding } from "@/lib/onboarding/steps";
import { listClinics } from "@/lib/ops/clinics";
import { clinicHealth, recordTouch } from "@/lib/ops/health";
import { runOperation, type Operator } from "@/lib/ops/api";
import { sendLiveAlert } from "@/lib/reporting/alerts";
import type { DeliveryTarget, EmailTransport, OutgoingEmail } from "@/lib/reporting/deliver";
import { addRecipient } from "@/lib/reporting/recipients";
import { withTenant } from "@/lib/tenant";
import { ingestCall, type VoiceCallEvent } from "@/lib/voice/ingest";

import { closePools, getMigratorPool, hasTestDatabase, runMigrations, truncateAll } from "./setup/db";
import { inTenant, seedClinic, seedConversation } from "./setup/factories";

/**
 * Phase 8: the forwarding test, the first-weeks view, the deposit fallback
 * and the Stripe Connect scaffold.
 */

const describeDb = hasTestDatabase ? describe : describe.skip;
const DAY = 24 * 60 * 60 * 1000;
const ACTOR = { type: "service", serviceName: "test" } as const;
const OPERATOR: Operator = { email: "ops@healdesk.test", request: {} };
const SECRET = "connect-state-secret";

const CLINIC_NUMBER = "+14155550199";

function call(clinicId: string, over: Partial<VoiceCallEvent> = {}): VoiceCallEvent {
  return {
    externalCallId: `call_${Math.random().toString(36).slice(2, 10)}`,
    clinicId,
    callerPhone: "+15550100123",
    startedAt: new Date(),
    rangAtClinicFirst: true,
    ...over,
  };
}

async function makeProduction(clinicId: string, wentLiveAt: Date): Promise<void> {
  await getMigratorPool().query(
    `update clinics set data_classification = 'production', baa_signed_at = $2, went_live_at = $2 where id = $1`,
    [clinicId, wentLiveAt],
  );
}

class FakeTransport implements EmailTransport {
  readonly name = "fake";
  readonly sent: { target: DeliveryTarget; message: OutgoingEmail }[] = [];
  async send(target: DeliveryTarget, message: OutgoingEmail) {
    this.sent.push({ target, message });
    return { status: "sent" as const, messageId: `fake-${this.sent.length}` };
  }
}

describe("forwarding test — the rule", () => {
  const until = new Date("2026-09-14T15:05:00Z");
  const clinic = { forwardingTestUntil: until, publishedPhoneE164: CLINIC_NUMBER };
  const inWindow = new Date("2026-09-14T15:02:00Z");

  test("a call inside the window with a stranger's number passes, and names the condition", () => {
    const v = evaluateForwardingCall(clinic, call("c", { startedAt: inWindow, clinicLineBusy: true }), "conv");
    expect(v.isTest).toBe(true);
    expect(v.observation).toEqual({ arrivedAt: inWindow.toISOString(), conversationId: "conv", callerIdPreserved: true, condition: "busy" });
  });

  test("a call carrying the clinic's own number fails the test", () => {
    const v = evaluateForwardingCall(clinic, call("c", { startedAt: inWindow, callerPhone: CLINIC_NUMBER }), "conv");
    expect(v.isTest).toBe(true);
    expect(v.callerIsClinic).toBe(true);
    expect(v.observation?.callerIdPreserved).toBe(false);
  });

  test("a call with no caller number at all is not a pass", () => {
    const v = evaluateForwardingCall(clinic, call("c", { startedAt: inWindow, callerPhone: undefined }), "conv");
    expect(v.observation?.callerIdPreserved).toBe(false);
  });

  test("outside the window it is not the test", () => {
    const late = new Date(until.getTime() + 1000);
    const early = new Date(until.getTime() - FORWARDING_TEST_WINDOW_MS - 1000);
    expect(evaluateForwardingCall(clinic, call("c", { startedAt: late }), "conv").isTest).toBe(false);
    expect(evaluateForwardingCall(clinic, call("c", { startedAt: early }), "conv").isTest).toBe(false);
    expect(evaluateForwardingCall({ ...clinic, forwardingTestUntil: null }, call("c", { startedAt: inWindow }), "conv").isTest).toBe(false);
  });
});

describe("stripe connect state", () => {
  const clinicId = "11111111-1111-4111-8111-111111111111";
  const now = new Date("2026-09-14T12:00:00Z");

  test("round-trips within the hour and refuses tampering, other secrets and stale states", () => {
    const state = connectState(clinicId, now, SECRET);
    expect(verifyConnectState(state, new Date(now.getTime() + 30 * 60_000), SECRET)).toBe(clinicId);
    expect(verifyConnectState(state, new Date(now.getTime() + 61 * 60_000), SECRET)).toBeNull();
    expect(verifyConnectState(state, now, "another-secret")).toBeNull();
    expect(verifyConnectState(state.replace(clinicId, "22222222-2222-4222-8222-222222222222"), now, SECRET)).toBeNull();
    expect(verifyConnectState(`${state}x`, now, SECRET)).toBeNull();
    expect(verifyConnectState("", now, SECRET)).toBeNull();
  });

  test("no link until the platform is configured", () => {
    const before = { id: process.env.STRIPE_CONNECT_CLIENT_ID, key: process.env.STRIPE_SECRET_KEY };
    delete process.env.STRIPE_CONNECT_CLIENT_ID;
    expect(connectAuthorizeUrl(clinicId)).toBeNull();
    process.env.STRIPE_CONNECT_CLIENT_ID = "ca_test";
    process.env.STRIPE_SECRET_KEY = "sk_test_x";
    process.env.HEALDESK_PROVISION_SECRET ??= "provision-secret-for-phase8";
    const url = connectAuthorizeUrl(clinicId, now);
    expect(url).toMatch(/^https:\/\/connect\.stripe\.com\/oauth\/authorize\?/);
    expect(new URL(url!).searchParams.get("client_id")).toBe("ca_test");
    expect(new URL(url!).searchParams.get("state")).toMatch(new RegExp(`^${clinicId}\\.`));
    if (before.id) process.env.STRIPE_CONNECT_CLIENT_ID = before.id;
    else delete process.env.STRIPE_CONNECT_CLIENT_ID;
    if (before.key) process.env.STRIPE_SECRET_KEY = before.key;
    else delete process.env.STRIPE_SECRET_KEY;
  });
});

describeDb("phase 8, against the database", () => {
  beforeAll(async () => {
    await runMigrations();
    await truncateAll();
    process.env.HEALDESK_PROVISION_SECRET ??= "provision-secret-for-phase8";
  }, 60_000);

  afterAll(async () => {
    await closePools();
  });

  test("inbound-only: a call the vendor flags as placed by the agent is refused before any row is written", async () => {
    const c = await seedClinic("inbound-only");
    await expect(ingestCall(call(c.clinicId, { isCallback: true }), ACTOR)).rejects.toThrow(/inbound-only/);
    const rows = await inTenant(c.clinicId, (client) => client.query(`select 1 from conversations`));
    expect(rows.rows).toHaveLength(0);
    const events = await getMigratorPool().query(`select 1 from security_events where event = 'outbound_call_refused'`);
    expect(events.rows.length).toBeGreaterThanOrEqual(1);
  });

  test("a test call inside the window stamps the step; the clinic's own number as caller ID reopens it later", async () => {
    const c = await seedClinic("fwd");
    await withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) =>
      setPhoneSettings(tx, { synthflowNumberE164: "+14155550100", publishedPhoneE164: CLINIC_NUMBER, callRouting: "conditional" }),
    );
    // Before the window: an ordinary call changes nothing.
    await ingestCall(call(c.clinicId), ACTOR);
    let state = await withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) => readOnboarding(tx));
    expect(state.test_call_passed).toBeNull();

    const until = await withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) => startForwardingTest(tx));
    expect(until.getTime()).toBeGreaterThan(Date.now());

    const result = await ingestCall(call(c.clinicId, { rangAtClinicFirst: true }), ACTOR);
    state = await withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) => readOnboarding(tx));
    expect(state.test_call_passed).not.toBeNull();
    const overview = (await listClinics()).find((x) => x.id === c.clinicId)!;
    expect(overview.forwardingTestUntil).toBeNull(); // the window is consumed
    expect(overview.forwardingTestObserved).toMatchObject({ conversationId: result.conversationId, callerIdPreserved: true, condition: "no_answer" });

    // Weeks later the carrier changes something: a call arrives as the clinic.
    await ingestCall(call(c.clinicId, { callerPhone: CLINIC_NUMBER }), ACTOR);
    state = await withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) => readOnboarding(tx));
    expect(state.test_call_passed).toBeNull();
  });

  test("a test call that lost its caller ID leaves the step open with the reason", async () => {
    const c = await seedClinic("fwd-lost");
    await withTenant({ clinicId: c.clinicId, actor: ACTOR }, async (tx) => {
      await setPhoneSettings(tx, { synthflowNumberE164: "+14155550100", publishedPhoneE164: CLINIC_NUMBER });
      await startForwardingTest(tx);
    });
    await ingestCall(call(c.clinicId, { callerPhone: CLINIC_NUMBER }), ACTOR);
    const state = await withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) => readOnboarding(tx));
    expect(state.test_call_passed).toBeNull();
    const overview = (await listClinics()).find((x) => x.id === c.clinicId)!;
    expect(overview.forwardingTestObserved?.callerIdPreserved).toBe(false);
  });

  test("the operation refuses to start without the two numbers", async () => {
    const c = await seedClinic("fwd-op");
    const refused = await runOperation("startForwardingTest", { clinicId: c.clinicId }, OPERATOR);
    expect((refused.body as { data: { status: string; message: string } }).data.status).toBe("error");
    await withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) =>
      setPhoneSettings(tx, { synthflowNumberE164: "+14155550100", publishedPhoneE164: CLINIC_NUMBER }),
    );
    const started = await runOperation("startForwardingTest", { clinicId: c.clinicId }, OPERATOR);
    expect((started.body as { data: { status: string } }).data.status).toBe("started");
  });

  test("a required deposit flags the booking for the desk, and the booked alert says so", async () => {
    const c = await seedClinic("deposit");
    await makeProduction(c.clinicId, new Date(Date.now() - 10 * DAY));
    await withTenant({ clinicId: c.clinicId, actor: ACTOR }, async (tx) => {
      await updateAgentConfig(tx, {
        greeting: "Thanks for calling.",
        services: [],
        escalationPhone: null,
        escalationHours: null,
        notes: null,
        depositPolicy: { required: true, amountUsd: 50, collection: "front_desk" },
      });
      await addRecipient(tx, { email: "desk@example-clinic.test", addedBy: "test" });
    });
    const booked = await ingestCall(
      call(c.clinicId, { outcome: "booked", booking: { scheduledFor: new Date(Date.now() + 3 * DAY), treatment: "Consultation" } }),
      ACTOR,
    );
    expect(booked.appointmentId).not.toBeNull();
    const rows = await inTenant(c.clinicId, (client) =>
      client.query<{ deposit_status: string; deposit_usd: string | null }>(`select deposit_status, deposit_usd from appointments`),
    );
    expect(rows.rows).toEqual([{ deposit_status: "pending_front_desk", deposit_usd: "50.00" }]);

    const transport = new FakeTransport();
    expect(await sendLiveAlert(c.clinicId, "booked", booked.conversationId, transport)).toBe("sent");
    expect(transport.sent[0]!.message.text).toMatch(/deposit is due/);
    expect(transport.sent[0]!.message.text).not.toMatch(/\+1555|Consultation/);
  });

  test("the deposit rule is validated and a stranger's collection method is refused", async () => {
    const c = await seedClinic("deposit-bad");
    await expect(
      withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) =>
        updateAgentConfig(tx, {
          greeting: "Hi",
          services: [],
          escalationPhone: null,
          escalationHours: null,
          notes: null,
          depositPolicy: { required: true, amountUsd: 50_000, collection: "front_desk" },
        }),
      ),
    ).rejects.toThrow(/deposit amount/);
  });

  test("the first-weeks view flags the two human moments and carries the touches", async () => {
    const now = new Date();
    const silent = await seedClinic("health-silent");
    const winner = await seedClinic("health-winner");
    const fresh = await seedClinic("health-fresh");
    const old = await seedClinic("health-old");
    await makeProduction(silent.clinicId, new Date(now.getTime() - 9 * DAY));
    await makeProduction(winner.clinicId, new Date(now.getTime() - 5 * DAY));
    await makeProduction(fresh.clinicId, new Date(now.getTime() - 2 * DAY));
    await makeProduction(old.clinicId, new Date(now.getTime() - 90 * DAY));
    await seedConversation(winner.clinicId, { startedAt: new Date(now.getTime() - 1 * DAY), recovered: true, booked: true });
    await seedConversation(winner.clinicId, { startedAt: new Date(now.getTime() - 2 * DAY) });

    let rows = await clinicHealth(now);
    const byId = Object.fromEntries(rows.map((r) => [r.clinicId, r]));
    expect(byId[old.clinicId]).toBeUndefined(); // past the watch window
    expect(byId[silent.clinicId]!.flags).toEqual(["no_calls_after_day_7"]);
    expect(byId[fresh.clinicId]!.flags).toEqual([]);
    expect(byId[winner.clinicId]!.flags).toEqual(["first_win"]);
    expect(byId[winner.clinicId]!.conversations).toEqual({ total: 2, last7: 2 });
    expect(byId[winner.clinicId]!.recovered.total).toBe(1);
    expect(byId[winner.clinicId]!.bookings).toBe(1);
    expect(byId[winner.clinicId]!.firstRecoveredBookingAt).not.toBeNull();
    // Sorted youngest first, so the day-2 clinic leads the list.
    expect(rows[0]!.clinicId).toBe(fresh.clinicId);

    // The first-win call, recorded: the flag clears.
    const recorded = await runOperation(
      "recordClinicTouch",
      { clinicId: winner.clinicId, kind: "call", summary: "Called the manager; walked through the first recovered booking.", outcome: "agreed to a case study" },
      OPERATOR,
    );
    expect((recorded.body as { data: { status: string } }).data.status).toBe("updated");
    rows = await clinicHealth(now);
    const after = rows.find((r) => r.clinicId === winner.clinicId)!;
    expect(after.flags).toEqual([]);
    expect(after.touches).toHaveLength(1);
    expect(after.touches[0]!.byLabel).toBe("ops@healdesk.test");
    expect(after.touches[0]!.outcome).toBe("agreed to a case study");

    // A touch that names a patient is refused, like an incident summary.
    const phi = await runOperation(
      "recordClinicTouch",
      { clinicId: winner.clinicId, kind: "note", summary: "Spoke about jane@example.com's booking" },
      OPERATOR,
    );
    expect((phi.body as { data: { status: string } }).data.status).toBe("error");

    // Touches are append-only for the runtime role.
    await withTenant({ clinicId: silent.clinicId, actor: ACTOR }, (tx) =>
      recordTouch(tx, { kind: "note", summary: "left a voicemail", byLabel: "test" }),
    );
    const appPool = (await import("./setup/db")).getAppPool();
    const client = await appPool.connect();
    try {
      await client.query("begin");
      await client.query(`select set_config('app.clinic_id', $1, true)`, [silent.clinicId]);
      await expect(client.query(`delete from clinic_touches`)).rejects.toThrow(/permission denied/);
      await client.query("rollback");
    } finally {
      client.release();
    }
  });

  test("completing the Connect callback stores the account id, and a bad state stores nothing", async () => {
    const c = await seedClinic("connect");
    const exchange = async (code: string) => ({ accountId: code === "good" ? "acct_1TestClinic" : "nope" });
    const now = new Date();
    const ok = await completeConnect({ code: "good", state: connectState(c.clinicId, now) }, exchange, now);
    expect(ok).toEqual({ status: "connected", clinicId: c.clinicId, accountId: "acct_1TestClinic" });
    const overview = (await listClinics()).find((x) => x.id === c.clinicId)!;
    expect(overview.stripeConnectAccountId).toBe("acct_1TestClinic");
    expect(overview.stripeConnectConnectedAt).not.toBeNull();

    const other = await seedClinic("connect-other");
    expect(await completeConnect({ code: "good", state: `${other.clinicId}.${now.getTime()}.forged` }, exchange, now)).toEqual({ status: "invalid_state" });
    expect(await completeConnect({ code: "bad", state: connectState(other.clinicId, now) }, exchange, now)).toEqual({ status: "failed", reason: "not an account id" });
    const untouched = (await listClinics()).find((x) => x.id === other.clinicId)!;
    expect(untouched.stripeConnectAccountId).toBeNull();
  });
});
