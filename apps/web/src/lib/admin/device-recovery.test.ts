import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

/**
 * The clinic's devices from /admin (wave 2, R4; plan Part D3 and Annex X5's
 * O3): the human route's link and the removal of devices are each sent only
 * with a session, the call back and a fresh code from the operator's
 * authenticator, checked before anything crosses to apps/app; nothing of an
 * address crosses at all; and the readers refuse what this console does not
 * know.
 */

const session = vi.hoisted(() => ({ operator: "ops@healdesk.test" as string | null }));
vi.mock("@/lib/admin/operator", () => ({ requireOperator: async () => session.operator }));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "user-agent": "vitest", "x-forwarded-for": "203.0.113.9" }),
}));

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { DevicesSection } from "@/app/admin/ops/[clinicId]/account/DevicesSection";
import { enterDeviceRecovery, enterDeviceRemoval } from "@/lib/admin/device-recovery";
import { endDeviceRecovery, fetchClinicDevices } from "@/lib/admin/ops-client";
import { __resetStepLedgerForTests, base32Decode, hotp, totpStep } from "@/lib/admin/totp";

const CLINIC = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
const DEVICE = "9b2e1c4d-1111-4c2a-9a8b-1f2e3d4c5b6a";
const LINK = "0b1c2d3e-4f50-4617-8899-aabbccddeeff";
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

const ISSUED = {
  data: {
    status: "issued",
    recoveryId: LINK,
    expiresAt: "2026-10-20T14:32:00.000Z",
    emailed: true,
    replaced: 0,
  },
};

describe("the human route's link from /admin", () => {
  test("with a session, the call back and a fresh code, it sends the clinic and the tick, and no address", async () => {
    replies.push(ISSUED);
    expect(await enterDeviceRecovery(CLINIC, { code: code(), calledBack: true })).toEqual({
      ok: true,
      data: ISSUED.data,
    });
    expect(sent).toEqual([
      { op: "issueDeviceRecovery", args: { clinicId: CLINIC, calledBack: true } },
    ]);
  });

  test("no session, no call back, a wrong code or a code used once already: nothing crosses", async () => {
    session.operator = null;
    expect(await enterDeviceRecovery(CLINIC, { code: code(), calledBack: true })).toMatchObject({
      ok: false,
      code: "unauthenticated",
    });
    session.operator = "ops@healdesk.test";
    expect(await enterDeviceRecovery(CLINIC, { code: code(), calledBack: false })).toMatchObject({
      ok: true,
      data: { status: "refused" },
    });
    expect(await enterDeviceRecovery(CLINIC, { code: "123456", calledBack: true })).toMatchObject({
      ok: true,
      data: { status: "refused" },
    });
    expect(sent).toEqual([]);

    replies.push(ISSUED);
    const once = code();
    await enterDeviceRecovery(CLINIC, { code: once, calledBack: true });
    expect(await enterDeviceRecovery(CLINIC, { code: once, calledBack: true })).toMatchObject({
      ok: true,
      data: { status: "refused" },
    });
    expect(sent).toHaveLength(1);
  });

  test("ending a link needs no code, and says whether a browser was signed out with it", async () => {
    replies.push({ data: { status: "ended", browsersSignedOut: 1 } });
    expect(await endDeviceRecovery(CLINIC)).toEqual({
      ok: true,
      data: { status: "ended", browsersSignedOut: 1 },
    });
    expect(sent).toEqual([{ op: "endDeviceRecovery", args: { clinicId: CLINIC } }]);
    replies.push({ data: { status: "none" } });
    expect(await endDeviceRecovery(CLINIC)).toEqual({ ok: true, data: { status: "none" } });
    // An apps/app deployed before the sign-out existed answers without the
    // count: it signed nobody out, and the console reads it so.
    replies.push({ data: { status: "ended" } });
    expect(await endDeviceRecovery(CLINIC)).toEqual({
      ok: true,
      data: { status: "ended", browsersSignedOut: 0 },
    });
    replies.push({ data: { status: "ended", browsersSignedOut: "one" } });
    expect(await endDeviceRecovery(CLINIC)).toMatchObject({ ok: false, code: "malformed" });
  });
});

