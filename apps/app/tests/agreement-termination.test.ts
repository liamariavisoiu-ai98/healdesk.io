import { randomUUID } from "node:crypto";

import type Stripe from "stripe";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

import { assistantMayAnswer } from "@/lib/billing/answering";
import { handleStripeEvent } from "@/lib/billing/events";
import { reconcileBilling } from "@/lib/billing/reconcile";
import { drainBillingRequests } from "@/lib/billing/requests";
import { commitRefund, previewRefund } from "@/lib/billing/stripe-actions";
import { assertPayloadAllowed } from "@/lib/email/lint";
import { destroyDueClinics } from "@/lib/offboarding/offboarding";
import { runOperation, type Operator } from "@/lib/ops/api";
import { COVERAGE_VENDORS } from "@/lib/compliance/vendor-coverage";

import { asApp } from "./setup/calendar-db";
import {
  closePools,
  getMigratorPool,
  hasTestDatabase,
  runMigrations,
  truncateAll,
} from "./setup/db";
import { inTenant, seedChannels, seedClinic, seedEntitled } from "./setup/factories";
import { createStripeWorld, type StripeWorld } from "./setup/stripe-world";
import { attestPlatform } from "./setup/platform";

/**
 * Ending the agreement ends the Services (BAA 1.3.0 clause 1, clause 17 ¶3,
 * clause 20; the C19 audit's blocker 1). A recorded termination that leaves a
 * practice no agreement in effect stops the assistant, refuses new patient
 * rows in the database, starts every location's offboarding, cancels the
 * subscription at once without proration, and, for the two endings clause 17
 * refunds, lets the operator preview and confirm the fees paid for time after
 * the day. A practice another agreement still covers is untouched. Stripe is
 * the stateful fake the billing tests use; nothing reaches Stripe.
 */

const notifyOps = vi.hoisted(() => vi.fn(async () => {}));
const notifyOpsOnce = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("@/lib/ops/notify", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ops/notify")>()),
  notifyOps,
  notifyOpsOnce,
}));

const describeDb = hasTestDatabase ? describe : describe.skip;

const OPERATOR: Operator = { email: "ops@healdesk.test", request: {} };
const ACTOR = { type: "service", serviceName: "agreement-termination-test" } as const;
const DAY = 24 * 60 * 60 * 1000;
const LINE = "+14155550100";
const s = (date: Date) => Math.floor(date.getTime() / 1000);

/**
 * The run's clock, read once and passed as `now` to every call that takes
 * one, so a run that crosses UTC midnight stays on one day: the refund's
 * proration, the § 5 window and the fake Stripe all count from it. Only the
 * database's own now() moves on, and nothing here compares to it closely.
 */
const NOW = new Date();
/** Today's UTC midnight: the termination is recorded for today, as an operator would. */
const TODAY = new Date(Date.UTC(NOW.getUTCFullYear(), NOW.getUTCMonth(), NOW.getUTCDate()));
const TODAY_ON = TODAY.toISOString().slice(0, 10);
/** A monthly period of thirty days that started eleven days ago: 18 of its 30 days are after tomorrow's start. */
const PERIOD_START = new Date(TODAY.getTime() - 11 * DAY);
const PERIOD_END = new Date(PERIOD_START.getTime() + 30 * DAY);
const PACKAGE_CENTS = 89_700;

async function run(op: Parameters<typeof runOperation>[0], args: Record<string, unknown>) {
  const outcome = await runOperation(op, args, OPERATOR);
  expect(outcome.status, JSON.stringify(outcome)).toBe(200);
  return (outcome.body as { data: Record<string, unknown> }).data;
}

/** A bound agreement for the organisation, accepted `daysAgo` days ago, as the migrator. */
async function bindAgreement(
  organizationId: string,
  daysAgo: number,
  version = "1.2.1",
): Promise<string> {
  const id = randomUUID();
  await getMigratorPool().query(
    `insert into baa_acceptances
       (id, organization_id, document_version, document_hash, rendered_text, variables, assent_label,
        accepted_by_name, accepted_by_email, accepted_at, bound_at)
     values ($1, $2, $3, repeat('d', 64), 'AGREEMENT (test)', '{}'::jsonb, 'I agree', 'Alex Chen',
             'alex@termination.test', now() - make_interval(days => $4), now() - make_interval(days => $4))`,
    [id, organizationId, version, daysAgo],
  );
  return id;
}

/** A second location of the same practice, billed on `billingClinicId`. */
async function seedLocation(
  organizationId: string,
  billingClinicId: string,
  label: string,
): Promise<string> {
  const { rows } = await getMigratorPool().query<{ id: string }>(
    `insert into clinics (organization_id, slug, name, specialty, billing_clinic_id)
     values ($1, $2, $3, 'med-spa', $4) returning id`,
    [organizationId, `${label}-${randomUUID().slice(0, 6)}`, `${label} Clinic`, billingClinicId],
  );
  return rows[0]!.id;
}

/** Live under the agreement: production, with baa_signed_at as go-live copies it. */
async function makeProduction(clinicIds: string[]): Promise<void> {
  await getMigratorPool().query(
    `update clinics set data_classification = 'production', baa_signed_at = now() - interval '30 days',
            went_live_at = now() - interval '30 days'
      where id = any($1::uuid[])`,
    [clinicIds],
  );
}

async function setDirectLine(clinicId: string, line: string): Promise<void> {
  await inTenant(clinicId, (c) =>
    c.query(
      `insert into clinic_settings (clinic_id, direct_line_e164) values ($1, $2)
       on conflict (clinic_id) do update set direct_line_e164 = excluded.direct_line_e164`,
      [clinicId, line],
    ),
  );
}

/** A new patient row, as the runtime role writes one. */
function insertContact(clinicId: string, phone: string) {
  return asApp(clinicId, (c) =>
    c.query(`insert into contacts (clinic_id, phone) values ($1, $2) returning id`, [
      clinicId,
      phone,
    ]),
  );
}

