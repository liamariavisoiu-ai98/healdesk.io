import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { __resetDemoCacheForTests, createDemoSession, updateDemoSession } from "@/lib/demo/sessions";
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
