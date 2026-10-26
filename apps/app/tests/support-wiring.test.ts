import { randomUUID } from "node:crypto";

import type Anthropic from "@anthropic-ai/sdk";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

import { getApproval, moveStatus, SERVICE_ACTOR } from "@/lib/approvals/store";
import { renderOpsDigest } from "@/lib/email/templates/ops_digest";
import { collectDigest } from "@/lib/ops/digest";
import type { Operator } from "@/lib/ops/api";
import { opDecideApproval } from "@/lib/ops/approval-ops";
import { slackText } from "@/lib/ops/slack";
import { watchSupportReplies } from "@/lib/ops/watch";
import { setJobEnabled } from "@/lib/scheduler/jobs";
import { forgetSupportReplyDrafts, JOB_SUPPORT_SEND, runSupportRetention, runSupportSendJob } from "@/lib/scheduler/support-send";
import { sweepSentReplyText } from "@/lib/support/send";
import { assignSupportCase, closeSupportCase, recordChatEscalation, snoozeSupportCase } from "@/lib/support/cases";
import { draftNextCase, type DraftModelClient } from "@/lib/support/draft/run";
import { READ_TOOL_NAMES } from "@/lib/support/draft/tools";
import { installReplyChecks, restoreReplyChecks } from "@/lib/support/send-checks";
import { alertNowCases, closeQuietCases, endSnoozes, supportCaseCounts, watchSupportCases } from "@/lib/support/watch";
import { CASE_CLOSED_OUTCOME } from "@/lib/support/wire";

import { closePools, getAppPool, getMigratorPool, hasTestDatabase, runMigrations, truncateAll } from "./setup/db";
import { inTenant } from "./setup/factories";
import { provisionPortalClinic, type PortalClinic } from "./setup/portal-clinic";

/**
 * The support slice wired together (ops automation lane P7e; drizzle/0127):
 * a passing draft reaches the owner's approval inbox by itself and goes out
 * once he approves it with his code; closing a case takes its item off the
 * list; the support-send job retries what did not go; the watch alerts once
 * per case and promise, ends snoozes and closes quiet cases without a word;
 * a `now` case is one Slack-bound alert; the digest's support line; and a
 * reply's words are forgotten at 12 months and at the clinic's destruction,
 * in its approval item too, with nothing else of the record moving.
 *
 * Every clock is fixed: Tuesday 27 October 2026, a reply due Wednesday the
 * 28th. ops_alerts is shared, so each test reads only its own clinic's rows.
 */

vi.setConfig({ testTimeout: 120_000 });

const send = vi.fn();
vi.mock("resend", () => ({
  Resend: class {
    emails = { send };
  },
}));

const describeDb = hasTestDatabase ? describe : describe.skip;
const ACTOR = { type: "service", serviceName: "support-wiring-test" } as const;
const OPERATOR: Operator = {
  email: "ops@healdesk.test",
  request: { requestId: randomUUID(), ipAddress: "203.0.113.9", userAgent: "vitest" },
};
const NOW = new Date("2026-10-27T15:00:00Z");
const REPLY_BY = "2026-10-28";
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const at = (ms: number, from = NOW) => new Date(from.getTime() + ms);
const BY_WEDNESDAY = "Hi, a person at healdesk will reply with the next step by Wednesday.";
const REPLY_BY_FACT = { tool: "get_case_history", field: "A person replies by", value: "Wednesday 28 October 2026" };
const SENT = { data: { id: "re_msg_1" }, error: null, headers: {} };
const DOWN = { data: null, error: { name: "application_error", message: "down", statusCode: 500 }, headers: {} };

function message(content: Anthropic.ContentBlock[]): Anthropic.Message {
  return {
    id: `msg_${randomUUID()}`,
    type: "message",
    role: "assistant",
    model: "claude-opus-5-5",
    content,
    stop_reason: "tool_use",
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  } as unknown as Anthropic.Message;
}

function use(name: string, input: unknown = {}): Anthropic.ToolUseBlock {
  return { type: "tool_use", id: `toolu_${randomUUID().slice(0, 8)}`, name, input } as Anthropic.ToolUseBlock;
}

