import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

/**
 * Entering an attestation of the platform from /admin/compliance (WP2):
 * automatic go-live reads what is entered, so it is entered as the address
 * change is: a session, then a fresh code from the operator's authenticator,
 * each before anything crosses to apps/app; the launch promises, which this
 * app holds, refused here while one that blocks go-live is open; and the
 * reader of the attestation view, field by field.
 */

const session = vi.hoisted(() => ({ operator: "ops@healdesk.test" as string | null }));
vi.mock("@/lib/admin/operator", () => ({ requireOperator: async () => session.operator }));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "user-agent": "vitest", "x-forwarded-for": "203.0.113.9" }),
}));
const promises = vi.hoisted(() => ({
  list: [] as { id: string; promise: string; status: string; blocksGoLive: boolean }[],
}));
vi.mock("@/lib/admin/seo/launch", () => ({
  get LAUNCH_PROMISES() {
    return promises.list;
  },
}));

import { fetchPlatformCompliance } from "@/lib/admin/ops-client";
import { enterPlatformAttestation, openLaunchPromises } from "@/lib/admin/platform-compliance";
import { __resetStepLedgerForTests, base32Decode, hotp, totpStep } from "@/lib/admin/totp";

const SECRET = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";
const OPEN = {
  id: "no-audio",
  promise: "No call audio is kept",
  status: "building",
  blocksGoLive: true,
};
const ON = {
  id: "urgent-alert",
  promise: "An urgent message goes at once",
  status: "on",
  blocksGoLive: true,
};
const NOT_BLOCKING = {
  id: "later",
  promise: "Something later",
  status: "building",
  blocksGoLive: false,
};

let replies: unknown[] = [];
let sent: Array<{ op: string; args: Record<string, unknown> }> = [];

function code(at: number = Date.now()): string {
  return hotp(base32Decode(SECRET)!, totpStep(at));
}

const RECORDED = {
  data: { status: "recorded", subject: "anthropic", attested: true, auditRecorded: true },
};

