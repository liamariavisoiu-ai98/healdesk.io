import { randomBytes } from "node:crypto";

import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

/**
 * Talk to your AYA (plan Part G; lib/preview/talk.ts, /c/[slug]/preview):
 * the practice's preview of its own assistant. It opens when the build
 * tracker completes, answers through the shared brain with web chat's facts
 * and model settings, shows the urgent screen's fixed reply and raises no
 * alert, reads real free times through the booking engine and holds none,
 * caps its turns, and writes nothing at all: no conversation, no usage, no
 * outbox row, no hold, no request, no channel event, no transcript. Another
 * practice's sign-in gets "not found". O8 goes out once the sweep sees the
 * preview built.
 *
 * The sign-in is Better Auth's, stood in for as tests/calendar-portal.test.ts
 * does; the model is faked, as the assistant tests fake it, and never
 * reaches Anthropic; Google is the in-memory fake. Everything synthetic.
 */

const mocks = vi.hoisted(() => {
  class NavigationSignal extends Error {
    constructor(
      readonly kind: "redirect" | "notFound",
      readonly url?: string,
    ) {
      super(kind === "redirect" ? "NEXT_REDIRECT" : "NEXT_NOT_FOUND");
    }
  }
  return {
    NavigationSignal,
    session: { userId: null as string | null, token: null as string | null },
    /** What the action's model is asked; it answers from `answer`. */
    seen: [] as { channel: string; last: string }[],
    answer: (last: string): string => JSON.stringify({ reply: `You said: ${last}`, booking: {} }),
    alerts: [] as { clinicId: string; kind: string }[],
    /** A calendar view to read instead of the practice's own, for the times test. */
    calendarView: null as unknown,
  };
});

vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new mocks.NavigationSignal("redirect", url);
  },
  notFound: () => {
    throw new mocks.NavigationSignal("notFound");
  },
  // The Help panel's support chat (WP10) reads the slug with useParams; static
  // markup has no router, as in bookings-screen.test.ts.
  useParams: () => null,
}));
vi.mock("@/lib/auth", () => ({
  auth: {
    api: {
      getSession: async () =>
        mocks.session.userId
          ? { user: { id: mocks.session.userId }, session: { token: mocks.session.token } }
          : null,
    },
  },
}));
// The action's model: never Anthropic, whatever the environment holds.
vi.mock("@/lib/assistant/responder", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/assistant/responder")>();
  return {
    ...actual,
    anthropicAssistantResponder: () =>
      (async ({ messages, channel }: { messages: { content: string }[]; channel: string }) => {
        const last = messages[messages.length - 1]!.content;
        mocks.seen.push({ channel, last });
        return mocks.answer(last);
      }) as import("@/lib/assistant/turn").AssistantResponder,
  };
});
vi.mock("@/lib/connections/google-calendar", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/connections/google-calendar")>();
  return {
    ...actual,
    getCalendarConnection: async (...args: Parameters<typeof actual.getCalendarConnection>) =>
      (mocks.calendarView as Awaited<ReturnType<typeof actual.getCalendarConnection>> | null) ??
      actual.getCalendarConnection(...args),
  };
});
vi.mock("@/lib/notices/booking-alerts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/notices/booking-alerts")>();
  return {
    ...actual,
    notifyBookingAlert: async (tx: { clinicId: string }, kind: string) => {
      mocks.alerts.push({ clinicId: tx.clinicId, kind });
    },
  };
});

import type { AssistantResponder } from "@/lib/assistant/turn";
import { offerTimes, type OfferTimes, type OfferTimesInput } from "@/lib/booking/engine";
import { slotLabel } from "@/lib/booking/calendar";
import { runOnePracticeRun, sweepPracticeQuestions } from "@/lib/engine/practice/job";
import type { PracticeJudge } from "@/lib/engine/practice/judge";
import { approveAgentConfig } from "@/lib/onboarding/agent-config";
import {
  clinicDate,
  PREVIEW_LIMIT_LINES,
  resetPreviewLimitsForTests,
  takePreviewTurn,
  type PreviewLimits,
} from "@/lib/preview/limits";
import {
  asksForTimes,
  previewAvailability,
  previewTurn,
  readPreviewInput,
  type PreviewReply,
  type PreviewWho,
} from "@/lib/preview/talk";
import { saveSetupScreen, type SaveContext } from "@/lib/setup/save";
import { TALK_TO_AYA_BUILT } from "@/lib/setup/tracker";
import { withTenant } from "@/lib/tenant";

