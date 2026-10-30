import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { applyDeauthorization } from "@/lib/billing/connect";
import { runClinicChangeAlerts } from "@/lib/clinic/change-events";
import { setAutoConfirm } from "@/lib/booking/mode";
import { markCalendarBrokenWithin } from "@/lib/connections/google-calendar";
import { saveSetting, type SettingContext } from "@/lib/portal/settings";
import { readSettingsView } from "@/lib/portal/settings-view";
import { fullPaymentActive, paymentLinkTextOffered, readPaymentFacts } from "@/lib/portal/switch-resets";
import { HEALDESK_SETTING_UP, TEXT_NOT_READY_REASON, UNLOCK_REASONS } from "@/lib/portal/switch-rules";
import { saveSetupScreen } from "@/lib/setup/save";
import { readSetupState } from "@/lib/setup/state";
import { withTenant } from "@/lib/tenant";

import { insertGoogleConnection } from "./setup/calendar-db";
import { closePools, getMigratorPool, hasTestDatabase, runMigrations, truncateAll } from "./setup/db";
import { inTenant } from "./setup/factories";
import { provisionPortalClinic, type PortalClinic } from "./setup/portal-clinic";

/**
 * The payment switches against a provisioned clinic (lane A, 28 October
 * 2026): "Text the payment link" and "What AYA asks the patient to pay" save
 * through saveSetting and the wizard's deposits step; a crafted request to
 * turn one on while switch-rules.ts says it is unavailable is refused with
 * the rule's own sentence, and off always passes; and losing a fact
 * (Auto-confirm off, the calendar broken, the Stripe account deauthorized)
 * sets back what needs it in the same transaction, with a history row per
 * switch, an audit row naming the cause and ONE email naming what was
 * switched off. Synthetic data only.
 */

const describeDb = hasTestDatabase ? describe : describe.skip;
const ACTOR = { type: "service", serviceName: "payment-switches-test" } as const;
const NOW = new Date("2026-10-28T15:00:00Z");
let minute = 0;
/** A later moment for each write, so history reads back in the order written. */
function tick(): Date {
  minute += 1;
  return new Date(NOW.getTime() + minute * 60_000);
}

let clinic: PortalClinic;
let chatOnly: PortalClinic;

function ctxFor(c: PortalClinic): SettingContext {
  return { clinicId: c.clinicId, userId: c.userId, actorLabel: "Front desk Mac", steppedUp: false };
}

async function migrator(text: string, values: unknown[] = []) {
  return (await getMigratorPool().query(text, values)).rows;
}

async function tenantRows<R extends Record<string, unknown>>(
  clinicId: string,
  text: string,
  values: unknown[] = [],
): Promise<R[]> {
  return inTenant(clinicId, async (c) => (await c.query<R>(text, values)).rows);
}

async function switches(clinicId: string) {
  const [row] = await tenantRows<{
    deposits_enabled: boolean;
    text_payment_link: boolean;
    payment_ask: string;
  }>(
    clinicId,
    `select deposits_enabled, text_payment_link, payment_ask from clinic_settings where clinic_id = $1`,
    [clinicId],
  );
  return row ?? { deposits_enabled: false, text_payment_link: false, payment_ask: "deposit_only" };
}

async function resetEmails(clinicId: string) {
  return tenantRows<{ dedupe_key: string; payload: Record<string, unknown> }>(
    clinicId,
    `select dedupe_key, payload from billing_notices
      where kind = 'setting_changed' and payload->>'field' = 'payment_switches_reset'
      order by created_at`,
  );
}

async function history(clinicId: string) {
  return tenantRows<{ field: string; before_value: string; after_value: string }>(
    clinicId,
    `select field, before_value, after_value from clinic_settings_history
      where field in ('deposits_enabled', 'text_payment_link', 'payment_ask')
      order by changed_at, field`,
  );
}

/**
 * The text switch left on from before it was locked (29 October 2026): no
 * writer can turn it on while no sender exists (switch-rules.ts), so a test
 * that needs it on sets the stored value directly.
 */
