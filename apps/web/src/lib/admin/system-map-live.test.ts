import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { FakeSheets, __setSheetsClientForTests } from "@/lib/sheets/client";
import { __resetSheetSchemaForTests } from "@/lib/sheets/schema";

import { credentialKeyStatus, keyPresence } from "./ops-client";
import { checkGithubToken, parseTokenExpiry } from "./github-token";
import { readRotations, recordRotation } from "./key-rotations";
import { gatherLive, stripeMode, vercelPresence } from "./system-map-live";

vi.mock("./ops-client", () => ({ keyPresence: vi.fn(), credentialKeyStatus: vi.fn() }));

/**
 * The system map's live half: presence is yes or no, the GitHub check reads
 * only a status and a date, and the rotation log keeps names and dates.
 */

describe("vercelPresence", () => {
  afterEach(() => vi.unstubAllEnvs());

  test("answers booleans, and an empty value or the placeholder is unset", () => {
    vi.stubEnv("RESEND_API_KEY", "re_value_that_must_not_appear");
    vi.stubEnv("CRON_SECRET", "   ");
    vi.stubEnv("STRIPE_WEBHOOK_SECRET", "__unset__");
    vi.stubEnv("GOOGLE_SERVICE_ACCOUNT_JSON", "not a key file");
    const present = vercelPresence();
    expect(present.RESEND_API_KEY).toBe(true);
    expect(present.CRON_SECRET).toBe(false);
    expect(present.STRIPE_WEBHOOK_SECRET).toBe(false);
    expect(present.GOOGLE_SERVICE_ACCOUNT_JSON).toBe(false);
    expect(Object.values(present).every((v) => typeof v === "boolean")).toBe(true);
    expect(JSON.stringify(present)).not.toContain("re_value_that_must_not_appear");
  });

  test("the Stripe mode is read from the public prefix only", () => {
    expect(stripeMode("sk_live_abc")).toBe("live");
    expect(stripeMode("rk_test_abc")).toBe("test");
    expect(stripeMode("pk_live_abc")).toBeNull();
    expect(stripeMode(undefined)).toBeNull();
  });
});

