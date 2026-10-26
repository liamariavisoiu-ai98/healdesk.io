import { createHmac, randomBytes, randomUUID, scryptSync } from "node:crypto";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

import { getApproval } from "@/lib/approvals/store";
import { type Operator } from "@/lib/ops/api";
import { opSaveSupportDraft } from "@/lib/ops/support-reply-ops";
import { recordChatEscalation } from "@/lib/support/cases";
import { installReplyChecks, restoreReplyChecks, type ReplyCheckInput } from "@/lib/support/send-checks";
import { SLACK_FACTOR, slackInteractionWebhook, verifySlackSignature } from "@/lib/support/slack-actions";
import { parseOperatorIds, slackSupportConfig } from "@/lib/support/slack-api";
import { __resetSlackPasscodeForTests } from "@/lib/support/slack-passcode";
import { replyMessage, runSupportSlackSweep, syncCaseMessage, type ReplyView } from "@/lib/support/slack-reply";

import { closePools, getMigratorPool, hasTestDatabase, runMigrations, truncateAll } from "./setup/db";
import { seedClinic } from "./setup/factories";

/**
 * Support replies operated from Slack (ops automation lane P7i; the owner's
 * decision of 26 October 2026: "Show the draft reply text in Slack so I can
 * read and approve it there with the passcode. I accept that Slack has no
 * BAA."). Against a fake Slack Web API (a stubbed fetch) and signed fixture
 * payloads: Slack's signature and its five minutes, the operator list, the
 * console's passcode verifier and lockout, a send that happens once however
 * often Slack replays, a stale version refused, the reply checks naming a
 * rule and never the words, Snooze and Close, the feature off, long drafts
 * split into blocks, and the clinic's own email never in any Slack call.
 * Fixed dates; the clock is passed in.
 */

vi.setConfig({ testTimeout: 90_000 });

const send = vi.fn();
vi.mock("resend", () => ({
  Resend: class {
    emails = { send };
  },
}));

// The clinic's own email, as the drafter would read it from the bucket: if
// anything on the Slack path read it, the sentinel would reach a Slack call.
const SENTINEL = "SENTINEL-CLINIC-EMAIL-WORDS-7Q";
const emailReads = vi.hoisted(() => ({ count: 0 }));
vi.mock("@/lib/support/draft/email", async (original) => {
  const actual = await original<typeof import("@/lib/support/draft/email")>();
  return {
    ...actual,
    readEmails: async () => {
      emailReads.count += 1;
      return [{ subject: SENTINEL, body: SENTINEL }];
    },
    pendingEmails: async () => {
      emailReads.count += 1;
      return { keys: ["mail/x"], subjects: [SENTINEL] } as never;
    },
  };
});

const describeDb = hasTestDatabase ? describe : describe.skip;
const NOW = new Date("2026-10-14T15:00:00Z");
const NOW_S = Math.floor(NOW.getTime() / 1000);
const REPLY_BY = "2026-10-15";
const ACTOR = { type: "service", serviceName: "support-slack-test" } as const;
const CONSOLE: Operator = { email: "ops@healdesk.test", request: { requestId: randomUUID(), ipAddress: "203.0.113.9", userAgent: "vitest" } };

const TOKEN = "xoxb-test-000000000000";
const SECRET = "8f742231b10e8888abcd99aaabbb85a5";
const CHANNEL = "C0TESTCHAN";
const OWNER = "U0OWNER01";
const STRANGER = "U0STRANGER";
const PASSCODE = "482913";

function hashOf(passcode: string): string {
  const salt = randomBytes(16);
  const key = scryptSync(passcode, salt, 32, { N: 1024, r: 8, p: 1 });
  return `scrypt$1024$8$1$${salt.toString("base64")}$${key.toString("base64")}`;
}
const HASH = hashOf(PASSCODE);

const GOOD =
  "Hi, calls aren't reaching AYA yet because forwarding on your main line isn't set, so callers reach your line as before.\n\nThe codes are in Settings, under Channels. If they don't take, reply here and we'll call you on Monday.";
const EDITED =
  "Hi, calls aren't reaching AYA yet because forwarding on your main line isn't set.\n\nThe codes are in Settings, under Channels. Reply here if they don't take.";

/** Checks 2 to 8 as the send-path tests fake them: one marker each. */
const CHECK_MARKERS = [
  { id: "names", marker: "MARK-NAME", rule: "Names no person" },
  { id: "clinical", marker: "MARK-CLINICAL", rule: "Says nothing clinical" },
] as const;
function fakeChecks(input: ReplyCheckInput) {
  const results = CHECK_MARKERS.map((c) => ({ id: c.id, ok: !input.text.includes(c.marker), rule: c.rule }));
  return { ok: results.every((r) => r.ok), results };
}

