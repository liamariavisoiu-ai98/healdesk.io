/**
 * The light HTML twin of a plain-text email (Annex X1.8 of the funnel and
 * portal plan): "Plain text first, with a light HTML twin built from the same
 * blocks: one column, system fonts, no images, no remote content, under 100 KB
 * (Gmail clips at 102 KB)."
 *
 * apps/app builds its twin from the blocks a template lists
 * (apps/app/src/lib/email/templates/compose.ts). apps/web's emails are written
 * as text, so their twin is built from the text itself: each paragraph (a run
 * of lines between blank lines) becomes one paragraph with its line breaks
 * kept, every http(s) address already in the text becomes that same address as
 * a link, and the footer after the `--` line is set in a quieter colour. The
 * twin can never say anything the text does not, because the text is all it
 * is made from, and it adds no link the text does not carry.
 *
 * Pure, no dependencies, and safe in the browser: the size is measured with
 * TextEncoder, not Buffer.
 */

/** Gmail clips a message over 102 KB; this leaves room for the headers the provider adds. */
export const EMAIL_HTML_MAX_BYTES = 100 * 1024;

/** Nothing is loaded: a web font is remote content, fetched whenever the message opens. */
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
}`;

export function escapeEmailHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * One column, the system font stack, light and dark, nothing fetched. The
 * body is HTML the caller has already escaped.
 */
export function emailHtmlDocument(subject: string, bodyHtml: string): string {
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="color-scheme" content="light dark">',
    '<meta name="supported-color-schemes" content="light dark">',
    `<title>${escapeEmailHtml(subject)}</title>`,
    `<style>${DARK_MODE}</style>`,
    "</head>",
    `<body style="margin:0;padding:0;background:#ffffff;color:${INK};font-family:${FONT};">`,
    `<div class="hd-wrap" style="max-width:560px;margin:0 auto;padding:24px 16px;font-size:16px;line-height:1.5;color:${INK};font-family:${FONT};">`,
    bodyHtml,
    "</div>",
    "</body>",
    "</html>",
  ].join("\n");
}

/** Every http(s) address in a line of text. Trailing sentence punctuation is not part of it. */
const URL_IN_TEXT = /https?:\/\/[^\s<>"'`]+/g;

/** Escape a run of text, with each address in it as a link to itself. */
function linkified(text: string): string {
  let out = "";
  let last = 0;
  for (const match of text.matchAll(URL_IN_TEXT)) {
    const start = match.index ?? 0;
    const url = match[0].replace(/[.,;:!?)\]]+$/, "");
    out += escapeEmailHtml(text.slice(last, start));
    out += `<a href="${escapeEmailHtml(url)}" style="color:inherit;">${escapeEmailHtml(url)}</a>`;
    last = start + url.length;
  }
  return out + escapeEmailHtml(text.slice(last));
}

function paragraph(text: string, muted: boolean): string {
  const style = muted
    ? `margin:0 0 6px;white-space:pre-wrap;color:${MUTED};font-size:13px;`
    : "margin:0 0 16px;white-space:pre-wrap;";
  return `<p${muted ? ' class="hd-muted"' : ""} style="${style}">${linkified(text)}</p>`;
}

/** The line that opens a footer in apps/web's text: `--` alone. */
const FOOTER_RULE = /^--\s*$/;

/**
 * The HTML twin of `text`, or null when it would be over the size ceiling, in
 * which case the email goes as text alone rather than clipped.
 */
export function htmlTwinOfText(subject: string, text: string): string | null {
  const blocks: string[] = [];
  let inFooter = false;
  for (const block of text.replace(/\r\n/g, "\n").split(/\n{2,}/)) {
    const lines = block.split("\n");
    const rule = lines.findIndex((line) => FOOTER_RULE.test(line));
    if (rule >= 0) {
      const before = lines.slice(0, rule).join("\n");
      if (before.trim()) blocks.push(paragraph(before, inFooter));
      blocks.push(`<hr style="border:0;border-top:1px solid #d0d7de;margin:24px 0 12px;">`);
      inFooter = true;
      for (const line of lines.slice(rule + 1)) {
        if (line.trim()) blocks.push(paragraph(line, true));
      }
      continue;
    }
    if (!block.trim()) continue;
    if (inFooter) {
      for (const line of lines) if (line.trim()) blocks.push(paragraph(line, true));
    } else {
      blocks.push(paragraph(block, false));
    }
  }
  const html = emailHtmlDocument(subject, blocks.join("\n"));
  return new TextEncoder().encode(html).length > EMAIL_HTML_MAX_BYTES ? null : html;
}