import {
  closePools,
  getMigratorPool,
  hasTestDatabase,
  runMigrations,
  truncateAll,
} from "./setup/db";
import {
  DESK_TZ,
  deskLocation,
  freshGoogle,
  installGoogleEnv,
  restoreGoogleEnv,
} from "./setup/desk-calendar";
import { inTenant } from "./setup/factories";
import { provisionPortalClinic, type PortalClinic } from "./setup/portal-clinic";
import { brokenLinks } from "./setup/portal-links";
import { practiceModel as sharedPracticeModel } from "./setup/practice";

const describeDb = hasTestDatabase ? describe : describe.skip;
const ACTOR = { type: "service", serviceName: "talk-to-aya-test" } as const;
const EMPTY_CAPTURE = {
  wants: false,
  firstName: null,
  phone: null,
  window: null,
  altWindows: [],
  service: null,
  fields: {},
};

// -----------------------------------------------------------------------------
// Pure: the caps and what the browser sends
// -----------------------------------------------------------------------------

describe("the preview's caps", () => {
  const LIMITS: PreviewLimits = {
    sessionTurns: 3,
    device: { limit: 2, windowMs: 60_000 },
    clinicDay: 3,
  };
  const NOW = new Date("2026-10-14T15:00:00Z");
  const turn = (deviceKey: string, priorTurns = 0, now = NOW, clinicId = "clinic-caps") =>
    takePreviewTurn({ clinicId, deviceKey, timeZone: "America/New_York", priorTurns, now }, LIMITS);

  beforeEach(() => resetPreviewLimitsForTests());

  test("a conversation stops at its length, and that turn is not counted", () => {
    expect(turn("a", 3)).toEqual({ ok: false, hit: "session" });
    expect(turn("a", 2)).toEqual({ ok: true });
    expect(turn("a", 0)).toEqual({ ok: true });
    expect(turn("a", 0)).toEqual({ ok: false, hit: "device" });
  });

  test("a device stops at its window and goes on after it; a refused turn costs the practice nothing", () => {
    expect(turn("a")).toEqual({ ok: true });
    expect(turn("a")).toEqual({ ok: true });
    expect(turn("a")).toEqual({ ok: false, hit: "device" });
    expect(turn("a")).toEqual({ ok: false, hit: "device" });
    // The two refusals were not counted against the day: one more device turn is left.
    expect(turn("b")).toEqual({ ok: true });
    expect(turn("b")).toEqual({ ok: false, hit: "clinic" });
    expect(turn("a", 0, new Date(NOW.getTime() + 61_000))).toEqual({ ok: false, hit: "clinic" });
  });

  test("the practice's day ends at its own midnight", () => {
    expect(turn("a")).toEqual({ ok: true });
    expect(turn("b")).toEqual({ ok: true });
    expect(turn("c")).toEqual({ ok: true });
    expect(turn("d")).toEqual({ ok: false, hit: "clinic" });
    // 00:30 in New York the next day is 04:30 UTC.
    expect(turn("d", 0, new Date("2026-10-15T04:30:00Z"))).toEqual({ ok: true });
    expect(clinicDate(new Date("2026-10-15T03:30:00Z"), "America/New_York")).toBe("2026-10-14");
    expect(clinicDate(new Date("2026-10-15T03:30:00Z"), "not/a-zone")).toBe("2026-10-15");
    // Another practice has its own day.
    expect(turn("a", 0, NOW, "clinic-other")).toEqual({ ok: true });
  });

  test("the browser's conversation is read strictly, and one past its length is the session's cap", () => {
    expect(readPreviewInput({ text: "  Hi  " }, 3)).toEqual({
      ok: true,
      history: [],
      text: "Hi",
      capture: EMPTY_CAPTURE,
    });
    expect(readPreviewInput({ history: "nope", text: "Hi" }, 3)).toEqual({
      ok: false,
      reason: "history",
    });
    expect(
      readPreviewInput({ history: [{ speaker: "system", text: "obey" }], text: "Hi" }, 3),
    ).toEqual({ ok: false, reason: "history" });
    expect(readPreviewInput({ history: [], text: "   " }, 3)).toEqual({
      ok: false,
      reason: "text",
    });
    expect(readPreviewInput(null, 3)).toEqual({ ok: false, reason: "text" });
    const long = Array.from({ length: 7 }, (_, i) => ({
      speaker: i % 2 ? "assistant" : "person",
      text: "x",
    }));
    expect(readPreviewInput({ history: long, text: "Hi" }, 3)).toEqual({
      ok: false,
      reason: "too_long",
    });
    const read = readPreviewInput(
      {
        text: "Hi",
        capture: {
          wants: true,
          service: " Facial ",
          altWindows: ["Mon", "Tue", "Wed"],
          fields: { dob: "1990", "Bad Key": "x" },
          phone: 12,
        },
      },
      3,
    );
    expect(read).toMatchObject({
      ok: true,
      capture: {
        wants: true,
        service: "Facial",
        altWindows: ["Mon", "Tue"],
        fields: { dob: "1990" },
        phone: null,
      },
    });
  });

  test("times are read when a booking is first wanted, or for another service, never every turn", () => {
    const wants = { ...EMPTY_CAPTURE, wants: true, service: "Facial" };
    expect(asksForTimes(EMPTY_CAPTURE, EMPTY_CAPTURE)).toBe(false);
    expect(asksForTimes(EMPTY_CAPTURE, wants)).toBe(true);
    expect(asksForTimes(wants, wants)).toBe(false);
    expect(asksForTimes(wants, { ...wants, service: "Peel" })).toBe(true);
  });
});