async function offboardingOf(clinicId: string): Promise<Date | null> {
  const { rows } = await getMigratorPool().query<{ offboarding_started_at: Date | null }>(
    `select offboarding_started_at from clinics where id = $1`,
    [clinicId],
  );
  return rows[0]!.offboarding_started_at;
}

/** A clinic's offboarding clock: when it started and when destruction is due. */
async function clockOf(clinicId: string) {
  const { rows } = await getMigratorPool().query<{
    offboarding_started_at: Date | null;
    destroy_after: Date | null;
  }>(`select offboarding_started_at, destroy_after from clinics where id = $1`, [clinicId]);
  return rows[0]!;
}

async function requestsOf(clinicId: string) {
  return inTenant(
    clinicId,
    async (c) =>
      (
        await c.query<{ kind: string; reason: string; outcome: string | null }>(
          `select kind, reason, outcome from billing_requests where clinic_id = $1 order by kind`,
          [clinicId],
        )
      ).rows,
  );
}

/** The billing-requests job's switch: it ships off (drizzle/0050), and truncateAll seeds it off. */
async function setBillingRequestsJob(enabled: boolean): Promise<void> {
  await getMigratorPool().query(
    `update scheduled_jobs set enabled = $1 where name = 'billing-requests'`,
    [enabled],
  );
}

/**
 * A started monthly practice: the billing clinic, a second location answering
 * calls, both live under one bound agreement, and Stripe holding the
 * subscription's paid invoices.
 */
async function seedPractice(label: string, options: { interval?: "month" | "year" } = {}) {
  const billing = await seedClinic(label);
  const locationId = await seedLocation(billing.organizationId, billing.clinicId, `${label}-loc`);
  const agreementId = await bindAgreement(billing.organizationId, 60);
  await makeProduction([billing.clinicId, locationId]);
  const ids = await seedEntitled(billing.clinicId, {
    planId: "voice-metachat-1000-1000",
    interval: options.interval ?? "month",
    planStartedAt: PERIOD_START,
    planStartAppliedAt: PERIOD_START,
    firstInvoice: {
      periodStart: new Date(PERIOD_START.getTime() - 5 * DAY),
      periodEnd: PERIOD_START,
    },
    channelRows: [
      { channel: "web", readyAt: PERIOD_START, liveAt: PERIOD_START, firstAnswerAt: PERIOD_START },
      {
        channel: "voice",
        readyAt: PERIOD_START,
        liveAt: PERIOD_START,
        firstAnswerAt: PERIOD_START,
      },
      { channel: "meta", readyAt: PERIOD_START, liveAt: PERIOD_START, firstAnswerAt: PERIOD_START },
    ],
  });
  await seedChannels(locationId, [
    { channel: "voice", readyAt: PERIOD_START, liveAt: PERIOD_START, firstAnswerAt: PERIOD_START },
  ]);
  await setDirectLine(locationId, LINE);
  return {
    billingClinicId: billing.clinicId,
    locationId,
    organizationId: billing.organizationId,
    agreementId,
    customerId: ids.stripeCustomerId!,
    subscriptionId: ids.stripeSubscriptionId!,
  };
}

/** Stripe for the practice: the setup invoice, and this period's paid invoice with an overage line. */
function worldFor(practice: { customerId: string; subscriptionId: string }): StripeWorld {
  const world = createStripeWorld({
    customerId: practice.customerId,
    subscriptionId: practice.subscriptionId,
    items: [{ lookupKey: "healdesk_web-voice_month_89700", quantity: 1 }],
    periodStart: s(PERIOD_START),
    periodEnd: s(PERIOD_END),
    customerDefaultPm: "pm_customer",
    nowSeconds: s(NOW),
  });
  world.addPaidSubscriptionInvoice({
    created: s(new Date(PERIOD_START.getTime() - 5 * DAY)),
    billingReason: "subscription_create",
    lines: [
      // The setup fee: never refunded.
      {
        amount: 99_700,
        periodStart: s(new Date(PERIOD_START.getTime() - 5 * DAY)),
        periodEnd: s(new Date(PERIOD_START.getTime() - 5 * DAY)),
        oneOff: true,
      },
      {
        lookupKey: "healdesk_plan_start_placeholder_month",
        amount: 0,
        periodStart: s(new Date(PERIOD_START.getTime() - 5 * DAY)),
        periodEnd: s(PERIOD_START),
      },
    ],
  });
  world.fake.on("subscriptions.cancel", () => {
    world.state.subscription.status = "canceled";
    return JSON.parse(JSON.stringify(world.state.subscription));
  });
  world.fake.on("invoiceItems.list", () => ({ data: [], has_more: false }));
  return world;
}

function thisPeriodInvoice(world: StripeWorld) {
  return world.addPaidSubscriptionInvoice({
    created: s(PERIOD_START),
    lines: [
      {
        lookupKey: "healdesk_web-voice_month_89700",
        amount: PACKAGE_CENTS,
        periodStart: s(PERIOD_START),
        periodEnd: s(PERIOD_END),
      },
      // Overage billed in arrears for time already served: never refunded.
      {
        lookupKey: "healdesk_meter_voice_minutes_block100_8000",
        amount: 8_000,
        periodStart: s(new Date(PERIOD_START.getTime() - 30 * DAY)),
        periodEnd: s(PERIOD_START),
      },
    ],
  });
}

