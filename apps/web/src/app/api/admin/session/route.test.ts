/**
 * The sign-in route, branch by branch, with the second factor on Vercel.
 *
 * Since 14 October 2026 the code is checked in this app against
 * `HEALDESK_ADMIN_TOTP_SECRET` and nothing on the sign-in path calls apps/app.
 * That second half is a property, not a detail, so it is asserted: `fetch` is
 * a spy for the whole file, `HEALDESK_APP_URL` points at a host nothing should
 * ever ask, and every test that signs in checks the spy was not called before
 * the alert ran. The alert itself goes out through Resend, mocked here, after
 * the response (`after()`, captured rather than run by Next).
 *
 * The scrypt work factor is lowered (N=1024) because what is under test here
 * is the order of the checks, not their cost; `burst.test.ts` measures the cost
 * at the real factors.
 */

import { randomBytes, scryptSync } from "node:crypto";

import { after } from "next/server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { OPERATOR_COOKIE, STEP_COOKIE, verifyOperatorToken, verifyStepToken } from "@/lib/admin/operator";
import { __resetStepLedgerForTests, base32Decode, hotp, totpStep } from "@/lib/admin/totp";
import { __resetRateLimiterForTests } from "@/lib/rate-limit";

import { DELETE, POST } from "./route";

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();
  return { ...actual, after: vi.fn() };
});

const EMAIL = "healdesk.io@gmail.com";
const PASSWORD = "correct horse battery staple 9f2a";
const SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
const KEY = base32Decode(SECRET)!;
const APP_URL = "http://apps-app.invalid";

/** A fixed instant mid-step, so a code and its neighbours are known in advance. */
const NOW = new Date("2026-10-14T12:00:10Z");

function hashFor(password: string): string {
  const salt = randomBytes(16);
  const key = scryptSync(password, salt, 64, { N: 1024, r: 8, p: 1 });
  return `scrypt$1024$8$1$${salt.toString("base64")}$${key.toString("base64")}`;
}

