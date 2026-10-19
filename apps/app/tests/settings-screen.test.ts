import { randomBytes, randomUUID } from "node:crypto";

import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

import { assistantMayAnswer } from "@/lib/billing/answering";
import { depositDecision, readClinicDepositFacts } from "@/lib/billing/deposits";
import { assertPayloadAllowed } from "@/lib/email/lint";
import { optionalEmailAllowed } from "@/lib/email/stop";
import { attachMetaChannel } from "@/lib/meta/channels";
import type { MetaPlatform } from "@/lib/meta/front-door";
import { hashSessionToken } from "@/lib/factors/step-ups";
import { unsubscribeToken } from "@/lib/email/unsubscribe";
import { NOT_A_DEVICE_LABEL } from "@/lib/notices/setting-changed";
import { SIGN_IN_ACTOR_LABEL } from "@/lib/portal/actor";
import { SETTING_CHANNELS } from "@/lib/portal/settings";
import { failureLines } from "@/lib/portal/settings-view";
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
let deviceLabel = "Front desk Mac";
const touched = vi.fn();
/**
 * This browser's session token. Null, the step-up is stood in by `steppedUp`;
 * set, the portal's own actor and step-up code run against step_ups.
 */
let sessionToken: string | null = null;

vi.mock("@/lib/portal/access", () => ({
  requirePortal: async () => portal,
  portalGrants: async () => grants,
  currentSessionToken: async () => sessionToken,
}));
vi.mock("@/lib/portal/actor", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/portal/actor")>();
  return {
    SIGN_IN_ACTOR_LABEL: actual.SIGN_IN_ACTOR_LABEL,
    portalActor: async (ctx: Parameters<typeof actual.portalActor>[0]) => {
      if (sessionToken) return actual.portalActor(ctx);
      return steppedUp
        ? { label: deviceLabel, steppedUp: true }
        : { label: actual.SIGN_IN_ACTOR_LABEL, steppedUp: false };
    },
  };
});
vi.mock("@/lib/portal/step-up", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/portal/step-up")>();
  return {
    sessionBinding: async (ctx: Parameters<typeof actual.sessionBinding>[0]) =>
      sessionToken
        ? actual.sessionBinding(ctx)
        : { userId: portal.userId, sessionTokenHash: randomBytes(32) },
    stepUpPath: (slug: string, next: string) =>
      `/c/${slug}/step-up?next=${encodeURIComponent(next)}`,
    touchStepUp: async (ctx: Parameters<typeof actual.touchStepUp>[0]) => {
      touched();
      return sessionToken ? actual.touchStepUp(ctx) : null;
    },
  };
});
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

