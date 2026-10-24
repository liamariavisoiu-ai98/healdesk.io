import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

/**
 * `appAnswers`: the cheap, remembered question a personalised demo asks before
 * it chooses its engine. Yes only for a valid signed answer; no for anything
 * else, fast; and asked at most once every 30 seconds per instance.
 */

vi.mock("@/lib/admin/operator", () => ({ requireOperator: async () => "ops@healdesk.test" }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));

import { __resetAppAnswersForTests, appAnswers } from "@/lib/admin/ops-client";

let sent: { url: string; op: string; signed: boolean }[] = [];
let respond: () => Promise<Response>;

beforeEach(() => {
  sent = [];
  __resetAppAnswersForTests();
  respond = async () => Response.json({ data: { directBooking: false } });
  vi.stubEnv("HEALDESK_PROVISION_SECRET", "test-provision-secret");
  vi.stubEnv("HEALDESK_APP_URL", "http://ops.internal.test");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: URL, init: { body: string; headers: Record<string, string> }) => {
      sent.push({ url: String(url), op: (JSON.parse(init.body) as { op: string }).op, signed: Object.keys(init.headers).length >= 3 });
      return respond();
    }),
  );
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("appAnswers", () => {
  test("is yes for a valid signed answer, whatever it says, asking the cheapest read", async () => {
    expect(await appAnswers(1_000)).toBe(true);
    expect(sent).toEqual([{ url: "http://ops.internal.test/api/ops", op: "bookingSwitch", signed: true }]);
  });

  test("remembers the answer for 30 seconds, then asks again", async () => {
    expect(await appAnswers(0)).toBe(true);
    expect(await appAnswers(29_000)).toBe(true);
    expect(sent).toHaveLength(1);
    expect(await appAnswers(31_000)).toBe(true);
    expect(sent).toHaveLength(2);
  });

  test("asks once for a burst of simultaneous demo calls", async () => {
    const answers = await Promise.all([appAnswers(0), appAnswers(0), appAnswers(0)]);
    expect(answers).toEqual([true, true, true]);
    expect(sent).toHaveLength(1);
  });

  test("is no when apps/app refuses, and remembers the no", async () => {
    respond = async () => new Response("nope", { status: 503 });
    expect(await appAnswers(0)).toBe(false);
    expect(await appAnswers(5_000)).toBe(false);
    expect(sent).toHaveLength(1);
  });

  test("is no for an answer it cannot read", async () => {
    respond = async () => Response.json({ data: { somethingElse: 1 } });
    expect(await appAnswers(0)).toBe(false);
  });

  test("is no when the host cannot be reached, as in standby", async () => {
    respond = async () => {
      throw new TypeError("fetch failed");
    };
    expect(await appAnswers(0)).toBe(false);
  });

  test("is no, without asking, when the secret or the address is not set", async () => {
    vi.stubEnv("HEALDESK_APP_URL", "");
    expect(await appAnswers(0)).toBe(false);
    expect(sent).toHaveLength(0);
  });

  test("gives up after a second and a half", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    await appAnswers(0);
    expect(timeout).toHaveBeenCalledWith(1_500);
  });
});
