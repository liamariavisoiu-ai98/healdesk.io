import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

import { runClinicChangeAlerts, settingAlertFields, SUPPORT_ACTION_SERVICE, changeOriginOf } from "@/lib/clinic/change-events";
import { settingChangeSummary } from "@/lib/clinic/setting-changes";
import { SETTING_ENTRIES, SETTING_VALUE_WORDS, settingValueToken } from "@/lib/clinic/setting-words";
import { assertPayloadAllowed } from "@/lib/email/lint";
import { renderOpsAlert } from "@/lib/email/templates/ops_alert";
import { alertWording } from "@/lib/ops/alert-wording";
import { isMutating, isOpName, runOperation, type Operator } from "@/lib/ops/api";
import { runOpsSlackSweep, slackFields, slackText } from "@/lib/ops/slack";
import { operatorRefusal, switchKeys, switchViews, type SwitchFactsRead } from "@/lib/ops/switch-ops";
import { saveSetting, SETTING_KEYS } from "@/lib/portal/settings";

import { closePools, getMigratorPool, hasTestDatabase, runMigrations, truncateAll } from "./setup/db";
import { insertGoogleConnection } from "./setup/calendar-db";
import { inTenant } from "./setup/factories";
import { provisionPortalClinic, type PortalClinic } from "./setup/portal-clinic";

/**
 * Lane C1 (owner, 28 October 2026; docs/design/launch-readiness-2026-10-27/
 * portal-dashboard-lanes.md): an operator reads a clinic's switches and sets
 * one through the clinic's own saveSetting, never where calls go; and every
 * settings change, whoever made it, is told to ops once, by email and in
 * Slack, in closed words: the clinic, the switch, before and after, who.
 * Synthetic data only.
 */

const sent = vi.hoisted(() => ({ emails: [] as { to: string; kind: string; subject: string; text: string; payload: unknown }[] }));
vi.mock("@/lib/email/send", async (original) => {
  const real = await original<typeof import("@/lib/email/send")>();
  return {
    ...real,
    sendEmail: async (email: { to: string; kind: string; subject: string; text: string; payload: unknown }) => {
      sent.emails.push(email);
      return { status: "sent", messageId: `msg-${sent.emails.length}` };
    },
  };
});

const describeDb = hasTestDatabase ? describe : describe.skip;
const OPERATOR: Operator = { email: "ops@healdesk.test", request: { ipAddress: "203.0.113.9", userAgent: "vitest" } };
const CLINIC = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
const ALERT = "9b2f1c3e-0a4d-4e5f-8a6b-7c8d9e0f1a2b";

const FACTS: SwitchFactsRead = {
  snapshot: {
    channel_web: true,
    channel_voice: true,
    channel_instagram: true,
    channel_messenger: false,
    channel_whatsapp: false,
    coverage_mode: "overflow_after_hours",
    tone: "warm",
    phone_greeting: "Thanks for calling Glow",
    suggest_add_ons: false,
    mention_promotions: true,
    deposits_enabled: false,
    book_voice_without_deposit: true,
    book_chat_without_deposit: false,
    deposit_uncollectable: "book_and_flag",
    deposit_hold_minutes: "60",
    text_payment_link: false,
    payment_ask: "deposit_only",
    direct_line: "+14155550100",
    daily_summary: true,
    transfer_live_calls: false,
    auto_confirm: true,
  },
  bought: ["web", "meta", "voice"],
  connectedMeta: ["instagram"],
  facts: { gatewayConnected: false, hasDepositAmount: false, calendarConnected: false, autoConfirm: true, hasVoice: true },
};

