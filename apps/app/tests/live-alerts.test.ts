import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";

import {
  CHANNELS,
  fixedUrgentReply,
  TREATMENT_NAMES,
  URGENT_TEAM_TOLD_LINE,
  type Channel,
} from "@healdesk/catalog";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

import { GET as health } from "@/app/api/health/route";
import { __setMetaRuntimeForTests, POST as metaWebhook } from "@/app/api/webhooks/meta/route";
import type { AssistantResponder } from "@/lib/assistant/turn";
import {
  readToken,
  sendWebChatMessage,
  startWebChat,
  webChatClinic,
  type WebChatClinic,
} from "@/lib/chat/web-chat";
import { readOpenChat } from "@/lib/conversations/transcript-outbox";
import { CRITICAL_NOTICE_KINDS } from "@/lib/email/kind-rules";
import { NOTICE_KIND_REGISTRY } from "@/lib/email/kinds";
import {
  assertPayloadAllowed,
  copyProblems,
  linkProblems,
  PayloadNotAllowedError,
  visibleText,
} from "@/lib/email/lint";
import { lateCriticalNotices, sendPendingNotices } from "@/lib/email/outbox";
import type { BookingAlertPayload } from "@/lib/email/templates/booking_alert";
import { clinicReason } from "@/lib/email/templates/context";
import { PENDING_TEMPLATES, templateFor } from "@/lib/email/templates/registry";
import type { TemplateContext } from "@/lib/email/templates/types";
import { attachMetaChannel, setMetaFrontDoor, type MetaSender } from "@/lib/meta/channels";
import { createBookingRequest, expireLapsedRequests } from "@/lib/meta/booking-requests";
import { signMetaBody } from "@/lib/meta/webhook";
import {
  ALERT_SECTION,
  dedupeKey,
  notifyBookingAlert,
  queueRequestsStillOpen,
  withoutTeamTold,
  type BookingAlertKind,
} from "@/lib/notices/booking-alerts";
import { approveAgentConfig, updateAgentConfig } from "@/lib/onboarding/agent-config";
import { setPhoneSettings } from "@/lib/onboarding/phone";
import type {
  DeliveryResult,
  DeliveryTarget,
  EmailTransport,
  OutgoingEmail,
} from "@/lib/reporting/deliver";
import { addRecipient } from "@/lib/reporting/recipients";
import { JOB_BILLING_NOTICES, JOB_REQUESTS_STILL_OPEN, setJobEnabled } from "@/lib/scheduler/jobs";
import {
  openedToday,
  queueRequestsStillOpenFor,
  runRequestsStillOpenJob,
} from "@/lib/scheduler/requests-still-open";
import { withTenant } from "@/lib/tenant";
import { RetellCallSession, type RetellOutbound } from "@/lib/voice/retell";
import { COVERAGE_VENDORS } from "@/lib/compliance/vendor-coverage";

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
  queuedNotices,
  seedClinic,
  seedContact,
  seedEntitled,
  setWeekdayHours,
  type SeededClinic,
} from "./setup/factories";
import { attestPlatform } from "./setup/platform";

/**
 * The live alerts (package F; Annex X5's L7-L12, L20 and L34): every one a
 * pointer queued in the outbox in the transaction that makes it true, L12
 * critical and sent in-process after commit, and nothing about the person in
 * any of them. First the templates and their payloads, with no database;
 * then each hook, against the real tables, with a fake mail transport and a
 * fake model. Nothing reaches Resend, Retell, Meta or Anthropic.
 */

const ORIGIN = "https://app.healdesk.test";
const LIVE_KINDS = [
  "booking_request",
  "request_still_open",
  "request_missed",
  "deposit_to_collect",
  "handover",
  "urgent",
  "website_message",
  "calendar_check",
  "ended_early",
] as const satisfies readonly BookingAlertKind[];

/** The only keys a live alert's payload may carry: ids, a channel, a link, a flag and counts. */
const ALERT_KEYS = ["appointmentId", "bookingRequestId", "channel", "conversationId", "portalUrl"];
const KEYS_OF: Record<(typeof LIVE_KINDS)[number], string[]> = {
  booking_request: ALERT_KEYS,
  request_still_open: ["closesAfterDays", "openCount", "portalUrl"],
  request_missed: ALERT_KEYS,
  deposit_to_collect: [...ALERT_KEYS, "isPossiblyPaid"].sort(),
  handover: ALERT_KEYS,
  urgent: ALERT_KEYS,
  website_message: ALERT_KEYS,
  calendar_check: ALERT_KEYS,
  ended_early: ALERT_KEYS,
};

function ctx(audience: "patients" | "clients" = "patients"): TemplateContext {
  return {
    clinicName: "Radiance Med Spa",
    audience,
    reason: clinicReason("Radiance Med Spa"),
    raisedAt: new Date("2026-10-14T14:32:00Z"),
    timeZone: "America/New_York",
  };
}

/** Every shape a kind's payload takes: each channel, and no link. */
function variants(kind: (typeof LIVE_KINDS)[number]): Record<string, unknown>[] {
  const url = `${ORIGIN}/c/radiance-med-spa/bookings`;
  if (kind === "request_still_open") {
    return [1, 3].flatMap((openCount) =>
      [url, null].map((portalUrl) => ({ portalUrl, openCount, closesAfterDays: 7 })),
    );
  }
  const out: Record<string, unknown>[] = [];
  for (const channel of [...CHANNELS, null] as (Channel | null)[]) {
    for (const portalUrl of [url, null]) {
      const base: BookingAlertPayload = {
        portalUrl,
        channel,
        bookingRequestId: randomUUID(),
        appointmentId: kind === "deposit_to_collect" && channel === "voice" ? randomUUID() : null,
        conversationId: channel === "web" ? randomUUID() : null,
      };
      if (kind === "deposit_to_collect") {
        out.push({ ...base, isPossiblyPaid: true }, { ...base, isPossiblyPaid: false });
      } else {
        out.push(base);
      }
    }
  }
  return out;
}

const SAVED: Record<string, string | undefined> = {};

