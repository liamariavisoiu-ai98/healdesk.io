import { describe, expect, test, vi } from "vitest";

import type { OpsInbox } from "@/lib/admin/strip-types";

/**
 * Home's op buttons (E1 step 4): every op in the closed list runs its typed
 * ops-client call with the row's own ids; any other name is refused by name;
 * a forged id, a day count past the cap, or a row the server did not build
 * runs nothing. ops-client is mocked: what reaches it is the whole test.
 */

const calls = vi.hoisted(() => ({ made: [] as [string, unknown[]][] }));
vi.mock("@/lib/admin/ops-client", () => {
  const done = (name: string) => async (...args: unknown[]) => {
    calls.made.push([name, args]);
    return { ok: true, data: { status: "updated", auditRecorded: true } };
  };
  return {
    resendTranscript: done("resendTranscript"),
    goLive: done("goLive"),
    extendSetupDeadline: done("extendSetupDeadline"),
    rerunPracticeQuestions: done("rerunPracticeQuestions"),
    requestSiteReread: done("requestSiteReread"),
    deleteRecordedCall: done("deleteRecordedCall"),
    markSupportReplied: done("markSupportReplied"),
    setUsageAlerts: done("setUsageAlerts"),
  };
});

const { runInboxOp, runInboxRow } = await import("./inbox-ops");
const { INBOX_BUTTON_OPS } = await import("./inbox-button-ops");

const CLINIC = "3FA85F64-5717-4562-B3FC-2C963F66AFA6";
const OTHER = "5b4a3c2d-1e0f-4a9b-8c7d-6e5f4a3b2c1d";

function refusedWith(result: Awaited<ReturnType<typeof runInboxOp>>): string {
  if (!result.ok) throw new Error(result.message);
  expect(result.data.status).toBe("refused");
  return result.data.message ?? "";
}

describe("the closed switch", () => {
  test("every listed op runs its ops-client call with the row's ids, lower-cased", async () => {
    calls.made = [];
    const expected: Record<(typeof INBOX_BUTTON_OPS)[number], { args: Record<string, string | number | boolean>; sent: unknown[] }> = {
      resendTranscript: { args: { clinicId: CLINIC, conversationId: OTHER }, sent: [CLINIC.toLowerCase(), OTHER] },
      goLive: { args: { clinicId: CLINIC }, sent: [CLINIC.toLowerCase()] },
      extendSetupDeadline: { args: { clinicId: CLINIC, days: 7, fromDeadline: "2026-11-18T00:00:00.000Z" }, sent: [CLINIC.toLowerCase(), { days: 7, fromDeadline: "2026-11-18T00:00:00.000Z" }] },
      rerunPracticeQuestions: { args: { clinicId: CLINIC }, sent: [CLINIC.toLowerCase()] },
      requestSiteReread: { args: { clinicId: CLINIC }, sent: [CLINIC.toLowerCase()] },
      deleteRecordedCall: { args: { clinicId: CLINIC, alertId: OTHER }, sent: [CLINIC.toLowerCase(), OTHER] },
      markSupportReplied: { args: { clinicId: CLINIC, requestId: OTHER }, sent: [CLINIC.toLowerCase(), OTHER] },
      setUsageAlerts: { args: { clinicId: CLINIC, on: true }, sent: [CLINIC.toLowerCase(), true] },
    };
    for (const op of INBOX_BUTTON_OPS) {
      const result = await runInboxOp({ label: op, kind: "op", op, args: expected[op].args });
      expect(result.ok && result.data.status, op).toBe("updated");
      expect(calls.made.at(-1), op).toEqual([op, expected[op].sent]);
    }
    expect(calls.made).toHaveLength(INBOX_BUTTON_OPS.length);
  });

  test("any other name is refused by name, and nothing runs", async () => {
    calls.made = [];
    for (const op of ["commitRefund", "closeUnfinishedSetup", "goLive; rm -rf", ""]) {
      expect(refusedWith(await runInboxOp({ label: "x", kind: "op", op, args: { clinicId: CLINIC } }))).toContain("cannot run");
    }
    expect(calls.made).toEqual([]);
  });

  test("a forged id or a day count past the cap is refused, and nothing runs", async () => {
    calls.made = [];
    expect(refusedWith(await runInboxOp({ label: "x", kind: "op", op: "goLive", args: { clinicId: "radiance" } }))).toContain("no clinic id");
    expect(refusedWith(await runInboxOp({ label: "x", kind: "op", op: "resendTranscript", args: { clinicId: CLINIC, conversationId: "conv-1" } }))).toContain("no conversation id");
    expect(refusedWith(await runInboxOp({ label: "x", kind: "op", op: "deleteRecordedCall", args: { clinicId: CLINIC } }))).toContain("no alert id");
    expect(refusedWith(await runInboxOp({ label: "x", kind: "op", op: "markSupportReplied", args: { clinicId: CLINIC, requestId: `${OTHER}'` } }))).toContain("no request id");
    expect(refusedWith(await runInboxOp({ label: "x", kind: "op", op: "extendSetupDeadline", args: { clinicId: CLINIC, days: 31, fromDeadline: "2026-11-18T00:00:00.000Z" } }))).toContain("1 to 30");
    expect(refusedWith(await runInboxOp({ label: "x", kind: "op", op: "extendSetupDeadline", args: { clinicId: CLINIC, days: 1.5, fromDeadline: "2026-11-18T00:00:00.000Z" } }))).toContain("1 to 30");
    expect(refusedWith(await runInboxOp({ label: "x", kind: "op", op: "extendSetupDeadline", args: { clinicId: CLINIC, days: 7, fromDeadline: "soon" } }))).toContain("no deadline");
    expect(calls.made).toEqual([]);
  });
});

describe("running a row the server built", () => {
  const inbox: OpsInbox = {
    checkedAt: "2026-10-23T09:12:00.000Z",
    unreadable: [],
    rows: [
      { id: "golive:1", kind: "ready_to_go_live", count: 1, sentence: "ready.", clinic: { id: CLINIC, name: "Radiance" }, button: { label: "Go live", kind: "op", op: "goLive", args: { clinicId: CLINIC } }, tone: "ok", dueAt: null },
      { id: "queue:support", kind: "support_owed", count: 2, sentence: "owed.", clinic: null, button: { label: "Open", kind: "link", href: "/admin/queues#support" }, tone: "warn", dueAt: null },
    ],
  };

  test("the row's own button runs; a link row, a missing row or a bad id runs nothing", async () => {
    calls.made = [];
    const ran = await runInboxRow(inbox, "golive:1");
    expect(ran.ok && ran.data.status).toBe("updated");
    expect(calls.made).toEqual([["goLive", [CLINIC.toLowerCase()]]]);
    expect(refusedWith(await runInboxRow(inbox, "queue:support"))).toContain("a link, not an action");
    expect(refusedWith(await runInboxRow(inbox, "golive:2"))).toContain("no longer on the list");
    expect(refusedWith(await runInboxRow(inbox, 42))).toContain("could not be read");
    expect(refusedWith(await runInboxRow(inbox, "x".repeat(201)))).toContain("could not be read");
    expect(calls.made).toHaveLength(1);
  });
});
