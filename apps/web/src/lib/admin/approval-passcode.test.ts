import { randomBytes, scryptSync } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

/**
 * The one approval passcode (lane P7h; owner, 26 October 2026): every
 * approval decision and every covered-entity answer takes it, or a fresh
 * authenticator code; five wrong tries of either lock approvals for fifteen
 * minutes, per operator account and across all of them; the passcode is
 * checked against a salted scrypt hash in HEALDESK_APPROVAL_PASSCODE_HASH,
 * never crosses to apps/app, and apps/app is told which factor was checked.
 * Unset, only the authenticator works and the refusal says so. Every other
 * fresh-code act keeps the authenticator alone.
 */

const session = vi.hoisted(() => ({ operator: "ops@healdesk.test" as string | null }));
vi.mock("@/lib/admin/operator", () => ({ requireOperator: async () => session.operator }));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "user-agent": "vitest", "x-forwarded-for": "203.0.113.9" }),
}));

import { recordAgreementAnswerWithCode, setCoveredEntityWithCode } from "@/lib/admin/agreement-answer";
import { decideApprovalWithCode } from "@/lib/admin/approval-decide";
import {
  __resetApprovalPasscodeForTests,
  APPROVAL_PASSCODE_VARIABLE,
  approvalPasscodeConfigured,
  checkApprovalCode,
  PASSCODE_ATTEMPT_LIMIT,
  PASSCODE_LOCK_MS,
  parsePasscodeHash,
} from "@/lib/admin/approval-passcode";
import { checkFreshOperatorCode } from "@/lib/admin/fresh-code";
import { __resetStepLedgerForTests, base32Decode, hotp, totpStep } from "@/lib/admin/totp";

const SECRET = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";
const PASSCODE = "482913";
const ITEM = "5c0ffee0-1111-4c2a-9a8b-1f2e3d4c5b6a";
const CLINIC = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
const REVIEW = "7d1e2f30-2222-4b3c-8d4e-5f6a7b8c9d0e";
const NOW = Date.UTC(2026, 9, 27, 15, 0, 0);

/** A hash as the owner's script makes one, with a small N so the tests are quick. */
function hashOf(passcode: string): string {
  const salt = randomBytes(16);
  const key = scryptSync(passcode, salt, 32, { N: 1024, r: 8, p: 1 });
  return `scrypt$1024$8$1$${salt.toString("base64")}$${key.toString("base64")}`;
}
const HASH = hashOf(PASSCODE);

function totp(at = Date.now()): string {
  return hotp(base32Decode(SECRET)!, totpStep(at));
}

let sent: { op: string; args: Record<string, unknown> }[] = [];