describe("the live alerts' templates", () => {
  beforeEach(() => {
    for (const key of ["BETTER_AUTH_URL", "HEALDESK_APP_URL"]) SAVED[key] = process.env[key];
    process.env.BETTER_AUTH_URL = ORIGIN;
    delete process.env.HEALDESK_APP_URL;
  });
  afterEach(() => {
    for (const [key, value] of Object.entries(SAVED)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  test("every live alert has a template now, and none is pending", () => {
    for (const kind of LIVE_KINDS) {
      expect(templateFor(kind), kind).toBeDefined();
      expect(Object.keys(PENDING_TEMPLATES), kind).not.toContain(kind);
    }
  });

  test("L12 is the one critical live alert, sent at any hour; the rest are normal and any hour too", () => {
    for (const kind of LIVE_KINDS) {
      expect(NOTICE_KIND_REGISTRY[kind].quietHours, kind).toBe("any_hour");
      expect(CRITICAL_NOTICE_KINDS.includes(kind), kind).toBe(kind === "urgent");
    }
  });

  for (const kind of LIVE_KINDS) {
    describe(kind, () => {
      test("every shape of its payload passes the allowlist, carries only its own keys, and renders a pointer", () => {
        for (const payload of variants(kind)) {
          expect(Object.keys(payload).sort()).toEqual(KEYS_OF[kind]);
          expect(() => assertPayloadAllowed(payload, kind)).not.toThrow();
          for (const audience of ["patients", "clients"] as const) {
            const r = templateFor(kind)!.render(payload, ctx(audience));
            // The body above the footer: the footer is compose()'s, and carries
            // our own postal address.
            const body = (text: string) => text.split("\n\n—\n")[0]!.split("<hr")[0]!;
            const seen = [r.subject, r.preheader, body(r.text), visibleText(body(r.html))].join(
              "\n",
            );
            expect(linkProblems(r, kind)).toEqual([]);
            expect(copyProblems(seen)).toEqual([]);
            // No number anyone could call, no time, no id: nothing but the
            // clinic's name, the link and, for L8, a count.
            expect(seen).not.toMatch(/\+?\d[\d\s().-]{6,}\d/);
            expect(seen).not.toMatch(/\b\d{1,2}(:\d{2})?\s?(am|pm)\b/i);
            for (const id of Object.values(payload).filter(
              (v) => typeof v === "string" && /^[0-9a-f-]{36}$/.test(v),
            )) {
              expect(seen).not.toContain(id);
            }
            if (payload.portalUrl) expect(r.text).toContain(String(payload.portalUrl));
            else expect(r.text).toContain("Sign in to healdesk to see it.");
          }
        }
      });

      test("a payload that smuggles anything about the person is refused, naming the field and not its value", () => {
        const base = variants(kind)[0]!;
        const smuggled: [string, unknown][] = [
          ["firstName", "Dana"],
          ["phone", "+14155550192"],
          ["preferredWindow", "Thursday afternoon"],
          ["treatment", TREATMENT_NAMES[0]],
          ["service", "Consultation"],
          ["message", "I have a rash after my peel"],
          ["channel", "Instagram DM from Dana"],
          ["bookingRequestId", "Dana Smith"],
        ];
        for (const [key, value] of smuggled) {
          let caught: unknown;
          try {
            assertPayloadAllowed({ ...base, [key]: value }, kind);
          } catch (error) {
            caught = error;
          }
          expect(caught, key).toBeInstanceOf(PayloadNotAllowedError);
          expect((caught as Error).message).toContain(key);
          expect((caught as Error).message).not.toContain(String(value));
        }
      });
    });
  }

  test("the deposit alert says to check Stripe only when the link may already be paid", () => {
    const [paid, unpaid] = variants("deposit_to_collect");
    const render = templateFor("deposit_to_collect")!.render;
    expect(render(paid!, ctx()).text).toContain(
      "check your Stripe account before asking for the deposit again",
    );
    expect(render(unpaid!, ctx()).text).not.toContain("Stripe");
  });

  test("the urgent alert names the fixed reply a vet's clients hear, and a practice's patients", () => {
    const payload = variants("urgent")[0]!;
    const render = templateFor("urgent")!.render;
    expect(render(payload, ctx("patients")).text).toContain("call 911 in an emergency");
    expect(render(payload, ctx("clients")).text).toContain("emergency referral clinic");
    expect(render(payload, ctx("clients")).text).toContain("no client details");
  });

  test("an urgent alert links Conversations, which marks an urgent call or chat, as does a call that ended early; every other live alert links Bookings", () => {
    const { urgent, ended_early: endedEarly, ...rest } = ALERT_SECTION;
    expect(urgent).toBe("conversations");
    expect(endedEarly).toBe("conversations");
    expect(new Set(Object.values(rest))).toEqual(new Set(["bookings"]));
  });

  test("a reply built as told reads as the untold one once its alert turns out not to be queued", () => {
    for (const channel of ["voice", "web_chat", "meta"] as const) {
      for (const language of ["en", "es"] as const) {
        for (const emergency of ["911", "veterinary"] as const) {
          const input = { channel, language, emergency, clinicName: "Radiance", clinicNumber: "(415) 555-0123" };
          const told = fixedUrgentReply({ ...input, teamAlerted: true });
          const untold = fixedUrgentReply({ ...input, teamAlerted: false });
          const what = `${channel} ${language} ${emergency}`;
          expect(told, what).not.toBe(untold);
          expect(withoutTeamTold(told), what).toBe(untold);
          expect(withoutTeamTold(untold), what).toBe(untold);
        }
      }
    }
    expect(withoutTeamTold("Happy to help.")).toBe("Happy to help.");
  });

  test("the dedupe key: the appointment, then the request, the conversation, the call, else a fresh one", () => {
    const appointmentId = randomUUID();
    const bookingRequestId = randomUUID();
    const conversationId = randomUUID();
    expect(
      dedupeKey("deposit_to_collect", { appointmentId, bookingRequestId, conversationId }),
    ).toBe(`deposit_to_collect:appointment:${appointmentId}`);
    expect(dedupeKey("deposit_to_collect", { appointmentId, mayBePaid: true })).toBe(
      `deposit_to_collect:appointment:${appointmentId}:unchecked`,
    );
    expect(dedupeKey("booking_request", { bookingRequestId, conversationId })).toBe(
      `booking_request:request:${bookingRequestId}`,
    );
    expect(dedupeKey("urgent", { conversationId })).toBe(`urgent:conversation:${conversationId}`);
    expect(dedupeKey("handover", { callId: "call_abc" })).toBe("handover:call:call_abc");
    const a = dedupeKey("urgent", {});
    expect(a).toMatch(/^urgent:event:[0-9a-f-]{36}$/);
    expect(dedupeKey("urgent", {})).not.toBe(a);
  });

  test("notifyDesk and its after-commit twin are gone, and so is sendLiveAlert", async () => {
    const requests = await import("@/lib/meta/booking-requests");
    expect(Object.keys(requests)).not.toContain("notifyDesk");
    expect(Object.keys(requests)).not.toContain("notifyDeskAfterCommit");
    expect(existsSync(join(process.cwd(), "src", "lib", "reporting", "alerts.ts"))).toBe(false);
  });

  test("today's first opening, as an instant, once it has come", () => {
    const hours = {
      sun: [],
      mon: [["09:00", "17:00"]],
      tue: [
        ["13:30", "18:00"],
        ["08:15", "12:00"],
      ],
      wed: [],
      thu: [],
      fri: [],
      sat: [],
    } as const;
    // Monday 12 October 2026 and Tuesday 13 October, in UTC.
    expect(openedToday(hours, new Date("2026-10-12T08:59:00Z"), "UTC")).toBeNull();
    expect(openedToday(hours, new Date("2026-10-12T09:00:30Z"), "UTC")).toEqual(
      new Date("2026-10-12T09:00:00Z"),
    );
    expect(openedToday(hours, new Date("2026-10-12T15:42:10Z"), "UTC")).toEqual(
      new Date("2026-10-12T09:00:00Z"),
    );
    // The day's earliest range, whatever order the ranges are in.
    expect(openedToday(hours, new Date("2026-10-13T08:20:00Z"), "UTC")).toEqual(
      new Date("2026-10-13T08:15:00Z"),
    );
    // In the clinic's own zone: 09:00 in New York is 13:00 UTC in October.
    expect(openedToday(hours, new Date("2026-10-12T13:05:00Z"), "America/New_York")).toEqual(
      new Date("2026-10-12T13:00:00Z"),
    );
    expect(openedToday(hours, new Date("2026-10-14T12:00:00Z"), "UTC")).toBeNull();
  });
});

// -----------------------------------------------------------------------------
// The hooks, against the real tables
// -----------------------------------------------------------------------------

const describeDb = hasTestDatabase ? describe : describe.skip;
const ACTOR = { type: "service", serviceName: "live-alerts-test" } as const;
const DAY = 24 * 60 * 60 * 1000;
const DESK = "desk@live-alerts.test";

class FakeTransport implements EmailTransport {
  readonly name = "fake";
  sent: { target: DeliveryTarget; message: OutgoingEmail }[] = [];
  async send(target: DeliveryTarget, message: OutgoingEmail): Promise<DeliveryResult> {
    this.sent.push({ target, message });
    return { status: "sent", messageId: `msg-${this.sent.length}` };
  }
  /** Everything but transcripts, which go through SES and may carry PHI. */
  notices() {
    return this.sent.filter((s) => s.message.phiClass !== "may-carry-phi");
  }
}

function scripted(answer: (last: string) => Record<string, unknown>): AssistantResponder {
  return async ({ messages }) => JSON.stringify(answer(messages[messages.length - 1]!.content));
}

const URGENT_WORDS = "I'm having a severe reaction to my filler";

describeDb("the live alerts' hooks", () => {
  beforeAll(async () => {
    await runMigrations();
    process.env.BETTER_AUTH_URL = ORIGIN;
    process.env.META_APP_SECRET = "meta-app-secret-for-live-alerts";
  }, 180_000);

  beforeEach(async () => {
    await truncateAll();
    // The vendors' agreements in force, as a launched platform holds them
    // (the answer gate reads them, lib/compliance/vendor-coverage.ts).
    await attestPlatform(COVERAGE_VENDORS);
  });

  afterAll(async () => {
    __setMetaRuntimeForTests(undefined, undefined);
    await closePools();
  });

  /** The notices sender's switch; jobs ship off. */
  async function senderOn(c: SeededClinic, on = true): Promise<void> {
    await setJobEnabled(JOB_BILLING_NOTICES, on, c.staffUserId);
  }

  /** A clinic whose website chat is live, with a report recipient the old path would have mailed. */
  async function webClinic(
    label: string,
  ): Promise<{ seeded: SeededClinic; clinic: WebChatClinic }> {
    const seeded = await seedClinic(label);
    await bindAgreementInEffect(seeded.clinicId);
    await setWeekdayHours(seeded.clinicId);
    const start = new Date("2026-10-01T00:00:00Z");
    await getMigratorPool().query(
      `update clinics set data_classification = 'production', baa_signed_at = now(), went_live_at = now(), website = null where id = $1`,
      [seeded.clinicId],
    );
    await seedEntitled(seeded.clinicId, {
      planId: "webchat-1000",
      planStartedAt: start,
      channelRows: [{ channel: "web", liveAt: start }],
    });
    await withTenant({ clinicId: seeded.clinicId, actor: ACTOR }, async (tx) => {
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
      await addRecipient(tx, { email: DESK, addedBy: "test" });
    });
    const clinic = await webChatClinic(seeded.slug);
    if (!clinic) throw new Error("no clinic");
    return { seeded, clinic };
  }

  test("web chat: an urgent message queues one L12 and it goes in-process, to the clinic's one address, before the reply returns", async () => {
    const { seeded, clinic } = await webClinic("alert-web-urgent");
    await senderOn(seeded);
    const transport = new FakeTransport();
    const start = await startWebChat(clinic);
    if (start.mode !== "chat") throw new Error("no chat");
    const responder = scripted(() => ({ reply: "Happy to help." }));

    const first = await sendWebChatMessage(clinic, start.token, URGENT_WORDS, {
      responder,
      transport,
    });
    if (first.mode !== "chat") throw new Error("no chat");
    expect(first.reply).toMatch(/call (911|9-1-1)/);

    const queued = await queuedNotices(seeded.clinicId);
    expect(queued.map((n) => n.kind)).toEqual(["urgent"]);
    expect(Object.keys(queued[0]!.payload).sort()).toEqual(KEYS_OF.urgent);
    expect(queued[0]!.payload).toMatchObject({
      channel: "web",
      portalUrl: `${ORIGIN}/c/${seeded.slug}/conversations`,
    });
    expect(queued[0]!.dedupe_key).toBe(`urgent:conversation:${queued[0]!.payload.conversationId}`);
    expect(() => assertPayloadAllowed(queued[0]!.payload, "urgent")).not.toThrow();
    // Sent in-process: already sent when sendWebChatMessage returned.
    expect(queued[0]!.sent_at).not.toBeNull();
    expect(transport.notices().map((s) => [s.target.to, s.message.subject])).toEqual([
      [seeded.staffEmail, "URGENT: a complication or urgent symptom was reported"],
    ]);
    expect(transport.notices()[0]!.message.text).not.toMatch(/filler|reaction/);

    // A second urgent message in the same conversation alerts nobody again.
    await sendWebChatMessage(clinic, first.token, URGENT_WORDS, { responder, transport });
    expect((await queuedNotices(seeded.clinicId)).map((n) => n.kind)).toEqual(["urgent"]);
    expect(transport.notices()).toHaveLength(1);
    // The report recipient notifyDesk used to mail never hears of it.
    expect(transport.sent.some((s) => s.target.to === DESK)).toBe(false);
  });

  /** The urgent-alert-not-queued ops alerts raised about a clinic. */
  async function urgentMisses(clinicId: string): Promise<Record<string, unknown>[]> {
    const { rows } = await getMigratorPool().query<{ fields: Record<string, unknown> }>(
      `select fields from ops_alerts where event = 'urgent_alert_not_queued' and fields->>'clinicId' = $1 order by raised_at`,
      [clinicId],
    );
    return rows.map((r) => r.fields);
  }

  /** A database fault on one table, as the app's role meets it, for the length of `fn`. */
  async function refusing<T>(table: string, when: string, fn: () => Promise<T>): Promise<T> {
    const pool = getMigratorPool();
    await pool.query(`
      create or replace function live_alerts_refuse() returns trigger language plpgsql as $$
      begin raise exception 'refused for the test'; end $$`);
    await pool.query(`create trigger live_alerts_refuse before insert on ${table} for each row when (${when}) execute function live_alerts_refuse()`);
    try {
      return await fn();
    } finally {
      await pool.query(`drop trigger if exists live_alerts_refuse on ${table}`);
      await pool.query(`drop function if exists live_alerts_refuse()`);
    }
  }

  test("web chat: with the sender off the alert is still queued, unsent, and the reply never says the team was told", async () => {
    const { seeded, clinic } = await webClinic("alert-web-urgent-off");
    await senderOn(seeded, false);
    const transport = new FakeTransport();
    const start = await startWebChat(clinic);
    if (start.mode !== "chat") throw new Error("no chat");
    const answer = await sendWebChatMessage(clinic, start.token, URGENT_WORDS, {
      responder: scripted(() => ({ reply: "Happy to help." })),
      transport,
    });
    if (answer.mode !== "chat") throw new Error("no chat");
    expect(answer.reply).toMatch(/call (911|9-1-1)/);
    expect(answer.reply).toContain("Otherwise, please call");
    expect(answer.reply).not.toContain(URGENT_TEAM_TOLD_LINE);
    // Queued exactly as before, so it goes the moment the sender is switched on.
    const queued = await queuedNotices(seeded.clinicId);
    expect(queued.map((n) => [n.kind, n.sent_at])).toEqual([["urgent", null]]);
    expect(transport.notices()).toEqual([]);
    await senderOn(seeded);
    await sendPendingNotices({ clinicId: seeded.clinicId, transport });
    expect(transport.notices().map((s) => s.target.to)).toEqual([seeded.staffEmail]);
  });

  test("web chat: an urgent alert that cannot be queued is told to ops, the reply never says the team was told, and the next urgent message tries again", async () => {
    const { seeded, clinic } = await webClinic("alert-web-urgent-miss");
    await senderOn(seeded);
    const transport = new FakeTransport();
    const start = await startWebChat(clinic);
    if (start.mode !== "chat") throw new Error("no chat");
    const responder = scripted(() => ({ reply: "Happy to help." }));

    const first = await refusing("billing_notices", "new.kind = 'urgent'", () =>
      sendWebChatMessage(clinic, start.token, URGENT_WORDS, { responder, transport }),
    );
    if (first.mode !== "chat") throw new Error("no chat");
    const conversationId = readToken(first.token, seeded.clinicId)!.conversationId!;
    // Still 911 and the clinic's number; never a promise that was not kept.
    expect(first.reply).toMatch(/call (911|9-1-1)/);
    expect(first.reply).not.toContain(URGENT_TEAM_TOLD_LINE);
    expect(first.reply).toContain("Leave a number for the clinic to call you.");
    expect(await queuedNotices(seeded.clinicId)).toEqual([]);
    expect(transport.notices()).toEqual([]);
    // Ops hears of it, to phone the clinic: ids and a channel, nothing said.
    await vi.waitFor(async () => expect(await urgentMisses(seeded.clinicId)).toHaveLength(1), { timeout: 10_000 });
    expect(await urgentMisses(seeded.clinicId)).toEqual([
      { clinicId: seeded.clinicId, channel: "web", conversationId },
    ]);
    // The conversation is still marked urgent, and the transcript holds what was said.
    const { rows } = await inTenant(seeded.clinicId, (client) =>
      client.query<{ outcome: string; urgent: boolean }>(`select outcome, urgent from conversations`),
    );
    expect(rows).toEqual([{ outcome: "escalated_to_human", urgent: true }]);
    const open = await withTenant({ clinicId: seeded.clinicId, actor: ACTOR }, (tx) =>
      readOpenChat<{ urgentAlerted: boolean }>(tx, conversationId),
    );
    expect(open!.payload.turns.at(-1)).toEqual({ speaker: "assistant", text: first.reply });
    expect(open!.payload.state.urgentAlerted).toBe(false);

    // The next urgent message, with the outbox taking rows again, alerts the clinic.
    const second = await sendWebChatMessage(clinic, first.token, URGENT_WORDS, { responder, transport });
    if (second.mode !== "chat") throw new Error("no chat");
    expect(second.reply).toContain(URGENT_TEAM_TOLD_LINE);
    expect((await queuedNotices(seeded.clinicId)).map((n) => [n.kind, n.payload.conversationId])).toEqual([
      ["urgent", conversationId],
    ]);
    expect(transport.notices().map((s) => s.message.subject)).toEqual([
      "URGENT: a complication or urgent symptom was reported",
    ]);
    expect(await urgentMisses(seeded.clinicId)).toHaveLength(1);
  });

  test("web chat: an urgent message whose whole transaction fails is told to ops once it has ended", async () => {
    const { seeded, clinic } = await webClinic("alert-web-urgent-rollback");
    await senderOn(seeded);
    const transport = new FakeTransport();
    const start = await startWebChat(clinic);
    if (start.mode !== "chat") throw new Error("no chat");
    const responder = scripted(() => ({ reply: "Happy to help." }));
    const tasks: (() => Promise<void>)[] = [];

    const answer = await refusing("conversations", "true", () =>
      sendWebChatMessage(clinic, start.token, URGENT_WORDS, { responder, transport, after: (task) => tasks.push(task) }),
    );
    if (answer.mode !== "chat") throw new Error("no chat");
    expect(answer.reply).not.toContain(URGENT_TEAM_TOLD_LINE);
    expect(await queuedNotices(seeded.clinicId)).toEqual([]);
    // Handed to the route's after(), so the reply never waits on it.
    expect(tasks).toHaveLength(1);
    expect(await urgentMisses(seeded.clinicId)).toEqual([]);
    await tasks[0]!();
    expect(await urgentMisses(seeded.clinicId)).toEqual([
      { clinicId: seeded.clinicId, channel: "web", conversationId: expect.any(String) },
    ]);
  });

  test("web chat: asking for a person queues one L11 per conversation, sent by the minute queue, and none after an urgent alert", async () => {
    const { seeded, clinic } = await webClinic("alert-web-handover");
    const transport = new FakeTransport();
    const responder = scripted(() => ({
      reply: "I'll pass that on; the team will get back to you within a day.",
      handoff: true,
    }));
    const start = await startWebChat(clinic);
    if (start.mode !== "chat") throw new Error("no chat");
    const first = await sendWebChatMessage(clinic, start.token, "Can I talk to a real person?", {
      responder,
      transport,
    });
    if (first.mode !== "chat") throw new Error("no chat");
    await sendWebChatMessage(clinic, first.token, "A human, please", { responder, transport });

    const queued = await queuedNotices(seeded.clinicId);
    expect(queued.map((n) => [n.kind, n.payload.channel, n.sent_at])).toEqual([
      ["handover", "web", null],
    ]);
    expect(Object.keys(queued[0]!.payload).sort()).toEqual(KEYS_OF.handover);
    // Not critical: nothing went in-process. The minute queue sends it.
    expect(transport.notices()).toEqual([]);
    await senderOn(seeded);
    await sendPendingNotices({ clinicId: seeded.clinicId, transport });
    expect(transport.notices().map((s) => [s.target.to, s.message.subject])).toEqual([
      [seeded.staffEmail, "Someone asked to speak with a person"],
    ]);

    // An urgent conversation that then asks for a person raises the urgent alert only.
    const other = await startWebChat(clinic);
    if (other.mode !== "chat") throw new Error("no chat");
    const urgent = await sendWebChatMessage(clinic, other.token, URGENT_WORDS, {
      responder,
      transport,
    });
    if (urgent.mode !== "chat") throw new Error("no chat");
    await sendWebChatMessage(clinic, urgent.token, "Can I talk to a person?", {
      responder,
      transport,
    });
    expect((await queuedNotices(seeded.clinicId)).map((n) => n.kind)).toEqual([
      "handover",
      "urgent",
    ]);
  });

  test("voice: an urgent caller queues one L12, keyed to the call and sent in-process; a caller asking for a person, one L11", async () => {
    const urgentClinic = await seedClinic("alert-voice-urgent");
    await senderOn(urgentClinic);
    const transport = new FakeTransport();
    const said: RetellOutbound[] = [];
    const run = async (
      clinicId: string,
      callId: string,
      lines: string[],
      responder: AssistantResponder,
    ) => {
      const session = new RetellCallSession(clinicId, callId, (m) => said.push(m), {
        responder,
        transport,
        realCalls: true,
      });
      await session.open();
      await session.handle(
        JSON.stringify({
          interaction_type: "call_details",
          call: { call_id: callId, from_number: "+14155550192", direction: "inbound" },
        }),
      );
      for (const [i, content] of lines.entries()) {
        await session.handle(
          JSON.stringify({
            interaction_type: "response_required",
            response_id: i + 1,
            transcript: [{ role: "user", content }],
          }),
        );
      }
      await session.finish();
    };

    await run(
      urgentClinic.clinicId,
      "call_alert_urgent",
      [URGENT_WORDS, URGENT_WORDS],
      scripted(() => ({ reply: "model" })),
    );
    const urgent = await queuedNotices(urgentClinic.clinicId);
    expect(urgent.map((n) => [n.kind, n.dedupe_key, n.payload.channel])).toEqual([
      ["urgent", "urgent:call:call_alert_urgent", "voice"],
    ]);
    expect(urgent[0]!.sent_at).not.toBeNull();
    expect(transport.notices().map((s) => [s.target.to, s.message.subject])).toEqual([
      [urgentClinic.staffEmail, "URGENT: a complication or urgent symptom was reported"],
    ]);

    const handoverClinic = await seedClinic("alert-voice-handover");
    await run(
      handoverClinic.clinicId,
      "call_alert_person",
      ["Can I speak to someone at the front desk?", "A real person please"],
      scripted(() => ({ reply: "I'll pass that on.", handoff: true })),
    );
    const handover = await queuedNotices(handoverClinic.clinicId);
    expect(handover.map((n) => [n.kind, n.dedupe_key, n.payload.channel])).toEqual([
      ["handover", "handover:call:call_alert_person", "voice"],
    ]);
    expect(Object.keys(handover[0]!.payload).sort()).toEqual(KEYS_OF.handover);
  });

  test("voice: an urgent alert that cannot be queued is told to ops, and the caller never hears the team was told", async () => {
    const c = await seedClinic("alert-voice-urgent-miss");
    await senderOn(c);
    const transport = new FakeTransport();
    const said: RetellOutbound[] = [];
    const session = new RetellCallSession(c.clinicId, "call_alert_miss", (m) => said.push(m), {
      responder: scripted(() => ({ reply: "model" })),
      transport,
      realCalls: true,
    });
    await session.open();
    const opening = String((said.find((m) => m.response_type === "response") as { content?: unknown } | undefined)?.content ?? "");
    await refusing("billing_notices", "new.kind = 'urgent'", () =>
      session.handle(
        JSON.stringify({
          interaction_type: "response_required",
          response_id: 1,
          transcript: [{ role: "agent", content: opening }, { role: "user", content: URGENT_WORDS }],
        }),
      ),
    );
    await session.finish();
    const urgentReply = said
      .filter((m) => m.response_type === "response")
      .map((m) => String((m as { content?: unknown }).content))
      .find((r) => /911/.test(r));
    // Still 911 and the clinic's number; never a promise that was not kept.
    expect(urgentReply).toBeDefined();
    expect(urgentReply).not.toContain(URGENT_TEAM_TOLD_LINE);
    expect(await queuedNotices(c.clinicId)).toEqual([]);
    expect(transport.notices()).toEqual([]);
    // Ops hears of it, to phone the clinic: ids and a channel, nothing said.
    await vi.waitFor(async () => expect(await urgentMisses(c.clinicId)).toHaveLength(1), { timeout: 10_000 });
    expect(await urgentMisses(c.clinicId)).toEqual([
      { clinicId: c.clinicId, channel: "voice", conversationId: null, callId: "call_alert_miss" },
    ]);
  });

  test("Meta: an urgent message queues one L12 per conversation, sent in-process once the answer has committed", async () => {
    const c = await seedClinic("alert-meta-urgent");
    const pageId = "990000000000001";
    await setWeekdayHours(c.clinicId);
    await withTenant({ clinicId: c.clinicId, actor: ACTOR }, async (tx) => {
      await setPhoneSettings(tx, { publishedPhoneE164: "+14155550142" });
      await updateAgentConfig(tx, {
        greeting: "Hi",
        services: [],
        escalationPhone: null,
        escalationHours: null,
        notes: null,
      });
      await approveAgentConfig(tx, "Dr Chen");
      await attachMetaChannel(tx, {
        platform: "messenger",
        externalId: pageId,
        accessToken: "EAAB-messenger-token-0123456789",
      });
      await setMetaFrontDoor(tx, true);
    });
    await senderOn(c);
    const transport = new FakeTransport();
    const sent: Parameters<MetaSender>[0][] = [];
    __setMetaRuntimeForTests(
      async () => "unused",
      async (input) => void sent.push(input),
      transport,
    );
    const post = (text: string) => {
      const raw = JSON.stringify({
        object: "page",
        entry: [
          {
            id: pageId,
            messaging: [
              {
                sender: { id: "user-urgent" },
                recipient: { id: pageId },
                message: { mid: `m-${randomUUID()}`, text },
              },
            ],
          },
        ],
      });
      return metaWebhook(
        new Request("http://app.test/api/webhooks/meta", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-hub-signature-256": signMetaBody(raw, process.env.META_APP_SECRET!),
          },
          body: raw,
        }),
      );
    };
    expect(await (await post(URGENT_WORDS)).json()).toEqual({
      received: true,
      answered: 1,
      skipped: 0,
    });
    await post(URGENT_WORDS);
    const queued = await queuedNotices(c.clinicId);
    expect(queued.map((n) => [n.kind, n.payload.channel])).toEqual([["urgent", "meta"]]);
    expect(queued[0]!.dedupe_key).toMatch(/^urgent:conversation:[0-9a-f-]{36}$/);
    expect(queued[0]!.sent_at).not.toBeNull();
    expect(transport.notices().map((s) => s.target.to)).toEqual([c.staffEmail]);
    expect(transport.notices()[0]!.message.text).toContain(
      "Their message is in your Instagram, Messenger or WhatsApp inbox.",
    );
  });

  /**
   * Main's fix (e097325f) tells ops when the alert's own savepoint fails. On
   * Meta the alert is queued inside the answer's transaction, and the message
   * is claimed before it, so a transaction that failed after queuing took the
   * alert with it, Meta's redelivery was never answered, and nobody heard.
   */
  test("Meta: an urgent message whose answer's transaction fails is told to ops, to phone the clinic", async () => {
    const c = await seedClinic("alert-meta-urgent-rollback");
    const pageId = "990000000000002";
    await setWeekdayHours(c.clinicId);
    await withTenant({ clinicId: c.clinicId, actor: ACTOR }, async (tx) => {
      await setPhoneSettings(tx, { publishedPhoneE164: "+14155550142" });
      await updateAgentConfig(tx, {
        greeting: "Hi",
        services: [],
        escalationPhone: null,
        escalationHours: null,
        notes: null,
      });
      await approveAgentConfig(tx, "Dr Chen");
      await attachMetaChannel(tx, {
        platform: "messenger",
        externalId: pageId,
        accessToken: "EAAB-messenger-token-0123456789",
      });
      await setMetaFrontDoor(tx, true);
    });
    await senderOn(c);
    const transport = new FakeTransport();
    const sent: Parameters<MetaSender>[0][] = [];
    __setMetaRuntimeForTests(
      async () => "unused",
      async (input) => void sent.push(input),
      transport,
    );
    const raw = JSON.stringify({
      object: "page",
      entry: [
        {
          id: pageId,
          messaging: [
            {
              sender: { id: "user-urgent-rollback" },
              recipient: { id: pageId },
              message: { mid: `m-${randomUUID()}`, text: URGENT_WORDS },
            },
          ],
        },
      ],
    });
    // The answer's audit row is written at its commit: refused, the whole
    // transaction rolls back, the queued alert with it.
    const answered = await refusing("audit_log", "new.resource_type = 'meta_front_door_reply'", () =>
      metaWebhook(
        new Request("http://app.test/api/webhooks/meta", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-hub-signature-256": signMetaBody(raw, process.env.META_APP_SECRET!),
          },
          body: raw,
        }),
      ),
    );
    expect(await answered.json()).toMatchObject({ answered: 0, skipped: 1 });
    expect(await queuedNotices(c.clinicId)).toEqual([]);
    expect(sent).toEqual([]);
    expect(await urgentMisses(c.clinicId)).toEqual([
      { clinicId: c.clinicId, channel: "meta", conversationId: null },
    ]);
  });

  test("L9: each request that lapses queues one 'missed' alert, in the transaction that lapses it", async () => {
    const c = await seedClinic("alert-missed");
    const contactId = await seedContact(c.clinicId, "+15550100777");
    const make = () =>
      withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) =>
        createBookingRequest(tx, {
          channel: "voice",
          contactId,
          conversationId: null,
          preferredWindow: "Thursday afternoon",
          treatment: null,
        }),
      );
    const a = await make();
    const b = await make();
    expect(await queuedNotices(c.clinicId)).toEqual([]);

    const later = new Date(Date.now() + 8 * DAY);
    expect((await expireLapsedRequests(later)).expired).toBe(2);
    expect((await expireLapsedRequests(later)).expired).toBe(0);
    const queued = await queuedNotices(c.clinicId);
    expect(queued.map((n) => n.dedupe_key).sort()).toEqual(
      [`request_missed:request:${a.id}`, `request_missed:request:${b.id}`].sort(),
    );
    for (const notice of queued) {
      expect(notice.kind).toBe("request_missed");
      expect(notice.payload).toMatchObject({ channel: "voice" });
      expect(Object.keys(notice.payload).sort()).toEqual(KEYS_OF.request_missed);
    }
  });

  test("L7, L10 and L34 from their callers: the channel read from the request, the deposit's flag, and once per request", async () => {
    const c = await seedClinic("alert-callers");
    const contactId = await seedContact(c.clinicId, "+15550100778");
    const request = await withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) =>
      createBookingRequest(tx, {
        channel: "web_chat",
        contactId,
        conversationId: null,
        preferredWindow: "Friday morning",
        treatment: null,
      }),
    );
    await withTenant({ clinicId: c.clinicId, actor: ACTOR }, async (tx) => {
      await notifyBookingAlert(tx, "booking_request", { bookingRequestId: request.id });
      await notifyBookingAlert(tx, "booking_request", { bookingRequestId: request.id });
      await notifyBookingAlert(tx, "calendar_check", { bookingRequestId: request.id });
      await notifyBookingAlert(tx, "deposit_to_collect", { bookingRequestId: request.id });
      await notifyBookingAlert(tx, "deposit_to_collect", {
        bookingRequestId: request.id,
        mayBePaid: true,
      });
    });
    // One transaction, so one created_at: in kind order.
    const queued = (await queuedNotices(c.clinicId)).sort((x, y) =>
      `${x.kind}${String(x.payload.isPossiblyPaid)}`.localeCompare(
        `${y.kind}${String(y.payload.isPossiblyPaid)}`,
      ),
    );
    expect(
      queued.map((n) => [n.kind, n.payload.channel, n.payload.isPossiblyPaid ?? null]),
    ).toEqual([
      ["booking_request", "web", null],
      ["calendar_check", "web", null],
      ["deposit_to_collect", "web", false],
      ["deposit_to_collect", "web", true],
    ]);
    for (const notice of queued)
      expect(() =>
        assertPayloadAllowed(notice.payload, notice.kind as BookingAlertKind),
      ).not.toThrow();
  });

  test("an alert queued in a transaction that rolls back is never queued, so nothing is sent", async () => {
    const c = await seedClinic("alert-rollback");
    await senderOn(c);
    const transport = new FakeTransport();
    const contactId = await seedContact(c.clinicId, "+15550100780");
    await expect(
      withTenant({ clinicId: c.clinicId, actor: ACTOR }, async (tx) => {
        const request = await createBookingRequest(tx, {
          channel: "voice",
          contactId,
          conversationId: null,
          preferredWindow: "Monday",
          treatment: null,
        });
        await notifyBookingAlert(tx, "booking_request", { bookingRequestId: request.id });
        await notifyBookingAlert(tx, "urgent", { callId: "call_rolled_back", channel: "voice" });
        throw new Error("the caller's work failed after queueing");
      }),
    ).rejects.toThrow("the caller's work failed");
    expect(await queuedNotices(c.clinicId)).toEqual([]);
    await sendPendingNotices({ transport });
    expect(transport.sent).toEqual([]);
  });

  test("every live alert kind is sent to the clinic's one address, and to no report recipient", async () => {
    const c = await seedClinic("alert-every-kind");
    await senderOn(c);
    const transport = new FakeTransport();
    const contactId = await seedContact(c.clinicId, "+15550100781");
    await withTenant({ clinicId: c.clinicId, actor: ACTOR }, async (tx) => {
      await addRecipient(tx, { email: DESK, addedBy: "test" });
      const request = () =>
        createBookingRequest(tx, { channel: "web_chat", contactId, conversationId: null, preferredWindow: "Friday", treatment: null });
      await notifyBookingAlert(tx, "booking_request", { bookingRequestId: (await request()).id });
      await notifyBookingAlert(tx, "request_missed", { bookingRequestId: (await request()).id });
      await notifyBookingAlert(tx, "deposit_to_collect", { bookingRequestId: (await request()).id });
      await notifyBookingAlert(tx, "handover", { callId: "call_every_kind", channel: "voice" });
      await notifyBookingAlert(tx, "urgent", { conversationId: randomUUID(), channel: "web" });
      await notifyBookingAlert(tx, "website_message", { bookingRequestId: (await request()).id });
      await notifyBookingAlert(tx, "calendar_check", { bookingRequestId: (await request()).id });
      await notifyBookingAlert(tx, "ended_early", { conversationId: randomUUID(), channel: "voice" });
      await queueRequestsStillOpen(tx, { localDate: "2026-10-19", openCount: 2, closesAfterDays: 7 });
    });
    const queued = await queuedNotices(c.clinicId);
    expect(queued.map((n) => n.kind).sort()).toEqual(Object.keys(ALERT_SECTION).sort());

    await sendPendingNotices({ transport });
    expect(transport.sent.some((s) => s.target.to === DESK)).toBe(false);
    expect(new Set(transport.notices().map((s) => s.target.to))).toEqual(new Set([c.staffEmail]));
    expect(transport.notices().map((s) => s.message.subject).sort()).toEqual(
      [
        "2 booking requests are still waiting",
        "A booking may not be in your calendar",
        "A booking request is waiting for your team",
        "A call ended unexpectedly",
        "A deposit to collect",
        "A message was left on your website",
        "Missed: they were told you'd call",
        "Someone asked to speak with a person",
        "URGENT: a complication or urgent symptom was reported",
      ].sort(),
    );
    expect((await queuedNotices(c.clinicId)).every((n) => n.sent_at !== null)).toBe(true);
  });

  test("notifyBookingAlert says whether the alert is queued; an urgent one that is not is told to ops, and no other kind is", async () => {
    const c = await seedClinic("alert-result");
    const contactId = await seedContact(c.clinicId, "+15550100782");
    const results = await withTenant({ clinicId: c.clinicId, actor: ACTOR }, async (tx) => {
      const request = await createBookingRequest(tx, {
        channel: "voice",
        contactId,
        conversationId: null,
        preferredWindow: "Monday",
        treatment: null,
      });
      return [
        await notifyBookingAlert(tx, "booking_request", { bookingRequestId: request.id }),
        // Already queued under the same key: still queued.
        await notifyBookingAlert(tx, "booking_request", { bookingRequestId: request.id }),
        await notifyBookingAlert(tx, "urgent", { callId: "call_result", channel: "voice" }),
        // Not a uuid, and no channel given: the read of the conversation fails in the savepoint.
        await notifyBookingAlert(tx, "calendar_check", { bookingRequestId: "not-a-uuid" }),
        await notifyBookingAlert(tx, "urgent", { conversationId: "not-a-uuid" }),
      ];
    });
    expect(results).toEqual([true, true, true, false, false]);
    // One transaction, one created_at: compared as a set.
    expect((await queuedNotices(c.clinicId)).map((n) => n.kind).sort()).toEqual(["booking_request", "urgent"]);
    await vi.waitFor(async () => expect(await urgentMisses(c.clinicId)).toHaveLength(1), { timeout: 10_000 });
    expect(await urgentMisses(c.clinicId)).toEqual([
      { clinicId: c.clinicId, channel: null, conversationId: "not-a-uuid" },
    ]);
  });

  test("an alert that cannot be queued breaks nothing: the caller's transaction still commits", async () => {
    const c = await seedClinic("alert-broken");
    const contactId = await seedContact(c.clinicId, "+15550100779");
    const request = await withTenant({ clinicId: c.clinicId, actor: ACTOR }, async (tx) => {
      // Not a uuid: the alert's read fails inside its savepoint.
      await notifyBookingAlert(tx, "calendar_check", { bookingRequestId: "not-a-uuid" });
      return createBookingRequest(tx, {
        channel: "voice",
        contactId,
        conversationId: null,
        preferredWindow: "Monday",
        treatment: null,
      });
    });
    const rows = await inTenant(c.clinicId, (client) =>
      client.query<{ id: string }>(`select id from booking_requests`),
    );
    expect(rows.rows).toEqual([{ id: request.id }]);
    expect(await queuedNotices(c.clinicId)).toEqual([]);
  });

  describe("L8, at the clinic's opening hour", () => {
    /** The next weekday, at least a day ahead, at `hh:mm` UTC: the clinics here keep UTC hours. */
    function nextWeekdayAt(hhmm: string): Date {
      for (let days = 1; days < 8; days += 1) {
        const d = new Date(Date.now() + days * DAY);
        const weekday = d.getUTCDay();
        if (weekday >= 1 && weekday <= 5) {
          return new Date(`${d.toISOString().slice(0, 10)}T${hhmm}:00Z`);
        }
      }
      throw new Error("no weekday in a week");
    }

    async function stillOpenClinic(label: string, summaryOn: boolean) {
      const c = await seedClinic(label);
      await setWeekdayHours(c.clinicId);
      await getMigratorPool().query(`update clinics set timezone = 'UTC' where id = $1`, [
        c.clinicId,
      ]);
      await inTenant(c.clinicId, (client) =>
        client.query(
          `insert into clinic_settings (clinic_id, daily_summary) values ($1, $2)
           on conflict (clinic_id) do update set daily_summary = excluded.daily_summary`,
          [c.clinicId, summaryOn],
        ),
      );
      const contactId = await seedContact(c.clinicId, "+15550100780");
      const request = () =>
        withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) =>
          createBookingRequest(tx, {
            channel: "voice",
            contactId,
            conversationId: null,
            preferredWindow: "Tuesday",
            treatment: null,
          }),
        );
      return { c, request };
    }

    test("once a day at opening, with the count of requests taken before it, only while the daily summary is off", async () => {
      const { c, request } = await stillOpenClinic("still-open", false);
      const first = await request();
      await request();
      const morning = nextWeekdayAt("08:30");
      const opening = nextWeekdayAt("09:30");

      expect(await queueRequestsStillOpenFor(c.clinicId, morning)).toBe("not_open");
      expect(await queueRequestsStillOpenFor(c.clinicId, opening)).toBe("queued");
      expect(
        await queueRequestsStillOpenFor(c.clinicId, new Date(opening.getTime() + 60 * 60_000)),
      ).toBe("already_queued");
      const queued = await queuedNotices(c.clinicId);
      expect(queued.map((n) => [n.kind, n.dedupe_key])).toEqual([
        ["request_still_open", `request_still_open:${opening.toISOString().slice(0, 10)}`],
      ]);
      expect(queued[0]!.payload).toEqual({
        portalUrl: `${ORIGIN}/c/${c.slug}/bookings`,
        openCount: 2,
        closesAfterDays: 7,
      });
      expect(() => assertPayloadAllowed(queued[0]!.payload, "request_still_open")).not.toThrow();

      // A request the desk has answered is not waiting; the next day counts one.
      await inTenant(c.clinicId, (client) =>
        client.query(
          `update booking_requests set status = 'declined', decided_at = now() where id = $1`,
          [first.id],
        ),
      );
      const tomorrow = new Date(opening.getTime() + DAY);
      if (tomorrow.getUTCDay() >= 1 && tomorrow.getUTCDay() <= 5) {
        expect(await queueRequestsStillOpenFor(c.clinicId, tomorrow)).toBe("queued");
        expect((await queuedNotices(c.clinicId)).at(-1)!.payload.openCount).toBe(1);
      }
    });

    test("nothing while the daily summary is on, on a closed day, or with nothing waiting", async () => {
      const on = await stillOpenClinic("still-open-summary", true);
      await on.request();
      expect(await queueRequestsStillOpenFor(on.c.clinicId, nextWeekdayAt("09:30"))).toBe(
        "summary_on",
      );

      const off = await stillOpenClinic("still-open-closed", false);
      const opening = nextWeekdayAt("09:30");
      expect(await queueRequestsStillOpenFor(off.c.clinicId, opening)).toBe("none_waiting");
      await off.request();
      await inTenant(off.c.clinicId, (client) =>
        client.query(`insert into clinic_closures (clinic_id, closed_on) values ($1, $2)`, [
          off.c.clinicId,
          opening.toISOString().slice(0, 10),
        ]),
      );
      expect(await queueRequestsStillOpenFor(off.c.clinicId, opening)).toBe("not_open");
      // A request taken after today's opening is tomorrow's.
      expect(
        await queueRequestsStillOpenFor(off.c.clinicId, new Date(Date.now() + 60_000)),
      ).not.toBe("queued");
      expect(await queuedNotices(off.c.clinicId)).toEqual([]);
    });

    test("the hourly job runs only behind its switch, and an L8 whose requests were all answered closes unsent", async () => {
      const { c, request } = await stillOpenClinic("still-open-job", false);
      const only = await request();
      const opening = nextWeekdayAt("09:30");
      expect(await runRequestsStillOpenJob({ now: opening })).toEqual({ status: "disabled" });
      expect(await queuedNotices(c.clinicId)).toEqual([]);
      await setJobEnabled(JOB_REQUESTS_STILL_OPEN, true, c.staffUserId);
      expect(await runRequestsStillOpenJob({ now: opening })).toMatchObject({
        status: "ok",
        note: expect.stringMatching(/^1 queued/),
      });

      // The desk answers it before the sender runs: the email is closed, unsent.
      await inTenant(c.clinicId, (client) =>
        client.query(
          `update booking_requests set status = 'declined', decided_at = now() where id = $1`,
          [only.id],
        ),
      );
      await senderOn(c);
      const transport = new FakeTransport();
      await sendPendingNotices({ clinicId: c.clinicId, transport });
      expect(transport.sent).toEqual([]);
      const { rows } = await inTenant(c.clinicId, (client) =>
        client.query<{
          sent_at: Date | null;
          last_error: string | null;
          recipients_count: number | null;
        }>(
          `select sent_at, last_error, recipients_count from billing_notices where kind = 'request_still_open'`,
        ),
      );
      expect(rows).toEqual([
        {
          sent_at: expect.any(Date),
          last_error: "not sent: no booking request is still waiting",
          recipients_count: 0,
        },
      ]);
    });
  });

  test("an urgent alert still unsent ten minutes on turns /api/health red", async () => {
    const c = await seedClinic("alert-health");
    // The sender is off, so the in-process send finds its switch off and the
    // notice waits: the outage /api/health exists to catch.
    await withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) =>
      notifyBookingAlert(tx, "urgent", { callId: "call_late" }),
    );
    expect(await lateCriticalNotices()).toEqual([]);
    await inTenant(c.clinicId, (client) =>
      client.query(
        `update billing_notices set created_at = now() - interval '11 minutes', send_after = now() - interval '11 minutes' where kind = 'urgent'`,
      ),
    );
    expect((await lateCriticalNotices()).map((n) => n.kind)).toEqual(["urgent"]);
    const res = await health(new Request("http://localhost/api/health"));
    expect(res.status).toBe(503);
    expect((await res.json()).reasons).toEqual(["critical_notice_undelivered"]);
  });
});
