import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { setupUnsubscribeUrl, unsubscribeUrl, verifyUnsubscribeTarget } from "@/lib/email";
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

  test("one click stops that request's emails, by GET or by the mail client's POST", async () => {
    const first = await request();
    const page = await GET(new Request(setupUnsubscribeUrl(first.id)));
    expect(page.status).toBe(200);
    expect((await findSetupRequest(first.id))!.unsubscribedAt).toBeInstanceOf(Date);

    const second = await request();
    const oneClick = await POST(new Request(setupUnsubscribeUrl(second.id), { method: "POST" }));
    expect(oneClick.status).toBe(200);
    expect((await findSetupRequest(second.id))!.unsubscribedAt).toBeInstanceOf(Date);
  });

  test("a token that doesn't verify changes nothing", async () => {
    const saved = await request();
    const forged = setupUnsubscribeUrl(saved.id).replace(/.{4}$/, "AAAA");
    const response = await GET(new Request(forged));
    expect(response.status).toBe(400);
    expect((await findSetupRequest(saved.id))!.unsubscribedAt).toBeNull();
  });
});