describe("the switches an operator sees", () => {
  test("start from SETTING_KEYS, then Auto-confirm, and leave every text setting out", () => {
    const keys = switchKeys();
    expect(keys.at(-1)).toBe("auto_confirm");
    for (const key of keys.slice(0, -1)) expect(SETTING_KEYS as readonly string[]).toContain(key);
    for (const text of ["direct_line", "transfer_number", "phone_greeting", "chat_greeting", "short_name", "languages", "urgent_help", "vet_referral"]) {
      expect(keys).not.toContain(text);
    }
    // Every setting has an entry with a label: a new key without one fails here.
    for (const key of SETTING_KEYS) expect(SETTING_ENTRIES[key]?.label, key).toBeTruthy();
  });

  test("carry a plain label, value, kind and options, and the reason from switch-rules", () => {
    const views = switchViews(FACTS);
    const by = Object.fromEntries(views.map((v) => [v.key, v]));
    expect(by.deposits_enabled).toEqual({
      key: "deposits_enabled",
      label: "Take deposits",
      kind: "switch",
      value: false,
      enabled: false,
      reason: "Connect your Stripe account first.",
      operatorMayChange: true,
    });
    expect(by.tone).toMatchObject({ kind: "choice", value: "warm", enabled: true, operatorMayChange: true });
    expect(by.tone!.options!.map((o) => o.id)).toEqual(["warm", "clinical"]);
    expect(by.deposit_hold_minutes).toMatchObject({ kind: "choice", value: "60" });
    expect(by.deposit_hold_minutes!.options!.map((o) => o.id)).toEqual(["30", "60", "120", "240", "1440"]);
    // Listed with its options, but the clinic's own choice.
    expect(by.coverage_mode).toMatchObject({ kind: "choice", operatorMayChange: false });
    expect(by.coverage_mode!.options).toHaveLength(3);
    expect(by.channel_instagram).toMatchObject({ value: true, enabled: true });
    expect(by.channel_messenger).toMatchObject({ enabled: false, reason: "Messenger isn't connected yet." });
    expect(by.auto_confirm).toMatchObject({ label: "Auto-confirm bookings", value: true });
    expect(by.channel_web!.options).toBeUndefined();
    // Never a number or a greeting.
    expect(JSON.stringify(views)).not.toMatch(/555|Thanks for calling/);
  });

  test("leave out what the plan did not buy", () => {
    const keys = switchViews({ ...FACTS, bought: ["web"], connectedMeta: [] }).map((v) => v.key);
    expect(keys).toContain("channel_web");
    expect(keys).toContain("book_chat_without_deposit");
    for (const key of ["channel_voice", "coverage_mode", "channel_instagram", "book_voice_without_deposit", "transfer_live_calls"]) {
      expect(keys).not.toContain(key);
    }
  });

  test(
    "text_payment_link and payment_ask, each governed by its rule",
    () => {
      const by = Object.fromEntries(switchViews({ ...FACTS, facts: { ...FACTS.facts, gatewayConnected: true } }).map((v) => [v.key, v]));
      expect(by.text_payment_link).toMatchObject({ kind: "switch", value: false, enabled: true });
      expect(by.payment_ask).toMatchObject({
        kind: "choice",
        value: "deposit_only",
        enabled: false,
        reason: "Connect your calendar first.",
      });
      expect(by.payment_ask!.options!.map((o) => o.id)).toEqual(["deposit_only", "full_payment"]);
    },
  );

  test("refuse where calls go and which calls reach AYA, in the clinic's words", () => {
    expect(operatorRefusal("direct_line")).toMatch(/Only the clinic can change where calls go/);
    expect(operatorRefusal("transfer_number")).toMatch(/Only the clinic can change where calls go/);
    expect(operatorRefusal("coverage_mode")).toMatch(/call forwarding steps follow it/);
    expect(operatorRefusal("phone_greeting")).toBe("That isn't one of the clinic's switches.");
    expect(operatorRefusal("constructor")).toBe("That isn't one of the clinic's switches.");
    expect(operatorRefusal("tone")).toBeNull();
    expect(operatorRefusal("auto_confirm")).toBeNull();
  });

  test("are two operations, the set one mutating", () => {
    expect(isOpName("getClinicSwitches")).toBe(true);
    expect(isOpName("setClinicSwitch")).toBe(true);
    expect(isMutating("getClinicSwitches")).toBe(false);
    expect(isMutating("setClinicSwitch")).toBe(true);
  });
});

