import { SENDER_IDENTITY } from "@healdesk/catalog";

import type { RenderedEmail, TemplateContext } from "./types";

/**
 * The blocks every email is written in, and the footer every email ends with.
 *
 * Plain text first (Annex X1.8): a template lists blocks, and both renderings
 * are built from the same list, so the HTML can never say something the text
 * does not. The HTML is deliberately plain: one column, system fonts, no
 * images and nothing fetched from anywhere, because a remote image is a read
 * receipt and a tracking pixel in all but name, and because Gmail clips a
 * message over 102 KB (compose refuses anything over 100 KB).
 *
 * The footer is not the template's to write. compose() appends it to both
 * renderings, so no template can leave out the sender's identity, the postal
 * address, the reply line or, for an optional or commercial kind, the way to
 * stop it.
 */

export type Block =
  /** One paragraph. Line breaks inside it are kept. */
  | { type: "paragraph"; text: string }
  /** Label and value pairs: ids, counts, dates. */
  | { type: "facts"; rows: readonly (readonly [label: string, value: string])[] }
  /** The one next action (X1.3): a link, as a button in HTML and "Label: url" in text. */
  | { type: "action"; label: string; url: string }
  | { type: "list"; items: readonly string[] }
  /**
   * Text to copy exactly, such as the line a clinic pastes on its website
   * (O10, O11): on a line of its own in text, and in HTML a monospaced box
   * that wraps rather than scrolls, escaped like every other value, so a tag
   * in it is shown and never parsed.
   */
  | { type: "code"; text: string }
  /**
   * A list whose every item ends in its own link: the daily summary's rows,
   * "Phone call · Waiting for you", each opening its request. "- text:
   * url" in text; in HTML the label is the link.
   */
  | { type: "links"; items: readonly { text: string; label: string; url: string }[] };

export type EmailContent = {
  subject: string;
  preheader: string;
  blocks: readonly Block[];
  /**
   * The footer's line about reaching us. `reply` for every email but one:
   * `write_new` for an email whose body carries a live single-use link and
   * asks the reader to write to hello@ afresh instead (O16), so the footer
   * does not invite the reply that would quote the link into our inbox.
   */
  replyLine?: "reply" | "write_new";
};

/** Gmail clips at 102 KB; this leaves room for the headers Resend adds. */
export const MAX_HTML_BYTES = 100 * 1024;

/** The line every footer carries, so hello@ stays free of patient details (X1.9). */
export const REPLY_LINE = "Replies reach the healdesk team. Please leave out patient details.";

/**
 * X1.9's line for the one email whose link must not be quoted back to us
 * (O16): where to write instead of replying, and, as every footer says, to
 * leave out patient details.
 */
export const WRITE_NEW_LINE =
  "To reach the healdesk team, write a new email to hello@healdesk.io rather than replying. Please leave out patient details.";

export class EmailCompositionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmailCompositionError";
  }
}

/** The footer, as lines of text, in the order both renderings print them. */
export function footerLines(
  ctx: TemplateContext,
  replyLine: EmailContent["replyLine"] = "reply",
): string[] {
  return [
    ctx.reason,
    replyLine === "write_new" ? WRITE_NEW_LINE : REPLY_LINE,
    ...(ctx.unsubscribeUrl ? [`Stop these emails: ${ctx.unsubscribeUrl}`] : []),
    SENDER_IDENTITY.postalAddress,
  ];
}

export function compose(content: EmailContent, ctx: TemplateContext): RenderedEmail {
  for (const [field, value] of [
    ["subject", content.subject],
    ["preheader", content.preheader],
  ] as const) {
    if (/[\r\n]/.test(value)) {
      throw new EmailCompositionError(`The ${field} must be one line.`);
    }
  }
  if (!ctx.reason.trim()) {
    throw new EmailCompositionError("Every email says why the recipient gets it (X1.9).");
  }

  const footer = ["—", ...footerLines(ctx, content.replyLine)].join("\n");
  const text = [...content.blocks.map(blockText), footer].join("\n\n");
  const html = renderHtml(content, ctx);

  const bytes = Buffer.byteLength(html, "utf8");
  if (bytes > MAX_HTML_BYTES) {
    throw new EmailCompositionError(
      `The HTML is ${bytes} bytes, over the ${MAX_HTML_BYTES}-byte ceiling: Gmail would clip it.`,
    );
  }

  return { subject: content.subject, preheader: content.preheader, text: `${text}\n`, html };
}

function blockText(block: Block): string {
  switch (block.type) {
    case "paragraph":
      return block.text;
    case "facts":
      return block.rows.map(([label, value]) => `${label}: ${value}`).join("\n");
    case "action":
      return `${block.label}: ${block.url}`;
    case "list":
      return block.items.map((item) => `- ${item}`).join("\n");
    case "code":
      return block.text;
    case "links":
      return block.items.map((item) => `- ${item.text}: ${item.url}`).join("\n");
  }
}

