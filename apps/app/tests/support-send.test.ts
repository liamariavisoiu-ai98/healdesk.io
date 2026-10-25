import { randomUUID } from "node:crypto";

import { SUPPORT_SIGN_OFF } from "@healdesk/catalog";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

import { APPROVAL_KINDS } from "@/db/schema";
import { draftHash, KIND_FAMILY, KIND_SPECS } from "@/lib/approvals/kinds";
import { serialiseDraft } from "@/lib/approvals/drafts";
import { proposeApprovals } from "@/lib/approvals/proposers";
import { endOfDayIn, parseSupportReplyPayload, sendSupportReply, supportReplyDueAt } from "@/lib/approvals/support-reply";
import { getApproval } from "@/lib/approvals/store";
import { DIRECT_KINDS, LEDGER_DIRECT_KINDS } from "@/lib/email/direct-kinds";
import { NOTICE_KINDS } from "@/lib/email/kinds";
import { assertPayloadAllowed, isApprovedReplyShape, linkProblems, PayloadNotAllowedError } from "@/lib/email/lint";
import { MAX_NOTICE_ATTEMPTS, RETRY_DELAYS_MINUTES } from "@/lib/email/outbox";
import { renderSupportReplyWith, SUPPORT_REPLY_ENTRY, SUPPORT_REPLY_REASON } from "@/lib/email/templates/support_reply";
import { isMutating, isOpName, type Operator } from "@/lib/ops/api";
import { opDecideApproval } from "@/lib/ops/approval-ops";
import { approvalSentence } from "@/lib/ops/inbox/approvals";
import { opPreviewSupportReply, opProposeSupportReply, opSaveSupportDraft } from "@/lib/ops/support-reply-ops";
import { closeSupportCase, recordChatEscalation } from "@/lib/support/cases";
import { retrySupportReplies, sweepSentReplyText } from "@/lib/support/send";
import { CHECKS_NOT_INSTALLED, installReplyChecks, runSupportReplyChecks, type ReplyCheckInput } from "@/lib/support/send-checks";
import { SUPPORT_REPLY_SUBJECTS, SUPPORT_SEND_MAX_ATTEMPTS, supportReplySubject } from "@/lib/support/send-vocab";

import { closePools, getAppPool, getMigratorPool, hasTestDatabase, runMigrations, truncateAll } from "./setup/db";
import { inTenant, seedClinic } from "./setup/factories";

/**
 * Approve and send a support reply (ops automation lane P7c; drizzle/0126;
 * owner decision D12): the one email kind whose body is prose. What is
 * proved here is what keeps it safe: prose refused on every other kind and
 * on a reply without its approval; the reply checks run again on the exact
 * text approved, refusing with the rule's name and never the words; a fresh
 * code required; the text sent exactly once, under one idempotency key,
 * retried on the outbox's schedule and stopped dead after six; nothing sent
 * once the case closed or a newer draft replaced it; and the record (both
 * hashes, the frozen text) immutable for every role.
 *
 * Lane P7b's eight checks are not on its branch yet, so the checker here is
 * a fake installed through installReplyChecks, keyed on fixed markers, one
 * rule per check 2 to 8; the send path's own floor (tone, copy, shape,
 * links) runs for real. Fixed dates throughout; the clock is passed in.
 */

vi.setConfig({ testTimeout: 90_000 });

const send = vi.fn();
vi.mock("resend", () => ({
  Resend: class {
    emails = { send };
  },
}));

const describeDb = hasTestDatabase ? describe : describe.skip;
const NOW = new Date("2026-10-14T15:00:00Z");
const REPLY_BY = "2026-10-15";
const MINUTE = 60_000;
const at = (ms: number) => new Date(NOW.getTime() + ms);
const OPERATOR: Operator = {
  email: "ops@healdesk.test",
  request: { requestId: randomUUID(), ipAddress: "203.0.113.9", userAgent: "vitest" },
};
const ACTOR = { type: "service", serviceName: "support-send-test" } as const;

const GOOD =
  "Hi, calls aren't reaching AYA yet because forwarding on your main line isn't set, so callers reach your line as before.\n\nThe codes are in Settings, under Channels. If they don't take, reply here and we'll call you on Monday.";

/** Checks 2 to 8 (design E5 §6), one marker each: the fake fails the check whose marker the text carries. */
const CHECK_MARKERS = [
  { id: "screen", marker: "MARK-SCREEN", rule: "Hides nothing the screen would hide" },
  { id: "names", marker: "MARK-NAME", rule: "Names no person" },
  { id: "clinical", marker: "MARK-CLINICAL", rule: "Says nothing clinical" },
  { id: "promises", marker: "MARK-PROMISE", rule: "Promises nothing a recorded action does not back" },
  { id: "claims", marker: "MARK-CLAIM", rule: "Makes no claim the product may not make" },
  { id: "shape", marker: "MARK-SHAPE", rule: "Six sentences, one question and one link at most" },
  { id: "other_clinics", marker: "MARK-OTHER", rule: "Names nothing of another case" },
] as const;