beforeEach(() => {
  sent = [];
  session.operator = "ops@healdesk.test";
  __resetStepLedgerForTests();
  __resetApprovalPasscodeForTests();
  vi.stubEnv("HEALDESK_PROVISION_SECRET", "test-provision-secret");
  vi.stubEnv("HEALDESK_APP_URL", "http://ops.internal.test");
  vi.stubEnv("HEALDESK_ADMIN_TOTP_SECRET", SECRET);
  vi.stubEnv(APPROVAL_PASSCODE_VARIABLE, HASH);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: unknown, init: { body: string }) => {
      const envelope = JSON.parse(init.body) as { op: string; args: Record<string, unknown> };
      sent.push({ op: envelope.op, args: envelope.args });
      const data =
        envelope.op === "decideApproval"
          ? { status: "executed", outcomeCode: "sent", message: "Sent.", auditRecorded: true }
          : { status: "recorded", agreementKind: "baa", isCoveredEntity: true, covered: true, supersedeStarted: true, linkSent: true, auditRecorded: true };
      return new Response(JSON.stringify({ data }), { status: 200, headers: { "content-type": "application/json" } });
    }),
  );
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("the passcode on every approval", () => {
  test("a decision with the passcode crosses with the mark and codeKind passcode, never the passcode", async () => {
    expect(await decideApprovalWithCode(ITEM, "approve", "owner_checked", PASSCODE)).toMatchObject({ ok: true, data: { status: "executed" } });
    expect(sent).toEqual([{ op: "decideApproval", args: { id: ITEM, action: "approve", reasonCode: "owner_checked", codeChecked: true, codeKind: "passcode" } }]);
    expect(JSON.stringify(sent)).not.toContain(PASSCODE);
    // A reject asks for it too, and the same passcode works again: it is static.
    expect(await decideApprovalWithCode(ITEM, "reject", "not_needed", PASSCODE)).toMatchObject({ ok: true, data: { status: "executed" } });
    expect(sent[1]!.args).toMatchObject({ codeKind: "passcode" });
  });

  test("the authenticator code is still accepted, named as such", async () => {
    await decideApprovalWithCode(ITEM, "approve", "owner_checked", totp());
    expect(sent[0]!.args).toMatchObject({ codeChecked: true, codeKind: "authenticator" });
  });

  test("the agreement answer and the Account tab's covered-entity answer take the passcode too", async () => {
    expect(await recordAgreementAnswerWithCode(CLINIC, REVIEW, "yes", PASSCODE)).toMatchObject({ ok: true, data: { status: "recorded" } });
    expect(await setCoveredEntityWithCode(CLINIC, "not_sure", PASSCODE)).toMatchObject({ ok: true, data: { status: "recorded" } });
    expect(sent).toEqual([
      { op: "recordAgreementAnswer", args: { clinicId: CLINIC, reviewId: REVIEW, answer: "yes", codeChecked: true, codeKind: "passcode" } },
      { op: "setCoveredEntity", args: { clinicId: CLINIC, answer: "not_sure", codeChecked: true, codeKind: "passcode" } },
    ]);
  });

  test("a wrong code, no session, or the passcode for another shape sends nothing", async () => {
    expect(await decideApprovalWithCode(ITEM, "approve", "owner_checked", "000000")).toMatchObject({ ok: true, data: { status: "code_refused" } });
    expect(await decideApprovalWithCode(ITEM, "approve", "owner_checked", "48291")).toMatchObject({ ok: true, data: { status: "code_refused" } });
    session.operator = null;
    expect(await decideApprovalWithCode(ITEM, "approve", "owner_checked", PASSCODE)).toMatchObject({ ok: false, code: "unauthenticated" });
    expect(sent).toEqual([]);
  });
});

describe("unset or malformed, it fails closed and says so", () => {
  test.each([["unset", ""], ["malformed", "scrypt6384=="], ["a huge N", "scrypt$1073741824$8$1$c2FsdHNhbHQ=$a2V5a2V5a2V5a2V5a2V5a2V5"]])(
    "%s: the passcode is refused with the reason, and the authenticator still works",
    async (_label, value) => {
      vi.stubEnv(APPROVAL_PASSCODE_VARIABLE, value);
      expect(approvalPasscodeConfigured()).toBe(false);
      const refused = await decideApprovalWithCode(ITEM, "approve", "owner_checked", PASSCODE);
      expect(refused).toMatchObject({ ok: true, data: { status: "code_refused" } });
      expect(JSON.stringify(refused)).toContain("approval passcode is not set on this deployment");
      expect(sent).toEqual([]);
      await decideApprovalWithCode(ITEM, "approve", "owner_checked", totp());
      expect(sent[0]!.args).toMatchObject({ codeKind: "authenticator" });
    },
  );

  test("the hash is read with its own parameters", () => {
    expect(parsePasscodeHash(HASH)).toMatchObject({ N: 1024, r: 8, p: 1 });
    expect(parsePasscodeHash("bcrypt$1$2$3$4$5")).toBeNull();
  });
});