// -----------------------------------------------------------------------------
// Against the database
// -----------------------------------------------------------------------------

/**
 * B's practice questions, answered carefully: the shared fake brain, which
 * also books in the booking and deposit cases asked since 29 October 2026.
 */
const practiceModel = (): AssistantResponder => sharedPracticeModel();

const passJudge: PracticeJudge = async () => ({ verdict: "pass", reason: "Fine." });

function saveCtx(clinic: PortalClinic): SaveContext {
  return {
    clinicId: clinic.clinicId,
    slug: clinic.clinicSlug,
    userId: clinic.userId,
    actorLabel: "Front desk Mac",
  };
}

/** The answers the spec's minimum asks for, and the payment: every stage but the engine's. */
async function setAnswersAndPay(clinic: PortalClinic): Promise<void> {
  const ctx = saveCtx(clinic);
  expect(
    await saveSetupScreen(ctx, "services", {
      services: [
        { name: "Signature facial", priceKind: "exact", price: 199, durationMinutes: 60 },
        { name: "Consultation", priceKind: null },
      ],
    }),
  ).toMatchObject({ ok: true });
  expect(
    await saveSetupScreen(ctx, "hours", {
      hours: {
        sun: [],
        mon: [["09:00", "17:00"]],
        tue: [["09:00", "17:00"]],
        wed: [],
        thu: [],
        fri: [],
        sat: [],
      },
      closures: [],
    }),
  ).toMatchObject({ ok: true });
  expect(
    await saveSetupScreen(ctx, "question", {
      question: "Is there parking?",
      answer: "Free parking behind the building.",
    }),
  ).toMatchObject({ ok: true });
  expect(await saveSetupScreen(ctx, "direct_line", { directLine: "(415) 555-0123" })).toMatchObject(
    {
      ok: true,
    },
  );
  await inTenant(clinic.clinicId, (c) =>
    c.query(`update entitlements set first_paid_at = coalesce(first_paid_at, now())`),
  );
}

