import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

import { EMPTY_TOOL_STATE, type BookingTools, type BookingToolState, type ToolTurn } from "@/lib/assistant/booking-tools";
import type { AssistantFacts } from "@/lib/assistant/facts";
import { answerTurn, type AssistantResponder } from "@/lib/assistant/turn";
import { __setStripeForTests } from "@/lib/billing/stripe-client";
import { updateAgentConfig } from "@/lib/onboarding/agent-config";
import {
  callRefHash,
  PAYMENT_TEXT_LINES_EN,
  paymentTextAnswer,
  paymentTextTools,
  textableNumber,
  type PaymentTextDeps,
} from "@/lib/sms/payment-text";
import { PAYMENT_LINK_TEXT_TEMPLATE, paymentLinkTextBody, smsFailureCode, type SmsRequest } from "@/lib/sms/send";
import { agreementVersionCoversText } from "@/lib/sms/agreement";
import { smsOriginationIdentity, smsSenderConfigured } from "@/lib/sms/config";
import { withTenant } from "@/lib/tenant";

import { closePools, getMigratorPool, hasTestDatabase, runMigrations, truncateAll } from "./setup/db";
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
    for (const v of ["1.5.1", "1.5.0", "1.2.1", "dpa/1.0.0", "1.1.0-draft", "1.7.0", "dpa/1.2.0", "dpa/", "", "1.6", "v1.6.0", null, undefined]) {
      expect(agreementVersionCoversText(v), String(v)).toBe(false);
    }
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