// -----------------------------------------------------------------------------
// The fake Slack Web API
// -----------------------------------------------------------------------------

type SlackCall = { method: string; body: Record<string, unknown>; raw: string; auth: string | null };
let calls: SlackCall[] = [];
let failNext: string | null = null;
let tsCounter = 100;

function fakeSlack() {
  return vi.fn(async (url: unknown, init: { body: string; headers: Record<string, string> }) => {
    const u = String(url);
    if (!u.startsWith("https://slack.com/api/")) throw new Error(`unexpected fetch to ${u}`);
    const method = u.slice("https://slack.com/api/".length);
    calls.push({ method, body: JSON.parse(init.body) as Record<string, unknown>, raw: init.body, auth: init.headers.authorization ?? null });
    if (failNext) {
      const error = failNext;
      failNext = null;
      return new Response(JSON.stringify({ ok: false, error }), { status: 200, headers: { "content-type": "application/json" } });
    }
    const answer: Record<string, unknown> = { ok: true };
    if (method === "chat.postMessage") {
      tsCounter += 1;
      answer.ts = `1760000000.000${tsCounter}`;
      answer.channel = CHANNEL;
    }
    return new Response(JSON.stringify(answer), { status: 200, headers: { "content-type": "application/json" } });
  });
}

const of = (method: string) => calls.filter((c) => c.method === method);

// -----------------------------------------------------------------------------
// Signed requests
// -----------------------------------------------------------------------------

function signedRequest(
  payload: unknown,
  options: { secret?: string; ts?: number; contentType?: string; signature?: string } = {},
): Request {
  const body = `payload=${encodeURIComponent(JSON.stringify(payload))}`;
  const ts = String(options.ts ?? NOW_S);
  const signature = options.signature ?? `v0=${createHmac("sha256", options.secret ?? SECRET).update(`v0:${ts}:${body}`).digest("hex")}`;
  return new Request("https://app.healdesk.test/api/webhooks/slack", {
    method: "POST",
    headers: {
      "content-type": options.contentType ?? "application/x-www-form-urlencoded",
      "x-slack-request-timestamp": ts,
      "x-slack-signature": signature,
    },
    body,
  });
}

let deferred: (() => Promise<void>)[] = [];
async function hit(payload: unknown, options: Parameters<typeof signedRequest>[1] = {}, now = NOW) {
  const response = await slackInteractionWebhook(signedRequest(payload, options), { now: () => now, defer: (work) => void deferred.push(work) });
  // Run what Next would run after the answer, in order.
  while (deferred.length > 0) await deferred.shift()!();
  const text = await response.text();
  const isJson = (response.headers.get("content-type") ?? "").includes("application/json");
  return { status: response.status, json: text && isJson ? (JSON.parse(text) as Record<string, unknown>) : null };
}

function button(actionId: string, value: { approvalId: string; caseId: string }, user = OWNER) {
  return {
    type: "block_actions",
    user: { id: user },
    trigger_id: "1234.5678.trigger",
    channel: { id: CHANNEL },
    actions: [{ action_id: actionId, value: JSON.stringify({ a: value.approvalId, c: value.caseId }) }],
  };
}

function submission(view: Record<string, unknown>, values: { text?: string; code?: string }, user = OWNER) {
  const state: Record<string, Record<string, { value: string }>> = {};
  if (values.text !== undefined) state.reply = { text: { value: values.text } };
  if (values.code !== undefined) state.passcode = { code: { value: values.code } };
  return { type: "view_submission", user: { id: user }, view: { callback_id: view.callback_id, private_metadata: view.private_metadata, state: { values: state } } };
}

// -----------------------------------------------------------------------------
// The environment
// -----------------------------------------------------------------------------

