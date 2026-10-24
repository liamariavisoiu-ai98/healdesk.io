import type { RichSegment } from "@/lib/email/templates/compose";

import { PLACES } from "./places";

/**
 * Emphasis in an ops alert (lane N4; owner, 24 October 2026: "bold and
 * highlighted and underlined text"), parsed by ONE function for the HTML
 * email, the plain-text email and Slack.
 *
 * Two sources, one result (RichSegment[], which compose.ts renders):
 *
 *   - a wording writer's markers: `**bold**`, `__underline__`,
 *     `==highlight==`. A marker counts only when it pairs with the same
 *     marker later and nothing between them is another marker; an unpaired
 *     or nested marker is printed as the plain characters it is, so a typo
 *     can never produce broken markup;
 *   - the renderer's own emphasis, in private-use characters that no
 *     wording and no filled value can contain (neutraliseValue strips them):
 *     a filled value in the headline and the first sentence (bold), a day
 *     (highlight), a console place or button in a step (bold and underline).
 *
 * The HTML is escaped after parsing, segment by segment (compose.ts), so a
 * `<` or `&` anywhere prints as itself.
 */

/** The renderer's markers. Balanced by construction; toggled, never nested in themselves. */
export const MARK = {
  bold: "\uE001",
  highlight: "\uE002",
  place: "\uE003",
  /** A filled value in a step: no emphasis, but nothing inside it is a console place. */
  value: "\uE004",
} as const;

const PRIVATE_USE = /[\uE000-\uF8FF]/g;
const IS_PRIVATE_USE = /^[\uE000-\uF8FF]$/;
const AUTHOR = /\*\*|__|==/g;

/**
 * A filled value as it may enter a wording: none of the renderer's private
 * markers, and no run of two marker characters, so a clinic called
 * "**Glow**" or "A==B" prints its characters and emphasises nothing.
 */
export function neutraliseValue(value: string): string {
  return value.replace(PRIVATE_USE, "").replace(/\*{2,}/g, "*").replace(/_{2,}/g, "_").replace(/={2,}/g, "=");
}

/** Wrap a piece of text in one of the renderer's markers. */
export function mark(kind: keyof typeof MARK, text: string): string {
  return text ? `${MARK[kind]}${text}${MARK[kind]}` : text;
}

/** The text with every marker of both kinds taken out: what a reader reads. */
export function plainText(text: string): string {
  return toPlain(parseMarkup(text));
}

/** The author markers that pair, as [open index, close index]; the rest are literal. */
function authorPairs(text: string): Map<number, number> {
  const tokens = [...text.matchAll(AUTHOR)].map((m) => ({ at: m.index!, token: m[0] }));
  const pairs = new Map<number, number>();
  let i = 0;
  while (i < tokens.length) {
    const open = tokens[i]!;
    const next = tokens[i + 1];
    // Pairs only with the very next marker, and only when it is the same one:
    // anything between them would be nesting, which prints as plain text.
    if (next && next.token === open.token && next.at > open.at + 2) {
      const inner = text.slice(open.at + 2, next.at);
      if (inner.trim() === inner) {
        pairs.set(open.at, next.at);
        i += 2;
        continue;
      }
    }
    i += 1;
  }
  return pairs;
}

/** Text with markers in, segments out. Never throws, never drops a character a reader should see. */
export function parseMarkup(text: string): RichSegment[] {
  const pairs = authorPairs(text);
  const closes = new Set(pairs.values());
  const segments: RichSegment[] = [];
  const state = { bold: false, underline: false, highlight: false, place: false };
  const author = { bold: false, underline: false, highlight: false };
  let buffer = "";
  const flush = () => {
    if (!buffer) return;
    const bold = state.bold || state.place || author.bold;
    const underline = state.place || author.underline;
    const highlight = state.highlight || author.highlight;
    const last = segments[segments.length - 1];
    if (last && Boolean(last.bold) === bold && Boolean(last.underline) === underline && Boolean(last.highlight) === highlight) {
      last.text += buffer;
    } else {
      segments.push({ text: buffer, ...(bold ? { bold } : {}), ...(underline ? { underline } : {}), ...(highlight ? { highlight } : {}) });
    }
    buffer = "";
  };
  for (let i = 0; i < text.length; ) {
    const ch = text[i]!;
    if (ch === MARK.value) {
      i += 1;
      continue;
    }
    if (ch === MARK.bold || ch === MARK.highlight || ch === MARK.place) {
      flush();
      if (ch === MARK.bold) state.bold = !state.bold;
      else if (ch === MARK.highlight) state.highlight = !state.highlight;
      else state.place = !state.place;
      i += 1;
      continue;
    }
    if (pairs.has(i) || closes.has(i)) {
      flush();
      const token = text.slice(i, i + 2);
      const key = token === "**" ? "bold" : token === "__" ? "underline" : "highlight";
      author[key] = !author[key];
      i += 2;
      continue;
    }
    if (IS_PRIVATE_USE.test(ch)) {
      i += 1;
      continue;
    }
    buffer += ch;
    i += 1;
  }
  flush();
  return segments;
}

/** The plain-text email: the words, no markers. */
export function toPlain(segments: readonly RichSegment[]): string {
  return segments.map((s) => s.text).join("");
}

/**
 * Slack mrkdwn: bold as `*x*`; underline and highlight have no Slack form, so
 * they are bold too. Spaces stay outside the asterisks, which Slack needs.
 * The caller escapes `&`, `<` and `>` in the words first (escape).
 */
export function toSlack(segments: readonly RichSegment[], escape: (text: string) => string): string {
  return segments
    .map((s) => {
      const words = escape(s.text);
      if (!(s.bold || s.underline || s.highlight)) return words;
      const lead = /^\s*/.exec(words)![0];
      const trail = /\s*$/.exec(words)![0];
      const core = words.slice(lead.length, words.length - trail.length);
      return core ? `${lead}*${core}*${trail}` : words;
    })
    .join("");
}

const PLACE_PATTERN = new RegExp(
  `(?<![A-Za-z])(${Object.keys(PLACES)
    .sort((a, b) => b.length - a.length)
    .map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|")})(?![A-Za-z])`,
  "g",
);

/**
 * A step with every console place and button it names marked (bold and
 * underline), longest name first, once each where it stands, never inside a
 * span the renderer already marked (a filled value or a day).
 */
export function emphasisePlaces(step: string): string {
  let out = "";
  const open = new Set<string>();
  let chunk = "";
  const take = () => {
    out += open.size > 0 ? chunk : chunk.replace(PLACE_PATTERN, (name) => mark("place", name));
    chunk = "";
  };
  for (const ch of step) {
    if (ch === MARK.bold || ch === MARK.highlight || ch === MARK.place || ch === MARK.value) {
      take();
      if (open.has(ch)) open.delete(ch);
      else open.add(ch);
      out += ch;
      continue;
    }
    chunk += ch;
  }
  take();
  return out;
}