describe("a settings change in closed words", () => {
  test("a switch or a choice is its token; a text setting has none", () => {
    expect(settingValueToken("deposits_enabled", true)).toBe("on");
    expect(settingValueToken("deposits_enabled", "yes")).toBeUndefined();
    expect(settingValueToken("tone", "clinical")).toBe("clinical");
    expect(settingValueToken("tone", "chatty")).toBeUndefined();
    expect(settingValueToken("deposit_hold_minutes", 120)).toBe("120");
    expect(settingValueToken("deposit_hold_minutes", 45)).toBeUndefined();
    expect(settingValueToken("direct_line", "+14155550100")).toBeUndefined();
    expect(settingChangeSummary("direct_line", "+14155550100", "+14155550199")).toEqual({ setting: "direct_line" });
    expect(settingChangeSummary("tone", "warm", "clinical")).toEqual({ setting: "tone", before: "warm", after: "clinical" });
  });

  test("a support action is its own source and actor", () => {
    expect(changeOriginOf({ type: "service", serviceName: SUPPORT_ACTION_SERVICE })).toEqual({
      source: "support_action",
      actor: "support",
    });
    expect(changeOriginOf({ type: "service", serviceName: "ops@healdesk.test" })).toEqual({ source: "ops_console", actor: "ops" });
  });

  test("Slack carries the clinic, the switch, before, after and who, and nothing else", () => {
    const fields = settingAlertFields(CLINIC, "ops", {
      setting: "deposits_enabled",
      before: "off",
      after: "on",
      ...({ greeting: "Thanks for calling Glow" } as object),
    });
    expect(fields).toEqual({
      clinicId: CLINIC,
      section: "setting",
      setting: "deposits_enabled",
      before: "off",
      after: "on",
      actor: "ops",
    });
    expect(slackFields(fields)).toEqual(fields);
    // Off the closed lists, a value is left out whatever it holds.
    expect(
      slackFields({ ...fields, setting: "Dr Lee's line", before: "(415) 555-0100", after: "maria@glow.test", actor: "Maria" }),
    ).toEqual({ clinicId: CLINIC, section: "setting" });
    // And a summary off the lists never reaches the alert.
    expect(settingAlertFields(CLINIC, "clinic_device", { setting: "tone", before: "warm", after: "Be chatty" })).toEqual({
      clinicId: CLINIC,
      section: "setting",
      setting: "tone",
      actor: "clinic_device",
    });
    for (const word of Object.keys(SETTING_VALUE_WORDS)) expect(() => assertPayloadAllowed({ before: word }, "ops_alert")).not.toThrow();
    expect(() => assertPayloadAllowed(fields, "ops_alert")).not.toThrow();
  });

  test("the email and Slack say the same sentences in words, never the raw key", () => {
    const fields = settingAlertFields(CLINIC, "clinic_signin", { setting: "book_voice_without_deposit", before: "on", after: "off" });
    const wording = alertWording("clinic_availability_changed", fields);
    expect(wording.title).toBe("A clinic's setting changed");
    expect(`healdesk ops: ${wording.title}`.length).toBeLessThanOrEqual(70);
    const email = renderOpsAlert(
      { event: "clinic_availability_changed", ...fields, clinicName: "Glow Med Spa" },
      { clinicName: null, audience: "patients", reason: "ops", raisedAt: new Date("2026-10-28T10:00:00Z"), timeZone: "UTC" } as never,
    );
    const slack = slackText({ event: "clinic_availability_changed", fields, clinicName: "Glow Med Spa", alertId: ALERT });
    const line = "Glow Med Spa's Book by phone without a deposit setting changed from on to off";
    expect(email.text).toContain(line);
    expect(slack.replace(/\*/g, "")).toContain(line);
    // Who, under the facts both renderings print.
    expect(email.text).toContain("Changed by: the clinic");
    expect(slack).toContain("the clinic");
    for (const text of [email.text, slack]) {
      expect(text).not.toContain("book_voice_without_deposit");
      expect(text).not.toContain("clinic_signin");
    }
    // An availability change keeps its own wording.
    expect(alertWording("clinic_availability_changed", { clinicId: CLINIC, section: "closures", count: 1 }).title).toBe(
      "A clinic's booking hours or providers changed",
    );
  });
});