async function textOnFromBeforeTheLock(c: PortalClinic) {
  const rows = await tenantRows(
    c.clinicId,
    `update clinic_settings set text_payment_link = true where clinic_id = $1 returning clinic_id`,
    [c.clinicId],
  );
  expect(rows).toHaveLength(1);
}

const TEXT_REFUSED = { ok: false, field: "text_payment_link", message: TEXT_NOT_READY_REASON } as const;
/** The text's refusal before Stripe: the first of its checks the clinic can act on. */
const TEXT_NEEDS_STRIPE = { ok: false, field: "text_payment_link", message: UNLOCK_REASONS.connect_stripe } as const;

/** Stripe connected, a deposit on a treatment, and (optionally) a working calendar. */
async function ready(c: PortalClinic, options: { calendar?: boolean } = {}) {
  await migrator(
    `update clinics set stripe_connect_account_id = $2, stripe_connect_connected_at = $3 where id = $1`,
    [c.clinicId, `acct_1Lane${c.clinicId.slice(0, 8)}`, new Date("2026-10-01T00:00:00Z")],
  );
  await inTenant(c.clinicId, async (q) => {
    await q.query(
      `update agent_configs set services = '[{"name":"Consultation","priceKind":"exact","priceFromUsd":150,"priceToUsd":150,"durationMinutes":30,"depositUsd":50}]'::jsonb where clinic_id = $1`,
      [c.clinicId],
    );
  });
  if (options.calendar !== false) {
    return insertGoogleConnection(c.clinicId, { managed: true });
  }
  return null;
}