/** Reads every tool first, as lane P7b's fake does, then proposes `reply`, citing the reply-by day. */
function fakeModel(reply: string, fact = REPLY_BY_FACT): DraftModelClient {
  let calls = 0;
  return {
    async create() {
      calls += 1;
      if (calls === 1) return message(READ_TOOL_NAMES.map((name) => use(name)));
      return message([
        {
          type: "tool_use",
          id: `toolu_${randomUUID().slice(0, 8)}`,
          name: "propose_reply",
          input: {
            category: "forwarding",
            symptom: "other",
            urgency: "this_week",
            handoff_reasons: [],
            reply,
            facts_used: [fact],
            questions_for_ops: [],
            confidence: "medium",
          },
        } as Anthropic.ToolUseBlock,
      ]);
    },
  };
}

function ok<T>(outcome: { status: number; body: unknown }): T {
  expect(outcome.status, JSON.stringify(outcome.body)).toBe(200);
  return (outcome.body as { data: T }).data;
}

async function chatCase(clinicId: string, topic = "forwarding", symptom = "codes_not_working", replyByOn = REPLY_BY, now = NOW) {
  return recordChatEscalation({
    clinicId,
    actor: ACTOR,
    requestId: randomUUID(),
    fields: { topic, symptom, carrier: null, phoneSystem: null, mode: null, channel: null },
    replyByOn,
    now,
  } as Parameters<typeof recordChatEscalation>[0]);
}

async function caseRow(caseId: string) {
  const { rows } = await getMigratorPool().query<Record<string, unknown>>(`select * from support_cases where id = $1`, [caseId]);
  return rows[0]!;
}

async function itemsOf(caseId: string) {
  const { rows } = await getMigratorPool().query<{ id: string; status: string; outcome_code: string | null; draft: string | null; draft_hash: string | null }>(
    `select id, status, outcome_code, draft, draft_hash from ops_approvals where kind = 'support_reply_send' and payload->>'caseId' = $1 order by proposed_at, id`,
    [caseId],
  );
  return rows;
}

async function alertsFor(clinicId: string, event?: string) {
  const { rows } = await getMigratorPool().query<{ event: string; fields: Record<string, unknown>; dedupe_key: string }>(
    `select event, fields, dedupe_key from ops_alerts where fields->>'clinicId' = $1 ${event ? "and event = $2" : ""} order by raised_at, id`,
    event ? [clinicId, event] : [clinicId],
  );
  return rows;
}

function replySends() {
  return send.mock.calls.filter(([payload]) =>
    ((payload as { tags?: { name: string; value: string }[] }).tags ?? []).some((t) => t.name === "kind" && t.value === "support_reply"),
  );
}

/** Draft the case with the fake model, as the support-draft job does. */
async function draft(caseId: string, reply = BY_WEDNESDAY, now = NOW, replyByWords = REPLY_BY_FACT.value) {
  return draftNextCase({ client: fakeModel(reply, { ...REPLY_BY_FACT, value: replyByWords }), now }, caseId);
}

function decide(id: string, now = at(10 * MINUTE)) {
  return opDecideApproval({ id, action: "approve", reasonCode: "owner_checked", codeChecked: true }, OPERATOR, { now });
}

