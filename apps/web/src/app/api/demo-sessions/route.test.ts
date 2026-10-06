import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * POST /api/demo-sessions spends a crawl and a model call per request, so the
 * one thing it must never be is open: unset secret means off, wrong secret
 * means 401, and only then is the body read.
 */

vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: vi.fn(),
}));

const requestDemo = vi.fn();
vi.mock("@/lib/demo/build", () => ({ requestDemo: (...args: unknown[]) => requestDemo(...args), runDemoBuild: vi.fn() }));

const SECRET = "s".repeat(32);

function post(body: unknown, auth?: string) {
  return new Request("https://healdesk.io/api/demo-sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(auth ? { Authorization: auth } : {}) },
    body: JSON.stringify(body),
  });
}

describe("POST /api/demo-sessions", () => {
  beforeEach(() => {
    vi.resetModules();
    requestDemo.mockReset();
  });
  afterEach(() => vi.unstubAllEnvs());

  it("is off when no secret is configured", async () => {
    vi.stubEnv("DEMO_WEBHOOK_SECRET", "");
    const { POST } = await import("./route");
    expect((await POST(post({}, `Bearer ${SECRET}`))).status).toBe(503);
    expect(requestDemo).not.toHaveBeenCalled();
  });

  it("refuses a wrong or missing bearer", async () => {
    vi.stubEnv("DEMO_WEBHOOK_SECRET", SECRET);
    const { POST } = await import("./route");
    expect((await POST(post({}))).status).toBe(401);
    expect((await POST(post({}, `Bearer ${"x".repeat(32)}`))).status).toBe(401);
    expect(requestDemo).not.toHaveBeenCalled();
  });

  it("maps the brief's payload and answers 202 with the private link", async () => {
    vi.stubEnv("DEMO_WEBHOOK_SECRET", SECRET);
    requestDemo.mockResolvedValue({
      ok: true,
      url: "https://healdesk.io/demo/smith-dental-k7q2mz9xwa",
      session: { slug: "smith-dental-k7q2mz9xwa", status: "building", expiresAt: new Date("2026-10-13T00:00:00Z") },
    });
    const { POST } = await import("./route");
    const response = await POST(
      post(
        {
          lead_email: "owner@smith.com",
          clinic_name: "Smith Dental",
          website_url: "smithdental.com",
          phone_number: "+15125550142",
          niche: "dental",
          send_email: true,
        },
        `Bearer ${SECRET}`,
      ),
    );
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ slug: "smith-dental-k7q2mz9xwa", url: "https://healdesk.io/demo/smith-dental-k7q2mz9xwa" });
    expect(requestDemo).toHaveBeenCalledWith(
      expect.objectContaining({
        clinicName: "Smith Dental",
        websiteUrl: "smithdental.com",
        leadEmail: "owner@smith.com",
        phone: "+15125550142",
        niche: "dental",
        sendEmail: true,
        createdBy: "webhook",
      }),
    );
  });
});
