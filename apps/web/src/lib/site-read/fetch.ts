import { lookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { pipeline, Transform, type Readable } from "node:stream";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";

import { CLINIC_PROFILE_LIMITS } from "@healdesk/catalog";

import { site } from "@/lib/site";

import { refusedAddress } from "./address";
import { decodeWindows1252, isWindows1252 } from "./decode";
import { pickPages, readLinks, sameSite } from "./html";
import { parseRobots, robotsAllows, type Robots } from "./robots";

/**
 * The fetch guard: how apps/web reads a website a buyer typed, without
 * becoming a way to read anything else.
 *
 * This is the one place in the codebase where a stranger chooses a URL and
 * our server fetches it, so the read runs here, on the marketing host with no
 * database and no patient data, never on apps/app (CLAUDE.md, "THE PHI
 * BOUNDARY"). And it runs behind these rules:
 *
 * - **Pinned.** We resolve the host ourselves, refuse it if any address it
 *   resolves to is private or special (address.ts), and connect to exactly
 *   the address we checked, through a `lookup` that returns it. Nothing
 *   resolves the name a second time, so a DNS answer that changes between
 *   the check and the connection (rebinding) changes nothing.
 * - **Re-checked on every hop.** Redirects are followed by hand, at most
 *   three, and each one goes through the same checks as the first URL.
 * - **Only the web.** http and https, ports 80 and 443, no credentials in the
 *   URL, never apps/app's own host. Each request gets its own agent with no
 *   proxy settings, so HTTP_PROXY and its kin cannot route a read anywhere.
 * - **Only pages.** `text/html` only, at most 1.5 MB after decompression,
 *   counted as it streams and cut off past the limit.
 * - **Bounded.** A deadline for each request and one for the whole read,
 *   both inside the route's maxDuration.
 * - **Polite.** robots.txt is honoured for our token and for `*`, and at most
 *   eight pages are read: the home page and the likeliest seven of its links.
 */

/** Why a read failed. Logged with the host; never told to the browser. */
export type FetchFailure =
  | "refused"
  | "dns"
  | "robots"
  | "redirects"
  | "status"
  | "not-html"
  | "too-large"
  | "encoding"
  | "timeout"
  | "network";

export class SiteFetchError extends Error {
  constructor(
    readonly reason: FetchFailure,
    /** For the log: a status code, a range's name, an error code. Never page content. */
    readonly detail: string = "",
  ) {
    super(detail ? `${reason}: ${detail}` : reason);
    this.name = "SiteFetchError";
  }
}

export const FETCH_LIMITS = {
  /** One page, after decompression. */
  pageBytes: 1_500_000,
  /** RFC 9309 asks a crawler to read at least this much of robots.txt; the rest is ignored. */
  robotsBytes: 500 * 1024,
  /** Bytes on the wire for one response, whatever its encoding. */
  wireBytes: 4_000_000,
  redirects: 3,
  /** One request, from connecting to the last byte. */
  requestMs: 7_000,
  robotsMs: 4_000,
  /** Pages fetched at once after the home page. */
  concurrency: 4,
} as const;

/** The product token robots.txt can name, and a page to read about us. */
export const USER_AGENT = `Mozilla/5.0 (compatible; HealdeskBot/1.0; +${site.url})`;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export type Pinned = { address: string; family: 4 | 6 };

export type Resolver = (hostname: string) => Promise<readonly { address: string }[]>;

export type TransportRequest = {
  url: URL;
  pinned: Pinned;
  /** A page must be HTML; robots.txt may be anything, and any status is an answer. */
  accept: "html" | "robots";
  signal: AbortSignal;
};

export type TransportResult =
  | { kind: "redirect"; status: number; location: string }
  | { kind: "response"; status: number; body: string };

export type Transport = (request: TransportRequest) => Promise<TransportResult>;

export type ReadOptions = {
  /** Epoch milliseconds by which every request has finished or been abandoned. */
  deadline: number;
  /** Hosts never fetched, whatever they resolve to: apps/app's own. */
  blockedHosts?: readonly string[];
  /** DNS. Tests replace it; everything else uses the system resolver. */
  resolve?: Resolver;
  /** The HTTP exchange. Tests replace it; everything else uses `requestPinned`. */
  transport?: Transport;
};

export type FetchedPage = { url: string; html: string };

const systemResolver: Resolver = (hostname) => lookup(hostname, { all: true });

/**
 * The hosts a read never touches: apps/app's, from HEALDESK_APP_URL. That
 * origin is internal and must never be fetched on a stranger's say-so,
 * whatever name points at it.
 */
export function blockedHostsFromEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  try {
    return env.HEALDESK_APP_URL ? [normalizeHost(new URL(env.HEALDESK_APP_URL).hostname)] : [];
  } catch {
    return [];
  }
}

