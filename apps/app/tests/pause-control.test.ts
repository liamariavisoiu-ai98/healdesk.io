import { randomUUID } from "node:crypto";

import type { Channel } from "@healdesk/catalog";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";

import { __setMetaRuntimeForTests, POST as metaPost } from "@/app/api/webhooks/meta/route";
import type { AssistantResponder } from "@/lib/assistant/turn";
import { voiceAnswerDecision } from "@/lib/billing/answering";
import { updateClinicSettings } from "@/lib/billing/settings";
import {
  noteChannelSwitchedOff,
  PAUSE_REMINDER_MS,
  pauseAya,
  PauseError,
  pauseEmailSuperseded,
  resumeAya,
  sweepEndedPauses,
} from "@/lib/channels/pause";
import {
  fallbackLine,
  pauseBanner,
  pauseEmailsClinic,
  pauseEndFor,
} from "@/lib/channels/pause-words";
import { sendWebChatMessage, signToken, startWebChat, webChatClinic } from "@/lib/chat/web-chat";
import { assertPayloadAllowed } from "@/lib/email/lint";
import { deliverNotice } from "@/lib/email/outbox";
import { supersededReason } from "@/lib/email/superseded";
import { attachMetaChannel, setMetaFrontDoor, type MetaSender } from "@/lib/meta/channels";
import type { FrontDoorResponder } from "@/lib/meta/front-door";
import { signMetaBody } from "@/lib/meta/webhook";
import { approveAgentConfig, updateAgentConfig } from "@/lib/onboarding/agent-config";
import { setPhoneSettings } from "@/lib/onboarding/phone";
import { opSetClinicSettings } from "@/lib/ops/billing";
import { saveSetting } from "@/lib/portal/settings";
import type { DeliveryResult, EmailTransport, OutgoingEmail } from "@/lib/reporting/deliver";
import { withTenant, type TenantTx } from "@/lib/tenant";
import { RetellCallSession, TRANSFER_LINE, type RetellOutbound } from "@/lib/voice/retell";

import {
  closePools,
  getMigratorPool,
  hasTestDatabase,
  runMigrations,
  truncateAll,
} from "./setup/db";
import {
  bindAgreementInEffect,
  inTenant,
  seedClinic,
  seedEntitled,
  setWeekdayHours,
} from "./setup/factories";

/**
 * Pause AI and L15 (plan Part F0, Annex X5; spec, "Every switch in the
 * portal"). Pure first: the three durations on the clinic's clock, each
 * channel's line and the banner. Then against the database: a
 * pause stops AYA on every channel's entry point (Retell, web chat, the Meta
 * webhook) with phone going to the direct line; switching back on, or the
 * pause's own end, brings her back with one `resumed` row; L15 goes for a
 * pause until tomorrow or with no end, again a day into one with no end, and
 * for a live channel switched Off, never for an hour.
 */

const describeDb = hasTestDatabase ? describe : describe.skip;
const ACTOR = { type: "service", serviceName: "pause-control-test" } as const;
const ZONE = "America/New_York";
/** 11:00 am EDT, Thursday 15 October 2026. */
const NOW = new Date("2026-10-15T15:00:00Z");
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const at = (ms: number) => new Date(NOW.getTime() + ms);
/**
 * A delivery time no earlier than the database's own clock: a notice queued
 * with no delay is due from `now()` there, which runs on whatever today is,
 * while these tests pause on a fixed day.
 */
const onceDue = (when: Date) => new Date(Math.max(Date.now(), when.getTime()) + MINUTE);
const LINE = "+14155550123";
const DEVICE = "Front desk Mac";

// -----------------------------------------------------------------------------
// Pure
// -----------------------------------------------------------------------------

