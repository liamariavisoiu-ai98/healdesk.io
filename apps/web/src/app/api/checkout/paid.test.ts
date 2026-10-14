import { WELCOME_NONCE_COOKIE } from "@healdesk/catalog";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { intentRecordsFor } from "@/lib/checkout/records";
import { signTestAgreement, type TestSignature } from "@/lib/checkout/records.testing";
import { createDemoSession, updateDemoSession, __resetDemoCacheForTests } from "@/lib/demo/sessions";
import { LEGAL_VERSION } from "@/lib/legal";
import { issueSetupToken, setupLinkExpiry } from "@/lib/setup-link";
import { createSetupRequest, updateSetupRequest } from "@/lib/setup-requests";
import { FakeSheets, __setSheetsClientForTests } from "@/lib/sheets/client";
import { __resetSheetSchemaForTests } from "@/lib/sheets/schema";
import { SITE_OFFER_COOKIE, siteOfferToken } from "@/lib/site-offer";

/**
 * POST /api/checkout on the paid path, with Stripe faked and the marketing
 * Sheet faked, and nothing on apps/app at all: since 14 October 2026 the
 * purchase is recorded on this site, so a buyer can pay while the AWS host is
 * in standby (docs/design/checkout-records-on-vercel-2026-10-14.md).
 *
 * - The agreement the purchase names is checked against its record before
 *   Stripe sees anything: missing, signed under another address, for other
 *   answers, or edited in the Sheet, and the buyer signs again.
 * - Otherwise the buyer goes to Stripe, with the /welcome nonce cookie, and
 *   Stripe brings them back to this site's /welcome.
 * - A Session its record cannot name is expired and its URL never handed out,
 *   and the press is withdrawn.
 * - A press of Pay on a setup link whose previous Session was paid creates
 *   nothing; one whose previous Session is open expires it first.
 * - The Session carries at most one setup coupon, the strongest offer the
 *   server can establish (the demo's 50% over the website's 30%), and never
 *   one the browser merely names.
 */

const fake = vi.hoisted(() => ({
  previousStatus: "open",
  created: [] as string[],
  params: [] as Record<string, unknown>[],
  expired: [] as string[],
}));

vi.mock("stripe", () => ({
  default: class FakeStripe {
    checkout = {
      sessions: {
        create: async (params: Record<string, unknown>) => {
          const id = `cs_test_new${fake.created.length + 1}`;
          fake.created.push(id);
          fake.params.push(params);
          return { id, url: `https://checkout.stripe.com/c/pay/${id}` };
        },
        retrieve: async (id: string) => ({ id, status: fake.previousStatus }),
        expire: async (id: string) => {
          fake.expired.push(id);
          return { id, status: "expired" };
        },
      },
    };
    prices = { list: async () => ({ data: [{ id: "price_test" }] }) };
  },
}));

const { POST } = await import("./route");

const UNSIGNED = "6f1f7c1e-2f0e-4d2b-9a0a-3f5e2c1d4b7a";

const ORDER = {
  plan: "voice-webchat-500-300",
  interval: "month",
  clinicName: "Radiance Med Spa LLC",
  specialty: "med-spa",
  website: "radiancemedspa.com",
  bookingSystem: "google_calendar",
  calendarAccount: "workspace_baa",
  contactName: "Alex Chen",
  contactEmail: "alex@example.com",
  agreementId: UNSIGNED,
  covered: "no",
  profile: null,
  profileStatus: "failed",
  termsAccepted: true,
  termsVersion: LEGAL_VERSION,
};

const SIGNATURE: TestSignature = {
  clinicName: ORDER.clinicName,
  specialty: ORDER.specialty,
  covered: "no",
  bookingSystem: ORDER.bookingSystem,
  calendarAccount: ORDER.calendarAccount,
  contactName: ORDER.contactName,
  contactEmail: ORDER.contactEmail,
};

let sheets: FakeSheets;
const fetchMock = vi.fn(async () => new Response("apps/app is not here", { status: 503 }));
let counter = 0;