function normalizeHost(hostname: string): string {
  return hostname
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "")
    .toLowerCase();
}

/**
 * The checks a URL must pass before anything is resolved or sent. Throws a
 * `refused` SiteFetchError naming the rule; returns the host to resolve.
 */
export function checkTarget(url: URL, blockedHosts: readonly string[]): string {
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new SiteFetchError("refused", `scheme ${url.protocol}`);
  }
  if (url.username || url.password) throw new SiteFetchError("refused", "credentials in the URL");
  const port = url.port === "" ? (url.protocol === "https:" ? 443 : 80) : Number(url.port);
  if (port !== 80 && port !== 443) throw new SiteFetchError("refused", `port ${port}`);
  const hostname = normalizeHost(url.hostname);
  if (!hostname) throw new SiteFetchError("refused", "no host");
  if (blockedHosts.includes(hostname)) throw new SiteFetchError("refused", "the app's own host");
  if (isIP(hostname)) {
    const refused = refusedAddress(hostname);
    if (refused) throw new SiteFetchError("refused", refused);
  }
  return hostname;
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new SiteFetchError("timeout"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new SiteFetchError("timeout"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

/**
 * The address to connect to for a host: itself when it is a literal, else
 * the first IPv4 answer (serverless hosts often have no IPv6 route), else the
 * first IPv6. Refused when ANY answer is refused, so a name that resolves to
 * one public and one private address cannot be used to reach the private one.
 */
export async function resolvePinned(
  hostname: string,
  resolve: Resolver,
  signal: AbortSignal,
): Promise<Pinned> {
  const literal = isIP(hostname);
  if (literal) return { address: hostname, family: literal === 6 ? 6 : 4 };
  let answers: readonly { address: string }[];
  try {
    answers = await abortable(resolve(hostname), signal);
  } catch (error) {
    if (error instanceof SiteFetchError) throw error;
    throw new SiteFetchError("dns", errorCode(error));
  }
  if (answers.length === 0) throw new SiteFetchError("dns", "no addresses");
  for (const answer of answers) {
    const refused = refusedAddress(answer.address);
    if (refused) throw new SiteFetchError("refused", `resolves to ${refused}`);
  }
  const chosen = answers.find((a) => isIP(a.address) === 4) ?? answers[0]!;
  return { address: chosen.address, family: isIP(chosen.address) === 6 ? 6 : 4 };
}

function errorCode(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error) {
    return String((error as { code: unknown }).code);
  }
  return error instanceof Error ? error.name : "error";
}

/** Node asks for one address or for all of them (happy eyeballs); either way it gets the pinned one. */
function pinnedLookup(pinned: Pinned): LookupFunction {
  return (_hostname, options, callback) => {
    if (options.all) callback(null, [{ address: pinned.address, family: pinned.family }]);
    else callback(null, pinned.address, pinned.family);
  };
}

function asFetchError(error: unknown, signal: AbortSignal): SiteFetchError {
  if (error instanceof SiteFetchError) return error;
  if (signal.aborted) return new SiteFetchError("timeout");
  const code = errorCode(error);
  if (/^Z_|ZLIB|BROTLI/i.test(code)) return new SiteFetchError("encoding", code);
  return new SiteFetchError("network", code);
}

function byteCounter(limit: number): Transform {
  let seen = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      seen += chunk.length;
      if (seen > limit) callback(new SiteFetchError("too-large", "on the wire"));
      else callback(null, chunk);
    },
  });
}

