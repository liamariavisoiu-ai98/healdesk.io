import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

/**
 * Entering a change of a clinic's address from /admin (changeClinicEmail,
 * plan Part D5): a session, the call back, and a fresh code from the
 * operator's authenticator, each before anything crosses to apps/app; and
 * the account readers in ops-client, checked field by field.
 */

const session = vi.hoisted(() => ({ operator: "ops@healdesk.test" as string | null }));
vi.mock("@/lib/admin/operator", () => ({ requireOperator: async () => session.operator }));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "user-agent": "vitest", "x-forwarded-for": "203.0.113.9" }),
}));

import { enterClinicEmailChange } from "@/lib/admin/address-change";
import { checkFreshOperatorCode } from "@/lib/admin/fresh-code";
import {
  changeClinicEmail,
  fetchClinicCards,
  fetchClinicSignIn,
  fetchSiteReadFailures,
  setCoveredEntity,
} from "@/lib/admin/ops-client";
import { __resetStepLedgerForTests, base32Decode, hotp, totpStep } from "@/lib/admin/totp";

const CLINIC = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
const CHANGE = "9b2e1c4d-1111-4c2a-9a8b-1f2e3d4c5b6a";
const SECRET = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";

let replies: unknown[] = [];
let sent: Array<{ op: string; args: Record<string, unknown> }> = [];

function code(at: number = Date.now()): string {
  return hotp(base32Decode(SECRET)!, totpStep(at));
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
      return new Response(JSON.stringify(next), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }),
  );
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const ENTERED = {
  data: {
    status: "entered",
    changeId: CHANGE,
    newEmail: "front@radiance.test",
    effectiveAt: "2026-10-17T14:32:00.000Z",
    emailed: true,
  },
};

describe("a fresh code from the operator's authenticator", () => {
  test("the current code passes once; the same code again, a wrong one, or no secret does not", () => {
    const now = Date.now();
    expect(checkFreshOperatorCode(code(now), now)).toEqual({ ok: true });
    expect(checkFreshOperatorCode(code(now), now)).toMatchObject({ ok: false });
    expect(checkFreshOperatorCode("000000", now + 120_000)).toMatchObject({ ok: false });
    expect(checkFreshOperatorCode(12345, now)).toMatchObject({ ok: false });
    vi.stubEnv("HEALDESK_ADMIN_TOTP_SECRET", "");
    expect(checkFreshOperatorCode(code(now + 60_000), now + 60_000)).toMatchObject({ ok: false });
  });
});

describe("changeClinicEmail from /admin", () => {
  test("with a session, the call back and a fresh code, it sends the clinic and the address, and nothing else", async () => {
    replies.push(ENTERED);
    const result = await enterClinicEmailChange(CLINIC, {
      newEmail: "front@radiance.test",
      code: code(),
      calledBack: true,
    });
    expect(result).toEqual({ ok: true, data: ENTERED.data });
    expect(sent).toEqual([
      { op: "changeClinicEmail", args: { clinicId: CLINIC, newEmail: "front@radiance.test" } },
    ]);
  });

  test("no session, no call back, or a wrong code: nothing crosses", async () => {
    session.operator = null;
    expect(
      await enterClinicEmailChange(CLINIC, {
        newEmail: "a@b.test",
        code: code(),
        calledBack: true,
      }),
    ).toMatchObject({ ok: false, code: "unauthenticated" });
    session.operator = "ops@healdesk.test";
    expect(
      await enterClinicEmailChange(CLINIC, {
        newEmail: "a@b.test",
        code: code(),
        calledBack: false,
      }),
    ).toMatchObject({ ok: true, data: { status: "refused" } });
    expect(
      await enterClinicEmailChange(CLINIC, {
        newEmail: "a@b.test",
        code: "123456",
        calledBack: true,
      }),
    ).toMatchObject({ ok: true, data: { status: "refused" } });
    expect(sent).toEqual([]);
  });

  test("a refusal upstream is carried as its sentence", async () => {
    replies.push({ data: { status: "refused", message: "That's already the clinic's address." } });
    expect(await changeClinicEmail(CLINIC, "info@radiance.test")).toEqual({
      ok: true,
      data: { status: "refused", message: "That's already the clinic's address." },
    });
  });
});