async function pay(options: { cookie?: string; body?: Record<string, unknown> } = {}): Promise<Response> {
  counter += 1;
  const body: Record<string, unknown> = { ...ORDER, ...options.body };
  if (body.agreementId === UNSIGNED) body.agreementId = (await signTestAgreement(SIGNATURE)).id;
  return POST(
    new Request("http://localhost/api/checkout", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-forwarded-for": `10.9.0.${counter}`,
        ...(options.cookie ? { cookie: options.cookie } : {}),
      },
      body: JSON.stringify(body),
    }),
  );
}

beforeEach(() => {
  vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_fake");
  vi.stubEnv("HEALDESK_PROVISION_SECRET", "test-secret");
  vi.stubEnv("HEALDESK_APP_URL", "http://app.test");
  vi.stubEnv("HEALDESK_CHECKOUT_MODE", "public");
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://healdesk.test");
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockClear();
  vi.spyOn(console, "error").mockImplementation(() => {});
  sheets = new FakeSheets();
  __setSheetsClientForTests(sheets);
  __resetSheetSchemaForTests();
  fake.previousStatus = "open";
  fake.created.length = 0;
  fake.params.length = 0;
  fake.expired.length = 0;
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  __setSheetsClientForTests(null);
  __resetSheetSchemaForTests();
});

