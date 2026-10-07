import { afterEach, describe, expect, test, vi } from "vitest";

import { connectRedirectUri, connectReturnUrl, mintConnectState } from "@/lib/billing/connect";
import { bookingRequestUrl } from "@/lib/meta/booking-requests";
import { publicOrigin, publicOriginProblem, publicUrl, PublicUrlError } from "@/lib/public-url";

/**
 * publicUrl() (design D16): every clinic-facing link from BETTER_AUTH_URL, and
 * never a development fallback in production.
 */

describe("publicUrl", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test("builds from BETTER_AUTH_URL without doubling or losing a slash", () => {
    vi.stubEnv("BETTER_AUTH_URL", "https://app.healdesk.io/");
    expect(publicUrl("/link/abc")).toBe("https://app.healdesk.io/link/abc");
    vi.stubEnv("BETTER_AUTH_URL", "https://app.healdesk.io");
    expect(publicUrl("/setup/xyz")).toBe("https://app.healdesk.io/setup/xyz");
    vi.stubEnv("BETTER_AUTH_URL", "https://healdesk.example/app/");
    expect(publicOrigin()).toBe("https://healdesk.example/app");
    expect(publicUrl("/link/abc")).toBe("https://healdesk.example/app/link/abc");
  });

  test("throws in production when BETTER_AUTH_URL is unset, rather than mailing a localhost link", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("BETTER_AUTH_URL", "");
    expect(() => publicUrl("/link/abc")).toThrow(PublicUrlError);
    expect(() => publicUrl("/link/abc")).toThrow(/BETTER_AUTH_URL is not set/);
  });

  test("falls back to the local app outside production", () => {
    vi.stubEnv("BETTER_AUTH_URL", "");
    expect(publicUrl("/link/abc")).toBe("http://localhost:3001/link/abc");
  });

  test("refuses a malformed origin and any path that would leave the origin", () => {
    vi.stubEnv("BETTER_AUTH_URL", "app.healdesk.io");
    expect(() => publicUrl("/x")).toThrow(PublicUrlError);
    vi.stubEnv("BETTER_AUTH_URL", "javascript:alert(1)");
    expect(() => publicUrl("/x")).toThrow(PublicUrlError);
    vi.stubEnv("BETTER_AUTH_URL", "https://app.healdesk.io");
    for (const path of [
      "link/abc",
      "//evil.example/x",
      "https://evil.example",
      "/\\evil.example",
      "/\t/evil.example",
      "/\n/evil.example",
    ]) {
      expect(() => publicUrl(path), path).toThrow(PublicUrlError);
    }
  });

  test("the existing clinic-facing builders go through it", () => {
    vi.stubEnv("BETTER_AUTH_URL", "https://app.healdesk.io/");
    expect(bookingRequestUrl("tok")).toBe("https://app.healdesk.io/booking/tok");
    expect(connectRedirectUri()).toBe("https://app.healdesk.io/api/connect/stripe");
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("BETTER_AUTH_URL", "");
    expect(() => bookingRequestUrl("tok")).toThrow(PublicUrlError);
  });

  test("publicOriginProblem lets a caller check before it mints a link", () => {
    vi.stubEnv("BETTER_AUTH_URL", "https://app.healdesk.io");
    expect(publicOriginProblem()).toBeNull();
    vi.stubEnv("BETTER_AUTH_URL", "app.healdesk.io");
    expect(publicOriginProblem()).toMatch(/not a URL/);
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("BETTER_AUTH_URL", "");
    expect(publicOriginProblem()).toMatch(/BETTER_AUTH_URL is not set/);
  });

  test("a missing origin refuses a Connect link before any state is minted", async () => {
    vi.stubEnv("STRIPE_CONNECT_CLIENT_ID", "ca_test");
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_x");
    vi.stubEnv("BETTER_AUTH_URL", "app.healdesk.io");
    // Refused before the database is touched: there is no tenant to open here.
    await expect(
      mintConnectState({ clinicId: "00000000-0000-4000-8000-000000000001", returnTo: "ops" }),
    ).rejects.toMatchObject({ name: "ConnectError", code: "no_public_origin" });
  });

  test("the Connect callback's redirects are built on the public origin, never /admin", () => {
    vi.stubEnv("BETTER_AUTH_URL", "https://app.healdesk.io/");
    expect(connectReturnUrl({ status: "invalid_state" })).toBe(
      "https://app.healdesk.io/connect/stripe/done?result=expired",
    );
    expect(
      connectReturnUrl({
        status: "connected",
        target: { clinicId: "c", slug: "glow", returnTo: "settings" },
        accountLabel: null,
      }),
    ).toBe("https://app.healdesk.io/c/glow/settings?connect=ok");
    // A broken origin still redirects, on this app, rather than failing the browser.
    vi.stubEnv("BETTER_AUTH_URL", "app.healdesk.io");
    expect(connectReturnUrl({ status: "unbound" })).toBe("/connect/stripe/done?result=failed");
  });
});
