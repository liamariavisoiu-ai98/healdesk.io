import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { setupUnsubscribeUrl, unsubscribeUrl, verifyUnsubscribeTarget } from "@/lib/email";
import { findLeadById, recordDemoUnlock } from "@/lib/leads";
import { createSetupRequest, findSetupRequest } from "@/lib/setup-requests";
import { FakeSheets, __setSheetsClientForTests } from "@/lib/sheets/client";
import { __resetSheetSchemaForTests } from "@/lib/sheets/schema";

import { GET, POST } from "./route";

/**
 * The one-click opt-out on the setup-link emails (P4, P5) names a setup
 * request, not a lead: a request can exist with no lead behind it. Both
 * kinds of token share the route, and neither can be edited into the other.
 */

const tokenOf = (url: string) => new URL(url).searchParams.get("t");

beforeEach(() => {
  __setSheetsClientForTests(new FakeSheets());
  __resetSheetSchemaForTests();
});

afterEach(() => {
  __setSheetsClientForTests(null);
  __resetSheetSchemaForTests();
});

describe("unsubscribe tokens", () => {
  test("a setup token names its request, a lead token its lead, and an edit names nothing", () => {
    const id = "6f1f7c1e-2f0e-4d2b-9a0a-3f5e2c1d4b7a";
    const setup = tokenOf(setupUnsubscribeUrl(id));
    expect(verifyUnsubscribeTarget(setup)).toEqual({ kind: "setup", id });
    expect(verifyUnsubscribeTarget(tokenOf(unsubscribeUrl(id)))).toEqual({ kind: "lead", id });

    const other = "7f1f7c1e-2f0e-4d2b-9a0a-3f5e2c1d4b7a";
    expect(verifyUnsubscribeTarget(setup!.replace(id, other))).toBeNull();
    // A setup signature does not pass as a lead's, or the other way round.
    expect(verifyUnsubscribeTarget(setup!.slice(2))).toBeNull();
    expect(verifyUnsubscribeTarget(`s.${tokenOf(unsubscribeUrl(id))}`)).toBeNull();
  });
});

describe("the unsubscribe route, for a setup request", () => {
  async function request() {
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
    return created.request;
  }

  test("a GET, a link scanner's or a person's, changes nothing and shows the one button", async () => {
    const saved = await request();
    const url = setupUnsubscribeUrl(saved.id);
    const page = await GET(new Request(url));
    expect(page.status).toBe(200);
    expect(page.headers.get("cache-control")).toBe("no-store");
    const html = await page.text();
    expect(html).toContain("Stop these emails?");
    // The button posts the same signed link back.
    const action = html.match(/<form method="post" action="([^"]+)">/)?.[1];
    expect(action).toBe(`/api/email/unsubscribe?t=${encodeURIComponent(tokenOf(url)!)}`);
    expect((await findSetupRequest(saved.id))!.unsubscribedAt).toBeNull();
    // However many times the scanner opens it.
    await GET(new Request(url));
    expect((await findSetupRequest(saved.id))!.unsubscribedAt).toBeNull();
  });

  test("the page's button stops that request's emails, and says so", async () => {
    const saved = await request();
    const response = await POST(
      new Request(setupUnsubscribeUrl(saved.id), {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "",
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Done. You will not get another marketing email from us.");
    expect((await findSetupRequest(saved.id))!.unsubscribedAt).toBeInstanceOf(Date);
  });

  test("the mail client's RFC 8058 one-click POST stops them with no page", async () => {
    const saved = await request();
    const response = await POST(
      new Request(setupUnsubscribeUrl(saved.id), {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "List-Unsubscribe=One-Click",
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect((await findSetupRequest(saved.id))!.unsubscribedAt).toBeInstanceOf(Date);
  });

  test("a token that doesn't verify changes nothing", async () => {
    const saved = await request();
    const forged = setupUnsubscribeUrl(saved.id).replace(/.{4}$/, "AAAA");
    const response = await GET(new Request(forged));
    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain("<form");
    const posted = await POST(new Request(forged, { method: "POST", body: "List-Unsubscribe=One-Click" }));
    expect(posted.status).toBe(400);
    expect((await findSetupRequest(saved.id))!.unsubscribedAt).toBeNull();
  });
});

describe("the unsubscribe route, for a lead", () => {
  test("a GET changes nothing; the button, or the mail client, stops the nurture", async () => {
    const unlocked = await recordDemoUnlock({ email: "laura@glowmedspa.com", isBusinessEmail: true, marketingConsent: true });
    if (!unlocked.ok) throw new Error("no lead");
    const url = unsubscribeUrl(unlocked.leadId);
    await GET(new Request(url));
    expect((await findLeadById(unlocked.leadId))!.unsubscribedAt).toBeNull();
    await POST(new Request(url, { method: "POST", body: "" }));
    expect((await findLeadById(unlocked.leadId))!.unsubscribedAt).toBeInstanceOf(Date);
  });
});