describe("the paid path, with no apps/app", () => {
  test("a recorded Session sends the buyer to Stripe, with the nonce cookie, and back to this site's /welcome", async () => {
    const response = await pay();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ checkoutUrl: "https://checkout.stripe.com/c/pay/cs_test_new1" });
    const cookie = response.headers.get("set-cookie") ?? "";
    expect(cookie).toContain(`${WELCOME_NONCE_COOKIE}=`);
    expect(cookie).toContain("Path=/welcome");
    expect(fake.expired).toEqual([]);

    // Stripe returns the buyer here, never to apps/app.
    const params = fake.params[0]!;
    const ref = (params.metadata as Record<string, string>).ref!;
    expect(ref).toMatch(/^[0-9a-f-]{36}$/);
    expect(params.success_url).toBe(`https://healdesk.test/welcome?h=${ref}&cs={CHECKOUT_SESSION_ID}`);
    expect(params.client_reference_id).toBe(ref);

    // The press is recorded, sealed, naming the Session it opened.
    const { records, refused } = await intentRecordsFor(ref);
    expect(refused).toEqual([]);
    expect(records).toHaveLength(1);
    expect(records[0]!.record).toMatchObject({ ref, attempt: 1, sessionId: "cs_test_new1" });
    expect(records[0]!.intent).toMatchObject({ contactEmail: "alex@example.com", plan: "voice-webchat-500-300" });

    // And apps/app was never asked anything.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("the nonce cookie is set on the parent domain the two apps share, for /welcome only", async () => {
    vi.stubEnv("HEALDESK_APP_URL", "https://app-internal.healdesk.io");
    counter += 1;
    const agreementId = (await signTestAgreement(SIGNATURE)).id;
    const response = await POST(
      new Request("https://healdesk.io/api/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-forwarded-for": `10.9.1.${counter}` },
        body: JSON.stringify({ ...ORDER, agreementId }),
      }),
    );
    expect(response.status).toBe(200);
    const cookie = response.headers.get("set-cookie") ?? "";
    expect(cookie).toMatch(new RegExp(`^${WELCOME_NONCE_COOKIE}=[A-Za-z0-9_-]{32};`));
    // healdesk.io's /welcome reads it, then app.healdesk.io's: the parent
    // both share, never the internal host itself.
    expect(cookie).toMatch(/; Domain=healdesk\.io(;|$)/);
    expect(cookie).not.toContain("app-internal");
    expect(cookie).toMatch(/; Path=\/welcome(;|$)/);
    expect(cookie).toMatch(/; Max-Age=1800(;|$)/);
    expect(cookie).toMatch(/; HttpOnly(;|$)/);
    expect(cookie.toLowerCase()).toMatch(/; samesite=lax(;|$)/);
    // Only its hash is in the record.
    const nonce = cookie.split(";")[0]!.split("=")[1]!;
    expect(JSON.stringify(sheets.records("checkout_intents"))).not.toContain(nonce);
  });

  test("on one host (localhost, where cookies ignore ports) the nonce cookie is host-only", async () => {
    vi.stubEnv("HEALDESK_APP_URL", "http://localhost:3001");
    const cookie = (await pay()).headers.get("set-cookie") ?? "";
    expect(cookie).toContain(`${WELCOME_NONCE_COOKIE}=`);
    expect(cookie).not.toMatch(/Domain=/i);
  });

  test("the buyer's details never ride in Stripe metadata (design D1)", async () => {
    await pay();
    const params = fake.params[0]!;
    const metadata = JSON.stringify([params.metadata, (params.subscription_data as { metadata: unknown }).metadata]);
    for (const detail of ["Alex", "alex@example.com", "Radiance", "radiancemedspa"]) {
      expect(metadata).not.toContain(detail);
    }
  });

  test("a purchase whose agreement does not hold is refused before Stripe sees it", async () => {
    // Never signed.
    const missing = await pay({ body: { agreementId: "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d" } });
    expect(missing.status).toBe(422);
    expect(await missing.json()).toMatchObject({ field: "agreementId" });

    // Signed for another practice.
    const other = await signTestAgreement({ ...SIGNATURE, clinicName: "Another Spa LLC" });
    const renamed = await pay({ body: { agreementId: other.id } });
    expect(renamed.status).toBe(422);
    expect(await renamed.json()).toMatchObject({ field: "agreementId", error: expect.stringMatching(/different practice/) });

    // Signed under another address.
    const elsewhere = await signTestAgreement({ ...SIGNATURE, contactEmail: "someone@else.com" });
    const wrongEmail = await pay({ body: { agreementId: elsewhere.id } });
    expect(wrongEmail.status).toBe(422);
    expect(await wrongEmail.json()).toMatchObject({ field: "contactEmail" });

    // Edited in the Sheet after signing: its seal no longer matches.
    const edited = await signTestAgreement(SIGNATURE);
    const row = sheets.records("agreements").findIndex((r) => r.id === edited.id) + 2;
    const cell = String(sheets.records("agreements")[row - 2]!.record_1);
    sheets.setCell("agreements", row, "record_1", cell.replace("Alex Chen", "Alex Chan"));
    const tampered = await pay({ body: { agreementId: edited.id } });
    expect(tampered.status).toBe(422);
    expect(await tampered.json()).toMatchObject({ field: "agreementId" });

    expect(fake.created).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("a Session its record cannot name is expired, the press withdrawn, and the press fails", async () => {
    const write = sheets.updateRange.bind(sheets);
    let failed = false;
    vi.spyOn(sheets, "updateRange").mockImplementation(async (range, rows) => {
      // The first rewrite of the purchase's row is the one that names the Session.
      if (!failed && /^checkout_intents!A([2-9]|\d{2,}):/.test(range)) {
        failed = true;
        throw new Error("Google Sheets API 503 UNAVAILABLE");
      }
      return write(range, rows);
    });
    const response = await pay();
    expect(response.status).toBe(502);
    expect(((await response.json()) as { error: string }).error).toMatch(/Nothing has been charged/);
    expect(fake.expired).toEqual(["cs_test_new1"]);
    expect(response.headers.get("set-cookie")).toBeNull();
    const [row] = sheets.records("checkout_intents");
    expect(row!.withdrawn_at).not.toBe("");
  });
});

