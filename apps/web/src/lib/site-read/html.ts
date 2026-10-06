/**
 * A clinic's pages as plain text, and which of the home page's links are
 * worth reading.
 *
 * There is no HTML parser in apps/web and this does not add one. What the
 * extraction needs is the words a visitor would read, in order, with line
 * breaks where the layout puts them, and without scripts, styles or markup:
 * that keeps the prompt small, and it means no script on a clinic's site is
 * ever more than skipped text to us. Everything here is a single linear pass,
 * because the input is a stranger's 1.5 MB of markup and a regular expression
 * that backtracks over it would be a way to stall the route.
 */

/** Elements whose content is never visible text. Skipped whole. */
const SKIPPED = new Set([
  "script",
  "style",
  "noscript",
  "template",
  "svg",
  "math",
  "iframe",
  "object",
  "canvas",
  "textarea",
  "select",
]);

/** Elements that end a line where they open or close. */
const BREAKS = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "br",
  "dd",
  "div",
  "dl",
  "dt",
  "figcaption",
  "figure",
  "footer",
  "form",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hr",
  "li",
  "main",
  "nav",
  "ol",
  "p",
  "pre",
  "section",
  "table",
  "title",
  "tr",
  "ul",
]);

/** Table cells: kept on one line with a separator, so a price stays beside its service. */
const CELLS = new Set(["td", "th"]);

const TAG = /^<\s*(\/?)\s*([a-zA-Z][a-zA-Z0-9:-]*)/;
const HREF = /\shref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i;

type Tag = { name: string; closing: boolean; raw: string };

/** Lower-case ASCII only, so every index into the copy is an index into the original. */
function asciiLower(text: string): string {
  return text.replace(/[A-Z]+/g, (run) => run.toLowerCase());
}

function walk(html: string, onText: (text: string) => void, onTag: (tag: Tag) => void): void {
  const lower = asciiLower(html);
  const end = html.length;
  let i = 0;
  // The next ">" after the current "<", cached so a run of stray "<" costs
  // one scan rather than one each.
  let gt = -1;
  while (i < end) {
    const lt = html.indexOf("<", i);
    if (lt === -1) {
      onText(html.slice(i));
      return;
    }
    if (lt > i) onText(html.slice(i, lt));
    if (html.startsWith("<!--", lt)) {
      const close = html.indexOf("-->", lt + 4);
      i = close === -1 ? end : close + 3;
      continue;
    }
    if (gt <= lt) gt = html.indexOf(">", lt + 1);
    // An unterminated tag ends the document, as it does in a browser.
    if (gt === -1) return;
    const raw = html.slice(lt, gt + 1);
    const match = TAG.exec(raw);
    if (!match) {
      if (raw[1] === "!" || raw[1] === "?") {
        i = gt + 1;
      } else {
        // A "<" that opens no tag is text: "under <$200".
        onText("<");
        i = lt + 1;
      }
      continue;
    }
    i = gt + 1;
    const name = match[2]!.toLowerCase();
    const closing = match[1] === "/";
    if (!closing && SKIPPED.has(name) && !raw.endsWith("/>")) {
      const close = lower.indexOf(`</${name}`, i);
      if (close === -1) return;
      const after = html.indexOf(">", close);
      i = after === -1 ? end : after + 1;
      continue;
    }
    onTag({ name, closing, raw });
  }
}

const NAMED_ENTITIES = new Map<string, string>(
  Object.entries({
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
    ndash: "–",
    mdash: "—",
    hellip: "…",
    rsquo: "’",
    lsquo: "‘",
    rdquo: "”",
    ldquo: "“",
    copy: "©",
    reg: "®",
    trade: "™",
    middot: "·",
    bull: "•",
    deg: "°",
    times: "×",
    euro: "€",
    pound: "£",
    cent: "¢",
    frac12: "½",
    frac14: "¼",
    frac34: "¾",
    eacute: "é",
    egrave: "è",
    aacute: "á",
    agrave: "à",
    iacute: "í",
    oacute: "ó",
    uacute: "ú",
    ntilde: "ñ",
    ccedil: "ç",
    uuml: "ü",
    ouml: "ö",
    auml: "ä",
    dollar: "$",
    plus: "+",
    ast: "*",
    sol: "/",
    colon: ":",
    comma: ",",
    period: ".",
    excl: "!",
    quest: "?",
    lpar: "(",
    rpar: ")",
    num: "#",
    percnt: "%",
  }),
);