describe("five wrong tries lock approvals for fifteen minutes", () => {
  test("per account: the sixth try, even the right passcode, is refused until the window passes", async () => {
    for (let i = 0; i < PASSCODE_ATTEMPT_LIMIT; i += 1) {
      expect(await checkApprovalCode(`00000${i}`, "ops@healdesk.test", NOW + i)).toMatchObject({ ok: false });
    }
    const locked = await checkApprovalCode(PASSCODE, "ops@healdesk.test", NOW + 10);
    expect(locked).toMatchObject({ ok: false });
    expect(locked.ok ? "" : locked.message).toMatch(/locked for 15 more minutes/);
    // The authenticator is locked out too: the lock is on approvals, not on one factor.
    expect(await checkApprovalCode(totp(NOW + 10), "ops@healdesk.test", NOW + 10)).toMatchObject({ ok: false });
    expect(await checkApprovalCode(PASSCODE, "ops@healdesk.test", NOW + PASSCODE_LOCK_MS + 1)).toEqual({ ok: true, factor: "passcode" });
  });

  test("globally: wrong tries spread across accounts lock every account", async () => {
    for (let i = 0; i < PASSCODE_ATTEMPT_LIMIT; i += 1) await checkApprovalCode("111111", `ops${i}@healdesk.test`, NOW);
    expect(await checkApprovalCode(PASSCODE, "someone-new@healdesk.test", NOW + 1)).toMatchObject({ ok: false });
  });

  test("a right code does not reset the count, and four wrong tries leave the fifth chance", async () => {
    for (let i = 0; i < PASSCODE_ATTEMPT_LIMIT - 1; i += 1) await checkApprovalCode("222222", "ops@healdesk.test", NOW);
    expect(await checkApprovalCode(PASSCODE, "ops@healdesk.test", NOW)).toEqual({ ok: true, factor: "passcode" });
    await checkApprovalCode("222222", "ops@healdesk.test", NOW);
    expect(await checkApprovalCode(PASSCODE, "ops@healdesk.test", NOW)).toMatchObject({ ok: false });
  });

  test("an authenticator code already used is refused as used and costs no try", async () => {
    const code = totp(NOW);
    expect(await checkApprovalCode(code, "ops@healdesk.test", NOW)).toEqual({ ok: true, factor: "authenticator" });
    for (let i = 0; i < PASSCODE_ATTEMPT_LIMIT; i += 1) {
      const again = await checkApprovalCode(code, "ops@healdesk.test", NOW);
      expect(again.ok ? "" : again.message).toMatch(/already used/);
    }
    expect(await checkApprovalCode(PASSCODE, "ops@healdesk.test", NOW)).toEqual({ ok: true, factor: "passcode" });
  });

  test("one derivation at a time: a burst cannot all read an unspent budget", async () => {
    const results = await Promise.all([checkApprovalCode("333333", "ops@healdesk.test", NOW), checkApprovalCode("333334", "ops@healdesk.test", NOW)]);
    expect(results.filter((r) => !r.ok && r.message.startsWith("Another code is being checked"))).toHaveLength(1);
  });
});

describe("what keeps the authenticator alone", () => {
  test("the passcode is never an authenticator code: sign-in's and the other step-up acts' check refuses it", () => {
    vi.stubEnv("HEALDESK_ADMIN_TOTP_SECRET", SECRET);
    expect(checkFreshOperatorCode(PASSCODE === totp() ? "000000" : PASSCODE)).toMatchObject({ ok: false });
  });

  test("only approval-decide.ts and agreement-answer.ts take the passcode; every other fresh-code act keeps the authenticator alone", () => {
    const root = join(__dirname, "..", "..");
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) files.push(path);
      }
    };
    walk(root);
    const takers = files.filter((f) => /\bcheckApprovalCode\(/.test(readFileSync(f, "utf8"))).map((f) => f.slice(root.length + 1)).sort();
    expect(takers).toEqual([join("lib", "admin", "agreement-answer.ts"), join("lib", "admin", "approval-decide.ts"), join("lib", "admin", "approval-passcode.ts")].sort());
    for (const own of ["address-change.ts", "device-recovery.ts", "voice-drift.ts", "platform-compliance.ts"]) {
      const text = readFileSync(join(root, "lib", "admin", own), "utf8");
      expect(text).toContain("checkFreshOperatorCode(");
      expect(text).not.toContain("approval-passcode");
    }
  });
});
