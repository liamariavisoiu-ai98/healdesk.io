/**
 * How every healdesk email looks (owner, 1 November 2026: "brand this email,
 * like all emails sent from healdesk to users with healdesk's branding. it
 * must be apple like but with healdesk branding").
 *
 * The model is the owner's own Apple-like email, the demo-ready email of
 * 30 October 2026 (apps/web/src/lib/email/demo-ready.ts): the healdesk logo
 * centred at the top, Apple's greys and system type, a pill button, a quiet
 * footer under a hairline, white in light mode and black in dark. Every other
 * email is built on this one shell: apps/app's notices
 * (lib/email/templates/compose.ts), the transcript email, the agreement copy
 * and apps/web's text emails (htmlTwinOfText). So a clinic's sign-in link,
 * its daily summary, its transcript and a prospect's setup link all look like
 * the same company.
 *
 * What the shell adds is look, never words: the logo (alt text "healdesk"),
 * a title where the caller gives one, and the styles. Each renderer still
 * writes its own blocks and its own footer, already escaped; the plain-text
 * part is untouched.
 *
 * ## The one thing fetched
 *
 * The logo is the only remote file, and it replaces Annex X1.8's "no images,
 * no remote content" for this one image (owner's request above; the
 * demo-ready email has carried it since 30 October). It is the same public
 * URL in every email, on the marketing site, which is always on (apps/app's
 * host is not, in standby), so it carries nothing about the reader, the
 * clinic or the message: no query, no id, no per-send name. It cannot tell us
 * who opened what, which is what made a remote image a read receipt. Fonts
 * are still the system's own, never loaded. A client that blocks remote
 * images shows the alt text, set in the logo's red, in its place.
 *
 * ## Built to survive mail clients
 *
 * Tables for the frame and the button, because Outlook on Windows lays out
 * with Word and ignores max-width and padding on anything else; inline styles
 * on every element, because a client may drop the <style> block; and classes
 * that dark mode repaints, for the clients that honour prefers-color-scheme
 * (Apple Mail) and Outlook.com's data-ogsc/data-ogsb attributes. Still one
 * column: nothing sits beside anything else.
 *
 * Pure, no dependencies and safe in the browser, like the rest of the catalog.
 */

/** The logo: colour artwork on a transparent PNG, readable on white and on black. */
export const EMAIL_LOGO = {
  /**
   * The email-sized export in apps/web/public/brand (352x64, shown at 176x32
   * for sharp retina type). Email clients show no WebP, hence the PNG.
   */
  url: "https://healdesk.io/brand/healdesk-logo-email.png",
  width: 176,
  height: 32,
  alt: "healdesk",
} as const;

/** Apple's greys, as the owner's demo-ready email uses them, plus healdesk's red. */
export const EMAIL_COLORS = {
  page: "#FFFFFF",
  ink: "#1D1D1F",
  muted: "#6E6E73",
  rule: "#D2D2D7",
  soft: "#F5F5F7",
  /** The logo's red (--color-red on the site): the alt text when images are off. */
  brand: "#E62627",
  /**
   * Links in running text: the logo red darkened just enough to read as text
   * (--color-red-deep on the site, 5.08:1 on white).
   */
  link: "#DA191A",
} as const;

/** The same, on black, for the clients that honour dark mode. */
export const EMAIL_DARK_COLORS = {
  page: "#000000",
  ink: "#F5F5F7",
  muted: "#A1A1A6",
  rule: "#38383A",
  soft: "#1C1C1E",
  /** Apple's dark-mode red: 6.2:1 on black, where the light red is 4.1:1. */
  link: "#FF453A",
} as const;

/**
 * The system's own sans, San Francisco first. Nothing is loaded: a web font
 * is remote content, fetched whenever the message opens.
 */
export const EMAIL_FONT =
  "-apple-system,BlinkMacSystemFont,'SF Pro Text','Helvetica Neue','Segoe UI',Roboto,Helvetica,Arial,sans-serif";
/** San Francisco's display cut for the title, the same stack after it. */
export const EMAIL_DISPLAY_FONT =
  "-apple-system,BlinkMacSystemFont,'SF Pro Display','Helvetica Neue','Segoe UI',Roboto,Helvetica,Arial,sans-serif";
export const EMAIL_MONO_FONT = "ui-monospace,SFMono-Regular,Menlo,Consolas,monospace";

/** The frame's width, and how far its text sits from each edge. */
export const EMAIL_WIDTH = 600;

/**
 * The inline styles each kind of text carries. Every one names its font,
 * size and colour itself, so a client that drops the <style> block, or
 * Outlook, which resets a paragraph's font, still shows the same email.
 */
