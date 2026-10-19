import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { send } from "./index";
import { __resetQuotaReportsForTests, quotaFromHeader, shouldReportQuota } from "./quota";

/**
 * Resend's daily count (`x-resend-daily-quota`) as this site's sends see it,
 * handed to apps/app's emailQuota op so its 70-a-day alarm and the ops digest
 * count this site's mail too (Annex X2). Resend and apps/app are stubbed.
 */

type Call = { url: string; body: Record<string, unknown> };
let calls: Call[];
let quota: string | null;

beforeEach(() => {
  calls = [];
  quota = "12";
  __resetQuotaReportsForTests();
  vi.stubEnv("RESEND_API_KEY", "re_test");
  vi.stubEnv("HEALDESK_EMAIL_FROM", "healdesk <noreply@healdesk.io>");
  vi.stubEnv("HEALDESK_PROVISION_SECRET", "test-secret");
  vi.stubEnv("HEALDESK_APP_URL", "http://app.internal.test");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown, init?: RequestInit) => {
      calls.push({
        url: String(url),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      });
      if (String(url).startsWith("https://api.resend.com/")) {
        return Response.json(
          { id: "re_1" },
          { headers: quota === null ? {} : { "x-resend-daily-quota": quota } },
        );
      }
      return Response.json({ data: { recorded: true } });
    }),
  );
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const reports = () =>
  calls.filter((c) => c.url === "http://app.internal.test/api/ops").map((c) => c.body);
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

async function mail(): Promise<void> {
  await send({ to: "a@b.test", subject: "s", text: "t" });
  await flush();
}

describe("the daily count reaches apps/app", () => {
  test("the first count of the day goes to apps/app as emailQuota, with no browser context", async () => {
    await mail();
    expect(reports()).toEqual([{ op: "emailQuota", args: { used: 12, at: expect.any(String) } }]);
  });

  test("below the alarm, again only once the count has grown by ten", async () => {
    await mail();
    quota = "15";
    await mail();
    quota = "22";
    await mail();
    expect(reports().map((r) => (r.args as { used: number }).used)).toEqual([12, 22]);
  });

  test("at or past the alarm, every observation that is higher", async () => {
    quota = "69";
    await mail();
    for (const n of ["70", "70", "71"]) {
      quota = n;
      await mail();
    }
    expect(reports().map((r) => (r.args as { used: number }).used)).toEqual([69, 70, 71]);
  });

  test("nothing without the header, or on a deployment that cannot reach apps/app", async () => {
    quota = null;
    await mail();
    vi.stubEnv("HEALDESK_APP_URL", "");
    quota = "90";
    await mail();
    expect(reports()).toEqual([]);
  });

  test("a failed report never fails the send", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown) =>
        String(url).startsWith("https://api.resend.com/")
          ? Response.json({ id: "re_1" }, { headers: { "x-resend-daily-quota": "80" } })
          : Promise.reject(new Error("host in standby")),
      ),
    );
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await send({ to: "a@b.test", subject: "s", text: "t" })).toEqual({
      status: "sent",
      providerId: "re_1",
    });
    await flush();
  });
});

describe("the rules", () => {
  test("the header is a count, or nothing", () => {
    expect(quotaFromHeader("42")).toBe(42);
    expect(quotaFromHeader(" 7 ")).toBe(7);
    for (const value of [null, "", "x", "-1", "4.2", "1e3"])
      expect(quotaFromHeader(value)).toBeNull();
  });

  test("a new UTC day always reports", () => {
    const at = new Date("2026-10-15T00:01:00Z");
    expect(shouldReportQuota(3, at, { day: "2026-10-14", used: 95 })).toBe(true);
    expect(shouldReportQuota(3, at, null)).toBe(true);
  });
});