const seen: ReplyCheckInput[] = [];
function fakeChecks(input: ReplyCheckInput) {
  seen.push(input);
  const results = CHECK_MARKERS.map((c) => ({ id: c.id, ok: !input.text.includes(c.marker), rule: c.rule }));
  return { ok: results.every((r) => r.ok), results };
}

const ENV = ["HEALDESK_EMAIL_TRANSPORT", "RESEND_API_KEY", "HEALDESK_EMAIL_FROM", "BETTER_AUTH_URL", "HEALDESK_APP_URL", "HEALDESK_OPS_EMAIL", "SLACK_WEBHOOK_URL", "HEALDESK_OPS_PEOPLE"] as const;
const SAVED: Record<string, string | undefined> = {};
let keys = 0;
function saveEnv() {
  for (const key of ENV) SAVED[key] = process.env[key];
  process.env.HEALDESK_EMAIL_TRANSPORT = "resend";
  process.env.RESEND_API_KEY = `re_stub_${keys++}`;
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

// -----------------------------------------------------------------------------
// Pure: the payload class, the template, the subjects, the checks
// -----------------------------------------------------------------------------

const APPROVED = {
  caseId: "8b0c9d1e-2f3a-4b5c-8d6e-7f8091a2b3c4",
  messageId: "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
  supportRef: "HD-7F3KQ",
  topic: "forwarding",
  approvedReplyText: GOOD,
  approvedAt: "2026-10-14T15:00:00.000Z",
  approvedByLabel: SUPPORT_SIGN_OFF,
};

describe("the one prose class: approvedReplyText (D12)", () => {
  test("is refused on every other email kind, outbox or direct, at the top level and nested", () => {
    const others = [...NOTICE_KINDS, ...DIRECT_KINDS].filter((k) => k !== "support_reply");
    expect(others.length).toBeGreaterThan(80);
    for (const kind of others) {
      expect(() => assertPayloadAllowed({ approvedReplyText: GOOD }, kind), kind).toThrow(PayloadNotAllowedError);
      expect(() => assertPayloadAllowed({ approvedReplyText: GOOD }, kind), kind).toThrow(/prose/);
      expect(() => assertPayloadAllowed({ rows: [{ approvedReplyText: GOOD }] }, kind), kind).toThrow(PayloadNotAllowedError);
    }
    // And with no kind at all (an outbox payload checked before its kind is known).
    expect(() => assertPayloadAllowed({ approvedReplyText: GOOD })).toThrow(PayloadNotAllowedError);
    // Any other key holding the same prose is off the allowlist, as before, on every kind.
    for (const kind of [...others, "support_reply" as const]) {
      expect(() => assertPayloadAllowed({ body: GOOD }, kind), kind).toThrow(PayloadNotAllowedError);
      expect(() => assertPayloadAllowed({ text: GOOD }, kind), kind).toThrow(PayloadNotAllowedError);
    }
  });

  test("a support reply goes only with its approval: each of text, time, label and ref is required", () => {
    expect(() => assertPayloadAllowed(APPROVED, "support_reply")).not.toThrow();
    for (const key of ["approvedReplyText", "approvedAt", "approvedByLabel", "supportRef"] as const) {
      const without: Record<string, unknown> = { ...APPROVED };
      delete without[key];
      expect(() => assertPayloadAllowed(without, "support_reply"), key).toThrow(new RegExp(`"${key}"`));
    }
    expect(() => assertPayloadAllowed({ ...APPROVED, approvedAt: "yesterday" }, "support_reply")).toThrow(/approvedAt/);
    expect(() => assertPayloadAllowed({ ...APPROVED, supportRef: "HD-IL0O1" }, "support_reply")).toThrow(/supportRef/);
  });

  test("the class's own shape: no address, no phone-shaped number, no markup, never echoing the value", () => {
    for (const bad of ["Write to dana@clinic.test", "Call 555 123 4567 today", "See <b>this</b>", "", "x".repeat(1501), "a‮b"]) {
      expect(isApprovedReplyShape(bad), bad.slice(0, 20)).toBe(false);
      try {
        assertPayloadAllowed({ ...APPROVED, approvedReplyText: bad }, "support_reply");
        throw new Error("not refused");
      } catch (error) {
        expect(error).toBeInstanceOf(PayloadNotAllowedError);
        if (bad.length > 3) expect((error as Error).message).not.toContain(bad.slice(0, 12));
      }
    }
    expect(isApprovedReplyShape("$259 on 20 October, 1,500 minutes, step 3 of 4.")).toBe(true);
  });

  test("the link scanner: one link at most, and only into the portal", () => {
    vi.stubEnv("BETTER_AUTH_URL", "https://app.healdesk.test");
    const portal = "https://app.healdesk.test/c/glow/settings";
    expect(linkProblems({ subject: "", text: `Open ${portal}`, html: "" }, "support_reply")).toEqual([]);
    expect(linkProblems({ subject: "", text: `Open ${portal} and ${portal}/channels`, html: "" }, "support_reply")).toContain(
      "more than one link in a support reply",
    );
    expect(linkProblems({ subject: "", text: "Pay at https://invoice.stripe.com/i/acct_1", html: "" }, "support_reply")).toContain(
      "a link outside the portal in a support reply",
    );
    // The same Stripe link is still allowed on a billing kind.
    expect(linkProblems({ subject: "", text: "Pay at https://invoice.stripe.com/i/acct_1", html: "" }, "receipt")).toEqual([]);
    vi.unstubAllEnvs();
  });
});

describe("L37, the reply as the clinic reads it", () => {
  test("subjects come from a fixed list per topic, with the case's ref, never free text", () => {
    expect(Object.keys(SUPPORT_REPLY_SUBJECTS).sort()).toEqual(
      ["billing", "calendar", "channel", "forwarding", "other", "plan", "sign_in", "transcript"],
    );
    expect(supportReplySubject("forwarding", "HD-7F3KQ")).toBe("Re: Your call forwarding (ref HD-7F3KQ)");
    expect(supportReplySubject("not_a_topic", "HD-7F3KQ")).toBe("Re: Your question to healdesk (ref HD-7F3KQ)");
    for (const topic of Object.keys(SUPPORT_REPLY_SUBJECTS)) {
      expect(supportReplySubject(topic, "HD-ZZZZZ").length, topic).toBeLessThanOrEqual(70);
    }
  });

  test("the approved text, then the sign-off, the ref and the standard footer; no threading headers without an inbound id", () => {
    const r = renderSupportReplyWith("Re: Your call forwarding (ref HD-7F3KQ)")(SUPPORT_REPLY_ENTRY.fixture, {
      clinicName: "Radiance Med Spa",
      audience: "patients",
      reason: SUPPORT_REPLY_REASON,
      raisedAt: NOW,
      timeZone: "America/New_York",
    });
    const lines = r.text.split("\n");
    const signOff = lines.indexOf(SUPPORT_SIGN_OFF);
    expect(signOff).toBeGreaterThan(0);
    expect(r.text.indexOf(SUPPORT_REPLY_ENTRY.fixture.approvedReplyText.split("\n")[0]!)).toBe(0);
    expect(lines.slice(signOff).join("\n")).toContain("Your reference: HD-7F3KQ.");
    expect(r.text).toContain(SUPPORT_REPLY_REASON);
    expect(r.text).toContain("Replies reach the healdesk team. Please leave out patient details.");
    expect(r.text).not.toMatch(/Liam|Dana/);
    expect(r.subject).toBe("Re: Your call forwarding (ref HD-7F3KQ)");
  });
});

describe("the reply checks: P7b's eight plugged in, the send path's floor always on", () => {
  afterEach(() => installReplyChecks(null));

  test("fail closed while P7b's checks are not installed", async () => {
    installReplyChecks(null);
    const result = await runSupportReplyChecks({ text: GOOD, clinicName: null, ownCaseRef: "HD-7F3KQ", mode: "send" });
    expect(result.ok).toBe(false);
    expect(result.results).toContainEqual(CHECKS_NOT_INSTALLED);
  });

  test("a checker that throws or answers out of shape is a failure, never a pass", async () => {
    installReplyChecks(() => {
      throw new Error("boom");
    });
    expect((await runSupportReplyChecks({ text: GOOD, clinicName: null, ownCaseRef: "HD-7F3KQ", mode: "send" })).ok).toBe(false);
    installReplyChecks(() => ({ ok: true }) as never);
    expect((await runSupportReplyChecks({ text: GOOD, clinicName: null, ownCaseRef: "HD-7F3KQ", mode: "send" })).ok).toBe(false);
    installReplyChecks(() => ({ ok: false, results: [] }));
    expect((await runSupportReplyChecks({ text: GOOD, clinicName: null, ownCaseRef: "HD-7F3KQ", mode: "send" })).ok).toBe(false);
  });

  test("the floor names its rule and never the words: exclamation, a banned phrase, a claim, a treatment, two links", async () => {
    installReplyChecks(fakeChecks);
    for (const [text, id] of [
      ["Done!", "send_tone"],
      ["Unfortunately the calendar is off.", "send_tone"],
      ["Your revenue went up.", "send_copy"],
      ["Your Botox prices are set.", "send_copy"],
      ["See https://app.healdesk.test/a and https://app.healdesk.test/b", "send_links"],
      ["Write to dana@clinic.test", "send_shape"],
    ] as const) {
      vi.stubEnv("BETTER_AUTH_URL", "https://app.healdesk.test");
      const result = await runSupportReplyChecks({ text, clinicName: null, ownCaseRef: "HD-7F3KQ", mode: "send" });
      expect(result.ok, text).toBe(false);
      const failed = result.results.filter((c) => !c.ok);
      expect(failed.map((c) => c.id), text).toContain(id);
      for (const c of failed) expect(c.rule.toLowerCase(), text).not.toContain(text.toLowerCase().slice(0, 10));
    }
    vi.unstubAllEnvs();
  });

  test("the outbox's rule: six tries, the delays between them reused", () => {
    expect(SUPPORT_SEND_MAX_ATTEMPTS).toBe(MAX_NOTICE_ATTEMPTS);
    expect(RETRY_DELAYS_MINUTES.length).toBe(SUPPORT_SEND_MAX_ATTEMPTS - 1);
  });

  test("the item's kind: a fresh code, a draft, 14 days, the support family; its payload ids only", () => {
    expect(KIND_SPECS.support_reply_send).toMatchObject({ irreversible: true, hasDraft: true, expiryDays: 14, urgency: "routine" });
    expect(KIND_FAMILY.support_reply_send).toBe("support");
    const payload = { caseId: APPROVED.caseId, messageId: APPROVED.messageId, draftVersion: 2, ref: "7F3KQ" };
    expect(parseSupportReplyPayload(payload)).toEqual(payload);
    expect(parseSupportReplyPayload({ ...payload, text: "hi" })).toBeNull();
    expect(parseSupportReplyPayload({ ...payload, draftVersion: 0 })).toBeNull();
    expect(approvalSentence("support_reply_send", 1)).toBe("1 support reply is waiting for your yes.");
    expect(approvalSentence("support_reply_send", 3)).toBe("3 support replies are waiting for your yes.");
    for (const op of ["previewSupportReply", "saveSupportDraft", "proposeSupportReply"]) expect(isOpName(op), op).toBe(true);
    expect(isMutating("saveSupportDraft")).toBe(true);
    expect(isMutating("proposeSupportReply")).toBe(true);
    expect(isMutating("previewSupportReply")).toBe(false);
  });

  test("due by the end of the reply-by day in New York, at once for a `now` case", () => {
    expect(endOfDayIn("2026-10-15").toISOString()).toBe("2026-10-16T04:00:00.000Z");
    expect(endOfDayIn("2026-12-15").toISOString()).toBe("2026-12-16T05:00:00.000Z");
    expect(supportReplyDueAt({ urgency: "today", replyByOn: REPLY_BY }, NOW).toISOString()).toBe("2026-10-16T04:00:00.000Z");
    expect(supportReplyDueAt({ urgency: "now", replyByOn: REPLY_BY }, NOW).getTime()).toBe(NOW.getTime() + MINUTE);
  });
});

// -----------------------------------------------------------------------------
// Against the database
// -----------------------------------------------------------------------------

/** A clinic with a chat case on forwarding, as the chat's escalation writes one. */
async function chatCase(label: string, symptom = "codes_not_working") {
  const clinic = await seedClinic(label);
  const opened = await recordChatEscalation({
    clinicId: clinic.clinicId,
    actor: ACTOR,
    requestId: randomUUID(),
    fields: { topic: "forwarding", symptom, carrier: null, phoneSystem: null, mode: null, channel: null },
    replyByOn: REPLY_BY,
    now: NOW,
  });
  return { ...clinic, caseId: opened.caseId, ref: opened.ref };
}

function ok<T>(outcome: { status: number; body: unknown }): T {
  expect(outcome.status, JSON.stringify(outcome.body)).toBe(200);
  return (outcome.body as { data: T }).data;
}

async function replyRow(caseId: string) {
  const { rows } = await getMigratorPool().query<Record<string, unknown>>(
    `select * from support_messages where case_id = $1 and kind = 'reply' order by created_at desc, id desc limit 1`,
    [caseId],
  );
  return rows[0]!;
}

async function caseRow(caseId: string) {
  const { rows } = await getMigratorPool().query<Record<string, unknown>>(`select * from support_cases where id = $1`, [caseId]);
  return rows[0]!;
}

async function events(approvalId: string) {
  const { rows } = await getMigratorPool().query<{ event: string; draft_hash_approved: string | null; draft_hash_sent: string | null; outcome_code: string | null; actor_label: string }>(
    `select event, draft_hash_approved, draft_hash_sent, outcome_code, actor_label from ops_approval_events where approval_id = $1 order by at, id`,
    [approvalId],
  );
  return rows;
}

/** The sends Resend was asked for, of support replies only. */
function replySends() {
  return send.mock.calls.filter(([payload]) =>
    ((payload as { tags?: { name: string; value: string }[] }).tags ?? []).some((t) => t.name === "kind" && t.value === "support_reply"),
  );
}

const SENT = { data: { id: "re_msg_1" }, error: null, headers: {} };
const DOWN = { data: null, error: { name: "application_error", message: "down", statusCode: 500 }, headers: {} };

async function saveAndPropose(caseId: string, text: string, now = NOW) {
  return ok<{ approvalId: string | null; draftVersion: number; state: string; ok: boolean; failed: string[] }>(
    await opSaveSupportDraft({ caseId, text }, OPERATOR, now),
  );
}

function decide(id: string, extra: Record<string, unknown> = {}, now = at(10 * MINUTE)) {
  return opDecideApproval({ id, action: "approve", reasonCode: "owner_checked", codeChecked: true, ...extra }, OPERATOR, { now });
}

describeDb("approve and send a support reply (drizzle/0126)", () => {
  beforeAll(async () => {
    await runMigrations();
    await truncateAll();
  }, 180_000);

  beforeEach(() => {
    saveEnv();
    send.mockReset();
    send.mockResolvedValue(SENT);
    seen.length = 0;
    installReplyChecks(fakeChecks);
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    installReplyChecks(null);
    restoreEnv();
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await closePools();
  });

  test("the CHECKs take the new kinds only, and ops_approvals' lists every kind", async () => {
    const { rows } = await getMigratorPool().query<{ name: string; def: string }>(
      `select conname as name, pg_get_constraintdef(oid) as def from pg_constraint
        where conname in ('ops_approvals_kind_check', 'report_deliveries_kind_check')`,
    );
    const def = (name: string) => rows.find((r) => r.name === name)!.def;
    const listed = [...def("ops_approvals_kind_check").matchAll(/'([a-z_]+)'::text/g)].map((m) => m[1]).sort();
    expect(listed).toEqual([...APPROVAL_KINDS].sort());
    expect(listed).toContain("support_reply_send");
    expect(def("report_deliveries_kind_check")).toContain("'support_reply'::text");
    for (const kind of LEDGER_DIRECT_KINDS) expect(def("report_deliveries_kind_check"), kind).toContain(`'${kind}'::text`);
    await expect(
      getMigratorPool().query(
        `insert into ops_approvals (kind, subject_ref, payload, due_at, urgency, proposed_by) values ('support_reply', 'x', '{}', now(), 'routine', 'ops-console')`,
      ),
    ).rejects.toThrow(/ops_approvals_kind_check/);
  });

  test("a passing draft is proposed with ids only and the reply as its draft; approving sends it once, with both hashes kept", async () => {
    const c = await chatCase("send-once");
    const saved = await saveAndPropose(c.caseId, GOOD);
    expect(saved).toMatchObject({ state: "drafted", ok: true, failed: [], draftVersion: 1 });
    expect(saved.approvalId).not.toBeNull();
    const item = (await getApproval(saved.approvalId!))!;
    expect(item.kind).toBe("support_reply_send");
    expect(Object.keys(item.payload).sort()).toEqual(["caseId", "draftVersion", "messageId", "ref"]);
    expect(JSON.stringify(item.payload)).not.toContain("forwarding on your main line");
    const subject = `Re: Your call forwarding (ref HD-${c.ref})`;
    expect(JSON.parse(item.draft!)).toEqual({ subject, body: GOOD });
    expect(item.dueAt.toISOString()).toBe("2026-10-16T04:00:00.000Z");
    // The checks ran with this case's ref and the clinic's name, in draft mode.
    expect(seen.at(-1)).toMatchObject({ ownCaseRef: `HD-${c.ref}`, mode: "draft", clinicName: "send-once Clinic" });

    const decided = ok<{ status: string; outcomeCode: string }>(await decide(item.id));
    expect(decided).toMatchObject({ status: "executed", outcomeCode: "sent" });
    expect(seen.at(-1)).toMatchObject({ mode: "send", text: GOOD });

    const sends = replySends();
    expect(sends).toHaveLength(1);
    const [payload, options] = sends[0]! as [Record<string, unknown>, { idempotencyKey: string }];
    const row = await replyRow(c.caseId);
    expect(options.idempotencyKey).toBe(`hd-support_reply-${row.id}-1`);
    expect(payload.to).toBe(c.staffEmail);
    expect(payload.subject).toBe(subject);
    expect(String(payload.text)).toContain(GOOD.split("\n")[0]);
    expect(String(payload.text)).toContain(SUPPORT_SIGN_OFF);

    // The record: text frozen, both hashes equal to the hash of what went.
    const hash = draftHash(serialiseDraft({ subject, body: GOOD }));
    expect(row).toMatchObject({ text: GOOD, reply_subject: subject, approved_hash: hash, approved_by_label: SUPPORT_SIGN_OFF, send_attempts: 1 });
    expect(row.sent_at).not.toBeNull();
    expect(row.delivery_id).not.toBeNull();
    const ev = await events(item.id);
    expect(ev.map((e) => e.event)).toEqual(["proposed", "approved", "executed"]);
    expect(ev.find((e) => e.event === "approved")!.draft_hash_approved).toBe(hash);
    expect(ev.find((e) => e.event === "executed")!.draft_hash_sent).toBe(hash);
    expect(ev[0]!.actor_label).toBe(OPERATOR.email);
    // The ledger row the webhook relay marks, and the case now waits on the clinic.
    const { rows: ledger } = await inTenant(c.clinicId, (client) =>
      client.query(`select status, period_key from report_deliveries where id = $1`, [row.delivery_id]),
    );
    expect(ledger[0]).toMatchObject({ status: "sent", period_key: row.id });
    expect(await caseRow(c.caseId)).toMatchObject({ state: "waiting_clinic" });
    expect((await caseRow(c.caseId)).last_outbound_at).not.toBeNull();

    // A second decision on the same item, and the executor run again: nothing more goes.
    expect(ok<{ status: string }>(await decide(item.id))).toMatchObject({ status: "error" });
    expect((await sendSupportReply((await getApproval(item.id))!, { subject, body: GOOD }, at(20 * MINUTE))).outcomeCode).toBe(
      "no_longer_needed",
    );
    expect(replySends()).toHaveLength(1);
  });

  test("the owner's edit is checked again on exactly the edited text, and sent with its own hash", async () => {
    const c = await chatCase("send-edit");
    const saved = await saveAndPropose(c.caseId, GOOD);
    const item = (await getApproval(saved.approvalId!))!;
    const subject = `Re: Your call forwarding (ref HD-${c.ref})`;
    const edited = `${GOOD}\n\nThanks for catching this.`;
    expect(ok<{ status: string; outcomeCode: string }>(await decide(item.id, { editedDraft: { subject, body: edited } }))).toMatchObject({
      status: "executed",
      outcomeCode: "sent",
    });
    expect(seen.at(-1)).toMatchObject({ mode: "send", text: edited });
    const hash = draftHash(serialiseDraft({ subject, body: edited }));
    const ev = await events(item.id);
    expect(ev.map((e) => e.event)).toEqual(["proposed", "edited", "approved", "executed"]);
    expect(ev.find((e) => e.event === "executed")!.draft_hash_sent).toBe(hash);
    expect(ev.find((e) => e.event === "approved")!.draft_hash_approved).toBe(hash);
    expect((await replyRow(c.caseId)).text).toBe(edited);
  });

  test.each(CHECK_MARKERS.map((c) => [c.id, c.marker, c.rule]))(
    "check %s stops a Send: refused with the rule's name, never the words, and nothing goes",
    async (_id, marker, rule) => {
      const c = await chatCase(`send-check-${_id}`);
      const saved = await saveAndPropose(c.caseId, GOOD);
      const subject = `Re: Your call forwarding (ref HD-${c.ref})`;
      const edited = `${GOOD} ${marker} secret words.`;
      const decided = ok<{ status: string; outcomeCode: string; message: string }>(
        await decide(saved.approvalId!, { editedDraft: { subject, body: edited } }),
      );
      expect(decided).toMatchObject({ status: "failed", outcomeCode: "checks_failed" });
      expect(decided.message).toContain(rule);
      expect(decided.message).not.toContain("secret words");
      expect(decided.message).not.toContain(marker);
      expect(replySends()).toHaveLength(0);
      const row = await replyRow(c.caseId);
      expect(row).toMatchObject({ approved_at: null, text: null, sent_at: null });
    },
  );

  test("a draft that fails a check is saved as needs_edit and never proposed; the preview names the rule only", async () => {
    const c = await chatCase("send-needs-edit");
    const saved = await saveAndPropose(c.caseId, `${GOOD} MARK-NAME Dana`);
    expect(saved).toMatchObject({ state: "needs_edit", ok: false, approvalId: null });
    expect(saved.failed).toEqual(["Names no person"]);
    const { rows } = await getMigratorPool().query(`select count(*)::int as n from ops_approvals where kind = 'support_reply_send' and subject_ref like $1`, [
      `${(await replyRow(c.caseId)).id}:%`,
    ]);
    expect(rows[0].n).toBe(0);
    const preview = ok<{ ok: boolean; failed: string[]; checks: { id: string; ok: boolean; rule: string }[] }>(
      await opPreviewSupportReply({ caseId: c.caseId, text: "Great news!" }, OPERATOR),
    );
    expect(preview.ok).toBe(false);
    expect(preview.failed).toContain("No exclamation mark, no emoji and none of the banned phrases");
    expect(JSON.stringify(preview)).not.toContain("Great news");
    // Propose refuses it too, naming the rule.
    const proposal = ok<{ outcome: string; failed: string[] }>(await opProposeSupportReply({ caseId: c.caseId }, OPERATOR, NOW));
    expect(proposal).toMatchObject({ outcome: "checks_failed", failed: ["Names no person"] });
    // An edit that passes is the next version, proposed.
    const next = await saveAndPropose(c.caseId, GOOD, at(MINUTE));
    expect(next).toMatchObject({ state: "drafted", draftVersion: 2, ok: true });
    expect(next.approvalId).not.toBeNull();
  });

  test("a newer draft replaces the waiting item; the stale version sends nothing", async () => {
    const c = await chatCase("send-stale");
    const first = await saveAndPropose(c.caseId, GOOD);
    const old = (await getApproval(first.approvalId!))!;
    const second = await saveAndPropose(c.caseId, `${GOOD}\n\nOne more line.`, at(MINUTE));
    expect(second.draftVersion).toBe(2);
    expect((await getApproval(old.id))!).toMatchObject({ status: "expired", outcomeCode: "no_longer_needed" });
    // The stale item's executor, run directly, finds a newer version and sends nothing.
    const result = await sendSupportReply(old, JSON.parse(old.draft!), at(2 * MINUTE));
    expect(result.outcomeCode).toBe("no_longer_needed");
    expect(replySends()).toHaveLength(0);
  });

  test("a case closed meanwhile sends nothing, and the approvals job takes its item off the list", async () => {
    const c = await chatCase("send-closed");
    const saved = await saveAndPropose(c.caseId, GOOD);
    await closeSupportCase(c.caseId, "replied_by_hand", at(MINUTE));
    expect(ok<{ status: string; outcomeCode: string }>(await decide(saved.approvalId!))).toMatchObject({
      status: "failed",
      outcomeCode: "no_longer_needed",
    });
    expect(replySends()).toHaveLength(0);
    const c2 = await chatCase("send-closed-sweep");
    const saved2 = await saveAndPropose(c2.caseId, GOOD);
    await closeSupportCase(c2.caseId, "duplicate", at(MINUTE));
    await proposeApprovals(at(2 * MINUTE));
    expect((await getApproval(saved2.approvalId!))!).toMatchObject({ status: "expired", outcomeCode: "no_longer_needed" });
  });

  test("the fresh code is required: without its mark nothing is decided or sent", async () => {
    const c = await chatCase("send-code");
    const saved = await saveAndPropose(c.caseId, GOOD);
    const refused = ok<{ status: string; message: string }>(
      await opDecideApproval({ id: saved.approvalId!, action: "approve", reasonCode: "owner_checked" }, OPERATOR, { now: at(MINUTE) }),
    );
    expect(refused).toMatchObject({ status: "error" });
    expect(refused.message).toMatch(/authenticator/);
    expect((await getApproval(saved.approvalId!))!.status).toBe("waiting");
    expect(replySends()).toHaveLength(0);
  });

  test("the subject cannot be edited: refused, nothing sent", async () => {
    const c = await chatCase("send-subject");
    const saved = await saveAndPropose(c.caseId, GOOD);
    const decided = ok<{ status: string; outcomeCode: string }>(
      await decide(saved.approvalId!, { editedDraft: { subject: "Re: something else", body: GOOD } }),
    );
    expect(decided).toMatchObject({ status: "failed", outcomeCode: "subject_changed" });
    expect(replySends()).toHaveLength(0);
  });

  test("a failed try is retried on the outbox's schedule under the same key, and dead after six with one alert", async () => {
    const c = await chatCase("send-retry");
    const saved = await saveAndPropose(c.caseId, GOOD);
    send.mockResolvedValue(DOWN);
    const decided = ok<{ status: string; outcomeCode: string }>(await decide(saved.approvalId!, {}, NOW));
    expect(decided).toMatchObject({ status: "executed", outcomeCode: "send_retrying" });
    let row = await replyRow(c.caseId);
    expect(row).toMatchObject({ send_attempts: 1, sent_at: null });
    expect(new Date(String(row.next_send_at)).getTime()).toBe(NOW.getTime() + MINUTE);
    // Not due before its delay.
    expect(await retrySupportReplies(at(30_000))).toEqual({ sent: 0, retrying: 0, stopped: 0 });
    let t = NOW.getTime();
    for (const [i, delay] of RETRY_DELAYS_MINUTES.entries()) {
      t += delay * MINUTE;
      const outcome = await retrySupportReplies(new Date(t));
      row = await replyRow(c.caseId);
      if (i < RETRY_DELAYS_MINUTES.length - 1) {
        expect(outcome).toEqual({ sent: 0, retrying: 1, stopped: 0 });
        expect(row.send_attempts).toBe(i + 2);
      } else {
        expect(outcome).toEqual({ sent: 0, retrying: 0, stopped: 1 });
      }
    }
    expect(row).toMatchObject({ send_attempts: 6, send_stopped_reason: "dead", sent_at: null, next_send_at: null });
    const keysUsed = new Set(replySends().map(([, o]) => (o as { idempotencyKey: string }).idempotencyKey));
    expect([...keysUsed]).toEqual([`hd-support_reply-${row.id}-1`]);
    expect(replySends()).toHaveLength(6);
    const { rows: alerts } = await getMigratorPool().query(
      `select count(*)::int as n from ops_alerts where event = 'support_reply_dead' and fields->>'clinicId' = $1`,
      [c.clinicId],
    );
    expect(alerts[0].n).toBe(1);
    // Stopped is stopped: nothing more is tried.
    expect(await retrySupportReplies(new Date(t + 24 * 60 * MINUTE))).toEqual({ sent: 0, retrying: 0, stopped: 0 });
  });

  test("a retry that goes through records the send; a retry after the case closed sends nothing", async () => {
    const c = await chatCase("send-retry-ok");
    const saved = await saveAndPropose(c.caseId, GOOD);
    send.mockResolvedValueOnce(DOWN);
    await decide(saved.approvalId!, {}, NOW);
    expect(await retrySupportReplies(at(MINUTE))).toEqual({ sent: 1, retrying: 0, stopped: 0 });
    expect(await replyRow(c.caseId)).toMatchObject({ send_attempts: 2 });
    expect((await replyRow(c.caseId)).sent_at).not.toBeNull();
    expect(replySends()).toHaveLength(2);

    const c2 = await chatCase("send-retry-closed");
    const saved2 = await saveAndPropose(c2.caseId, GOOD);
    send.mockResolvedValueOnce(DOWN);
    await decide(saved2.approvalId!, {}, NOW);
    await closeSupportCase(c2.caseId, "replied_by_hand", at(30_000));
    const before = replySends().length;
    await retrySupportReplies(at(MINUTE));
    expect(replySends()).toHaveLength(before);
    expect(await replyRow(c2.caseId)).toMatchObject({ send_stopped_reason: "case_closed", sent_at: null });
  });

  test("nothing is proposed or sent while P7b's checks are not installed", async () => {
    installReplyChecks(null);
    const c = await chatCase("send-uninstalled");
    const saved = await saveAndPropose(c.caseId, GOOD);
    expect(saved).toMatchObject({ state: "needs_edit", approvalId: null, ok: false });
    expect(saved.failed).toContain(CHECKS_NOT_INSTALLED.rule);
  });

  test("the record is immutable for every role: approved text, subject, hash and label fixed; the text may only be deleted", async () => {
    const c = await chatCase("send-immutable");
    const saved = await saveAndPropose(c.caseId, GOOD);
    await decide(saved.approvalId!);
    const row = await replyRow(c.caseId);
    for (const pool of [getAppPool(), getMigratorPool()]) {
      for (const set of [
        `text = 'rewritten'`,
        `reply_subject = 'Re: other'`,
        `approved_hash = repeat('0', 64)`,
        `approved_by_label = 'Someone'`,
        `draft_text = 'other'`,
        `sent_at = now()`,
      ]) {
        await expect(pool.query(`update support_messages set ${set} where id = $1`, [row.id]), set).rejects.toThrow();
      }
    }
    await expect(getAppPool().query(`delete from support_messages where id = $1`, [row.id])).rejects.toThrow(/permission denied/);
    // A reply is born a draft: no text, approval or send on insert.
    await expect(
      getMigratorPool().query(
        `insert into support_messages (case_id, direction, kind, text) values ($1, 'out', 'reply', 'hi')`,
        [c.caseId],
      ),
    ).rejects.toThrow();
    // The 12-month sweep deletes the text, and only after 12 months.
    expect(await sweepSentReplyText(at(364 * 24 * 60 * MINUTE))).toBe(0);
    expect(await sweepSentReplyText(at(366 * 24 * 60 * MINUTE))).toBeGreaterThanOrEqual(1);
    const swept = await replyRow(c.caseId);
    expect(swept).toMatchObject({ text: null, approved_hash: row.approved_hash, reply_subject: row.reply_subject });
    expect(swept.sent_at).not.toBeNull();
  });

  test("a reply goes only on a case with a clinic that wrote first, to its one address", async () => {
    const c = await chatCase("send-address");
    const saved = await saveAndPropose(c.caseId, GOOD);
    // The sign-in revoked: no address left, so nothing goes.
    await inTenant(c.clinicId, (client) =>
      client.query(`update clinic_memberships set revoked_at = now() where clinic_id = $1`, [c.clinicId]),
    );
    const decided = ok<{ status: string; outcomeCode: string }>(await decide(saved.approvalId!));
    expect(decided).toMatchObject({ status: "failed", outcomeCode: "clinic_left" });
    expect(replySends()).toHaveLength(0);
  });
});