describe("the pause's words", () => {
  test("for 1 hour, until 8 am tomorrow on the clinic's clock, or until turned back on", () => {
    expect(pauseEndFor("hour", NOW, ZONE)).toEqual(at(HOUR));
    // 08:00 EDT on Friday 16 October.
    expect(pauseEndFor("tomorrow", NOW, ZONE)).toEqual(new Date("2026-10-16T12:00:00Z"));
    expect(pauseEndFor("tomorrow", NOW, "America/Los_Angeles")).toEqual(
      new Date("2026-10-16T15:00:00Z"),
    );
    expect(pauseEndFor("indefinite", NOW, ZONE)).toBeNull();
    // Just after midnight it is still the next calendar day's 8 am.
    expect(pauseEndFor("tomorrow", new Date("2026-10-15T04:30:00Z"), ZONE)).toEqual(
      new Date("2026-10-16T12:00:00Z"),
    );
  });

  test("tomorrow 8 am stays 8 am on the clinic's clocks across a daylight-saving change", () => {
    // 4 pm EDT on Saturday 31 October; the clocks go back overnight.
    expect(pauseEndFor("tomorrow", new Date("2026-10-31T20:00:00Z"), ZONE)).toEqual(
      new Date("2026-11-01T13:00:00Z"),
    );
  });

  test("a pause emails the clinic only when it runs past an hour, or has no end", () => {
    expect(pauseEmailsClinic(NOW, pauseEndFor("hour", NOW, ZONE))).toBe(false);
    expect(pauseEmailsClinic(NOW, pauseEndFor("tomorrow", NOW, ZONE))).toBe(true);
    expect(pauseEmailsClinic(NOW, null)).toBe(true);
    // Late in the evening "tomorrow 8 am" is still well past an hour.
    const late = new Date("2026-10-16T03:59:00Z");
    expect(pauseEmailsClinic(late, pauseEndFor("tomorrow", late, ZONE))).toBe(true);
  });

  test("each channel's line says what it really does while AYA is off", () => {
    expect(fallbackLine("voice", LINE)).toBe(
      "Phone: calls go to your direct line ((415) 555-0123)",
    );
    expect(fallbackLine("web", LINE)).toBe("Website chat: shows a contact form");
    expect(fallbackLine("meta", LINE)).toBe(
      "Instagram, Messenger & WhatsApp: messages wait for your team in the apps",
    );
    expect(fallbackLine("meta", null, "instagram")).toBe(
      "Instagram: messages wait for your team in Instagram",
    );
    // Never a transfer promised to no number.
    expect(fallbackLine("voice", null)).not.toContain("direct line (");
  });

  test("the banner names the device, and the times on the clinic's clock", () => {
    expect(
      pauseBanner(
        { pausedAt: at(-46 * MINUTE), byLabel: DEVICE, until: at(14 * MINUTE) },
        ZONE,
        NOW,
      ),
    ).toBe("Paused from Front desk Mac at 10:14 am, until 11:14 am.");
    expect(
      pauseBanner(
        { pausedAt: at(-46 * MINUTE), byLabel: DEVICE, until: pauseEndFor("tomorrow", NOW, ZONE) },
        ZONE,
        NOW,
      ),
    ).toBe("Paused from Front desk Mac at 10:14 am, until 8 am tomorrow.");
    expect(
      pauseBanner(
        { pausedAt: at(-26 * HOUR), byLabel: "healdesk support", until: null },
        ZONE,
        NOW,
      ),
    ).toBe("Paused from healdesk support at 9 am yesterday, until someone turns AYA back on.");
  });
});

// -----------------------------------------------------------------------------
// Against the database
// -----------------------------------------------------------------------------

const APP_SECRET = "meta-app-secret-for-pause-tests";
const WINDOW_START = new Date("2026-10-01T00:00:00Z");
const SAVED_ENV: Record<string, string | undefined> = {};

type Sent = { to: string; message: OutgoingEmail };
function capture(): EmailTransport & { sent: Sent[] } {
  const sent: Sent[] = [];
  return {
    name: "capture",
    sent,
    async send(recipient, message): Promise<DeliveryResult> {
      sent.push({ to: recipient.to, message });
      return { status: "sent", messageId: `msg-${sent.length}` };
    },
  } as EmailTransport & { sent: Sent[] };
}

