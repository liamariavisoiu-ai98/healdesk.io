import { randomBytes } from "node:crypto";

import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

import { assistantMayAnswer } from "@/lib/billing/answering";
import { depositDecision, readClinicDepositFacts } from "@/lib/billing/deposits";
import { optionalEmailAllowed } from "@/lib/email/stop";
import { unsubscribeToken } from "@/lib/email/unsubscribe";
import { NOT_A_DEVICE_LABEL } from "@/lib/notices/setting-changed";
import { SIGN_IN_ACTOR_LABEL } from "@/lib/portal/actor";
import { withTenant } from "@/lib/tenant";

import {
  closePools,
  getMigratorPool,
  hasTestDatabase,
  runMigrations,
  truncateAll,
} from "./setup/db";
import { inTenant } from "./setup/factories";
import { provisionPortalClinic, type PortalClinic } from "./setup/portal-clinic";
import { brokenLinks } from "./setup/portal-links";

/**
 * Settings (plan Part F2), through its server actions with the sign-in stood
 * in, against a provisioned clinic: each switch's EFFECT, where something in
 * this build reads it (the answer gate, the deposit decision, the sender's
 * optional-email switch, the call routing), and otherwise the "Applies when
 * … opens" its toast carries; the step-up on where calls go once set, with
 * its history row and its O4 email; refusals worded for the clinic; and the
 * page as a browser receives it.
 */

const portal = { userId: "", clinicId: "", clinicSlug: "" };
const grants: { clinicId: string; slug: string; name: string }[] = [];
let steppedUp = false;
const touched = vi.fn();

vi.mock("@/lib/portal/access", () => ({
  requirePortal: async () => portal,
  portalGrants: async () => grants,
  currentSessionToken: async () => null,
}));
vi.mock("@/lib/portal/actor", () => ({
  SIGN_IN_ACTOR_LABEL: "the clinic's sign-in",
  portalActor: async () =>
    steppedUp
      ? { label: "Front desk Mac", steppedUp: true }
      : { label: "the clinic's sign-in", steppedUp: false },
}));
vi.mock("@/lib/portal/step-up", () => ({
  sessionBinding: async () => ({ userId: portal.userId, sessionTokenHash: randomBytes(32) }),
  stepUpPath: (slug: string, next: string) => `/c/${slug}/step-up?next=${encodeURIComponent(next)}`,
  touchStepUp: async () => {
    touched();
    return null;
  },
}));
vi.mock("@/app/c/[slug]/request-meta", () => ({ requestMeta: async () => ({}) }));

const describeDb = hasTestDatabase ? describe : describe.skip;
const ACTOR = { type: "service", serviceName: "settings-test" } as const;

let complete: PortalClinic;
let chatOnly: PortalClinic;

function use(clinic: PortalClinic) {
  Object.assign(portal, {
    userId: clinic.userId,
    clinicId: clinic.clinicId,
    clinicSlug: clinic.clinicSlug,
  });
  grants.splice(0, grants.length, {
    clinicId: clinic.clinicId,
    slug: clinic.clinicSlug,
    name: "Settings Med Spa LLC",
  });
}

async function save(key: string, value: unknown) {
  const { saveSettingAction } = await import("@/app/c/[slug]/settings/actions");
  return saveSettingAction(portal.clinicSlug, key, value);
}

async function gate(channel: "voice" | "web" | "meta") {
  return assistantMayAnswer({ clinicId: portal.clinicId, channel, actor: ACTOR });
}

async function sql<T extends Record<string, unknown>>(text: string, values: unknown[] = []) {
  return (await getMigratorPool().query<T>(text, values)).rows;
}

/**
 * Mark the clinic's channels live (or not) as go-live will, inside its tenant:
 * clinic_channels forces row-level security, so the migrator's own update
 * would change nothing.
 */
async function setLive(live: boolean, channel?: "voice" | "web" | "meta") {
  await inTenant(portal.clinicId, async (c) => {
    await c.query(
      `update clinic_channels set live_at = ${live ? "now()" : "null"}
        where clinic_id = $1 and ($2::text is null or channel = $2)`,
      [portal.clinicId, channel ?? null],
    );
  });
}

