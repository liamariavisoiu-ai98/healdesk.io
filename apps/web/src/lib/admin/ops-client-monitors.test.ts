import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

/**
 * The ops client's Phase 5 monitors (lane P5a), against a stubbed upstream:
 * the voice agent's read-back and retry, the drift clear behind the
 * operator's fresh code, the stuck calendar writes and the undelivered
 * transcripts. Each call sends exactly the op and args apps/app reads, and
 * each answer is read strictly: a field missing, a field apps/app does not
 * send, or a value off its list is a malformed answer, never half a row.
 * The signing, the transport, the readers and the fresh-code check are the
 * real ones.
 */

const session = vi.hoisted(() => ({ operator: "ops@healdesk.test" as string | null }));
vi.mock("@/lib/admin/operator", () => ({ requireOperator: async () => session.operator }));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "user-agent": "vitest", "x-forwarded-for": "203.0.113.9" }),
}));

import {
  CALENDAR_WRITE_REASON_CODES,
  clearVoiceDriftFlag as sendClear,
  fetchStuckCalendarWrites,
  fetchUndeliveredTranscripts,
  fetchVoiceAgentReport,
  retryVoiceAgent,
} from "@/lib/admin/ops-client";
import { __resetStepLedgerForTests, base32Decode, hotp, totpStep } from "@/lib/admin/totp";
import { clearVoiceDriftFlagWithCode, retryVoiceAgentWithCode } from "@/lib/admin/voice-drift";

const CLINIC = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
const APPT = "5c0ffee0-1111-4c2a-9a8b-1f2e3d4c5b6a";
const SECRET = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";

let replies: unknown[] = [];
let sent: { op: string; args: Record<string, unknown> }[] = [];

function reply(data: unknown): void {
  replies.push({ data });
}

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

const MALFORMED = { ok: false, code: "malformed" };

const AGENT = {
  clinicId: CLINIC,
  clinicSlug: "radiance",
  engine: "custom",
  status: "ready",
  retellAgentId: "agent_abc123",
  hasNumber: true,
  attempts: 1,
  lastError: null,
  lastSyncedAt: "2026-10-24T09:00:00.000Z",
  numberOrderedAt: "2026-10-23T09:00:00.000Z",
  driftRepairs: 0,
  driftFlaggedAt: "2026-10-24T03:00:00.000Z",
  releasedAt: null,
  updatedAt: "2026-10-24T09:00:00.000Z",
};
const REPORT = {
  clinicId: CLINIC,
  status: "ready",
  engine: "custom",
  ok: false,
  checked: true,
  agentExists: true,
  numberExists: true,
  problems: ["fallback"],
  note: null,
};

describe("fetchVoiceAgentReport", () => {
  test("asks for the read-back and reads the rows and the report", async () => {
    reply({ agents: [AGENT], report: REPORT });
    expect(await fetchVoiceAgentReport(CLINIC)).toEqual({ ok: true, data: { agents: [AGENT], report: REPORT } });
    expect(sent).toEqual([{ op: "voiceAgentStatus", args: { clinicId: CLINIC, verify: true } }]);
    reply({ agents: [], report: null });
    expect(await fetchVoiceAgentReport(CLINIC)).toEqual({ ok: true, data: { agents: [], report: null } });
  });

  test("a report with a field missing, an extra field or a problem off the list is malformed", async () => {
    const { note: _note, ...missing } = REPORT;
    for (const report of [missing, { ...REPORT, number: "+14155550142" }, { ...REPORT, problems: ["price"] }]) {
      reply({ agents: [AGENT], report });
      expect(await fetchVoiceAgentReport(CLINIC)).toMatchObject(MALFORMED);
    }
    reply({ agents: [AGENT], report: REPORT, extra: 1 });
    expect(await fetchVoiceAgentReport(CLINIC)).toMatchObject(MALFORMED);
  });
});

describe("retryVoiceAgent", () => {
  test("sends the clinic, reads each outcome, and drops the number from a ready one", async () => {
    reply({ outcome: "ready", agentId: "agent_abc123", phoneNumber: "+14155551001", adopted: false });
    const ready = await retryVoiceAgent(CLINIC);
    expect(sent).toEqual([{ op: "retryVoiceAgent", args: { clinicId: CLINIC } }]);
    expect(ready).toEqual({ ok: true, data: { outcome: "ready", agentId: "agent_abc123", adopted: false } });
    expect(JSON.stringify(ready)).not.toContain("+1415");
    for (const data of [
      { outcome: "already", status: "ready" },
      { outcome: "not_eligible", reason: "the first invoice is not paid" },
      { outcome: "deferred", reason: "daily_cap" },
      { outcome: "failed", code: "rejected", reason: "Retell refused" },
      { outcome: "switched_off" },
      { outcome: "not_found" },
    ]) {
      reply(data);
      expect(await retryVoiceAgent(CLINIC)).toEqual({ ok: true, data });
    }
  });

  test("a missing or an extra field, or an outcome off the list, is malformed", async () => {
    for (const data of [
      { outcome: "already" },
      { outcome: "switched_off", reason: "x" },
      { outcome: "failed", code: "rejected" },
      { outcome: "bought" },
      { outcome: "deferred", reason: "later" },
    ]) {
      reply(data);
      expect(await retryVoiceAgent(CLINIC)).toMatchObject(MALFORMED);
    }
  });
});