export const EMAIL_STYLES = {
  title:
    `margin:0 0 28px;font-family:${EMAIL_DISPLAY_FONT};font-size:28px;line-height:34px;` +
    `font-weight:700;letter-spacing:-0.5px;color:${EMAIL_COLORS.ink};text-align:center;`,
  paragraph: `margin:0 0 18px;font-family:${EMAIL_FONT};font-size:17px;line-height:26px;color:${EMAIL_COLORS.ink};`,
  small: `margin:0 0 18px;font-family:${EMAIL_FONT};font-size:13px;line-height:19px;color:${EMAIL_COLORS.muted};`,
  footer: `margin:0 0 10px;font-family:${EMAIL_FONT};font-size:12px;line-height:18px;color:${EMAIL_COLORS.muted};`,
  link: `color:${EMAIL_COLORS.link};text-decoration:underline;text-underline-offset:2px;`,
  footerLink: `color:${EMAIL_COLORS.muted};text-decoration:underline;`,
} as const;

/**
 * Dark mode and the small-screen rules. Inline styles carry the light
 * rendering, so a client that strips <style> still shows a readable message;
 * every coloured element names a class here for the clients that repaint.
 */
const STYLE_BLOCK = `
  :root { color-scheme: light dark; supported-color-schemes: light dark; }
  body { margin:0; padding:0; width:100%!important; -webkit-text-size-adjust:100%; -ms-text-size-adjust:100%; }
  table { border-collapse:collapse; mso-table-lspace:0; mso-table-rspace:0; }
  img { border:0; line-height:100%; outline:none; text-decoration:none; }
  a[x-apple-data-detectors] { color:inherit!important; text-decoration:none!important; font:inherit!important; }
  u + #body a { color:inherit; text-decoration:none; font:inherit; }
  #MessageViewBody a { color:inherit; text-decoration:none; font:inherit; }
  .hd-action:hover { opacity:.88; }

  @media (max-width:620px) {
    .hd-wrap { width:100%!important; }
    .hd-px { padding-left:24px!important; padding-right:24px!important; }
    .hd-title { font-size:24px!important; line-height:30px!important; }
  }

  @media (prefers-color-scheme: dark) {
    body, .hd-page { background:${EMAIL_DARK_COLORS.page}!important; }
    .hd-ink { color:${EMAIL_DARK_COLORS.ink}!important; }
    .hd-muted { color:${EMAIL_DARK_COLORS.muted}!important; }
    .hd-rule { border-color:${EMAIL_DARK_COLORS.rule}!important; }
    .hd-soft { background:${EMAIL_DARK_COLORS.soft}!important; }
    .hd-link { color:${EMAIL_DARK_COLORS.link}!important; }
    .hd-btn { background:${EMAIL_DARK_COLORS.ink}!important; }
    a.hd-action { background:${EMAIL_DARK_COLORS.ink}!important; color:${EMAIL_COLORS.ink}!important; }
    .hd-btn-outline { border-color:${EMAIL_DARK_COLORS.ink}!important; }
  }
  [data-ogsc] .hd-ink { color:${EMAIL_DARK_COLORS.ink}!important; }
  [data-ogsc] .hd-muted { color:${EMAIL_DARK_COLORS.muted}!important; }
  [data-ogsc] .hd-link { color:${EMAIL_DARK_COLORS.link}!important; }
  [data-ogsc] a.hd-action { color:${EMAIL_COLORS.ink}!important; }
  [data-ogsc] .hd-btn-outline { border-color:${EMAIL_DARK_COLORS.ink}!important; }
  [data-ogsb] .hd-page { background:${EMAIL_DARK_COLORS.page}!important; }
  [data-ogsb] .hd-soft { background:${EMAIL_DARK_COLORS.soft}!important; }
  [data-ogsb] .hd-btn, [data-ogsb] a.hd-action { background:${EMAIL_DARK_COLORS.ink}!important; }
`;

/** Outlook on Windows: 96 dpi, and a font for the paragraphs Word would set in Times. */
const MSO_HEAD = `<!--[if mso]>
<noscript><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript>
<style>td,th,div,p,a,h1,h2,span,li{font-family:'Segoe UI',Helvetica,Arial,sans-serif !important;}</style>
<![endif]-->`;

/**
 * After the preheader, so the inbox's preview stops there instead of running
 * on into the body: invisible joiners and spaces.
 */
const PREVIEW_STOP = "&#847;&zwnj;&nbsp;".repeat(16);

export function escapeEmailHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** The logo, centred; its alt text is styled to stand in for it when images are off. */
export function emailLogoHtml(): string {
  return (
    `<img src="${EMAIL_LOGO.url}" width="${EMAIL_LOGO.width}" height="${EMAIL_LOGO.height}" alt="${EMAIL_LOGO.alt}" ` +
    `style="display:block;margin:0 auto;width:${EMAIL_LOGO.width}px;height:${EMAIL_LOGO.height}px;border:0;outline:none;` +
    `text-decoration:none;font-family:${EMAIL_DISPLAY_FONT};font-size:24px;line-height:32px;font-weight:700;` +
    `color:${EMAIL_COLORS.brand};text-align:center;">`
  );
}

/**
 * The pill button: a table cell, so Outlook keeps its colour and padding
 * (it squares the corners). `label` and `url` are plain text, escaped here.
 *
 * An email's first action is the filled pill, `hd-action`, which dark mode
 * inverts to light on black; any later one is the outlined pill, as Apple
 * sets a second choice beside the first, so an email with several links
 * still shows which one is the next step (Annex X1.3).
 */