const ENV = [
  "SLACK_BOT_TOKEN",
  "SLACK_SIGNING_SECRET",
  "SLACK_SUPPORT_CHANNEL",
  "SLACK_OPERATOR_IDS",
  "HEALDESK_APPROVAL_PASSCODE_HASH",
  "HEALDESK_ADMIN_EMAIL",
  "HEALDESK_CONSOLE_ORIGIN",
  "HEALDESK_EMAIL_TRANSPORT",
  "RESEND_API_KEY",
  "HEALDESK_EMAIL_FROM",
  "BETTER_AUTH_URL",
  "HEALDESK_APP_URL",
  "HEALDESK_OPS_EMAIL",
  "SLACK_WEBHOOK_URL",
  "HEALDESK_OPS_PEOPLE",
] as const;
const SAVED: Record<string, string | undefined> = {};
let keys = 0;
function setEnv() {
  for (const key of ENV) SAVED[key] = process.env[key];
  process.env.SLACK_BOT_TOKEN = TOKEN;
  process.env.SLACK_SIGNING_SECRET = SECRET;
  process.env.SLACK_SUPPORT_CHANNEL = CHANNEL;
  process.env.SLACK_OPERATOR_IDS = `${OWNER}, U0SECOND1`;
  process.env.HEALDESK_APPROVAL_PASSCODE_HASH = HASH;
  process.env.HEALDESK_ADMIN_EMAIL = "ops@healdesk.test";
  process.env.HEALDESK_CONSOLE_ORIGIN = "https://healdesk.test";
  process.env.HEALDESK_EMAIL_TRANSPORT = "resend";
  process.env.RESEND_API_KEY = `re_stub_slack_${keys++}`;
  process.env.HEALDESK_EMAIL_FROM = "healdesk <hello@healdesk.io>";
  process.env.BETTER_AUTH_URL = "https://app.healdesk.test";
  process.env.HEALDESK_OPS_EMAIL = "";
  process.env.SLACK_WEBHOOK_URL = "";
  delete process.env.HEALDESK_APP_URL;
  delete process.env.HEALDESK_OPS_PEOPLE;
}
function restoreEnv() {
  for (const key of ENV) {
    if (SAVED[key] === undefined) delete process.env[key];
    else process.env[key] = SAVED[key];
  }
}

