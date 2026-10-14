import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { __resetDemoCacheForTests, createDemoSession, updateDemoSession } from "@/lib/demo/sessions";
import { replyByDate } from "@/lib/reply-by";
import { issueSetupToken, SETUP_COOKIE, setupLinkExpiry } from "@/lib/setup-link";
import { createSetupRequest, updateSetupRequest } from "@/lib/setup-requests";
import { FakeSheets, __setSheetsClientForTests } from "@/lib/sheets/client";
import { __resetSheetSchemaForTests } from "@/lib/sheets/schema";
import { SITE_OFFER_COOKIE, siteOfferToken } from "@/lib/site-offer";

import { GET } from "./route";

/**
 * What /api/checkout/mode says about the setup offer: the one /api/checkout
 * would put on the Session if the buyer paid now, from the same server-side
 * facts (lib/billing.ts `chooseSetupOffer`), so "Due today" and the Session
 * agree. It reads the website's offer cookie and never starts its clock.
 */

const HOUR = 3_600_000;

function ask(cookie?: string): Promise<Response> {
  return GET(new Request("http://localhost/api/checkout/mode", { headers: cookie ? { cookie } : {} }));
}

function siteCookie(hoursAgo: number): string {
  return `${SITE_OFFER_COOKIE}=${encodeURIComponent(siteOfferToken(new Date(Date.now() - hoursAgo * HOUR))!)}`;
}

beforeEach(() => {
  vi.stubEnv("HEALDESK_CHECKOUT_MODE", "public");
  __setSheetsClientForTests(new FakeSheets());
  __resetSheetSchemaForTests();
  __resetDemoCacheForTests();
});

afterEach(() => {
  vi.unstubAllEnvs();
  __setSheetsClientForTests(null);
});

describe("the setup offer in the mode answer", () => {
  test("none without an offer, and the answer never sets the offer cookie", async () => {
    const response = await ask();
    expect(await response.json()).toMatchObject({ mode: "public", offer: null });
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  test("the website's 30% while its cookie holds, with its end", async () => {
    const shownAt = Date.now() - HOUR;
    const body = (await (await ask(siteCookie(1))).json()) as { offer: { kind: string; percentOfSetupFee: number; endsAt: string } };
    expect(body.offer.kind).toBe("site-setup-30");
    expect(body.offer.percentOfSetupFee).toBe(30);
    expect(Math.abs(new Date(body.offer.endsAt).getTime() - (shownAt + 48 * HOUR))).toBeLessThan(5_000);
    expect(await (await ask(siteCookie(49))).json()).toMatchObject({ offer: null });
  });

  test("the demo's 50% over the website's 30%, while the demo's 48 hours hold", async () => {
    const readyAt = new Date(Date.now() - 2 * HOUR);
    const demo = await createDemoSession({ clinicName: "Radiance", websiteUrl: "https://radiancemedspa.com/" }, readyAt);
    await updateDemoSession(demo.slug, { status: "ready", readyAt });
    __resetDemoCacheForTests();
    const body = (await (await ask(`hd_demo_ref=${demo.slug}; ${siteCookie(1)}`)).json()) as {
      offer: { kind: string; percentOfSetupFee: number; endsAt: string };
    };
    expect(body.offer).toEqual({
      kind: "demo-setup-50",
      percentOfSetupFee: 50,
      endsAt: new Date(readyAt.getTime() + 48 * HOUR).toISOString(),
    });
  });
});

/**
 * The answer the static pages' purchase modal opens on, in pilot mode: the
 * form unless the setup cookie holds a valid link, and then the purchase,
 * pre-filled from that request alone. Never cached, by any answer: a cached
 * pilot answer would keep a buyer with a fresh link on the form, and a cached
 * valid one would show one requester's details to the next browser.
 */
describe("the mode answer in pilot mode", () => {
  beforeEach(() => {
    vi.stubEnv("HEALDESK_CHECKOUT_MODE", "");
  });

  async function invite(): Promise<{ cookie: string; requestId: string }> {
    const created = await createSetupRequest({
      name: "Alex Chen",
      clinicName: "Radiance Med Spa",
      website: "radiancemedspa.com",
      email: "info@radiancemedspa.com",
      channels: ["phone", "web"],
      leadId: null,
      ipAddress: null,
    });
    if (!created.ok) throw new Error("the fake Sheet refused a request");
    const expiresAt = setupLinkExpiry();
    await updateSetupRequest(created.request.id, { status: "invited", invitedAt: new Date(), linkExpiresAt: expiresAt });
    const token = issueSetupToken(created.request.id, "info@radiancemedspa.com", expiresAt);
    return { cookie: `${SETUP_COOKIE}=${encodeURIComponent(token)}`, requestId: created.request.id };
  }

  test("without a setup link: the form, with the day we reply by, and nothing about anyone", async () => {
    const response = await ask();
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toEqual({ mode: "pilot", link: "none", replyBy: replyByDate() });
  });

  test("a forged link is invalid, and is answered like no link", async () => {
    const response = await ask(`${SETUP_COOKIE}=8a0c6f4e-1d2b-4c3a-9e8f-7a6b5c4d3e2f.9999999999999.forged`);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ mode: "pilot", link: "invalid", replyBy: replyByDate() });
  });

  test("a used link says so", async () => {
    const link = await invite();
    await updateSetupRequest(link.requestId, { status: "paid", paidAt: new Date() });
    expect(await (await ask(link.cookie)).json()).toMatchObject({ mode: "pilot", link: "used" });
  });

  test("a valid link: the purchase, pre-filled from its own request and nothing else", async () => {
    const link = await invite();
    const response = await ask(link.cookie);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      mode: "pilot",
      link: "valid",
      setup: {
        name: "Alex Chen",
        clinicName: "Radiance Med Spa",
        email: "info@radiancemedspa.com",
        website: "radiancemedspa.com",
        channels: ["phone", "web"],
      },
      creditUntil: null,
      salesTax: false,
      offer: null,
    });
    expect(JSON.stringify(body)).not.toContain(link.requestId);
  });

  test("the public answer is never cached either", async () => {
    vi.stubEnv("HEALDESK_CHECKOUT_MODE", "public");
    expect((await ask()).headers.get("cache-control")).toBe("no-store");
  });
});
