import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/**
 * Read a clinic's public website: its pages as text, and its brand.
 *
 * ## Two crawlers, because one of them lies by omission
 *
 * Most clinic sites are Wix, Squarespace or a React theme, and on many of them
 * the service menu is rendered in the browser. A plain HTTP fetch of such a
 * page returns a shell, and an extraction run on a shell does not fail, it
 * produces a confident profile with no services in it
 * (packages/leadgen/src/enrich/crawl.ts learned this the expensive way).
 *
 * So when `APIFY_TOKEN` is set, the pages come from Apify's
 * website-content-crawler, which runs a real browser. A plain fetch runs
 * alongside it regardless, for three things the rendered text loses: the
 * `<head>` (logo, theme colour, site name), the JSON-LD block a lot of
 * clinic themes ship with hours and address in it, and a fallback when Apify
 * is down, slow or out of credit. Without the token the plain fetch is all
 * there is, and the demo is only as good as the site's server-side HTML.
 *
 * ## It fetches a URL somebody typed, so it is careful about where
 *
 * The URL arrives from an authenticated operator or a signed webhook, never
 * from a visitor, but it is still fetched from inside our infrastructure.
 * `assertPublicUrl()` refuses anything that resolves to a private, loopback or
 * link-local address, redirects are followed by hand and re-checked at every
 * hop, and every response is size-capped and time-limited.
 *
 * Nothing here is patient data: a clinic's public pages and its logo.
 */

export type ScrapedPage = { url: string; title: string; text: string };

export type ClinicBrand = {
  /** The name the site calls itself, from og:site_name, JSON-LD or <title>. */
  name: string | null;
  /** Absolute https URL of a logo or icon, or null when none was found. */
  logoUrl: string | null;
  /** `#rrggbb`, from theme-color or the stylesheet's dominant saturated colour. */
  color: string | null;
};

export type ScrapeResult = {
  pages: ScrapedPage[];
  brand: ClinicBrand;
  source: "apify" | "fetch" | "apify+fetch";
  /** Why the rendered crawl was skipped or failed, for the operator; null when it ran. */
  apifyNote: string | null;
};

export class ScrapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScrapeError";
  }
}

const USER_AGENT =
  "Mozilla/5.0 (compatible; healdesk-demo-builder/1.0; +https://healdesk.io/contact)";
const PAGE_TIMEOUT_MS = 10_000;
const MAX_PAGE_BYTES = 1_500_000;
const MAX_CSS_BYTES = 300_000;
const MAX_REDIRECTS = 5;
/** Homepage plus this many prioritised internal pages on the plain-fetch path. */
const FETCH_PAGE_BUDGET = 10;
const APIFY_PAGE_BUDGET = 15;
/** Apify's run-sync endpoint gives up at 300 s; leave the structuring call room. */
const APIFY_TIMEOUT_SECS = 180;
/** Characters of page text per page and in total handed to the structuring call. */
const MAX_PAGE_TEXT = 20_000;
const MAX_TOTAL_TEXT = 150_000;

// -----------------------------------------------------------------------------
// URL safety
// -----------------------------------------------------------------------------

/** Normalise what an operator pasted ("smithdental.com", "http://…/") into a URL. */
export function parseWebsiteUrl(input: string): URL {
  const trimmed = input.trim();
  if (!trimmed) throw new ScrapeError("Enter the clinic's website.");
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new ScrapeError("That doesn't look like a website address.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new ScrapeError("Only http and https websites can be read.");
  }
  if (url.username || url.password) throw new ScrapeError("Website addresses with credentials are refused.");
  if (url.port && url.port !== "80" && url.port !== "443") {
    throw new ScrapeError("Only websites on the standard ports can be read.");
  }
  if (!url.hostname.includes(".") || url.hostname.endsWith(".local") || url.hostname.endsWith(".internal")) {
    throw new ScrapeError("That isn't a public website address.");
  }
  url.hash = "";
  return url;
}

function isPrivateAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b] = address.split(".").map(Number) as [number, number];
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  const v6 = address.toLowerCase();
  if (v6.startsWith("::ffff:")) return isPrivateAddress(v6.slice(7));
  return (
    v6 === "::" ||
    v6 === "::1" ||
    v6.startsWith("fc") ||
    v6.startsWith("fd") ||
    v6.startsWith("fe8") ||
    v6.startsWith("fe9") ||
    v6.startsWith("fea") ||
    v6.startsWith("feb") ||
    v6.startsWith("ff")
  );
}

/** Refuse a URL whose host is, or resolves to, anything but the public internet. */
export async function assertPublicUrl(url: URL): Promise<void> {
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost") throw new ScrapeError("That isn't a public website address.");
  const addresses = isIP(host) ? [host] : (await lookup(host, { all: true })).map((a) => a.address);
  if (addresses.length === 0 || addresses.some(isPrivateAddress)) {
    throw new ScrapeError("That website resolves to a private address and was not fetched.");
  }
}

/**
 * GET with redirects followed by hand, each hop re-checked, the body capped.
 * Returns null for anything that is not a 2xx of the expected kind; the
 * crawler treats a missing page as missing, not as a reason to stop.
 */
async function safeFetch(start: URL, accept: "html" | "css"): Promise<{ url: URL; body: string } | null> {
  let url = start;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertPublicUrl(url);
    let response: Response;
    try {
      response = await fetch(url, {
        redirect: "manual",
        headers: {
          "User-Agent": USER_AGENT,
          Accept: accept === "html" ? "text/html,application/xhtml+xml" : "text/css,*/*;q=0.1",
        },
        signal: AbortSignal.timeout(PAGE_TIMEOUT_MS),
      });
    } catch {
      return null;
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) return null;
      try {
        url = new URL(location, url);
      } catch {
        return null;
      }
      if (url.protocol !== "https:" && url.protocol !== "http:") return null;
      continue;
    }
    if (!response.ok || !response.body) return null;
    const type = response.headers.get("content-type") ?? "";
    if (accept === "html" && !/html|xml/i.test(type)) return null;
    const limit = accept === "html" ? MAX_PAGE_BYTES : MAX_CSS_BYTES;
    const body = await readCapped(response.body, limit);
    return { url, body };
  }
  return null;
}

async function readCapped(stream: ReadableStream<Uint8Array>, limit: number): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let out = "";
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      out += decoder.decode(value, { stream: true });
      if (bytes >= limit) break;
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  return out + decoder.decode();
}

// -----------------------------------------------------------------------------
// HTML, without a parser dependency
// -----------------------------------------------------------------------------

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
  hellip: "…",
  middot: "·",
  copy: "©",
  reg: "®",
  trade: "™",
};

export function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, code: string) => {
    if (code[0] === "#") {
      const n = code[1]?.toLowerCase() === "x" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : match;
    }
    return ENTITIES[code.toLowerCase()] ?? match;
  });
}

function attr(tag: string, name: string): string | null {
  const match = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag);
  const value = match?.[1] ?? match?.[2] ?? match?.[3];
  return value === undefined ? null : decodeEntities(value).trim();
}

function metaContent(html: string, key: string): string | null {
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const name = (attr(tag, "property") ?? attr(tag, "name") ?? "").toLowerCase();
    if (name === key) return attr(tag, "content");
  }
  return null;
}

/** Visible text, block structure kept as line breaks. */
export function htmlToText(html: string): string {
  const body = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|template|iframe|head)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|section|article|li|h[1-6]|tr|header|footer|nav|ul|ol|table|dd|dt|main|aside)>/gi, "\n")
    .replace(/<(li)\b[^>]*>/gi, "\n- ")
    .replace(/<[^>]+>/g, " ");
  return decodeEntities(body)
    .split("\n")
    .map((line) => line.replace(/[ \t\f\v ]+/g, " ").trim())
    .filter(Boolean)
    .join("\n")
    .replace(/\n{3,}/g, "\n\n");
}