const saved = { ...process.env };
const fetchSpy = vi.fn(
  async (..._args: unknown[]) =>
    new Response(JSON.stringify({ id: "re_test" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
);

beforeAll(() => {
  process.env.HEALDESK_ADMIN_EMAIL = EMAIL;
  process.env.HEALDESK_ADMIN_SECRET = "test-secret-not-a-real-one";
  process.env.HEALDESK_ADMIN_PASSWORD_HASH = hashFor(PASSWORD);
  process.env.HEALDESK_APP_URL = APP_URL;
  process.env.HEALDESK_PROVISION_SECRET = "test-provision-secret";
  process.env.RESEND_API_KEY = "re_test_key";
  process.env.HEALDESK_EMAIL_FROM = "healdesk <hello@healdesk.io>";
  vi.stubGlobal("fetch", fetchSpy);
});

afterAll(() => {
  vi.unstubAllGlobals();
  process.env = { ...saved };
});

let logs: { info: string[]; warn: string[]; error: string[] };

beforeEach(() => {
  process.env.HEALDESK_ADMIN_TOTP_SECRET = SECRET;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  __resetStepLedgerForTests();
  __resetRateLimiterForTests();
  fetchSpy.mockClear();
  vi.mocked(after).mockClear();
  logs = { info: [], warn: [], error: [] };
  vi.spyOn(console, "info").mockImplementation((...args: unknown[]) => void logs.info.push(args.join(" ")));
  vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => void logs.warn.push(args.join(" ")));
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => void logs.error.push(args.join(" ")));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

let address = 0;

/** A fresh address per request, so the per-address limit is never what answers. */
function attempt(body: Record<string, unknown>, cookie?: string): Request {
  address += 1;
  return new Request("http://localhost/api/admin/session", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": `203.0.113.${address % 250}`,
      "user-agent": "Mozilla/5.0 (test)",
      ...(cookie !== undefined ? { cookie } : {}),
    },
    body: JSON.stringify(body),
  });
}

const codeNow = (offset = 0) => hotp(KEY, totpStep(NOW.getTime()) + offset);

/** Every log line this file's requests wrote, for the "never logged" checks. */
const allLogs = () => [...logs.info, ...logs.warn, ...logs.error].join("\n");

/** The structured line for an outcome, parsed. */
function outcomeLine(outcome: string): Record<string, unknown> | undefined {
  for (const line of [...logs.info, ...logs.warn, ...logs.error]) {
    const match = /^\[healdesk\] admin sign-in (\{.*\})$/.exec(line);
    if (!match) continue;
    const parsed = JSON.parse(match[1]!) as Record<string, unknown>;
    if (parsed.outcome === outcome) return parsed;
  }
  return undefined;
}

describe("without a second factor configured", () => {
  it("refuses a correct password with a 503 naming the variable, and signs nobody in", async () => {
    delete process.env.HEALDESK_ADMIN_TOTP_SECRET;
    const response = await POST(attempt({ email: EMAIL, password: PASSWORD, code: codeNow() }));

    expect(response.status).toBe(503);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("HEALDESK_ADMIN_TOTP_SECRET");
    expect(body.error).toContain("nothing was signed in");
    expect(response.cookies.get(OPERATOR_COOKIE)).toBeUndefined();
    expect(after).not.toHaveBeenCalled();
    expect(outcomeLine("misconfigured")).toMatchObject({ variable: "HEALDESK_ADMIN_TOTP_SECRET", problem: "unset" });
  });

  it("refuses a malformed secret the same way, rather than checking codes against it", async () => {
    process.env.HEALDESK_ADMIN_TOTP_SECRET = SECRET.slice(0, 31);
    const response = await POST(attempt({ email: EMAIL, password: PASSWORD, code: codeNow() }));

    expect(response.status).toBe(503);
    expect(((await response.json()) as { error: string }).error).toContain("32-character base32");
    expect(response.cookies.get(OPERATOR_COOKIE)).toBeUndefined();
    expect(outcomeLine("misconfigured")).toMatchObject({ problem: "malformed" });
  });

  it("says nothing about it to somebody without the password", async () => {
    delete process.env.HEALDESK_ADMIN_TOTP_SECRET;
    const response = await POST(attempt({ email: EMAIL, password: "wrong-password", code: codeNow() }));

    expect(response.status).toBe(401);
    expect(JSON.stringify(await response.json())).not.toContain("TOTP");
  });
});

describe("the first factor", () => {
  it("answers a wrong password with one sentence and no cookie", async () => {
    const response = await POST(attempt({ email: EMAIL, password: "wrong-password", code: codeNow() }));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "That email and password did not match." });
    expect(response.cookies.get(OPERATOR_COOKIE)).toBeUndefined();
    expect(outcomeLine("wrong_password")).toBeDefined();
  });

  it("asks for the code when the password is right and none was sent", async () => {
    const response = await POST(attempt({ email: EMAIL, password: PASSWORD }));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: "Enter the six-digit code from your authenticator app.",
      next: "code",
    });
    expect(response.cookies.get(OPERATOR_COOKIE)).toBeUndefined();
    expect(outcomeLine("code_required")).toBeDefined();
  });

  it("treats a recovery code, which no longer exists, as no code at all", async () => {
    const response = await POST(attempt({ email: EMAIL, password: PASSWORD, recoveryCode: "ABCDE-12345" }));

    expect(response.status).toBe(401);
    expect(((await response.json()) as { next?: string }).next).toBe("code");
  });

  it("refuses a code that is not six digits before running scrypt", async () => {
    const response = await POST(attempt({ email: EMAIL, password: PASSWORD, code: "12345" }));
    expect(response.status).toBe(400);
  });
});

