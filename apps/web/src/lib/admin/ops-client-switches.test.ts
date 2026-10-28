import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

/** The clinic-switch operations against a stubbed upstream, shaped as the lane contract (28 October 2026) defines them. */

vi.mock("@/lib/admin/operator", () => ({ requireOperator: async () => "ops@healdesk.test" }));
vi.mock("next/headers", () => ({ headers: async () => new Headers({ "user-agent": "vitest" }) }));

import { fetchClinicSwitches, setClinicSwitch } from "@/lib/admin/ops-client";

const CLINIC = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
let replies: { status?: number; body: unknown }[] = [];
let sent: { op: string; args: Record<string, unknown> }[] = [];

beforeEach(() => {
  replies = [];
  sent = [];
  vi.stubEnv("HEALDESK_PROVISION_SECRET", "test-provision-secret");
  vi.stubEnv("HEALDESK_APP_URL", "http://ops.internal.test");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: unknown, init: { body: string }) => {
      const envelope = JSON.parse(init.body) as { op: string; args: Record<string, unknown> };
      sent.push({ op: envelope.op, args: envelope.args });
      const next = replies.shift();
      if (!next) throw new Error("no stubbed reply");
      return new Response(JSON.stringify(next.body), { status: next.status ?? 200, headers: { "content-type": "application/json" } });
    }),
  );
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const ROW = { key: "channel_web", label: "Website chat", kind: "switch", value: true, enabled: true, reason: null, operatorMayChange: true };

describe("fetchClinicSwitches", () => {
  test("sends the clinic id and reads every row field", async () => {
    const options = [
      { id: "deposit_only", label: "Deposit only" },
      { id: "full_payment", label: "Full payment" },
    ];
    replies.push({ body: { data: { switches: [ROW, { ...ROW, key: "payment_ask", kind: "choice", value: "deposit_only", enabled: false, reason: "Connect Stripe first.", options }] } } });
    const result = await fetchClinicSwitches(CLINIC);
    expect(sent).toEqual([{ op: "getClinicSwitches", args: { clinicId: CLINIC } }]);
    expect(result).toMatchObject({ ok: true, data: { switches: [{ key: "channel_web", value: true }, { value: "deposit_only", reason: "Connect Stripe first.", options }] } });
    if (result.ok) expect(result.data.switches[0]!.options).toBeUndefined();
  });

  test("a choice's option without a label is a malformed answer", async () => {
    replies.push({ body: { data: { switches: [{ ...ROW, kind: "choice", value: "warm", options: [{ id: "warm" }] }] } } });
    expect(await fetchClinicSwitches(CLINIC)).toMatchObject({ ok: false, code: "malformed" });
  });

  test("a value of the wrong type for its kind is a malformed answer", async () => {
    replies.push({ body: { data: { switches: [{ ...ROW, value: "yes" }] } } });
    expect(await fetchClinicSwitches(CLINIC)).toMatchObject({ ok: false, code: "malformed" });
  });
});

describe("setClinicSwitch", () => {
  test("sends clinic, key and value and reads the toast and the resets", async () => {
    replies.push({ body: { data: { ok: true, toast: "Saved.", resets: [{ switch: "payment_ask", notice: "Back to deposit only." }] } } });
    const result = await setClinicSwitch(CLINIC, "auto_confirm", false);
    expect(sent).toEqual([{ op: "setClinicSwitch", args: { clinicId: CLINIC, key: "auto_confirm", value: false } }]);
    expect(result).toEqual({ ok: true, data: { status: "set", toast: "Saved.", resets: [{ switch: "payment_ask", notice: "Back to deposit only." }] } });
  });

  test("a problem becomes a refusal carrying its sentence, or a plain one when it has none", async () => {
    replies.push({ body: { data: { ok: false, message: "Connect Stripe first." } } });
    expect(await setClinicSwitch(CLINIC, "text_payment_link", true)).toEqual({ ok: true, data: { status: "refused", message: "Connect Stripe first." } });
    replies.push({ body: { data: { ok: false } } });
    const silent = await setClinicSwitch(CLINIC, "text_payment_link", true);
    expect(silent).toMatchObject({ ok: true, data: { status: "refused" } });
  });

  test("an unreachable host is a failed call, not a refusal", async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error("ECONNREFUSED"));
    expect(await setClinicSwitch(CLINIC, "tone", "warm")).toMatchObject({ ok: false, code: "unreachable" });
  });
});