function decompressor(encoding: string): Transform | null {
  switch (encoding) {
    case "":
    case "identity":
      return null;
    case "gzip":
    case "x-gzip":
      return createGunzip();
    case "deflate":
      return createInflate();
    case "br":
      return createBrotliDecompress();
    default:
      throw new SiteFetchError("encoding", encoding.slice(0, 20));
  }
}

/**
 * The decompressed body, counted as it streams. Past the limit a page is
 * refused; robots.txt is cut there and read as far as it got.
 */
async function readBody(
  response: http.IncomingMessage,
  limit: number,
  truncate: boolean,
): Promise<Buffer> {
  const decode = decompressor(
    String(response.headers["content-encoding"] ?? "")
      .trim()
      .toLowerCase(),
  );
  const counter = byteCounter(FETCH_LIMITS.wireBytes);
  // pipeline destroys every stream when one fails, so an error anywhere
  // reaches the loop below through the last one. Its callback has nothing
  // left to do.
  const ignore = () => {};
  const source: Readable = decode
    ? pipeline(response, counter, decode, ignore)
    : pipeline(response, counter, ignore);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of source as AsyncIterable<Buffer>) {
    if (size + chunk.length > limit) {
      if (!truncate) throw new SiteFetchError("too-large");
      chunks.push(chunk.subarray(0, limit - size));
      size = limit;
      break;
    }
    chunks.push(chunk);
    size += chunk.length;
  }
  return Buffer.concat(chunks, size);
}