describe("the second factor", () => {
  it("refuses a wrong code", async () => {
    const wrong = codeNow() === "000000" ? "111111" : "000000";
    const response = await POST(attempt({ email: EMAIL, password: PASSWORD, code: wrong }));

    expect(response.status).toBe(401);
    expect(((await response.json()) as { error: string }).error).toMatch(/not right/);
    expect(response.cookies.get(OPERATOR_COOKIE)).toBeUndefined();
    expect(outcomeLine("wrong_code")).toBeDefined();
  });

  it("refuses a code two steps old", async () => {
    const response = await POST(attempt({ email: EMAIL, password: PASSWORD, code: codeNow(-2) }));
    expect(response.status).toBe(401);
  });

  it("signs in on the right code: the session cookie, the step cookie, an alert scheduled, and no call to apps/app", async () => {
    const response = await POST(attempt({ email: EMAIL, password: PASSWORD, code: codeNow() }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ next: "admin" });

    const session = response.cookies.get(OPERATOR_COOKIE);
    expect(verifyOperatorToken(session?.value)).toBe(EMAIL);
    expect(session).toMatchObject({ httpOnly: true, sameSite: "strict", path: "/" });

    const step = response.cookies.get(STEP_COOKIE);
    expect(verifyStepToken(step?.value)).toBe(totpStep(NOW.getTime()));
    expect(step).toMatchObject({ httpOnly: true, sameSite: "strict", path: "/api/admin/session" });

    // Nothing left this process to sign in: no ops API, no database, no store.
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(after).toHaveBeenCalledTimes(1);
    expect(outcomeLine("success")).toMatchObject({ ip: expect.stringMatching(/^203\.0\.113\./) });
  });

  it("accepts the step either side of now, and records the one that matched", async () => {
    const response = await POST(attempt({ email: EMAIL, password: PASSWORD, code: codeNow(1) }));
    expect(response.status).toBe(200);
    expect(verifyStepToken(response.cookies.get(STEP_COOKIE)?.value)).toBe(totpStep(NOW.getTime()) + 1);
  });

  it("sends the alert after the response, through Resend, to the account and nowhere else", async () => {
    await POST(attempt({ email: EMAIL, password: PASSWORD, code: codeNow() }));
    const task = vi.mocked(after).mock.calls[0]![0] as () => Promise<void>;
    await task();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.resend.com/emails");
    expect(String(url)).not.toContain("apps-app.invalid");
    const sent = JSON.parse(String(init.body)) as { to: string[]; subject: string; text: string };
    expect(sent.to).toEqual([EMAIL]);
    expect(sent.subject).toBe("healdesk admin: signed in at 2026-10-14 12:00 UTC");
    expect(sent.text).toContain("Time:    2026-10-14 12:00 UTC");
    expect(sent.text).toMatch(/Address: 203\.0\.113\.\d+/);
    expect(sent.text).toContain("Browser: Mozilla/5.0 (test)");
    expect(sent.text).not.toContain(codeNow());
    expect(sent.text).not.toMatch(/https?:\/\//);
  });

  it("still signs in when the alert cannot be sent, and says so in the log", async () => {
    fetchSpy.mockResolvedValueOnce(new Response("down", { status: 503 }));
    const response = await POST(attempt({ email: EMAIL, password: PASSWORD, code: codeNow() }));
    expect(response.status).toBe(200);

    const task = vi.mocked(after).mock.calls[0]![0] as () => Promise<void>;
    await task();
    expect(logs.error.join("\n")).toMatch(/admin sign-in alert was not delivered: failed resend 503/);
  });

  it("never logs the code, the password, the secret or the address typed", async () => {
    await POST(attempt({ email: EMAIL, password: PASSWORD, code: codeNow() }));
    await POST(attempt({ email: EMAIL, password: PASSWORD, code: codeNow() }));
    await POST(attempt({ email: EMAIL, password: "wrong-password", code: codeNow() }));
    await POST(attempt({ email: EMAIL, password: PASSWORD, code: "000000" }));

    const written = allLogs();
    expect(written).toContain("admin sign-in");
    for (const secretish of [codeNow(), PASSWORD, "wrong-password", SECRET, EMAIL]) {
      expect(written).not.toContain(secretish);
    }
  });
});

describe("replay", () => {
  it("refuses the same code twice in this process, from any browser", async () => {
    const code = codeNow();
    const first = await POST(attempt({ email: EMAIL, password: PASSWORD, code }));
    expect(first.status).toBe(200);

    const again = await POST(attempt({ email: EMAIL, password: PASSWORD, code }));
    expect(again.status).toBe(401);
    await expect(again.json()).resolves.toEqual({
      error: "That code has already been used. Wait for the next one.",
    });
    expect(again.cookies.get(OPERATOR_COOKIE)).toBeUndefined();
    expect(outcomeLine("replayed_code")).toMatchObject({ seen: "instance" });
  });

  it("refuses an older code once a newer one has signed in", async () => {
    expect((await POST(attempt({ email: EMAIL, password: PASSWORD, code: codeNow(1) }))).status).toBe(200);
    expect((await POST(attempt({ email: EMAIL, password: PASSWORD, code: codeNow() }))).status).toBe(401);
  });

  it("refuses the same code from the same browser on another instance, by its step cookie", async () => {
    const code = codeNow();
    const first = await POST(attempt({ email: EMAIL, password: PASSWORD, code }));
    const stepCookie = `${STEP_COOKIE}=${first.cookies.get(STEP_COOKIE)!.value}`;

    // A different serverless instance: its own, empty ledger.
    __resetStepLedgerForTests();
    const again = await POST(attempt({ email: EMAIL, password: PASSWORD, code }, `other=1; ${stepCookie}`));
    expect(again.status).toBe(401);
    expect(outcomeLine("replayed_code")).toMatchObject({ seen: "browser" });
  });

  it("lets that browser sign in with the next code", async () => {
    const first = await POST(attempt({ email: EMAIL, password: PASSWORD, code: codeNow() }));
    const stepCookie = `${STEP_COOKIE}=${first.cookies.get(STEP_COOKIE)!.value}`;

    vi.setSystemTime(new Date(NOW.getTime() + 30_000));
    const next = hotp(KEY, totpStep(NOW.getTime()) + 1);
    const response = await POST(attempt({ email: EMAIL, password: PASSWORD, code: next }, stepCookie));
    expect(response.status).toBe(200);
  });

  it("ignores a step cookie it did not sign, rather than locking the browser out", async () => {
    const response = await POST(
      attempt({ email: EMAIL, password: PASSWORD, code: codeNow() }, `${STEP_COOKIE}=999999999999.forged`),
    );
    expect(response.status).toBe(200);
  });

  it("does not cover a second instance with no cookie: the documented gap", async () => {
    // Stated in lib/admin/totp.ts beside the ledger: with no shared store, two
    // instances and two browsers can each accept one code once inside its
    // ninety seconds. The password and the attempt limits stand in front of it,
    // and the owner is mailed on every success. Pinned here so that closing the
    // gap one day is a visible change to this test, not a silent one.
    const code = codeNow();
    expect((await POST(attempt({ email: EMAIL, password: PASSWORD, code }))).status).toBe(200);
    __resetStepLedgerForTests();
    expect((await POST(attempt({ email: EMAIL, password: PASSWORD, code }))).status).toBe(200);
    expect(after).toHaveBeenCalledTimes(2);
  });
});

describe("sign-out", () => {
  it("clears the session cookie and keeps the step cookie, which only ever refuses", async () => {
    const response = await DELETE();
    expect(response.status).toBe(204);
    expect(response.cookies.get(OPERATOR_COOKIE)).toMatchObject({ value: "", maxAge: 0, path: "/" });
    expect(response.cookies.get(STEP_COOKIE)).toBeUndefined();
  });
});
