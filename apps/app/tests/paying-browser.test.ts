import { randomBytes } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

import {
  isPayingBrowser,
  markPayingBrowser,
  PAYING_BROWSER_COOKIE,
  payingBrowserCookie,
  payingBrowserValue,
} from "@/lib/sign-in/paying-browser";

import { closePools, hasTestDatabase, runMigrations, truncateAll } from "./setup/db";
import { seedClinic, seedPortalUser } from "./setup/factories";

/**
 * O3 for a first passkey (Annex X5): "a passkey is added (except the first,
 * in the paying browser)". The browser that spent the checkout link at
 * /welcome is marked by a cookie (lib/sign-in/paying-browser.ts); adding the
 * sign-in's first device there sends nothing, and adding it from any other
 * session emails the clinic's address. Before this, no first passkey sent
 * O3 from any session.
 */

const mocks = vi.hoisted(() => ({
  verifyRegistrationResponse: vi.fn(),
  notify: vi.fn(),
  cookie: undefined as string | undefined,
  portal: { userId: "", clinicId: "", clinicSlug: "" },
  sessionToken: "",
}));

vi.mock("@simplewebauthn/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@simplewebauthn/server")>()),
  verifyRegistrationResponse: mocks.verifyRegistrationResponse,
}));
vi.mock("@/lib/notices/device-changes", () => ({ notifyDeviceChange: mocks.notify }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === PAYING_BROWSER_COOKIE && mocks.cookie !== undefined
        ? { name, value: mocks.cookie }
        : undefined,
  }),
  headers: async () => new Headers({ "user-agent": "vitest" }),
}));
vi.mock("@/lib/portal/access", () => ({
  requirePortal: async () => mocks.portal,
  currentSessionToken: async () => mocks.sessionToken,
  portalGrants: async () => [],
}));

const describeDb = hasTestDatabase ? describe : describe.skip;
const NOW = new Date("2026-10-14T12:00:00Z");
const ORIGIN = "http://localhost:3001";
const b64 = (value: string | Buffer) => Buffer.from(value).toString("base64url");

describe("the paying browser's mark", () => {
  test("holds for the user it was minted for, for seven days, and for nobody else", () => {
    const value = payingBrowserValue("user_a", NOW);
    expect(isPayingBrowser("user_a", value, NOW)).toBe(true);
    expect(isPayingBrowser("user_a", value, new Date(NOW.getTime() + 6 * 86_400_000))).toBe(true);
    expect(isPayingBrowser("user_a", value, new Date(NOW.getTime() + 7 * 86_400_000))).toBe(false);
    expect(isPayingBrowser("user_b", value, NOW)).toBe(false);
  });

  test("a forged, altered or missing value is no mark", () => {
    const value = payingBrowserValue("user_a", NOW);
    const [expires, signature] = value.split(".") as [string, string];
    expect(isPayingBrowser("user_a", undefined, NOW)).toBe(false);
    expect(isPayingBrowser("user_a", "", NOW)).toBe(false);
    expect(isPayingBrowser("user_a", "yes", NOW)).toBe(false);
    // A later expiry under the old signature.
    expect(isPayingBrowser("user_a", `${Number(expires) + 86_400}.${signature}`, NOW)).toBe(false);
    // A signature of the right shape that this app did not make.
    expect(isPayingBrowser("user_a", `${expires}.${b64(randomBytes(32))}`, NOW)).toBe(false);
  });

  test("an HttpOnly, whole-app, Lax cookie, set only when the link spent is the checkout link", () => {
    expect(payingBrowserCookie("user_a", NOW)).toMatchObject({
      name: PAYING_BROWSER_COOKIE,
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: 7 * 24 * 60 * 60,
    });
    const set = vi.fn();
    expect(markPayingBrowser({ purpose: "welcome", userId: "user_a" }, { set }, NOW)).toBe(false);
    expect(markPayingBrowser({ purpose: "sign_in", userId: "user_a" }, { set }, NOW)).toBe(false);
    expect(set).not.toHaveBeenCalled();
    expect(markPayingBrowser({ purpose: "checkout", userId: "user_a" }, { set }, NOW)).toBe(true);
    expect(set).toHaveBeenCalledWith(payingBrowserCookie("user_a", NOW));
  });
});