export function emailButtonHtml(
  label: string,
  url: string,
  variant: "primary" | "secondary" = "primary",
): string {
  const href = escapeEmailHtml(url);
  const text = escapeEmailHtml(label);
  if (variant === "secondary") {
    return (
      `<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:4px auto 26px;border-collapse:separate;">` +
      `<tr><td align="center" class="hd-btn-outline" style="border:1px solid ${EMAIL_COLORS.ink};border-radius:980px;mso-padding-alt:12px 30px;">` +
      `<a class="hd-action-outline hd-ink" href="${href}" style="display:inline-block;padding:12px 30px;` +
      `font-family:${EMAIL_FONT};font-size:16px;line-height:20px;font-weight:600;color:${EMAIL_COLORS.ink};` +
      `text-decoration:none;border-radius:980px;">${text}</a>` +
      `</td></tr></table>`
    );
  }
  return (
    `<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:10px auto 28px;border-collapse:separate;">` +
    `<tr><td align="center" class="hd-btn" style="background:${EMAIL_COLORS.ink};border-radius:980px;mso-padding-alt:14px 34px;">` +
    `<a class="hd-action" href="${href}" style="display:inline-block;padding:14px 34px;` +
    `font-family:${EMAIL_FONT};font-size:17px;line-height:20px;font-weight:600;color:#FFFFFF;` +
    `background:${EMAIL_COLORS.ink};text-decoration:none;border-radius:980px;">${text}</a>` +
    `</td></tr></table>`
  );
}

export type BrandedEmail = {
  /** The subject: the document's <title>. Plain text, escaped here. */
  subject: string;
  /** The hidden line inboxes show after the subject. Plain text, escaped here. */
  preheader?: string;
  /** The large line under the logo, or none. Plain text, escaped here. */
  title?: string | null;
  /** The email's blocks, as HTML the caller has already escaped. */
  bodyHtml: string;
  /** The footer's paragraphs, as HTML the caller has already escaped; none when empty. */
  footerHtml?: string;
};

/**
 * The whole document: the logo, the title, the body, then the footer under a
 * hairline, in a 600-pixel column on white (black in dark mode).
 */
export function brandedEmailDocument(email: BrandedEmail): string {
  const preheader = email.preheader?.trim()
    ? `<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:#FFFFFF;opacity:0;">` +
      `${escapeEmailHtml(email.preheader)}${PREVIEW_STOP}</div>`
    : "";
  const title = email.title?.trim()
    ? `<h1 class="hd-title hd-ink" style="${EMAIL_STYLES.title}">${escapeEmailHtml(email.title)}</h1>\n`
    : "";
  // The footer opens with the document's first <hr>, its hairline: what comes
  // before it is the email, what comes after is the footer (a test that reads
  // the body alone cuts there, as it did before the shell).
  const footer = email.footerHtml?.trim()
    ? [
        `<tr><td class="hd-px" style="padding:40px 48px 48px 48px;">`,
        `<hr class="hd-rule" style="height:0;border:0;border-top:1px solid ${EMAIL_COLORS.rule};margin:0 0 24px 0;">`,
        email.footerHtml,
        `</td></tr>`,
      ].join("\n")
    : `<tr><td style="padding:0 0 48px 0;font-size:0;line-height:0;"></td></tr>`;

  return [
    "<!doctype html>",
    // Office's namespace only, for the settings Outlook reads in the head: no
    // XHTML namespace, whose http:// address the link scanners would read as a link.
    '<html lang="en" dir="ltr" xmlns:o="urn:schemas-microsoft-com:office:office">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="x-apple-disable-message-reformatting">',
    '<meta name="format-detection" content="telephone=no, date=no, address=no, email=no, url=no">',
    '<meta name="color-scheme" content="light dark">',
    '<meta name="supported-color-schemes" content="light dark">',
    `<title>${escapeEmailHtml(email.subject)}</title>`,
    MSO_HEAD,
    `<style>${STYLE_BLOCK}</style>`,
    "</head>",
    `<body id="body" class="hd-page" style="margin:0;padding:0;background:${EMAIL_COLORS.page};">`,
    preheader,
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="hd-page" style="background:${EMAIL_COLORS.page};">`,
    `<tr><td align="center" style="padding:0;">`,
    `<table role="presentation" width="${EMAIL_WIDTH}" cellpadding="0" cellspacing="0" border="0" class="hd-wrap" style="width:${EMAIL_WIDTH}px;max-width:${EMAIL_WIDTH}px;">`,
    `<tr><td align="center" class="hd-px" style="padding:48px 48px 0 48px;">${emailLogoHtml()}</td></tr>`,
    // The body's own font and ink, for any text that names neither: dark
    // mode repaints the ink through the class, and the text inherits it.
    `<tr><td class="hd-px hd-ink" style="padding:40px 48px 0 48px;font-family:${EMAIL_FONT};color:${EMAIL_COLORS.ink};">`,
    `${title}${email.bodyHtml}`,
    `</td></tr>`,
    footer,
    "</table>",
    "</td></tr>",
    "</table>",
    "</body>",
    "</html>",
  ]
    .filter((line) => line !== "")
    .join("\n");
}