describeDb("ending the agreement ends the Services (BAA 1.3.0 clauses 1, 17 and 20)", () => {
  beforeAll(async () => {
    await runMigrations();
    await truncateAll();
    // The vendors' agreements in force, as a launched platform holds them
    // (the answer gate reads them, lib/compliance/vendor-coverage.ts).
    await attestPlatform(COVERAGE_VENDORS);
  }, 180_000);

  beforeEach(async () => {
    notifyOps.mockClear();
    notifyOpsOnce.mockClear();
    delete process.env.HEALDESK_OPS_EMAIL;
    delete process.env.HEALDESK_ADMIN_EMAIL;
    // On, as it is in service: the tests of it being off switch it off.
    await setBillingRequestsJob(true);
  });

  afterAll(async () => {
    await closePools();
  });

  test("a termination stops answering, refuses new patient rows, offboards every location, cancels without proration, and refunds the time after the day on the operator's confirmation", async () => {
    const practice = await seedPractice("term-main");
    const world = worldFor(practice);
    const invoice = thisPeriodInvoice(world);
    // A guarantee refund already made on this period's payment: the
    // termination refund must not pay that part back a second time.
    world.state.refunds.push({
      id: "re_earlier_guarantee",
      object: "refund",
      payment_intent: `pi_${invoice.id}`,
      amount: 50_000,
      status: "succeeded",
      metadata: { hd_kind: "guarantee" },
    });

    // In effect: the location answers its calls and takes patient rows.
    expect(
      await assistantMayAnswer({ clinicId: practice.locationId, channel: "voice", actor: ACTOR }),
    ).toEqual({ decision: "answer" });
    await insertContact(practice.locationId, "+15550170001");

    expect(
      await run("markAgreementTerminated", {
        agreementId: practice.agreementId,
        terminationDate: TODAY_ON,
        terminationReason: "practice_healdesk_breach",
      }),
    ).toMatchObject({
      status: "recorded",
      terminatedOn: TODAY_ON,
      services: "services_ended",
      refundDue: true,
    });

    // The assistant stops, and passes the call to the direct line.
    expect(
      await assistantMayAnswer({ clinicId: practice.locationId, channel: "voice", actor: ACTOR }),
    ).toEqual({
      decision: "pass_through",
      reason: "no_agreement",
      fallback: "direct_line",
      directLine: LINE,
    });
    expect(
      await assistantMayAnswer({
        clinicId: practice.billingClinicId,
        channel: "web",
        actor: ACTOR,
      }),
    ).toMatchObject({ decision: "pass_through", reason: "no_agreement", fallback: "contact_form" });

    // The database refuses a new patient row, for every location.
    for (const clinicId of [practice.locationId, practice.billingClinicId]) {
      await expect(insertContact(clinicId, "+15550170002")).rejects.toMatchObject({
        code: "23514",
        message: expect.stringMatching(/refusing to write PHI to contacts/),
      });
    }

    // Every location is offboarding, its clock started at the end of the day.
    expect(await offboardingOf(practice.locationId)).not.toBeNull();
    expect(await offboardingOf(practice.billingClinicId)).not.toBeNull();

    // The cancellation is recorded on the billing clinic, and ops is told a refund is due.
    expect(await requestsOf(practice.billingClinicId)).toEqual([
      { kind: "cancel_now", reason: "ops", outcome: null },
    ]);
    expect(notifyOps).toHaveBeenCalledWith("agreement_refund_due", {
      clinicId: practice.billingClinicId,
      agreementId: practice.agreementId,
    });
    // With the billing-requests job on, nothing is incomplete.
    expect(notifyOps).not.toHaveBeenCalledWith(
      "agreement_termination_incomplete",
      expect.anything(),
    );

    // The worker cancels at once, with no proration and no final invoice.
    // The request is due from the database's now(), later than NOW.
    expect(await drainBillingRequests({ now: new Date(), stripe: world.stripe })).toMatchObject({
      processed: 1,
      failed: 0,
    });
    const [cancel] = world.fake.callsTo("subscriptions.cancel");
    expect(cancel!.args[0]).toBe(practice.subscriptionId);
    expect(cancel!.args[1]).toEqual({
      prorate: false,
      invoice_now: false,
      cancellation_details: { comment: "hd_agreement_terminated" },
    });

    // Stripe's customer.subscription.deleted for that cancellation arrives
    // after the termination: the account is canceled, and the offboarding
    // clock the termination started does not move.
    const clock = await clockOf(practice.billingClinicId);
    expect(
      await handleStripeEvent(
        {
          id: `evt_deleted_${practice.billingClinicId.slice(0, 8)}`,
          object: "event",
          api_version: "2026-08-26.dahlia",
          created: s(NOW) + 60,
          livemode: false,
          pending_webhooks: 1,
          request: null,
          type: "customer.subscription.deleted",
          data: {
            object: {
              ...world.state.subscription,
              ended_at: s(NOW) + 30,
              cancellation_details: { comment: "hd_agreement_terminated", reason: null },
            },
          },
        } as unknown as Stripe.Event,
        { now: NOW },
      ),
    ).toMatchObject({ clinicId: practice.billingClinicId });
    expect(await clockOf(practice.billingClinicId)).toEqual(clock);

    // The operator previews the refund: this period's package line, from the
    // day after the termination to the period's end (18 of its 30 days),
    // capped by the fee the payment has left after the guarantee refund.
    // Never the setup fee, never the overage line.
    const unused = Math.trunc((PACKAGE_CENTS * 18) / 30);
    const expected = Math.min(unused, PACKAGE_CENTS - 50_000);
    const preview = await previewRefund(
      { clinicId: practice.billingClinicId, kind: "agreement_terminated" },
      { now: NOW, stripe: world.stripe },
    );
    expect(preview).toEqual({
      status: "ok",
      kind: "agreement_terminated",
      amountCents: expected,
      cancelsPlan: true,
      planStartedOn: PERIOD_START.toISOString().slice(0, 10),
      windowEndsOn: TODAY_ON,
    });

    const committed = await commitRefund(
      {
        clinicId: practice.billingClinicId,
        kind: "agreement_terminated",
        confirmAmountCents: expected,
        reason: "Terminated for our breach, clause 17",
        actorLabel: OPERATOR.email,
      },
      { now: NOW, stripe: world.stripe },
    );
    expect(committed).toMatchObject({
      status: "refunded",
      amountCents: expected,
      isCancelRequested: true,
    });
    const creates = world.fake.callsTo("refunds.create");
    expect(creates).toHaveLength(1);
    expect(creates[0]!.args[0]).toEqual({
      payment_intent: `pi_${invoice.id}`,
      amount: expected,
      reason: "requested_by_customer",
      metadata: { hd_kind: "agreement_terminated", hd_invoice: invoice.id },
    });
    expect(creates[0]!.args[1]).toMatchObject({
      idempotencyKey: `hd-refund:agreement_terminated:${practice.billingClinicId}:${invoice.id}`,
    });

    // One email with the termination's own words, and the § 5 marker untouched.
    const notices = await inTenant(
      practice.billingClinicId,
      async (c) =>
        (
          await c.query<{ kind: string; payload: Record<string, unknown> }>(
            `select kind, payload from billing_notices where clinic_id = $1 and kind = 'refund_issued'`,
            [practice.billingClinicId],
          )
        ).rows,
    );
    expect(notices).toHaveLength(1);
    expect(notices[0]!.payload).toMatchObject({
      kind: "agreement_terminated",
      amountCents: expected,
    });
    assertPayloadAllowed(notices[0]!.payload, "refund_issued");
    const marker = await inTenant(
      practice.billingClinicId,
      async (c) =>
        (
          await c.query<{ first_period_refunded_at: Date | null }>(
            `select first_period_refunded_at from entitlements where clinic_id = $1`,
            [practice.billingClinicId],
          )
        ).rows,
    );
    expect(marker[0]!.first_period_refunded_at).toBeNull();

    // A second preview or confirmation is refused with the day it was made,
    // rather than reading as a second refund: no second refund, billing note
    // or audit row.
    // The day the database recorded it, whatever the clock says now.
    const refundedOn = await inTenant(
      practice.billingClinicId,
      async (c) =>
        (
          await c.query<{ on: string }>(
            `select to_char(created_at at time zone 'UTC', 'YYYY-MM-DD') as on
               from billing_transitions where clinic_id = $1 and reason = 'refund_agreement_terminated'`,
            [practice.billingClinicId],
          )
        ).rows[0]!.on,
    );
    const again = await previewRefund(
      { clinicId: practice.billingClinicId, kind: "agreement_terminated" },
      { now: NOW, stripe: world.stripe },
    );
    expect(again).toEqual({
      status: "refused",
      message: expect.stringMatching(new RegExp(`^Already refunded on ${refundedOn}`)),
    });
    expect(
      await commitRefund(
        {
          clinicId: practice.billingClinicId,
          kind: "agreement_terminated",
          confirmAmountCents: expected,
          reason: "Retried",
          actorLabel: OPERATOR.email,
        },
        { now: NOW, stripe: world.stripe },
      ),
    ).toEqual({
      status: "refused",
      message: expect.stringMatching(new RegExp(`^Already refunded on ${refundedOn}`)),
    });
    expect(world.fake.callsTo("refunds.create")).toHaveLength(1);
    const records = await inTenant(
      practice.billingClinicId,
      async (c) =>
        (
          await c.query<{ n: number }>(
            `select count(*)::int as n from billing_transitions
              where clinic_id = $1 and reason = 'refund_agreement_terminated'`,
            [practice.billingClinicId],
          )
        ).rows[0]!.n,
    );
    expect(records).toBe(1);
  }, 180_000);

  test("a § 5 refund after the termination refund pays back only the fee the payment has left", async () => {
    const practice = await seedPractice("term-then-s5");
    const world = worldFor(practice);
    const invoice = thisPeriodInvoice(world);
    await run("markAgreementTerminated", {
      agreementId: practice.agreementId,
      terminationDate: TODAY_ON,
      terminationReason: "practice_healdesk_breach",
    });

    // The termination refund first: 18 of the period's 30 days.
    const unused = Math.trunc((PACKAGE_CENTS * 18) / 30);
    expect(
      await commitRefund(
        {
          clinicId: practice.billingClinicId,
          kind: "agreement_terminated",
          confirmAmountCents: unused,
          reason: "Terminated for our breach, clause 17",
          actorLabel: OPERATOR.email,
        },
        { now: NOW, stripe: world.stripe },
      ),
    ).toMatchObject({ status: "refunded", amountCents: unused });

    // Then the first period in full under § 5: the package fee less what the
    // termination already paid back, and not a cent of the overage line the
    // charge also holds. Uncapped, it asked Stripe for the whole fee again.
    const left = PACKAGE_CENTS - unused;
    expect(
      await previewRefund(
        { clinicId: practice.billingClinicId, kind: "first_period_cancel" },
        { now: NOW, stripe: world.stripe },
      ),
    ).toMatchObject({ status: "ok", amountCents: left });
    expect(
      await commitRefund(
        {
          clinicId: practice.billingClinicId,
          kind: "first_period_cancel",
          confirmAmountCents: left,
          reason: "First period under § 5",
          actorLabel: OPERATOR.email,
        },
        { now: NOW, stripe: world.stripe },
      ),
    ).toMatchObject({ status: "refunded", amountCents: left });

    const creates = world.fake.callsTo("refunds.create");
    expect(creates.map((call) => (call.args[0] as { amount: number }).amount)).toEqual([
      unused,
      left,
    ]);
    const refunded = world.state.refunds
      .filter((refund) => refund.payment_intent === `pi_${invoice.id}`)
      .reduce((sum, refund) => sum + (refund.amount as number), 0);
    expect(refunded).toBe(PACKAGE_CENTS);
  }, 180_000);

  test("a cancellation recorded while the billing-requests job is off tells ops at once, from a termination and from a first-period refund", async () => {
    await setBillingRequestsJob(false);

    // A termination: the cancel_now is recorded, and ops hears it will not go.
    const ended = await seedPractice("term-job-off");
    worldFor(ended);
    await run("markAgreementTerminated", {
      agreementId: ended.agreementId,
      terminationDate: TODAY_ON,
      terminationReason: "change_in_law",
    });
    expect(await requestsOf(ended.billingClinicId)).toEqual([
      { kind: "cancel_now", reason: "ops", outcome: null },
    ]);
    expect(notifyOps).toHaveBeenCalledWith("agreement_termination_incomplete", {
      clinicId: ended.billingClinicId,
      agreementId: ended.agreementId,
      phase: "billing_job_off",
    });

    // A first-period refund under § 5, with no termination: the same gap.
    const refunded = await seedPractice("refund-job-off");
    const world = worldFor(refunded);
    thisPeriodInvoice(world);
    notifyOps.mockClear();
    expect(
      await commitRefund(
        {
          clinicId: refunded.billingClinicId,
          kind: "first_period_cancel",
          confirmAmountCents: PACKAGE_CENTS,
          reason: "First period under § 5",
          actorLabel: OPERATOR.email,
        },
        { now: NOW, stripe: world.stripe },
      ),
    ).toMatchObject({ status: "refunded", isCancelRequested: true });
    expect(notifyOps).toHaveBeenCalledWith("refund_cancel_job_off", {
      clinicId: refunded.billingClinicId,
    });

    // With the job on, neither alert.
    await setBillingRequestsJob(true);
    notifyOps.mockClear();
    const quiet = await seedPractice("refund-job-on");
    const quietWorld = worldFor(quiet);
    thisPeriodInvoice(quietWorld);
    await commitRefund(
      {
        clinicId: quiet.billingClinicId,
        kind: "first_period_cancel",
        confirmAmountCents: PACKAGE_CENTS,
        reason: "First period under § 5",
        actorLabel: OPERATOR.email,
      },
      { now: NOW, stripe: quietWorld.stripe },
    );
    expect(notifyOps).not.toHaveBeenCalledWith("refund_cancel_job_off", expect.anything());
  }, 180_000);

  test("a termination whose process stopped before its steps ran is finished by the hourly reconcile, once, and ops is told", async () => {
    const practice = await seedPractice("term-killed");
    worldFor(practice);
    // The termination committed, and the process died before
    // endServicesAfterTermination ran: no offboarding, no cancellation.
    await getMigratorPool().query(
      `update baa_acceptances
          set terminated_at = $2::date + interval '1 day' - interval '1 millisecond',
              termination_reason = 'practice_healdesk_breach'
        where id = $1`,
      [practice.agreementId, TODAY_ON],
    );
    expect(await offboardingOf(practice.locationId)).toBeNull();
    expect(await requestsOf(practice.billingClinicId)).toEqual([]);
    // The console refuses a second termination, so nothing else would finish it.
    expect(
      await run("markAgreementTerminated", {
        agreementId: practice.agreementId,
        terminationDate: TODAY_ON,
        terminationReason: "practice_healdesk_breach",
      }),
    ).toMatchObject({ status: "error", message: expect.stringMatching(/^Already recorded/) });
    expect(await offboardingOf(practice.locationId)).toBeNull();

    expect(await reconcileBilling(NOW)).toMatchObject({ terminationsFinished: 1 });
    expect(await offboardingOf(practice.locationId)).not.toBeNull();
    expect(await offboardingOf(practice.billingClinicId)).not.toBeNull();
    expect(await requestsOf(practice.billingClinicId)).toEqual([
      { kind: "cancel_now", reason: "ops", outcome: null },
    ]);
    expect(notifyOps).toHaveBeenCalledWith("agreement_termination_finished_late", {
      organizationId: practice.organizationId,
      agreementId: practice.agreementId,
      phase: "offboarding",
      count: 2,
    });
    expect(notifyOps).toHaveBeenCalledWith("agreement_termination_finished_late", {
      organizationId: practice.organizationId,
      agreementId: practice.agreementId,
      phase: "billing",
      count: 1,
    });
    // The alert the termination never got to raise.
    expect(notifyOps).toHaveBeenCalledWith("agreement_refund_due", {
      clinicId: practice.billingClinicId,
      agreementId: practice.agreementId,
    });

    // Finished: the next pass leaves it, and every termination before it, alone.
    notifyOps.mockClear();
    expect(await reconcileBilling(NOW)).toMatchObject({ terminationsFinished: 0 });
    expect(notifyOps).not.toHaveBeenCalledWith(
      "agreement_termination_finished_late",
      expect.anything(),
    );
    expect(await requestsOf(practice.billingClinicId)).toHaveLength(1);
  }, 180_000);

  test("a refund-due alert lost with the process is raised again by the reconcile, until the refund is confirmed", async () => {
    // The verification of 3a6de11: the process died after recording
    // cancel_now and before agreement_refund_due. Every step is done, so
    // nothing else would ever say a refund is owed.
    const practice = await seedPractice("term-lost-alert");
    const world = worldFor(practice);
    thisPeriodInvoice(world);
    await run("markAgreementTerminated", {
      agreementId: practice.agreementId,
      terminationDate: TODAY_ON,
      terminationReason: "practice_healdesk_breach",
    });
    expect(await requestsOf(practice.billingClinicId)).toHaveLength(1);

    // The reconcile has no step to finish, and raises the alert once-only:
    // notifyOpsOnce finds the termination's own alert, if it went.
    expect(await reconcileBilling(NOW)).toMatchObject({ terminationsFinished: 0 });
    expect(notifyOpsOnce).toHaveBeenCalledWith("agreement_refund_due", {
      clinicId: practice.billingClinicId,
      agreementId: practice.agreementId,
    });

    // Confirmed, it is owed no longer.
    const unused = Math.trunc((PACKAGE_CENTS * 18) / 30);
    await commitRefund(
      {
        clinicId: practice.billingClinicId,
        kind: "agreement_terminated",
        confirmAmountCents: unused,
        reason: "Terminated for our breach, clause 17",
        actorLabel: OPERATOR.email,
      },
      { now: NOW, stripe: world.stripe },
    );
    notifyOpsOnce.mockClear();
    await reconcileBilling(NOW);
    expect(notifyOpsOnce).not.toHaveBeenCalledWith("agreement_refund_due", {
      clinicId: practice.billingClinicId,
      agreementId: practice.agreementId,
    });
  }, 180_000);

  test("the answer gate never follows a location's billing pointer into another practice", async () => {
    // The verification of 3a6de11: R6's rule, applied where the assistant
    // decides whether to answer, so a location can't ride another
    // practice's subscription.
    const a = await seedPractice("gate-pointer-a");
    const b = await seedPractice("gate-pointer-b");
    expect(
      await assistantMayAnswer({ clinicId: a.locationId, channel: "voice", actor: ACTOR }),
    ).toEqual({ decision: "answer" });
    await asApp(a.locationId, (c) =>
      c.query(`update clinics set billing_clinic_id = $2 where id = $1`, [
        a.locationId,
        b.billingClinicId,
      ]),
    );
    expect(
      await assistantMayAnswer({ clinicId: a.locationId, channel: "voice", actor: ACTOR }),
    ).toEqual({
      decision: "pass_through",
      reason: "not_active",
      fallback: "direct_line",
      directLine: LINE,
    });
    expect(notifyOpsOnce).toHaveBeenCalledWith("billing_pointer_outside_practice", {
      clinicId: a.locationId,
    });
  }, 180_000);

  test("a location pointed at another practice's billing clinic never gets that practice cancelled", async () => {
    const ended = await seedPractice("term-pointer-a");
    const other = await seedPractice("term-pointer-b");
    worldFor(ended);
    // The runtime role may write billing_clinic_id: point A's second
    // location at B's billing clinic.
    await asApp(ended.locationId, (c) =>
      c.query(`update clinics set billing_clinic_id = $2 where id = $1`, [
        ended.locationId,
        other.billingClinicId,
      ]),
    );

    await run("markAgreementTerminated", {
      agreementId: ended.agreementId,
      terminationDate: TODAY_ON,
      terminationReason: "change_in_law",
    });

    // A's locations are offboarding and A's own subscription is cancelled;
    // B is untouched, and ops is told about the pointer.
    expect(await offboardingOf(ended.locationId)).not.toBeNull();
    expect(await requestsOf(ended.billingClinicId)).toEqual([
      { kind: "cancel_now", reason: "ops", outcome: null },
    ]);
    expect(await requestsOf(other.billingClinicId)).toEqual([]);
    expect(await offboardingOf(other.billingClinicId)).toBeNull();
    expect(notifyOps).toHaveBeenCalledWith("agreement_termination_incomplete", {
      clinicId: ended.locationId,
      agreementId: ended.agreementId,
      phase: "billing_pointer",
    });

    // Nor does the hourly reconcile follow it.
    await reconcileBilling(NOW);
    expect(await requestsOf(other.billingClinicId)).toEqual([]);
  }, 180_000);

  test("a refund that died after Stripe and before the record is finished by the next confirmation, once", async () => {
    const practice = await seedPractice("term-recover");
    const world = worldFor(practice);
    const invoice = thisPeriodInvoice(world);
    await run("markAgreementTerminated", {
      agreementId: practice.agreementId,
      terminationDate: TODAY_ON,
      terminationReason: "practice_healdesk_breach",
    });
    const unused = Math.trunc((PACKAGE_CENTS * 18) / 30);
    // The refund went through in Stripe, and nothing was recorded.
    world.state.refunds.push({
      id: "re_made_before_the_crash",
      object: "refund",
      payment_intent: `pi_${invoice.id}`,
      amount: unused,
      status: "succeeded",
      metadata: { hd_kind: "agreement_terminated", hd_invoice: invoice.id },
    });
    expect(
      await previewRefund(
        { clinicId: practice.billingClinicId, kind: "agreement_terminated" },
        { now: NOW, stripe: world.stripe },
      ),
    ).toMatchObject({ status: "ok", amountCents: unused });
    expect(
      await commitRefund(
        {
          clinicId: practice.billingClinicId,
          kind: "agreement_terminated",
          confirmAmountCents: unused,
          reason: "Finishing the refund",
          actorLabel: OPERATOR.email,
        },
        { now: NOW, stripe: world.stripe },
      ),
    ).toMatchObject({ status: "refunded", amountCents: unused });
    expect(world.fake.callsTo("refunds.create")).toHaveLength(0);
    expect(
      await previewRefund(
        { clinicId: practice.billingClinicId, kind: "agreement_terminated" },
        { now: NOW, stripe: world.stripe },
      ),
    ).toMatchObject({ status: "refused", message: expect.stringMatching(/^Already refunded on/) });
  }, 180_000);

  test("an invoice paid out of band is shown to settle by hand, not left out of what is owed", async () => {
    const practice = await seedPractice("term-oob");
    const world = worldFor(practice);
    const card = thisPeriodInvoice(world);
    // A renewal for the next period, marked paid in the Dashboard (a wire):
    // owed back in full, but there is no card payment to refund it to.
    const wired = world.addPaidSubscriptionInvoice({
      created: s(PERIOD_END),
      paidOutOfBand: true,
      lines: [
        {
          lookupKey: "healdesk_web-voice_month_89700",
          amount: PACKAGE_CENTS,
          periodStart: s(PERIOD_END),
          periodEnd: s(new Date(PERIOD_END.getTime() + 30 * DAY)),
        },
      ],
    });
    await run("markAgreementTerminated", {
      agreementId: practice.agreementId,
      terminationDate: TODAY_ON,
      terminationReason: "practice_subcontractor_objection",
    });
    const unused = Math.trunc((PACKAGE_CENTS * 18) / 30);
    expect(
      await previewRefund(
        { clinicId: practice.billingClinicId, kind: "agreement_terminated" },
        { now: NOW, stripe: world.stripe },
      ),
    ).toMatchObject({
      status: "ok",
      amountCents: unused,
      settleByHand: { amountCents: PACKAGE_CENTS, invoiceIds: [wired.id] },
    });
    await commitRefund(
      {
        clinicId: practice.billingClinicId,
        kind: "agreement_terminated",
        confirmAmountCents: unused,
        reason: "Subcontractor objection",
        actorLabel: OPERATOR.email,
      },
      { now: NOW, stripe: world.stripe },
    );
    // Only the card payment was refunded through Stripe.
    expect(
      world.fake
        .callsTo("refunds.create")
        .map((call) => (call.args[0] as { payment_intent: string }).payment_intent),
    ).toEqual([`pi_${card.id}`]);
  }, 180_000);

  test("on an annual plan the termination refunds the rest of the year, by the line's own period", async () => {
    const practice = await seedPractice("term-annual", { interval: "year" });
    const world = worldFor(practice);
    const YEAR_END = new Date(PERIOD_START.getTime() + 365 * DAY);
    const YEAR_CENTS = 860_400;
    world.addPaidSubscriptionInvoice({
      created: s(PERIOD_START),
      lines: [
        {
          lookupKey: "healdesk_web-voice_year_860400",
          amount: YEAR_CENTS,
          periodStart: s(PERIOD_START),
          periodEnd: s(YEAR_END),
        },
      ],
    });
    await run("markAgreementTerminated", {
      agreementId: practice.agreementId,
      terminationDate: TODAY_ON,
      terminationReason: "practice_healdesk_breach",
    });
    // From the start of the day after the termination to the year's end: 353 of its 365 days.
    const expected = Math.trunc((YEAR_CENTS * 353) / 365);
    expect(
      await previewRefund(
        { clinicId: practice.billingClinicId, kind: "agreement_terminated" },
        { now: NOW, stripe: world.stripe },
      ),
    ).toMatchObject({ status: "ok", amountCents: expected });
  }, 180_000);

  test("a plan change in the period counts its credit and its charge, each by its own period", async () => {
    const practice = await seedPractice("term-change");
    const world = worldFor(practice);
    thisPeriodInvoice(world);
    // Six days ago the practice moved up a package: the old price's unused
    // 25 days credited, the new price's charged, on one invoice.
    const CHANGE = new Date(TODAY.getTime() - 6 * DAY);
    const NEW_CENTS = 119_700;
    const credit = -Math.trunc((PACKAGE_CENTS * 25) / 30);
    const charge = Math.trunc((NEW_CENTS * 25) / 30);
    world.addPaidSubscriptionInvoice({
      created: s(CHANGE),
      lines: [
        {
          lookupKey: "healdesk_web-voice_month_89700",
          amount: credit,
          periodStart: s(CHANGE),
          periodEnd: s(PERIOD_END),
          proration: true,
        },
        {
          lookupKey: "healdesk_complete_month_119700",
          amount: charge,
          periodStart: s(CHANGE),
          periodEnd: s(PERIOD_END),
          proration: true,
        },
      ],
    });
    await run("markAgreementTerminated", {
      agreementId: practice.agreementId,
      terminationDate: TODAY_ON,
      terminationReason: "practice_healdesk_breach",
    });
    // The first invoice's 18 of 30 days; the change's lines 18 of their 25,
    // the credit counting against the charge on its own invoice.
    const expected =
      Math.trunc((PACKAGE_CENTS * 18) / 30) +
      Math.trunc((credit * 18) / 25) +
      Math.trunc((charge * 18) / 25);
    expect(
      await previewRefund(
        { clinicId: practice.billingClinicId, kind: "agreement_terminated" },
        { now: NOW, stripe: world.stripe },
      ),
    ).toMatchObject({ status: "ok", amountCents: expected });
  }, 180_000);

  test("a renewal paid after the termination comes back in full", async () => {
    const practice = await seedPractice("term-renewal");
    const world = worldFor(practice);
    thisPeriodInvoice(world);
    await run("markAgreementTerminated", {
      agreementId: practice.agreementId,
      terminationDate: TODAY_ON,
      terminationReason: "practice_healdesk_breach",
    });
    // The next period's renewal, paid before the cancellation went through.
    world.addPaidSubscriptionInvoice({
      created: s(NOW) + 60,
      billingReason: "subscription_cycle",
      lines: [
        {
          lookupKey: "healdesk_web-voice_month_89700",
          amount: PACKAGE_CENTS,
          periodStart: s(PERIOD_END),
          periodEnd: s(new Date(PERIOD_END.getTime() + 30 * DAY)),
        },
      ],
    });
    expect(
      await previewRefund(
        { clinicId: practice.billingClinicId, kind: "agreement_terminated" },
        { now: NOW, stripe: world.stripe },
      ),
    ).toMatchObject({
      status: "ok",
      amountCents: Math.trunc((PACKAGE_CENTS * 18) / 30) + PACKAGE_CENTS,
    });
  }, 180_000);

  test("who ended it and why is recorded once, with the date, and never changed", async () => {
    const practice = await seedPractice("term-reason");
    await run("markAgreementTerminated", {
      agreementId: practice.agreementId,
      terminationDate: TODAY_ON,
      terminationReason: "change_in_law",
    });
    const { rows } = await getMigratorPool().query<{ termination_reason: string }>(
      `select termination_reason from baa_acceptances where id = $1`,
      [practice.agreementId],
    );
    expect(rows[0]!.termination_reason).toBe("change_in_law");
    // Not even the owner can turn a no-refund ending into a refunded one.
    await expect(
      getMigratorPool().query(
        `update baa_acceptances set termination_reason = 'practice_healdesk_breach' where id = $1`,
        [practice.agreementId],
      ),
    ).rejects.toMatchObject({ code: "23514" });

    // A reason outside the closed set, and a missing one, are refused before anything is written.
    const other = await seedPractice("term-reason-bad");
    for (const terminationReason of [undefined, "operator_felt_like_it"]) {
      expect(
        await run("markAgreementTerminated", {
          agreementId: other.agreementId,
          terminationDate: TODAY_ON,
          ...(terminationReason ? { terminationReason } : {}),
        }),
      ).toMatchObject({ status: "error" });
    }
    await expect(
      getMigratorPool().query(
        `update baa_acceptances set termination_reason = 'some_reason', terminated_at = now() where id = $1`,
        [other.agreementId],
      ),
    ).rejects.toMatchObject({
      code: "23514",
      constraint: "baa_acceptances_termination_reason_check",
    });
    expect(await offboardingOf(other.locationId)).toBeNull();
  }, 180_000);

  test("an ending clause 17 does not refund stops the Services and the Fees the same day and refunds nothing", async () => {
    for (const terminationReason of [
      "healdesk_practice_breach",
      "change_in_law",
      "services_ended",
    ]) {
      const practice = await seedPractice(`term-norefund-${terminationReason.slice(0, 8)}`);
      const world = worldFor(practice);
      thisPeriodInvoice(world);
      expect(
        await run("markAgreementTerminated", {
          agreementId: practice.agreementId,
          terminationDate: TODAY_ON,
          terminationReason,
        }),
      ).toMatchObject({ services: "services_ended", refundDue: false });
      expect(await offboardingOf(practice.locationId)).not.toBeNull();
      expect(await requestsOf(practice.billingClinicId)).toEqual([
        { kind: "cancel_now", reason: "ops", outcome: null },
      ]);
      expect(notifyOps).not.toHaveBeenCalledWith("agreement_refund_due", expect.anything());
      expect(
        await previewRefund(
          { clinicId: practice.billingClinicId, kind: "agreement_terminated" },
          { now: NOW, stripe: world.stripe },
        ),
      ).toMatchObject({ status: "refused", message: expect.stringMatching(/not refunded/) });
    }
  }, 180_000);

  test("before the plan starts there is nothing to refund", async () => {
    const billing = await seedClinic("term-unstarted");
    const agreementId = await bindAgreement(billing.organizationId, 20);
    await seedEntitled(billing.clinicId, { planId: "voice-metachat-1000-1000" });
    await run("markAgreementTerminated", {
      agreementId,
      terminationDate: TODAY_ON,
      terminationReason: "practice_subcontractor_objection",
    });
    expect(
      await previewRefund(
        { clinicId: billing.clinicId, kind: "agreement_terminated" },
        {
          stripe: createStripeWorld({
            customerId: "cus_x",
            subscriptionId: "sub_x",
            items: [],
            periodStart: 0,
            periodEnd: 1,
          }).stripe,
        },
      ),
    ).toMatchObject({ status: "refused", message: expect.stringMatching(/had not started/) });
  }, 180_000);

  test("a practice with another agreement still in effect is untouched", async () => {
    const practice = await seedPractice("term-other");
    // A newer agreement, still in effect: the older one is the one terminated.
    await bindAgreement(practice.organizationId, 10);
    expect(
      await run("markAgreementTerminated", {
        agreementId: practice.agreementId,
        terminationDate: TODAY_ON,
        terminationReason: "practice_healdesk_breach",
      }),
    ).toMatchObject({ status: "recorded", services: "agreement_in_effect", refundDue: false });
    expect(
      await assistantMayAnswer({ clinicId: practice.locationId, channel: "voice", actor: ACTOR }),
    ).toEqual({ decision: "answer" });
    await insertContact(practice.locationId, "+15550170003");
    expect(await offboardingOf(practice.locationId)).toBeNull();
    expect(await offboardingOf(practice.billingClinicId)).toBeNull();
    expect(await requestsOf(practice.billingClinicId)).toEqual([]);
    expect(notifyOps).not.toHaveBeenCalled();
  }, 180_000);

  test("offboarding's destruction still runs for a terminated practice, through the cascades that rewrite rows it keeps", async () => {
    const practice = await seedPractice("term-destroy");
    // A booked appointment with a paid deposit: rows the patient-data gate
    // stands in front of, which destruction must still be able to remove
    // once no agreement is in effect. Since drizzle/0065 the deposit goes
    // with the rest (app_destroy_deposit_payments), handed over in the
    // export first.
    const appointmentId = await inTenant(practice.locationId, async (c) => {
      const contact = (
        await c.query<{ id: string }>(
          `insert into contacts (clinic_id, phone) values ($1, '+15550170004') returning id`,
          [practice.locationId],
        )
      ).rows[0]!.id;
      const appointment = (
        await c.query<{ id: string }>(
          `insert into appointments (clinic_id, contact_id, scheduled_for) values ($1, $2, now() - interval '3 days') returning id`,
          [practice.locationId, contact],
        )
      ).rows[0]!.id;
      await c.query(
        `insert into deposit_payments (clinic_id, appointment_id, channel, amount_cents, stripe_account_id, status)
         values ($1, $2, 'web', 5000, 'acct_test_termination', 'paid')`,
        [practice.locationId, appointment],
      );
      return appointment;
    });
    expect(appointmentId).toBeTruthy();

    await run("markAgreementTerminated", {
      agreementId: practice.agreementId,
      terminationDate: TODAY_ON,
      terminationReason: "services_ended",
    });
    // Twenty-nine days on, by the database's stamps: a 1.2.1 practice is due.
    await getMigratorPool().query(
      `update clinics
          set offboarding_started_at = offboarding_started_at - interval '29 days 1 hour',
              destroy_after = destroy_after - interval '29 days 1 hour'
        where id = any($1::uuid[])`,
      [[practice.locationId, practice.billingClinicId]],
    );
    const results = await destroyDueClinics(new Date());
    expect(results.map((r) => r.clinicId)).toEqual(
      expect.arrayContaining([practice.locationId, practice.billingClinicId]),
    );
    const deposits = await inTenant(
      practice.locationId,
      async (c) =>
        (
          await c.query<{ appointment_id: string | null }>(
            `select appointment_id from deposit_payments where clinic_id = $1`,
            [practice.locationId],
          )
        ).rows,
    );
    expect(deposits).toEqual([]);
    const { rows } = await getMigratorPool().query<{ destroyed_at: Date | null }>(
      `select destroyed_at from clinics where id = $1`,
      [practice.locationId],
    );
    expect(rows[0]!.destroyed_at).toBeInstanceOf(Date);
  }, 180_000);
});
