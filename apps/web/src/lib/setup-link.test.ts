import { afterEach, describe, expect, test, vi } from "vitest";

import {
  issueSetupToken,
  readCookie,
  setupCookieOptions,
  setupLinkExpiry,
  setupLinkUrl,
  setupTokenRequestId,
  verifySetupToken,
} from "./setup-link";

const ID = "6f1f7c1e-2f0e-4d2b-9a0a-3f5e2c1d4b7a";
const NOW = new Date("2026-10-06T14:00:00Z");

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("the setup link token", () => {
  test("verifies for the request's own address, in any case, until it expires", () => {
    const expiresAt = setupLinkExpiry(NOW);
    const token = issueSetupToken(ID, "Alex@Radiance.com", expiresAt);
    expect(setupTokenRequestId(token)).toBe(ID);
    expect(verifySetupToken(token, "alex@radiance.com", NOW)).toEqual({ ok: true, requestId: ID, expiresAt });
    expect(verifySetupToken(token, "alex@radiance.com", expiresAt)).toEqual({ ok: false, reason: "expired" });
  });

  test("lasts fourteen days", () => {
    expect(setupLinkExpiry(NOW).getTime() - NOW.getTime()).toBe(14 * 24 * 60 * 60 * 1000);
  });

  test("is bound to the address: the same token fails for another one", () => {
    const token = issueSetupToken(ID, "alex@radiance.com", setupLinkExpiry(NOW));
    expect(verifySetupToken(token, "someone@else.com", NOW)).toEqual({ ok: false, reason: "forged" });
  });

  test("refuses an edited expiry, an edited id and a malformed token", () => {
    const expiresAt = setupLinkExpiry(NOW);
    const token = issueSetupToken(ID, "alex@radiance.com", expiresAt);
    const [id, expiry, mac] = token.split(".") as [string, string, string];
    const later = `${id}.${Number(expiry) + 86_400_000}.${mac}`;
    expect(verifySetupToken(later, "alex@radiance.com", NOW)).toEqual({ ok: false, reason: "forged" });
    const otherId = `${ID.replace("6f1f", "7f1f")}.${expiry}.${mac}`;
    expect(verifySetupToken(otherId, "alex@radiance.com", NOW)).toEqual({ ok: false, reason: "forged" });
    for (const bad of ["", "nonsense", `${ID}.abc.${mac}`, `${ID}.${expiry}`, null, undefined]) {
      expect(verifySetupToken(bad, "alex@radiance.com", NOW)).toEqual({ ok: false, reason: "malformed" });
    }
  });

  test("a key from another secret does not verify", () => {
    vi.stubEnv("HEALDESK_GATE_SECRET", "one");
    const token = issueSetupToken(ID, "alex@radiance.com", setupLinkExpiry(NOW));
    vi.stubEnv("HEALDESK_GATE_SECRET", "two");
    expect(verifySetupToken(token, "alex@radiance.com", NOW)).toEqual({ ok: false, reason: "forged" });
  });

  test("production without a secret signs nothing and verifies nothing", () => {
    const token = issueSetupToken(ID, "alex@radiance.com", setupLinkExpiry(NOW));
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("HEALDESK_GATE_SECRET", "");
    expect(() => issueSetupToken(ID, "alex@radiance.com", setupLinkExpiry(NOW))).toThrow(/HEALDESK_GATE_SECRET/);
    expect(verifySetupToken(token, "alex@radiance.com", NOW)).toEqual({ ok: false, reason: "forged" });
  });

  test("the emailed address goes through /start, never straight to the purchase", () => {
    const token = issueSetupToken(ID, "alex@radiance.com", setupLinkExpiry(NOW));
    expect(setupLinkUrl(token)).toMatch(/\/start\?t=/);
    expect(setupLinkUrl(token)).not.toMatch(/get-started/);
  });
});

describe("the setup cookie", () => {
  test("is httpOnly, lax, site-wide and dies with the link", () => {
    const expiresAt = new Date(NOW.getTime() + 3_600_000);
    expect(setupCookieOptions(expiresAt, NOW)).toEqual({
      httpOnly: true,
      sameSite: "lax",
      secure: false,
      path: "/",
      maxAge: 3600,
    });
  });

  test("is read from a raw Cookie header among others", () => {
    const headers = new Headers({ cookie: "a=1; hd_setup=x%2Ey.z; b=2" });
    expect(readCookie(headers, "hd_setup")).toBe("x.y.z");
    expect(readCookie(headers, "missing")).toBeNull();
    expect(readCookie(new Headers(), "hd_setup")).toBeNull();
  });
});