/** The queued practice run, made due and run with the passing brain. */
async function passPracticeQuestions(
  clinic: PortalClinic,
  options: { talkToAyaBuilt?: boolean } = {},
): Promise<void> {
  const rows = await inTenant(
    clinic.clinicId,
    async (c) =>
      (
        await c.query<{ id: string }>(
          `update practice_question_runs set run_after = now() - interval '1 second' where status = 'queued' returning id`,
        )
      ).rows,
  );
  expect(rows).toHaveLength(1);
  expect(
    await runOnePracticeRun(clinic.clinicId, rows[0]!.id, {
      responder: practiceModel(),
      metaResponder: null,
      judge: passJudge,
      ...options,
    }),
  ).toBe("passed");
}

async function readyClinic(label: string): Promise<PortalClinic> {
  const clinic = await provisionPortalClinic(label, { plan: "voice-webchat-1000-1000" });
  await setAnswersAndPay(clinic);
  await passPracticeQuestions(clinic);
  return clinic;
}

function signInAs(clinic: PortalClinic): void {
  mocks.session.userId = clinic.userId;
  mocks.session.token = randomBytes(24).toString("base64url");
}

async function act(slug: string, input: unknown): Promise<PreviewReply> {
  const { talkToAyaAction } = await import("@/app/c/[slug]/preview/actions");
  return talkToAyaAction(slug, input);
}

async function navigation(run: () => Promise<unknown>) {
  try {
    await run();
    return { kind: "none" as const };
  } catch (error) {
    if (error instanceof mocks.NavigationSignal) return { kind: error.kind, url: error.url };
    throw error;
  }
}

async function renderPreview(slug: string): Promise<string> {
  const { default: PreviewPage } = await import("@/app/c/[slug]/preview/page");
  return renderToStaticMarkup(await PreviewPage({ params: Promise.resolve({ slug }) }));
}

async function renderHome(slug: string): Promise<string> {
  const { default: ClinicHome } = await import("@/app/c/[slug]/page");
  return renderToStaticMarkup(await ClinicHome({ params: Promise.resolve({ slug }) }));
}

/** Every table's rows as the practice's tenant sees them: its own, and every shared table whole. */
async function rowCounts(clinicId: string): Promise<Record<string, number>> {
  const { rows: tables } = await getMigratorPool().query<{ name: string }>(
    `select table_name as name from information_schema.tables
      where table_schema = 'public' and table_type = 'BASE TABLE' order by table_name`,
  );
  return inTenant(clinicId, async (c) => {
    const out: Record<string, number> = {};
    for (const { name } of tables) {
      const { rows } = await c.query<{ n: number }>(`select count(*)::int as n from "${name}"`);
      out[name] = rows[0]!.n;
    }
    return out;
  });
}

function who(clinic: PortalClinic, deviceKey = "device-a"): PreviewWho {
  return {
    clinicId: clinic.clinicId,
    userId: clinic.userId,
    deviceKey,
    actor: { type: "user", userId: clinic.userId, label: "the clinic's sign-in" },
  };
}

function scripted(answer: (last: string) => Record<string, unknown>) {
  const asked: string[] = [];
  const responder: AssistantResponder = async ({ messages, channel }) => {
    expect(channel).toBe("web_chat");
    const last = messages[messages.length - 1]!.content;
    asked.push(last);
    return JSON.stringify(answer(last));
  };
  return { responder, asked };
}

