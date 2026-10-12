import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * POST /api/own-demo/preview answers while a visitor watches a progress line.
 * It must show whatever it can find, never block the form on a site it cannot
 * read, tell a typo at once, keep nothing, and stop at its limits.
 */

const fetchBrandPreview = vi.fn();
vi.mock("@/lib/demo/scrape", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/demo/scrape")>()),
  fetchBrandPreview: (...args: unknown[]) => fetchBrandPreview(...args),
}));

let ip = 0;
function post(body: unknown, from = `198.51.100.${(ip += 1)}`) {
  return new Request("https://healdesk.io/api/own-demo/preview", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-forwarded-for": from },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const PREVIEW = { host: "peachystudio.com", name: "Peachy Studio", logoUrl: "data:image/png;base64,AAAA", image: "data:image/jpeg;base64,BBBB", color: "#0a7cff" };

async function route() {
  return (await import("./route")).POST;
}

describe("POST /api/own-demo/preview", () => {
  beforeEach(() => {
    // A fresh module graph: the per-instance counters start at zero.
    vi.resetModules();
    fetchBrandPreview.mockReset();
    fetchBrandPreview.mockResolvedValue(PREVIEW);
  });

  it("answers with the preview, uncached, for the site as the visitor typed it", async () => {
    const POST = await route();
    const response = await POST(post({ domain: " www.peachystudio.com/about " }));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual(PREVIEW);
    expect(fetchBrandPreview).toHaveBeenCalledWith("https://www.peachystudio.com/about");
  });

  it("passes nulls through: a site that gives up nothing still gets a preview", async () => {
    fetchBrandPreview.mockResolvedValue({ host: "peachystudio.com", name: null, logoUrl: null, image: null, color: null });
    const POST = await route();
    const response = await POST(post({ domain: "peachystudio.com" }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ host: "peachystudio.com", name: null, logoUrl: null, image: null, color: null });
  });

  it("refuses what is not a public website, naming the field, without fetching it", async () => {
    const POST = await route();
    // An address that parses but points inside our network is refused by the fetch itself (next test).
    for (const domain of ["", "not a site", "localhost", "https://user:pw@peachystudio.com", "ftp://peachystudio.com", "peachystudio.com:8080"]) {
      const response = await POST(post({ domain }));
      expect(response.status, domain).toBe(422);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect((await response.json()).field).toBe("domain");
    }
    expect(fetchBrandPreview).not.toHaveBeenCalled();
  });

  it("refuses an address that resolves inside our network", async () => {
    const { ScrapeError } = await import("@/lib/demo/scrape");
    fetchBrandPreview.mockRejectedValue(new ScrapeError("That website resolves to a private address and was not fetched."));
    const POST = await route();
    const response = await POST(post({ domain: "internal.example.com" }));
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ field: "domain", error: expect.stringMatching(/private address/) });
  });

  it("tells a visitor at once when the name does not resolve", async () => {
    fetchBrandPreview.mockRejectedValue(Object.assign(new Error("getaddrinfo ENOTFOUND peachystudoi.com"), { code: "ENOTFOUND" }));
    const POST = await route();
    const response = await POST(post({ domain: "peachystudoi.com" }));
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ field: "domain", error: expect.stringMatching(/Check the spelling/) });
  });

  it("falls back to an empty preview, not an error, when something of ours goes wrong", async () => {
    fetchBrandPreview.mockRejectedValue(new Error("resolver hiccup"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const POST = await route();
    const response = await POST(post({ domain: "peachystudio.com" }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ host: "peachystudio.com", name: null, logoUrl: null, image: null, color: null });
    warn.mockRestore();
  });

  it("rejects a body that is not JSON", async () => {
    const POST = await route();
    const response = await POST(post("{nope"));
    expect(response.status).toBe(400);
    expect(fetchBrandPreview).not.toHaveBeenCalled();
  });

  it("stops one address after ten an hour, with when to come back", async () => {
    const POST = await route();
    for (let i = 0; i < 10; i += 1) {
      expect((await POST(post({ domain: `clinic${i}.com` }, "203.0.113.9"))).status).toBe(200);
    }
    const over = await POST(post({ domain: "clinic11.com" }, "203.0.113.9"));
    expect(over.status).toBe(429);
    expect(Number(over.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(over.headers.get("cache-control")).toBe("no-store");
    // Someone else is not held to it.
    expect((await POST(post({ domain: "clinic11.com" }, "203.0.113.10"))).status).toBe(200);
  });

  it("stops one website after six an hour, whoever asks", async () => {
    const POST = await route();
    for (let i = 0; i < 6; i += 1) {
      expect((await POST(post({ domain: "www.peachystudio.com" }))).status).toBe(200);
    }
    const over = await POST(post({ domain: "peachystudio.com" }));
    expect(over.status).toBe(429);
    expect((await POST(post({ domain: "other-clinic.com" }))).status).toBe(200);
  });
});