/** Connect one Meta platform, as a Facebook login or WhatsApp signup leaves it. */
async function connect(platform: MetaPlatform) {
  await withTenant({ clinicId: portal.clinicId, actor: ACTOR }, (tx) =>
    attachMetaChannel(tx, {
      platform,
      externalId: `${platform === "whatsapp" ? 1 : platform === "instagram" ? 2 : 3}${Date.now()}`,
      accessToken: `EAAB-${platform}-token-0123456789`,
      via: platform === "whatsapp" ? "embedded_signup" : "facebook_login",
    }),
  );
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

describe("Safety net's failure table", () => {
  const planEnds = (bought: { web: boolean; meta: boolean; voice: boolean }) =>
    failureLines({ bought, allowance: null }).find((line) => line.when === "Your plan ends")!.then;

  test("once the plan ends, website chat takes no messages and asks visitors to call; it never promises a contact form", () => {
    // The widget of a clinic that has left keeps nothing (BAA clause 17;
    // lib/chat/contact-form.ts keepsMessages) and shows the practice's
    // number instead. Until 19 October this row said "shows a contact form",
    // and for a chat-only clinic it repeated the pause's sentence.
    for (const bought of [
      { web: true, meta: false, voice: false },
      { web: true, meta: true, voice: false },
      { web: true, meta: false, voice: true },
      { web: true, meta: true, voice: true },
    ]) {
      const line = planEnds(bought);
      expect(line).toContain("Website chat takes no more messages: it asks visitors to call your practice instead, until you remove its line from your site.");
      expect(line).not.toMatch(/contact form/i);
    }
    expect(planEnds({ web: true, meta: false, voice: true })).toMatch(/^For 30 days calls still reach your direct line through us/);
    expect(planEnds({ web: true, meta: true, voice: false })).toContain("Messages wait for your team in the apps.");
    // The pause still turns the chat into its contact form: that is the spec's.
    const paused = failureLines({ bought: { web: true, meta: false, voice: false }, allowance: null }).find((l) => l.when === "AYA is paused")!;
    expect(paused.then).toBe("Website chat shows a contact form.");
  });
});

describeDb("Settings", () => {
  beforeAll(async () => {
    await runMigrations();
    await truncateAll();
    complete = await provisionPortalClinic("settings", { plan: "voice-metachat-1000-1000" });
    chatOnly = await provisionPortalClinic("chatonly", { plan: "webchat-1000" });
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
    deviceLabel = "Front desk Mac";
    sessionToken = null;
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

  test("website chat Off shows the contact form; Instagram, Messenger and WhatsApp switch on their own, and the Meta channel stops only once every connected one is Off", async () => {
    await setLive(true);
    expect(await save("channel_web", false)).toEqual({
      ok: true,
      toast: "Website chat is off. Your website shows a contact form instead.",
    });
    expect(await gate("web")).toMatchObject({ reason: "channel_off", fallback: "contact_form" });

    // The Meta channel has no switch of its own any more, and a platform has
    // one only once it is connected.
    expect(await save("channel_meta", false)).toMatchObject({
      ok: false,
      message: "That isn't one of your settings.",
    });
    expect(await save("channel_instagram", false)).toEqual({
      ok: false,
      message: "Instagram isn't connected yet. Its switch appears here once it is.",
    });

    await connect("instagram");
    await connect("whatsapp");
    expect(await save("channel_instagram", false)).toEqual({
      ok: true,
      toast: "Instagram is off. Messages there wait for your team in Instagram.",
    });
    // WhatsApp is still On, so the channel still answers there.
    expect(await gate("meta")).toEqual({ decision: "answer" });
    expect(await save("channel_whatsapp", false)).toMatchObject({ ok: true });
    // Every connected platform Off: the channel is Off, whatever the
    // unconnected Messenger switch says, and messages wait for the team.
    expect(await gate("meta")).toMatchObject({ reason: "channel_off", fallback: "no_reply" });
    expect(await save("channel_instagram", true)).toEqual({
      ok: true,
      toast: "Instagram is on. AYA answers messages there.",
    });
    expect(await gate("meta")).toEqual({ decision: "answer" });

    const events = await inTenant(
      portal.clinicId,
      async (c) =>
        (
          await c.query<{ kind: string; platform: string | null; actor: string }>(
            `select kind, detail->>'platform' as platform, actor from channel_events
              where channel = 'meta' order by occurred_at, (detail ? 'platform') desc`,
          )
        ).rows,
    );
    expect(events).toEqual([
      { kind: "turned_off", platform: "instagram", actor: "the clinic's sign-in" },
      { kind: "turned_off", platform: "whatsapp", actor: "the clinic's sign-in" },
      { kind: "turned_off", platform: null, actor: "the clinic's sign-in" },
      { kind: "turned_on", platform: "instagram", actor: "the clinic's sign-in" },
      { kind: "turned_on", platform: null, actor: "the clinic's sign-in" },
    ]);

    await save("channel_web", true);
    await save("channel_whatsapp", true);
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
    // Only the languages the screens read: the review of 14 October.
    expect(await save("languages", ["en", "fr"])).toEqual({
      ok: false,
      message: "AYA answers in English and Spanish, the languages its safety checks read.",
    });
    // Instagram, Messenger and WhatsApp answer in English: the setting applies to the phone and the website only.
    expect(SETTING_CHANNELS.languages).toEqual(["web", "voice"]);
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
    // With phone live the refusal says why in phone's words, as the
    // operator's path does (DIRECT_LINE_NEEDED_WHILE_LIVE).
    const wasLive = await inTenant(
      portal.clinicId,
      async (c) =>
        (
          await c.query<{ live_at: Date | null }>(
            `select live_at from clinic_channels where channel = 'voice'`,
          )
        ).rows[0]!.live_at,
    );
    await inTenant(portal.clinicId, (c) =>
      c.query(`update clinic_channels set live_at = now() where channel = 'voice'`),
    );
    expect(await save("direct_line", "")).toMatchObject({
      ok: false,
      message: expect.stringMatching(
        /^Phone is live, so the direct line can be changed but not removed/,
      ),
    });
    await inTenant(portal.clinicId, (c) =>
      c.query(`update clinic_channels set live_at = $1 where channel = 'voice'`, [wasLive]),
    );

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

  test("there is no setting for how long transcripts are kept: the key is refused, nothing is stored, and no card offers it", async () => {
    // The owner's decision of 13 October 2026: a transcript is emailed to the
    // clinic when its conversation ends, and healdesk keeps none (BAA 1.4.0
    // clause 11). Until then Settings had a Records card, "Keep transcripts
    // for", under BAA 1.3.0's "Practice may shorten the period for
    // transcripts in its portal"; with nothing to keep, nothing may offer it.
    const stored = () =>
      inTenant(
        portal.clinicId,
        async (c) =>
          (
            await c.query<{ days: number }>(
              `select transcript_retention_days as days from clinic_settings where clinic_id = $1`,
              [portal.clinicId],
            )
          ).rows[0]?.days,
      );
    const history = () =>
      inTenant(
        portal.clinicId,
        async (c) =>
          (
            await c.query<{ id: string }>(
              `select id from clinic_settings_history where field = 'transcript_retention_days'`,
            )
          ).rows,
      );
    const before = (await stored()) ?? 90;

    // Refused as no setting at all, with or without a live passkey, whatever
    // the value, and nothing stored, kept in the history or emailed.
    for (const steppedUpNow of [false, true]) {
      steppedUp = steppedUpNow;
      for (const value of [7, 30, 90, "7"]) {
        expect(await save("transcript_retention", value), String(value)).toEqual({
          ok: false,
          message: "That isn't one of your settings.",
        });
      }
    }
    expect((await stored()) ?? 90).toBe(before);
    expect(await history()).toEqual([]);
    const notices = await inTenant(
      portal.clinicId,
      async (c) =>
        (
          await c.query(
            `select id from billing_notices
              where kind = 'setting_changed' and payload->>'field' = 'transcript_retention_days'`,
          )
        ).rows,
    );
    expect(notices).toEqual([]);

    // The page offers no such choice.
    const { default: SettingsPage } = await import("@/app/c/[slug]/settings/page");
    const html = renderToStaticMarkup(
      await SettingsPage({
        params: Promise.resolve({ slug: portal.clinicSlug }),
        searchParams: Promise.resolve({}),
      }),
    );
    expect(html).toContain('id="channels"');
    expect(html).not.toContain('id="records"');
    expect(html).not.toMatch(/Keep transcripts for|transcript_retention/);
    expect(html).not.toMatch(/transcripts? (are|is) kept/i);
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
    // The toast names what changes with it: the recap goes alone on Mondays
    // (lib/scheduler/weekly-recap.ts), or rides the week's first summary.
    expect(await save("daily_summary", false)).toMatchObject({
      ok: true,
      toast: expect.stringMatching(/your weekly recap comes on its own each Monday\./),
    });
    expect(await allowed()).toBe(false);
    expect(await save("daily_summary", true)).toMatchObject({
      ok: true,
      toast: expect.stringMatching(/the week's first carries your weekly recap\./),
    });
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

  test("product updates (L33): on by default, and its stop link turns the switch off, which the sender reads", async () => {
    const allowed = () =>
      withTenant({ clinicId: portal.clinicId, actor: ACTOR }, (tx) =>
        optionalEmailAllowed(tx, "product_updates"),
      );
    expect(await allowed()).toBe(true);
    const { POST } = await import("@/app/email/stop/[token]/route");
    const token = unsubscribeToken(portal.clinicId, "product_updates");
    const response = await POST(
      new Request(`https://app.healdesk.test/email/stop/${token}`, {
        method: "POST",
        body: "List-Unsubscribe=One-Click",
      }),
      { params: Promise.resolve({ token }) },
    );
    expect(response.status).toBe(200);
    expect(await allowed()).toBe(false);
    // Only that switch: the daily summary still goes.
    expect(
      await withTenant({ clinicId: portal.clinicId, actor: ACTOR }, (tx) =>
        optionalEmailAllowed(tx, "daily_summary"),
      ),
    ).toBe(true);
    await inTenant(portal.clinicId, async (c) => {
      await c.query(`update clinic_settings set product_updates = true where clinic_id = $1`, [
        portal.clinicId,
      ]);
    });
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
    // A switch for each connected Meta platform (Instagram and WhatsApp,
    // connected above), none for Messenger, and none for the channel itself.
    expect(html).toMatch(/class="font-semibold">Instagram<\/p>/);
    expect(html).toMatch(/class="font-semibold">WhatsApp<\/p>/);
    expect(html).not.toMatch(/class="font-semibold">Messenger<\/p>/);
    expect(html).not.toMatch(/class="font-semibold">Instagram, Messenger &amp; WhatsApp<\/p>/);

    use(chatOnly);
    const chat = await render();
    expect(chat).toContain("Website chat");
    expect(chat).not.toMatch(/class="font-semibold">(Instagram|Messenger|WhatsApp)<\/p>/);
    expect(chat).not.toContain("Direct line");
    expect(chat).not.toContain("Which calls reach AYA");
    expect(chat).not.toContain("Transfer live calls");
    expect(chat).not.toContain("When AYA answers a call");
    expect(brokenLinks(chat, portal.clinicSlug)).toEqual([]);
  });

  test("O4 leaves out a device name the email may not carry, rather than have the sender refuse it for good", async () => {
    steppedUp = true;
    deviceLabel = "maria@frontdesk";
    expect(await save("direct_line", "(512) 555-0166")).toMatchObject({ ok: true });
    const [notice] = await inTenant(
      portal.clinicId,
      async (c) =>
        (
          await c.query<{ payload: Record<string, unknown> }>(
            `select payload from billing_notices
              where kind = 'setting_changed' and payload->>'afterMasked' = '(•••) •••-0166'`,
          )
        ).rows,
    );
    expect(notice!.payload).toMatchObject({
      field: "direct_line_e164",
      beforeMasked: "(•••) •••-0188",
      afterMasked: "(•••) •••-0166",
    });
    expect(notice!.payload).not.toHaveProperty("deviceName");
    // What the sender checks before it renders: it passes, so the email goes.
    expect(() => assertPayloadAllowed(notice!.payload, "setting_changed")).not.toThrow();
  });

  test("disconnecting the payment account needs a step-up: without one it is refused and the account stays connected", async () => {
    await sql(
      `update clinics set stripe_connect_account_id = 'acct_1TestDeposit', stripe_connect_connected_at = now() where id = $1`,
      [portal.clinicId],
    );
    const { disconnectPaymentsAction } = await import("@/app/c/[slug]/settings/actions");
    expect(await disconnectPaymentsAction(portal.clinicSlug)).toEqual({
      ok: false,
      message: expect.stringMatching(/^Disconnecting your payment account needs Face ID/),
      stepUpHref: `/c/${portal.clinicSlug}/step-up?next=${encodeURIComponent(`/c/${portal.clinicSlug}/settings`)}`,
    });
    expect(touched).not.toHaveBeenCalled();
    expect(
      await sql(`select stripe_connect_account_id from clinics where id = $1`, [portal.clinicId]),
    ).toEqual([{ stripe_connect_account_id: "acct_1TestDeposit" }]);
  });

  test("a real step-up: only a live step_ups row on this session lets the direct line change, the change is named by its device, and it counts as activity", async () => {
    // A passkey on the clinic's sign-in, as "Add this device" leaves it.
    const factorId = randomUUID();
    await sql(
      `insert into user_factors (id, user_id, kind, device_label, credential_id, public_key, counter, transports, backed_up)
       values ($1, $2, 'passkey', 'Back office PC', $3, $4, 0, '{internal}', true)`,
      [factorId, portal.userId, randomBytes(16).toString("base64url"), randomBytes(77)],
    );
    sessionToken = randomBytes(24).toString("base64url");
    const latest = async () =>
      (
        await inTenant(
          portal.clinicId,
          async (c) =>
            (
              await c.query<{ after_value: string; actor_label: string }>(
                `select after_value, actor_label from clinic_settings_history
                  where field = 'direct_line_e164' order by changed_at desc limit 1`,
              )
            ).rows,
        )
      )[0]!;
    const before = await latest();

    // No step-up on this session yet: refused, and nothing written.
    expect(await save("direct_line", "(512) 555-0155")).toMatchObject({
      ok: false,
      stepUpHref: expect.any(String),
    });
    expect(await latest()).toEqual(before);

    // The passkey ceremony's row, five minutes ago, on another session: not this one's.
    const stepUpRow = async (token: string) =>
      (
        await sql<{ id: string }>(
          `insert into step_ups (session_token_hash, user_id, factor_id, device_label, created_at, last_activity_at)
           values ($1, $2, $3, 'Back office PC', now() - interval '5 minutes', now() - interval '5 minutes')
           returning id`,
          [hashSessionToken(token), portal.userId, factorId],
        )
      )[0]!.id;
    await stepUpRow(randomBytes(24).toString("base64url"));
    expect(await save("direct_line", "(512) 555-0155")).toMatchObject({ ok: false });

    // This session's: the change goes through, under the device's name.
    const id = await stepUpRow(sessionToken);
    expect(await save("direct_line", "(512) 555-0155")).toMatchObject({ ok: true });
    expect(await latest()).toEqual({ after_value: "+15125550155", actor_label: "Back office PC" });
    const [row] = await sql<{ touched: boolean }>(
      `select last_activity_at > created_at + interval '1 minute' as touched from step_ups where id = $1`,
      [id],
    );
    expect(row).toEqual({ touched: true });

    // Removing the device ends what it stepped up: the next change is refused.
    await sql(`update user_factors set revoked_at = now() where id = $1`, [factorId]);
    expect(await save("direct_line", "(512) 555-0144")).toMatchObject({ ok: false });
  });
});