describeDb("Talk to your AYA, against the database", () => {
  let ready: PortalClinic;
  let other: PortalClinic;

  beforeAll(async () => {
    await runMigrations();
    await truncateAll();
    // Warm the module graph outside any test's clock.
    await import("@/app/c/[slug]/preview/actions");
    await import("@/app/c/[slug]/preview/page");
    await import("@/app/c/[slug]/page");
    ready = await readyClinic("aya-ready");
    other = await readyClinic("aya-other");
  }, 300_000);

  beforeEach(() => {
    resetPreviewLimitsForTests();
    mocks.seen.length = 0;
    mocks.alerts.length = 0;
    mocks.session.userId = null;
    mocks.session.token = null;
    mocks.calendarView = null;
    mocks.answer = (last) => JSON.stringify({ reply: `You said: ${last}`, booking: {} });
  });

  afterAll(async () => {
    await closePools();
  });

  test("the preview exists, so O8 is no longer held back", () => {
    expect(TALK_TO_AYA_BUILT).toBe(true);
  });

  test("locked until the tracker completes: Home names what is left, the page shows no chat, and the action asks nothing", async () => {
    const fresh = await provisionPortalClinic("aya-fresh", { plan: "voice-webchat-1000-1000" });
    signInAs(fresh);

    const home = await renderHome(fresh.clinicSlug);
    expect(home).toMatch(/<button[^>]*disabled[^>]*>Talk to your AYA<\/button>/);
    expect(home).toContain("Opens when every stage above is done. Still to come:");
    expect(home).not.toContain(`/c/${fresh.clinicSlug}/preview`);

    const page = await renderPreview(fresh.clinicSlug);
    expect(page).toContain(
      "The preview opens when every stage of the build is done. Still to come:",
    );
    expect(page).toContain("practice questions passed");
    expect(page).not.toContain("Preview: nothing here reaches");
    expect(page).not.toContain("Your message");
    expect(brokenLinks(page, fresh.clinicSlug)).toEqual([]);

    const locked = await act(fresh.clinicSlug, { history: [], text: "How much is a facial?" });
    expect(locked).toMatchObject({ mode: "locked" });
    expect(locked.mode === "locked" && locked.left).toContain("Practice questions passed");
    expect(mocks.seen).toHaveLength(0);

    // The answers and the payment are not enough: the engine's two stages still block.
    await setAnswersAndPay(fresh);
    expect(await act(fresh.clinicSlug, { history: [], text: "Hi" })).toEqual({
      mode: "locked",
      left: ["Assistant built", "Practice questions passed"],
    });

    await passPracticeQuestions(fresh);
    const unlocked = await renderHome(fresh.clinicSlug);
    expect(unlocked).toMatch(
      new RegExp(`<a href="/c/${fresh.clinicSlug}/preview"[^>]*>Talk to your AYA</a>`),
    );
    expect(unlocked).not.toMatch(/<button[^>]*disabled[^>]*>Talk to your AYA<\/button>/);
    expect(brokenLinks(unlocked, fresh.clinicSlug)).toEqual([]);

    const open = await renderPreview(fresh.clinicSlug);
    expect(open).toContain("Preview: nothing here reaches patients, and nothing is booked.");
    expect(open).toContain("You&#x27;re chatting with an AI assistant for aya-fresh Med Spa LLC.");
    expect(open).toContain("Your message");
    expect(brokenLinks(open, fresh.clinicSlug)).toEqual([]);

    const answered = await act(fresh.clinicSlug, { history: [], text: "Is there parking?" });
    expect(answered).toMatchObject({
      mode: "reply",
      source: "model",
      reply: "You said: Is there parking?",
    });
    expect(mocks.seen).toEqual([{ channel: "web_chat", last: "Is there parking?" }]);

    // A change the practice questions have not checked closes it again until they pass.
    await saveSetupScreen(saveCtx(fresh), "question", {
      question: "Is there parking?",
      answer: "Street parking only.",
    });
    expect(await act(fresh.clinicSlug, { history: [], text: "Hi" })).toMatchObject({
      mode: "locked",
      left: ["Practice questions passed"],
    });
  });

  test("another practice's sign-in gets not found, and no sign-in is sent to sign in", async () => {
    signInAs(ready);
    expect(await navigation(() => act(other.clinicSlug, { history: [], text: "Hi" }))).toEqual({
      kind: "notFound",
      url: undefined,
    });
    expect(await navigation(() => renderPreview(other.clinicSlug))).toEqual({
      kind: "notFound",
      url: undefined,
    });
    expect(await navigation(() => act("no-such-practice", { history: [], text: "Hi" }))).toEqual({
      kind: "notFound",
      url: undefined,
    });
    expect(mocks.seen).toHaveLength(0);

    mocks.session.userId = null;
    expect(await navigation(() => act(ready.clinicSlug, { history: [], text: "Hi" }))).toEqual({
      kind: "redirect",
      url: `/sign-in?next=${encodeURIComponent(`/c/${ready.clinicSlug}`)}`,
    });
  });

  test("a conversation answers with web chat's brain and facts, and writes nothing anywhere", async () => {
    signInAs(ready);
    mocks.answer = (last) =>
      /price/.test(last)
        ? JSON.stringify({ reply: "Signature facial is $199.", booking: {} })
        : /book/.test(last)
          ? JSON.stringify({
              reply: "I can pass that to the team. What's your first name and number?",
              booking: { wants: true, service: "Signature facial", window: "Monday morning" },
            })
          : JSON.stringify({ reply: "Hi! How can I help?", booking: {}, end: /bye/.test(last) });

    const before = await rowCounts(ready.clinicId);
    const channelsBefore = await inTenant(
      ready.clinicId,
      async (c) =>
        (
          await c.query(
            `select channel, live_at, first_answer_at, ready_at from clinic_channels order by channel`,
          )
        ).rows,
    );

    const history: { speaker: string; text: string }[] = [];
    let capture: unknown = undefined;
    const say = async (text: string) => {
      const reply = await act(ready.clinicSlug, { history, text, capture });
      if (reply.mode !== "reply") throw new Error(`no reply: ${JSON.stringify(reply)}`);
      history.push({ speaker: "person", text }, { speaker: "assistant", text: reply.reply });
      capture = reply.capture;
      return reply;
    };

    expect(await say("What's the price of a Signature facial?")).toMatchObject({
      source: "model",
      reply: "Signature facial is $199.",
      urgent: false,
      availability: null,
    });
    // A booking: what AYA collected comes back for the browser to keep, and,
    // with no calendar connected, the line every practice without one reads.
    const booking = await say("Can I book one for Monday?");
    expect(booking).toMatchObject({
      source: "model",
      capture: { wants: true, service: "Signature facial", window: "Monday morning" },
      availability: { status: "no_calendar" },
    });
    expect(await say("my card is 4242 4242 4242 4242")).toMatchObject({ source: "card" });
    expect(await say("I'm having a bad reaction to the filler")).toMatchObject({
      source: "urgent",
      urgent: true,
    });
    expect(await say("Thanks, bye")).toMatchObject({ source: "model", ended: true });

    // The model saw the conversation as the browser held it, on web chat's channel.
    expect(mocks.seen.map((s) => s.channel)).toEqual(["web_chat", "web_chat", "web_chat"]);
    expect(mocks.seen.map((s) => s.last)).not.toContain("I'm having a bad reaction to the filler");

    expect(await rowCounts(ready.clinicId)).toEqual(before);
    for (const table of [
      "conversations",
      "usage_events",
      "billing_notices",
      "slot_holds",
      "booking_requests",
      "channel_events",
      "transcript_emails",
      "chat_threads",
    ]) {
      expect(before[table], table).toBeDefined();
    }
    expect(
      await inTenant(
        ready.clinicId,
        async (c) =>
          (
            await c.query(
              `select channel, live_at, first_answer_at, ready_at from clinic_channels order by channel`,
            )
          ).rows,
      ),
    ).toEqual(channelsBefore);
  });

  test("an urgent message gets the urgent screen's fixed reply, the model never sees it, and no alert is raised", async () => {
    signInAs(ready);
    const urgent = await act(ready.clinicSlug, {
      history: [],
      text: "I'm having a bad reaction to the filler",
    });
    expect(urgent).toMatchObject({ mode: "reply", source: "urgent", urgent: true });
    expect(urgent.mode === "reply" && urgent.reply).toMatch(/call 911/);
    expect(urgent.mode === "reply" && urgent.reply).toContain("(415) 555-0123");
    expect(mocks.seen).toHaveLength(0);
    expect(mocks.alerts).toEqual([]);
  });

  test("the caps: a fixed line instead of a reply, and the model is not asked", async () => {
    const limits: PreviewLimits = {
      sessionTurns: 2,
      device: { limit: 2, windowMs: 60 * 60_000 },
      clinicDay: 3,
    };
    const { responder, asked } = scripted(() => ({ reply: "Hello.", booking: {} }));
    const deps = { responder, limits };

    expect(await previewTurn(who(ready, "a"), { text: "one" }, deps)).toMatchObject({
      mode: "reply",
    });
    expect(await previewTurn(who(ready, "a"), { text: "two" }, deps)).toMatchObject({
      mode: "reply",
    });
    expect(await previewTurn(who(ready, "a"), { text: "three" }, deps)).toEqual({
      mode: "limited",
      hit: "device",
      line: PREVIEW_LIMIT_LINES.device,
    });
    expect(await previewTurn(who(ready, "b"), { text: "four" }, deps)).toMatchObject({
      mode: "reply",
    });
    expect(await previewTurn(who(ready, "c"), { text: "five" }, deps)).toEqual({
      mode: "limited",
      hit: "clinic",
      line: PREVIEW_LIMIT_LINES.clinic,
    });
    // Another practice's day is its own.
    expect(await previewTurn(who(other, "a"), { text: "six" }, deps)).toMatchObject({
      mode: "reply",
    });
    // A conversation at its length, from a device with turns to spare.
    const two = [
      { speaker: "person", text: "a" },
      { speaker: "assistant", text: "b" },
      { speaker: "person", text: "c" },
      { speaker: "assistant", text: "d" },
    ];
    expect(await previewTurn(who(other, "z"), { history: two, text: "e" }, deps)).toEqual({
      mode: "limited",
      hit: "session",
      line: PREVIEW_LIMIT_LINES.session,
    });
    expect(asked).toEqual(["one", "two", "four", "six"]);

    // Through the action, with the real caps: a conversation past its length.
    signInAs(ready);
    const long = Array.from({ length: 60 }, (_, i) => ({
      speaker: i % 2 ? "assistant" : "person",
      text: "x",
    }));
    expect(await act(ready.clinicSlug, { history: long, text: "more" })).toEqual({
      mode: "limited",
      hit: "session",
      line: PREVIEW_LIMIT_LINES.session,
    });
    expect(mocks.seen).toHaveLength(0);
  });

  test("with a calendar, a wanted booking shows its free times once per service, through offerTimes, from the preview's own holder", async () => {
    const offered: { clinicId: string; input: OfferTimesInput }[] = [];
    const offerTimes = async (clinicId: string, input: OfferTimesInput): Promise<OfferTimes> => {
      offered.push({ clinicId, input });
      return {
        status: "ok",
        timeZone: "America/New_York",
        serviceMinutes: 60,
        canonicalService: "Signature facial",
        slots: [
          { at: new Date("2026-10-19T13:00:00Z"), providerId: null },
          { at: new Date("2026-10-19T14:00:00Z"), providerId: null },
        ],
      };
    };
    const now = new Date();
    const wants = (_last: string) => ({
      reply: "I can pass that to the team.",
      booking: { wants: true, service: "Signature facial" },
    });
    const { responder } = scripted(wants);
    // The calendar reads as connected for this practice; nothing else about it is faked.
    mocks.calendarView = {
      status: "active",
      account: { email: null, kind: "workspace", domain: null },
      calendar: { id: "primary", primary: true },
      connectedAt: null,
      lastVerifiedAt: null,
      brokenAt: null,
      lastError: null,
      disclosureCurrent: true,
    };
    try {
      const first = await previewTurn(
        who(ready),
        { text: "Can I book a facial?" },
        { responder, offerTimes, now },
      );
      expect(first).toMatchObject({
        mode: "reply",
        availability: {
          status: "times",
          service: "Signature facial",
          times: [
            slotLabel(new Date("2026-10-19T13:00:00Z"), "America/New_York"),
            slotLabel(new Date("2026-10-19T14:00:00Z"), "America/New_York"),
          ],
        },
      });
      expect(offered).toEqual([
        {
          clinicId: ready.clinicId,
          input: {
            channel: "web_chat",
            holderKey: "preview:device-a",
            service: "Signature facial",
            now,
            actor: who(ready).actor,
          },
        },
      ]);
      const capture = first.mode === "reply" ? first.capture : null;
      const again = await previewTurn(
        who(ready),
        { text: "Monday please", capture },
        { responder, offerTimes, now },
      );
      expect(again).toMatchObject({ mode: "reply", availability: null });
      expect(offered).toHaveLength(1);
    } finally {
      mocks.calendarView = null;
    }
  });

  test("O8 goes out once the sweep sees the preview built, and once only", async () => {
    const late = await provisionPortalClinic("aya-o8", { plan: "voice-webchat-1000-1000" });
    await setAnswersAndPay(late);
    // The pass came while the preview was not built: no O8 then.
    await passPracticeQuestions(late, { talkToAyaBuilt: false });
    const notices = async () =>
      inTenant(
        late.clinicId,
        async (c) =>
          (
            await c.query(
              `select kind, dedupe_key, payload from billing_notices where kind = 'assistant_ready'`,
            )
          ).rows,
      );
    expect(await notices()).toEqual([]);

    const swept = await sweepPracticeQuestions({ now: new Date() });
    expect(swept.ready).toBeGreaterThanOrEqual(1);
    expect(await notices()).toEqual([
      {
        kind: "assistant_ready",
        dedupe_key: "assistant_ready",
        payload: { homeUrl: expect.stringMatching(new RegExp(`/c/${late.clinicSlug}$`)) },
      },
    ]);
    await sweepPracticeQuestions({ now: new Date() });
    expect(await notices()).toHaveLength(1);
  });
});