describeDb("the support slice, wired (lane P7e; drizzle/0127)", () => {
  let a: PortalClinic;

  beforeAll(async () => {
    await runMigrations();
    await truncateAll();
    a = await provisionPortalClinic("wiring", { plan: "voice-webchat-500-300" });
  }, 240_000);

  beforeEach(() => {
    vi.stubEnv("HEALDESK_EMAIL_TRANSPORT", "resend");
    vi.stubEnv("RESEND_API_KEY", `re_stub_${randomUUID().slice(0, 6)}`);
    vi.stubEnv("HEALDESK_EMAIL_FROM", "healdesk <hello@healdesk.io>");
    vi.stubEnv("BETTER_AUTH_URL", "https://app.healdesk.test");
    vi.stubEnv("HEALDESK_OPS_EMAIL", "");
    vi.stubEnv("HEALDESK_ADMIN_EMAIL", "");
    vi.stubEnv("SLACK_WEBHOOK_URL", "");
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    send.mockReset();
    send.mockResolvedValue(SENT);
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(async () => {
    restoreReplyChecks();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    // One open chat case per clinic and topic: close what a test left open.
    const { rows } = await getMigratorPool().query<{ id: string }>(`select id from support_cases where state <> 'closed'`);
    for (const r of rows) await closeSupportCase(r.id, "no_reply_needed", NOW);
  });

  afterAll(async () => {
    await closePools();
  });

  // ---------------------------------------------------------------------------
  // Item 2: the auto-propose hook
  // ---------------------------------------------------------------------------

  test("the whole chain: case, draft, approval item, approve with the code, one email, waiting on the clinic", async () => {
    const c = await chatCase(a.clinicId);
    expect(await draft(c.caseId)).toMatchObject({ outcome: "drafted", version: 1, failed: [] });
    const items = await itemsOf(c.caseId);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ status: "waiting" });
    expect(JSON.parse(items[0]!.draft!)).toMatchObject({ body: BY_WEDNESDAY });
    expect(replySends()).toHaveLength(0);

    const decided = ok<{ status: string; outcomeCode: string }>(await decide(items[0]!.id));
    expect(decided).toMatchObject({ status: "executed", outcomeCode: "sent" });
    expect(replySends()).toHaveLength(1);
    expect([(replySends()[0]![0] as { to: string[] | string }).to].flat()).toEqual([a.email]);
    expect(await caseRow(c.caseId)).toMatchObject({ state: "waiting_clinic" });
    // Approving again sends nothing more.
    await decide(items[0]!.id, at(11 * MINUTE));
    expect(replySends()).toHaveLength(1);
  });

  test("a draft that fails a check proposes nothing; the same version is proposed once; a failed proposal never fails the draft", async () => {
    const failing = await chatCase(a.clinicId, "billing", "invoice_question");
    expect(await draft(failing.caseId, "Hi! A person will reply by Wednesday.")).toMatchObject({ outcome: "needs_edit" });
    expect(await itemsOf(failing.caseId)).toEqual([]);

    const passing = await chatCase(a.clinicId, "calendar", "wont_connect");
    expect(await draft(passing.caseId)).toMatchObject({ outcome: "drafted" });
    // The hook again for the same version (a retried run, a woken snooze): still one item.
    const { proposeAfterDraft } = await import("@/lib/support/wire");
    expect(await proposeAfterDraft(passing.caseId, at(MINUTE))).toMatchObject({ status: "already_waiting" });
    expect((await itemsOf(passing.caseId)).filter((i) => i.status === "waiting")).toHaveLength(1);

    // The send-side checks throwing: the proposal fails, the draft stands.
    installReplyChecks(() => {
      throw new Error("checks down");
    });
    const third = await chatCase(a.clinicId, "transcript", "not_received");
    expect(await draft(third.caseId)).toMatchObject({ outcome: "drafted", failed: [] });
    expect(await caseRow(third.caseId)).toMatchObject({ state: "drafted" });
    expect(await itemsOf(third.caseId)).toEqual([]);
  });

  // ---------------------------------------------------------------------------
  // Item 3: close expires the item; snooze and assign leave it
  // ---------------------------------------------------------------------------

  test("closing a case expires its waiting reply item as case_closed; snoozing or assigning it leaves the item waiting", async () => {
    const c = await chatCase(a.clinicId);
    await draft(c.caseId);
    const [item] = await itemsOf(c.caseId);
    expect(item!.status).toBe("waiting");

    await snoozeSupportCase(c.caseId, at(DAY), at(MINUTE));
    await assignSupportCase(c.caseId, "The Healdesk Team", at(2 * MINUTE));
    expect((await getApproval(item!.id))!.status).toBe("waiting");

    expect((await closeSupportCase(c.caseId, "replied_by_hand", at(3 * MINUTE))).outcome).toBe("done");
    expect(await getApproval(item!.id)).toMatchObject({ status: "expired", outcomeCode: CASE_CLOSED_OUTCOME });
    const { rows: events } = await getMigratorPool().query<{ event: string; outcome_code: string | null }>(
      `select event, outcome_code from ops_approval_events where approval_id = $1 order by at, id`,
      [item!.id],
    );
    expect(events.map((e) => [e.event, e.outcome_code])).toEqual([
      ["proposed", null],
      ["expired", "case_closed"],
    ]);
    // Nothing was sent, and the expired item cannot be approved into a send.
    await decide(item!.id, at(4 * MINUTE));
    expect(replySends()).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // Item 1: the support-send job
  // ---------------------------------------------------------------------------

  test("support-send ships off; switched on, it retries a reply whose first try failed and reports its counts", async () => {
    const c = await chatCase(a.clinicId);
    await draft(c.caseId);
    const [item] = await itemsOf(c.caseId);
    send.mockResolvedValueOnce(DOWN);
    expect(ok<{ outcomeCode: string }>(await decide(item!.id, NOW)).outcomeCode).toBe("send_retrying");
    expect(replySends()).toHaveLength(1);

    expect(await runSupportSendJob({ now: at(2 * MINUTE) })).toEqual({ status: "disabled" });
    expect(replySends()).toHaveLength(1);

    await setJobEnabled(JOB_SUPPORT_SEND, true, a.userId);
    try {
      expect(await runSupportSendJob({ now: at(2 * MINUTE) })).toEqual({ status: "ok", note: "1 sent, 0 to try again, 0 stopped" });
      expect(replySends()).toHaveLength(2);
      expect(await caseRow(c.caseId)).toMatchObject({ state: "waiting_clinic" });
      // Idempotent: nothing is due again.
      expect(await runSupportSendJob({ now: at(3 * MINUTE) })).toEqual({ status: "ok", note: "0 sent, 0 to try again, 0 stopped" });
      expect(replySends()).toHaveLength(2);
    } finally {
      await setJobEnabled(JOB_SUPPORT_SEND, false, a.userId);
    }
  });

  // ---------------------------------------------------------------------------
  // Item 4: the watch, one alert per promise, the digest
  // ---------------------------------------------------------------------------

  test("a chat escalation past its day raises ONE past-due alert (the case's), however often the watches run", async () => {
    const clinic = await provisionPortalClinic("wiring-due", { plan: "voice-webchat-500-300" });
    const requestId = randomUUID();
    // As escalate_to_support writes them: the case, and its L25 acknowledgement in the outbox.
    const opened = await recordChatEscalation({
      clinicId: clinic.clinicId,
      actor: ACTOR,
      requestId,
      fields: { topic: "billing", symptom: "invoice_question", carrier: null, phoneSystem: null, mode: null, channel: null },
      replyByOn: REPLY_BY,
      now: NOW,
    });
    await inTenant(clinic.clinicId, (q) =>
      q.query(`insert into billing_notices (clinic_id, kind, dedupe_key, payload) values ($1, 'support_request', $2, $3)`, [
        clinic.clinicId,
        `support_request:${requestId}`,
        JSON.stringify({ requestId, topic: "billing", replyByOn: REPLY_BY, helpPhoneE164: null }),
      ]),
    );
    // And an older L25 request with no case: the old watch still chases it.
    const oldRequest = randomUUID();
    await inTenant(clinic.clinicId, (q) =>
      q.query(`insert into billing_notices (clinic_id, kind, dedupe_key, payload) values ($1, 'support_request', $2, $3)`, [
        clinic.clinicId,
        `support_request:${oldRequest}`,
        JSON.stringify({ requestId: oldRequest, topic: "plan", replyByOn: REPLY_BY, helpPhoneE164: null }),
      ]),
    );

    // On the day itself nothing is late.
    await watchSupportCases(at(6 * 60 * MINUTE));
    expect(await alertsFor(clinic.clinicId, "support_case_past_due")).toEqual([]);

    const late = new Date("2026-10-29T14:00:00Z");
    for (let i = 0; i < 3; i += 1) {
      await watchSupportReplies(late);
      await watchSupportCases(late);
    }
    const caseAlerts = await alertsFor(clinic.clinicId, "support_case_past_due");
    expect(caseAlerts).toHaveLength(1);
    expect(caseAlerts[0]!.fields).toMatchObject({ clinicId: clinic.clinicId, requestId: opened.caseId, promisedOn: REPLY_BY, supportRef: `HD-${opened.ref}` });
    const oldAlerts = await alertsFor(clinic.clinicId, "support_reply_past_due");
    expect(oldAlerts.map((r) => r.fields.requestId)).toEqual([oldRequest]);
    // Never a word of the clinic's: the alert's fields are ids, a ref and a day.
    expect(Object.keys(caseAlerts[0]!.fields).sort()).toEqual(["clinicId", "promisedOn", "requestId", "supportRef"]);
  });

  test("a now case raises one alert, Slack-bound, carrying the clinic, the ref and the day only", async () => {
    const clinic = await provisionPortalClinic("wiring-now", { plan: "voice-webchat-500-300" });
    const c = await chatCase(clinic.clinicId, "forwarding", "calls_ring_out");
    expect((await caseRow(c.caseId)).urgency).toBe("now");
    const later = await chatCase(clinic.clinicId, "billing", "card_change");
    await alertNowCases(NOW);
    await alertNowCases(at(MINUTE));
    await watchSupportCases(at(2 * MINUTE));
    const raised = await alertsFor(clinic.clinicId, "support_case_now");
    expect(raised).toHaveLength(1);
    expect(raised[0]!.fields).toMatchObject({ requestId: c.caseId, supportRef: `HD-${c.ref}`, promisedOn: REPLY_BY });
    expect(raised.some((r) => r.fields.requestId === later.caseId)).toBe(false);

    const text = slackText({ event: "support_case_now", fields: raised[0]!.fields as Record<string, string>, clinicName: "wiring-now Clinic" });
    expect(text).toContain(`HD-${c.ref}`);
    expect(text).toContain("28 Oct");
    expect(text).toContain("wiring-now Clinic");
    expect(text).not.toMatch(/undefined|\{[a-z]+\}/i);
  });

  test("a snooze that ran out puts the case back where its draft says, and a drafted one is proposed again", async () => {
    const drafted = await chatCase(a.clinicId);
    await draft(drafted.caseId);
    const [first] = await itemsOf(drafted.caseId);
    await snoozeSupportCase(drafted.caseId, at(DAY), at(MINUTE));
    // The item ran out while the case slept.
    await moveStatus(first!.id, "waiting", "expired", "expired", SERVICE_ACTOR, at(2 * MINUTE), { outcomeCode: "window_closed" });

    const fresh = await chatCase(a.clinicId, "plan", "move_up_a_step");
    await snoozeSupportCase(fresh.caseId, at(DAY), at(MINUTE));

    const failing = await chatCase(a.clinicId, "billing", "invoice_question");
    await draft(failing.caseId, "Hi! A person will reply by Wednesday.");
    await snoozeSupportCase(failing.caseId, at(DAY), at(MINUTE));

    // Not yet.
    expect(await endSnoozes(at(DAY - MINUTE))).toBe(0);
    expect(await caseRow(drafted.caseId)).toMatchObject({ state: "snoozed" });

    expect(await endSnoozes(at(DAY))).toBe(3);
    expect(await caseRow(drafted.caseId)).toMatchObject({ state: "drafted", snoozed_until: null });
    expect(await caseRow(fresh.caseId)).toMatchObject({ state: "new", snoozed_until: null });
    expect(await caseRow(failing.caseId)).toMatchObject({ state: "needs_edit", snoozed_until: null });
    const items = await itemsOf(drafted.caseId);
    expect(items.map((i) => i.status)).toEqual(["expired", "waiting"]);
  });

  test("a case waiting on the clinic 14 days since our reply closes as no_further_reply, sending nothing to anyone", async () => {
    const c = await chatCase(a.clinicId);
    await draft(c.caseId);
    const [item] = await itemsOf(c.caseId);
    await decide(item!.id, NOW);
    expect(await caseRow(c.caseId)).toMatchObject({ state: "waiting_clinic" });
    const sends = send.mock.calls.length;

    expect(await closeQuietCases(at(14 * DAY - MINUTE))).toBe(0);
    expect(await closeQuietCases(at(14 * DAY))).toBe(1);
    expect(await caseRow(c.caseId)).toMatchObject({ state: "closed", closed_reason: "no_further_reply" });
    expect(send.mock.calls.length).toBe(sends);
    expect(await alertsFor(a.clinicId, "support_case_past_due")).toEqual([]);
  });

  test("the digest's support line: need you, past their day, waiting on a clinic", async () => {
    const clinic = await provisionPortalClinic("wiring-digest", { plan: "voice-webchat-500-300" });
    const before = await supportCaseCounts(new Date("2026-10-29T14:00:00Z"));
    await chatCase(clinic.clinicId, "billing", "invoice_question");
    await chatCase(clinic.clinicId, "plan", "move_up_a_step", "2026-10-30");
    const waiting = await chatCase(clinic.clinicId, "calendar", "wont_connect");
    await getMigratorPool().query(`update support_cases set state = 'waiting_clinic', last_outbound_at = $2 where id = $1`, [waiting.caseId, NOW]);
    const counts = await supportCaseCounts(new Date("2026-10-29T14:00:00Z"));
    expect(counts).toEqual({ needYou: before.needYou + 2, pastDue: before.pastDue + 1, waitingClinic: before.waitingClinic + 1 });

    const payload = await collectDigest(new Date("2026-10-29T14:00:00Z"));
    expect(payload).toMatchObject({
      supportNeedYouCount: counts.needYou,
      supportPastDueCount: counts.pastDue,
      supportWaitingClinicCount: counts.waitingClinic,
    });
    const rendered = renderOpsDigest(payload, {
      clinicName: null,
      audience: "patients",
      reason: "You're receiving this because you're on healdesk's ops rota.",
      raisedAt: new Date("2026-10-29T14:00:00Z"),
      timeZone: "UTC",
    });
    expect(rendered.text).toContain(
      `Support: ${counts.needYou} need you, ${counts.pastDue} past their day, ${counts.waitingClinic} waiting on a clinic.`,
    );
  });

  // ---------------------------------------------------------------------------
  // Item 6: a reply's words in its approval item
  // ---------------------------------------------------------------------------

  test("12 months after its decision a support reply item's draft is forgotten; the item, its hash and its events stay", async () => {
    const OLD = new Date("2024-03-05T15:00:00Z");
    const c = await chatCase(a.clinicId, "forwarding", "codes_not_working", "2024-03-06", OLD);
    expect(await draft(c.caseId, BY_WEDNESDAY, OLD, "Wednesday 6 March 2024")).toMatchObject({ outcome: "drafted" });
    const [item] = await itemsOf(c.caseId);
    expect(ok<{ outcomeCode: string }>(await decide(item!.id, at(MINUTE, OLD))).outcomeCode).toBe("sent");
    const before = (await itemsOf(c.caseId))[0]!;
    const { rows: eventsBefore } = await getMigratorPool().query(`select * from ops_approval_events where approval_id = $1 order by at, id`, [item!.id]);

    // 364 days on: kept. 366 days on: forgotten.
    expect(await forgetSupportReplyDrafts(at(364 * DAY, OLD))).toBe(0);
    expect((await itemsOf(c.caseId))[0]!.draft).not.toBeNull();
    expect(await forgetSupportReplyDrafts(at(366 * DAY, OLD))).toBeGreaterThanOrEqual(1);
    const after = (await itemsOf(c.caseId))[0]!;
    expect(after).toMatchObject({ status: before.status, outcome_code: before.outcome_code, draft: null, draft_hash: before.draft_hash });
    const { rows: eventsAfter } = await getMigratorPool().query(`select * from ops_approval_events where approval_id = $1 order by at, id`, [item!.id]);
    expect(eventsAfter).toEqual(eventsBefore);

    // A time ahead of the database's clock forgets nothing early.
    const FUTURE = new Date("2099-01-06T15:00:00Z");
    const f = await chatCase(a.clinicId, "sign_in", "passkey_problem", "2099-01-07", FUTURE);
    expect(await draft(f.caseId, BY_WEDNESDAY, FUTURE, "Wednesday 7 January 2099")).toMatchObject({ outcome: "drafted" });
    const [futureItem] = await itemsOf(f.caseId);
    await moveStatus(futureItem!.id, "waiting", "rejected", "rejected", SERVICE_ACTOR, at(MINUTE, FUTURE), { outcomeCode: "owner_rejected" });
    expect(await forgetSupportReplyDrafts(new Date("2101-01-01T00:00:00Z"))).toBe(0);
    expect((await getApproval(futureItem!.id))!.draft).not.toBeNull();

    // The nightly step runs both sweeps and says so.
    expect((await runSupportRetention(at(366 * DAY, OLD))).status).toBe("ok");
  });

  test("the words of a reply that never went are forgotten 12 months from the stop, in the row and in its approval item; one that is still trying keeps its words", async () => {
    const wordsOf = async (caseId: string) => {
      const { rows } = await getMigratorPool().query<{
        text: string | null;
        text_delete_after: Date | null;
        send_stopped_at: Date | null;
        send_stopped_reason: string | null;
        sent_at: Date | null;
      }>(
        `select text, text_delete_after, send_stopped_at, send_stopped_reason, sent_at from support_messages where case_id = $1 and kind = 'reply' and approved_at is not null`,
        [caseId],
      );
      return rows[0]!;
    };

    // A long-past clock, as the draft-forgetting test uses: the database never forgets a draft early by its own clock.
    const OLD = new Date("2024-03-05T15:00:00Z");
    // A reply whose first try failed, then its case was closed before the retry: stopped without going.
    const c = await chatCase(a.clinicId, "forwarding", "codes_not_working", "2024-03-06", OLD);
    await draft(c.caseId, BY_WEDNESDAY, OLD, "Wednesday 6 March 2024");
    const [item] = await itemsOf(c.caseId);
    send.mockResolvedValueOnce(DOWN);
    expect(ok<{ outcomeCode: string }>(await decide(item!.id, OLD)).outcomeCode).toBe("send_retrying");
    // Still trying: it keeps its words and has no deletion date (a CHECK holds that: a date needs a send or a stop).
    expect(await wordsOf(c.caseId)).toMatchObject({ text_delete_after: null, send_stopped_at: null });
    expect((await wordsOf(c.caseId)).text).not.toBeNull();
    await expect(
      getMigratorPool().query(`update support_messages set text_delete_after = now() where case_id = $1 and kind = 'reply'`, [c.caseId]),
    ).rejects.toThrow(/support_messages_send_check/);

    await closeSupportCase(c.caseId, "no_reply_needed", at(2 * MINUTE, OLD));
    await setJobEnabled(JOB_SUPPORT_SEND, true, a.userId);
    try {
      expect(await runSupportSendJob({ now: at(3 * MINUTE, OLD) })).toEqual({ status: "ok", note: "0 sent, 0 to try again, 1 stopped" });
    } finally {
      await setJobEnabled(JOB_SUPPORT_SEND, false, a.userId);
    }
    const stopped = await wordsOf(c.caseId);
    expect(stopped).toMatchObject({ send_stopped_reason: "case_closed", sent_at: null });
    expect(stopped.text).not.toBeNull();
    const stopAt = stopped.send_stopped_at!;
    expect(stopped.text_delete_after!.getTime() - stopAt.getTime()).toBe(365 * DAY);
    expect(replySends()).toHaveLength(1);

    // 364 days on: kept. 366 days on: the row's words and the approval item's copy are gone, and the rest stays.
    await sweepSentReplyText(new Date(stopAt.getTime() + 364 * DAY));
    expect((await wordsOf(c.caseId)).text).not.toBeNull();
    await sweepSentReplyText(new Date(stopAt.getTime() + 366 * DAY));
    expect(await wordsOf(c.caseId)).toMatchObject({ text: null, send_stopped_reason: "case_closed" });
    expect((await itemsOf(c.caseId))[0]!.draft).not.toBeNull();
    await forgetSupportReplyDrafts(new Date(stopAt.getTime() + 366 * DAY));
    expect((await itemsOf(c.caseId))[0]).toMatchObject({ draft: null, draft_hash: expect.stringMatching(/^[0-9a-f]{64}$/) });

    // A sent reply is unchanged by the wider rule: its date is 12 months from the send.
    const d = await chatCase(a.clinicId, "sign_in", "passkey_problem", "2024-03-06", OLD);
    await draft(d.caseId, BY_WEDNESDAY, OLD, "Wednesday 6 March 2024");
    const [sentItem] = await itemsOf(d.caseId);
    expect(ok<{ outcomeCode: string }>(await decide(sentItem!.id, at(10 * MINUTE, OLD))).outcomeCode).toBe("sent");
    const sent = await wordsOf(d.caseId);
    expect(sent.text_delete_after!.getTime() - sent.sent_at!.getTime()).toBe(365 * DAY);
  });

  test("the guard: only a support reply item's draft may go to NULL, with nothing else; no other kind, column or role", async () => {
    const c = await chatCase(a.clinicId);
    await draft(c.caseId);
    const [item] = await itemsOf(c.caseId);
    const m = getMigratorPool();
    // The runtime role cannot touch the draft at all.
    await expect(getAppPool().query(`update ops_approvals set draft = null where id = $1`, [item!.id])).rejects.toThrow(/permission denied/);
    // Nulling it together with any other column is refused, even for the owner role.
    for (const set of [`draft = null, draft_hash = null`, `draft = null, status = 'expired', decided_at = now()`, `draft = null, outcome_code = 'x'`, `draft = null, due_at = due_at + interval '1 day'`]) {
      await expect(m.query(`update ops_approvals set ${set} where id = $1`, [item!.id]), set).rejects.toThrow();
    }
    // Rewriting it is refused; and so is any other kind's draft going to NULL.
    await expect(m.query(`update ops_approvals set draft = '{"subject":"x","body":"y"}' where id = $1`, [item!.id])).rejects.toThrow(/fixed once made/);
    const { rows: other } = await m.query<{ id: string }>(
      `insert into ops_approvals (kind, subject_ref, payload, draft, draft_hash, due_at, urgency, proposed_by)
       values ('setup_help_offer', $1, '{}', '{"subject":"s","body":"b"}', repeat('a', 64), now() + interval '1 day', 'routine', 'ops-console') returning id`,
      [`wiring-other-${randomUUID().slice(0, 8)}`],
    );
    await expect(m.query(`update ops_approvals set draft = null where id = $1`, [other[0]!.id])).rejects.toThrow();
    await expect(m.query(`update ops_approvals set draft = null, draft_hash = null where id = $1`, [other[0]!.id])).rejects.toThrow(/fixed once made/);
    // The one allowed change, alone: it goes, and the hash stays.
    await m.query(`update ops_approvals set draft = null where id = $1`, [item!.id]);
    expect(await getApproval(item!.id)).toMatchObject({ draft: null, status: "waiting" });
    expect((await itemsOf(c.caseId))[0]!.draft_hash).toMatch(/^[0-9a-f]{64}$/);
    // Still never deleted.
    await expect(m.query(`delete from ops_approvals where id = $1`, [item!.id])).rejects.toThrow(/never deleted/);
    // The guard fires always, whatever the session's replication role.
    const { rows: trig } = await m.query<{ tgenabled: string }>(`select tgenabled from pg_trigger where tgname = 'ops_approvals_guard'`);
    expect(trig[0]!.tgenabled).toBe("A");
  });

  test("at the clinic's destruction its support reply items lose their words with it; another clinic's keep theirs", async () => {
    const { FORWARDING_PASS_THROUGH_DAYS } = await import("@healdesk/catalog");
    const { destroyDueClinics, markExportDelivered, startOffboarding } = await import("@/lib/offboarding/offboarding");
    const { withTenant } = await import("@/lib/tenant");
    const leaving = await provisionPortalClinic("wiring-leaving", { plan: "voice-webchat-500-300" });
    const staying = await provisionPortalClinic("wiring-staying", { plan: "voice-webchat-500-300" });
    const mine = await chatCase(leaving.clinicId);
    await draft(mine.caseId);
    const theirs = await chatCase(staying.clinicId);
    await draft(theirs.caseId);
    const [myItem] = await itemsOf(mine.caseId);
    const [theirItem] = await itemsOf(theirs.caseId);
    expect(myItem!.draft).not.toBeNull();

    await withTenant({ clinicId: leaving.clinicId, actor: ACTOR }, (tx) => startOffboarding(tx, "operator"));
    await withTenant({ clinicId: leaving.clinicId, actor: ACTOR }, (tx) => markExportDelivered(tx, "bundle handed over"));
    const secs = (FORWARDING_PASS_THROUGH_DAYS + 1) * 86_400;
    await getMigratorPool().query(
      `update clinics
          set offboarding_started_at = offboarding_started_at - make_interval(secs => $2),
              destroy_after = destroy_after - make_interval(secs => $2),
              export_delivered_at = export_delivered_at - make_interval(secs => $2)
        where id = $1`,
      [leaving.clinicId, secs],
    );
    expect((await destroyDueClinics()).filter((r) => r.clinicId === leaving.clinicId)).toHaveLength(1);

    const gone = await getApproval(myItem!.id);
    expect(gone).toMatchObject({ draft: null });
    expect(gone!.subjectClinicId).toBe(leaving.clinicId);
    expect((await getApproval(theirItem!.id))!.draft).toBe(theirItem!.draft);
  });
});