function titleOf(html: string): string {
  const match = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return match ? decodeEntities(match[1]!.replace(/\s+/g, " ")).trim() : "";
}

/** JSON-LD blocks, as compact JSON text. Many clinic themes carry hours and address here. */
function jsonLd(html: string): string[] {
  const out: string[] = [];
  const re = /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    try {
      out.push(JSON.stringify(JSON.parse(m[1]!.trim())));
    } catch {
      // A theme's malformed JSON-LD is common and not worth failing over.
    }
  }
  return out;
}

type Link = { url: URL; text: string };

function linksOf(html: string, base: URL): Link[] {
  const out: Link[] = [];
  const re = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    const href = attr(`<a ${m[1]}>`, "href");
    if (!href || href.startsWith("#") || /^(mailto|tel|javascript|sms):/i.test(href)) continue;
    try {
      const url = new URL(href, base);
      url.hash = "";
      out.push({ url, text: decodeEntities(m[2]!.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim() });
    } catch {
      // Unparseable href: skip.
    }
  }
  return out;
}

// -----------------------------------------------------------------------------
// Which pages a receptionist would want
// -----------------------------------------------------------------------------

const PAGE_HINTS: readonly [RegExp, number][] = [
  [/pric|cost|fee|rates|menu|price-list/, 10],
  [/service|treatment|procedure|offer|what-we-do/, 9],
  [/faq|question/, 8],
  [/hour|contact|location|visit|find-us|directions/, 7],
  [/polic|cancel|deposit|new-patient|first-visit|financ|insurance|payment/, 7],
  [/team|staff|provider|doctor|physician|about|meet|our-/, 6],
  [/special|promo|membership|offer|package/, 5],
  [/book|appointment|schedule|consult/, 4],
];

const SKIP = /\.(pdf|jpe?g|png|gif|webp|svg|mp4|mov|zip|docx?|xlsx?)$|\/(wp-admin|wp-login|cart|checkout|account|login|feed|tag|author)\b|\/blog\/.+/i;

function sameSite(a: URL, b: URL): boolean {
  const strip = (h: string) => h.replace(/^www\./, "");
  return strip(a.hostname) === strip(b.hostname);
}

export function prioritiseLinks(links: Link[], home: URL, budget: number): URL[] {
  const scored = new Map<string, { url: URL; score: number }>();
  for (const link of links) {
    if (!sameSite(link.url, home) || SKIP.test(link.url.pathname)) continue;
    link.url.search = "";
    const key = link.url.href.replace(/\/$/, "");
    if (key === home.href.replace(/\/$/, "")) continue;
    const haystack = `${link.url.pathname} ${link.text}`.toLowerCase();
    let score = 0;
    for (const [re, weight] of PAGE_HINTS) if (re.test(haystack)) score = Math.max(score, weight);
    // Shallow paths are the menu; deep ones are usually one blog post or one product.
    const depth = link.url.pathname.split("/").filter(Boolean).length;
    if (score === 0 && depth > 1) continue;
    score += Math.max(0, 3 - depth);
    const prior = scored.get(key);
    if (!prior || prior.score < score) scored.set(key, { url: link.url, score });
  }
  return [...scored.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, budget)
    .map((s) => s.url);
}

// -----------------------------------------------------------------------------
// Brand
// -----------------------------------------------------------------------------

