import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

/**
 * The clinic-contact approvals' apps/web side (ops automation lane P6f;
 * apps/app lib/ops/resign-ops.ts, lib/ops/notice-ops.ts, lib/approvals/
 * contact-*.ts), against a stubbed upstream: each call sends exactly the op
 * and args apps/app reads; each answer is read strictly, so a field apps/app
 * does not send or a code off its list is a malformed answer; an edit
 * crosses as closed fields only, never text; and the agreement answer goes
 * only through its fresh-code wrapper. The signing, the transport, the
 * readers and the fresh-code check are the real ones.
 */

const session = vi.hoisted(() => ({ operator: "ops@healdesk.test" as string | null }));
vi.mock("@/lib/admin/operator", () => ({ requireOperator: async () => session.operator }));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "user-agent": "vitest", "x-forwarded-for": "203.0.113.9" }),
}));

import { recordAgreementAnswerWithCode, setCoveredEntityWithCode } from "@/lib/admin/agreement-answer";
import { decideApprovalWithCode } from "@/lib/admin/approval-decide";
import {
  fetchApprovals,
  fetchOpenResigns,
  previewApprovalDraft,
  proposeAgreementQuestion,
  proposeLifecycleNotice,
  pullReminderForward,
} from "@/lib/admin/ops-client";
import { __resetStepLedgerForTests, base32Decode, hotp, totpStep } from "@/lib/admin/totp";

const CLINIC = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
const ITEM = "5c0ffee0-1111-4c2a-9a8b-1f2e3d4c5b6a";
const RESIGN = "7d1e2f30-2222-4b3c-8d4e-5f6a7b8c9d0e";
const REVIEW = "9a8b7c6d-1111-4222-8333-444455556666";
const SECRET = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";
const MALFORMED = { ok: false, code: "malformed" };

let replies: unknown[] = [];
let sent: { op: string; args: Record<string, unknown> }[] = [];
const reply = (data: unknown) => replies.push({ data });

beforeEach(() => {
  replies = [];
  sent = [];
  session.operator = "ops@healdesk.test";
  __resetStepLedgerForTests();
  vi.stubEnv("HEALDESK_PROVISION_SECRET", "test-provision-secret");
  vi.stubEnv("HEALDESK_APP_URL", "http://ops.internal.test");
  vi.stubEnv("HEALDESK_ADMIN_TOTP_SECRET", SECRET);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: unknown, init: { body: string }) => {
      const envelope = JSON.parse(init.body) as { op: string; args: Record<string, unknown> };
      sent.push({ op: envelope.op, args: envelope.args });
      const next = replies.shift();
      if (next === undefined) throw new Error("no stubbed reply");
      return new Response(JSON.stringify(next), { status: 200, headers: { "content-type": "application/json" } });
    }),
  );
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const fresh = () => hotp(base32Decode(SECRET)!, totpStep(Date.now()));

const RESIGN_ROW = {
  resignId: RESIGN,
  clinic: { id: CLINIC, name: "Radiance Med Spa" },
  reason: "baa_version",
  fromVersion: "1.5.0",
  toVersion: "1.6.0",
  startedAt: "2026-10-15T16:00:00.000Z",
  lastL22SentAt: "2026-10-22T16:00:00.000Z",
  daysOpen: 9,
  linkExpiresAt: "2026-11-05T16:00:00.000Z",
  belowFloor: true,
  fromVersionAcceptable: false,
  holdsPause: false,
  lastChaseAt: null,
  chaseBlocked: null,
};

const CHASE_ITEM = {
  id: ITEM,
  kind: "baa_resign_chase",
  clinic: { id: CLINIC, name: "Radiance Med Spa" },
  subjectRef: `${RESIGN}:1`,
  urgency: "routine",
  status: "waiting",
  proposedAt: "2026-10-24T16:00:00.000Z",
  dueAt: "2026-10-26T16:00:00.000Z",
  expiresAt: "2026-11-07T16:00:00.000Z",
  decidedAt: null,
  outcomeCode: null,
  pastDue: false,
  irreversible: true,
  operation: "sendResignChase",
  hasDraft: true,
  packet: {
    operation: "sendResignChase",
    irreversible: true,
    stillNeeded: true,
    effect: "Emails the clinic a fresh link to sign version 1.6.0 of the business associate agreement, made when it is sent.",
    facts: {
      kind: "baa_resign_chase",
      resignId: RESIGN,
      fromVersion: "1.5.0",
      toVersion: "1.6.0",
      startedAt: "2026-10-15T16:00:00.000Z",
      daysOpen: 9,
      lastL22SentAt: "2026-10-22T16:00:00.000Z",
      linkExpiresAt: "2026-11-05T16:00:00.000Z",
      lastChaseAt: null,
      belowFloor: true,
      fromVersionAcceptable: false,
      isAnswering: true,
      blocked: null,
      callFirst: true,
      publishedPhoneE164: "+18885550100",
    },
    draft: {
      subject: "Your updated business associate agreement is waiting",
      body: "Hi Radiance Med Spa team, version 1.6.0 of our business associate agreement is ready for your signature.\n\nOpen, read and sign: [a fresh signing link, made when this email is sent]",
    },
    editable: [{ field: "note", type: "choice", options: ["call_offer", "thanks"], optional: true }],
    fields: { note: null },
  },
};