/** What the library concludes about a registration: verified, user verified, this credential. */
function registers(credentialId: string) {
  mocks.verifyRegistrationResponse.mockResolvedValueOnce({
    verified: true,
    registrationInfo: {
      fmt: "none",
      aaguid: "00000000-0000-0000-0000-000000000000",
      credential: {
        id: credentialId,
        publicKey: new Uint8Array(randomBytes(77)),
        counter: 0,
        transports: ["internal"],
      },
      credentialType: "public-key",
      attestationObject: new Uint8Array(1),
      userVerified: true,
      credentialDeviceType: "multiDevice",
      credentialBackedUp: true,
      origin: ORIGIN,
      rpID: "localhost",
    },
  });
}

describeDb("adding the sign-in's first device", () => {
  beforeAll(async () => {
    await runMigrations();
    // The page's actions, imported once outside any test's clock.
    await import("@/app/c/[slug]/protect/actions");
  }, 120_000);

  beforeEach(async () => {
    await truncateAll();
    mocks.notify.mockReset();
    mocks.verifyRegistrationResponse.mockReset();
    mocks.cookie = undefined;
    mocks.sessionToken = b64(randomBytes(24));
  });

  afterAll(async () => {
    await closePools();
  });

  /**
   * The sign-in's first device, through the protect page's two actions as a
   * browser runs them, with the paying browser's mark set for this sign-in
   * or not. Returns the sign-in's user.
   */
  async function addFirstDevice(label: string, options: { paidHere: boolean }): Promise<string> {
    const clinic = await seedClinic("first-device");
    const owner = await seedPortalUser(clinic.clinicId, "owner");
    Object.assign(mocks.portal, {
      userId: owner.userId,
      clinicId: clinic.clinicId,
      clinicSlug: clinic.slug,
    });
    mocks.cookie = options.paidHere ? payingBrowserValue(owner.userId) : undefined;
    const { beginAddDevice, finishAddDevice } = await import("@/app/c/[slug]/protect/actions");
    const begun = await beginAddDevice(clinic.slug, {});
    if (!begun.ok) throw new Error(begun.message);
    const credentialId = b64(randomBytes(16));
    registers(credentialId);
    const finished = await finishAddDevice(clinic.slug, {
      label,
      response: {
        id: credentialId,
        rawId: credentialId,
        type: "public-key",
        response: {
          clientDataJSON: b64(
            JSON.stringify({
              type: "webauthn.create",
              challenge: begun.options.challenge,
              origin: ORIGIN,
            }),
          ),
          attestationObject: b64(randomBytes(64)),
          transports: ["internal"],
        },
        clientExtensionResults: {},
      },
    });
    expect(finished.ok).toBe(true);
    return owner.userId;
  }

  test("from a session that did not pay, the first passkey emails the clinic's address (O3)", async () => {
    const userId = await addFirstDevice("Reception PC", { paidHere: false });
    expect(mocks.notify).toHaveBeenCalledTimes(1);
    expect(mocks.notify).toHaveBeenCalledWith(
      expect.objectContaining({ userId, kind: "added", first: true, payingBrowser: false }),
    );
  });

  test("in the browser that paid, the addition says so, and the device email skips it", async () => {
    const userId = await addFirstDevice("Laura's MacBook", { paidHere: true });
    expect(mocks.notify).toHaveBeenCalledTimes(1);
    expect(mocks.notify).toHaveBeenCalledWith(
      expect.objectContaining({ userId, kind: "added", first: true, payingBrowser: true }),
    );
  });

  test("another sign-in's mark in the same browser is not this one's", async () => {
    const clinic = await seedClinic("other-mark");
    const other = await seedPortalUser(clinic.clinicId, "owner");
    const userId = await addFirstDevice("Front desk Mac", { paidHere: false });
    // A mark minted for somebody else, left in this browser.
    expect(isPayingBrowser(userId, payingBrowserValue(other.userId))).toBe(false);
    expect(mocks.notify).toHaveBeenCalledWith(
      expect.objectContaining({ userId, first: true, payingBrowser: false }),
    );
  });
});
