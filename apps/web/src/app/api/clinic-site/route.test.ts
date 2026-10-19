import {
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  parseClinicProfile,
  sign,
  type ClinicProfile,
} from "@healdesk/catalog";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  __resetDemoCacheForTests,
  createDemoSession,
  SELF_SERVE_DEMO,
  updateDemoSession,
} from "@/lib/demo/sessions";
import { __resetRateLimiterForTests, rateLimit } from "@/lib/rate-limit";
import { issueSetupToken, setupLinkExpiry } from "@/lib/setup-link";
import { cleanWebsite, createSetupRequest, updateSetupRequest } from "@/lib/setup-requests";
import { FakeSheets, __setSheetsClientForTests } from "@/lib/sheets/client";
import { __resetSheetSchemaForTests } from "@/lib/sheets/schema";
import { readClinicSite, type SiteRead } from "@/lib/site-read/read";

import { POST, READ_COOKIE } from "./route";

/**
 * POST /api/clinic-site with the read itself stubbed (lib/site-read has its
 * own tests). What is tested here is who may ask, how often, and what the
 * browser is told: a profile, or `{ status: "failed" }` and nothing else.
 */

vi.mock("@/lib/site-read/read", () => ({ readClinicSite: vi.fn() }));
const read = vi.mocked(readClinicSite);

const PROFILE: ClinicProfile = {
  version: 1,
  website: "glowmedspa.com",
  readAt: "2026-10-06T09:30:00.000Z",
  pages: 4,
  locations: [
    {
      label: "Glow Med Spa",
      address: "12 Main St, Austin, TX 78701",
      phone: "(512) 555-0100",
      hours: { sun: [], mon: [["09:00", "17:00"]], tue: [], wed: [], thu: [], fri: [], sat: [] },
    },
  ],
  services: [
    {
      name: "Hydrafacial",
      priceKind: "exact",
      priceUsd: 199,
      maxUsd: null,
      unit: null,
      durationMinutes: 60,
    },
    {
      name: "Botox",
      priceKind: "per_unit",
      priceUsd: 14,
      maxUsd: null,
      unit: "unit",
      durationMinutes: null,
    },
  ],
  providers: [{ name: "Dr. Maya Patel", title: "Medical Director" }],
  policies: [],
  faqs: [],
  acceptsInsurance: "no",
  practiceKind: "med-spa",
  dropped: 2,
};

const SECRET = "test-secret";
const CLINIC_ID = "8a0c6f4e-1d2b-4c3a-9e8f-7a6b5c4d3e2f";
let ip = 0;

beforeEach(() => {
  vi.stubEnv("ANTHROPIC_API_KEY", "sk-test");
  vi.stubEnv("HEALDESK_PROVISION_SECRET", SECRET);
  vi.stubEnv("HEALDESK_CHECKOUT_MODE", "");
  __setSheetsClientForTests(new FakeSheets());
  __resetSheetSchemaForTests();
  __resetRateLimiterForTests();
  read.mockReset();
  read.mockResolvedValue({ status: "read", profile: PROFILE, model: "claude-opus-5-5" });
  vi.spyOn(console, "info").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  __setSheetsClientForTests(null);
  __resetSheetSchemaForTests();
  vi.restoreAllMocks();
});

function browser(
  body: unknown,
  { cookie, from }: { cookie?: string; from?: string } = {},
): Promise<Response> {
  ip += 1;
  return POST(
    new Request("http://localhost/api/clinic-site", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-forwarded-for": from ?? `10.9.${Math.floor(ip / 250)}.${ip % 250}`,
        ...(cookie ? { cookie } : {}),
      },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
}

function signed(
  body: unknown,
  { secret = SECRET, at = Date.now(), drop }: { secret?: string; at?: number; drop?: string } = {},
) {
  const raw = JSON.stringify(body);
  const timestamp = Math.floor(at / 1000).toString();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    [TIMESTAMP_HEADER]: timestamp,
    [SIGNATURE_HEADER]: sign(raw, timestamp, secret),
  };
  if (drop) delete headers[drop];
  return POST(
    new Request("http://localhost/api/clinic-site", { method: "POST", headers, body: raw }),
  );
}