describeDb("pause control", () => {
  const asked: string[] = [];
  const metaSent: Parameters<MetaSender>[0][] = [];
  const sender: MetaSender = async (input) => {
    metaSent.push(input);
  };
  const metaResponder: FrontDoorResponder = async (_system, text) => {
    asked.push(text);
    return "We're open weekdays 9 to 5; call the practice to book.";
  };
  const responder: AssistantResponder = async ({ messages }) => {
    asked.push(messages[messages.length - 1]!.content);
    return JSON.stringify({ reply: "Happy to help." });
  };

  beforeAll(async () => {
    await runMigrations();
    await truncateAll();
    for (const key of ["BETTER_AUTH_URL", "META_APP_SECRET"]) SAVED_ENV[key] = process.env[key];
    process.env.BETTER_AUTH_URL = "https://app.healdesk.test";
    process.env.META_APP_SECRET = APP_SECRET;
  }, 180_000);

  afterEach(() => {
    asked.length = 0;
    metaSent.length = 0;
    __setMetaRuntimeForTests(undefined, undefined);
  });

  afterAll(async () => {
    for (const [key, value] of Object.entries(SAVED_ENV)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await closePools();
  });

  /**
   * A production clinic on Voice + Meta Chat, its plan started, with phone,
   * website chat and Messenger live, and a direct line: every entry point
   * answers until something stops it.
   */
  async function liveClinic(label: string, live: Channel[] = ["voice", "web", "meta"]) {
    const c = await seedClinic(label);
    const pageId = String(310_000_000_000_000 + Math.floor(Math.random() * 1_000_000_000));
    await bindAgreementInEffect(c.clinicId);
    await setWeekdayHours(c.clinicId);
    await getMigratorPool().query(
      `update clinics set data_classification = 'production', baa_signed_at = now(), went_live_at = now(),
              website = $2 where id = $1`,
      [c.clinicId, `${c.slug}.test`],
    );
    await seedEntitled(c.clinicId, {
      planStartedAt: WINDOW_START,
      channelRows: (["voice", "web", "meta"] as const).map((ch) => ({
        channel: ch,
        liveAt: live.includes(ch) ? WINDOW_START : null,
        readyAt: WINDOW_START,
      })),
    });
    await withTenant({ clinicId: c.clinicId, actor: ACTOR }, async (tx) => {
      await setPhoneSettings(tx, { publishedPhoneE164: "+14155550199" });
      await updateAgentConfig(tx, {
        greeting: "Hi",
        services: [
          { name: "Consultation", priceFromUsd: 150, priceToUsd: 150, durationMinutes: 30 },
        ],
        escalationPhone: null,
        escalationHours: "Weekdays 9 to 5",
        notes: null,
      });
      await approveAgentConfig(tx, "Dr Chen");
      await attachMetaChannel(tx, {
        platform: "messenger",
        externalId: pageId,
        accessToken: "EAAB-page-token-0123456789",
      });
      await setMetaFrontDoor(tx, true);
      await updateClinicSettings(tx, { directLineE164: LINE }, "test", at(-48 * HOUR));
    });
    return { ...c, pageId };
  }

  const inClinic = <T>(clinicId: string, fn: (tx: TenantTx) => Promise<T>) =>
    withTenant({ clinicId, actor: ACTOR }, fn);

  async function pauseEvents(clinicId: string) {
    return inTenant(clinicId, async (client) => {
      const { rows } = await client.query<{
        kind: string;
        channel: string | null;
        actor: string;
        occurred_at: Date;
        detail: Record<string, unknown>;
      }>(
        `select kind, channel, actor, occurred_at, detail from channel_events
          where kind in ('paused', 'resumed') order by occurred_at, id`,
      );
      return rows;
    });
  }

  async function pauseNotices(clinicId: string) {
    return inTenant(clinicId, async (client) => {
      const { rows } = await client.query<{
        id: string;
        dedupe_key: string;
        payload: Record<string, unknown>;
        send_after: Date;
      }>(
        `select id, dedupe_key, payload, send_after from billing_notices
          where kind = 'ai_paused' order by created_at, dedupe_key`,
      );
      return rows;
    });
  }

  /** What each entry point does at `when`: answer, or the reason it passed through. */
  async function entryPoints(c: { clinicId: string; slug: string; pageId: string }, when: Date) {
    // Website chat: the widget's opening (POST /api/widget/v1/<slug>/start)
    // and a message, both through the gate.
    const clinic = (await webChatClinic(c.slug))!;
    const start = await startWebChat(clinic, when);
    // A widget opened before the pause still holds its token.
    const token = signToken({
      clinicId: c.clinicId,
      conversationId: null,
      sessionId: randomUUID(),
      issuedAt: when.getTime(),
    });
    const message = await sendWebChatMessage(clinic, token, "Do you have anything on Friday?", {
      responder,
      now: when,
    });
    // Phone: the Retell custom-LLM session's opening.
    const said: RetellOutbound[] = [];
    const session = new RetellCallSession(c.clinicId, `call_${randomUUID()}`, (m) => said.push(m), {
      responder,
      now: () => when,
    });
    await session.open();
    const first = said.find((m) => m.response_type === "response") as
      Extract<RetellOutbound, { response_type: "response" }> | undefined;
    // Meta: a Messenger message through the webhook.
    __setMetaRuntimeForTests(metaResponder, sender, undefined, when);
    const raw = JSON.stringify({
      object: "page",
      entry: [
        {
          id: c.pageId,
          messaging: [
            {
              sender: { id: `psid-${randomUUID().slice(0, 8)}` },
              recipient: { id: c.pageId },
              timestamp: when.getTime() - MINUTE,
              message: { mid: `m-${randomUUID()}`, text: "are you open saturday?" },
            },
          ],
        },
      ],
    });
    const meta = (await (
      await metaPost(
        new Request("http://app.test/api/webhooks/meta", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-hub-signature-256": signMetaBody(raw, APP_SECRET),
          },
          body: raw,
        }),
      )
    ).json()) as { answered: number; skipped: number };
    return {
      webStart: start.mode === "chat" ? "answer" : start.reason,
      webMessage:
        message.mode === "contact_form" || message.mode === "invalid" ? message.reason : "answer",
      voice: first,
      metaAnswered: meta.answered,
      voiceGate: await voiceAnswerDecision(c.clinicId, when),
    };
  }

  test("paused, every channel's entry point passes through: phone to the direct line, website chat to its contact form, Meta unanswered; switched back on, all answer, with one resumed row", async () => {
    const c = await liveClinic("pause-effect");
    const answering = await entryPoints(c, NOW);
    expect(answering).toMatchObject({ webStart: "answer", webMessage: "answer", metaAnswered: 1 });
    expect(answering.voice?.content).not.toBe(TRANSFER_LINE);
    asked.length = 0;

    await inClinic(c.clinicId, (tx) =>
      pauseAya(tx, { choice: "indefinite", actorLabel: DEVICE, now: at(-10 * MINUTE) }),
    );
    const paused = await entryPoints(c, NOW);
    expect(paused.webStart).toBe("ai_paused");
    expect(paused.webMessage).toBe("ai_paused");
    expect(paused.voiceGate).toEqual({
      decision: "pass_through",
      reason: "ai_paused",
      fallback: "direct_line",
      directLine: LINE,
    });
    expect(paused.voice).toMatchObject({ content: TRANSFER_LINE, transfer_number: LINE });
    expect(paused.metaAnswered).toBe(0);
    // Nothing reached the model on any channel.
    expect(asked).toEqual([]);

    await inClinic(c.clinicId, (tx) => resumeAya(tx, { actorLabel: DEVICE, now: at(-MINUTE) }));
    const back = await entryPoints(c, NOW);
    expect(back).toMatchObject({ webStart: "answer", webMessage: "answer", metaAnswered: 1 });
    expect(back.voiceGate).toEqual({ decision: "answer" });

    // Switching on twice, and the sweep, write nothing more.
    await inClinic(c.clinicId, (tx) => resumeAya(tx, { actorLabel: DEVICE, now: NOW }));
    await sweepEndedPauses(at(HOUR));
    expect(await pauseEvents(c.clinicId)).toEqual([
      {
        kind: "paused",
        channel: null,
        actor: DEVICE,
        occurred_at: at(-10 * MINUTE),
        detail: { endsAt: null },
      },
      {
        kind: "resumed",
        channel: null,
        actor: DEVICE,
        occurred_at: at(-MINUTE),
        detail: { pausedAt: at(-10 * MINUTE).toISOString(), endedBy: "switch" },
      },
    ]);
  });

  test("a pause for an hour ends by itself: AYA answers from its end, the sweep writes one resumed row at that moment, and no email goes", async () => {
    const c = await liveClinic("pause-hour");
    const start = at(-30 * MINUTE);
    const { settings } = await inClinic(c.clinicId, (tx) =>
      pauseAya(tx, { choice: "hour", actorLabel: DEVICE, now: start }),
    );
    expect(settings.aiPausedUntil).toEqual(at(30 * MINUTE));
    expect((await entryPoints(c, NOW)).webStart).toBe("ai_paused");

    const later = at(2 * HOUR);
    const after = await entryPoints(c, later);
    expect(after).toMatchObject({ webStart: "answer", webMessage: "answer", metaAnswered: 1 });
    expect(after.voiceGate).toEqual({ decision: "answer" });

    expect((await sweepEndedPauses(later)).resumed).toBe(1);
    expect((await sweepEndedPauses(at(3 * HOUR))).resumed).toBe(0);
    const events = await pauseEvents(c.clinicId);
    expect(events.map((e) => [e.kind, e.actor, e.occurred_at])).toEqual([
      ["paused", DEVICE, start],
      ["resumed", "system", at(30 * MINUTE)],
    ]);
    expect(events[1]!.detail).toEqual({ pausedAt: start.toISOString(), endedBy: "time" });
    expect(await pauseNotices(c.clinicId)).toEqual([]);
  });

  test("a pause that ended by itself is closed at its end before the next one begins, even without the sweep", async () => {
    const c = await liveClinic("pause-next");
    await inClinic(c.clinicId, (tx) =>
      pauseAya(tx, { choice: "hour", actorLabel: DEVICE, now: at(-3 * HOUR) }),
    );
    await inClinic(c.clinicId, (tx) =>
      pauseAya(tx, { choice: "hour", actorLabel: "Reception iPad", now: NOW }),
    );
    expect((await pauseEvents(c.clinicId)).map((e) => [e.kind, e.actor, e.occurred_at])).toEqual([
      ["paused", DEVICE, at(-3 * HOUR)],
      ["resumed", "system", at(-2 * HOUR)],
      ["paused", "Reception iPad", NOW],
    ]);
  });

  test("until tomorrow 8 am: L15 names the device and the end, once, with no reminder", async () => {
    const c = await liveClinic("pause-tomorrow", ["voice", "web"]);
    await inClinic(c.clinicId, (tx) =>
      pauseAya(tx, { choice: "tomorrow", actorLabel: DEVICE, now: NOW }),
    );
    // Pressed again while paused: nothing new.
    await inClinic(c.clinicId, (tx) =>
      pauseAya(tx, { choice: "tomorrow", actorLabel: DEVICE, now: at(MINUTE) }),
    );
    const notices = await pauseNotices(c.clinicId);
    expect(notices.map((n) => n.dedupe_key)).toEqual([`pause:${NOW.toISOString()}`]);
    expect(notices[0]!.payload).toEqual({
      kind: "pause",
      channels: ["voice", "web"],
      platform: null,
      deviceName: DEVICE,
      pausedAt: NOW.toISOString(),
      endsAt: "2026-10-16T12:00:00.000Z",
      isReminder: false,
      directLineE164: LINE,
      homeUrl: `https://app.healdesk.test/c/${c.slug}`,
      settingsUrl: `https://app.healdesk.test/c/${c.slug}/settings`,
    });
    expect(() => assertPayloadAllowed(notices[0]!.payload, "ai_paused")).not.toThrow();

    // It goes at once, at any hour, and says what it should.
    const transport = capture();
    expect(
      await deliverNotice(c.clinicId, notices[0]!.id, { now: onceDue(at(MINUTE)), transport }),
    ).toBe("sent");
    const email = transport.sent[0]!.message;
    expect(email.subject).toBe("AYA is paused");
    expect(email.text).toContain(
      "AYA was paused from Front desk Mac at 11 am EDT on Thursday 15 October",
    );
    expect(email.text).toContain(
      "She starts answering again by herself at 8 am EDT on Friday 16 October",
    );
    expect(email.text).toContain("Phone: calls go to your direct line ((415) 555-0123)");
    expect(email.text).toContain("Website chat: shows a contact form");
    expect(email.text).not.toContain("Instagram");
  });

  test("until turned back on: L15 now and a reminder a day in, closed unsent if AYA is back on by then", async () => {
    const c = await liveClinic("pause-indefinite");
    await inClinic(c.clinicId, (tx) =>
      pauseAya(tx, { choice: "indefinite", actorLabel: DEVICE, now: NOW }),
    );
    const notices = await pauseNotices(c.clinicId);
    const key = `pause:${NOW.toISOString()}`;
    expect(notices.map((n) => n.dedupe_key)).toEqual([key, `${key}:24h`]);
    const reminder = notices[1]!;
    expect(reminder.send_after).toEqual(at(PAUSE_REMINDER_MS));
    expect(reminder.payload).toMatchObject({
      isReminder: true,
      endsAt: null,
      channels: ["voice", "web", "meta"],
    });

    const transport = capture();
    expect(await deliverNotice(c.clinicId, reminder.id, { now: at(HOUR), transport })).toBe(
      "not_due",
    );
    // Still paused a day in: it goes.
    expect(
      await deliverNotice(c.clinicId, reminder.id, {
        now: at(PAUSE_REMINDER_MS + MINUTE),
        transport,
      }),
    ).toBe("sent");
    expect(transport.sent[0]!.message.subject).toBe("AYA is still paused");
    const reminderText = transport.sent[0]!.message.text;
    expect(reminderText).toContain("AYA has been paused since 11 am EDT on Thursday 15 October");
    expect(reminderText).toContain("when she was paused from Front desk Mac.");

    // A second pause, switched back on within the day: its reminder is closed unsent.
    await inClinic(c.clinicId, (tx) => resumeAya(tx, { actorLabel: DEVICE, now: at(25 * HOUR) }));
    await inClinic(c.clinicId, (tx) =>
      pauseAya(tx, { choice: "indefinite", actorLabel: DEVICE, now: at(26 * HOUR) }),
    );
    await inClinic(c.clinicId, (tx) => resumeAya(tx, { actorLabel: DEVICE, now: at(27 * HOUR) }));
    const second = (await pauseNotices(c.clinicId)).find(
      (n) => n.dedupe_key === `pause:${at(26 * HOUR).toISOString()}:24h`,
    )!;
    expect(await deliverNotice(c.clinicId, second.id, { now: at(51 * HOUR), transport })).toBe(
      "superseded",
    );
    expect(transport.sent).toHaveLength(1);
  });

  test("a reminder is wrong once the pause has an end, or is a different pause", async () => {
    const c = await liveClinic("pause-superseded");
    await inClinic(c.clinicId, (tx) =>
      pauseAya(tx, { choice: "indefinite", actorLabel: DEVICE, now: NOW }),
    );
    const reminder = (await pauseNotices(c.clinicId))[1]!;
    const ask = () =>
      inClinic(c.clinicId, (tx) => supersededReason(tx, "ai_paused", reminder.payload));
    expect(await ask()).toBeNull();
    // The first email is never superseded: it is about what already happened.
    const first = (await pauseNotices(c.clinicId))[0]!;
    expect(await inClinic(c.clinicId, (tx) => pauseEmailSuperseded(tx, first.payload))).toBeNull();
    // Given an end (as the console can): the reminder no longer applies.
    await inClinic(c.clinicId, (tx) =>
      pauseAya(tx, { choice: "tomorrow", actorLabel: DEVICE, now: at(MINUTE) }),
    );
    expect(await ask()).toMatch(/turned back on|given an end/);
  });

  test("before go-live there is nothing to pause, and the header's action says so", async () => {
    const c = await liveClinic("pause-before", []);
    await expect(
      inClinic(c.clinicId, (tx) => pauseAya(tx, { choice: "hour", actorLabel: DEVICE, now: NOW })),
    ).rejects.toBeInstanceOf(PauseError);
    expect(await pauseEvents(c.clinicId)).toEqual([]);
  });

  test("a live channel switched Off in Settings sends L15 for that channel and its reminder; one not live sends nothing", async () => {
    const c = await liveClinic("pause-channel-off", ["voice", "meta"]);
    const ctx = {
      clinicId: c.clinicId,
      userId: c.staffUserId,
      actorLabel: DEVICE,
      steppedUp: false,
    };

    expect(await saveSetting(ctx, "channel_voice", false, NOW)).toMatchObject({ ok: true });
    expect(await saveSetting(ctx, "channel_web", false, NOW)).toMatchObject({ ok: true });
    expect(await saveSetting(ctx, "channel_messenger", false, at(MINUTE))).toMatchObject({
      ok: true,
    });

    const notices = await pauseNotices(c.clinicId);
    const voiceKey = `off:voice:${NOW.toISOString()}`;
    const metaKey = `off:meta:messenger:${at(MINUTE).toISOString()}`;
    expect(notices.map((n) => n.dedupe_key).sort()).toEqual(
      [voiceKey, `${voiceKey}:24h`, metaKey, `${metaKey}:24h`].sort(),
    );
    const voice = notices.find((n) => n.dedupe_key === voiceKey)!;
    expect(voice.payload).toMatchObject({
      kind: "channel_off",
      channels: ["voice"],
      platform: null,
      deviceName: DEVICE,
      endsAt: null,
      directLineE164: LINE,
    });
    expect(notices.find((n) => n.dedupe_key === metaKey)!.payload).toMatchObject({
      channels: ["meta"],
      platform: "messenger",
    });
    for (const n of notices)
      expect(() => assertPayloadAllowed(n.payload, "ai_paused")).not.toThrow();

    const transport = capture();
    expect(
      await deliverNotice(c.clinicId, voice.id, { now: onceDue(at(2 * MINUTE)), transport }),
    ).toBe("sent");
    expect(transport.sent[0]!.message.subject).toBe("AYA is paused on your phone");
    expect(transport.sent[0]!.message.text).toContain(
      "Phone was switched off in Settings from Front desk Mac at 11 am EDT on Thursday 15 October",
    );

    // Phone back on and off again: the first reminder is wrong, the second stands.
    expect(await saveSetting(ctx, "channel_voice", true, at(HOUR))).toMatchObject({ ok: true });
    expect(await saveSetting(ctx, "channel_voice", false, at(2 * HOUR))).toMatchObject({
      ok: true,
    });
    const reminders = (await pauseNotices(c.clinicId)).filter((n) =>
      n.dedupe_key.startsWith("off:voice"),
    );
    const firstReminder = reminders.find((n) => n.dedupe_key === `${voiceKey}:24h`)!;
    const secondReminder = reminders.find(
      (n) => n.dedupe_key === `off:voice:${at(2 * HOUR).toISOString()}:24h`,
    )!;
    const reason = (payload: unknown) =>
      inClinic(c.clinicId, (tx) => pauseEmailSuperseded(tx, payload));
    expect(await reason(firstReminder.payload)).toMatch(/switched back on/);
    expect(await reason(secondReminder.payload)).toBeNull();
    // Messenger still off: its reminder stands; back on, it does not.
    const metaReminder = (await pauseNotices(c.clinicId)).find(
      (n) => n.dedupe_key === `${metaKey}:24h`,
    )!;
    expect(await reason(metaReminder.payload)).toBeNull();
    expect(await saveSetting(ctx, "channel_messenger", true, at(3 * HOUR))).toMatchObject({
      ok: true,
    });
    expect(await reason(metaReminder.payload)).toMatch(/switched back on/);

    // Website chat had not gone live: switching it off emailed nothing.
    expect((await pauseNotices(c.clinicId)).some((n) => n.dedupe_key.startsWith("off:web"))).toBe(
      false,
    );
    expect(
      await inClinic(c.clinicId, (tx) =>
        noteChannelSwitchedOff(tx, { channel: "web", actorLabel: DEVICE, now: NOW }),
      ),
    ).toBe(false);
  });

  test("a pause from the console is recorded and emailed as one from the header, naming healdesk support", async () => {
    const c = await liveClinic("pause-console", ["web"]);
    const operator = {
      email: "ops@healdesk.test",
      request: { requestId: randomUUID(), ipAddress: "127.0.0.1", userAgent: "vitest" },
    };
    expect(
      await opSetClinicSettings({ clinicId: c.clinicId, aiPaused: true }, operator),
    ).toMatchObject({
      status: 200,
      body: { data: { changed: true } },
    });
    const events = await pauseEvents(c.clinicId);
    expect(events.map((e) => [e.kind, e.actor])).toEqual([["paused", "healdesk support"]]);
    const notices = await pauseNotices(c.clinicId);
    expect(notices).toHaveLength(2);
    expect(notices[0]!.payload).toMatchObject({ deviceName: "healdesk support", endsAt: null });

    expect(
      await opSetClinicSettings({ clinicId: c.clinicId, aiPaused: false }, operator),
    ).toMatchObject({
      status: 200,
      body: { data: { changed: true } },
    });
    expect((await pauseEvents(c.clinicId)).map((e) => [e.kind, e.actor])).toEqual([
      ["paused", "healdesk support"],
      ["resumed", "healdesk support"],
    ]);
  });
});
