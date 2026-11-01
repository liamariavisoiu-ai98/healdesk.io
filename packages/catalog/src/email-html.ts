import { brandedEmailDocument, EMAIL_STYLES, escapeEmailHtml } from "./email-brand";

/**
 * The HTML twin of a plain-text email (Annex X1.8 of the funnel and portal
 * plan): "Plain text first, with a light HTML twin built from the same
 * blocks", under 100 KB (Gmail clips at 102 KB). Since 1 November 2026 it
 * wears healdesk's look, the catalog's branded shell (email-brand.ts): the
 * logo at the top, Apple's type and greys, the footer under a hairline. The
 * logo is the one thing fetched; email-brand.ts says why that is safe.
 *
 * apps/app builds its twin from the blocks a template lists
 * (apps/app/src/lib/email/templates/compose.ts). apps/web's emails are written
 * as text, so their twin is built from the text itself: each paragraph (a run
 * of lines between blank lines) becomes one paragraph with its line breaks
 * kept, every http(s) address already in the text becomes that same address as
 * a link, and the footer after the `--` line goes to the shell's footer, set
 * small and grey. The twin can never say anything the text does not, because
 * the text is all it is made from: no title, since these emails are letters,
 * and no link the text does not carry.
 *
 * Pure, no dependencies, and safe in the browser: the size is measured with
 * TextEncoder, not Buffer.
 */

/** Gmail clips a message over 102 KB; this leaves room for the headers the provider adds. */
export const EMAIL_HTML_MAX_BYTES = 100 * 1024;

/**
 * The branded document around a body the caller has already escaped: the
 * logo, an optional title, the body, and an optional footer.
 */
export function emailHtmlDocument(
  subject: string,
  bodyHtml: string,
  options: { title?: string | null; preheader?: string; footerHtml?: string } = {},
): string {
  return brandedEmailDocument({ subject, bodyHtml, ...options });
}

/** Every http(s) address in a line of text. Trailing sentence punctuation is not part of it. */
const URL_IN_TEXT = /https?:\/\/[^\s<>"'`]+/g;

/** Escape a run of text, with each address in it as a link to itself. */
function linkified(text: string, muted: boolean): string {
  const [className, style] = muted
    ? ["hd-muted", EMAIL_STYLES.footerLink]
    : ["hd-link", EMAIL_STYLES.link];
  let out = "";
  let last = 0;
  for (const match of text.matchAll(URL_IN_TEXT)) {
    const start = match.index ?? 0;
    const url = match[0].replace(/[.,;:!?)\]]+$/, "");
    out += escapeEmailHtml(text.slice(last, start));
    out += `<a href="${escapeEmailHtml(url)}" class="${className}" style="${style}word-break:break-all;">${escapeEmailHtml(url)}</a>`;
    last = start + url.length;
  }
  return out + escapeEmailHtml(text.slice(last));
}

function paragraph(text: string, muted: boolean): string {
  return muted
    ? `<p class="hd-muted" style="${EMAIL_STYLES.footer}white-space:pre-wrap;">${linkified(text, true)}</p>`
    : `<p class="hd-ink" style="${EMAIL_STYLES.paragraph}white-space:pre-wrap;">${linkified(text, false)}</p>`;
}

/** The line that opens a footer in apps/web's text: `--` alone. */
const FOOTER_RULE = /^--\s*$/;

/**
 * The HTML twin of `text`, or null when it would be over the size ceiling, in
 * which case the email goes as text alone rather than clipped.
 */
export function htmlTwinOfText(subject: string, text: string): string | null {
  const body: string[] = [];
  const footer: string[] = [];
  let inFooter = false;
  for (const block of text.replace(/\r\n/g, "\n").split(/\n{2,}/)) {
    const lines = block.split("\n");
    const rule = lines.findIndex((line) => FOOTER_RULE.test(line));
    if (rule >= 0) {
      const before = lines.slice(0, rule).join("\n");
      if (before.trim()) (inFooter ? footer : body).push(paragraph(before, inFooter));
      inFooter = true;
      for (const line of lines.slice(rule + 1)) {
        if (line.trim()) footer.push(paragraph(line, true));
      }
      continue;
    }
    if (!block.trim()) continue;
    if (inFooter) {
      for (const line of lines) if (line.trim()) footer.push(paragraph(line, true));
    } else {
      body.push(paragraph(block, false));
    }
  }
  const html = emailHtmlDocument(subject, body.join("\n"), { footerHtml: footer.join("\n") });
  return new TextEncoder().encode(html).length > EMAIL_HTML_MAX_BYTES ? null : html;
}