beforeEach(() => {
  setEnv();
  calls = [];
  failNext = null;
  deferred = [];
  emailReads.count = 0;
  send.mockReset();
  send.mockResolvedValue({ data: { id: "re_msg_1" }, error: null, headers: {} });
  __resetSlackPasscodeForTests();
  installReplyChecks(fakeChecks);
  vi.stubGlobal("fetch", fakeSlack());
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  restoreReplyChecks();
  restoreEnv();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// -----------------------------------------------------------------------------
// Without the database
// -----------------------------------------------------------------------------

describe("the door: Slack's signature, the settings, the feature switch", () => {
  test("a signature over the exact body, within five minutes, compared in constant time", () => {
    const body = "payload=%7B%7D";
    const sig = `v0=${createHmac("sha256", SECRET).update(`v0:${NOW_S}:${body}`).digest("hex")}`;
    expect(verifySlackSignature(SECRET, String(NOW_S), sig, body, NOW_S)).toBe(true);
    expect(verifySlackSignature(SECRET, String(NOW_S), sig, `${body}x`, NOW_S)).toBe(false);
    expect(verifySlackSignature("another-secret-0000000000", String(NOW_S), sig, body, NOW_S)).toBe(false);
    expect(verifySlackSignature(SECRET, String(NOW_S), sig, body, NOW_S + 301)).toBe(false);
    expect(verifySlackSignature(SECRET, String(NOW_S), sig, body, NOW_S - 301)).toBe(false);
    expect(verifySlackSignature(SECRET, null, sig, body, NOW_S)).toBe(false);
    expect(verifySlackSignature(SECRET, String(NOW_S), "v0=abc", body, NOW_S)).toBe(false);
  });

  test("on only with all four settings, each well formed; the operator list is Slack user ids", () => {
    expect(slackSupportConfig()).toMatchObject({ channel: CHANNEL });
    expect([...slackSupportConfig()!.operators]).toEqual([OWNER, "U0SECOND1"]);
    for (const name of ["SLACK_BOT_TOKEN", "SLACK_SIGNING_SECRET", "SLACK_SUPPORT_CHANNEL", "SLACK_OPERATOR_IDS"]) {
      const was = process.env[name];
      process.env[name] = "__unset__";
      expect(slackSupportConfig(), name).toBeNull();
      process.env[name] = was;
    }
    process.env.SLACK_SUPPORT_CHANNEL = "#support";
    expect(slackSupportConfig()).toBeNull();
    expect(parseOperatorIds("U0A, someone@example.test")).toBeNull();
    expect(parseOperatorIds("")).toBeNull();
  });

  test("feature off: 404, nothing read, no Slack call", async () => {
    delete process.env.SLACK_BOT_TOKEN;
    const answer = await hit(button("support_review", { approvalId: randomUUID(), caseId: randomUUID() }));
    expect(answer.status).toBe(404);
    expect(calls).toEqual([]);
    expect((await runSupportSlackSweep(NOW)).note).toMatch(/off/);
  });

  test("a bad signature, an old timestamp or the wrong content type is refused before anything is read", async () => {
    const payload = button("support_close", { approvalId: randomUUID(), caseId: randomUUID() });
    expect((await hit(payload, { secret: "a-different-signing-secret-00" })).status).toBe(401);
    expect((await hit(payload, { signature: `v0=${"0".repeat(64)}` })).status).toBe(401);
    expect((await hit(payload, { ts: NOW_S - 6 * 60 })).status).toBe(401);
    expect((await hit(payload, { contentType: "application/json" })).status).toBe(415);
    expect(calls).toEqual([]);
  });

  test("a body over the cap is refused", async () => {
    const big = { type: "block_actions", user: { id: OWNER }, pad: "x".repeat(300_000) };
    expect((await hit(big)).status).toBe(413);
  });
});

describe("the message", () => {
  const view: ReplyView = {
    caseId: "8b0c9d1e-2f3a-4b5c-8d6e-7f8091a2b3c4",
    ref: "HD-7F3KQ",
    clinicName: "Glow *Med* Spa",
    urgency: "today",
    replyByOn: REPLY_BY,
    caseState: "drafted",
    snoozedUntil: null,
    item: { id: "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d", status: "waiting", outcomeCode: null },
    draftVersion: 2,
    draft: GOOD,
    failed: [],
  };

  test("carries the ref, the clinic, urgency, reply-by day, the escaped draft, the checks and five buttons", () => {
    const m = replyMessage({ ...view, draft: `${GOOD}\n<!channel> & <https://evil.test|x>` });
    const text = JSON.stringify(m.blocks);
    expect(m.text).toBe("Support reply to approve: HD-7F3KQ, Glow  Med  Spa".replace(/\s+/g, " "));
    expect(text).toContain("Reply by: Thu 15 Oct");
    expect(text).toContain("Draft v2");
    expect(text).toContain("forwarding on your main line");
    expect(text).toContain("&lt;!channel&gt; &amp; &lt;https://evil.test|x&gt;");
    expect(text).not.toContain("<!channel>");
    expect(text).toContain("Every check passes.");
    const actions = m.blocks.find((b) => b.type === "actions") as { elements: { action_id: string; url?: string }[] };
    expect(actions.elements.map((e) => e.action_id)).toEqual(["support_review", "support_edit", "support_open", "support_snooze", "support_close"]);
    expect(actions.elements[2]!.url).toBe(`https://healdesk.test/admin/support/${view.caseId}`);
  });

  test("a failing check is named by its rule, never by the words", () => {
    const text = JSON.stringify(replyMessage({ ...view, failed: ["Names no person"] }).blocks);
    expect(text).toContain("Failing: Names no person");
  });

  test("a long draft is split into sections within Slack's 3,000 characters, never cut short", () => {
    const words = Array.from({ length: 1400 }, (_, i) => `word${i}`).join(" ");
    const m = replyMessage({ ...view, draft: words });
    const sections = m.blocks.filter((b) => b.type === "section").map((b) => (b as { text: { text: string } }).text.text);
    for (const s of sections) expect(s.length).toBeLessThanOrEqual(3000);
    expect(sections.filter((s) => s.includes("word")).length).toBeGreaterThan(2);
    expect(sections.join(" ")).toContain("word0 ");
    expect(sections.join(" ")).toContain("word1399");
  });

  test("final: no buttons and no draft words, the outcome in closed words", () => {
    for (const [status, outcomeCode, line] of [
      ["executed", "sent", "Approved and sent"],
      ["rejected", "handled_elsewhere", "Rejected in the console"],
      ["expired", "case_closed", "The case closed"],
      ["expired", "no_longer_needed", "Replaced by a newer draft"],
      ["failed", "checks_failed", "not sent (`checks_failed`)"],
    ] as const) {
      const m = replyMessage({ ...view, item: { ...view.item!, status, outcomeCode }, draft: null });
      const text = JSON.stringify(m.blocks);
      expect(text, status).toContain(line);
      expect(m.blocks.some((b) => b.type === "actions"), status).toBe(false);
      expect(text, status).not.toContain("forwarding on your main line");
    }
  });
});

// -----------------------------------------------------------------------------
// Against the database
// -----------------------------------------------------------------------------

async function chatCase(label: string) {
  const clinic = await seedClinic(label);
  const opened = await recordChatEscalation({
    clinicId: clinic.clinicId,
    actor: ACTOR,
    requestId: randomUUID(),
    fields: { topic: "forwarding", symptom: "codes_not_working", carrier: null, phoneSystem: null, mode: null, channel: null },
    replyByOn: REPLY_BY,
    now: NOW,
  });
  return { ...clinic, caseId: opened.caseId, ref: opened.ref };
}

function ok<T>(outcome: { status: number; body: unknown }): T {
  expect(outcome.status, JSON.stringify(outcome.body)).toBe(200);
  return (outcome.body as { data: T }).data;
}

/** A case whose reply waits for a yes: draft v1 saved and proposed from the console. */
async function waitingCase(label: string, text = GOOD) {
  const c = await chatCase(label);
  const saved = ok<{ approvalId: string | null; draftVersion: number }>(await opSaveSupportDraft({ caseId: c.caseId, text }, CONSOLE, NOW));
  expect(saved.approvalId).not.toBeNull();
  return { ...c, approvalId: saved.approvalId!, value: { approvalId: saved.approvalId!, caseId: c.caseId } };
}

async function slackRow(caseId: string) {
  const { rows } = await getMigratorPool().query<Record<string, unknown>>(`select * from support_slack_messages where case_id = $1`, [caseId]);
  return rows[0] ?? null;
}

async function caseRow(caseId: string) {
  const { rows } = await getMigratorPool().query<Record<string, unknown>>(`select * from support_cases where id = $1`, [caseId]);
  return rows[0]!;
}

async function replyVersions(caseId: string) {
  const { rows } = await getMigratorPool().query<{ draft_version: number; draft_text: string }>(
    `select draft_version, draft_text from support_messages where case_id = $1 and kind = 'reply' order by draft_version`,
    [caseId],
  );
  return rows;
}

function replySends() {
  return send.mock.calls.filter(([payload]) =>
    ((payload as { tags?: { name: string; value: string }[] }).tags ?? []).some((t) => t.name === "kind" && t.value === "support_reply"),
  );
}

/** Open the review (or edit) dialog and return the view Slack was asked to open. */
async function openDialog(value: { approvalId: string; caseId: string }, action: "support_review" | "support_edit" = "support_review") {
  const before = of("views.open").length;
  const answer = await hit(button(action, value));
  expect(answer.status).toBe(200);
  const opened = of("views.open");
  expect(opened.length).toBe(before + 1);
  return opened.at(-1)!.body.view as Record<string, unknown> & { blocks: Record<string, unknown>[]; private_metadata: string; callback_id: string };
}

describeDb("support replies operated from Slack (lane P7i)", () => {
  beforeAll(async () => {
    await runMigrations();
    await truncateAll();
  }, 180_000);

  afterAll(async () => {
    await closePools();
  });

  test("the sweep posts one message per case and version, updates it for a new draft, and never twice", async () => {
    const c = await waitingCase("slack-post");
    await syncCaseMessage(c.caseId, { now: NOW });
    const posts = of("chat.postMessage");
    expect(posts).toHaveLength(1);
    expect(posts[0]!.auth).toBe(`Bearer ${TOKEN}`);
    expect(posts[0]!.body.channel).toBe(CHANNEL);
    expect(posts[0]!.raw).toContain("forwarding on your main line");
    expect(posts[0]!.raw).toContain(`HD-${c.ref}`);
    expect(posts[0]!.raw).toContain("slack-post Clinic");
    const row = (await slackRow(c.caseId))!;
    expect(row).toMatchObject({ channel: CHANNEL, approval_id: c.approvalId, draft_version: 1, final: false, attempts: 0 });

    // Unchanged: no call.
    await runSupportSlackSweep(NOW);
    await syncCaseMessage(c.caseId, { now: NOW });
    expect(of("chat.postMessage")).toHaveLength(1);
    expect(of("chat.update")).toHaveLength(0);

    // A new draft from the console: the same message is updated, not a new one.
    ok(await opSaveSupportDraft({ caseId: c.caseId, text: EDITED }, CONSOLE, new Date(NOW.getTime() + 60_000)));
    await syncCaseMessage(c.caseId, { now: NOW });
    expect(of("chat.postMessage")).toHaveLength(1);
    const update = of("chat.update").at(-1)!;
    expect(update.body.ts).toBe(row.ts);
    expect(update.raw).toContain("Draft v2");
    expect(update.raw).toContain("Reply here if they");
    expect(update.raw).not.toContain("so callers reach your line as before");
  });

  test("a Slack call that fails changes no approval or case, and waits before trying again", async () => {
    const c = await waitingCase("slack-down");
    failNext = "channel_not_found";
    expect(await syncCaseMessage(c.caseId, { now: NOW })).toBe("failed");
    expect((await getApproval(c.approvalId))!.status).toBe("waiting");
    expect((await caseRow(c.caseId)).state).toBe("drafted");
    expect(await slackRow(c.caseId)).toMatchObject({ attempts: 1, last_error: "channel_not_found", ts: null });
    expect(await syncCaseMessage(c.caseId, { now: NOW })).toBe("not_due");
    expect(await syncCaseMessage(c.caseId, { now: new Date(NOW.getTime() + 61_000) })).toBe("posted");
  });

  test("Review and send opens the reply read from the database, with the version and hash it opened on", async () => {
    const c = await waitingCase("slack-open");
    const view = await openDialog(c.value);
    expect(view.callback_id).toBe("support_review");
    const reply = view.blocks.find((b) => b.block_id === "reply") as { element: { initial_value: string; max_length: number } };
    expect(reply.element.initial_value).toBe(GOOD);
    expect(reply.element.max_length).toBe(3000);
    expect(view.blocks.some((b) => b.block_id === "passcode")).toBe(true);
    const meta = JSON.parse(view.private_metadata) as { v: number; h: string };
    expect(meta.v).toBe(1);
    expect(meta.h).toBe((await getApproval(c.approvalId))!.draftHash);
    expect(of("views.open").at(-1)!.body.trigger_id).toBe("1234.5678.trigger");
  });

  test("someone not on SLACK_OPERATOR_IDS is told no, privately, and nothing happens", async () => {
    const c = await waitingCase("slack-stranger");
    const answer = await hit(button("support_close", c.value, STRANGER));
    expect(answer.status).toBe(200);
    expect(of("chat.postEphemeral")).toHaveLength(1);
    expect(of("chat.postEphemeral")[0]!.body).toMatchObject({ user: STRANGER, channel: CHANNEL });
    expect(of("views.open")).toHaveLength(0);
    expect((await caseRow(c.caseId)).state).toBe("drafted");
    // And a dialog submitted by them (it could only be replayed) is refused too.
    const view = await openDialog(c.value);
    const refused = await hit(submission(view, { text: GOOD, code: PASSCODE }, STRANGER));
    expect(refused.json).toMatchObject({ response_action: "errors" });
    expect((await getApproval(c.approvalId))!.status).toBe("waiting");
    expect(replySends()).toHaveLength(0);
  });

  test("a wrong passcode is refused in the dialog; five lock Slack approvals, the right one included", async () => {
    const c = await waitingCase("slack-lock");
    const view = await openDialog(c.value);
    const wrong = await hit(submission(view, { text: GOOD, code: "000000" }));
    expect(wrong.json).toEqual({ response_action: "errors", errors: { passcode: "That is not the approval passcode. Nothing was changed." } });
    expect((await hit(submission(view, { text: GOOD, code: "12ab" }))).json).toMatchObject({ errors: { passcode: "Enter the 6-digit approval passcode." } });
    for (let i = 0; i < 4; i += 1) await hit(submission(view, { text: GOOD, code: "111111" }));
    const locked = await hit(submission(view, { text: GOOD, code: PASSCODE }));
    expect(locked.json).toEqual({ response_action: "errors", errors: { passcode: "Too many wrong passcodes: approvals are locked. Try later." } });
    expect((await getApproval(c.approvalId))!.status).toBe("waiting");
    expect(replySends()).toHaveLength(0);
    // The passcode is never in a log line.
    const logged = [...vi.mocked(console.warn).mock.calls, ...vi.mocked(console.info).mock.calls, ...vi.mocked(console.error).mock.calls].flat().join("\n");
    expect(logged).not.toContain(PASSCODE);
    expect(logged).not.toContain(SECRET);
    expect(logged).toContain("approval_code_locked");
  });

  test("the right passcode on the unchanged reply sends it once, recorded as passcode via slack; a replay sends nothing more", async () => {
    const c = await waitingCase("slack-send");
    await syncCaseMessage(c.caseId, { now: NOW });
    const view = await openDialog(c.value);
    const submit = submission(view, { text: GOOD, code: PASSCODE });
    const answer = await hit(submit);
    expect(answer.json).toEqual({ response_action: "clear" });
    expect(replySends()).toHaveLength(1);
    expect((await getApproval(c.approvalId))!.status).toBe("executed");

    // Who and with what: the operator account from Slack, with the member id, and the factor.
    const { rows: ev } = await getMigratorPool().query<{ event: string; actor_label: string }>(
      `select event, actor_label from ops_approval_events where approval_id = $1 order by at, id`,
      [c.approvalId],
    );
    expect(ev.find((e) => e.event === "approved")!.actor_label).toBe(`ops@healdesk.test via Slack ${OWNER}`);
    const { rows: sec } = await getMigratorPool().query<{ metadata: Record<string, unknown>; actor_label: string }>(
      `select metadata, actor_label from security_events where event = 'approval_approved' and metadata->>'approvalId' = $1`,
      [c.approvalId],
    );
    expect(sec).toHaveLength(1);
    expect(sec[0]!.metadata).toMatchObject({ factor: SLACK_FACTOR, freshCode: true, outcomeCode: "sent" });

    // The message is final: no buttons, no draft words; the owner is told privately.
    const update = of("chat.update").at(-1)!;
    expect(update.raw).toContain("Approved and sent");
    expect(update.raw).not.toContain("support_review");
    expect(update.raw).not.toContain("forwarding on your main line");
    expect((await slackRow(c.caseId))!.final).toBe(true);
    expect(of("chat.postEphemeral").at(-1)!.raw).toContain("approved and sent");

    // Slack replays the same submission: refused, nothing more is sent.
    const replay = await hit(submit);
    expect(replay.json).toMatchObject({ response_action: "errors" });
    expect(replySends()).toHaveLength(1);
  });

  test("an edited reply is checked first: a failing rule is named, never the words, and nothing is saved or sent", async () => {
    const c = await waitingCase("slack-edit-fail");
    const view = await openDialog(c.value);
    const answer = await hit(submission(view, { text: `${EDITED} MARK-NAME`, code: PASSCODE }));
    expect(answer.json).toMatchObject({ response_action: "errors" });
    const error = (answer.json!.errors as { reply: string }).reply;
    expect(error).toContain("Names no person");
    expect(error).not.toContain("Reply here");
    expect(await replyVersions(c.caseId)).toHaveLength(1);
    expect((await getApproval(c.approvalId))!.status).toBe("waiting");
    expect(replySends()).toHaveLength(0);
  });

  test("a passing edit is saved as the next draft, proposed, and that version is approved and sent", async () => {
    const c = await waitingCase("slack-edit-send");
    const view = await openDialog(c.value);
    const answer = await hit(submission(view, { text: EDITED, code: PASSCODE }));
    expect(answer.json).toEqual({ response_action: "clear" });
    const versions = await replyVersions(c.caseId);
    expect(versions.map((v) => v.draft_version)).toEqual([1, 2]);
    expect(versions[1]!.draft_text).toBe(EDITED);
    // The old item left the list unsent; the new one went.
    expect((await getApproval(c.approvalId))!).toMatchObject({ status: "expired", outcomeCode: "no_longer_needed" });
    const sends = replySends();
    expect(sends).toHaveLength(1);
    expect(String((sends[0]![0] as { text: string }).text)).toContain("Reply here if they don't take.");
    const { rows } = await getMigratorPool().query<{ status: string; payload: { draftVersion: number } }>(
      `select status, payload from ops_approvals where kind = 'support_reply_send' and payload->>'caseId' = $1 order by (payload->>'draftVersion')::int`,
      [c.caseId],
    );
    expect(rows.map((r) => [r.payload.draftVersion, r.status])).toEqual([
      [1, "expired"],
      [2, "executed"],
    ]);
  });

  test("a stale dialog (a newer draft since it opened) is refused, nothing is sent, and the message is brought up to date", async () => {
    const c = await waitingCase("slack-stale");
    await syncCaseMessage(c.caseId, { now: NOW });
    const view = await openDialog(c.value);
    ok(await opSaveSupportDraft({ caseId: c.caseId, text: EDITED }, CONSOLE, new Date(NOW.getTime() + 60_000)));
    const updates = of("chat.update").length;
    const answer = await hit(submission(view, { text: GOOD, code: PASSCODE }));
    expect(answer.json).toMatchObject({ response_action: "errors" });
    expect(JSON.stringify(answer.json)).toMatch(/no longer waiting|newer draft/);
    expect(replySends()).toHaveLength(0);
    expect(of("chat.update").length).toBe(updates + 1);
    expect(of("chat.update").at(-1)!.raw).toContain("Draft v2");
  });

  test("Edit only saves a passing edit as the next draft without sending, and the message shows it", async () => {
    const c = await waitingCase("slack-edit-only");
    await syncCaseMessage(c.caseId, { now: NOW });
    const view = await openDialog(c.value, "support_edit");
    expect(view.blocks.some((b) => b.block_id === "passcode")).toBe(false);
    const answer = await hit(submission(view, { text: EDITED }));
    expect(answer.json).toEqual({ response_action: "clear" });
    expect((await replyVersions(c.caseId)).map((v) => v.draft_version)).toEqual([1, 2]);
    expect(replySends()).toHaveLength(0);
    expect(of("chat.update").at(-1)!.raw).toContain("Draft v2");
    expect((await caseRow(c.caseId)).state).toBe("drafted");
  });

  test("Snooze puts the case aside a day and says so; Close closes it, takes the item off the list and turns the message final", async () => {
    const c = await waitingCase("slack-snooze");
    await syncCaseMessage(c.caseId, { now: NOW });
    await hit(button("support_snooze", c.value));
    const snoozed = await caseRow(c.caseId);
    expect(snoozed.state).toBe("snoozed");
    expect((snoozed.snoozed_until as Date).toISOString()).toBe("2026-10-15T15:00:00.000Z");
    expect(of("chat.update").at(-1)!.raw).toContain("Snoozed until Thu 15 Oct");

    await hit(button("support_close", c.value));
    const closed = await caseRow(c.caseId);
    expect(closed).toMatchObject({ state: "closed", closed_reason: "no_reply_needed" });
    expect((await getApproval(c.approvalId))!).toMatchObject({ status: "expired", outcomeCode: "case_closed" });
    const last = of("chat.update").at(-1)!;
    expect(last.raw).toContain("The case is closed");
    expect(last.raw).not.toContain("support_review");
    expect((await slackRow(c.caseId))!.final).toBe(true);
    expect(replySends()).toHaveLength(0);
    // The security log names the operator from Slack.
    const { rows } = await getMigratorPool().query<{ actor_label: string }>(
      `select actor_label from security_events where event = 'support_case_closed' order by occurred_at desc limit 1`,
    );
    expect(rows[0]!.actor_label).toBe(`ops@healdesk.test via Slack ${OWNER}`);
  });

  test("a draft longer than Slack's box can be approved unchanged only; Edit only points to the console", async () => {
    const c = await chatCase("slack-long");
    const long = Array.from({ length: 30 }, () => "Forwarding on your main line is not set yet, and the codes are in Settings.").join(" ");
    expect(long.length).toBeGreaterThan(1500);
    // Today the send path's floor caps a passing draft at 1,500 characters, so
    // no proposal can carry one this long; the dialog still has to hold if one
    // ever does. The reply row and its item are written directly.
    const longText = `${long} ${long}`.slice(0, 3500);
    const { rows } = await getMigratorPool().query<{ id: string }>(
      `insert into support_messages (case_id, direction, kind, draft_text, draft_version, checks_json, facts_json, created_at)
       values ($1, 'out', 'reply', $2, 1, '{"ok":true,"results":[]}', '{"by":"operator","attempt":1}', $3) returning id`,
      [c.caseId, longText, NOW],
    );
    await getMigratorPool().query(`update support_cases set state = 'drafted' where id = $1`, [c.caseId]);
    const { propose } = await import("@/lib/approvals/store");
    const { serialiseDraft } = await import("@/lib/approvals/drafts");
    const approvalId = await propose(
      {
        kind: "support_reply_send",
        subjectClinicId: c.clinicId,
        subjectRef: `${rows[0]!.id}:v1`,
        payload: { caseId: c.caseId, messageId: rows[0]!.id, draftVersion: 1, ref: c.ref },
        dueAt: new Date(NOW.getTime() + 86_400_000),
      },
      NOW,
      { draft: serialiseDraft({ subject: `Re: Your call forwarding (ref HD-${c.ref})`, body: longText }), proposedBy: "support-drafts", actor: { label: "support-drafts" } },
    );
    const proposed = { approvalId: approvalId! };
    const value = { approvalId: (proposed as { approvalId: string }).approvalId, caseId: c.caseId };

    await hit(button("support_edit", value));
    expect(of("views.open")).toHaveLength(0);
    expect(of("chat.postEphemeral").at(-1)!.raw).toContain("edit it in the console");

    const view = await openDialog(value);
    expect(view.blocks.some((b) => b.block_id === "reply")).toBe(false);
    expect(JSON.stringify(view.blocks)).toContain("cannot be edited here");
    const answer = await hit(submission(view, { code: PASSCODE }));
    expect(answer.json).toEqual({ response_action: "clear" });
    expect((await getApproval(value.approvalId))!.status).toMatch(/executed|failed/);
  });

  test("the clinic's own email never reaches a Slack call: only the drafted reply does", async () => {
    const c = await waitingCase("slack-sentinel");
    await runSupportSlackSweep(NOW);
    const view = await openDialog(c.value);
    await hit(submission(view, { text: GOOD, code: PASSCODE }));
    expect(calls.length).toBeGreaterThan(2);
    for (const call of calls) expect(call.raw, call.method).not.toContain(SENTINEL);
    expect(emailReads.count).toBe(0);
  });
});
