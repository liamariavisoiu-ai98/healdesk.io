import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { checkoutMode, setupLinksOpen } from "./checkout-mode";
import { gateState, refuseWithoutLink } from "./setup-gate";
import { issueSetupToken, setupLinkExpiry } from "./setup-link";
import { createSetupRequest, updateSetupRequest } from "./setup-requests";
import { FakeSheets, __setSheetsClientForTests } from "./sheets/client";
import { __resetSheetSchemaForTests } from "./sheets/schema";

const DAY = 24 * 60 * 60 * 1000;

let sheets: FakeSheets;

beforeEach(() => {
  vi.stubEnv("HEALDESK_CHECKOUT_MODE", "");
  sheets = new FakeSheets();
  __setSheetsClientForTests(sheets);
  __resetSheetSchemaForTests();
});

afterEach(() => {
  vi.unstubAllEnvs();
  __setSheetsClientForTests(null);
  __resetSheetSchemaForTests();
});

async function request(email = "info@radiance.com") {
  const created = await createSetupRequest({
    name: "Alex Chen",
    clinicName: "Radiance Med Spa",
    website: null,
    email,
    channels: ["phone", "web"],
    leadId: null,
    ipAddress: "10.0.0.1",
  });
  if (!created.ok) throw new Error("the fake Sheet refused a request");
  return created.request;
}

async function invite(id: string, email: string, sentAt = new Date()) {
  const expiresAt = setupLinkExpiry(sentAt);
  await updateSetupRequest(id, { status: "invited", invitedAt: sentAt, linkExpiresAt: expiresAt });
  return issueSetupToken(id, email, expiresAt);
}

describe("who may buy", () => {
  const env = (vars: Record<string, string | undefined>) => vars as unknown as NodeJS.ProcessEnv;

  test("only exactly 'public' opens the purchase; everything else is by setup link", () => {
    expect(checkoutMode(env({ HEALDESK_CHECKOUT_MODE: "public" }))).toBe("public");
    expect(checkoutMode(env({ HEALDESK_CHECKOUT_MODE: " PUBLIC " }))).toBe("public");
    for (const value of [undefined, "", "pilot", "publik", "true", "open"]) {
      expect(checkoutMode(env({ HEALDESK_CHECKOUT_MODE: value }))).toBe("pilot");
    }
  });

  test("setup links stay shut on every production deployment until the owner opens them", () => {
    expect(setupLinksOpen(env({ NODE_ENV: "production" }))).toBe(false);
    expect(setupLinksOpen(env({ NODE_ENV: "production", VERCEL_ENV: "preview" }))).toBe(false);
    expect(setupLinksOpen(env({ NODE_ENV: "test", VERCEL_ENV: "production" }))).toBe(false);
    expect(setupLinksOpen(env({ NODE_ENV: "production", HEALDESK_SETUP_LINKS: "yes" }))).toBe(false);
    expect(setupLinksOpen(env({ NODE_ENV: "production", HEALDESK_SETUP_LINKS: "open" }))).toBe(true);
    expect(setupLinksOpen(env({ NODE_ENV: "development" }))).toBe(true);
  });
});

describe("gateState", () => {
  test("public mode needs no link at all", async () => {
    vi.stubEnv("HEALDESK_CHECKOUT_MODE", "public");
    expect(await gateState(null)).toEqual({ mode: "public" });
  });

  test("no link, or a token that names no request, is not a purchase", async () => {
    expect(await gateState(null)).toEqual({ mode: "pilot", link: "none" });
    expect(await gateState("garbage")).toEqual({ mode: "pilot", link: "invalid" });
    const stranger = issueSetupToken(crypto.randomUUID(), "a@b.co", setupLinkExpiry());
    expect(await gateState(stranger)).toEqual({ mode: "pilot", link: "invalid" });
  });

  test("the latest link sent to an unpaid request is valid, with the request", async () => {
    const saved = await request();
    const token = await invite(saved.id, saved.email);
    const state = await gateState(token);
    expect(state).toMatchObject({ mode: "pilot", link: "valid", request: { id: saved.id, email: saved.email } });
  });

  test("a request never sent a link has no valid token, even a well-signed one", async () => {
    const saved = await request();
    const token = issueSetupToken(saved.id, saved.email, setupLinkExpiry());
    expect(await gateState(token)).toEqual({ mode: "pilot", link: "invalid" });
  });

  test("expired, replaced, used and declined are told apart", async () => {
    const saved = await request();
    const old = await invite(saved.id, saved.email, new Date(Date.now() - 20 * DAY));
    expect(await gateState(old)).toEqual({ mode: "pilot", link: "expired" });

    const first = await invite(saved.id, saved.email, new Date(Date.now() - DAY));
    const second = await invite(saved.id, saved.email);
    expect(await gateState(first)).toEqual({ mode: "pilot", link: "replaced" });
    expect(await gateState(second)).toMatchObject({ mode: "pilot", link: "valid" });

    await updateSetupRequest(saved.id, { status: "paid", paidAt: new Date() });
    // Paid wins over expired: the most useful thing to tell an old link.
    expect(await gateState(old)).toEqual({ mode: "pilot", link: "used" });
    expect(await gateState(second)).toEqual({ mode: "pilot", link: "used" });

    const other = await request("other@clinic.com");
    const token = await invite(other.id, other.email);
    await updateSetupRequest(other.id, { status: "declined" });
    expect(await gateState(token)).toEqual({ mode: "pilot", link: "invalid" });
  });

  test("a forged token learns nothing, not even that the request was paid", async () => {
    const saved = await request();
    const token = await invite(saved.id, saved.email);
    await updateSetupRequest(saved.id, { status: "paid", paidAt: new Date() });
    expect(await gateState(`${token.slice(0, -4)}AAAA`)).toEqual({ mode: "pilot", link: "invalid" });
  });

  test("a Sheet that can't be read closes the gate", async () => {
    const saved = await request();
    const token = await invite(saved.id, saved.email);
    sheets.tabs.set("setup_requests", [["not", "our", "headers"]]);
    __resetSheetSchemaForTests();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await gateState(token)).toEqual({ mode: "pilot", link: "invalid" });
  });
});

describe("the refusal", () => {
  test("names the field, and answers 409 only for a link already used", async () => {
    const none = refuseWithoutLink({ mode: "pilot", link: "none" });
    expect(none?.status).toBe(403);
    expect(await none?.json()).toMatchObject({ field: "setupLink", link: "none" });
    expect(refuseWithoutLink({ mode: "pilot", link: "used" })?.status).toBe(409);
  });
});
