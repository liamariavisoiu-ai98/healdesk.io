import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

import { EMPTY_TOOL_STATE, type BookingTools, type BookingToolState, type ToolTurn } from "@/lib/assistant/booking-tools";
import type { AssistantFacts } from "@/lib/assistant/facts";
import { answerTurn, type AssistantResponder } from "@/lib/assistant/turn";
import { __setStripeForTests } from "@/lib/billing/stripe-client";
import { updateAgentConfig } from "@/lib/onboarding/agent-config";
import {
  callRefHash,
  PAYMENT_TEXT_LINES_EN,
  PAYMENT_TEXT_LINES_ES,
  paymentTextAnswer,
  paymentTextTools,
  textableNumber,
  type PaymentTextDeps,
} from "@/lib/sms/payment-text";
import {
  PAYMENT_LINK_TEXT_TEMPLATE,
  paymentLinkTextBody,
  SMS_SEND_DEADLINE_MS,
  sendPaymentLinkText,
  smsFailureCode,
  type SmsRequest,
} from "@/lib/sms/send";
import { agreementVersionCoversText } from "@/lib/sms/agreement";
import { smsOriginationIdentity, smsSenderConfigured } from "@/lib/sms/config";
import { createDepositLink } from "@/lib/billing/deposit-link";
import {
  flagStaleOpenDepositsFor,
  flagUnlinkedDepositsFor,
  OPEN_LINK_EXPIRY_GRACE_MS,
  SWEEP_CHECKS,
  sweepUnlinkedDeposits,
} from "@/lib/billing/deposit-sweep";
import { recordDepositLapsed } from "@/lib/billing/deposits";
import { supersededReason } from "@/lib/email/superseded";
import { dedupeKey, notifyBookingAlert } from "@/lib/notices/booking-alerts";
import { bookingDepositLine, isDepositToCollect } from "@/lib/portal/bookings";
import { depositBadge } from "@/lib/portal/bookings-view";
import { DESK_ALERT_HOLD_MS } from "@/lib/sms/payment-text";
import { ALERT_WORDING } from "@/lib/ops/alert-wording";
import { withTenant } from "@/lib/tenant";

import { closePools, getMigratorPool, hasTestDatabase, runMigrations, truncateAll } from "./setup/db";
import { asApp } from "./setup/calendar-db";
import { bindAgreementInEffect, inTenant, seedClinic } from "./setup/factories";
import { createStripeFake } from "./setup/stripe-fake";

/**
 * The payment-link text after a call (owner, 28 and 30 October 2026): the
 * fixed words, the readiness read from config, the call flow read from the
 * model's structured state only, and the one send per booking, against the
 * database and a fake AWS transport. Nothing here reaches AWS or Stripe.
 */

const NOW = new Date("2026-10-30T18:00:00Z");
const LATER = (seconds: number) => new Date(NOW.getTime() + seconds * 1000);
const ACTOR = { type: "service", serviceName: "test" } as const;
const ACCOUNT = "acct_1PaymentText";
const IDENTITY = "phone-0123456789abcdef0123456789abcdef";
const ENV = { HEALDESK_SMS_ORIGINATION_IDENTITY: IDENTITY };
const CALLER = "+14155550142";

describe("the words", () => {
  const LINK = "https://checkout.stripe.com/c/pay/cs_test_a1";

  test("are the one template around the link, and nothing else", () => {
    expect(paymentLinkTextBody(LINK)).toBe(PAYMENT_LINK_TEXT_TEMPLATE.replace("{link}", LINK));
    expect(PAYMENT_LINK_TEXT_TEMPLATE).toBe(
      "Healdesk: your secure link to pay your booking deposit: {link}. We don't read replies. Msg&data rates may apply. Reply STOP to opt out, HELP for help.",
    );
  });

  test("name no treatment, time, amount or clinic", () => {
    const words = PAYMENT_LINK_TEXT_TEMPLATE.replace("{link}", "");
    expect(words).not.toMatch(/\$|\d|dollar|botox|filler|peel|facial|laser|consult|appointment at|today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|am\b|pm\b|clinic|spa|med/i);
  });

  test("refuse anything but an https link", () => {
    for (const bad of ["http://checkout.stripe.com/x", "javascript:alert(1)", "checkout.stripe.com/x", "https://a b", "https://{link}"]) {
      expect(() => paymentLinkTextBody(bad), bad).toThrow();
    }
  });
});

describe("readiness from config", () => {
  test("nothing set, __unset__, or a value of the wrong shape: not ready", () => {
    expect(smsSenderConfigured({})).toBe(false);
    expect(smsSenderConfigured({ HEALDESK_SMS_ORIGINATION_IDENTITY: "__unset__" })).toBe(false);
    expect(smsSenderConfigured({ HEALDESK_SMS_ORIGINATION_IDENTITY: "+14155550100" })).toBe(false); // not toll-free
    expect(smsSenderConfigured({ HEALDESK_SMS_ORIGINATION_IDENTITY: "phone-123" })).toBe(false);
    expect(smsSenderConfigured({ HEALDESK_SMS_ORIGINATION_IDENTITY: "pool-0123456789abcdef0123456789abcdef" })).toBe(false);
  });

  test("the phone-number id, its ARN or the toll-free number itself: ready", () => {
    for (const value of [
      IDENTITY,
      `arn:aws:sms-voice:us-east-1:865780386982:phone-number/${IDENTITY}`,
      "+18885550123",
    ]) {
      expect(smsOriginationIdentity({ HEALDESK_SMS_ORIGINATION_IDENTITY: ` ${value} ` })).toBe(value);
    }
  });

  test("AWS's refusals map to closed codes", () => {
    expect(smsFailureCode({ name: "ConflictException", Reason: "DESTINATION_PHONE_NUMBER_OPTED_OUT" })).toBe("opted_out");
    expect(smsFailureCode({ name: "ThrottlingException" })).toBe("throttled");
    expect(smsFailureCode({ name: "ValidationException", Reason: "INVALID_PARAMETER" })).toBe("error");
    expect(smsFailureCode(new Error("boom"))).toBe("error");
  });
});