describeDb("payment switches", () => {
  beforeAll(async () => {
    await runMigrations();
    await truncateAll();
  });

  beforeEach(async () => {
    // A fresh clinic per test: every test starts from the defaults.
    clinic = await provisionPortalClinic("payswitch", { plan: "voice-webchat-1000-1000" });
  });

  afterAll(async () => {
    await closePools();
  });

  test("new columns default to off and deposit only, as the settings view reads them", async () => {
    expect(await switches(clinic.clinicId)).toMatchObject({
      text_payment_link: false,
      payment_ask: "deposit_only",
    });
    const facts = await withTenant({ clinicId: clinic.clinicId, actor: ACTOR }, readPaymentFacts);
    expect(facts).toEqual({
      gatewayConnected: false,
      hasDepositAmount: false,
      calendarConnected: false,
      autoConfirm: true,
      hasVoice: true,
      textPaymentLinkOn: false,
      // Provisioning signs the current BAA, which covers the text.
      agreementCoversText: true,
    });
  });

  test("a crafted request is refused with the rule's own sentence until each fact is in place; off always passes", async () => {
    const ctx = ctxFor(clinic);
    expect(await saveSetting(ctx, "payment_ask", "full_payment", tick())).toEqual({
      ok: false,
      field: "payment_ask",
      message: UNLOCK_REASONS.connect_stripe,
    });
    expect(await saveSetting(ctx, "text_payment_link", true, tick())).toEqual(TEXT_NEEDS_STRIPE);
    expect(await saveSetting(ctx, "deposits_enabled", true, tick())).toEqual({
      ok: false,
      field: "deposits_enabled",
      message: UNLOCK_REASONS.connect_stripe,
    });
    expect(await saveSetting(ctx, "payment_ask", "everything", tick())).toMatchObject({ ok: false });
    // Off, and back to deposit only, are never refused.
    expect(await saveSetting(ctx, "text_payment_link", false, tick())).toMatchObject({ ok: true });
    expect(await saveSetting(ctx, "payment_ask", "deposit_only", tick())).toMatchObject({ ok: true });

    await ready(clinic, { calendar: false });
    expect(await saveSetting(ctx, "payment_ask", "full_payment", tick())).toEqual({
      ok: false,
      field: "payment_ask",
      message: UNLOCK_REASONS.connect_calendar,
    });
    // healdesk's texting number is not ready, so the text stays locked with Stripe connected too.
    expect(await saveSetting(ctx, "text_payment_link", true, tick())).toEqual(TEXT_REFUSED);

    await insertGoogleConnection(clinic.clinicId, { managed: true });
    const saved = await saveSetting(ctx, "payment_ask", "full_payment", tick());
    // Said as design, and true for a call, which never collects (R4).
    expect(saved).toMatchObject({
      ok: true,
      toast: expect.stringMatching(
        /^Full payment\. AYA is designed to ask patients to pay the full price through a secure payment link in chat; on a call she books it and flags it for your team\./,
      ),
    });
    expect(await switches(clinic.clinicId)).toMatchObject({
      text_payment_link: false,
      payment_ask: "full_payment",
    });
    expect(await withTenant({ clinicId: clinic.clinicId, actor: ACTOR }, fullPaymentActive)).toBe(
      true,
    );
    // The clinic's own changes keep their before and after, and send no reset email.
    expect(await history(clinic.clinicId)).toEqual([
      { field: "payment_ask", before_value: "deposit_only", after_value: "full_payment" },
    ]);
    expect(await resetEmails(clinic.clinicId)).toEqual([]);
  });

  test("the payment-link text is phone's: a plan without phone has no such setting", async () => {
    chatOnly = await provisionPortalClinic("payswitch-chat", { plan: "webchat-1000" });
    expect(await saveSetting(ctxFor(chatOnly), "text_payment_link", true, tick())).toMatchObject({
      ok: false,
      message: "That setting isn't part of your plan.",
    });
  });

  test("with healdesk's texting number configured, the text can be switched on and is offered once every check holds", async () => {
    const saved = process.env.HEALDESK_SMS_ORIGINATION_IDENTITY;
    const savedCalls = process.env.HEALDESK_VOICE_REAL_CALLS;
    process.env.HEALDESK_SMS_ORIGINATION_IDENTITY = "phone-0123456789abcdef0123456789abcdef";
    // Healdesk's side is the number and real calls (healdeskTextReady).
    process.env.HEALDESK_VOICE_REAL_CALLS = "1";
    try {
      const ctx = ctxFor(clinic);
      const offered = () =>
        withTenant({ clinicId: clinic.clinicId, actor: ACTOR }, (tx) => paymentLinkTextOffered(tx, { realCalls: true }));
      // Configured, but no Stripe: the clinic's own check comes first.
      expect(await saveSetting(ctx, "text_payment_link", true, tick())).toEqual(TEXT_NEEDS_STRIPE);
      expect(await offered()).toBe(false);
      await ready(clinic);
      // Every check but the switch: still not offered.
      expect(await offered()).toBe(false);
      expect(await saveSetting(ctx, "text_payment_link", true, tick())).toMatchObject({ ok: true });
      expect(await offered()).toBe(true);
      // The test-calls-only restriction keeps it off whatever the clinic chose.
      expect(
        await withTenant({ clinicId: clinic.clinicId, actor: ACTOR }, (tx) => paymentLinkTextOffered(tx, { realCalls: false })),
      ).toBe(false);
      // And the number unset again keeps it off, without touching the clinic's choice.
      delete process.env.HEALDESK_SMS_ORIGINATION_IDENTITY;
      expect(await offered()).toBe(false);
      expect((await switches(clinic.clinicId)).text_payment_link).toBe(true);
      // An agreement older than the one that covers the text keeps it off too,
      // whatever the clinic chose: BAA 1.5.1 in effect (spec, "Only under an
      // agreement that covers it").
      process.env.HEALDESK_SMS_ORIGINATION_IDENTITY = "phone-0123456789abcdef0123456789abcdef";
      expect(await offered()).toBe(true);
      await migrator(
        `update baa_acceptances set document_version = '1.5.1'
          where organization_id = (select organization_id from clinics where id = $1)`,
        [clinic.clinicId],
      );
      expect(await offered()).toBe(false);
      const facts = await withTenant({ clinicId: clinic.clinicId, actor: ACTOR }, readPaymentFacts);
      expect(facts.agreementCoversText).toBe(false);
    } finally {
      if (saved === undefined) delete process.env.HEALDESK_SMS_ORIGINATION_IDENTITY;
      else process.env.HEALDESK_SMS_ORIGINATION_IDENTITY = saved;
      if (savedCalls === undefined) delete process.env.HEALDESK_VOICE_REAL_CALLS;
      else process.env.HEALDESK_VOICE_REAL_CALLS = savedCalls;
    }
  });

  test("Auto-confirm off returns full payment to deposit only in the same transaction, audited, with one email", async () => {
    await ready(clinic);
    const ctx = ctxFor(clinic);
    expect(await saveSetting(ctx, "deposits_enabled", true, tick())).toMatchObject({
      ok: true,
      toast: expect.stringMatching(/^Deposits on\. In chat, AYA is designed to send a secure payment link/),
    });
    expect(await saveSetting(ctx, "text_payment_link", true, tick())).toEqual(TEXT_REFUSED);
    await textOnFromBeforeTheLock(clinic);
    await saveSetting(ctx, "payment_ask", "full_payment", tick());

    const outcome = await setAutoConfirm(clinic.clinicId, false, ACTOR, { label: "Front desk Mac", now: tick() });
    expect(outcome).toMatchObject({ changed: true, autoConfirm: false });
    // Only full payment needed Auto-confirm: the text and deposits stay on.
    expect(await switches(clinic.clinicId)).toEqual({
      deposits_enabled: true,
      text_payment_link: true,
      payment_ask: "deposit_only",
    });
    expect((await history(clinic.clinicId)).at(-1)).toEqual({
      field: "payment_ask",
      before_value: "full_payment",
      after_value: "deposit_only",
    });
    const audits = await tenantRows<{ metadata: Record<string, unknown> }>(
      clinic.clinicId,
      `select metadata from audit_log where clinic_id = $1 and resource_type = 'clinic_settings'
         and metadata->>'reason' = 'auto_confirm_off'`,
      [clinic.clinicId],
    );
    expect(audits).toHaveLength(1);
    expect(audits[0]!.metadata).toMatchObject({ paymentAsk: "deposit_only" });
    const emails = await resetEmails(clinic.clinicId);
    expect(emails).toHaveLength(1);
    expect(emails[0]!.payload).toMatchObject({
      field: "payment_switches_reset",
      switchIds: ["full_payment"],
      code: "turn_on_auto_confirm",
      settingsUrl: expect.stringContaining(`/c/${clinic.clinicSlug}/settings#payments`),
    });
    expect(await withTenant({ clinicId: clinic.clinicId, actor: ACTOR }, fullPaymentActive)).toBe(
      false,
    );

    // Switching it off again changes nothing and sends nothing more; on again
    // does not turn full payment back on by itself.
    await setAutoConfirm(clinic.clinicId, false, ACTOR, { label: "Front desk Mac", now: tick() });
    await setAutoConfirm(clinic.clinicId, true, ACTOR, { label: "Front desk Mac", now: tick() });
    expect((await switches(clinic.clinicId)).payment_ask).toBe("deposit_only");
    expect(await resetEmails(clinic.clinicId)).toHaveLength(1);
  });

  test("a reset is healdesk's own change in the feed: one row per switch, one ops alert each, once", async () => {
    await ready(clinic);
    const ctx = ctxFor(clinic);
    await saveSetting(ctx, "payment_ask", "full_payment", tick());
    const feed = () =>
      tenantRows<{ id: string; source: string; actor_kind: string; summary: Record<string, unknown> }>(
        clinic.clinicId,
        `select id, source, actor_kind, summary from clinic_change_events
          where kind = 'setting' and alerted_at is null order by changed_at, id`,
      );
    await inTenant(clinic.clinicId, (c) =>
      c.query(`update clinic_change_events set alerted_at = now() where alerted_at is null`),
    );

    await setAutoConfirm(clinic.clinicId, false, ACTOR, { label: "Front desk Mac", now: tick() });
    // The person's switch, and healdesk's reset of what needed it (same moment).
    const rows = (await feed()).sort((a, b) => String(a.summary.setting).localeCompare(String(b.summary.setting)));
    expect(rows.map((r) => [r.source, r.actor_kind, r.summary])).toEqual([
      ["portal", "clinic_signin", { setting: "auto_confirm", before: "on", after: "off" }],
      ["system", "system", { setting: "payment_ask", before: "full_payment", after: "deposit_only" }],
    ]);

    await runClinicChangeAlerts();
    await runClinicChangeAlerts();
    const alerts = await migrator(
      `select dedupe_key, fields from ops_alerts
        where event = 'clinic_availability_changed' and fields->>'clinicId' = $1 and fields->>'section' = 'setting'
        order by raised_at`,
      [clinic.clinicId],
    );
    const reset = alerts.filter((a) => a.dedupe_key === `key:setting_change:${rows[1]!.id}`);
    expect(reset).toHaveLength(1);
    expect(reset[0]!.fields).toMatchObject({ setting: "payment_ask", before: "full_payment", after: "deposit_only", actor: "system" });
    expect(alerts.filter((a) => a.dedupe_key === `key:setting_change:${rows[0]!.id}`)).toHaveLength(1);
  });

  test("a broken calendar returns full payment to deposit only", async () => {
    const connection = await ready(clinic);
    await saveSetting(ctxFor(clinic), "payment_ask", "full_payment", tick());
    await withTenant({ clinicId: clinic.clinicId, actor: ACTOR }, (tx) =>
      markCalendarBrokenWithin(tx, {
        code: "calendar_not_found",
        connectionId: connection!.id,
        credentialVersion: "x",
      }),
    );
    expect((await switches(clinic.clinicId)).payment_ask).toBe("deposit_only");
    const emails = await resetEmails(clinic.clinicId);
    expect(emails.map((e) => e.payload.code)).toEqual(["connect_calendar"]);
  });

  test("Stripe taking our access away switches off deposits, full payment and the text together, in the disconnect's one email", async () => {
    await ready(clinic);
    const ctx = ctxFor(clinic);
    await saveSetting(ctx, "deposits_enabled", true, tick());
    await textOnFromBeforeTheLock(clinic);
    await saveSetting(ctx, "payment_ask", "full_payment", tick());

    const result = await applyDeauthorization({
      clinicId: clinic.clinicId,
      accountId: `acct_1Lane${clinic.clinicId.slice(0, 8)}`,
      eventCreatedAt: tick(),
      now: tick(),
    });
    expect(result).toBe("applied");
    expect(await switches(clinic.clinicId)).toEqual({
      deposits_enabled: false,
      text_payment_link: false,
      payment_ask: "deposit_only",
    });
    // One email, the disconnect's own, naming what it set back besides
    // deposits; no second reset email.
    expect(await resetEmails(clinic.clinicId)).toHaveLength(0);
    const disconnected = await tenantRows<{ payload: Record<string, unknown> }>(
      clinic.clinicId,
      `select payload from billing_notices where kind = 'connect_disconnected'`,
    );
    expect(disconnected).toHaveLength(1);
    expect(disconnected[0]!.payload).toMatchObject({
      source: "stripe",
      resetSwitchIds: ["full_payment", "text_payment_link"],
    });
    // One audit entry for the settings, with the disconnect's reason.
    const audits = await tenantRows<{ metadata: Record<string, unknown> }>(
      clinic.clinicId,
      `select metadata from audit_log where clinic_id = $1 and resource_type = 'clinic_settings'
         and metadata->>'reason' in ('stripe_deauthorized', 'stripe_disconnected')`,
      [clinic.clinicId],
    );
    expect(audits).toHaveLength(1);
    expect(audits[0]!.metadata).toMatchObject({
      reason: "stripe_deauthorized",
      depositsEnabled: false,
      textPaymentLink: false,
      paymentAsk: "deposit_only",
    });
    const reset = (await history(clinic.clinicId)).slice(-3);
    expect(reset.map((r) => r.field).sort()).toEqual([
      "deposits_enabled",
      "payment_ask",
      "text_payment_link",
    ]);
  });

  test("the wizard's deposits step saves both switches through the same refusals", async () => {
    const save = (input: Record<string, unknown>) =>
      saveSetupScreen(
        {
          clinicId: clinic.clinicId,
          slug: clinic.clinicSlug,
          userId: clinic.userId,
          actorLabel: "Front desk Mac",
        },
        "deposits",
        input,
        NOW,
      );
    const consultation = { needsDeposits: true, deposits: { Consultation: 50 } };
    // Provisioning's knowledge may not list Consultation; give it the service the step reads.
    await inTenant(clinic.clinicId, async (q) => {
      await q.query(
        `update agent_configs set services = '[{"name":"Consultation","priceKind":"exact","priceFromUsd":150,"priceToUsd":150,"durationMinutes":30}]'::jsonb where clinic_id = $1`,
        [clinic.clinicId],
      );
    });
    expect(await save({ ...consultation, paymentAsk: "full_payment" })).toEqual({
      ok: false,
      field: "paymentAsk",
      message: UNLOCK_REASONS.connect_stripe,
    });
    expect(await save({ ...consultation, textPaymentLink: true })).toEqual({
      ok: false,
      field: "textPaymentLink",
      message: UNLOCK_REASONS.connect_stripe,
    });
    expect((await switches(clinic.clinicId)).text_payment_link).toBe(false);

    await migrator(
      `update clinics set stripe_connect_account_id = 'acct_1LaneWizard', stripe_connect_connected_at = now() where id = $1`,
      [clinic.clinicId],
    );
    // With Stripe the text is still locked: healdesk's texting number is not ready.
    expect(await save({ ...consultation, textPaymentLink: true, paymentAsk: "deposit_only" })).toEqual({
      ok: false,
      field: "textPaymentLink",
      message: TEXT_NOT_READY_REASON,
    });
    expect(await save({ ...consultation, paymentAsk: "deposit_only" })).toMatchObject({ ok: true });
    expect(await switches(clinic.clinicId)).toMatchObject({
      text_payment_link: false,
      payment_ask: "deposit_only",
    });
    // Without the calendar, full payment stays locked in the wizard too.
    expect(await save({ ...consultation, paymentAsk: "full_payment" })).toMatchObject({
      ok: false,
      message: UNLOCK_REASONS.connect_calendar,
    });
  });

  test("the wizard's deposits step writes only the fields it was sent; absent leaves each as it is", async () => {
    const save = (input: Record<string, unknown>) =>
      saveSetupScreen(
        { clinicId: clinic.clinicId, slug: clinic.clinicSlug, userId: clinic.userId, actorLabel: "Front desk Mac" },
        "deposits",
        input,
        NOW,
      );
    await ready(clinic, { calendar: false });
    const depositOf = async () =>
      (
        await tenantRows<{ deposit: string | null }>(
          clinic.clinicId,
          `select (services->0->>'depositUsd') as deposit from agent_configs where clinic_id = $1`,
          [clinic.clinicId],
        )
      )[0]!.deposit;
    expect(await depositOf()).toBe("50");

    await textOnFromBeforeTheLock(clinic);

    // Only the ask: the text stays as stored.
    expect(await save({ paymentAsk: "deposit_only" })).toMatchObject({ ok: true });
    expect((await switches(clinic.clinicId)).text_payment_link).toBe(true);

    // Nothing sent: nothing changes.
    expect(await save({})).toMatchObject({ ok: true });
    expect(await depositOf()).toBe("50");
    expect((await switches(clinic.clinicId)).text_payment_link).toBe(true);

    // Only the text switch (off always passes): the amounts and the ask are left alone.
    expect(await save({ textPaymentLink: false })).toMatchObject({ ok: true });
    expect(await depositOf()).toBe("50");
    expect(await switches(clinic.clinicId)).toMatchObject({ text_payment_link: false, payment_ask: "deposit_only" });

    // "Yes" with no amounts keeps the amounts already set; "No" clears them.
    expect(await save({ needsDeposits: true })).toMatchObject({ ok: true });
    expect(await depositOf()).toBe("50");
    expect(await save({ needsDeposits: false })).toMatchObject({ ok: true });
    expect(await depositOf()).toBe("0");
    expect(await save({ needsDeposits: true })).toMatchObject({ ok: false, field: "deposits" });
  });

  test("the wizard's changes reach ops as the wizard's, and a booking system turning Auto-confirm off as well", async () => {
    await ready(clinic);
    const ctx = {
      clinicId: clinic.clinicId,
      slug: clinic.clinicSlug,
      userId: clinic.userId,
      actorLabel: "Front desk Mac",
    };
    await inTenant(clinic.clinicId, (c) =>
      c.query(`update clinic_change_events set alerted_at = now() where alerted_at is null`),
    );
    const feed = async () =>
      (
        await tenantRows<{ source: string; actor_kind: string; summary: Record<string, unknown> }>(
          clinic.clinicId,
          `select source, actor_kind, summary from clinic_change_events
            where kind = 'setting' and alerted_at is null order by changed_at, id`,
        )
      )
        .map((r) => [r.source, r.actor_kind, r.summary] as const)
        .sort((a, b) => String(a[2].setting).localeCompare(String(b[2].setting)));

    expect(
      await saveSetupScreen(ctx, "deposits", { textPaymentLink: false, paymentAsk: "full_payment" }, tick()),
    ).toMatchObject({ ok: true });
    expect(await feed()).toEqual([
      ["wizard", "clinic_device", { setting: "payment_ask", before: "deposit_only", after: "full_payment" }],
    ]);
    // Re-saving the same answers records nothing more.
    await saveSetupScreen(ctx, "deposits", { textPaymentLink: false, paymentAsk: "full_payment" }, tick());
    expect(await feed()).toHaveLength(1);

    await inTenant(clinic.clinicId, (c) =>
      c.query(`update clinic_change_events set alerted_at = now() where alerted_at is null`),
    );
    // A booking system that does not read Google turns Auto-confirm off: the
    // wizard's change, and healdesk's reset of full payment, each once.
    expect(await saveSetupScreen(ctx, "calendar", { bookingSystem: "mindbody" }, tick())).toMatchObject({ ok: true });
    expect(await feed()).toEqual([
      ["wizard", "clinic_device", { setting: "auto_confirm", before: "on", after: "off" }],
      ["system", "system", { setting: "payment_ask", before: "full_payment", after: "deposit_only" }],
    ]);
    expect((await switches(clinic.clinicId)).payment_ask).toBe("deposit_only");
  });

  test("the settings view shows the stored values, the real facts and the rules from them", async () => {
    await ready(clinic);
    await saveSetting(ctxFor(clinic), "payment_ask", "full_payment", tick());
    // A text left on from before the lock reads as off: nothing can send it.
    await textOnFromBeforeTheLock(clinic);
    const actor = { type: "user", userId: clinic.userId, label: "Front desk Mac" } as const;
    const state = await withTenant({ clinicId: clinic.clinicId, actor }, (tx) =>
      readSetupState(tx, { userId: clinic.userId, now: NOW }),
    );
    const view = await readSettingsView({ slug: clinic.clinicSlug, state: state!, actor, now: NOW });
    expect(view.payments).toMatchObject({
      textPaymentLink: false,
      paymentAsk: "full_payment",
      autoConfirm: true,
      calendarConnected: true,
      rules: {
        full_payment: { enabled: true, reason: null },
        text_payment_link: {
          enabled: false,
          reason: TEXT_NOT_READY_REASON,
          unlock: null,
          checks: [
            { id: "phone", met: true },
            { id: "payments", met: true },
            { id: "agreement", met: true },
            { id: "switch", met: false },
            { id: "healdesk", met: false, waiting: HEALDESK_SETTING_UP },
          ],
        },
        deposits: { enabled: true },
      },
    });
  });
});
