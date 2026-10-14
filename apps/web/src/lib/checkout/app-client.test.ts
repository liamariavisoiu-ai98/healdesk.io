import { WELCOME_NONCE_TTL_SECONDS } from "@healdesk/catalog";
import { afterEach, describe, expect, test, vi } from "vitest";

import { sharedParentDomain, welcomeCookieOptions } from "./app-client";

/**
 * The /welcome nonce cookie's attributes. It is read by this site's /welcome
 * and then by apps/app's on another host, so it is set on the parent domain
 * the two share, worked out from HEALDESK_APP_URL; only the parent ever
 * reaches the browser.
 */

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("sharedParentDomain", () => {
  test("the parent the site and the app share", () => {
    expect(sharedParentDomain("healdesk.io", "app-internal.healdesk.io")).toBe("healdesk.io");
    expect(sharedParentDomain("www.healdesk.io", "app.healdesk.io")).toBe("healdesk.io");
    expect(sharedParentDomain("a.staging.healdesk.io", "b.staging.healdesk.io")).toBe("staging.healdesk.io");
  });

  test("none for one host, unrelated hosts, or only a top-level domain in common", () => {
    expect(sharedParentDomain("localhost", "localhost")).toBeUndefined();
    expect(sharedParentDomain("healdesk.io", "healdesk.io")).toBeUndefined();
    expect(sharedParentDomain("healdesk.io", "example.com")).toBeUndefined();
    expect(sharedParentDomain("healdesk.io", "other.io")).toBeUndefined();
  });
});

describe("welcomeCookieOptions", () => {
  test("Domain=healdesk.io for the production pair, path /welcome, httpOnly, Lax, the nonce's lifetime", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(welcomeCookieOptions("healdesk.io", "https://app-internal.healdesk.io")).toEqual({
      httpOnly: true,
      sameSite: "lax",
      secure: true,
      path: "/welcome",
      maxAge: WELCOME_NONCE_TTL_SECONDS,
      domain: "healdesk.io",
    });
    expect(WELCOME_NONCE_TTL_SECONDS).toBe(30 * 60);
  });

  test("host-only without the app's address, with a bad one, or on one host", () => {
    for (const appUrl of [undefined, "not a url", "http://localhost:3001"]) {
      expect(welcomeCookieOptions("localhost", appUrl), String(appUrl)).not.toHaveProperty("domain");
    }
    expect(welcomeCookieOptions("healdesk.io", undefined)).not.toHaveProperty("domain");
  });
});
