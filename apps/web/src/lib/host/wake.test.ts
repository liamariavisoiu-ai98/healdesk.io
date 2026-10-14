import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import type { OutboundEmail, SendResult } from "@/lib/email";

import type { DispatchResult } from "./github";
import { __resetWakeForTests, hostDidNotAnswer, WAKE_INTERVAL_MS, wakeHostForPaidInvoice } from "./wake";

/**
 * A first paid invoice while the AWS host is in standby (lib/host/wake.ts):
 * the Stripe webhook's provision call finds nothing, so the host is turned on
 * and the administrator told, once an hour at most, and nothing here can make
 * the webhook fail in a new way.
 */

const T0 = Date.parse("2026-10-14T12:00:00Z");

let dispatches: number;
let emails: OutboundEmail[];
let dispatchAnswer: DispatchResult;

function deps(now = T0) {
  return {
    now: () => now,
    dispatch: async () => {
      dispatches += 1;
      return dispatchAnswer;
    },
    email: async (message: OutboundEmail): Promise<SendResult> => {
      emails.push(message);
      return { status: "sent", providerId: "re_1" };
    },
  };
}

beforeEach(() => {
  __resetWakeForTests();
  dispatches = 0;
  emails = [];
  dispatchAnswer = { ok: true };
  vi.stubEnv("HEALDESK_GITHUB_ACTIONS_TOKEN", "github_pat_wake_test");
  vi.stubEnv("HEALDESK_ADMIN_EMAIL", "owner@healdesk.test");
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("which failures mean the host did not answer", () => {
  test("a network error, or a gateway's 502, 503 or 504", () => {
    expect(hostDidNotAnswer({ kind: "unreachable" })).toBe(true);
    for (const status of [502, 503, 504]) expect(hostDidNotAnswer({ kind: "retryable", status })).toBe(true);
  });

  test("not an answer from a host that is up: success, a 500, a 401, a 429, a refusal", () => {
    expect(hostDidNotAnswer({ kind: "ok" })).toBe(false);
    for (const status of [500, 401, 429]) expect(hostDidNotAnswer({ kind: "retryable", status })).toBe(false);
    expect(hostDidNotAnswer({ kind: "rejected", status: 409 })).toBe(false);
  });
});

describe("wakeHostForPaidInvoice", () => {
  test("dispatches host.yml once and emails the administrator once", async () => {
    const outcome = await wakeHostForPaidInvoice({ kind: "unreachable" }, "evt_1", deps());
    expect(dispatches).toBe(1);
    expect(emails).toHaveLength(1);
    expect(outcome).toMatchObject({ dispatched: { ok: true }, emailed: { status: "sent" } });

    const [email] = emails;
    expect(email!.to).toBe("owner@healdesk.test");
    expect(email!.subject).toMatch(/payment arrived while the AWS host was in standby: it is being turned on/);
    expect(email!.text).toContain("evt_1");
    expect(email!.text).toContain("/admin/host");
    expect(email!.idempotencyKey).toBe("hd-host-wake-2026-10-14T12-1");
    expect(email!.text).not.toContain("github_pat_wake_test");
  });

  test("Stripe's retries inside the hour change nothing; the next hour asks again", async () => {
    await wakeHostForPaidInvoice({ kind: "unreachable" }, "evt_1", deps());
    expect(await wakeHostForPaidInvoice({ kind: "retryable", status: 503 }, "evt_1", deps(T0 + 10 * 60 * 1000))).toBe("already-asked");
    expect(await wakeHostForPaidInvoice({ kind: "unreachable" }, "evt_2", deps(T0 + WAKE_INTERVAL_MS - 1))).toBe("already-asked");
    expect(dispatches).toBe(1);
    expect(emails).toHaveLength(1);

    await wakeHostForPaidInvoice({ kind: "unreachable" }, "evt_1", deps(T0 + WAKE_INTERVAL_MS));
    expect(dispatches).toBe(2);
    expect(emails).toHaveLength(2);
    expect(emails[1]!.idempotencyKey).toBe("hd-host-wake-2026-10-14T13-1");
  });

  test("does nothing for a host that answered", async () => {
    expect(await wakeHostForPaidInvoice({ kind: "retryable", status: 500 }, "evt_1", deps())).toBe("not-needed");
    expect(await wakeHostForPaidInvoice({ kind: "ok" }, "evt_1", deps())).toBe("not-needed");
    expect(dispatches + emails.length).toBe(0);
  });

  test("does nothing without the token, and says so in the log", async () => {
    vi.stubEnv("HEALDESK_GITHUB_ACTIONS_TOKEN", "");
    expect(await wakeHostForPaidInvoice({ kind: "unreachable" }, "evt_1", deps())).toBe("no-token");
    expect(dispatches + emails.length).toBe(0);
    expect(console.warn).toHaveBeenCalled();
  });

  test("a dispatch GitHub refused is still emailed, saying how to turn it on by hand", async () => {
    dispatchAnswer = { ok: false, status: 401, message: "GitHub refused HEALDESK_GITHUB_ACTIONS_TOKEN." };
    await wakeHostForPaidInvoice({ kind: "unreachable" }, "evt_1", deps());
    expect(emails).toHaveLength(1);
    expect(emails[0]!.subject).toMatch(/could not be turned on/);
    expect(emails[0]!.text).toContain("Actions, Host, mode active");
  });

  test("never throws: not when GitHub throws, not when the email throws", async () => {
    await expect(
      wakeHostForPaidInvoice({ kind: "unreachable" }, "evt_1", {
        now: () => T0,
        dispatch: async () => {
          throw new Error("boom");
        },
      }),
    ).resolves.toBe("not-needed");

    __resetWakeForTests();
    await expect(
      wakeHostForPaidInvoice({ kind: "unreachable" }, "evt_1", {
        now: () => T0,
        dispatch: async () => ({ ok: true }),
        email: async () => {
          throw new Error("resend down");
        },
      }),
    ).resolves.toBe("not-needed");
  });

  test("with the real dispatch, GitHub is asked for host.yml with mode active and the reason", async () => {
    const calls: { url: string; body: string }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url: String(url), body: String(init.body) });
        return new Response(null, { status: 204 });
      }),
    );
    await wakeHostForPaidInvoice({ kind: "unreachable" }, "evt_1", { now: () => T0, email: deps().email });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toMatch(/\/actions\/workflows\/host\.yml\/dispatches$/);
    expect(JSON.parse(calls[0]!.body)).toEqual({ ref: "main", inputs: { mode: "active", reason: "first paid invoice" } });
  });

  test("no administrator address: dispatched, nothing emailed", async () => {
    vi.stubEnv("HEALDESK_ADMIN_EMAIL", "");
    expect(await wakeHostForPaidInvoice({ kind: "unreachable" }, "evt_1", deps())).toMatchObject({ emailed: "no-address" });
    expect(dispatches).toBe(1);
    expect(emails).toHaveLength(0);
  });
});