describe("clearing a drift flag", () => {
  const fresh = () => hotp(base32Decode(SECRET)!, totpStep(Date.now()));

  test("with a fresh code: the clinic alone crosses, never the code, and each outcome is read", async () => {
    reply({ outcome: "cleared", check: "repaired", problems: ["fallback"] });
    const code = fresh();
    expect(await clearVoiceDriftFlagWithCode(CLINIC, code)).toEqual({
      ok: true,
      data: { outcome: "cleared", check: "repaired", problems: ["fallback"] },
    });
    expect(sent).toEqual([{ op: "clearVoiceDriftFlag", args: { clinicId: CLINIC } }]);
    expect(JSON.stringify(sent)).not.toContain(code);
    for (const data of [
      { outcome: "still_drifted", problems: ["agent_missing"] },
      { outcome: "not_flagged" },
      { outcome: "not_found" },
      { outcome: "cleared", check: "clean", problems: [] },
    ]) {
      reply(data);
      expect(await sendClear(CLINIC)).toEqual({ ok: true, data });
    }
  });

  test("a wrong, missing or reused code is code_refused and nothing is sent", async () => {
    for (const code of ["000000", undefined, ""]) {
      const result = await clearVoiceDriftFlagWithCode(CLINIC, code);
      expect(result).toMatchObject({ ok: true, data: { outcome: "code_refused" } });
    }
    expect(sent).toEqual([]);
    const code = fresh();
    reply({ outcome: "not_flagged" });
    await clearVoiceDriftFlagWithCode(CLINIC, code);
    expect(await clearVoiceDriftFlagWithCode(CLINIC, code)).toMatchObject({ ok: true, data: { outcome: "code_refused" } });
    expect(sent).toHaveLength(1);
  });

  test("without a session nothing is checked or sent", async () => {
    session.operator = null;
    expect(await clearVoiceDriftFlagWithCode(CLINIC, fresh())).toMatchObject({ ok: false, code: "unauthenticated" });
    expect(sent).toEqual([]);
  });

  test("an answer with a missing or extra field is malformed", async () => {
    for (const data of [
      { outcome: "cleared", check: "repaired" },
      { outcome: "not_flagged", problems: [] },
      { outcome: "still_drifted", problems: ["price"] },
    ]) {
      reply(data);
      expect(await sendClear(CLINIC)).toMatchObject(MALFORMED);
    }
  });
});

const WRITE = {
  clinicId: CLINIC,
  clinicName: "Radiance Med Spa",
  appointmentId: APPT,
  status: "unknown",
  reason: "unconfirmed",
  attempts: 2,
  nextAttemptAt: "2026-10-24T10:10:00.000Z",
  slotInDays: 4,
  retryable: true,
};

describe("fetchStuckCalendarWrites", () => {
  test("sends includeDemo only when asked, and reads every field", async () => {
    reply({ writes: [WRITE], count: 1, truncated: false, unreadClinics: 0 });
    expect(await fetchStuckCalendarWrites()).toEqual({
      ok: true,
      data: { writes: [WRITE], count: 1, truncated: false, unreadClinics: 0 },
    });
    reply({ writes: [], count: 0, truncated: false, unreadClinics: 1 });
    await fetchStuckCalendarWrites({ includeDemo: true });
    expect(sent).toEqual([
      { op: "listStuckCalendarWrites", args: {} },
      { op: "listStuckCalendarWrites", args: { includeDemo: true } },
    ]);
  });

  test("a row with a field missing, an extra field (a time, a name) or a reason off the list is malformed", async () => {
    const { slotInDays: _slot, ...missing } = WRITE;
    for (const row of [
      missing,
      { ...WRITE, scheduledFor: "2026-10-28T14:00:00.000Z" },
      { ...WRITE, patient: "Synthetic" },
      { ...WRITE, reason: "backendError" },
      { ...WRITE, status: "writing" },
    ]) {
      reply({ writes: [row], count: 1, truncated: false, unreadClinics: 0 });
      expect(await fetchStuckCalendarWrites()).toMatchObject(MALFORMED);
    }
    reply({ writes: [], count: 0, truncated: false });
    expect(await fetchStuckCalendarWrites()).toMatchObject(MALFORMED);
  });

  test("the reason codes are apps/app's own words, plus other", () => {
    const source = readFileSync(join(__dirname, "../../../../app/src/lib/booking/calendar.ts"), "utf8");
    const table = /export const CALENDAR_WRITE_REASONS = \{([\s\S]*?)\} as const/.exec(source)![1]!;
    const words = [...table.matchAll(/^\s+([a-z_]+): "(?:transient|settled|refused)",$/gm)].map((m) => m[1]!);
    expect(words.length).toBeGreaterThan(30);
    expect([...CALENDAR_WRITE_REASON_CODES].sort()).toEqual([...words, "other"].sort());
  });
});