describe("the reads", () => {
  test("fetchOpenResigns reads every field strictly", async () => {
    reply({ resigns: [RESIGN_ROW], unread: 0 });
    expect(await fetchOpenResigns()).toEqual({ ok: true, data: { resigns: [RESIGN_ROW], unread: 0 } });
    expect(sent).toEqual([{ op: "listOpenResigns", args: {} }]);
    for (const row of [
      { ...RESIGN_ROW, reason: "pause" },
      { ...RESIGN_ROW, fromVersion: "one" },
      { ...RESIGN_ROW, chaseBlocked: "because" },
      { ...RESIGN_ROW, signUrl: "https://app.healdesk.test/agreement/x" },
      { ...RESIGN_ROW, clinic: null },
    ]) {
      reply({ resigns: [row], unread: 0 });
      expect(await fetchOpenResigns()).toMatchObject(MALFORMED);
    }
  });

  test("a contact item's packet carries its draft, editable fields and values, and nothing else", async () => {
    reply({ items: [CHASE_ITEM], partial: [] });
    const read = await fetchApprovals();
    expect(read).toMatchObject({ ok: true });
    if (!read.ok) throw new Error("read failed");
    const packet = read.data.items[0]!.packet!;
    expect(packet.contact).toEqual({ draft: CHASE_ITEM.packet.draft, editable: CHASE_ITEM.packet.editable, fields: { note: null } });
    expect(packet.contact!.draft!.body).toContain("\n\n");
    for (const bad of [
      { ...CHASE_ITEM.packet, fields: { note: null, body: "free text" } },
      { ...CHASE_ITEM.packet, editable: [{ field: "body", type: "text" }] },
      { ...CHASE_ITEM.packet, editable: [{ field: "note", type: "choice", options: ["anything"], optional: true }] },
      { ...CHASE_ITEM.packet, facts: { ...CHASE_ITEM.packet.facts, blocked: "nope" } },
      { ...CHASE_ITEM.packet, draft: { subject: "s", body: "b", html: "<p>" } },
    ]) {
      reply({ items: [{ ...CHASE_ITEM, packet: bad }], partial: [] });
      expect(await fetchApprovals(), JSON.stringify(bad).slice(0, 80)).toMatchObject(MALFORMED);
    }
  });

  test("previewApprovalDraft sends the closed fields only and reads a preview or its problems", async () => {
    reply({ status: "preview", draft: { subject: "More time to finish setting up AYA", body: "We've given you 10 more days." }, editable: [] });
    expect(await previewApprovalDraft(ITEM, { days: 10, note: "thanks" })).toMatchObject({ ok: true, data: { status: "preview" } });
    reply({ status: "problems", problems: ["the days must be a whole number from 1 to 30"] });
    expect(await previewApprovalDraft(ITEM, { days: 40 })).toEqual({
      ok: true,
      data: { status: "problems", problems: ["the days must be a whole number from 1 to 30"] },
    });
    expect(sent).toEqual([
      { op: "previewApprovalDraft", args: { id: ITEM, fields: { days: 10, note: "thanks" } } },
      { op: "previewApprovalDraft", args: { id: ITEM, fields: { days: 40 } } },
    ]);
    // A caller's extra key never crosses.
    reply({ status: "refused", message: "No such approval." });
    await previewApprovalDraft(ITEM, { note: null, body: "typed" } as never);
    expect(sent[2]!.args).toEqual({ id: ITEM, fields: { note: null } });
  });
});