describe("pressing Pay again on one setup link", () => {
  beforeEach(() => {
    vi.stubEnv("HEALDESK_CHECKOUT_MODE", "");
  });

  async function invite(): Promise<{ id: string; cookie: string }> {
    const created = await createSetupRequest({
      name: "Alex Chen",
      clinicName: "Radiance Med Spa",
      website: "radiancemedspa.com",
      email: ORDER.contactEmail,
      channels: ["web"],
      leadId: null,
      ipAddress: null,
    });
    if (!created.ok) throw new Error("the fake Sheet refused a request");
    const expiresAt = setupLinkExpiry();
    await updateSetupRequest(created.request.id, { status: "invited", invitedAt: new Date(), linkExpiresAt: expiresAt });
    const token = issueSetupToken(created.request.id, ORDER.contactEmail, expiresAt);
    return { id: created.request.id, cookie: `hd_setup=${encodeURIComponent(token)}` };
  }

  test("an open previous Session is expired before the new one is made, under the next attempt", async () => {
    const link = await invite();
    expect((await pay({ cookie: link.cookie })).status).toBe(200);
    expect((await pay({ cookie: link.cookie })).status).toBe(200);
    expect(fake.expired).toEqual(["cs_test_new1"]);
    expect(fake.created).toEqual(["cs_test_new1", "cs_test_new2"]);
    // One purchase, the setup link's own id, two presses.
    expect(fake.params.map((p) => (p.metadata as Record<string, string>).ref)).toEqual([link.id, link.id]);
    const { records } = await intentRecordsFor(link.id);
    expect(records.map((r) => [r.record.attempt, r.record.sessionId])).toEqual([
      [1, "cs_test_new1"],
      [2, "cs_test_new2"],
    ]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("a press of Pay after the previous one was paid creates nothing", async () => {
    const link = await invite();
    expect((await pay({ cookie: link.cookie })).status).toBe(200);
    fake.previousStatus = "complete";
    const again = await pay({ cookie: link.cookie, body: { plan: "voice-metachat-500-300" } });
    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({ error: "This purchase is already paid. Check your email." });
    expect(fake.created).toEqual(["cs_test_new1"]);
    // Nothing moved past the paid press: still one record, attempt 1.
    const { records } = await intentRecordsFor(link.id);
    expect(records.map((r) => r.record.attempt)).toEqual([1]);
  });

  test("a setup link whose purchase is provisioned is refused", async () => {
    const link = await invite();
    expect((await pay({ cookie: link.cookie })).status).toBe(200);
    const row = sheets.records("checkout_intents").length + 1;
    sheets.setCell("checkout_intents", row, "provisioned_at", new Date().toISOString());
    const again = await pay({ cookie: link.cookie });
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ field: "setupLink" });
  });
});

describe("pressing Pay again without a setup link", () => {
  /** One signature, kept: a buyer who cancels at Stripe comes back to the same agreement. */
  async function signed(email = ORDER.contactEmail): Promise<string> {
    return (await signTestAgreement({ ...SIGNATURE, contactEmail: email })).id;
  }

  test("in public mode, the same buyer and agreement are one purchase: the open Session is expired first", async () => {
    const agreementId = await signed();
    expect((await pay({ body: { agreementId } })).status).toBe(200);
    expect((await pay({ body: { agreementId } })).status).toBe(200);
    expect(fake.created).toEqual(["cs_test_new1", "cs_test_new2"]);
    expect(fake.expired).toEqual(["cs_test_new1"]);
    const refs = fake.params.map((p) => (p.metadata as Record<string, string>).ref!);
    expect(refs[0]).toBe(refs[1]);
    expect(refs[0]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    const { records } = await intentRecordsFor(refs[0]!);
    expect(records.map((r) => [r.record.attempt, r.record.sessionId])).toEqual([
      [1, "cs_test_new1"],
      [2, "cs_test_new2"],
    ]);
    // Neither the address nor the agreement can be read off the ref.
    expect(refs[0]).not.toContain(agreementId.slice(0, 8));
  });

  test("a press after the previous Session was paid creates nothing", async () => {
    const agreementId = await signed();
    expect((await pay({ body: { agreementId } })).status).toBe(200);
    fake.previousStatus = "complete";
    const again = await pay({ body: { agreementId } });
    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({ error: "This purchase is already paid. Check your email." });
    expect(fake.created).toEqual(["cs_test_new1"]);
  });

  test("two buyers, or two agreements, are two purchases, and neither expires the other's Session", async () => {
    expect((await pay({ body: { agreementId: await signed() } })).status).toBe(200);
    expect((await pay({ body: { agreementId: await signed() } })).status).toBe(200);
    const other = await signed("info@another.test");
    expect((await pay({ body: { agreementId: other, contactEmail: "info@another.test" } })).status).toBe(200);
    expect(fake.expired).toEqual([]);
    expect(new Set(fake.params.map((p) => (p.metadata as Record<string, string>).ref)).size).toBe(3);
  });

  test("in pilot mode, a buyer invited through a personalised demo is held to the same rule", async () => {
    vi.stubEnv("HEALDESK_CHECKOUT_MODE", "");
    __resetDemoCacheForTests();
    const demo = await createDemoSession({ clinicName: "Radiance", websiteUrl: "https://radiancemedspa.com/" });
    await updateDemoSession(demo.slug, { status: "ready", readyAt: new Date() });
    __resetDemoCacheForTests();
    const cookie = `hd_demo_ref=${demo.slug}`;
    const agreementId = await signed();
    expect((await pay({ cookie, body: { agreementId } })).status).toBe(200);
    expect((await pay({ cookie, body: { agreementId } })).status).toBe(200);
    expect(fake.expired).toEqual(["cs_test_new1"]);
    const refs = fake.params.map((p) => (p.metadata as Record<string, string>).ref);
    expect(refs[0]).toBe(refs[1]);
  });
});

describe("the setup offer on the Session", () => {
  const HOUR = 3_600_000;

  beforeEach(() => {
    __resetDemoCacheForTests();
  });

  /** The website's offer cookie, shown `hoursAgo` hours ago. */
  function siteCookie(hoursAgo: number): string {
    return `${SITE_OFFER_COOKIE}=${encodeURIComponent(siteOfferToken(new Date(Date.now() - hoursAgo * HOUR))!)}`;
  }

  /** A built personalised demo, ready `hoursAgo` hours ago, and its cookie. */
  async function demoCookie(hoursAgo: number): Promise<string> {
    const readyAt = new Date(Date.now() - hoursAgo * HOUR);
    const demo = await createDemoSession({ clinicName: "Radiance", websiteUrl: "https://radiancemedspa.com/" }, readyAt);
    await updateDemoSession(demo.slug, { status: "ready", readyAt });
    __resetDemoCacheForTests();
    return `hd_demo_ref=${demo.slug}`;
  }

  function discounts(): unknown {
    return fake.params[0]?.discounts;
  }

  test("none without an offer, and none for an offer the browser only names", async () => {
    expect((await pay({ body: { offer: "cohort-setup", coupon: "healdesk-cohort-setup-voice-webchat-95600" } })).status).toBe(200);
    expect(discounts()).toBeUndefined();
    expect((fake.params[0]!.metadata as Record<string, string>).offer).toBeUndefined();
  });

  test("the website's 30% while its signed cookie is inside 48 hours", async () => {
    await pay({ cookie: siteCookie(47) });
    expect(discounts()).toEqual([{ coupon: "healdesk-site-setup-30-voice-webchat-28600" }]);
    expect((fake.params[0]!.metadata as Record<string, string>).offer).toBe("site-setup-30");

    fake.params.length = 0;
    await pay({ cookie: siteCookie(49) });
    expect(discounts()).toBeUndefined();

    fake.params.length = 0;
    await pay({ cookie: `${SITE_OFFER_COOKIE}=${Date.now() - HOUR}.forged` });
    expect(discounts()).toBeUndefined();
  });

  test("the demo's 50% within 48 hours of the demo being ready, over the website's 30%", async () => {
    const demo = await demoCookie(2);
    await pay({ cookie: `${demo}; ${siteCookie(1)}` });
    expect(discounts()).toEqual([{ coupon: "healdesk-demo-setup-50-voice-webchat-47800" }]);
    expect(fake.params[0]!.metadata).toMatchObject({ offer: "demo-setup-50", demo: demo.slice("hd_demo_ref=".length) });
  });

  test("a demo past its 48 hours gives no 50%, and the website's 30% still applies", async () => {
    const demo = await demoCookie(50);
    await pay({ cookie: `${demo}; ${siteCookie(1)}` });
    expect(discounts()).toEqual([{ coupon: "healdesk-site-setup-30-voice-webchat-28600" }]);
  });
});
