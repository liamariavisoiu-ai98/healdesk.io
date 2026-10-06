import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { issueSetupToken, setupLinkExpiry } from "@/lib/setup-link";
import { createSetupRequest, findSetupRequest, updateSetupRequest } from "@/lib/setup-requests";
import { FakeSheets, __setSheetsClientForTests } from "@/lib/sheets/client";
import { __resetSheetSchemaForTests } from "@/lib/sheets/schema";

import { GET } from "./route";

/**
 * /start?t=: the setup link in P4 and P5. It trades the token for an
 * httpOnly cookie and sends the browser to a clean /get-started, so the
 * token is never in that page's address, history or analytics.
 */

beforeEach(() => {
  vi.stubEnv("HEALDESK_CHECKOUT_MODE", "");
  __setSheetsClientForTests(new FakeSheets());
  __resetSheetSchemaForTests();
});

afterEach(() => {
  vi.unstubAllEnvs();
  __setSheetsClientForTests(null);
  __resetSheetSchemaForTests();
});

async function invited() {
  const created = await createSetupRequest({
    name: "Alex Chen",
    clinicName: "Radiance",
    website: null,
    email: "info@radiance.com",
    channels: ["web"],
    leadId: null,
    ipAddress: null,
  });
  if (!created.ok) throw new Error("the fake Sheet refused a request");
  const expiresAt = setupLinkExpiry();
  await updateSetupRequest(created.request.id, { status: "invited", invitedAt: new Date(), linkExpiresAt: expiresAt });
  return { id: created.request.id, token: issueSetupToken(created.request.id, "info@radiance.com", expiresAt) };
}

const open = (token: string) => GET(new Request(`https://healdesk.io/start?t=${encodeURIComponent(token)}`));

describe("GET /start", () => {
  test("a valid link becomes a cookie, lands on a clean /get-started and records the first open", async () => {
    const { id, token } = await invited();
    const response = await open(token);
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("https://healdesk.io/get-started");
    const cookie = response.headers.get("set-cookie") ?? "";
    expect(cookie).toContain(`hd_setup=${encodeURIComponent(token)}`);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=lax/i);
    expect((await findSetupRequest(id))!.openedAt).toBeInstanceOf(Date);
  });

  test("a link that can't buy lands on the form with a word saying why, and sets nothing", async () => {
    const { token } = await invited();
    const response = await open(`${token.slice(0, -4)}AAAA`);
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("https://healdesk.io/get-started?link=invalid");
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  test("in public mode the link is not needed, so it is not kept", async () => {
    vi.stubEnv("HEALDESK_CHECKOUT_MODE", "public");
    const { token } = await invited();
    const response = await open(token);
    expect(response.headers.get("location")).toBe("https://healdesk.io/get-started");
    expect(response.headers.get("set-cookie")).toBeNull();
  });
});