function httpsUrl(value: string | null, base: URL): string | null {
  if (!value || value.startsWith("data:")) return null;
  try {
    const url = new URL(value, base);
    // The demo page only loads https images: http would be mixed content.
    if (url.protocol === "http:") url.protocol = "https:";
    return url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

function logoFromJsonLd(blocks: string[]): string | null {
  for (const block of blocks) {
    const match = /"logo"\s*:\s*(?:"([^"]+)"|\{[^}]*"url"\s*:\s*"([^"]+)")/.exec(block);
    if (match) return match[1] ?? match[2] ?? null;
  }
  return null;
}

function nameFromJsonLd(blocks: string[]): string | null {
  for (const block of blocks) {
    if (!/"@type"\s*:\s*"(?:[A-Za-z]*Business|MedicalClinic|Dentist|Physician|MedicalOrganization|Organization|HealthAndBeautyBusiness|DaySpa|VeterinaryCare)"/.test(block)) continue;
    const match = /"name"\s*:\s*"([^"]{2,120})"/.exec(block);
    if (match) return match[1]!;
  }
  return null;
}

function logoFromImages(html: string, base: URL): string | null {
  for (const tag of html.match(/<img\b[^>]*>/gi) ?? []) {
    const marker = `${attr(tag, "class") ?? ""} ${attr(tag, "id") ?? ""} ${attr(tag, "alt") ?? ""} ${attr(tag, "src") ?? ""}`;
    if (!/logo/i.test(marker)) continue;
    const src = attr(tag, "src") ?? attr(tag, "data-src");
    const url = httpsUrl(src, base);
    if (url) return url;
  }
  return null;
}

function iconFromLinks(html: string, base: URL): string | null {
  let best: { url: string; size: number } | null = null;
  for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
    const rel = (attr(tag, "rel") ?? "").toLowerCase();
    if (!/icon/.test(rel)) continue;
    const url = httpsUrl(attr(tag, "href"), base);
    if (!url) continue;
    const declared = Number((attr(tag, "sizes") ?? "").split("x")[0]) || 0;
    const size = declared || (rel.includes("apple-touch") ? 180 : 32);
    if (!best || size > best.size) best = { url, size };
  }
  return best && best.size >= 96 ? best.url : null;
}

function cleanSiteName(raw: string | null): string | null {
  if (!raw) return null;
  // "Smith Dental | Family Dentist in Austin" -> "Smith Dental"
  const first = raw.split(/\s[|–—·:-]\s/)[0]!.trim();
  return first.length >= 2 && first.length <= 80 ? first : null;
}

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.length === 4 ? hex.replace(/^#(.)(.)(.)$/, "#$1$1$2$2$3$3") : hex;
  return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
}

function normaliseHex(raw: string | null): string | null {
  if (!raw) return null;
  const match = /#([0-9a-f]{6}|[0-9a-f]{3})\b/i.exec(raw);
  if (!match) return null;
  const [r, g, b] = hexToRgb(`#${match[1]}`);
  return `#${[r, g, b].map((n) => n.toString(16).padStart(2, "0")).join("")}`;
}

/** Saturated, and neither near-white nor near-black: a colour somebody chose. */
function isBrandish(hex: string): boolean {
  const [r, g, b] = hexToRgb(hex).map((n) => n / 255) as [number, number, number];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const lightness = (max + min) / 2;
  const saturation = max === min ? 0 : (max - min) / (1 - Math.abs(2 * lightness - 1));
  return saturation >= 0.3 && lightness >= 0.2 && lightness <= 0.72;
}