describe("removing devices from /admin (O3's promise)", () => {
  test("with a session, the call back and a fresh code, it sends the devices picked and the tick", async () => {
    replies.push({
      data: {
        status: "done",
        removedDevices: 1,
        sessionsEnded: 2,
        backupReset: true,
        codesRevoked: 10,
      },
    });
    expect(
      await enterDeviceRemoval(CLINIC, { code: code(), calledBack: true, factorIds: [DEVICE] }),
    ).toMatchObject({ ok: true, data: { status: "done", removedDevices: 1 } });
    expect(sent).toEqual([
      {
        op: "removeClinicDevices",
        args: { clinicId: CLINIC, factorIds: [DEVICE], calledBack: true },
      },
    ]);
  });

  test("the reply alone is not enough: without the call back, a code, or with a device that is not an id, nothing crosses", async () => {
    for (const input of [
      { code: code(), calledBack: false, factorIds: [DEVICE] },
      { code: "000000", calledBack: true, factorIds: [DEVICE] },
      { code: code(), calledBack: true, factorIds: ["Front desk Mac"] },
      { code: code(), calledBack: true, factorIds: "all" },
    ]) {
      expect(await enterDeviceRemoval(CLINIC, input), JSON.stringify(input)).toMatchObject({
        ok: true,
        data: { status: "refused" },
      });
    }
    expect(sent).toEqual([]);
  });
});

const unused = async (): Promise<never> => {
  throw new Error("an action ran during a static render");
};

describe("the devices reader is strict", () => {
  const view = {
    clinicId: CLINIC,
    hasSignIn: true,
    devices: [
      {
        id: DEVICE,
        label: "Front desk Mac",
        addedAt: "2026-10-14T14:32:00.000Z",
        lastUsedAt: null,
      },
    ],
    hasBackup: true,
    backupCodesLeft: 9,
    sessions: 2,
    patientDataMayExist: true,
    addressChangeOpen: false,
    recoveries: [
      {
        id: LINK,
        state: "used",
        issuedBy: "ops@healdesk.test",
        createdAt: "2026-10-14T14:32:00.000Z",
        expiresAt: "2026-10-15T14:32:00.000Z",
        claimedAt: "2026-10-14T14:40:00.000Z",
        usedAt: "2026-10-14T14:41:00.000Z",
        revokedAt: null,
        revokedReason: null,
      },
    ],
  };

  test("reads the devices, the backup, the sessions and the links", async () => {
    replies.push({ data: view });
    expect(await fetchClinicDevices(CLINIC)).toEqual({ ok: true, data: view });
  });

  test("the reply of an apps/app deployed before the address check reads as no change open, never as malformed", async () => {
    const { addressChangeOpen: _, ...older } = view;
    void _;
    replies.push({ data: older });
    const read = await fetchClinicDevices(CLINIC);
    expect(read).toEqual({ ok: true, data: { ...view, addressChangeOpen: false } });
    // And the panel renders it as a working panel, not an error.
    const html = renderToStaticMarkup(
      createElement(DevicesSection, {
        view: read,
        actions: { issueRecovery: unused, endRecovery: unused, removeDevices: unused },
      }),
    );
    expect(html).toContain("Front desk Mac");
    expect(html).toContain("Send the link");
  });

  test("a link state or an end it does not know, or a fractional count, is refused, not shown", async () => {
    for (const bad of [
      { ...view, recoveries: [{ ...view.recoveries[0], state: "teleported" }] },
      { ...view, recoveries: [{ ...view.recoveries[0], revokedReason: "because" }] },
      { ...view, sessions: 1.5 },
      { ...view, addressChangeOpen: "no" },
    ]) {
      replies.push({ data: bad });
      expect(await fetchClinicDevices(CLINIC)).toMatchObject({ ok: false, code: "malformed" });
    }
  });
});
