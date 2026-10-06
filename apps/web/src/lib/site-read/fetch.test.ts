import http from "node:http";
import type { AddressInfo } from "node:net";
import { brotliCompressSync, gzipSync } from "node:zlib";

import { afterEach, describe, expect, test, vi } from "vitest";

import {
  FETCH_LIMITS,
  SiteFetchError,
  checkTarget,
  fetchPage,
  fetchSitePages,
  requestPinned,
  type Resolver,
  type Transport,
  type TransportRequest,
  type TransportResult,
} from "./fetch";

/**
 * The guard, tested without the internet. The real transport is exercised
 * against servers on 127.0.0.1, reached through a name that cannot resolve,
 * so a passing request proves the connection went to the pinned address. The
 * rules above it (DNS, redirects, robots.txt, the page limit) run against a
 * stub resolver and a stub transport, which record what would have been
 * fetched.
 */

afterEach(() => {
  vi.unstubAllEnvs();
});

async function failure(promise: Promise<unknown>): Promise<SiteFetchError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof SiteFetchError) return error;
    throw error;
  }
  throw new Error("expected the read to fail");
}

// ---------------------------------------------------------------------------
// The transport, against real sockets
// ---------------------------------------------------------------------------

type Local = { port: number; seen: http.IncomingMessage[]; close: () => Promise<void> };

const open: Local[] = [];

afterEach(async () => {
  await Promise.all(open.splice(0).map((server) => server.close()));
});