export function dominantColour(css: string): string | null {
  const counts = new Map<string, number>();
  for (const match of css.matchAll(/#([0-9a-f]{6}|[0-9a-f]{3})\b/gi)) {
    const hex = normaliseHex(match[0]);
    if (!hex || !isBrandish(hex)) continue;
    counts.set(hex, (counts.get(hex) ?? 0) + 1);
  }
  let best: [string, number] | null = null;
  for (const entry of counts) if (!best || entry[1] > best[1]) best = entry;
  return best && best[1] >= 2 ? best[0] : null;
}

async function brandColour(html: string, base: URL): Promise<string | null> {
  const declared = normaliseHex(metaContent(html, "theme-color") ?? metaContent(html, "msapplication-tilecolor"));
  if (declared && isBrandish(declared)) return declared;

  let css = (html.match(/<style\b[^>]*>[\s\S]*?<\/style>/gi) ?? []).join("\n");
  css += (html.match(/\sstyle\s*=\s*"[^"]*"/gi) ?? []).join("\n");
  const sheets = (html.match(/<link\b[^>]*>/gi) ?? [])
    .filter((tag) => /stylesheet/i.test(attr(tag, "rel") ?? ""))
    .map((tag) => httpsUrl(attr(tag, "href"), base))
    .filter((href): href is string => Boolean(href))
    .filter((href) => sameSite(new URL(href), base))
    .slice(0, 2);
  for (const href of sheets) {
    const sheet = await safeFetch(new URL(href), "css").catch(() => null);
    if (sheet) css += `\n${sheet.body}`;
  }
  return dominantColour(css);
}

// -----------------------------------------------------------------------------
// The two crawlers
// -----------------------------------------------------------------------------

type PlainCrawl = { pages: ScrapedPage[]; brand: ClinicBrand; home: URL };

async function plainCrawl(start: URL): Promise<PlainCrawl> {
  const home = await safeFetch(start, "html");
  if (!home) throw new ScrapeError(`The homepage at ${start.host} could not be fetched.`);

  const blocks = jsonLd(home.body);
  const homeText = htmlToText(home.body);
  const pages: ScrapedPage[] = [
    {
      url: home.url.href,
      title: titleOf(home.body),
      text: [blocks.length ? `Structured data: ${blocks.join(" ").slice(0, 6_000)}` : "", homeText]
        .filter(Boolean)
        .join("\n\n"),
    },
  ];

  const targets = prioritiseLinks(linksOf(home.body, home.url), home.url, FETCH_PAGE_BUDGET);
  const fetched = await Promise.all(targets.map((url) => safeFetch(url, "html").catch(() => null)));
  for (const page of fetched) {
    if (!page) continue;
    const ld = jsonLd(page.body);
    pages.push({
      url: page.url.href,
      title: titleOf(page.body),
      text: [ld.length ? `Structured data: ${ld.join(" ").slice(0, 3_000)}` : "", htmlToText(page.body)]
        .filter(Boolean)
        .join("\n\n"),
    });
  }

  const brand: ClinicBrand = {
    name: cleanSiteName(metaContent(home.body, "og:site_name") ?? nameFromJsonLd(blocks) ?? titleOf(home.body)),
    logoUrl:
      httpsUrl(logoFromJsonLd(blocks), home.url) ??
      logoFromImages(home.body, home.url) ??
      iconFromLinks(home.body, home.url),
    color: await brandColour(home.body, home.url).catch(() => null),
  };
  return { pages, brand, home: home.url };
}

type ApifyItem = { url?: string; text?: string; markdown?: string; metadata?: { title?: string } };

async function apifyCrawl(start: URL, token: string): Promise<ScrapedPage[]> {
  const endpoint =
    "https://api.apify.com/v2/acts/apify~website-content-crawler/run-sync-get-dataset-items" +
    `?timeout=${APIFY_TIMEOUT_SECS}&clean=true&format=json`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      startUrls: [{ url: start.href }],
      // Adaptive renders only the pages that need a browser, which is most of
      // a Wix site and almost none of a WordPress one.
      crawlerType: "playwright:adaptive",
      maxCrawlDepth: 2,
      maxCrawlPages: APIFY_PAGE_BUDGET,
      maxResults: APIFY_PAGE_BUDGET,
      saveMarkdown: true,
      removeCookieWarnings: true,
      excludeUrlGlobs: [{ glob: "**/blog/**" }, { glob: "**/*.pdf" }, { glob: "**/cart**" }],
    }),
    signal: AbortSignal.timeout((APIFY_TIMEOUT_SECS + 20) * 1000),
  });
  if (!response.ok) throw new Error(`Apify HTTP ${response.status}`);
  const items = (await response.json()) as ApifyItem[];
  return (Array.isArray(items) ? items : [])
    .map((item) => ({
      url: item.url ?? start.href,
      title: item.metadata?.title ?? "",
      text: (item.markdown ?? item.text ?? "").trim(),
    }))
    .filter((page) => page.text.length > 0);
}