describe("the buttons only propose", () => {
  test("each sends exactly its args and reads proposed or refused", async () => {
    reply({ status: "proposed", approvalId: ITEM });
    expect(await proposeAgreementQuestion(CLINIC, REVIEW)).toEqual({ ok: true, data: { status: "proposed", approvalId: ITEM } });
    reply({ status: "proposed", approvalId: ITEM });
    await proposeLifecycleNotice({ clinicId: CLINIC, kind: "setup_extended", days: 14 });
    reply({ status: "refused", message: "This email has already gone for this stage, so it is not offered again." });
    expect(await proposeLifecycleNotice({ clinicId: CLINIC, kind: "setup_help_offer", phrase: "phone", note: "thanks" })).toEqual({
      ok: true,
      data: { status: "refused", message: "This email has already gone for this stage, so it is not offered again." },
    });
    reply({ status: "proposed", approvalId: ITEM, reminderNumber: 3, normallyDueOn: "2026-11-01" });
    expect(await pullReminderForward(CLINIC)).toEqual({
      ok: true,
      data: { status: "proposed", approvalId: ITEM, reminderNumber: 3, normallyDueOn: "2026-11-01" },
    });
    expect(sent).toEqual([
      { op: "proposeAgreementQuestion", args: { clinicId: CLINIC, reviewId: REVIEW } },
      { op: "proposeLifecycleNotice", args: { clinicId: CLINIC, kind: "setup_extended", days: 14 } },
      { op: "proposeLifecycleNotice", args: { clinicId: CLINIC, kind: "setup_help_offer", phrase: "phone", note: "thanks" } },
      { op: "pullReminderForward", args: { clinicId: CLINIC } },
    ]);
    reply({ status: "sent", approvalId: ITEM });
    expect(await proposeAgreementQuestion(CLINIC, REVIEW)).toMatchObject(MALFORMED);
    reply({ status: "proposed", approvalId: ITEM, extra: true });
    expect(await proposeAgreementQuestion(CLINIC, REVIEW)).toMatchObject(MALFORMED);
  });
});

describe("the edits and the answer", () => {
  test("an edit to a contact item crosses as its closed fields alone", async () => {
    reply({ status: "executed", outcomeCode: "sent", message: null, auditRecorded: true });
    await decideApprovalWithCode(ITEM, "approve", "owner_checked", fresh(), { fields: { note: "thanks", body: "typed" } as never });
    expect(sent[0]!.args.editedDraft).toEqual({ fields: { note: "thanks" } });
  });

  test("the agreement answer needs a fresh code, sends the mark and never the code", async () => {
    for (const code of ["000000", undefined]) {
      expect(await recordAgreementAnswerWithCode(CLINIC, REVIEW, "yes", code)).toMatchObject({ ok: true, data: { status: "code_refused" } });
    }
    expect(await recordAgreementAnswerWithCode(CLINIC, REVIEW, "maybe" as never, fresh())).toMatchObject({ ok: true, data: { status: "refused" } });
    session.operator = null;
    expect(await recordAgreementAnswerWithCode(CLINIC, REVIEW, "yes", fresh())).toMatchObject({ ok: false, code: "unauthenticated" });
    expect(sent).toEqual([]);
    session.operator = "ops@healdesk.test";
    reply({ status: "recorded", agreementKind: "baa", isCoveredEntity: true, covered: true, supersedeStarted: true, linkSent: true, auditRecorded: true });
    const code = fresh();
    expect(await recordAgreementAnswerWithCode(CLINIC, REVIEW, "yes", code)).toMatchObject({ ok: true, data: { status: "recorded", supersedeStarted: true } });
    expect(sent).toEqual([{ op: "recordAgreementAnswer", args: { clinicId: CLINIC, reviewId: REVIEW, answer: "yes", codeChecked: true, codeKind: "authenticator" } }]);
    expect(JSON.stringify(sent)).not.toContain(code);
  });

  test("the covered-entity answer from the Account tab needs a fresh code too, and sends the mark", async () => {
    expect(await setCoveredEntityWithCode(CLINIC, "yes", "000000")).toMatchObject({ ok: true, data: { status: "code_refused" } });
    expect(sent).toEqual([]);
    reply({ status: "recorded", agreementKind: "dpa", isCoveredEntity: true, covered: false, supersedeStarted: true, linkSent: true, auditRecorded: true });
    expect(await setCoveredEntityWithCode(CLINIC, "not_sure", fresh())).toMatchObject({ ok: true, data: { status: "recorded" } });
    expect(sent).toEqual([{ op: "setCoveredEntity", args: { clinicId: CLINIC, answer: "not_sure", codeChecked: true, codeKind: "authenticator" } }]);
  });

  test("nothing in apps/web source names the raw recordAgreementAnswer or setCoveredEntity but ops-client.ts and agreement-answer.ts", () => {
    const root = join(__dirname, "../..");
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) {
          if (name !== "node_modules" && !name.startsWith(".")) walk(path);
        } else if (/\.(ts|tsx|js|jsx|mjs)$/.test(name) && !/\.test\.[jt]sx?$/.test(name)) {
          files.push(path);
        }
      }
    };
    walk(root);
    expect(files.length).toBeGreaterThan(50);
    const allowed = [join("lib", "admin", "ops-client.ts"), join("lib", "admin", "agreement-answer.ts")];
    const offenders = files.filter(
      (file) =>
        !allowed.some((end) => file.endsWith(end)) && /\b(recordAgreementAnswer|setCoveredEntity)\b/.test(readFileSync(file, "utf8")),
    );
    expect(offenders).toEqual([]);
  });
});