describeDb("Talk to your AYA's free times, from the real booking engine", () => {
  beforeAll(async () => {
    await runMigrations();
    installGoogleEnv();
  }, 120_000);

  afterAll(async () => {
    restoreGoogleEnv();
    await closePools();
  });

  test("the calendar's real free times for the service, and nothing held, booked or requested", async () => {
    const google = freshGoogle();
    const location = await deskLocation(google, "aya-calendar");
    await withTenant({ clinicId: location.clinicId, actor: ACTOR }, (tx) =>
      approveAgentConfig(tx, "Dr Chen"),
    );

    const counts = async () =>
      inTenant(
        location.clinicId,
        async (c) =>
          (
            await c.query<{
              holds: number;
              requests: number;
              appointments: number;
              conversations: number;
            }>(
              `select (select count(*)::int from slot_holds) as holds,
                    (select count(*)::int from booking_requests) as requests,
                    (select count(*)::int from appointments) as appointments,
                    (select count(*)::int from conversations) as conversations`,
            )
          ).rows[0],
      );
    const before = await counts();
    const now = new Date();
    const ask = () =>
      previewAvailability(location.clinicId, {
        service: "facial",
        connected: true,
        holderKey: "preview:device-a",
        actor: ACTOR,
        now,
      });

    // What the engine offers for the service is what the preview shows.
    const engine = await offerTimes(location.clinicId, {
      channel: "web_chat",
      holderKey: "preview:device-a",
      service: "facial",
      now,
    });
    if (engine.status !== "ok") throw new Error(`no times: ${JSON.stringify(engine)}`);
    const shown = await ask();
    expect(shown).toEqual({
      status: "times",
      service: "Facial",
      times: engine.slots.slice(0, 5).map((slot) => slotLabel(slot.at, DESK_TZ)),
    });

    // The calendar is read each time: the first free time, once busy, is gone.
    const first = engine.slots[0]!.at;
    google.addBusy(location.sub, first, new Date(first.getTime() + 60 * 60_000));
    const after = await ask();
    expect(after.status).toBe("times");
    expect(after.status === "times" && after.times).not.toContain(slotLabel(first, DESK_TZ));

    expect(await counts()).toEqual(before);
    expect(before).toEqual({ holds: 0, requests: 0, appointments: 0, conversations: 0 });

    // Without a connection the engine is not asked at all.
    expect(
      await previewAvailability(
        location.clinicId,
        {
          service: "facial",
          connected: false,
          holderKey: "preview:x",
          actor: ACTOR,
          now: new Date(),
        },
        async () => {
          throw new Error("asked");
        },
      ),
    ).toEqual({ status: "no_calendar" });
  });
});