describeDb("settings changes reach ops, and operators set switches", () => {
  let clinic: PortalClinic;

  const settingRows = () =>
    inTenant(clinic.clinicId, async (c) =>
      (
        await c.query<{ id: string; source: string; actor_kind: string; summary: Record<string, unknown>; alerted_at: Date | null; audit_status: string | null }>(
          `select id, source, actor_kind, summary, alerted_at, audit_status from clinic_change_events
            where kind = 'setting' order by changed_at, id`,
        )
      ).rows,
    );
  const settingAlerts = async () =>
    (
      await getMigratorPool().query<{ dedupe_key: string; fields: Record<string, unknown> }>(
        `select dedupe_key, fields from ops_alerts
          where event = 'clinic_availability_changed' and fields->>'clinicId' = $1 and fields->>'section' = 'setting'
          order by raised_at`,
        [clinic.clinicId],
      )
    ).rows;

  beforeAll(async () => {
    await runMigrations();
    await truncateAll();
    process.env.HEALDESK_OPS_EMAIL = "hello@healdesk.test";
    delete process.env.SLACK_WEBHOOK_URL;
    clinic = await provisionPortalClinic("switches", { plan: "voice-metachat-1000-1000" });
  }, 180_000);

  beforeEach(async () => {
    sent.emails.length = 0;
    // Each test reads only its own clinic's settings rows and alerts.
    await inTenant(clinic.clinicId, (c) => c.query(`update clinic_change_events set alerted_at = now() where alerted_at is null`));
  });

  afterAll(async () => {
    delete process.env.HEALDESK_OPS_EMAIL;
    await closePools();
  });

  test("a clinic's own change is one row, one email and one alert for Slack, however often the sweep runs", async () => {
    const before = (await settingRows()).length;
    const saved = await saveSetting(
      { clinicId: clinic.clinicId, userId: clinic.userId, actorLabel: "Front desk Mac", steppedUp: false },
      "tone",
      "clinical",
    );
    expect(saved).toMatchObject({ ok: true });
    const rows = (await settingRows()).slice(before);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      source: "portal",
      actor_kind: "clinic_device",
      summary: { setting: "tone", before: "warm", after: "clinical" },
      alerted_at: null,
      audit_status: null,
    });

    const alertsBefore = (await settingAlerts()).length;
    expect(await runClinicChangeAlerts()).toMatchObject({ failures: 0 });
    await runClinicChangeAlerts();
    const alerts = (await settingAlerts()).slice(alertsBefore);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.dedupe_key).toBe(`key:setting_change:${rows[0]!.id}`);
    expect(alerts[0]!.fields).toEqual({
      clinicId: clinic.clinicId,
      section: "setting",
      setting: "tone",
      before: "warm",
      after: "clinical",
      actor: "clinic_device",
    });
    const ops = sent.emails.filter((e) => e.kind === "ops_alert");
    expect(ops).toHaveLength(1);
    expect(ops[0]!.to).toBe("hello@healdesk.test");
    expect(ops[0]!.subject).toContain("A clinic's setting changed");
    expect(ops[0]!.text).toContain("Tone setting changed from warm and welcoming to clinical and professional");
    expect(ops[0]!.text).not.toMatch(/glowspa\.test|Front desk Mac/);

    // Slack is off while its key is unset: the sweep says so and changes nothing.
    expect(await runOpsSlackSweep()).toMatchObject({ status: "ok" });
  });

  test("a change of where calls go is one ops alert with no number, beside the clinic's own email", async () => {
    const ctx = { clinicId: clinic.clinicId, userId: clinic.userId, actorLabel: "Front desk Mac", steppedUp: true };
    expect(await saveSetting(ctx, "direct_line", "(415) 555-0181")).toMatchObject({ ok: true });
    expect(await saveSetting(ctx, "direct_line", "(415) 555-0182")).toMatchObject({ ok: true });
    const rows = (await settingRows()).filter((r) => r.alerted_at === null);
    expect(rows.map((r) => r.summary)).toEqual([{ setting: "direct_line" }, { setting: "direct_line" }]);
    const alertsBefore = (await settingAlerts()).length;
    await runClinicChangeAlerts();
    await runClinicChangeAlerts();
    const alerts = (await settingAlerts()).slice(alertsBefore);
    expect(alerts).toHaveLength(2);
    const ops = sent.emails.filter((e) => e.kind === "ops_alert");
    expect(ops).toHaveLength(2);
    for (const email of ops) {
      expect(email.to).toBe("hello@healdesk.test");
      expect(email.text).toContain("Direct line setting changed");
      expect(email.text).not.toMatch(/0181|0182|555/);
    }
  });

  test("with Slack's key set, the sweep posts each settings alert once, in closed words", async () => {
    const posts: string[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: { body: string }) => {
      posts.push(init.body);
      return new Response("ok", { status: 200 });
    });
    process.env.SLACK_WEBHOOK_URL = "https://hooks.slack.com/services/T000/B000/abcdefghijklmnop";
    try {
      // Only this test's alert is waiting for Slack.
      await getMigratorPool().query(`update ops_alerts set slack_posted_at = now() where slack_posted_at is null`);
      await saveSetting(
        { clinicId: clinic.clinicId, userId: clinic.userId, actorLabel: "Front desk Mac", steppedUp: false },
        "mention_promotions",
        false,
      );
      await runClinicChangeAlerts();
      await runOpsSlackSweep();
      await runOpsSlackSweep();
      expect(posts).toHaveLength(1);
      const text = JSON.parse(posts[0]!).text as string;
      expect(text).toContain("Mention promotions setting changed from on to off");
      expect(text).not.toMatch(/mention_promotions|glowspa\.test|Front desk Mac/);
    } finally {
      delete process.env.SLACK_WEBHOOK_URL;
      vi.unstubAllGlobals();
    }
  });

  test("the same value saved again, and a refused save, record nothing", async () => {
    const before = (await settingRows()).length;
    const ctx = { clinicId: clinic.clinicId, userId: clinic.userId, actorLabel: "Front desk Mac", steppedUp: false };
    await saveSetting(ctx, "suggest_add_ons", true);
    const once = (await settingRows()).length;
    expect(once).toBe(before + 1);
    expect(await saveSetting(ctx, "suggest_add_ons", true)).toMatchObject({ ok: true });
    expect(await saveSetting(ctx, "tone", "chatty")).toMatchObject({ ok: false });
    expect((await settingRows()).length).toBe(once);
  });

  test("an operator reads the switches and sets one through the clinic's own door", async () => {
    const read = await runOperation("getClinicSwitches", { clinicId: clinic.clinicId }, OPERATOR);
    expect(read.status).toBe(200);
    const switches = (read.body as { data: { switches: { key: string; value: unknown }[] } }).data.switches;
    expect(switches.find((s) => s.key === "daily_summary")).toMatchObject({ value: true });
    expect(switches.map((s) => s.key)).not.toContain("direct_line");

    const before = (await settingRows()).length;
    const set = await runOperation("setClinicSwitch", { clinicId: clinic.clinicId, key: "daily_summary", value: false }, OPERATOR);
    expect(set.status).toBe(200);
    expect((set.body as { data: unknown }).data).toMatchObject({ ok: true, resets: [] });
    expect(((set.body as { data: { toast: string } }).data.toast)).toMatch(/^Daily summary off/);
    const rows = (await settingRows()).slice(before);
    expect(rows).toEqual([
      expect.objectContaining({ source: "ops_console", actor_kind: "ops", summary: { setting: "daily_summary", before: "on", after: "off" } }),
    ]);
    // The security event names the operator; the clinic sees the team.
    const events = await getMigratorPool().query<{ actor_label: string }>(
      `select actor_label from security_events where event = 'clinic_switch_set' order by occurred_at desc limit 1`,
    );
    expect(events.rows[0]?.actor_label).toBe(OPERATOR.email);

    await runClinicChangeAlerts();
    const fields = (await settingAlerts()).at(-1)!.fields;
    expect(fields).toMatchObject({ setting: "daily_summary", before: "on", after: "off", actor: "ops" });
  });

  test("Auto-confirm from the console is recorded too, once", async () => {
    const before = (await settingRows()).length;
    const set = await runOperation("setClinicSwitch", { clinicId: clinic.clinicId, key: "auto_confirm", value: false }, OPERATOR);
    expect((set.body as { data: unknown }).data).toMatchObject({ ok: true });
    await runOperation("setClinicSwitch", { clinicId: clinic.clinicId, key: "auto_confirm", value: false }, OPERATOR);
    expect((await settingRows()).slice(before)).toEqual([
      expect.objectContaining({ actor_kind: "ops", summary: { setting: "auto_confirm", before: "on", after: "off" } }),
    ]);
  });

  test("the payment switches: refused with the rule's reason, set from our side, and an Auto-confirm off lists its reset", async () => {
    const pay = await provisionPortalClinic("switches-pay", { plan: "voice-webchat-1000-1000" });
    const set = async (key: string, value: unknown) =>
      (
        (await runOperation("setClinicSwitch", { clinicId: pay.clinicId, key, value }, OPERATOR)).body as {
          data: { ok: boolean; message?: string; resets?: { switch: string; notice: string }[] };
        }
      ).data;
    const read = async () =>
      Object.fromEntries(
        (
          (await runOperation("getClinicSwitches", { clinicId: pay.clinicId }, OPERATOR)).body as {
            data: { switches: { key: string; value: unknown; enabled: boolean; reason: string | null }[] };
          }
        ).data.switches.map((s) => [s.key, s]),
      );

    // Nothing connected: both refused with the rule's own sentence.
    expect(await set("text_payment_link", true)).toEqual({ ok: false, message: "Connect your Stripe account first.", field: "text_payment_link" });
    expect(await set("payment_ask", "full_payment")).toMatchObject({ ok: false, message: "Connect your Stripe account first." });

    // Stripe, a deposit, and a calendar that is only degraded (Google briefly
    // unreachable): connected, as the Settings page and the wizard read it.
    await getMigratorPool().query(
      `update clinics set stripe_connect_account_id = $2, stripe_connect_connected_at = $3 where id = $1`,
      [pay.clinicId, `acct_1Swi${pay.clinicId.slice(0, 8)}`, new Date("2026-10-01T00:00:00Z")],
    );
    await inTenant(pay.clinicId, (c) =>
      c.query(
        `update agent_configs set services = '[{"name":"Consultation","priceKind":"exact","priceFromUsd":150,"priceToUsd":150,"durationMinutes":30,"depositUsd":50}]'::jsonb where clinic_id = $1`,
        [pay.clinicId],
      ),
    );
    await insertGoogleConnection(pay.clinicId, { managed: true, status: "degraded" });
    const ready = await read();
    expect(ready.payment_ask).toMatchObject({ value: "deposit_only", enabled: true, reason: null });
    expect(ready.text_payment_link).toMatchObject({ value: false, enabled: true, reason: null });

    expect(await set("payment_ask", "full_payment")).toMatchObject({ ok: true, resets: [] });
    expect(await set("text_payment_link", true)).toMatchObject({ ok: true, resets: [] });

    // Auto-confirm off from the console: full payment goes back to deposit
    // only in the same write, and the console is told so.
    const off = await set("auto_confirm", false);
    expect(off).toMatchObject({
      ok: true,
      resets: [
        {
          switch: "full_payment",
          notice: "Back to deposit only. Turn on Auto-confirm bookings first, so nobody pays for a time your team might decline.",
        },
      ],
    });
    const after = await read();
    expect(after.payment_ask).toMatchObject({ value: "deposit_only", enabled: false });
    expect(after.text_payment_link).toMatchObject({ value: true, enabled: true });
    expect(await set("payment_ask", "full_payment")).toMatchObject({
      ok: false,
      message: "Turn on Auto-confirm bookings first, so nobody pays for a time your team might decline.",
    });
    // Off again changes nothing, so it resets nothing.
    expect(await set("auto_confirm", false)).toMatchObject({ ok: true, resets: [] });
  });

  test("where calls go, and which calls reach AYA, are refused with a message and change nothing", async () => {
    const before = (await settingRows()).length;
    for (const [key, value] of [
      ["direct_line", "(415) 555-0177"],
      ["transfer_number", "(415) 555-0178"],
      ["coverage_mode", "all_calls"],
      ["phone_greeting", "Hello"],
    ] as const) {
      const out = await runOperation("setClinicSwitch", { clinicId: clinic.clinicId, key, value }, OPERATOR);
      expect(out.status, key).toBe(200);
      const data = (out.body as { data: { ok: boolean; message: string } }).data;
      expect(data.ok, key).toBe(false);
      expect(typeof data.message, key).toBe("string");
    }
    // saveSetting itself refuses an operator the direct line, whoever calls it.
    expect(
      await saveSetting(
        { clinicId: clinic.clinicId, userId: null, actorLabel: "healdesk support", steppedUp: true, actor: { type: "service", serviceName: OPERATOR.email } },
        "direct_line",
        "(415) 555-0177",
      ),
    ).toMatchObject({ ok: false, field: "direct_line" });
    expect((await settingRows()).length).toBe(before);
    expect((await runOperation("setClinicSwitch", { clinicId: "not-a-uuid", key: "tone", value: "warm" }, OPERATOR)).status).toBe(404);
  });

  test("a writer's change survives a feed it cannot record into", async () => {
    // The savepoint keeps the change when its record fails: a key off the list records nothing and throws nothing.
    const { recordSettingChange } = await import("@/lib/clinic/setting-changes");
    const { withTenant } = await import("@/lib/tenant");
    const id = await withTenant({ clinicId: clinic.clinicId, actor: { type: "service", serviceName: "c1-test" } }, (tx) =>
      recordSettingChange(tx, { key: "nonsense", before: true, after: false, origin: { source: "portal", actor: "clinic_signin" } }),
    );
    expect(id).toBeNull();
  });
});
