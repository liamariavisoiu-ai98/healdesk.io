import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * POST /api/own-demo is the one public door to the demo builder, and every
 * request through it is a crawl and a model call. So it must hand the build
 * the visitor's own site and address, as a self-serve demo, and nothing else;
 * and it must stop at each of its limits, its daily cap and its honeypot
 * before anything is recorded.
 */

const afterFns: (() => unknown)[] = [];
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: (fn: () => unknown) => void afterFns.push(fn),
}));

const requestDemo = vi.fn();
vi.mock("@/lib/demo/build", () => ({ requestDemo: (...args: unknown[]) => requestDemo(...args), runDemoBuild: vi.fn() }));

const buildSelfServeDemo = vi.fn();
vi.mock("@/lib/demo/own-demo", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/demo/own-demo")>()),
  buildSelfServeDemo: (...args: unknown[]) => buildSelfServeDemo(...args),
}));

let ip = 0;
function post(body: unknown, from = `198.51.100.${(ip += 1)}`) {
  return new Request("https://healdesk.io/api/own-demo", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-forwarded-for": from },
    body: JSON.stringify(body),
  });
}

const SESSION = { id: "row-1", slug: "peachy-studio-k7q2mz9xwa", status: "building" };

async function route() {
  return (await import("./route")).POST;
}

describe("POST /api/own-demo", () => {
  beforeEach(() => {
    // A fresh module graph: the per-instance counters start at zero.
    vi.resetModules();
    requestDemo.mockReset();
    buildSelfServeDemo.mockReset();
    afterFns.length = 0;
    requestDemo.mockResolvedValue({ ok: true, url: "https://healdesk.io/demo/x", session: SESSION });
  });
  afterEach(() => vi.unstubAllEnvs());

  it("records a self-serve demo from the domain, answers 202 with nothing in it, and builds after the response", async () => {
    const POST = await route();
    const response = await POST(post({ domain: " www.peachy-studio.com/about ", email: "Owner@Peachy.com " }));
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ ok: true });
    expect(requestDemo).toHaveBeenCalledWith({
      clinicName: "Peachy Studio",
      websiteUrl: "https://www.peachy-studio.com/about",
      leadEmail: "owner@peachy.com",
      sendEmail: true,
      createdBy: "homepage",
    });
    expect(buildSelfServeDemo).not.toHaveBeenCalled();
    expect(afterFns).toHaveLength(1);
    await afterFns[0]!();
    expect(buildSelfServeDemo).toHaveBeenCalledWith(SESSION);
  });

  it("does nothing for a bot that filled the hidden field, and says it worked", async () => {
    const POST = await route();
    const response = await POST(post({ domain: "peachy.com", email: "a@b.co", company: "Acme" }));
    expect(response.status).toBe(202);
    expect(requestDemo).not.toHaveBeenCalled();
    expect(afterFns).toHaveLength(0);
  });

  it("refuses a bad email or website, naming the field", async () => {
    const POST = await route();
    const badEmail = await POST(post({ domain: "peachy.com", email: "nope" }));
    expect(badEmail.status).toBe(422);
    expect((await badEmail.json()).field).toBe("email");
    for (const domain of ["", "localhost", "ftp://peachy.com", "user:pw@peachy.com", "printer.local"]) {
      const response = await POST(post({ domain, email: "a@peachy.com" }));
      expect(response.status, domain).toBe(422);
      expect((await response.json()).field).toBe("domain");
    }
    expect(requestDemo).not.toHaveBeenCalled();
  });

  it("stops one address after three requests an hour", async () => {
    const POST = await route();
    for (let i = 0; i < 3; i++) {
      expect((await POST(post({ domain: `clinic${i}.com`, email: `a${i}@b.co` }, "203.0.113.9"))).status).toBe(202);
    }
    const fourth = await POST(post({ domain: "clinic9.com", email: "z@b.co" }, "203.0.113.9"));
    expect(fourth.status).toBe(429);
    expect(fourth.headers.get("Retry-After")).toBeTruthy();
  });

  it("builds one website at most twice a day, whoever asks", async () => {
    const POST = await route();
    expect((await POST(post({ domain: "peachy.com", email: "a@b.co" }))).status).toBe(202);
    expect((await POST(post({ domain: "https://www.peachy.com", email: "c@d.co" }))).status).toBe(202);
    const third = await POST(post({ domain: "PEACHY.com", email: "e@f.co" }));
    expect(third.status).toBe(429);
    expect((await third.json()).error).toContain("peachy.com");
    expect(requestDemo).toHaveBeenCalledTimes(2);
  });

  it("is off at a daily cap of 0, and stops at the cap", async () => {
    vi.stubEnv("OWN_DEMO_DAILY_CAP", "0");
    let POST = await route();
    expect((await POST(post({ domain: "peachy.com", email: "a@b.co" }))).status).toBe(503);
    expect(requestDemo).not.toHaveBeenCalled();

    vi.resetModules();
    vi.stubEnv("OWN_DEMO_DAILY_CAP", "1");
    POST = await route();
    expect((await POST(post({ domain: "one.com", email: "a@b.co" }))).status).toBe(202);
    const over = await POST(post({ domain: "two.com", email: "c@d.co" }));
    expect(over.status).toBe(503);
    expect((await over.json()).error).toContain("hello@healdesk.io");
  });

  it("answers 503 when the register cannot be written, and builds nothing", async () => {
    requestDemo.mockRejectedValue(new Error("Sheets down"));
    const POST = await route();
    expect((await POST(post({ domain: "peachy.com", email: "a@b.co" }))).status).toBe(503);
    expect(afterFns).toHaveLength(0);
  });
});