describe("the account readers are strict", () => {
  test("the sign-in view: addresses, each change's state, and the covered-entity facts", async () => {
    replies.push({
      data: {
        clinicId: CLINIC,
        clinicName: "Radiance Med Spa",
        address: "info@radiance.test",
        changes: [
          {
            id: CHANGE,
            status: "pending",
            source: "operator",
            oldEmail: "info@radiance.test",
            newEmail: "front@radiance.test",
            requestedBy: "ops@healdesk.test",
            createdAt: "2026-10-14T14:32:00.000Z",
            confirmedAt: "2026-10-14T14:32:00.000Z",
            effectiveAt: "2026-10-17T14:32:00.000Z",
            resolvedAt: null,
            stoppedBy: null,
            resolution: null,
          },
        ],
        coveredEntity: {
          specialty: "med-spa",
          regime: "hipaa-if-covered",
          agreementKind: "dpa",
          isCoveredEntity: false,
        },
      },
    });
    const view = await fetchClinicSignIn(CLINIC);
    expect(view).toMatchObject({ ok: true, data: { changes: [{ status: "pending" }] } });

    replies.push({
      data: {
        clinicId: CLINIC,
        clinicName: "Radiance",
        address: null,
        changes: [{ id: CHANGE, status: "teleported" }],
        coveredEntity: {},
      },
    });
    expect(await fetchClinicSignIn(CLINIC)).toMatchObject({ ok: false, code: "malformed" });
  });

  test("setCoveredEntity sends a closed answer and reads whether the supersede started", async () => {
    replies.push({
      data: {
        status: "recorded",
        agreementKind: "dpa",
        isCoveredEntity: true,
        covered: false,
        supersedeStarted: true,
        linkSent: false,
        auditRecorded: true,
      },
    });
    expect(await setCoveredEntity(CLINIC, "yes")).toMatchObject({
      ok: true,
      data: { status: "recorded", covered: false, supersedeStarted: true },
    });
    expect(sent.at(-1)).toEqual({
      op: "setCoveredEntity",
      args: { clinicId: CLINIC, answer: "yes" },
    });
  });

  test("the clinic cards: a stage or a status this console does not know is refused, not shown", async () => {
    const card = {
      id: CLINIC,
      agreementKind: "baa",
      agreementLabel: "Business associate agreement",
      channels: [{ channel: "voice", status: "waiting" }],
      tracker: [{ id: "agreement", label: "Agreement signed", state: "done" }],
      trackerLeft: ["Assistant built"],
    };
    replies.push({ data: { cards: [card], limit: 50 } });
    expect(await fetchClinicCards()).toEqual({ ok: true, data: { cards: [card], limit: 50 } });
    replies.push({
      data: {
        cards: [{ ...card, tracker: [{ id: "summoned", label: "x", state: "done" }] }],
        limit: 50,
      },
    });
    expect(await fetchClinicCards()).toMatchObject({ ok: false, code: "malformed" });
  });

  test("the site-read failures: a website must be an http(s) URL", async () => {
    const row = {
      ref: CHANGE,
      clinicName: "Radiance Med Spa",
      website: "https://radiance.test/",
      createdAt: "2026-10-14T14:32:00.000Z",
      provisionedAt: null,
      clinicId: null,
      profileSince: false,
    };
    replies.push({ data: { failures: [row], limit: 100 } });
    expect(await fetchSiteReadFailures()).toEqual({
      ok: true,
      data: { failures: [row], limit: 100 },
    });
    replies.push({ data: { failures: [{ ...row, website: "javascript:alert(1)" }], limit: 100 } });
    expect(await fetchSiteReadFailures()).toMatchObject({ ok: false, code: "malformed" });
  });
});