describeDb("Settings", () => {
  beforeAll(async () => {
    await runMigrations();
    await truncateAll();
    complete = await provisionPortalClinic("settings", { plan: "complete" });
    chatOnly = await provisionPortalClinic("chatonly", { plan: "chat-web" });
    // The billing row as the first invoice leaves it, so the answer gate
    // decides on the clinic's own switches rather than on billing.
    for (const clinic of [complete, chatOnly]) {
      await inTenant(clinic.clinicId, async (c) => {
        await c.query(`update entitlements set status = 'active' where clinic_id = $1`, [
          clinic.clinicId,
        ]);
      });
    }
  }, 180_000);

  afterAll(async () => {
    await closePools();
  });

  beforeEach(() => {
    use(complete);
    steppedUp = false;
    touched.mockClear();
  });

  test("the sign-in label the O4 email leaves out is the portal's own", () => {
    expect(NOT_A_DEVICE_LABEL).toBe(SIGN_IN_ACTOR_LABEL);
  });

  test("a channel switch: Off passes a live channel through to the direct line, On answers again, and each flip names the device", async () => {
    expect(await save("direct_line", "(512) 555-0177")).toMatchObject({ ok: true });
    await setLive(true, "voice");
    expect(await gate("voice")).toEqual({ decision: "answer" });

    const off = await save("channel_voice", false);
    expect(off).toEqual({
      ok: true,
      toast: "Phone is off. Calls go to your direct line, (512) 555-0177.",
    });
    expect(await gate("voice")).toEqual({
      decision: "pass_through",
      reason: "channel_off",
      fallback: "direct_line",
      directLine: "+15125550177",
    });

    steppedUp = true;
    expect(await save("channel_voice", true)).toMatchObject({ ok: true });
    expect(await gate("voice")).toEqual({ decision: "answer" });

    const events = await inTenant(
      portal.clinicId,
      async (c) =>
        (
          await c.query(
            `select kind, actor from channel_events where channel = 'voice' order by occurred_at`,
          )
        ).rows,
    );
    expect(events).toEqual([
      { kind: "turned_off", actor: "the clinic's sign-in" },
      { kind: "turned_on", actor: "Front desk Mac" },
    ]);
    // A repeat changes nothing and records nothing.
    expect(await save("channel_voice", true)).toMatchObject({ ok: true });
    const count = await inTenant(
      portal.clinicId,
      async (c) =>
        (await c.query<{ n: number }>(`select count(*)::int as n from channel_events`)).rows[0],
    );
    expect(count).toEqual({ n: 2 });
    await setLive(false);
  });

  test("website chat Off shows the contact form; the Meta channels leave messages for the team", async () => {
    await setLive(true);
    expect(await save("channel_web", false)).toEqual({
      ok: true,
      toast: "Website chat is off. Your website shows a contact form instead.",
    });
    expect(await gate("web")).toMatchObject({ reason: "channel_off", fallback: "contact_form" });
    expect(await save("channel_meta", false)).toMatchObject({ ok: true });
    expect(await gate("meta")).toMatchObject({ reason: "channel_off", fallback: "no_reply" });
    await save("channel_web", true);
    await save("channel_meta", true);
    await setLive(false);
  });

  test("a switch whose channels are not answering says when it applies", async () => {
    expect(await save("tone", "clinical")).toEqual({
      ok: true,
      toast:
        "Tone: clinical and professional. Brief, calm and precise. Applies when website chat, phone and Instagram, Messenger & WhatsApp open.",
    });
    expect(await save("suggest_add_ons", true)).toMatchObject({
      toast: expect.stringMatching(/Applies when website chat and phone open\.$/),
    });
    expect(await save("phone_greeting", "Thanks for calling Glow. How can I help?")).toMatchObject({
      toast: expect.stringMatching(/Callers hear it .* Applies when phone opens\.$/),
    });
    expect(await save("languages", ["en", "es"])).toMatchObject({
      toast: expect.stringContaining("AYA answers in English and Spanish"),
    });
  });

  test("the direct line: set once freely; a change needs a step-up, keeps its history, emails the clinic masked, and is where the gate sends calls", async () => {
    // Set in the first test; a change now needs a step-up.
    const refused = await save("direct_line", "(512) 555-0188");
    expect(refused).toEqual({
      ok: false,
      message: expect.stringMatching(/needs Face ID or your screen lock/),
      stepUpHref: `/c/${portal.clinicSlug}/step-up?next=${encodeURIComponent(`/c/${portal.clinicSlug}/settings`)}`,
    });
    expect(touched).not.toHaveBeenCalled();
    expect(await save("direct_line", "")).toMatchObject({
      ok: false,
      message: expect.stringMatching(/can be changed but not removed/),
    });

    steppedUp = true;
    expect(await save("direct_line", "(512) 555-0188")).toEqual({
      ok: true,
      toast:
        "Direct line: (512) 555-0188. Calls go there whenever AYA can't answer. Applies when phone opens.",
    });
    expect(touched).toHaveBeenCalledTimes(1);

    const history = await inTenant(
      portal.clinicId,
      async (c) =>
        (
          await c.query(
            `select before_value, after_value, actor_label from clinic_settings_history
            where field = 'direct_line_e164' order by changed_at`,
          )
        ).rows,
    );
    expect(history).toEqual([
      { before_value: null, after_value: "+15125550177", actor_label: "the clinic's sign-in" },
      { before_value: "+15125550177", after_value: "+15125550188", actor_label: "Front desk Mac" },
    ]);
    // O4 for the change, not for the first setting.
    const notices = await inTenant(
      portal.clinicId,
      async (c) =>
        (
          await c.query<{ dedupe_key: string; payload: Record<string, unknown> }>(
            `select dedupe_key, payload from billing_notices where kind = 'setting_changed'`,
          )
        ).rows,
    );
    expect(notices).toHaveLength(1);
    expect(notices[0]!.payload).toEqual({
      field: "direct_line_e164",
      beforeMasked: "(•••) •••-0177",
      afterMasked: "(•••) •••-0188",
      changedAt: expect.any(String),
      deviceName: "Front desk Mac",
      settingsUrl: expect.stringMatching(
        new RegExp(`/c/${portal.clinicSlug}/settings#safety-net$`),
      ),
    });
    expect(JSON.stringify(notices[0]!.payload)).not.toMatch(/5550177|5550188/);

    await setLive(true, "voice");
    await save("channel_voice", false);
    expect(await gate("voice")).toMatchObject({ directLine: "+15125550188" });
    await save("channel_voice", true);
    await setLive(false);
  });

  test("the transfer number: first set freely, then a step-up and O4; never the main number, which forwards to AYA", async () => {
    await sql(`update clinics set published_phone_e164 = '+15125550100' where id = $1`, [
      portal.clinicId,
    ]);
    expect(await save("transfer_number", "(512) 555-0100")).toMatchObject({
      ok: false,
      message: expect.stringMatching(/different line from your main number/),
    });
    expect(await save("transfer_number", "(512) 555-0199")).toMatchObject({
      ok: true,
      toast: expect.stringMatching(/^Transfer number: \(512\) 555-0199\./),
    });
    expect(await save("transfer_number", "")).toMatchObject({
      ok: false,
      stepUpHref: expect.any(String),
    });
    steppedUp = true;
    expect(await save("transfer_number", "")).toMatchObject({
      ok: true,
      toast: expect.stringMatching(/^Live transfers go to your direct line\./),
    });
    const notices = await inTenant(
      portal.clinicId,
      async (c) =>
        (
          await c.query<{ payload: { beforeMasked: string | null; afterMasked: string | null } }>(
            `select payload from billing_notices where kind = 'setting_changed' and payload->>'field' = 'transfer_e164'`,
          )
        ).rows,
    );
    expect(notices.map((n) => [n.payload.beforeMasked, n.payload.afterMasked])).toEqual([
      ["(•••) •••-0199", null],
    ]);
  });

  test("deposits: Take deposits waits for a connected account and an amount; each switch changes what AYA does with a booking that needs one", async () => {
    expect(await save("deposits_enabled", true)).toMatchObject({
      ok: false,
      message: expect.stringMatching(/Connect your Stripe account/),
    });
    await sql(
      `update clinics set stripe_connect_account_id = 'acct_1TestDeposit', stripe_connect_connected_at = now() where id = $1`,
      [portal.clinicId],
    );
    expect(await save("deposits_enabled", true)).toMatchObject({
      ok: false,
      message: expect.stringMatching(/Set a deposit amount/),
    });
    await inTenant(portal.clinicId, async (c) => {
      await c.query(
        `update agent_configs set services = '[{"name":"Consultation","priceKind":"exact","priceFromUsd":150,"priceToUsd":150,"durationMinutes":30,"depositUsd":50}]'::jsonb where clinic_id = $1`,
        [portal.clinicId],
      );
    });
    expect(await save("deposits_enabled", true)).toMatchObject({ ok: true });

    const decide = async (channel: "voice" | "web") => {
      const facts = await withTenant({ clinicId: portal.clinicId, actor: ACTOR }, (tx) =>
        readClinicDepositFacts(tx),
      );
      return depositDecision({
        channel,
        depositsEnabled: facts.depositsEnabled,
        isConnected: facts.isConnected,
        amountUsd: 50,
        bookVoiceWithoutDeposit: facts.bookVoiceWithoutDeposit,
        bookChatWithoutDeposit: facts.bookChatWithoutDeposit,
        uncollectable: facts.uncollectable,
        canCollectNow: false,
      }).action;
    };
    expect(await decide("voice")).toBe("book_and_flag");
    expect(await save("book_voice_without_deposit", false)).toMatchObject({ ok: true });
    expect(await decide("voice")).toBe("decline_and_alert");

    expect(await decide("web")).toBe("book_and_flag");
    expect(await save("deposit_uncollectable", "hold_and_alert")).toMatchObject({
      toast: expect.stringMatching(/holds the slot for 60 minutes/),
    });
    expect(await decide("web")).toBe("hold_and_alert");
    expect(await save("deposit_hold_minutes", "120")).toMatchObject({ ok: true });
    expect(await save("book_chat_without_deposit", true)).toMatchObject({ ok: true });
    expect(await decide("web")).toBe("book_and_flag");

    expect(await save("deposits_enabled", false)).toMatchObject({ ok: true });
    expect(await decide("voice")).toBe("book");
  });

  test("the daily summary: its switch decides whether the sender sends it, and its stop link turns it off", async () => {
    const allowed = () =>
      withTenant({ clinicId: portal.clinicId, actor: ACTOR }, (tx) =>
        optionalEmailAllowed(tx, "daily_summary"),
      );
    expect(await allowed()).toBe(true);
    expect(await save("daily_summary", false)).toMatchObject({ ok: true });
    expect(await allowed()).toBe(false);
    expect(await save("daily_summary", true)).toMatchObject({ ok: true });
    expect(await allowed()).toBe(true);

    const { GET, POST } = await import("@/app/email/stop/[token]/route");
    const token = unsubscribeToken(portal.clinicId, "daily_summary");
    const params = { params: Promise.resolve({ token }) };
    // Opening the link changes nothing: it goes to the confirmation page.
    const opened = await GET(new Request(`https://app.healdesk.test/email/stop/${token}`), params);
    expect(opened.status).toBe(303);
    expect(opened.headers.get("Location")).toBe(`/email/stop/${token}/confirm`);
    expect(await allowed()).toBe(true);
    // A mail client's one-click POST stops it.
    const clicked = await POST(
      new Request(`https://app.healdesk.test/email/stop/${token}`, {
        method: "POST",
        body: "List-Unsubscribe=One-Click",
      }),
      params,
    );
    expect(clicked.status).toBe(200);
    expect(await allowed()).toBe(false);
    // A forged token changes nothing.
    const forged = await POST(
      new Request("https://app.healdesk.test/email/stop/x.y", { method: "POST" }),
      {
        params: Promise.resolve({ token: "x.y" }),
      },
    );
    expect(forged.status).toBe(404);
    await save("daily_summary", true);
  });

  test("usage alerts' stop link turns the billing clinic's switch off, which the sender reads", async () => {
    const { POST } = await import("@/app/email/stop/[token]/route");
    const token = unsubscribeToken(portal.clinicId, "usage_alerts");
    const response = await POST(
      new Request(`https://app.healdesk.test/email/stop/${token}`, { method: "POST", body: "" }),
      { params: Promise.resolve({ token }) },
    );
    expect(response.status).toBe(303);
    expect(response.headers.get("Location")).toBe(`/email/stop/${token}/confirm?done=1`);
    const allowed = await withTenant({ clinicId: portal.clinicId, actor: ACTOR }, (tx) =>
      optionalEmailAllowed(tx, "usage_alerts"),
    );
    expect(allowed).toBe(false);
    await inTenant(portal.clinicId, async (c) => {
      await c.query(`update entitlements set usage_alerts_enabled = true where clinic_id = $1`, [
        portal.clinicId,
      ]);
    });
  });

  test("which calls reach AYA is the single source, and the call routing follows it", async () => {
    expect(await save("coverage_mode", "all_calls")).toMatchObject({
      ok: true,
      toast: expect.stringMatching(/^All calls: .* Applies when phone opens\.$/),
    });
    const routing = async () =>
      (
        await sql<{ call_routing: string }>(`select call_routing from clinics where id = $1`, [
          portal.clinicId,
        ])
      )[0]!.call_routing;
    expect(await routing()).toBe("always");
    expect(await save("coverage_mode", "after_hours_only")).toMatchObject({ ok: true });
    expect(await routing()).toBe("conditional");
    const stored = await inTenant(
      portal.clinicId,
      async (c) =>
        (
          await c.query(`select coverage_mode from clinic_settings where clinic_id = $1`, [
            portal.clinicId,
          ])
        ).rows[0],
    );
    expect(stored).toEqual({ coverage_mode: "after_hours_only" });
  });

  test("After hours only: a live phone passes calls through to the direct line while the clinic is open, and answers once it shuts", async () => {
    const weekdays = [["09:00", "17:00"]];
    await sql(
      `update clinics set timezone = 'America/Chicago', opening_hours = $2::jsonb where id = $1`,
      [
        portal.clinicId,
        JSON.stringify({
          sun: [],
          mon: weekdays,
          tue: weekdays,
          wed: weekdays,
          thu: weekdays,
          fri: weekdays,
          sat: [],
        }),
      ],
    );
    await setLive(true, "voice");
    const at = (iso: string) =>
      assistantMayAnswer({
        clinicId: portal.clinicId,
        channel: "voice",
        actor: ACTOR,
        now: new Date(iso),
      });
    // Wednesday 14 October 2026, 10:00 in Chicago: open.
    const wednesdayMorning = "2026-10-14T15:00:00Z";
    // The same Wednesday, 22:00 in Chicago: shut.
    const wednesdayNight = "2026-10-15T03:00:00Z";

    expect(await save("coverage_mode", "after_hours_only")).toMatchObject({ ok: true });
    expect(await at(wednesdayMorning)).toEqual({
      decision: "pass_through",
      reason: "outside_coverage",
      fallback: "direct_line",
      directLine: "+15125550188",
    });
    expect(await at(wednesdayNight)).toEqual({ decision: "answer" });

    // Overflow and after hours answers the calls staff miss while open.
    expect(await save("coverage_mode", "overflow_after_hours")).toMatchObject({ ok: true });
    expect(await at(wednesdayMorning)).toEqual({ decision: "answer" });
    await setLive(false);
  });

  test("refusals are worded for the clinic: a setting it didn't buy, and a greeting that says something clinical", async () => {
    use(chatOnly);
    expect(await save("coverage_mode", "all_calls")).toEqual({
      ok: false,
      message: "That setting isn't part of your plan.",
    });
    expect(await save("direct_line", "(512) 555-0177")).toMatchObject({ ok: false });
    expect(await save("not_a_setting", true)).toMatchObject({ ok: false });
    expect(await save("chat_greeting", "Ask me about side effects before you book!")).toMatchObject(
      {
        ok: false,
        message: expect.stringMatching(/can't include side effects or risks \("/),
      },
    );
    expect(await save("chat_greeting", null)).toMatchObject({
      ok: true,
      toast: expect.stringMatching(/^Greeting back to the default\./),
    });
  });

  test("the page: every switch a labelled role=switch with its line, bought channels only, and every link goes somewhere", async () => {
    const { default: SettingsPage } = await import("@/app/c/[slug]/settings/page");
    const render = async () =>
      renderToStaticMarkup(
        await SettingsPage({
          params: Promise.resolve({ slug: portal.clinicSlug }),
          searchParams: Promise.resolve({}),
        }),
      );

    const html = await render();
    for (const id of [
      "channels",
      "how-aya-talks",
      "calendar",
      "payments",
      "safety-net",
      "alerts",
      "sign-in",
    ]) {
      expect(html, id).toContain(`id="${id}"`);
    }
    const switches = [...html.matchAll(/<button[^>]*role="switch"[^>]*>/g)].map((m) => m[0]);
    expect(switches.length).toBeGreaterThan(8);
    for (const tag of switches) {
      expect(tag).toMatch(/aria-checked="(true|false)"/);
      expect(tag).toMatch(/aria-labelledby="[^"]+"/);
      expect(tag).toMatch(/aria-describedby="[^"]+"/);
    }
    expect(html).toContain('role="status"');
    expect(brokenLinks(html, portal.clinicSlug)).toEqual([]);

    use(chatOnly);
    const chat = await render();
    expect(chat).toContain("Website chat");
    expect(chat).not.toContain("Direct line");
    expect(chat).not.toContain("Which calls reach AYA");
    expect(chat).not.toContain("Transfer live calls");
    expect(chat).not.toContain("When AYA answers a call");
    expect(brokenLinks(chat, portal.clinicSlug)).toEqual([]);
  });
});