/** The charset the response declares, or a `<meta charset>` near the top, or UTF-8. */
function decodeText(body: Buffer, contentType: string): string {
  const declared =
    /charset\s*=\s*["']?([\w.:-]+)/i.exec(contentType)?.[1] ??
    /<meta[^>]{0,200}?charset\s*=\s*["']?([\w.:-]+)/i.exec(
      body.subarray(0, 4096).toString("latin1"),
    )?.[1];
  if (declared && isWindows1252(declared)) return decodeWindows1252(body);
  try {
    return new TextDecoder(declared ?? "utf-8").decode(body);
  } catch {
    return new TextDecoder("utf-8").decode(body);
  }
}

async function receive(
  response: http.IncomingMessage,
  accept: TransportRequest["accept"],
): Promise<TransportResult> {
  const status = response.statusCode ?? 0;
  const location = response.headers.location;
  if (REDIRECT_STATUSES.has(status) && location) {
    response.destroy();
    return { kind: "redirect", status, location };
  }
  const contentType = String(response.headers["content-type"] ?? "");
  if (accept === "robots") {
    if (status < 200 || status >= 300) {
      response.destroy();
      return { kind: "response", status, body: "" };
    }
    const body = await readBody(response, FETCH_LIMITS.robotsBytes, true);
    return { kind: "response", status, body: decodeText(body, contentType) };
  }
  if (status !== 200) {
    response.destroy();
    throw new SiteFetchError("status", String(status));
  }
  if (!/^\s*text\/html\s*(;|$)/i.test(contentType)) {
    response.destroy();
    throw new SiteFetchError(
      "not-html",
      contentType.split(";")[0]?.trim().slice(0, 60) || "no content type",
    );
  }
  const declared = Number(response.headers["content-length"]);
  if (
    !response.headers["content-encoding"] &&
    Number.isFinite(declared) &&
    declared > FETCH_LIMITS.pageBytes
  ) {
    response.destroy();
    throw new SiteFetchError("too-large", "by its own Content-Length");
  }
  const body = await readBody(response, FETCH_LIMITS.pageBytes, false);
  return { kind: "response", status, body: decodeText(body, contentType) };
}

/**
 * One GET to the pinned address, with no redirect followed. The real
 * transport; `ReadOptions.transport` replaces it in tests.
 */
export const requestPinned: Transport = ({ url, pinned, accept, signal }) =>
  new Promise<TransportResult>((resolve, reject) => {
    const secure = url.protocol === "https:";
    const options: https.RequestOptions = {
      hostname: normalizeHost(url.hostname),
      port: url.port ? Number(url.port) : secure ? 443 : 80,
      path: `${url.pathname}${url.search}`,
      method: "GET",
      headers: {
        "User-Agent": USER_AGENT,
        Accept:
          accept === "html" ? "text/html,application/xhtml+xml;q=0.9" : "text/plain,*/*;q=0.5",
        "Accept-Encoding": "gzip, deflate, br",
        "Accept-Language": "en-US,en;q=0.8",
      },
      lookup: pinnedLookup(pinned),
      signal,
    };
    // A fresh agent per request: no pooled socket from another pin, and no
    // `proxyEnv`, so no proxy variable can ever apply to it.
    const agent = secure
      ? new https.Agent({ keepAlive: false })
      : new http.Agent({ keepAlive: false });
    let settled = false;
    const finish = (outcome: () => void) => {
      if (settled) return;
      settled = true;
      agent.destroy();
      outcome();
    };
    const request = secure
      ? https.request({ ...options, agent: agent as https.Agent })
      : http.request({ ...options, agent: agent as http.Agent });
    request.on("error", (error) => finish(() => reject(asFetchError(error, signal))));
    request.on("response", (response) => {
      receive(response, accept).then(
        (result) => finish(() => resolve(result)),
        (error: unknown) => {
          response.destroy();
          request.destroy();
          finish(() => reject(asFetchError(error, signal)));
        },
      );
    });
    request.end();
  });

/** One read: its caches, its deadline and its rules. */
class SiteSession {
  private readonly pins = new Map<string, Promise<Pinned>>();
  private readonly robotsByOrigin = new Map<string, Promise<Robots>>();
  private readonly resolve: Resolver;
  private readonly transport: Transport;
  private readonly blockedHosts: readonly string[];
  readonly signal: AbortSignal;

  constructor(options: ReadOptions) {
    this.resolve = options.resolve ?? systemResolver;
    this.transport = options.transport ?? requestPinned;
    this.blockedHosts = (options.blockedHosts ?? blockedHostsFromEnv()).map(normalizeHost);
    this.signal = AbortSignal.timeout(Math.max(1, options.deadline - Date.now()));
  }

  /** Resolved once per host for the whole read, so robots.txt and the pages use the same address. */
  private pin(hostname: string): Promise<Pinned> {
    let pinned = this.pins.get(hostname);
    if (!pinned) {
      pinned = resolvePinned(hostname, this.resolve, this.signal);
      this.pins.set(hostname, pinned);
    }
    return pinned;
  }

  private robots(url: URL): Promise<Robots> {
    let robots = this.robotsByOrigin.get(url.origin);
    if (!robots) {
      robots = this.loadRobots(url);
      this.robotsByOrigin.set(url.origin, robots);
    }
    return robots;
  }

  /**
   * RFC 9309's reading of each outcome: rules from a 2xx, everything allowed
   * when there is no file (4xx, or redirects past the limit), nothing allowed
   * when the server errs. A site we cannot reach for robots.txt is not read
   * at all: the failure is passed on as what it was.
   */
  private async loadRobots(page: URL): Promise<Robots> {
    try {
      const { status, body } = await this.get(new URL("/robots.txt", page), "robots", {
        checkRobots: false,
      });
      if (status >= 200 && status < 300) return { kind: "rules", rules: parseRobots(body) };
      if (status >= 400 && status < 500) return { kind: "allow-all" };
      return { kind: "disallow-all" };
    } catch (error) {
      if (error instanceof SiteFetchError && error.reason === "redirects") {
        return { kind: "allow-all" };
      }
      throw error;
    }
  }

  async get(
    start: URL,
    accept: TransportRequest["accept"],
    rules: { checkRobots: boolean; sameSiteAs?: string },
  ): Promise<{ url: URL; status: number; body: string }> {
    let url = new URL(start.href);
    url.hash = "";
    for (let hop = 0; ; hop += 1) {
      const hostname = checkTarget(url, this.blockedHosts);
      if (rules.sameSiteAs && !sameSite(hostname, rules.sameSiteAs)) {
        throw new SiteFetchError("refused", "a page outside the site");
      }
      if (
        rules.checkRobots &&
        !robotsAllows(await this.robots(url), `${url.pathname}${url.search}`)
      ) {
        throw new SiteFetchError("robots", url.pathname.slice(0, 80));
      }
      const pinned = await this.pin(hostname);
      const signal = AbortSignal.any([
        this.signal,
        AbortSignal.timeout(accept === "robots" ? FETCH_LIMITS.robotsMs : FETCH_LIMITS.requestMs),
      ]);
      if (signal.aborted) throw new SiteFetchError("timeout");
      const result = await this.transport({ url, pinned, accept, signal });
      if (result.kind === "response") {
        // requestPinned already refuses these; the rule holds whatever transport ran.
        if (accept === "html" && result.status !== 200) {
          throw new SiteFetchError("status", String(result.status));
        }
        return { url, status: result.status, body: result.body };
      }
      if (hop >= FETCH_LIMITS.redirects) {
        throw new SiteFetchError("redirects", `more than ${FETCH_LIMITS.redirects}`);
      }
      let next: URL;
      try {
        next = new URL(result.location, url);
      } catch {
        throw new SiteFetchError("redirects", "an unreadable Location");
      }
      next.hash = "";
      url = next;
    }
  }

  /**
   * The home page. https first; plain http only when https could not connect
   * at all (no TLS, or a certificate the host never fixed), and the www name
   * only when the bare one does not exist in DNS. Anything else, including a
   * refusal or robots.txt, is final.
   */
  async home(website: string): Promise<{ url: URL; body: string }> {
    const secure = new URL(`https://${website}`);
    try {
      return await this.get(secure, "html", { checkRobots: true });
    } catch (error) {
      if (!(error instanceof SiteFetchError)) throw error;
      if (error.reason === "network") {
        const plain = new URL(secure.href);
        plain.protocol = "http:";
        return this.get(plain, "html", { checkRobots: true });
      }
      if (error.reason === "dns" && !secure.hostname.startsWith("www.")) {
        const www = new URL(secure.href);
        www.hostname = `www.${secure.hostname}`;
        return this.get(www, "html", { checkRobots: true });
      }
      throw error;
    }
  }
}

async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  run: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await run(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * Read a clinic's website: the home page, then up to seven of its same-site
 * links chosen by `pickPages`. Throws a SiteFetchError when the home page
 * cannot be read; a later page that fails is left out, since the home page
 * alone usually carries the address, the hours and some of the menu.
 */
export async function fetchSitePages(
  website: string,
  options: ReadOptions,
): Promise<FetchedPage[]> {
  const session = new SiteSession(options);
  const home = await session.home(website);
  const links = pickPages(
    readLinks(home.body, home.url),
    home.url,
    CLINIC_PROFILE_LIMITS.pages - 1,
  );
  const rest = await mapLimit(links, FETCH_LIMITS.concurrency, async (link) => {
    try {
      const page = await session.get(link, "html", {
        checkRobots: true,
        sameSiteAs: home.url.hostname,
      });
      return { url: page.url.href, html: page.body };
    } catch (error) {
      if (error instanceof SiteFetchError) return null;
      throw error;
    }
  });
  const pages: FetchedPage[] = [{ url: home.url.href, html: home.body }];
  for (const page of rest) {
    // Two links can land on one page, through a redirect or a trailing slash.
    if (page && !pages.some((p) => p.url === page.url)) pages.push(page);
  }
  return pages;
}

/** One guarded page, robots.txt and redirects included. For tests and for single reads. */
export async function fetchPage(url: string, options: ReadOptions): Promise<FetchedPage> {
  const page = await new SiteSession(options).get(new URL(url), "html", { checkRobots: true });
  return { url: page.url.href, html: page.body };
}