describe("the GitHub token check", () => {
  test("reads GitHub's expiry header in the shapes it is written in", () => {
    expect(parseTokenExpiry("2026-11-30 10:00:00 UTC")?.toISOString()).toBe("2026-11-30T10:00:00.000Z");
    expect(parseTokenExpiry("2026-11-30 10:00:00 +0000")?.toISOString()).toBe("2026-11-30T10:00:00.000Z");
    expect(parseTokenExpiry("2026-11-30 12:00:00 +02:00")?.toISOString()).toBe("2026-11-30T10:00:00.000Z");
    expect(parseTokenExpiry("next Tuesday")).toBeNull();
    expect(parseTokenExpiry(null)).toBeNull();
  });

  test("401 is a rejected token; another failure says nothing about it", async () => {
    const answer = (status: number, headers: Record<string, string> = {}) =>
      vi.fn(async () => new Response("{}", { status, headers })) as unknown as typeof fetch;

    expect(await checkGithubToken("t", answer(401))).toEqual({ ok: false, reason: "rejected" });
    expect(await checkGithubToken("t", answer(503))).toEqual({ ok: false, reason: "unreachable" });
    const thrown = vi.fn(async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    expect(await checkGithubToken("t", thrown)).toEqual({ ok: false, reason: "unreachable" });

    const fine = await checkGithubToken("t", answer(200, { "github-authentication-token-expiration": "2026-12-01 00:00:00 UTC" }));
    expect(fine).toEqual({ ok: true, expiresAt: new Date("2026-12-01T00:00:00Z") });
    expect(await checkGithubToken("t", answer(200))).toEqual({ ok: true, expiresAt: null });
  });

  test("sends the token only to GitHub's rate-limit endpoint", async () => {
    const seen: string[] = [];
    const spy = vi.fn(async (url: string | URL | Request) => {
      seen.push(String(url));
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    await checkGithubToken("t", spy);
    expect(seen).toEqual(["https://api.github.com/rate_limit"]);
  });
});

describe("the rotation log", () => {
  let sheets: FakeSheets;

  beforeEach(() => {
    sheets = new FakeSheets();
    __setSheetsClientForTests(sheets);
    __resetSheetSchemaForTests();
  });

  afterEach(() => {
    __setSheetsClientForTests(null);
    __resetSheetSchemaForTests();
  });

  test("appends a row per press, and the newest row for a key is its last rotation", async () => {
    expect(await recordRotation("vercel.STRIPE_SECRET_KEY", "owner@healdesk.test", new Date("2026-04-01T09:00:00Z"))).toEqual({
      ok: true,
      on: "2026-04-01",
    });
    await recordRotation("vercel.STRIPE_SECRET_KEY", "owner@healdesk.test", new Date("2026-10-01T09:00:00Z"));
    await recordRotation("vercel.CRON_SECRET", "owner@healdesk.test", new Date("2026-09-01T09:00:00Z"));

    const rows = sheets.records("key_rotations");
    expect(rows).toHaveLength(3);
    expect(Object.keys(rows[0]!)).toEqual(["id", "key_id", "rotated_at", "recorded_by"]);

    const log = await readRotations();
    expect(log.ok).toBe(true);
    if (!log.ok) return;
    expect(log.last["vercel.STRIPE_SECRET_KEY"]?.toISOString()).toBe("2026-10-01T09:00:00.000Z");
    expect(log.last["vercel.CRON_SECRET"]?.toISOString()).toBe("2026-09-01T09:00:00.000Z");
  });

  test("refuses a key that is not on the map, or has no schedule to count against", async () => {
    expect(await recordRotation("vercel.NOT_A_KEY", "owner@healdesk.test")).toMatchObject({ ok: false });
    expect(await recordRotation("aws.HEALDESK_IDENTIFIER_REF_KEY", "owner@healdesk.test")).toMatchObject({ ok: false });
    expect(await recordRotation("vercel.MARKETING_SHEET_ID", "owner@healdesk.test")).toMatchObject({ ok: false });
    // Refused before the Sheet is touched at all.
    expect(sheets.tabs.has("key_rotations")).toBe(false);
  });
});

describe("asking the engine", () => {
  beforeEach(() => {
    vi.stubEnv("GITHUB_TOKEN", "");
    vi.stubEnv("HEALDESK_GITHUB_ACTIONS_TOKEN", "");
    vi.stubEnv("MARKETING_SHEET_ID", "");
    vi.mocked(credentialKeyStatus).mockResolvedValue({ ok: false, code: "unreachable", message: "x" });
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.mocked(keyPresence).mockReset();
  });

  test("an engine too old to know the question is can't-check, not a broken seal", async () => {
    vi.mocked(keyPresence).mockResolvedValue({ ok: false, code: "outdated", message: "x" });
    const live = await gatherLive();
    expect(live.host.state).toBe("silent");
    expect(live.host.state === "silent" && live.host.message).toContain("deploy the engine");
  });

  test("a refusal points at the seal first", async () => {
    vi.mocked(keyPresence).mockResolvedValue({ ok: false, code: "refused", message: "x" });
    const live = await gatherLive();
    expect(live.host).toMatchObject({ state: "refused" });
    expect(live.host.state === "refused" && live.host.message).toContain("HEALDESK_PROVISION_SECRET");
  });

  test("an answer carries presence through, and the key safe counts only when the host answered", async () => {
    vi.mocked(keyPresence).mockResolvedValue({ ok: true, data: { present: { STRIPE_SECRET_KEY: true }, stripeMode: "test" } });
    vi.mocked(credentialKeyStatus).mockResolvedValue({ ok: true, data: { provider: "aws-kms", keyConfigured: true, ok: true, error: null } });
    const live = await gatherLive();
    expect(live.host).toEqual({ state: "answered", present: { STRIPE_SECRET_KEY: true }, stripeMode: "test" });
    expect(live.proofs.kms?.ok).toBe(true);

    vi.mocked(keyPresence).mockResolvedValue({ ok: false, code: "unreachable", message: "x" });
    expect((await gatherLive()).proofs.kms).toBeUndefined();
  });
});