beforeEach(() => {
  replies = [];
  sent = [];
  session.operator = "ops@healdesk.test";
  promises.list = [OPEN, ON, NOT_BLOCKING];
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

describe("an attestation from /admin/compliance", () => {
  test("with a session and a fresh code it sends the subject, the reference and its days, and nothing else", async () => {
    replies.push(RECORDED);
    const result = await enterPlatformAttestation({
      action: "attest",
      subject: "anthropic",
      documentRef: "Anthropic BAA, legal drive",
      effectiveOn: "2026-10-19",
      expiresOn: "2027-10-19",
      code: code(),
    });
    expect(result).toEqual({ ok: true, data: RECORDED.data });
    expect(sent).toEqual([
      {
        op: "attestPlatformCompliance",
        args: {
          subject: "anthropic",
          documentRef: "Anthropic BAA, legal drive",
          effectiveOn: "2026-10-19",
          expiresOn: "2027-10-19",
        },
      },
    ]);
  });

  test("no session, a subject off the list, a wrong code or a spent one: nothing crosses", async () => {
    const input = { action: "attest", subject: "aws", documentRef: "x", effectiveOn: "2026-10-19" };
    session.operator = null;
    expect(await enterPlatformAttestation({ ...input, code: code() })).toMatchObject({
      ok: false,
      code: "unauthenticated",
    });
    session.operator = "ops@healdesk.test";
    expect(
      await enterPlatformAttestation({ ...input, subject: "meta", code: code() }),
    ).toMatchObject({
      ok: true,
      data: { status: "refused" },
    });
    expect(await enterPlatformAttestation({ ...input, code: "123456" })).toMatchObject({
      ok: true,
      data: { status: "refused", message: expect.stringMatching(/not right/) },
    });
    expect(sent).toEqual([]);

    const now = code();
    replies.push(RECORDED);
    expect(await enterPlatformAttestation({ ...input, code: now })).toMatchObject({ ok: true });
    expect(await enterPlatformAttestation({ ...input, code: now })).toMatchObject({
      ok: true,
      data: { status: "refused", message: expect.stringMatching(/already used/) },
    });
    expect(sent).toHaveLength(1);
  });

  test("the launch promises are refused here while one that blocks go-live is open, before the code is asked", async () => {
    expect(openLaunchPromises()).toEqual(["no-audio"]);
    const fresh = code();
    expect(
      await enterPlatformAttestation({
        action: "attest",
        subject: "launch_promises",
        documentRef: "/admin/seo",
        effectiveOn: "2026-10-19",
        code: fresh,
      }),
    ).toEqual({
      ok: true,
      data: {
        status: "refused",
        message:
          "Launch promises that block go-live are still open (no-audio): move each to on first, under /admin/compliance#launch. Nothing was recorded.",
      },
    });
    expect(sent).toEqual([]);

    // Each one on: it crosses, saying none is open, so apps/app checks it too.
    promises.list = [{ ...OPEN, status: "on" }, ON, NOT_BLOCKING];
    replies.push({ data: { ...RECORDED.data, subject: "launch_promises" } });
    expect(
      await enterPlatformAttestation({
        action: "attest",
        subject: "launch_promises",
        documentRef: "/admin/seo: every blocking item on",
        effectiveOn: "2026-10-19",
        code: fresh,
      }),
    ).toMatchObject({ ok: true, data: { status: "recorded" } });
    expect(sent).toEqual([
      {
        op: "attestPlatformCompliance",
        args: {
          subject: "launch_promises",
          documentRef: "/admin/seo: every blocking item on",
          effectiveOn: "2026-10-19",
          openLaunchPromises: [],
        },
      },
    ]);
  });

  test("a withdrawal sends the subject, why and its day, with the same code check", async () => {
    replies.push({
      data: { status: "recorded", subject: "retell", attested: false, auditRecorded: true },
    });
    expect(
      await enterPlatformAttestation({
        action: "withdraw",
        subject: "retell",
        documentRef: "Retell's agreement ended",
        effectiveOn: "2026-10-19",
        expiresOn: "2027-01-01",
        code: code(),
      }),
    ).toMatchObject({ ok: true, data: { status: "recorded", attested: false } });
    expect(sent).toEqual([
      {
        op: "withdrawPlatformCompliance",
        args: {
          subject: "retell",
          documentRef: "Retell's agreement ended",
          effectiveOn: "2026-10-19",
        },
      },
    ]);
  });
});

describe("the attestation view's reader is strict", () => {
  const VIEW = {
    today: "2026-10-19",
    subjects: [
      {
        subject: "retell",
        kind: "vendor",
        label: "Retell (phone)",
        attests: "Its BAA is in force.",
        needs: "Phone",
        channels: ["voice"],
        attested: true,
        lapsed: false,
        latest: {
          action: "attested",
          documentRef: "Retell BAA",
          effectiveOn: "2026-10-19",
          expiresOn: null,
          actorLabel: "ops@healdesk.test",
          recordedAt: "2026-10-19T12:00:00.000Z",
        },
      },
    ],
    history: [],
    gateB: [
      {
        id: "routed_answered_counter",
        label: "Counter",
        built: false,
        checked: false,
        detail: "Not built.",
      },
    ],
  };

  test("reads each subject, its last entry and what Gate B names", async () => {
    replies.push({ data: VIEW });
    expect(await fetchPlatformCompliance()).toEqual({ ok: true, data: VIEW });
  });

  test("a subject or a channel it doesn't know is a malformed reply, never a guess", async () => {
    replies.push({ data: { ...VIEW, subjects: [{ ...VIEW.subjects[0], subject: "meta" }] } });
    expect(await fetchPlatformCompliance()).toMatchObject({ ok: false, code: "malformed" });
    replies.push({ data: { ...VIEW, subjects: [{ ...VIEW.subjects[0], channels: ["fax"] }] } });
    expect(await fetchPlatformCompliance()).toMatchObject({ ok: false, code: "malformed" });
  });
});