async function serve(handler: http.RequestListener): Promise<Local> {
  const seen: http.IncomingMessage[] = [];
  const server = http.createServer((request, response) => {
    seen.push(request);
    handler(request, response);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const local: Local = {
    port: (server.address() as AddressInfo).port,
    seen,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
  open.push(local);
  return local;
}

/** A request for a name that does not exist (.invalid never resolves), pinned to the local server. */
function pinnedRequest(
  local: Local,
  accept: TransportRequest["accept"] = "html",
  signal = AbortSignal.timeout(5_000),
) {
  return requestPinned({
    url: new URL(`http://clinic.invalid:${local.port}/services?x=1`),
    pinned: { address: "127.0.0.1", family: 4 },
    accept,
    signal,
  });
}

const html =
  (body: string, headers: http.OutgoingHttpHeaders = {}) =>
  (_: http.IncomingMessage, response: http.ServerResponse) => {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", ...headers });
    response.end(body);
  };

describe("requestPinned", () => {
  test("connects to the pinned address, never resolving the name, and sends the name as Host", async () => {
    const local = await serve(html("<p>Hello</p>"));
    const result = await pinnedRequest(local);
    expect(result).toEqual({ kind: "response", status: 200, body: "<p>Hello</p>" });
    expect(local.seen[0]!.headers.host).toBe(`clinic.invalid:${local.port}`);
    expect(local.seen[0]!.url).toBe("/services?x=1");
    expect(local.seen[0]!.headers["user-agent"]).toMatch(/HealdeskBot\/1\.0/);
  });

  test("ignores proxy settings in the environment", async () => {
    vi.stubEnv("HTTP_PROXY", "http://127.0.0.1:9");
    vi.stubEnv("http_proxy", "http://127.0.0.1:9");
    vi.stubEnv("HTTPS_PROXY", "http://127.0.0.1:9");
    vi.stubEnv("ALL_PROXY", "http://127.0.0.1:9");
    vi.stubEnv("NO_PROXY", "");
    const local = await serve(html("<p>direct</p>"));
    expect(await pinnedRequest(local)).toMatchObject({ kind: "response", body: "<p>direct</p>" });
    expect(local.seen).toHaveLength(1);
  });

  test("hands a redirect back instead of following it", async () => {
    const local = await serve((_, response) => {
      response.writeHead(302, { Location: "http://169.254.169.254/latest/meta-data" });
      response.end();
    });
    expect(await pinnedRequest(local)).toEqual({
      kind: "redirect",
      status: 302,
      location: "http://169.254.169.254/latest/meta-data",
    });
    expect(local.seen).toHaveLength(1);
  });

  test("refuses a page that is not HTML", async () => {
    const local = await serve((_, response) => {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end("{}");
    });
    expect((await failure(pinnedRequest(local))).reason).toBe("not-html");
  });

  test("refuses a page with no content type", async () => {
    const local = await serve((_, response) => {
      response.writeHead(200);
      response.end("<p>hi</p>");
    });
    expect((await failure(pinnedRequest(local))).reason).toBe("not-html");
  });

  test("refuses a status other than 200", async () => {
    const local = await serve((_, response) => {
      response.writeHead(404, { "Content-Type": "text/html" });
      response.end("<p>Not found</p>");
    });
    expect(await failure(pinnedRequest(local))).toMatchObject({ reason: "status", detail: "404" });
  });

  test("refuses a body past 1.5 MB, counted as it streams", async () => {
    const local = await serve((_, response) => {
      response.writeHead(200, { "Content-Type": "text/html" });
      const chunk = "x".repeat(64 * 1024);
      for (let sent = 0; sent <= FETCH_LIMITS.pageBytes; sent += chunk.length) {
        response.write(chunk);
      }
      response.end();
    });
    expect((await failure(pinnedRequest(local))).reason).toBe("too-large");
  });

  test("refuses a body whose own Content-Length is past the limit, before reading it", async () => {
    const local = await serve((_, response) => {
      response.writeHead(200, {
        "Content-Type": "text/html",
        "Content-Length": String(FETCH_LIMITS.pageBytes + 1),
      });
      response.write("<p>");
    });
    expect(await failure(pinnedRequest(local))).toMatchObject({ reason: "too-large" });
  });

  test("counts after decompression, so a small gzip that inflates past the limit is refused", async () => {
    const bomb = gzipSync(Buffer.alloc(8_000_000, 0x20));
    expect(bomb.length).toBeLessThan(100_000);
    const local = await serve((_, response) => {
      response.writeHead(200, { "Content-Type": "text/html", "Content-Encoding": "gzip" });
      response.end(bomb);
    });
    expect((await failure(pinnedRequest(local))).reason).toBe("too-large");
  });

  test("decodes gzip and brotli within the limit", async () => {
    const page = "<p>Hydrafacial $199</p>";
    const gz = await serve((_, response) => {
      response.writeHead(200, { "Content-Type": "text/html", "Content-Encoding": "gzip" });
      response.end(gzipSync(page));
    });
    expect(await pinnedRequest(gz)).toMatchObject({ body: page });
    const br = await serve((_, response) => {
      response.writeHead(200, { "Content-Type": "text/html", "Content-Encoding": "br" });
      response.end(brotliCompressSync(page));
    });
    expect(await pinnedRequest(br)).toMatchObject({ body: page });
  });

  test("refuses an encoding it cannot read", async () => {
    const local = await serve((_, response) => {
      response.writeHead(200, { "Content-Type": "text/html", "Content-Encoding": "compress" });
      response.end("x");
    });
    expect((await failure(pinnedRequest(local))).reason).toBe("encoding");
  });

  test("decodes the charset the page declares", async () => {
    const local = await serve((_, response) => {
      response.writeHead(200, { "Content-Type": "text/html; charset=windows-1252" });
      response.end(Buffer.from([0x43, 0x61, 0x66, 0xe9])); // "Café"
    });
    expect(await pinnedRequest(local)).toMatchObject({ body: "Café" });
  });

  test("gives up at the deadline", async () => {
    const local = await serve(() => {
      // Never answers.
    });
    const started = Date.now();
    expect((await failure(pinnedRequest(local, "html", AbortSignal.timeout(300)))).reason).toBe(
      "timeout",
    );
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  test("robots.txt: any status is an answer, and a long file is cut rather than refused", async () => {
    const missing = await serve((_, response) => {
      response.writeHead(404, { "Content-Type": "text/html" });
      response.end("<p>nope</p>");
    });
    expect(await pinnedRequest(missing, "robots")).toEqual({
      kind: "response",
      status: 404,
      body: "",
    });
    const long = await serve((_, response) => {
      response.writeHead(200, { "Content-Type": "text/plain" });
      response.end(`User-agent: *\nDisallow: /x\n${"#".repeat(FETCH_LIMITS.robotsBytes)}`);
    });
    const result = (await pinnedRequest(long, "robots")) as Extract<
      TransportResult,
      { kind: "response" }
    >;
    expect(result.body.length).toBe(FETCH_LIMITS.robotsBytes);
    expect(result.body.startsWith("User-agent: *")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The rules, against stub DNS and HTTP
// ---------------------------------------------------------------------------

type Route = TransportResult | SiteFetchError | ((request: TransportRequest) => TransportResult);

function stubs(dns: Record<string, string[]>, routes: Record<string, Route>) {
  const calls: { url: string; address: string; accept: string }[] = [];
  const resolve: Resolver = async (hostname) => {
    const addresses = dns[hostname];
    if (!addresses) {
      throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: "ENOTFOUND" });
    }
    return addresses.map((address) => ({ address }));
  };
  const transport: Transport = async (request) => {
    calls.push({ url: request.url.href, address: request.pinned.address, accept: request.accept });
    const route = routes[request.url.href];
    if (route === undefined) {
      return request.accept === "robots"
        ? { kind: "response", status: 404, body: "" }
        : { kind: "response", status: 200, body: "<p>page</p>" };
    }
    if (route instanceof SiteFetchError) throw route;
    return typeof route === "function" ? route(request) : route;
  };
  return {
    calls,
    options: {
      resolve,
      transport,
      deadline: Date.now() + 10_000,
      blockedHosts: ["app.healdesk.io"],
    },
  };
}

const PUBLIC = ["93.184.216.34"];
const page = (body: string): TransportResult => ({ kind: "response", status: 200, body });
const redirect = (location: string): TransportResult => ({
  kind: "redirect",
  status: 301,
  location,
});

describe("checkTarget", () => {
  test.each([
    ["ftp://glow.com/", "scheme ftp:"],
    ["file:///etc/passwd", "scheme file:"],
    ["https://user:pass@glow.com/", "credentials in the URL"],
    ["https://glow.com:8443/", "port 8443"],
    ["http://glow.com:22/", "port 22"],
    ["https://app.healdesk.io/api/ops", "the app's own host"],
    ["https://APP.healdesk.io./x", "the app's own host"],
    ["http://169.254.169.254/latest/meta-data", "link-local, where cloud metadata lives"],
    ["http://[::1]/", "loopback"],
    ["http://[::ffff:127.0.0.1]/", "IPv4-mapped (carries 127.0.0.1, loopback)"],
    ["http://0x7f.1/", "loopback"],
    ["http://2130706433/", "loopback"],
  ])("refuses %s", (url, detail) => {
    expect(() => checkTarget(new URL(url), ["app.healdesk.io"])).toThrow(
      expect.objectContaining({ reason: "refused", detail }),
    );
  });

  test.each([
    "https://glow.com/",
    "http://glow.com:80/",
    "https://glow.com:443/x",
    "http://glow.com:443/",
  ])("allows %s", (url) => {
    expect(checkTarget(new URL(url), ["app.healdesk.io"])).toBe("glow.com");
  });
});

describe("fetchPage", () => {
  test("refuses a host that resolves to a private address, and connects to nothing", async () => {
    const { calls, options } = stubs({ "glow.com": ["10.0.0.5"] }, {});
    expect(await failure(fetchPage("https://glow.com/", options))).toMatchObject({
      reason: "refused",
      detail: "resolves to private",
    });
    expect(calls).toEqual([]);
  });

  test("refuses a host when any one of its addresses is private", async () => {
    const { calls, options } = stubs({ "glow.com": ["93.184.216.34", "127.0.0.1"] }, {});
    expect((await failure(fetchPage("https://glow.com/", options))).reason).toBe("refused");
    expect(calls).toEqual([]);
  });

  test("refuses a host that resolves to an IPv6 address carrying a private IPv4", async () => {
    const { options } = stubs({ "glow.com": ["::ffff:192.168.1.1"] }, {});
    expect((await failure(fetchPage("https://glow.com/", options))).reason).toBe("refused");
  });

  test("connects to the address it checked, IPv4 first", async () => {
    const { calls, options } = stubs({ "glow.com": ["2606:4700::6810:84e5", "93.184.216.34"] }, {});
    await fetchPage("https://glow.com/", options);
    expect(calls.map((c) => c.address)).toEqual(["93.184.216.34", "93.184.216.34"]);
  });

  test("refuses a redirect to a private address, and fetches nothing there", async () => {
    const { calls, options } = stubs(
      { "glow.com": PUBLIC },
      { "https://glow.com/": redirect("http://169.254.169.254/latest/meta-data") },
    );
    expect(await failure(fetchPage("https://glow.com/", options))).toMatchObject({
      reason: "refused",
    });
    expect(calls.map((c) => c.url)).toEqual(["https://glow.com/robots.txt", "https://glow.com/"]);
  });

  test("refuses a redirect to a name that resolves privately", async () => {
    const { calls, options } = stubs(
      { "glow.com": PUBLIC, "internal.glow.com": ["192.168.1.10"] },
      { "https://glow.com/": redirect("https://internal.glow.com/admin") },
    );
    expect(await failure(fetchPage("https://glow.com/", options))).toMatchObject({
      reason: "refused",
      detail: "resolves to private",
    });
    expect(calls.some((c) => c.url.startsWith("https://internal.glow.com/"))).toBe(false);
  });

  test("refuses a redirect to apps/app's own host, or to another port or scheme", async () => {
    for (const location of [
      "https://app.healdesk.io/api/ops",
      "https://glow.com:8443/",
      "file:///etc/passwd",
    ]) {
      const { options } = stubs(
        { "glow.com": PUBLIC, "app.healdesk.io": PUBLIC },
        { "https://glow.com/": redirect(location) },
      );
      expect((await failure(fetchPage("https://glow.com/", options))).reason, location).toBe(
        "refused",
      );
    }
  });

  test("follows three redirects and refuses a fourth", async () => {
    const hops = {
      "https://glow.com/": redirect("/a"),
      "https://glow.com/a": redirect("https://www.glow.com/b"),
      "https://www.glow.com/b": redirect("/c"),
      "https://www.glow.com/c": page("<p>made it</p>"),
    };
    const { options } = stubs({ "glow.com": PUBLIC, "www.glow.com": PUBLIC }, hops);
    expect(await fetchPage("https://glow.com/", options)).toEqual({
      url: "https://www.glow.com/c",
      html: "<p>made it</p>",
    });
    const { options: tooMany } = stubs(
      { "glow.com": PUBLIC, "www.glow.com": PUBLIC },
      { ...hops, "https://www.glow.com/c": redirect("/d") },
    );
    expect((await failure(fetchPage("https://glow.com/", tooMany))).reason).toBe("redirects");
  });

  test("respects robots.txt for us and for everyone", async () => {
    const everyone = stubs(
      { "glow.com": PUBLIC },
      { "https://glow.com/robots.txt": page("User-agent: *\nDisallow: /\n") },
    );
    expect((await failure(fetchPage("https://glow.com/", everyone.options))).reason).toBe("robots");
    expect(everyone.calls.map((c) => c.url)).toEqual(["https://glow.com/robots.txt"]);
    const us = stubs(
      { "glow.com": PUBLIC },
      { "https://glow.com/robots.txt": page("User-agent: HealdeskBot\nDisallow: /\n") },
    );
    expect((await failure(fetchPage("https://glow.com/", us.options))).reason).toBe("robots");
    const others = stubs(
      { "glow.com": PUBLIC },
      { "https://glow.com/robots.txt": page("User-agent: GPTBot\nDisallow: /\n") },
    );
    expect(await fetchPage("https://glow.com/", others.options)).toMatchObject({
      html: "<p>page</p>",
    });
  });

  test("robots.txt applies to every hop: a redirect into a disallowed path is not followed", async () => {
    const { calls, options } = stubs(
      { "glow.com": PUBLIC, "www.glow.com": PUBLIC },
      {
        "https://glow.com/": redirect("https://www.glow.com/members"),
        "https://www.glow.com/robots.txt": page("User-agent: *\nDisallow: /members\n"),
      },
    );
    expect((await failure(fetchPage("https://glow.com/", options))).reason).toBe("robots");
    expect(calls.map((c) => c.url)).not.toContain("https://www.glow.com/members");
  });

  test("a robots.txt that errors means nothing may be read; one that is missing means everything may", async () => {
    const erring = stubs(
      { "glow.com": PUBLIC },
      { "https://glow.com/robots.txt": { kind: "response", status: 503, body: "" } },
    );
    expect((await failure(fetchPage("https://glow.com/", erring.options))).reason).toBe("robots");
    const missing = stubs(
      { "glow.com": PUBLIC },
      { "https://glow.com/robots.txt": { kind: "response", status: 404, body: "" } },
    );
    expect(await fetchPage("https://glow.com/", missing.options)).toMatchObject({
      html: "<p>page</p>",
    });
  });

  test("an unknown name is a DNS failure", async () => {
    const { options } = stubs({}, {});
    expect(await failure(fetchPage("https://nowhere.example/", options))).toMatchObject({
      reason: "dns",
      detail: "ENOTFOUND",
    });
  });

  test("the whole read has a deadline", async () => {
    const { options } = stubs({ "glow.com": PUBLIC }, {});
    const slow: Transport = (request) =>
      new Promise((_, reject) =>
        request.signal.addEventListener("abort", () => reject(new SiteFetchError("timeout"))),
      );
    const started = Date.now();
    const error = await failure(
      fetchPage("https://glow.com/", { ...options, transport: slow, deadline: Date.now() + 200 }),
    );
    expect(error.reason).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(3_000);
  });
});

describe("fetchSitePages", () => {
  const links = (count: number) =>
    Array.from(
      { length: count },
      (_, i) => `<a href="/services/treatment-${i}">Treatment ${i}</a>`,
    ).join("") +
    '<a href="/pricing">Pricing</a><a href="/team">Team</a><a href="/contact">Contact</a><a href="/faq">FAQ</a><a href="/about">About</a>';

  test("reads at most eight pages: the home page and seven of its links", async () => {
    const { calls, options } = stubs(
      { "glow.com": PUBLIC },
      { "https://glow.com/": page(links(20)) },
    );
    const pages = await fetchSitePages("glow.com", options);
    expect(pages).toHaveLength(8);
    expect(calls.filter((c) => c.accept === "html")).toHaveLength(8);
    expect(pages.map((p) => new URL(p.url).pathname)).toEqual([
      "/",
      "/services/treatment-0",
      "/pricing",
      "/team",
      "/contact",
      "/faq",
      "/about",
      "/services/treatment-1",
    ]);
    // robots.txt once for the site, not once per page.
    expect(calls.filter((c) => c.accept === "robots")).toHaveLength(1);
  });

  test("leaves out a page that fails or leaves the site, and keeps the rest", async () => {
    const { options } = stubs(
      { "glow.com": PUBLIC, "evil.example": PUBLIC },
      {
        "https://glow.com/": page(
          '<a href="/pricing">Pricing</a><a href="/team">Team</a><a href="/faq">FAQ</a>',
        ),
        "https://glow.com/pricing": new SiteFetchError("not-html", "application/pdf"),
        "https://glow.com/team": redirect("https://evil.example/team"),
      },
    );
    const pages = await fetchSitePages("glow.com", options);
    expect(pages.map((p) => new URL(p.url).pathname)).toEqual(["/", "/faq"]);
  });

  test("a home page that cannot be read fails the read", async () => {
    const { options } = stubs(
      { "glow.com": PUBLIC },
      { "https://glow.com/": { kind: "response", status: 500, body: "" } },
    );
    expect((await failure(fetchSitePages("glow.com", options))).reason).toBe("status");
  });

  test("falls back to plain http when https cannot connect at all", async () => {
    const { calls, options } = stubs(
      { "glow.com": PUBLIC },
      {
        "https://glow.com/robots.txt": new SiteFetchError("network", "ECONNREFUSED"),
        "http://glow.com/": page("<p>plain</p>"),
      },
    );
    expect((await fetchSitePages("glow.com", options))[0]).toEqual({
      url: "http://glow.com/",
      html: "<p>plain</p>",
    });
    expect(calls.map((c) => c.url)).toEqual([
      "https://glow.com/robots.txt",
      "http://glow.com/robots.txt",
      "http://glow.com/",
    ]);
  });

  test("tries the www name when the bare one does not resolve", async () => {
    const { options } = stubs(
      { "www.glow.com": PUBLIC },
      { "https://www.glow.com/": page("<p>www</p>") },
    );
    expect((await fetchSitePages("glow.com", options))[0]).toEqual({
      url: "https://www.glow.com/",
      html: "<p>www</p>",
    });
  });

  test("a website with a path starts there", async () => {
    const { calls, options } = stubs({ "glow.com": PUBLIC }, {});
    await fetchSitePages("glow.com/austin", options);
    expect(calls.map((c) => c.url)).toContain("https://glow.com/austin");
  });
});