function key(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname.replace(/^www\./, "")}${u.pathname.replace(/\/$/, "")}`;
  } catch {
    return url;
  }
}

/**
 * Drop the lines every page repeats (the navigation menu, the footer) from
 * every page but the first. On a real clinic site the menu alone is a few
 * thousand characters per page, and ten copies of it would spend a third of
 * the text budget on words the homepage already carries once.
 */
export function stripBoilerplate(pages: ScrapedPage[]): ScrapedPage[] {
  if (pages.length < 3) return pages;
  const seenOn = new Map<string, number>();
  for (const page of pages) {
    for (const line of new Set(page.text.split("\n"))) seenOn.set(line, (seenOn.get(line) ?? 0) + 1);
  }
  const threshold = Math.max(2, Math.ceil(pages.length / 2));
  return pages.map((page, i) =>
    i === 0
      ? page
      : { ...page, text: page.text.split("\n").filter((line) => (seenOn.get(line) ?? 0) < threshold || line.startsWith("Structured data:")).join("\n") },
  );
}

/** Union by URL, keeping the longer text for a page both crawlers read, then cap. */
function merge(primary: ScrapedPage[], secondary: ScrapedPage[]): ScrapedPage[] {
  const byKey = new Map<string, ScrapedPage>();
  for (const page of [...primary, ...secondary]) {
    const k = key(page.url);
    const prior = byKey.get(k);
    if (!prior) byKey.set(k, page);
    else if (page.text.length > prior.text.length) {
      // Keep the JSON-LD line the plain fetch found even when the rendered text wins.
      const ld = prior.text.startsWith("Structured data:") ? prior.text.split("\n\n")[0] : "";
      byKey.set(k, { ...page, text: ld ? `${ld}\n\n${page.text}` : page.text });
    }
  }
  let total = 0;
  const out: ScrapedPage[] = [];
  for (const page of stripBoilerplate([...byKey.values()])) {
    const text = page.text.slice(0, MAX_PAGE_TEXT);
    if (total + text.length > MAX_TOTAL_TEXT) break;
    total += text.length;
    out.push({ ...page, text });
  }
  return out;
}

export async function scrapeClinicSite(input: string): Promise<ScrapeResult> {
  const start = parseWebsiteUrl(input);
  await assertPublicUrl(start);

  const token = process.env.APIFY_TOKEN;
  const [plain, rendered] = await Promise.allSettled([
    plainCrawl(start),
    token ? apifyCrawl(start, token) : Promise.reject(new Error("APIFY_TOKEN not set")),
  ]);

  const renderedPages = rendered.status === "fulfilled" ? rendered.value : [];
  const plainPages = plain.status === "fulfilled" ? plain.value.pages : [];
  const pages = merge(renderedPages, plainPages);

  if (pages.length === 0 || pages.every((p) => p.text.length < 200)) {
    const why = plain.status === "rejected" ? (plain.reason as Error).message : "the pages had no readable text";
    throw new ScrapeError(`Nothing usable came back from ${start.host}: ${why}.`);
  }

  const apifyNote =
    rendered.status === "rejected"
      ? (rendered.reason as Error).message
      : renderedPages.length === 0
        ? "Apify returned no pages"
        : null;

  return {
    pages,
    brand:
      plain.status === "fulfilled"
        ? plain.value.brand
        : { name: null, logoUrl: null, color: null },
    source: renderedPages.length && plainPages.length ? "apify+fetch" : renderedPages.length ? "apify" : "fetch",
    apifyNote,
  };
}
