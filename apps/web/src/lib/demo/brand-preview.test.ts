import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * What the homepage's live preview reads off a visitor's site: the brand a
 * page's own markup gives (`brandOf`, which a demo build reads with too), and
 * the preview's fetch, which has to stay inside the crawler's address checks
 * and return only images it can vouch for, whole and inline.
 */

vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async (host: string) => [{ address: host === "internal.example" ? "10.0.0.5" : "93.184.216.34", family: 4 }]),
}));

const { brandOf, fetchBrandPreview } = await import("./scrape");

const BASE = new URL("https://peachystudio.com/");

describe("brandOf", () => {
  it("names the site from og:site_name, trimmed of its tagline", async () => {
    const brand = await brandOf(
      '<head><meta property="og:site_name" content="Peachy Studio | Aesthetics in Austin"><title>Home</title></head>',
      BASE,
    );
    expect(brand.name).toBe("Peachy Studio");
  });

  it("falls back to the JSON-LD name, then the title", async () => {
    const ld = '<script type="application/ld+json">{"@type":"MedicalClinic","name":"Smith Dental"}</script><title>Welcome</title>';
    expect((await brandOf(ld, BASE)).name).toBe("Smith Dental");
    expect((await brandOf("<title>Greenway Skin - Home</title>", BASE)).name).toBe("Greenway Skin");
  });

  it("takes the logo from JSON-LD, resolved against the page and upgraded to https", async () => {
    const html = '<script type="application/ld+json">{"@type":"Organization","logo":"/img/logo.png"}</script>';
    expect((await brandOf(html, BASE)).logoUrl).toBe("https://peachystudio.com/img/logo.png");
    const http = '<script type="application/ld+json">{"@type":"Organization","logo":{"url":"http://cdn.example.com/l.png"}}</script>';
    expect((await brandOf(http, BASE)).logoUrl).toBe("https://cdn.example.com/l.png");
  });

  it("does not take someone else's badge for the clinic's logo", async () => {
    const brand = await brandOf('<img src="/google-logo.png" width="16" alt="Google logo"><img src="/badges/trustpilot-logo.svg" alt="Trustpilot logo">', BASE);
    expect(brand.logoUrl).toBeNull();
  });

  it("reads the share picture, absolute or relative, over https", async () => {
    expect((await brandOf('<meta property="og:image" content="https://cdn.example.com/hero.jpg">', BASE)).image).toBe("https://cdn.example.com/hero.jpg");
    expect((await brandOf('<meta property="og:image" content="/hero.jpg">', BASE)).image).toBe("https://peachystudio.com/hero.jpg");
    expect((await brandOf('<meta name="twitter:image" content="http://peachystudio.com/t.jpg">', BASE)).image).toBe("https://peachystudio.com/t.jpg");
  });

  it("prefers og:image:secure_url, and ignores a vector or a data URI as a hero", async () => {
    const both = '<meta property="og:image" content="/a.jpg"><meta property="og:image:secure_url" content="https://peachystudio.com/b.jpg">';
    expect((await brandOf(both, BASE)).image).toBe("https://peachystudio.com/b.jpg");
    expect((await brandOf('<meta property="og:image" content="/mark.svg">', BASE)).image).toBeNull();
    expect((await brandOf('<meta property="og:image" content="data:image/png;base64,AAAA">', BASE)).image).toBeNull();
    expect((await brandOf("<title>x</title>", BASE)).image).toBeNull();
  });

  it("takes a declared theme colour that somebody chose, and none that is white or grey", async () => {
    expect((await brandOf('<meta name="theme-color" content="#0a7cff">', BASE)).color).toBe("#0a7cff");
    expect((await brandOf('<meta name="theme-color" content="#ffffff">', BASE)).color).toBeNull();
  });
});

