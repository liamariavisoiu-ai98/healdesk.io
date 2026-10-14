import { beforeEach, describe, expect, test, vi } from "vitest";

const recorded = vi.hoisted(() => ({ calls: [] as [number, Date][] }));
vi.mock("@/lib/email/quota", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/email/quota")>()),
  recordDailyQuota: async (used: number, at: Date) => {
    recorded.calls.push([used, at]);
  },
}));

const { isMutating, isOpName, parseEnvelope, runOperation } = await import("@/lib/ops/api");

/**
 * emailQuota: Resend's daily count as one of apps/web's sends saw it, so the
 * 70-a-day alarm and the ops digest count the whole account (Annex X2), not
 * only this app's mail. It records through recordDailyQuota, whose own tests
 * cover the day's maximum and the one alert; here, only what the op accepts.
 * No database.
 */

const OPERATOR = { email: "ops@healdesk.test", request: {} };

async function relay(args: Record<string, unknown>) {
  const parsed = parseEnvelope(JSON.stringify({ op: "emailQuota", args }));
  if (!parsed.ok) throw new Error("emailQuota is not an operation");
  return runOperation(parsed.envelope.op, parsed.envelope.args, OPERATOR);
}

beforeEach(() => {
  recorded.calls.length = 0;
});

describe("emailQuota", () => {
  test("is on the list, and writes no audit row", () => {
    expect(isOpName("emailQuota")).toBe(true);
    expect(isMutating("emailQuota")).toBe(false);
  });

  test("records apps/web's observation of the day's count", async () => {
    const at = new Date().toISOString();
    const outcome = await relay({ used: 71, at });
    expect(outcome.status).toBe(200);
    expect(outcome.body).toEqual({ data: { recorded: true } });
    expect(recorded.calls).toEqual([[71, new Date(at)]]);
  });

  test("refuses anything that is not a count, or not today's", async () => {
    const now = new Date().toISOString();
    for (const args of [
      { used: "71", at: now },
      { used: 7.5, at: now },
      { used: -1, at: now },
      { used: 71 },
      { used: 71, at: "yesterday" },
      { used: 71, at: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString() },
    ]) {
      expect((await relay(args)).status, JSON.stringify(args)).toBe(400);
    }
    expect(recorded.calls).toEqual([]);
  });
});