/** The daily counters written so far; no tab at all means nothing was ever counted. */
function counters(sheets: FakeSheets): Record<string, unknown>[] {
  return sheets.tabs.has("counters") ? sheets.records("counters") : [];
}

async function setupLinkCookie(email = "info@glowmedspa.com"): Promise<string> {
  const created = await createSetupRequest({
    name: "Alex Chen",
    clinicName: "Glow Med Spa",
    website: "glowmedspa.com",
    email,
    channels: ["web"],
    leadId: null,
    ipAddress: null,
  });
  if (!created.ok) throw new Error("the fake Sheet refused a request");
  const expiresAt = setupLinkExpiry();
  await updateSetupRequest(created.request.id, {
    status: "invited",
    invitedAt: new Date(),
    linkExpiresAt: expiresAt,
  });
  return `hd_setup=${encodeURIComponent(issueSetupToken(created.request.id, email, expiresAt))}`;
}

describe("POST /api/clinic-site from a browser", () => {
  test("in pilot mode, no setup link, no read", async () => {
    const response = await browser({ website: "glowmedspa.com" });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ field: "setupLink", link: "none" });
    expect(read).not.toHaveBeenCalled();
  });

  test("in pilot mode, a forged setup link is refused like everywhere else", async () => {
    const response = await browser(
      { website: "glowmedspa.com" },
      { cookie: "hd_setup=8a0c6f4e-1d2b-4c3a-9e8f-7a6b5c4d3e2f.9999999999999.forged" },
    );
    expect(response.status).toBe(403);
    expect(read).not.toHaveBeenCalled();
  });

  test("with a valid setup link, reads and answers with the profile and its summary", async () => {
    const response = await browser(
      { website: "https://GlowMedSpa.com/" },
      { cookie: await setupLinkCookie() },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      status: "read",
      profile: PROFILE,
      summary: { services: 2, hours: true, providers: 1 },
    });
    expect(read).toHaveBeenCalledWith(
      "GlowMedSpa.com",
      expect.objectContaining({ deadline: expect.any(Number) }),
    );
    const cookie = response.headers.get("set-cookie")!;
    expect(cookie).toMatch(new RegExp(`^${READ_COOKIE}=1;`));
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/Path=\/api\/clinic-site/);
    expect(cookie).toMatch(/Max-Age=1800/);
  });

  test("in pilot mode, an operator's personalised demo is an invitation, as at signing and Pay", async () => {
    __resetDemoCacheForTests();
    const demo = await createDemoSession({ clinicName: "Glow", websiteUrl: "https://glowmedspa.com/" });
    await updateDemoSession(demo.slug, { status: "ready", readyAt: new Date() });
    __resetDemoCacheForTests();
    const response = await browser({ website: "glowmedspa.com" }, { cookie: `hd_demo_ref=${demo.slug}` });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "read" });
    expect(read).toHaveBeenCalledTimes(1);
  });

  test("in pilot mode, a homepage demo, an unbuilt one or a bought one is not", async () => {
    __resetDemoCacheForTests();
    const selfServe = await createDemoSession({
      clinicName: "Glow",
      websiteUrl: "https://glowmedspa.com/",
      createdBy: SELF_SERVE_DEMO,
    });
    await updateDemoSession(selfServe.slug, { status: "ready", readyAt: new Date() });
    const building = await createDemoSession({ clinicName: "Glow", websiteUrl: "https://glowmedspa.com/" });
    const bought = await createDemoSession({ clinicName: "Glow", websiteUrl: "https://glowmedspa.com/" });
    await updateDemoSession(bought.slug, { status: "ready", readyAt: new Date(), claimed: true });
    __resetDemoCacheForTests();
    for (const slug of [selfServe.slug, building.slug, bought.slug, "no-such-demo"]) {
      const response = await browser({ website: "glowmedspa.com" }, { cookie: `hd_demo_ref=${slug}` });
      expect(response.status, slug).toBe(403);
    }
    expect(read).not.toHaveBeenCalled();
  });

  test("in public mode, anyone may ask", async () => {
    vi.stubEnv("HEALDESK_CHECKOUT_MODE", "public");
    const response = await browser({ website: "glowmedspa.com" });
    expect(response.status).toBe(200);
    expect(read).toHaveBeenCalledTimes(1);
  });

  test.each<[string, SiteRead]>([
    ["unreachable", { status: "failed", reason: "dns", detail: "ENOTFOUND" }],
    ["refused", { status: "failed", reason: "refused", detail: "resolves to private" }],
    ["blocked by robots.txt", { status: "failed", reason: "robots", detail: "/" }],
    ["not HTML", { status: "failed", reason: "not-html", detail: "application/pdf" }],
    ["a refused extraction", { status: "failed", reason: "refusal", detail: "bio" }],
    ["an invalid extraction", { status: "failed", reason: "invalid", detail: "not JSON" }],
  ])("a read that failed (%s) tells the browser that, and only that", async (_name, outcome) => {
    vi.stubEnv("HEALDESK_CHECKOUT_MODE", "public");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    read.mockResolvedValue(outcome);
    const response = await browser({ website: "glowmedspa.com/austin" });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('{"status":"failed"}');
    // The log has the host and the reason.
    const logged = warn.mock.calls.find(([line]) =>
      String(line).includes("clinic site read failed"),
    );
    expect(logged?.[1]).toMatchObject({
      host: "glowmedspa.com",
      reason: outcome.status === "failed" ? outcome.reason : "",
    });
    // A failed read still counts as this browser's one read.
    expect(response.headers.get("set-cookie")).toMatch(new RegExp(`^${READ_COOKIE}=1;`));
  });

  test("a read that throws is a failure too, never a 500", async () => {
    vi.stubEnv("HEALDESK_CHECKOUT_MODE", "public");
    vi.spyOn(console, "error").mockImplementation(() => {});
    read.mockRejectedValue(new Error("boom"));
    const response = await browser({ website: "glowmedspa.com" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "failed" });
  });

  test("one read per browser", async () => {
    vi.stubEnv("HEALDESK_CHECKOUT_MODE", "public");
    const response = await browser({ website: "glowmedspa.com" }, { cookie: `${READ_COOKIE}=1` });
    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({ status: "failed" });
    expect(read).not.toHaveBeenCalled();
  });

  test("five reads per IP an hour", async () => {
    vi.stubEnv("HEALDESK_CHECKOUT_MODE", "public");
    const statuses: number[] = [];
    for (let i = 0; i < 6; i += 1) {
      const response = await browser({ website: "glowmedspa.com" }, { from: "203.0.113.50" });
      statuses.push(response.status);
    }
    expect(statuses).toEqual([200, 200, 200, 200, 200, 429]);
    expect(read).toHaveBeenCalledTimes(5);
  });

  test("the site-wide daily cap goes through the marketing Sheet, and stops reads when spent", async () => {
    vi.stubEnv("HEALDESK_CHECKOUT_MODE", "public");
    const sheets = new FakeSheets();
    __setSheetsClientForTests(sheets);
    for (let i = 0; i < 300; i += 1) {
      await rateLimit("site-read:global:day", 300, 24 * 60 * 60 * 1000);
    }
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const response = await browser({ website: "glowmedspa.com" });
    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({ status: "failed" });
    expect(read).not.toHaveBeenCalled();
    expect(counters(sheets).map((row) => row.key)).toEqual(["site-read:global:day"]);
  });

  test("a website that is not one is a form error, and costs nothing", async () => {
    vi.stubEnv("HEALDESK_CHECKOUT_MODE", "public");
    for (const body of [{ website: "not a site" }, { website: "" }, {}, "not json", [1, 2]]) {
      const response = await browser(body);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ field: "website" });
    }
    expect(read).not.toHaveBeenCalled();
  });

  test("an oversized body is refused before anything else", async () => {
    const response = await browser({ website: `glowmedspa.com/${"a".repeat(3_000)}` });
    expect(response.status).toBe(400);
    expect(read).not.toHaveBeenCalled();
  });

  test("without an Anthropic key, nothing is read or spent", async () => {
    vi.stubEnv("HEALDESK_CHECKOUT_MODE", "public");
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.spyOn(console, "error").mockImplementation(() => {});
    const sheets = new FakeSheets();
    __setSheetsClientForTests(sheets);
    const response = await browser({ website: "glowmedspa.com" });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ status: "failed" });
    expect(read).not.toHaveBeenCalled();
    expect(counters(sheets)).toEqual([]);
  });
});