export function decodeEntities(text: string): string {
  if (!text.includes("&")) return text;
  return text.replace(
    /&(#[xX][0-9a-fA-F]{1,6}|#[0-9]{1,7}|[a-zA-Z][a-zA-Z0-9]{1,31});/g,
    (whole, entity: string) => {
      if (entity[0] !== "#") {
        return NAMED_ENTITIES.get(entity) ?? NAMED_ENTITIES.get(entity.toLowerCase()) ?? whole;
      }
      const code =
        entity[1] === "x" || entity[1] === "X"
          ? parseInt(entity.slice(2), 16)
          : parseInt(entity.slice(1), 10);
      if (
        !Number.isFinite(code) ||
        code <= 0 ||
        code > 0x10ffff ||
        (code >= 0xd800 && code <= 0xdfff)
      )
        return whole;
      return String.fromCodePoint(code);
    },
  );
}

/** The visible text of a page, one line per block, table rows kept together. */
export function htmlToText(html: string): string {
  const lines: string[] = [];
  let line = "";
  const flush = () => {
    const clean = line
      .replace(/\s+/g, " ")
      .replace(/^\s*\|\s*/, "")
      .trim();
    if (clean) lines.push(clean);
    line = "";
  };
  walk(
    html,
    (text) => {
      line += decodeEntities(text);
    },
    (tag) => {
      if (BREAKS.has(tag.name)) flush();
      else if (CELLS.has(tag.name) && !tag.closing) line += " | ";
      else line += " ";
    },
  );
  flush();
  return lines.join("\n");
}

export type PageLink = { url: URL; text: string };

const MAX_LINKS = 1_000;
const MAX_LINK_TEXT = 200;

/** Every http(s) link on a page, resolved against it, with its anchor text. */
export function readLinks(html: string, base: URL): PageLink[] {
  const links: PageLink[] = [];
  let open: { href: string; text: string } | null = null;
  const close = () => {
    if (!open || links.length >= MAX_LINKS) {
      open = null;
      return;
    }
    try {
      const url = new URL(open.href.trim(), base);
      if (url.protocol === "http:" || url.protocol === "https:") {
        url.hash = "";
        links.push({ url, text: open.text.replace(/\s+/g, " ").trim().slice(0, MAX_LINK_TEXT) });
      }
    } catch {
      // Not a URL; a link nobody could follow.
    }
    open = null;
  };
  walk(
    html,
    (text) => {
      if (open && open.text.length < MAX_LINK_TEXT) open.text += decodeEntities(text);
    },
    (tag) => {
      if (tag.name !== "a") {
        if (open) open.text += " ";
        return;
      }
      close();
      if (tag.closing) return;
      const href = HREF.exec(tag.raw);
      if (href) open = { href: decodeEntities(href[1] ?? href[2] ?? href[3] ?? ""), text: "" };
    },
  );
  close();
  return links;
}

/** "www.glow.com" and "glow.com" are one site; "book.glow.com" is another. */
export function sameSite(a: string, b: string): boolean {
  const bare = (host: string) =>
    host
      .toLowerCase()
      .replace(/\.$/, "")
      .replace(/^www\./, "");
  return bare(a) === bare(b);
}

/**
 * The page kinds worth reading, in the order they are filled: the menu and
 * its prices first, because those are what setup most wants, then the people,
 * the address and hours, the common questions, and the practice itself. A
 * link counts for a kind when one of these words is in its path or its text.
 */
const PAGE_KINDS: readonly (readonly string[])[] = [
  [
    "services",
    "service",
    "treatments",
    "treatment",
    "menu",
    "procedures",
    "procedure",
    "offerings",
    "therapies",
    "injectables",
  ],
  [
    "pricing",
    "prices",
    "price",
    "rates",
    "fees",
    "cost",
    "costs",
    "specials",
    "packages",
    "membership",
    "memberships",
  ],
  [
    "team",
    "staff",
    "providers",
    "provider",
    "doctors",
    "doctor",
    "practitioners",
    "physicians",
    "injectors",
    "veterinarians",
    "vets",
    "dentists",
    "therapists",
    "meet",
  ],
  ["contact", "location", "locations", "hours", "visit", "directions", "find"],
  ["faq", "faqs", "questions"],
  ["about"],
];

/** Pages that are never about the practice's menu, people or hours. */
const NOT_A_PAGE =
  /\/(blog|news|posts?|articles?|tags?|category|categories|author|wp-admin|wp-login|wp-json|login|log-in|signin|sign-in|account|cart|checkout|shop|privacy|terms|cookies?|careers|jobs|feed)(\/|$)/i;
const NOT_HTML =
  /\.(pdf|jpe?g|png|gif|webp|avif|svg|ico|mp3|mp4|mov|webm|zip|docx?|xlsx?|pptx?|ics|vcf|xml|json|css|js|txt)$/i;

function words(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean),
  );
}