// -----------------------------------------------------------------------------
// HTML
// -----------------------------------------------------------------------------

/**
 * The system font stack. Nothing is loaded: a web font is remote content, and
 * remote content is a request every mail client makes when the message opens.
 */
const FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

const INK = "#1f2328";
const MUTED = "#57606a";

/**
 * Dark mode, for the clients that honour prefers-color-scheme. Inline styles
 * carry the light rendering, so a client that strips <style> still shows a
 * readable message.
 */
const DARK_MODE = `@media (prefers-color-scheme: dark) {
  body, .hd-wrap { background: #0d1117 !important; color: #e6edf3 !important; }
  .hd-muted { color: #9da7b3 !important; }
  a { color: #8cc4ff !important; }
  a.hd-action { background: #e6edf3 !important; color: #0d1117 !important; }
}`;

function renderHtml(content: EmailContent, ctx: TemplateContext): string {
  const blocks = content.blocks.map(blockHtml).join("\n");
  const footer = footerLines(ctx, content.replyLine)
    .map(
      (line) =>
        `<p class="hd-muted" style="margin:0 0 6px;color:${MUTED};font-size:13px;">${linkify(line)}</p>`,
    )
    .join("\n");

  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="color-scheme" content="light dark">',
    '<meta name="supported-color-schemes" content="light dark">',
    `<title>${escapeHtml(content.subject)}</title>`,
    `<style>${DARK_MODE}</style>`,
    "</head>",
    `<body style="margin:0;padding:0;background:#ffffff;color:${INK};">`,
    // The preheader: shown in the inbox list, hidden in the message.
    `<span style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all;">${escapeHtml(content.preheader)}</span>`,
    `<div class="hd-wrap" style="max-width:560px;margin:0 auto;padding:24px 16px;font-family:${FONT};font-size:16px;line-height:1.5;color:${INK};background:#ffffff;">`,
    blocks,
    `<hr style="border:none;border-top:1px solid #d0d7de;margin:24px 0 16px;">`,
    footer,
    "</div>",
    "</body>",
    "</html>",
  ].join("\n");
}

function blockHtml(block: Block): string {
  switch (block.type) {
    case "paragraph":
      return `<p style="margin:0 0 16px;">${escapeHtml(block.text).replace(/\n/g, "<br>")}</p>`;
    case "facts":
      return block.rows
        .map(
          ([label, value]) =>
            `<p style="margin:0 0 4px;"><strong>${escapeHtml(label)}:</strong> ${escapeHtml(value)}</p>`,
        )
        .join("\n");
    case "action":
      return (
        `<p style="margin:16px 0 24px;"><a class="hd-action" href="${escapeHtml(block.url)}" ` +
        `style="display:inline-block;background:${INK};color:#ffffff;padding:10px 16px;` +
        `border-radius:6px;text-decoration:none;font-weight:600;">${escapeHtml(block.label)}</a></p>`
      );
    case "code":
      // Its own ink on its own ground, so a client's dark mode, which
      // repaints the page, never leaves light text on this light box.
      return (
        `<pre style="margin:0 0 16px;padding:12px;background:#f6f8fa;color:${INK};` +
        `border:1px solid #d0d7de;border-radius:6px;font-family:ui-monospace, SFMono-Regular, ` +
        `Menlo, Consolas, monospace;font-size:13px;line-height:1.4;white-space:pre-wrap;` +
        `word-break:break-all;">${escapeHtml(block.text)}</pre>`
      );
    case "list":
      return `<ul style="margin:0 0 16px;padding-left:20px;">${block.items
        .map((item) => `<li>${escapeHtml(item)}</li>`)
        .join("")}</ul>`;
    case "links":
      return `<ul style="margin:0 0 16px;padding-left:20px;">${block.items
        .map(
          (item) =>
            `<li style="margin:0 0 4px;">${escapeHtml(item.text)} · <a href="${escapeHtml(item.url)}">${escapeHtml(item.label)}</a></li>`,
        )
        .join("")}</ul>`;
  }
}

/** The footer's one link (the stop link), clickable in HTML; everything else escaped. */
function linkify(line: string): string {
  const match = /^(Stop these emails: )(https:\/\/\S+|http:\/\/\S+)$/.exec(line);
  if (!match) return escapeHtml(line);
  return `${escapeHtml(match[1]!)}<a href="${escapeHtml(match[2]!)}">${escapeHtml(match[2]!)}</a>`;
}

/** For text and for attribute values alike: every value in the HTML passes through it. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