describe("POST /api/clinic-site signed by apps/app", () => {
  test("re-reads a clinic's site without a setup link, and sets no cookie", async () => {
    const response = await signed({ clinicId: CLINIC_ID, website: "glowmedspa.com" });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: "read",
      summary: { services: 2, hours: true, providers: 1 },
    });
    expect(read).toHaveBeenCalledWith("glowmedspa.com", expect.any(Object));
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  test("does not spend the browsers' daily cap, and counts its own in the marketing Sheet", async () => {
    const sheets = new FakeSheets();
    __setSheetsClientForTests(sheets);
    await signed({ clinicId: CLINIC_ID, website: "glowmedspa.com" });
    expect(
      counters(sheets)
        .map((row) => row.key)
        .sort(),
    ).toEqual([`site-read:clinic:${CLINIC_ID}`, "site-read:signed:day"]);
  });

  test("its per-clinic limit holds across instances, not four per warm instance", async () => {
    const sheets = new FakeSheets();
    __setSheetsClientForTests(sheets);
    for (let i = 0; i < 4; i += 1) {
      expect((await signed({ clinicId: CLINIC_ID, website: "glowmedspa.com" })).status).toBe(200);
    }
    // A cold start: memory gone, the Sheet still there.
    __resetRateLimiterForTests();
    expect((await signed({ clinicId: CLINIC_ID, website: "glowmedspa.com" })).status).toBe(429);
    expect(read).toHaveBeenCalledTimes(4);
  });

  test.each([
    ["a wrong secret", { secret: "not-the-secret" }],
    ["a stale timestamp", { at: Date.now() - 10 * 60 * 1000 }],
    ["no signature", { drop: SIGNATURE_HEADER }],
    ["no timestamp", { drop: TIMESTAMP_HEADER }],
  ])(
    "refuses %s, and a half-signed request is not treated as a browser's",
    async (_name, options) => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const response = await signed({ clinicId: CLINIC_ID, website: "glowmedspa.com" }, options);
      expect(response.status).toBe(401);
      expect(read).not.toHaveBeenCalled();
    },
  );

  test("needs a clinic id and a website", async () => {
    expect((await signed({ clinicId: "clinic-1", website: "glowmedspa.com" })).status).toBe(422);
    expect((await signed({ clinicId: CLINIC_ID, website: "nope" })).status).toBe(422);
    expect(read).not.toHaveBeenCalled();
  });

  test("has its own limit, per clinic per day", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      statuses.push((await signed({ clinicId: CLINIC_ID, website: "glowmedspa.com" })).status);
    }
    expect(statuses).toEqual([200, 200, 200, 200, 429]);
    // Another clinic is not held up by the first.
    expect(
      (await signed({ clinicId: "0f9e8d7c-6b5a-4f3e-8d2c-1b0a9f8e7d6c", website: "paws.vet" }))
        .status,
    ).toBe(200);
  });

  test("answers a failed re-read the same way", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    read.mockResolvedValue({ status: "failed", reason: "robots", detail: "/" });
    const response = await signed({ clinicId: CLINIC_ID, website: "glowmedspa.com" });
    expect(await response.text()).toBe('{"status":"failed"}');
  });

  test("is unavailable without the shared secret", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubEnv("HEALDESK_PROVISION_SECRET", "");
    expect((await signed({ clinicId: CLINIC_ID, website: "glowmedspa.com" })).status).toBe(503);
    expect(read).not.toHaveBeenCalled();
  });
});

test("every website the form accepts is one the profile accepts", () => {
  for (const typed of [
    "glowmedspa.com",
    "https://www.GlowMedSpa.com/",
    "glow-med-spa.co.uk/austin/",
    "http://glow.spa/path?x=1",
  ]) {
    const website = cleanWebsite(typed);
    expect(website, typed).not.toBeNull();
    expect(parseClinicProfile({ ...PROFILE, website }), typed).not.toBeNull();
  }
});