const TRANSCRIPTS = {
  clinicId: CLINIC,
  clinicName: "Radiance Med Spa",
  counts: { overdue: 1, bounced: 0, expired: 2, unconfirmed: 0 },
  oldestAgeHours: 80,
};

describe("fetchUndeliveredTranscripts", () => {
  test("sends no argument and reads every field", async () => {
    reply({ clinics: [TRANSCRIPTS, { ...TRANSCRIPTS, oldestAgeHours: null }], unreadClinics: 0 });
    expect(await fetchUndeliveredTranscripts()).toEqual({
      ok: true,
      data: { clinics: [TRANSCRIPTS, { ...TRANSCRIPTS, oldestAgeHours: null }], unreadClinics: 0 },
    });
    expect(sent).toEqual([{ op: "listUndeliveredTranscripts", args: {} }]);
  });

  test("a missing or extra field, in the row or its counts, is malformed", async () => {
    const { oldestAgeHours: _age, ...missing } = TRANSCRIPTS;
    for (const row of [
      missing,
      { ...TRANSCRIPTS, conversationId: APPT },
      { ...TRANSCRIPTS, counts: { overdue: 1, bounced: 0, expired: 2 } },
      { ...TRANSCRIPTS, counts: { ...TRANSCRIPTS.counts, delivered: 4 } },
    ]) {
      reply({ clinics: [row], unreadClinics: 0 });
      expect(await fetchUndeliveredTranscripts()).toMatchObject(MALFORMED);
    }
  });
});

describe("the two voice acts that change Retell go only through the fresh code", () => {
  const fresh = () => hotp(base32Decode(SECRET)!, totpStep(Date.now()));

  test("retryVoiceAgentWithCode: a fresh code sends the clinic alone; a wrong or missing one sends nothing", async () => {
    for (const code of ["000000", undefined]) {
      expect(await retryVoiceAgentWithCode(CLINIC, code)).toMatchObject({ ok: true, data: { outcome: "code_refused" } });
    }
    expect(sent).toEqual([]);
    session.operator = null;
    expect(await retryVoiceAgentWithCode(CLINIC, fresh())).toMatchObject({ ok: false, code: "unauthenticated" });
    expect(sent).toEqual([]);
    session.operator = "ops@healdesk.test";
    reply({ outcome: "already", status: "ready" });
    const code = fresh();
    expect(await retryVoiceAgentWithCode(CLINIC, code)).toEqual({ ok: true, data: { outcome: "already", status: "ready" } });
    expect(sent).toEqual([{ op: "retryVoiceAgent", args: { clinicId: CLINIC } }]);
    expect(JSON.stringify(sent)).not.toContain(code);
  });

  test("nothing in apps/web source names the raw retryVoiceAgent or clearVoiceDriftFlag but ops-client.ts and voice-drift.ts", () => {
    // Any occurrence of either identifier, however it got there: a named or
    // aliased import, a re-export, a dynamic import, destructuring from a
    // namespace, a cast alias's property. The gated wrappers are
    // retryVoiceAgentWithCode and clearVoiceDriftFlagWithCode, which a word
    // boundary keeps apart. Test files are allowed: they test the raw readers.
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
    const allowed = [join("lib", "admin", "ops-client.ts"), join("lib", "admin", "voice-drift.ts")];
    const offenders = files.filter(
      (file) =>
        !allowed.some((end) => file.endsWith(end)) &&
        /\b(?:retryVoiceAgent|clearVoiceDriftFlag)\b/.test(readFileSync(file, "utf8")),
    );
    expect(offenders).toEqual([]);
    // clinic-strip.ts reads the ops client through a namespace, and names neither.
    const strip = readFileSync(join(root, "lib", "admin", "clinic-strip.ts"), "utf8");
    expect(strip).toMatch(/import \* as ops from "@\/lib\/admin\/ops-client"/);
    expect(strip).not.toMatch(/retryVoiceAgent|clearVoiceDriftFlag/);
  });
});