function pageKey(url: URL): string {
  return `${url.hostname.replace(/^www\./, "")}${url.pathname.replace(/\/+$/, "")}${url.search}`;
}

/**
 * At most `max` same-site pages from the home page's links: the best link for
 * each kind above, in that order, then the best of the rest. A link with no
 * kind is never read: a random page costs time and prompt and says nothing
 * setup needs. Ties go to the shallower path, which is usually the index page
 * ("/services") rather than one of its children.
 */
export function pickPages(links: readonly PageLink[], home: URL, max: number): URL[] {
  const seen = new Set([pageKey(home)]);
  const candidates: { url: URL; scores: number[]; depth: number }[] = [];
  for (const link of links) {
    const { url } = link;
    if (!sameSite(url.hostname, home.hostname)) continue;
    if (NOT_HTML.test(url.pathname) || NOT_A_PAGE.test(url.pathname)) continue;
    const key = pageKey(url);
    if (seen.has(key)) continue;
    seen.add(key);
    const inPath = words(decodeURIComponentSafe(url.pathname));
    const inText = words(link.text);
    const scores = PAGE_KINDS.map(
      (kind) =>
        (kind.some((word) => inPath.has(word)) ? 3 : 0) +
        (kind.some((word) => inText.has(word)) ? 2 : 0),
    );
    if (scores.every((score) => score === 0)) continue;
    candidates.push({ url, scores, depth: url.pathname.split("/").filter(Boolean).length });
  }
  const chosen: URL[] = [];
  const taken = new Set<string>();
  const take = (url: URL) => {
    chosen.push(url);
    taken.add(url.href);
  };
  for (let kind = 0; kind < PAGE_KINDS.length && chosen.length < max; kind += 1) {
    const best = candidates
      .filter((c) => c.scores[kind]! > 0 && !taken.has(c.url.href))
      .sort((a, b) => b.scores[kind]! - a.scores[kind]! || a.depth - b.depth)[0];
    if (best) take(best.url);
  }
  const rest = candidates
    .filter((c) => !taken.has(c.url.href))
    .sort((a, b) => Math.max(...b.scores) - Math.max(...a.scores) || a.depth - b.depth);
  for (const candidate of rest) {
    if (chosen.length >= max) break;
    take(candidate.url);
  }
  return chosen;
}

function decodeURIComponentSafe(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

export type PageText = { url: string; text: string };

/** Characters of text per page, and for the whole read: about ten thousand tokens. */
export const TEXT_LIMITS = { perPage: 12_000, total: 40_000 };

/**
 * The pages' text as the extraction sees it, home page first, within the
 * limits above. A line that already appeared on an earlier page is left out
 * of the later one when it has no digit in it: that is the navigation and the
 * footer, repeated on every page. A line with a digit stays wherever it is,
 * because "$199" under one service and "$199" under the next are two prices,
 * and dropping the second would pair a price with the wrong service.
 */
export function pageTexts(pages: readonly { url: string; html: string }[]): PageText[] {
  const seen = new Set<string>();
  const out: PageText[] = [];
  let total = 0;
  for (const [index, page] of pages.entries()) {
    const lines = htmlToText(page.html)
      .split("\n")
      .filter((line) => index === 0 || /\d/.test(line) || !seen.has(line));
    for (const line of lines) seen.add(line);
    const room = Math.min(TEXT_LIMITS.perPage, TEXT_LIMITS.total - total);
    if (room <= 0) break;
    const text = lines.join("\n").slice(0, room);
    if (!text) continue;
    out.push({ url: page.url, text });
    total += text.length;
  }
  return out;
}