describe("one attempt, inside a deadline", () => {
  test("a transport that never answers: one attempt, aborted at the deadline, failed, never retried", async () => {
    const calls: Array<{ request: SmsRequest; signal: AbortSignal | undefined }> = [];
    const hung = (request: SmsRequest, signal?: AbortSignal) => {
      calls.push({ request, signal });
      return new Promise<{ MessageId?: string }>(() => undefined);
    };
    const started = Date.now();
    const result = await sendPaymentLinkText({
      to: CALLER,
      url: "https://checkout.stripe.com/c/pay/cs_test_hung",
      env: ENV,
      transport: hung,
      deadlineMs: 50,
    });
    // Not "error": AWS may have accepted it, so whether it went is unknown.
    expect(result).toEqual({ status: "failed", code: "unknown" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.signal?.aborted).toBe(true);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  test("the deadline keeps the caller's silence to a few seconds", () => {
    expect(SMS_SEND_DEADLINE_MS).toBeLessThanOrEqual(5_000);
  });
});

describe("reading the model's state", () => {
  test("only booleans count, and a number needs ten digits", () => {
    expect(paymentTextAnswer(null)).toEqual({ agreed: null, number: null, confirmed: null });
    expect(paymentTextAnswer({ paymentText: { agreed: "yes", confirmed: 1, number: "555" } })).toEqual({ agreed: null, number: null, confirmed: null });
    expect(paymentTextAnswer({ paymentText: { agreed: true, number: "(415) 555-0142", confirmed: false } })).toEqual({
      agreed: true,
      number: "4155550142",
      confirmed: false,
    });
  });

  test("only US and Canadian numbers can be texted from the toll-free number", () => {
    expect(textableNumber("(415) 555-0142")).toBe(CALLER);
    expect(textableNumber("+44 20 7946 0958")).toBeNull();
    expect(textableNumber("123")).toBeNull();
  });

  test("the call is kept as a hash, never its id", () => {
    expect(callRefHash("call_abc")).toMatch(/^[0-9a-f]{64}$/);
    expect(callRefHash("call_abc")).not.toContain("call_abc");
  });
});

describe("the agreement that covers the text", () => {
  test("BAA 1.6.0 and DPA 1.1.0 or later; anything older, a draft, unknown or unreadable is no", () => {
    expect(agreementVersionCoversText("1.6.0")).toBe(true);
    expect(agreementVersionCoversText("dpa/1.1.0")).toBe(true);
    // Released since C13 landed, and carrying the same exception.
    expect(agreementVersionCoversText("1.7.0")).toBe(true);
    expect(agreementVersionCoversText("dpa/1.2.0")).toBe(true);
    for (const v of ["1.5.1", "1.5.0", "1.2.1", "dpa/1.0.0", "1.1.0-draft", "1.8.0", "dpa/1.3.0", "dpa/", "", "1.6", "v1.6.0", null, undefined]) {
      expect(agreementVersionCoversText(v), String(v)).toBe(false);
    }
  });

  test("a BAA draft at or past 1.6.0 that is not released is not covered", () => {
    const templates = [
      { version: "1.7.0", approvedByCounsel: false },
      { version: "1.6.0", approvedByCounsel: true },
    ];
    expect(agreementVersionCoversText("1.7.0", templates)).toBe(false);
    expect(agreementVersionCoversText("1.6.0", templates)).toBe(true);
    expect(agreementVersionCoversText("1.6.0", [{ version: "1.6.0", approvedByCounsel: false }])).toBe(false);
  });
});

describe("with nothing configured, as in CI", () => {
  test("the text is never offered and the database is never asked", async () => {
    const tools = paymentTextTools({ clinicId: "00000000-0000-0000-0000-000000000000", callId: "call_ci" }, { env: {}, realCalls: true });
    const booked: ToolTurn = {
      reply: "You're booked.",
      state: { ...EMPTY_TOOL_STATE, done: { kind: "booked", at: NOW.toISOString(), requestId: null, appointmentId: "11111111-1111-1111-1111-111111111111" } },
      bookingWritten: true,
      requestId: null,
      appointmentId: "11111111-1111-1111-1111-111111111111",
    };
    const after = await tools.offerAfterBooking(booked, NOW);
    expect(after).toBe(booked);
    expect(tools.live(after.state)).toBe(false);
  });

  test("and in test-calls-only mode it is never offered either, configured or not", async () => {
    const tools = paymentTextTools({ clinicId: "00000000-0000-0000-0000-000000000000", callId: "call_ci" }, { env: ENV, realCalls: false });
    const booked: ToolTurn = {
      reply: "You're booked.",
      state: EMPTY_TOOL_STATE,
      bookingWritten: true,
      requestId: null,
      appointmentId: "11111111-1111-1111-1111-111111111111",
    };
    expect(await tools.offerAfterBooking(booked, NOW)).toBe(booked);
  });
});

const describeDb = hasTestDatabase ? describe : describe.skip;

describeDb("the call flow and the one send, against the database", { timeout: 30_000 }, () => {
  let sent: SmsRequest[] = [];
  let reply: (request: SmsRequest) => Promise<{ MessageId?: string }> = async () => ({ MessageId: "msg-0001" });
  const transport = async (request: SmsRequest) => {
    sent.push(request);
    return reply(request);
  };
  let notified: Array<{ event: string; fields: Record<string, unknown> }> = [];
  const notify = (async (event: string, fields: Record<string, unknown>) => {
    notified.push({ event, fields });
  }) as unknown as NonNullable<PaymentTextDeps["notify"]>;
  let sessions = 0;

  beforeAll(async () => {
    await runMigrations();
  }, 60_000);

  beforeEach(async () => {
    await truncateAll();
    vi.stubEnv("BETTER_AUTH_URL", "https://app.healdesk.test");
    sent = [];
    notified = [];
    sessions = 0;
    reply = async () => ({ MessageId: "msg-0001" });
    const fake = createStripeFake({
      "checkout.sessions.create": (params: unknown) => {
        sessions += 1;
        return {
          id: `cs_test_text_${sessions}`,
          url: `https://checkout.stripe.com/c/pay/cs_test_text_${sessions}`,
          status: "open",
          expires_at: (params as { expires_at: number }).expires_at,
        };
      },
      "checkout.sessions.retrieve": (id: unknown) => ({
        id,
        url: `https://checkout.stripe.com/c/pay/${String(id)}`,
        status: "open",
        payment_status: "unpaid",
        expires_at: Math.floor(NOW.getTime() / 1000) + 3600,
      }),
    });
    __setStripeForTests(fake.stripe);
  });

  afterEach(() => {
    __setStripeForTests(null);
    vi.unstubAllEnvs();
  });

  afterAll(async () => {
    await closePools();
  });

  /** The clinic's agreement in effect, of the version's own kind. */
  async function onAgreement(clinicId: string, version: string) {
    await getMigratorPool().query(
      version.startsWith("dpa/")
        ? `update clinics set regulatory_regime = 'hipaa-if-covered', agreement_kind = 'dpa', is_covered_entity = false where id = $1`
        : `update clinics set agreement_kind = 'baa' where id = $1`,
      [clinicId],
    );
    await bindAgreementInEffect(clinicId, version);
  }

  async function clinicWithBooking(label: string, version: string | null = "1.6.0") {
    const c = await seedClinic(label);
    await getMigratorPool().query(
      `update clinics set stripe_connect_account_id = $2, stripe_connect_connected_at = now() where id = $1`,
      [c.clinicId, ACCOUNT],
    );
    if (version) await onAgreement(c.clinicId, version);
    await inTenant(c.clinicId, (client) =>
      client.query(`insert into clinic_settings (clinic_id, deposits_enabled, deposit_hold_minutes) values ($1, true, 60)`, [c.clinicId]),
    );
    await withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) =>
      updateAgentConfig(tx, {
        greeting: "Hi",
        services: [{ name: "Chemical peel", priceFromUsd: null, priceToUsd: null, durationMinutes: 30, depositUsd: 75 }],
        escalationPhone: null,
        escalationHours: null,
        notes: null,
        depositPolicy: null,
      }),
    );
    // A call booking whose deposit the front desk takes, as recordDepositOutcome leaves it.
    const appointmentId = await inTenant(c.clinicId, async (client) => {
      const { rows: contact } = await client.query<{ id: string }>(
        `insert into contacts (clinic_id, phone) values ($1, $2) returning id`,
        [c.clinicId, CALLER],
      );
      const { rows } = await client.query<{ id: string }>(
        `insert into appointments (clinic_id, contact_id, scheduled_for, treatment, deposit_usd, deposit_status)
         values ($1, $2, $3, 'Chemical peel', '75.00', 'pending_front_desk') returning id`,
        [c.clinicId, contact[0]!.id, new Date(NOW.getTime() + 3 * 86_400_000)],
      );
      return rows[0]!.id;
    });
    return { clinicId: c.clinicId, appointmentId };
  }

  function bookedTurn(appointmentId: string): ToolTurn {
    return {
      reply: "You're booked for Tuesday at 10.",
      state: { ...EMPTY_TOOL_STATE, done: { kind: "booked", at: NOW.toISOString(), requestId: null, appointmentId } },
      bookingWritten: true,
      requestId: null,
      appointmentId,
    };
  }

  const ledger = (clinicId: string) =>
    inTenant(clinicId, (client) => client.query<Record<string, unknown>>(`select * from payment_link_texts order by created_at`)).then((r) => r.rows);

  const depositStatus = (clinicId: string, id: string) =>
    inTenant(clinicId, (client) => client.query<{ deposit_status: string }>(`select deposit_status from appointments where id = $1`, [id])).then(
      (r) => r.rows[0]!.deposit_status,
    );

  function tools(clinicId: string, callId = "call_one", offered = true) {
    return paymentTextTools(
      { clinicId, callId },
      { offered: async () => offered, transport, env: ENV, notify, realCalls: true },
    );
  }

  /** Offer, yes, the number, then a yes to the read-back: the whole happy path. */
  async function throughReadBack(t: ReturnType<typeof tools>, appointmentId: string): Promise<BookingToolState> {
    const offered = await t.offerAfterBooking(bookedTurn(appointmentId), NOW);
    expect(offered.reply).toBe(`You're booked for Tuesday at 10. ${PAYMENT_TEXT_LINES_EN.offer}`);
    expect(t.live(offered.state)).toBe(true);
    const yes = await t.step({ state: offered.state, answer: { paymentText: { agreed: true } }, now: LATER(5) });
    expect(yes.reply).toBe(PAYMENT_TEXT_LINES_EN.askNumber);
    const number = await t.step({ state: yes.state, answer: { paymentText: { number: "415 555 0142" } }, now: LATER(10) });
    expect(number.reply).toMatch(/^That's .+\. Is that right\?$/);
    return number.state;
  }

  test("configured and switched on: offered, and sent once to the number read back, after the yes", async () => {
    const { clinicId, appointmentId } = await clinicWithBooking("text-sent");
    const t = tools(clinicId);
    const state = await throughReadBack(t, appointmentId);
    // Nothing has left yet: no yes to the read-back.
    expect(sent).toEqual([]);
    const done = await t.step({ state, answer: { paymentText: { confirmed: true } }, now: LATER(15) });
    expect(done.reply).toBe(PAYMENT_TEXT_LINES_EN.sent);
    expect(t.live(done.state)).toBe(false);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual({
      DestinationPhoneNumber: CALLER,
      OriginationIdentity: IDENTITY,
      MessageBody: paymentLinkTextBody("https://checkout.stripe.com/c/pay/cs_test_text_1"),
      MessageType: "TRANSACTIONAL",
    });
    const [row] = await ledger(clinicId);
    expect(row).toMatchObject({ status: "sent", aws_message_id: "msg-0001", failure_code: null, call_ref_hash: callRefHash("call_one") });
    expect(row!.opted_in_at).toEqual(LATER(5));
    expect(row!.confirmed_at).toEqual(LATER(15));
    expect(row!.deposit_payment_id).toEqual(expect.any(String));
    // The deposit link was made for the call (channel voice), once.
    const deposits = await inTenant(clinicId, (client) => client.query(`select channel from deposit_payments`));
    expect(deposits.rows).toEqual([{ channel: "voice" }]);
    expect(notified).toEqual([]);
  });

  test("the ledger holds no phone number and no message body", async () => {
    const { clinicId, appointmentId } = await clinicWithBooking("text-ledger");
    const t = tools(clinicId);
    await t.step({ state: await throughReadBack(t, appointmentId), answer: { paymentText: { confirmed: true } }, now: LATER(15) });
    const rows = await ledger(clinicId);
    const dump = JSON.stringify(rows);
    expect(dump).not.toMatch(/4155550142|555.?0142/);
    expect(dump).not.toMatch(/Healdesk:|secure link|STOP|checkout\.stripe\.com/);
    expect(dump).not.toContain("call_one");
    const columns = await getMigratorPool().query<{ column_name: string }>(
      `select column_name from information_schema.columns where table_name = 'payment_link_texts' order by column_name`,
    );
    expect(columns.rows.map((c) => c.column_name)).not.toEqual(expect.arrayContaining([expect.stringMatching(/phone|number|body|message_text|destination/)]));
  });

  test("a yes without the read-back sends nothing", async () => {
    const { clinicId, appointmentId } = await clinicWithBooking("text-no-readback");
    const t = tools(clinicId);
    const offered = await t.offerAfterBooking(bookedTurn(appointmentId), NOW);
    // Yes and a confirmed flag on the same turn, with no number read back yet: asked for the number, nothing sent.
    const yes = await t.step({ state: offered.state, answer: { paymentText: { agreed: true, confirmed: true } }, now: LATER(5) });
    expect(yes.reply).toBe(PAYMENT_TEXT_LINES_EN.askNumber);
    // A number with a confirmed flag on the same turn: read back first, never sent on it.
    const number = await t.step({ state: yes.state, answer: { paymentText: { number: "4155550142", confirmed: true } }, now: LATER(10) });
    expect(number.reply).toMatch(/^That's /);
    // A turn with no answer to the read-back: the model's reply stands, still nothing sent.
    const silent = await t.step({ state: number.state, answer: null, now: LATER(12) });
    expect(silent.reply).toBeNull();
    // A no to the read-back: asked again.
    const no = await t.step({ state: number.state, answer: { paymentText: { confirmed: false } }, now: LATER(14) });
    expect(no.reply).toBe(PAYMENT_TEXT_LINES_EN.askAgain);
    expect(sent).toEqual([]);
    expect(await ledger(clinicId)).toEqual([]);
  });

  test("a no to the offer records a decline and is never offered again", async () => {
    const { clinicId, appointmentId } = await clinicWithBooking("text-declined");
    const t = tools(clinicId);
    const offered = await t.offerAfterBooking(bookedTurn(appointmentId), NOW);
    const no = await t.step({ state: offered.state, answer: { paymentText: { agreed: false } }, now: LATER(5) });
    expect(no.reply).toBe(PAYMENT_TEXT_LINES_EN.declined);
    expect(t.live(no.state)).toBe(false);
    expect((await ledger(clinicId)).map((r) => r.status)).toEqual(["declined"]);
    // A reconnected call (a new session, the same booking) is not offered it again.
    const again = await tools(clinicId, "call_two").offerAfterBooking(bookedTurn(appointmentId), LATER(60));
    expect(again.reply).toBe("You're booked for Tuesday at 10.");
    expect(sent).toEqual([]);
  });

  test("two identical confirmations, or a reconnected call, send once and return the first outcome", async () => {
    const { clinicId, appointmentId } = await clinicWithBooking("text-once");
    const t = tools(clinicId);
    const state = await throughReadBack(t, appointmentId);
    const [first, second] = await Promise.all([
      t.step({ state, answer: { paymentText: { confirmed: true } }, now: LATER(15) }),
      t.step({ state, answer: { paymentText: { confirmed: true } }, now: LATER(15) }),
    ]);
    expect(sent).toHaveLength(1);
    expect([first.reply, second.reply]).toContain(PAYMENT_TEXT_LINES_EN.sent);
    // The same tool call once more, after both settled: the first outcome back, nothing sent.
    const third = await t.step({ state, answer: { paymentText: { confirmed: true } }, now: LATER(20) });
    expect(third.reply).toBe(PAYMENT_TEXT_LINES_EN.sent);
    // A reconnect: a new session for the same booking is never offered it again.
    const other = tools(clinicId, "call_reconnect");
    const offer = await other.offerAfterBooking(bookedTurn(appointmentId), LATER(30));
    expect(other.live(offer.state)).toBe(false);
    expect(sent).toHaveLength(1);
    expect((await ledger(clinicId)).map((r) => r.status)).toEqual(["sent"]);
  });

  test("an opted-out number: the booking stands, the deposit stays with the front desk, no second attempt, no ops alert", async () => {
    const { clinicId, appointmentId } = await clinicWithBooking("text-opted-out");
    reply = async () => {
      throw Object.assign(new Error("opted out"), { name: "ConflictException", Reason: "DESTINATION_PHONE_NUMBER_OPTED_OUT" });
    };
    const t = tools(clinicId);
    const state = await throughReadBack(t, appointmentId);
    const done = await t.step({ state, answer: { paymentText: { confirmed: true } }, now: LATER(15) });
    expect(done.reply).toBe(PAYMENT_TEXT_LINES_EN.optedOut);
    expect(await depositStatus(clinicId, appointmentId)).toBe("pending_front_desk");
    expect((await ledger(clinicId)).map((r) => r.status)).toEqual(["opted_out"]);
    const again = await t.step({ state, answer: { paymentText: { confirmed: true } }, now: LATER(20) });
    expect(again.reply).toBe(PAYMENT_TEXT_LINES_EN.optedOut);
    expect(sent).toHaveLength(1);
    expect(notified).toEqual([]);
    const appointments = await inTenant(clinicId, (client) => client.query(`select id from appointments`));
    expect(appointments.rows).toEqual([{ id: appointmentId }]);
  });

  test("an AWS error: the booking stands, the deposit is the front desk's, ops are told without a patient detail, no retry", async () => {
    const { clinicId, appointmentId } = await clinicWithBooking("text-aws-error");
    reply = async () => {
      throw Object.assign(new Error("Rate exceeded for +14155550142"), { name: "ThrottlingException" });
    };
    const t = tools(clinicId);
    const state = await throughReadBack(t, appointmentId);
    const done = await t.step({ state, answer: { paymentText: { confirmed: true } }, now: LATER(15) });
    expect(done.reply).toBe(PAYMENT_TEXT_LINES_EN.notSent);
    expect(await depositStatus(clinicId, appointmentId)).toBe("pending_front_desk");
    expect((await ledger(clinicId)).map((r) => [r.status, r.failure_code])).toEqual([["failed", "throttled"]]);
    expect(notified).toEqual([{ event: "payment_text_not_sent", fields: { clinicId, code: "throttled" } }]);
    expect(JSON.stringify(notified)).not.toMatch(/4155550142|Chemical|peel|\$|cs_test/);
    await t.step({ state, answer: { paymentText: { confirmed: true } }, now: LATER(20) });
    expect(sent).toHaveLength(1);
  });

  test("a send that times out: outcome unknown, the front desk told to check Stripe first, never a plain 'collect', never sent again", async () => {
    const { clinicId, appointmentId } = await clinicWithBooking("text-timeout");
    // The booking's plain L10, queued when the call booked it.
    await withTenant({ clinicId, actor: ACTOR }, (tx) => notifyBookingAlert(tx, "deposit_to_collect", { appointmentId }));
    let attempts = 0;
    const hung = async () => {
      attempts += 1;
      return new Promise<{ MessageId?: string }>(() => undefined);
    };
    const t = paymentTextTools(
      { clinicId, callId: "call_timeout" },
      { offered: async () => true, transport: hung, env: ENV, notify, realCalls: true, smsDeadlineMs: 50 },
    );
    const state: BookingToolState = {
      ...EMPTY_TOOL_STATE,
      text: { stage: "confirming", appointmentId, number: CALLER, optedInAt: LATER(5).toISOString(), unanswered: 0 },
    };
    const done = await t.step({ state, answer: { paymentText: { confirmed: true } }, now: LATER(15) });
    // The caller is not told it failed: it may have gone.
    expect(done.reply).toBe(PAYMENT_TEXT_LINES_EN.unsure);
    expect(PAYMENT_TEXT_LINES_EN.unsure).not.toMatch(/couldn't send/);
    expect(attempts).toBe(1);
    expect((await ledger(clinicId)).map((r) => [r.status, r.failure_code])).toEqual([["failed", "unknown"]]);
    expect(await depositStatus(clinicId, appointmentId)).toBe("pending_front_desk");
    const alerts = await inTenant(clinicId, (client) =>
      client.query<{ dedupe_key: string; sent_at: Date | null; recipients_count: number | null; payload: Record<string, unknown> }>(
        `select dedupe_key, sent_at, recipients_count, payload from billing_notices where kind = 'deposit_to_collect' order by created_at`,
      ),
    ).then((r) => r.rows);
    // The plain "collect" email is closed unsent; the possibly-paid one replaces it.
    expect(alerts.map((a) => [a.dedupe_key, a.sent_at !== null, a.recipients_count, a.payload.isPossiblyPaid])).toEqual([
      [dedupeKey("deposit_to_collect", { appointmentId }), true, 0, false],
      [dedupeKey("deposit_to_collect", { appointmentId, mayBePaid: true }), false, null, true],
    ]);
    expect(notified).toEqual([{ event: "payment_text_not_sent", fields: { clinicId, code: "unknown" } }]);
    // The same confirmation again (a retried tool call): the same answer, no second attempt.
    const again = await t.step({ state, answer: { paymentText: { confirmed: true } }, now: LATER(20) });
    expect(again.reply).toBe(PAYMENT_TEXT_LINES_EN.unsure);
    expect(attempts).toBe(1);
  });

  test("a retried confirmation while the first attempt is in flight is never told it failed", async () => {
    const { clinicId, appointmentId } = await clinicWithBooking("text-inflight");
    await inTenant(clinicId, (client) =>
      client.query(
        `insert into payment_link_texts (clinic_id, appointment_id, call_ref_hash, status, opted_in_at, confirmed_at, created_at)
         values ($1, $2, $3, 'queued', $4, $4, $4)`,
        [clinicId, appointmentId, callRefHash("call_one"), LATER(5)],
      ),
    );
    const state: BookingToolState = {
      ...EMPTY_TOOL_STATE,
      text: { stage: "confirming", appointmentId, number: CALLER, optedInAt: LATER(5).toISOString(), unanswered: 0 },
    };
    const done = await tools(clinicId).step({ state, answer: { paymentText: { confirmed: true } }, now: LATER(15) });
    expect(done.reply).toBe(PAYMENT_TEXT_LINES_EN.unsure);
    expect(sent).toEqual([]);
  });

  test("an unknown outcome for a deposit already paid queues no 'may be paid' email", async () => {
    const { clinicId, appointmentId } = await clinicWithBooking("text-unknown-paid");
    const t = paymentTextTools(
      { clinicId, callId: "call_paid" },
      {
        offered: async () => true,
        env: ENV,
        notify,
        realCalls: true,
        smsDeadlineMs: 50,
        // The caller pays the link while AWS has not answered.
        transport: async () => {
          await inTenant(clinicId, (client) => client.query(`update appointments set deposit_status = 'paid' where id = $1`, [appointmentId]));
          return new Promise<{ MessageId?: string }>(() => undefined);
        },
      },
    );
    const state: BookingToolState = {
      ...EMPTY_TOOL_STATE,
      text: { stage: "confirming", appointmentId, number: CALLER, optedInAt: LATER(5).toISOString(), unanswered: 0 },
    };
    await t.step({ state, answer: { paymentText: { confirmed: true } }, now: LATER(15) });
    expect(await depositStatus(clinicId, appointmentId)).toBe("paid");
    const alerts = await inTenant(clinicId, (client) => client.query(`select 1 from billing_notices where kind = 'deposit_to_collect'`));
    expect(alerts.rows).toEqual([]);
  });

  test("in Spanish, an unknown outcome is said as unconfirmed too", async () => {
    const { clinicId, appointmentId } = await clinicWithBooking("text-unknown-es");
    const t = paymentTextTools(
      { clinicId, callId: "call_es" },
      { offered: async () => true, env: ENV, notify, realCalls: true, smsDeadlineMs: 50, transport: () => new Promise(() => undefined) },
    );
    const state: BookingToolState = {
      ...EMPTY_TOOL_STATE,
      text: { stage: "confirming", appointmentId, number: CALLER, optedInAt: LATER(5).toISOString(), unanswered: 0 },
    };
    const done = await t.step({ state, answer: { paymentText: { confirmed: true } }, now: LATER(15), language: "es" });
    expect(done.reply).toBe(PAYMENT_TEXT_LINES_ES.unsure);
    expect(PAYMENT_TEXT_LINES_ES.unsure).toMatch(/no pude confirmar/);
  });

  test("a definite refusal is not 'unknown': the plain front-desk path", () => {
    expect(smsFailureCode({ name: "ValidationException", Reason: "INVALID_PHONE_NUMBER" })).toBe("invalid_number");
    expect(smsFailureCode({ name: "ConflictException", Reason: "DESTINATION_PHONE_NUMBER_OPTED_OUT" })).toBe("opted_out");
    expect(smsFailureCode({ name: "TimeoutError" })).toBe("unknown");
    expect(smsFailureCode({ name: "AbortError" })).toBe("unknown");
  });

  test("the one-text gate reads the ledger: a claim settled elsewhere before the send sends nothing", async () => {
    const { clinicId, appointmentId } = await clinicWithBooking("text-gate-ledger");
    const t = paymentTextTools(
      { clinicId, callId: "call_gate" },
      {
        offered: async () => true,
        transport,
        env: ENV,
        notify,
        realCalls: true,
        // While the link is made, something else settles the booking's claim.
        createLink: async (clinic, appointment, options) => {
          await inTenant(clinicId, (client) =>
            client.query(`update payment_link_texts set status = 'failed', failure_code = 'error', settled_at = now() where appointment_id = $1`, [
              appointmentId,
            ]),
          );
          return createDepositLink(clinic, appointment, options);
        },
      },
    );
    const state: BookingToolState = {
      ...EMPTY_TOOL_STATE,
      text: { stage: "confirming", appointmentId, number: CALLER, optedInAt: LATER(5).toISOString(), unanswered: 0 },
    };
    const done = await t.step({ state, answer: { paymentText: { confirmed: true } }, now: LATER(15) });
    expect(done.reply).toBe(PAYMENT_TEXT_LINES_EN.notSent);
    expect(sent).toEqual([]);
  });

  test("a deposit not yet with the front desk is handed to it when the text fails", async () => {
    const { clinicId, appointmentId } = await clinicWithBooking("text-to-desk");
    await inTenant(clinicId, (client) => client.query(`update appointments set deposit_status = 'pending_link' where id = $1`, [appointmentId]));
    reply = async () => ({});
    const t = paymentTextTools({ clinicId, callId: "call_desk" }, { offered: async () => true, transport, env: ENV, notify, realCalls: true });
    const state: BookingToolState = {
      ...EMPTY_TOOL_STATE,
      text: { stage: "confirming", appointmentId, number: CALLER, optedInAt: LATER(5).toISOString(), unanswered: 0 },
    };
    const done = await t.step({ state, answer: { paymentText: { confirmed: true } }, now: LATER(15) });
    expect(done.reply).toBe(PAYMENT_TEXT_LINES_EN.notSent);
    expect(await depositStatus(clinicId, appointmentId)).toBe("pending_front_desk");
  });

  test("the switch turned off mid-call: nothing is sent", async () => {
    const { clinicId, appointmentId } = await clinicWithBooking("text-switch-off");
    const state = await throughReadBack(tools(clinicId), appointmentId);
    const off = tools(clinicId, "call_one", false);
    const done = await off.step({ state, answer: { paymentText: { confirmed: true } }, now: LATER(15) });
    expect(done.reply).toBe(PAYMENT_TEXT_LINES_EN.notSent);
    expect(sent).toEqual([]);
    expect(await ledger(clinicId)).toEqual([]);
  });

  test("not offered when the switch is off, or the deposit is not owed", async () => {
    const { clinicId, appointmentId } = await clinicWithBooking("text-not-offered");
    expect((await tools(clinicId, "call_one", false).offerAfterBooking(bookedTurn(appointmentId), NOW)).state.text).toBeUndefined();
    await inTenant(clinicId, (client) => client.query(`update appointments set deposit_status = 'paid' where id = $1`, [appointmentId]));
    expect((await tools(clinicId).offerAfterBooking(bookedTurn(appointmentId), NOW)).state.text).toBeUndefined();
  });

  test("only under an agreement that covers it: BAA 1.5.x, DPA 1.0.0 or no agreement is never offered or sent", async () => {
    for (const [version, covered] of [
      ["1.5.1", false],
      ["1.6.0", true],
      ["dpa/1.0.0", false],
      ["dpa/1.1.0", true],
      [null, false],
    ] as const) {
      const label = `text-agr-${String(version).replace(/[^a-z0-9]/gi, "")}`;
      const { clinicId, appointmentId } = await clinicWithBooking(label, version);
      // Offer time: the injected readiness says yes, the agreement decides.
      const offer = await tools(clinicId).offerAfterBooking(bookedTurn(appointmentId), NOW);
      expect(Boolean(offer.state.text), String(version)).toBe(covered);
      // Send time: a call that somehow reached the yes is still refused.
      const state: BookingToolState = {
        ...EMPTY_TOOL_STATE,
        text: { stage: "confirming", appointmentId, number: CALLER, optedInAt: LATER(5).toISOString(), unanswered: 0 },
      };
      const before = sent.length;
      const done = await tools(clinicId, `call_${label}`).step({ state, answer: { paymentText: { confirmed: true } }, now: LATER(15) });
      expect(done.reply, String(version)).toBe(covered ? PAYMENT_TEXT_LINES_EN.sent : PAYMENT_TEXT_LINES_EN.notSent);
      expect(sent.length - before, String(version)).toBe(covered ? 1 : 0);
      if (!covered) expect(await ledger(clinicId)).toEqual([]);
    }
  });

  test("an agreement kind the clinic's own record disagrees with is not covered", async () => {
    const { clinicId, appointmentId } = await clinicWithBooking("text-agr-mismatch");
    await getMigratorPool().query(`update clinics set agreement_kind = null where id = $1`, [clinicId]);
    expect((await tools(clinicId).offerAfterBooking(bookedTurn(appointmentId), NOW)).state.text).toBeUndefined();
  });

  describe("the front desk is never told to collect a deposit the caller was texted a link for", () => {
    const deskAlerts = (clinicId: string) =>
      inTenant(clinicId, (client) =>
        client.query<{ dedupe_key: string; send_after: Date; sent_at: Date | null; payload: Record<string, unknown> }>(
          `select dedupe_key, send_after, sent_at, payload from billing_notices where kind = 'deposit_to_collect' order by created_at`,
        ),
      ).then((r) => r.rows);

    /** The booking's L10, queued as recordDepositOutcome queues it when the call books. */
    async function bookedWithAlert(label: string) {
      const booked = await clinicWithBooking(label);
      await withTenant({ clinicId: booked.clinicId, actor: ACTOR }, (tx) =>
        notifyBookingAlert(tx, "deposit_to_collect", { appointmentId: booked.appointmentId }),
      );
      return booked;
    }

    test("sent: the L10 is held, then closed unsent; Bookings says the link was texted and counts nothing to collect", async () => {
      const { clinicId, appointmentId } = await bookedWithAlert("text-desk-sent");
      const t = tools(clinicId);
      const state = await throughReadBack(t, appointmentId);
      // Held while the text is offered.
      const [held] = await deskAlerts(clinicId);
      // Pushed on by each turn of the text: five minutes from the read-back's turn.
      expect(held!.send_after).toEqual(new Date(LATER(10).getTime() + DESK_ALERT_HOLD_MS));
      await t.step({ state, answer: { paymentText: { confirmed: true } }, now: LATER(15) });
      expect(await depositStatus(clinicId, appointmentId)).toBe("pending_link");

      // Bookings: the "not paid yet" wording, never one to collect.
      const appt = { depositStatus: "pending_link" as const, status: "scheduled" as const, scheduledFor: new Date(NOW.getTime() + 3 * 86_400_000) };
      expect(isDepositToCollect(appt, NOW)).toBe(false);
      expect(depositBadge(appt, NOW)).toEqual({ label: "Deposit not paid yet", tone: "waiting" });
      expect(bookingDepositLine({ depositStatus: "pending_link", depositUsd: "75.00", depositLinkMade: true })).toBe(
        "Deposit of $75: payment link sent, not paid yet",
      );

      // The held L10, when it comes due, is closed unsent.
      const reason = await withTenant({ clinicId, actor: ACTOR }, (tx) => supersededReason(tx, "deposit_to_collect", held!.payload));
      expect(reason).toMatch(/payment link went out/);
      expect(JSON.stringify(held!.payload)).not.toMatch(/4155550142|Chemical|peel|\$|cs_test/);

      // The texted link lapses unpaid: the deposit is the front desk's again, with an L10 of its own.
      const [deposit] = await inTenant(clinicId, (client) => client.query<{ id: string }>(`select id from deposit_payments`)).then((r) => r.rows);
      await withTenant({ clinicId, actor: ACTOR }, (tx) =>
        recordDepositLapsed(tx, { depositId: deposit!.id, status: "expired", from: ["open"], eventId: null, at: LATER(3600) }),
      );
      expect(await depositStatus(clinicId, appointmentId)).toBe("pending_front_desk");
      const keys = (await deskAlerts(clinicId)).map((a) => a.dedupe_key);
      expect(keys).toEqual([
        dedupeKey("deposit_to_collect", { appointmentId }),
        dedupeKey("deposit_to_collect", { appointmentId, depositId: deposit!.id }),
      ]);
      const [, lapsed] = await deskAlerts(clinicId);
      expect(await withTenant({ clinicId, actor: ACTOR }, (tx) => supersededReason(tx, "deposit_to_collect", lapsed!.payload))).toBeNull();
    });

    test("a slow caller: every turn pushes the hold on, and a text is refused once the L10 has gone", async () => {
      const { clinicId, appointmentId } = await bookedWithAlert("text-desk-slow");
      const t = tools(clinicId);
      const offered = await t.offerAfterBooking(bookedTurn(appointmentId), NOW);
      const yes = await t.step({ state: offered.state, answer: { paymentText: { agreed: true } }, now: LATER(240) });
      // Asked for the number four minutes in: the hold runs five minutes from this turn.
      expect((await deskAlerts(clinicId))[0]!.send_after).toEqual(new Date(LATER(240).getTime() + DESK_ALERT_HOLD_MS));
      const number = await t.step({ state: yes.state, answer: { paymentText: { number: "4155550142" } }, now: LATER(420) });
      expect((await deskAlerts(clinicId))[0]!.send_after).toEqual(new Date(LATER(420).getTime() + DESK_ALERT_HOLD_MS));
      // Meanwhile the outbox sends the L10 anyway (say the hold could not be written).
      await inTenant(clinicId, (client) =>
        client.query(
          `update billing_notices set sent_at = now(), recipients_count = 1, attempts = 1 where clinic_id = $1 and kind = 'deposit_to_collect'`,
          [clinicId],
        ),
      );
      const done = await t.step({ state: number.state, answer: { paymentText: { confirmed: true } }, now: LATER(430) });
      expect(done.reply).toBe(PAYMENT_TEXT_LINES_EN.notSent);
      expect(sent).toEqual([]);
      expect(await depositStatus(clinicId, appointmentId)).toBe("pending_front_desk");
      expect(await ledger(clinicId)).toEqual([]);
    });

    /** A claim left queued with its link made: the process died, maybe after AWS accepted the text. */
    async function leftQueued(clinicId: string, appointmentId: string): Promise<string> {
      return inTenant(clinicId, async (client) => {
        await client.query(
          `insert into payment_link_texts (clinic_id, appointment_id, call_ref_hash, status, opted_in_at, confirmed_at, created_at)
           values ($1, $2, $3, 'queued', $4, $4, $4)`,
          [clinicId, appointmentId, callRefHash("call_crash"), LATER(5)],
        );
        const { rows } = await client.query<{ id: string }>(
          `insert into deposit_payments (clinic_id, appointment_id, channel, amount_cents, stripe_account_id, status, checkout_session_id, expires_at)
           values ($1, $2, 'voice', 7500, $3, 'open', 'cs_crash', $4) returning id`,
          [clinicId, appointmentId, ACCOUNT, LATER(3600)],
        );
        await client.query(`update appointments set deposit_status = 'pending_link' where id = $1`, [appointmentId]);
        return rows[0]!.id;
      });
    }

    test("a claim left queued (a crash, maybe after AWS accepted it): staff get only the possibly-paid email, never a plain 'collect'", async () => {
      const { clinicId, appointmentId } = await bookedWithAlert("text-desk-crash");
      await leftQueued(clinicId, appointmentId);
      const [held] = await deskAlerts(clinicId);
      // When the held plain L10 comes due, the outbox asks: it is closed, and the possibly-paid one queued.
      const reason = await withTenant({ clinicId, actor: ACTOR }, (tx) => supersededReason(tx, "deposit_to_collect", held!.payload));
      expect(reason).toMatch(/outcome is unknown/);
      expect(await depositStatus(clinicId, appointmentId)).toBe("pending_front_desk");
      // The hand-over is audited, as the tool layer's own is, with no patient detail.
      const audit = await inTenant(clinicId, (client) =>
        client.query<{ metadata: Record<string, unknown> }>(
          `select metadata from audit_log where resource_type = 'appointment' and resource_id = $1 and metadata->>'reason' = 'payment_text_unknown'`,
          [appointmentId],
        ),
      );
      expect(audit.rows.map((r) => r.metadata.outcome)).toEqual(["deposit_to_front_desk"]);
      const alerts = await deskAlerts(clinicId);
      expect(alerts.map((a) => [a.dedupe_key, a.payload.isPossiblyPaid])).toEqual([
        [dedupeKey("deposit_to_collect", { appointmentId }), false],
        [dedupeKey("deposit_to_collect", { appointmentId, mayBePaid: true }), true],
      ]);
      // Exactly one email goes: the plain one is superseded, the possibly-paid one is not.
      expect(await withTenant({ clinicId, actor: ACTOR }, (tx) => supersededReason(tx, "deposit_to_collect", alerts[1]!.payload))).toBeNull();
      // Asked again (a retried outbox run), nothing new is queued.
      await withTenant({ clinicId, actor: ACTOR }, (tx) => supersededReason(tx, "deposit_to_collect", held!.payload));
      expect(await deskAlerts(clinicId)).toHaveLength(2);
      // And the sweep has nothing left to do once the link expires.
      const later = new Date(LATER(3600).getTime() + OPEN_LINK_EXPIRY_GRACE_MS + 60_000);
      expect(await flagStaleOpenDepositsFor(clinicId, later)).toBe(0);
    });

    test("the possibly-paid email is never closed by the queued-text rule, even when a later link moves the deposit back", async () => {
      const { clinicId, appointmentId } = await bookedWithAlert("text-desk-pp");
      await leftQueued(clinicId, appointmentId);
      const [held] = await deskAlerts(clinicId);
      await withTenant({ clinicId, actor: ACTOR }, (tx) => supersededReason(tx, "deposit_to_collect", held!.payload));
      const possiblyPaid = (await deskAlerts(clinicId))[1]!;
      expect(possiblyPaid.payload.isPossiblyPaid).toBe(true);
      // A later link moves the deposit pending_front_desk -> pending_link while the text row is still queued.
      await inTenant(clinicId, (client) => client.query(`update appointments set deposit_status = 'pending_link' where id = $1`, [appointmentId]));
      expect(await withTenant({ clinicId, actor: ACTOR }, (tx) => supersededReason(tx, "deposit_to_collect", possiblyPaid.payload))).toBeNull();
    });

    test("an expired open link with no word from Stripe is swept to the desk as possibly paid, once", async () => {
      const { clinicId, appointmentId } = await clinicWithBooking("text-desk-sweep");
      const depositId = await inTenant(clinicId, async (client) => {
        const { rows } = await client.query<{ id: string }>(
          `insert into deposit_payments (clinic_id, appointment_id, channel, amount_cents, stripe_account_id, status, checkout_session_id, expires_at)
           values ($1, $2, 'voice', 7500, $3, 'open', 'cs_sweep', $4) returning id`,
          [clinicId, appointmentId, ACCOUNT, LATER(3600)],
        );
        await client.query(`update appointments set deposit_status = 'pending_link' where id = $1`, [appointmentId]);
        return rows[0]!.id;
      });
      const later = new Date(LATER(3600).getTime() + OPEN_LINK_EXPIRY_GRACE_MS + 60_000);
      expect(await flagStaleOpenDepositsFor(clinicId, new Date(LATER(3600).getTime() + 60_000))).toBe(0);
      expect(await flagStaleOpenDepositsFor(clinicId, later)).toBe(1);
      expect(await flagStaleOpenDepositsFor(clinicId, later)).toBe(0);
      expect(await depositStatus(clinicId, appointmentId)).toBe("pending_front_desk");
      expect((await deskAlerts(clinicId)).map((a) => [a.dedupe_key, a.payload.isPossiblyPaid])).toEqual([
        [dedupeKey("deposit_to_collect", { appointmentId, depositId, mayBePaid: true }), true],
      ]);
    });

    test("the sweep's expired-link check runs even when the unlinked-deposit check throws", async () => {
      const { clinicId, appointmentId } = await clinicWithBooking("text-desk-sweep-indep");
      await inTenant(clinicId, async (client) => {
        await client.query(
          `insert into deposit_payments (clinic_id, appointment_id, channel, amount_cents, stripe_account_id, status, checkout_session_id, expires_at)
           values ($1, $2, 'voice', 7500, $3, 'open', 'cs_sweep_indep', $4)`,
          [clinicId, appointmentId, ACCOUNT, LATER(3600)],
        );
        await client.query(`update appointments set deposit_status = 'pending_link' where id = $1`, [appointmentId]);
      });
      const later = new Date(LATER(3600).getTime() + OPEN_LINK_EXPIRY_GRACE_MS + 60_000);
      const summary = await sweepUnlinkedDeposits(later, [
        { check: async () => Promise.reject(new Error("boom")), failed: "unlinked deposits not swept" },
        { check: flagStaleOpenDepositsFor, failed: "expired open deposit links not swept" },
      ]);
      expect(summary).toMatchObject({ clinics: 1, flagged: 1, failures: 1 });
      // And the sweep's own list runs both checks: dropping either fails here.
      expect(SWEEP_CHECKS.map((c) => c.check)).toEqual([flagUnlinkedDepositsFor, flagStaleOpenDepositsFor]);
      expect(await depositStatus(clinicId, appointmentId)).toBe("pending_front_desk");
    });

    test("declined: the held L10 goes at once, and still goes when due", async () => {
      const { clinicId, appointmentId } = await bookedWithAlert("text-desk-declined");
      const t = tools(clinicId);
      const offered = await t.offerAfterBooking(bookedTurn(appointmentId), NOW);
      await t.step({ state: offered.state, answer: { paymentText: { agreed: false } }, now: LATER(5) });
      const [alert] = await deskAlerts(clinicId);
      expect(alert!.send_after).toEqual(LATER(5));
      expect(await withTenant({ clinicId, actor: ACTOR }, (tx) => supersededReason(tx, "deposit_to_collect", alert!.payload))).toBeNull();
    });

    test("a failed send releases the held L10 at once", async () => {
      const { clinicId, appointmentId } = await bookedWithAlert("text-desk-failed");
      reply = async () => {
        throw Object.assign(new Error("boom"), { name: "InternalServerException" });
      };
      const t = tools(clinicId);
      const state = await throughReadBack(t, appointmentId);
      await t.step({ state, answer: { paymentText: { confirmed: true } }, now: LATER(15) });
      const [alert] = await deskAlerts(clinicId);
      expect(alert!.send_after).toEqual(LATER(15));
      expect(await depositStatus(clinicId, appointmentId)).toBe("pending_front_desk");
    });
  });

  test("a closed clinic's deposits purge on the record clock, a ledger row naming one never stops it", async () => {
    const { clinicId, appointmentId } = await clinicWithBooking("text-purge-closed");
    const DAY = 86_400_000;
    const now = Date.now();
    // A text sent for a booking long past the record clock (app_record_cutoff).
    await inTenant(clinicId, async (client) => {
      await client.query(`update appointments set scheduled_for = $2 where id = $1`, [appointmentId, new Date(now - 120 * DAY)]);
      const { rows } = await client.query<{ id: string }>(
        `insert into deposit_payments (clinic_id, appointment_id, channel, amount_cents, stripe_account_id, status, checkout_session_id, created_at)
         values ($1, $2, 'voice', 7500, $3, 'expired', 'cs_purge_text', $4) returning id`,
        [clinicId, appointmentId, ACCOUNT, new Date(now - 125 * DAY)],
      );
      const { rows: text } = await client.query<{ id: string }>(
        `insert into payment_link_texts (clinic_id, appointment_id, call_ref_hash, status, opted_in_at, confirmed_at, created_at)
         values ($1, $2, $3, 'queued', $4, $4, $4) returning id`,
        [clinicId, appointmentId, callRefHash("call_purge"), new Date(now - 125 * DAY)],
      );
      await client.query(
        `update payment_link_texts set status = 'sent', aws_message_id = 'msg-purge', deposit_payment_id = $2, settled_at = $3 where id = $1`,
        [text[0]!.id, rows[0]!.id, new Date(now - 125 * DAY)],
      );
    });
    await getMigratorPool().query(`update clinics set account_closed_at = now() where id = $1`, [clinicId]);
    const purged = await asApp(clinicId, (q) =>
      q.query<{ deposits_deleted: number }>(`select * from app_purge_deposit_payments(app_record_cutoff())`),
    );
    expect(purged.rows[0]!.deposits_deleted).toBe(1);
    // The ledger row stays with its appointment, untouched, until the appointment goes.
    expect((await ledger(clinicId)).map((r) => r.status)).toEqual(["sent"]);
  });

  test("a settled ledger row never changes, and a queued one only settles once", async () => {
    const { clinicId, appointmentId } = await clinicWithBooking("text-guard");
    const t = tools(clinicId);
    await t.step({ state: await throughReadBack(t, appointmentId), answer: { paymentText: { confirmed: true } }, now: LATER(15) });
    await expect(
      inTenant(clinicId, (client) => client.query(`update payment_link_texts set status = 'failed', failure_code = 'error', aws_message_id = null`)),
    ).rejects.toThrow(/settled text/);
    await expect(
      inTenant(clinicId, (client) => client.query(`update payment_link_texts set opted_in_at = now()`)),
    ).rejects.toThrow();
  });

  describe("through the shared turn", () => {
    const facts: AssistantFacts = {
      clinicId: "00000000-0000-0000-0000-000000000000",
      clinicName: "Radiance Med Spa",
      specialty: "med-spa",
      timeZone: "America/Los_Angeles",
      phone: "+15125550100",
      urgentPhone: null,
      vetReferralPhone: null,
      directLine: null,
      address: null,
      hours: [],
      openingHours: null,
      services: [],
      policies: [],
      quickAnswers: [],
      promotions: null,
      notes: null,
      escalationHours: null,
      neverSay: [],
      requirements: [],
      greeting: { phone: "Looking to book, or got a question?", chat: "How can I help?" },
      tone: "warm",
      languages: ["en"],
      suggestAddOns: false,
      providerNames: [],
    };

    test("the offer joins the booked line, the step's line replaces the model's words, and nothing is spoken early", async () => {
      const { clinicId, appointmentId } = await clinicWithBooking("text-turn");
      const t = tools(clinicId);
      const booking: BookingTools = {
        channel: "voice",
        available: async () => true,
        run: async () => bookedTurn(appointmentId),
      };
      const said: string[] = [];
      const responder = (raw: string): AssistantResponder =>
        (async () => raw) as unknown as AssistantResponder;
      const first = await answerTurn({
        facts,
        channel: "voice",
        history: [{ speaker: "assistant", text: "Hi! I'm the AI assistant at Radiance Med Spa, and this call's transcribed." }],
        text: "Tuesday at 10 works.",
        responder: responder(JSON.stringify({ reply: "Great.", action: { type: "choose_time", at: NOW.toISOString() } })),
        tools: booking,
        paymentText: t,
        now: NOW,
      });
      expect(first.source).toBe("tool");
      expect(first.reply).toBe(`You're booked for Tuesday at 10. ${PAYMENT_TEXT_LINES_EN.offer}`);
      const second = await answerTurn({
        facts,
        channel: "voice",
        history: [{ speaker: "assistant", text: first.reply }],
        text: "Yes please, text me.",
        responder: responder(`Sure thing, I'll text it now!\n###\n${JSON.stringify({ state: { paymentText: { agreed: true } } })}`),
        tools: booking,
        toolState: first.toolState,
        paymentText: t,
        speak: (sentence) => said.push(sentence),
        now: LATER(5),
      });
      expect(said).toEqual([]);
      expect(second.reply).toBe(PAYMENT_TEXT_LINES_EN.askNumber);
      expect(sent).toEqual([]);
    });
  });
});

describe("the ops alert for a text that did not go", () => {
  test("says what the code paths that raise it make true, and where the key is read", () => {
    const w = ALERT_WORDING.payment_text_not_sent!;
    // `error` is raised for a ledger row that could not be written too, before anything was sent.
    expect(w.whatHappened).toMatch(/record of the text may not have been written, in which case nothing was sent/);
    expect(w.whatHappened).not.toMatch(/confirmed their number, and the text did not go/);
    // For an unknown outcome it never claims the text did not go.
    expect(w.whatHappened).toMatch(/for the code unknown, AWS did not answer in time, so the text may have gone/);
    // The web tier reads the texting number too, so a restart covers both.
    expect(w.steps[0]).toMatch(/web tier and the voice line both read it/);
    expect(w.steps[0]).not.toMatch(/redeploy the voice line\.$/);
    expect(JSON.stringify(w)).not.toMatch(/\+1\d{10}|Chemical|peel/);
  });
});