describe("fetchBrandPreview", () => {
  const HTML = `<html><head>
    <meta property="og:site_name" content="Peachy Studio">
    <meta property="og:image" content="/hero.jpg">
    <meta name="theme-color" content="#0a7cff">
    <script type="application/ld+json">{"@type":"MedicalClinic","logo":"/logo.png"}</script>
  </head><body>hello</body></html>`;

  const bytes = (n: number) => new Uint8Array(n).fill(7);
  const page = (body = HTML) => new Response(body, { headers: { "content-type": "text/html; charset=utf-8" } });
  const image = (type: string, n = 400) => new Response(bytes(n), { headers: { "content-type": type } });

  let routes: Record<string, () => Response>;
  const seen: string[] = [];

  beforeEach(() => {
    seen.length = 0;
    routes = {};
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: URL | string) => {
        const url = String(input);
        seen.push(url);
        const route = routes[url];
        return route ? route() : new Response("not found", { status: 404 });
      }),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it("returns the name and colour, and the logo and picture inline as data URIs", async () => {
    routes["https://peachystudio.com/"] = () => page();
    routes["https://peachystudio.com/hero.jpg"] = () => image("image/jpeg", 2_000);
    routes["https://peachystudio.com/logo.png"] = () => image("image/png", 300);
    const preview = await fetchBrandPreview("peachystudio.com");
    expect(preview.host).toBe("peachystudio.com");
    expect(preview.name).toBe("Peachy Studio");
    expect(preview.color).toBe("#0a7cff");
    expect(preview.logoUrl).toMatch(/^data:image\/png;base64,/);
    expect(preview.image).toMatch(/^data:image\/jpeg;base64,/);
    expect(Buffer.from(preview.image!.split(",")[1]!, "base64")).toHaveLength(2_000);
  });

  it("names the host without www, whichever way it was typed", async () => {
    routes["https://www.peachystudio.com/"] = () => page();
    expect((await fetchBrandPreview("www.peachystudio.com")).host).toBe("peachystudio.com");
  });

  it("answers with nulls, not an error, when the page cannot be read", async () => {
    routes["https://peachystudio.com/"] = () => new Response("down", { status: 503 });
    expect(await fetchBrandPreview("peachystudio.com")).toEqual({ host: "peachystudio.com", name: null, logoUrl: null, image: null, color: null });
  });

  it("keeps the name and colour when an image cannot be had", async () => {
    routes["https://peachystudio.com/"] = () => page();
    const preview = await fetchBrandPreview("peachystudio.com");
    expect(preview.name).toBe("Peachy Studio");
    expect(preview.color).toBe("#0a7cff");
    expect(preview.logoUrl).toBeNull();
    expect(preview.image).toBeNull();
  });

  it("refuses an image that is too big, or that is not an image the server can name", async () => {
    routes["https://peachystudio.com/"] = () => page();
    routes["https://peachystudio.com/hero.jpg"] = () => image("image/jpeg", 360_000);
    routes["https://peachystudio.com/logo.png"] = () => image("text/html", 300);
    const preview = await fetchBrandPreview("peachystudio.com");
    expect(preview.image).toBeNull();
    expect(preview.logoUrl).toBeNull();
  });

  it("refuses an image whose declared length is over the limit without reading it", async () => {
    routes["https://peachystudio.com/"] = () => page();
    routes["https://peachystudio.com/hero.jpg"] = () =>
      new Response(bytes(100), { headers: { "content-type": "image/jpeg", "content-length": "900000" } });
    expect((await fetchBrandPreview("peachystudio.com")).image).toBeNull();
  });

  it("takes script and handlers out of a vector logo, and labels it image/svg+xml", async () => {
    routes["https://peachystudio.com/"] = () => page();
    routes["https://peachystudio.com/logo.png"] = () =>
      new Response('<svg viewBox="0 0 10 10" onload="x()"><script>evil()</script><path d="M0 0h10v10z"/></svg>', {
        headers: { "content-type": "image/svg+xml" },
      });
    const logo = (await fetchBrandPreview("peachystudio.com")).logoUrl!;
    expect(logo).toMatch(/^data:image\/svg\+xml;base64,/);
    const svg = Buffer.from(logo.split(",")[1]!, "base64").toString();
    expect(svg).toContain("<path");
    expect(svg).not.toMatch(/script|onload/);
  });

  it("follows a redirect to an image on a CDN, and refuses one that leads inside our network", async () => {
    routes["https://peachystudio.com/"] = () => page();
    routes["https://peachystudio.com/hero.jpg"] = () => new Response(null, { status: 302, headers: { location: "https://cdn.example.com/hero.jpg" } });
    routes["https://cdn.example.com/hero.jpg"] = () => image("image/webp", 500);
    routes["https://peachystudio.com/logo.png"] = () => new Response(null, { status: 302, headers: { location: "http://internal.example/logo.png" } });
    routes["http://internal.example/logo.png"] = () => image("image/png", 300);
    const preview = await fetchBrandPreview("peachystudio.com");
    expect(preview.image).toMatch(/^data:image\/webp;base64,/);
    expect(preview.logoUrl).toBeNull();
    expect(seen).not.toContain("http://internal.example/logo.png");
  });

  it("throws for an address that is not a public website, before any request", async () => {
    await expect(fetchBrandPreview("http://10.0.0.1/")).rejects.toThrow();
    await expect(fetchBrandPreview("internal.example")).rejects.toThrow(/private address/);
    await expect(fetchBrandPreview("localhost")).rejects.toThrow();
    expect(seen).toHaveLength(0);
  });

  it("returns what it has when time runs out", async () => {
    routes["https://peachystudio.com/"] = () => page();
    routes["https://peachystudio.com/hero.jpg"] = () => image("image/jpeg", 500);
    // The logo hangs for longer than the budget allows.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: URL | string, init?: RequestInit) => {
        const url = String(input);
        if (url === "https://peachystudio.com/") return page();
        if (url.endsWith("/hero.jpg")) return image("image/jpeg", 500);
        return new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
      }),
    );
    const started = Date.now();
    const preview = await fetchBrandPreview("peachystudio.com", 600);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(preview.name).toBe("Peachy Studio");
    expect(preview.image).toMatch(/^data:image\/jpeg/);
    expect(preview.logoUrl).toBeNull();
  });
});
