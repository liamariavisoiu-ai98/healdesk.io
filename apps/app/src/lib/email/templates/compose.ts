import {
  brandedEmailDocument,
  EMAIL_COLORS,
  EMAIL_DISPLAY_FONT,
  EMAIL_FONT,
  EMAIL_MONO_FONT,
  EMAIL_STYLES,
  emailButtonHtml,
  SENDER_IDENTITY,
} from "@healdesk/catalog";

import type { EmailAudience, RenderedEmail, TemplateContext } from "./types";

/**
 * The blocks every email is written in, and the footer every email ends with.
 *
 * Plain text first (Annex X1.8): a template lists blocks, and both renderings
 * are built from the same list, so the HTML can never say something the text
 * does not. The HTML wears healdesk's look (owner, 1 November 2026: every
 * email branded, Apple-like): the catalog's shell (email-brand.ts) puts the
 * logo at the top, the subject under it as the title, and the blocks below in
 * Apple's type and greys. The title is the one line of the HTML the text part
 * does not repeat, because a text-only reader sees the subject first anyway.
 * The logo is the only thing fetched: one public file, the same URL in every
 * email, so it says nothing about who opened what (email-brand.ts explains).
 * Fonts are the system's own, and Gmail clips a message over 102 KB, so
 * compose refuses anything over 100 KB.
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
  | { type: "links"; items: readonly { text: string; label: string; url: string }[] }
  /**
   * Text with emphasis (lane N4, the ops alert): segments, each bold,
   * underlined or highlighted as it says, already parsed by the caller
   * (lib/ops/alert-wording/markup.ts). `small` prints it muted and small
   * (a reference line). Escaped segment by segment like every value.
   */
  | { type: "rich"; segments: readonly RichSegment[]; small?: boolean; label?: string }
  /** One headline line, large and bold, under a coloured one-word tag (URGENT, TODAY, FYI). */
  | { type: "headline"; tag: { text: string; tone: "red" | "amber" | "grey" }; segments: readonly RichSegment[] }
  /** A highlighted box with a bold label ("Do this first"), its text, and at most one button. */
  | {
      type: "callout";
      label: string;
      segments: readonly RichSegment[];
      action?: { label: string; url: string };
    }
  /** A thin rule with a small label under it ("More detail"). */
  | { type: "divider"; label: string };

/** A run of text and its emphasis, for the `rich`, `headline` and `callout` blocks. */
export type RichSegment = { text: string; bold?: boolean; underline?: boolean; highlight?: boolean };

export type EmailContent = {
  subject: string;
  preheader: string;
  /**
   * The large line under the logo, in the HTML only. Left out, it is the
   * subject, unless the email opens with its own headline (an ops alert).
   * Null for none: a support reply reads as a letter, not a notice.
   */
  title?: string | null;
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

/**
 * What every footer asks a reply to leave out, so hello@ stays free of
 * patient details (X1.9), in the practice's own word: a veterinary practice's
 * people are its clients (ctx.audience), as the email carrying a signed data
 * protection agreement says it (agreementCopyFooter in @healdesk/catalog).
 */
const LEAVE_OUT: Readonly<Record<EmailAudience, string>> = {
  patients: "Please leave out patient details.",
  clients: "Please leave out your clients' details.",
};

/** The line every footer carries (X1.9), by audience. */
export const REPLY_LINES: Readonly<Record<EmailAudience, string>> = {
  patients: `Replies reach the healdesk team. ${LEAVE_OUT.patients}`,
  clients: `Replies reach the healdesk team. ${LEAVE_OUT.clients}`,
};

/**
 * X1.9's line for the one email whose link must not be quoted back to us
 * (O16): where to write instead of replying, and, as every footer says, what
 * to leave out.
 */
export const WRITE_NEW_LINES: Readonly<Record<EmailAudience, string>> = {
  patients: `To reach the healdesk team, write a new email to hello@healdesk.io rather than replying. ${LEAVE_OUT.patients}`,
  clients: `To reach the healdesk team, write a new email to hello@healdesk.io rather than replying. ${LEAVE_OUT.clients}`,
};

/** The reply line a practice whose patients are people reads. */
export const REPLY_LINE = REPLY_LINES.patients;

/** O16's line, as a practice whose patients are people reads it. */
export const WRITE_NEW_LINE = WRITE_NEW_LINES.patients;

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
  const audience: EmailAudience = ctx.audience === "clients" ? "clients" : "patients";
  return [
    ctx.reason,
    replyLine === "write_new" ? WRITE_NEW_LINES[audience] : REPLY_LINES[audience],
    ...(ctx.unsubscribeUrl ? [`Stop these emails: ${ctx.unsubscribeUrl}`] : []),
    SENDER_IDENTITY.postalAddress,
  ];
}

export function compose(content: EmailContent, ctx: TemplateContext): RenderedEmail {
  for (const [field, value] of [
    ["subject", content.subject],
    ["preheader", content.preheader],
    ["title", content.title ?? ""],
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
    case "rich":
      // A label in capitals, so the text part scans too ("WHY IT MATTERS:").
      return labelled(block.label?.toUpperCase(), segmentsText(block.segments));
    case "headline":
      return `${block.tag.text}: ${segmentsText(block.segments)}`;
    case "callout":
      return [
        `${block.label.toUpperCase()}: ${segmentsText(block.segments)}`,
        ...(block.action ? [`${block.action.label}: ${block.action.url}`] : []),
      ].join("\n");
    case "divider":
      return block.label.toUpperCase();
  }
}

/** A label before text, with a space unless the text starts on a new line. */
function labelled(label: string | undefined, text: string): string {
  if (!label) return text;
  return text.startsWith("\n") ? `${label}${text}` : `${label} ${text}`;
}

/** The plain words of segments: the text part carries no markers. */
function segmentsText(segments: readonly RichSegment[]): string {
  return segments.map((s) => s.text).join("");
}

// -----------------------------------------------------------------------------
// HTML
// -----------------------------------------------------------------------------

const INK = EMAIL_COLORS.ink;
const MUTED = EMAIL_COLORS.muted;
const RULE = EMAIL_COLORS.rule;

/** Body copy: the paragraph style the shell sets every block's text in. */
const BODY = EMAIL_STYLES.paragraph;

function renderHtml(content: EmailContent, ctx: TemplateContext): string {
  const footer = footerLines(ctx, content.replyLine)
    .map((line) => `<p class="hd-muted" style="${EMAIL_STYLES.footer}">${footerLineHtml(line)}</p>`)
    .join("\n");
  // The first action is the filled pill; any later one is outlined, so the
  // next step still stands out in an email with several links (X1.3).
  const firstAction = content.blocks.findIndex((block) => block.type === "action");
  return brandedEmailDocument({
    subject: content.subject,
    preheader: content.preheader,
    title: titleOf(content),
    bodyHtml: content.blocks.map((block, i) => blockHtml(block, i === firstAction)).join("\n"),
    footerHtml: footer,
  });
}

/** The title under the logo: the template's, else the subject, unless an alert's headline opens it. */
function titleOf(content: EmailContent): string | null {
  if (content.title !== undefined) return content.title;
  return content.blocks[0]?.type === "headline" ? null : content.subject;
}

function blockHtml(block: Block, isFirstAction: boolean): string {
  switch (block.type) {
    case "paragraph":
      return `<p class="hd-ink" style="${BODY}">${escapeHtml(block.text).replace(/\n/g, "<br>")}</p>`;
    case "facts":
      return factsHtml(block.rows);
    case "action":
      return emailButtonHtml(block.label, block.url, isFirstAction ? "primary" : "secondary");
    case "code":
      // A soft grey box, its ground and ink repainted together in dark mode,
      // so a client's dark mode never leaves light text on a light box.
      return (
        `<pre class="hd-soft hd-ink" style="margin:0 0 18px;padding:14px 16px;background:${EMAIL_COLORS.soft};color:${INK};` +
        `border-radius:12px;font-family:${EMAIL_MONO_FONT};font-size:13px;line-height:20px;white-space:pre-wrap;` +
        `word-break:break-all;">${escapeHtml(block.text)}</pre>`
      );
    case "list":
      return `<ul class="hd-ink" style="${LIST}">${block.items
        .map((item) => `<li style="margin:0 0 6px;">${escapeHtml(item)}</li>`)
        .join("")}</ul>`;
    case "links":
      return `<ul class="hd-ink" style="${LIST}">${block.items
        .map(
          (item) =>
            `<li style="margin:0 0 6px;">${escapeHtml(item.text)} · <a href="${escapeHtml(item.url)}" class="hd-link" ` +
            `style="${EMAIL_STYLES.link}">${escapeHtml(item.label)}</a></li>`,
        )
        .join("")}</ul>`;
    case "rich": {
      const label = block.label
        ? `<strong>${escapeHtml(block.label)}</strong>${segmentsText(block.segments).startsWith("\n") ? "" : " "}`
        : "";
      return block.small
        ? `<p class="hd-muted" style="margin:24px 0 0;font-family:${EMAIL_FONT};font-size:13px;line-height:19px;color:${MUTED};">${label}${segmentsHtml(block.segments)}</p>`
        : `<p class="hd-ink" style="${BODY}">${label}${segmentsHtml(block.segments)}</p>`;
    }
    case "headline":
      // The tag as a small pill, then the line itself, large: an alert's own
      // title, so the shell prints no other (titleOf).
      return (
        `<p style="margin:0 0 12px;font-family:${EMAIL_FONT};"><span style="display:inline-block;background:${TAG_TONES[block.tag.tone]};` +
        `color:#ffffff;font-size:12px;line-height:16px;font-weight:700;letter-spacing:0.08em;padding:4px 11px;border-radius:980px;">` +
        `${escapeHtml(block.tag.text)}</span></p>\n` +
        `<p class="hd-ink" style="margin:0 0 20px;font-family:${EMAIL_DISPLAY_FONT};font-size:24px;line-height:30px;font-weight:700;` +
        `letter-spacing:-0.3px;color:${INK};">${segmentsHtml(block.segments)}</p>`
      );
    case "callout":
      // Its own ground, ink and button colours, kept in dark mode: the shell
      // repaints the page and the one hd-action button, never this box, so
      // its button carries no hd-action class and stays dark on the light box.
      return (
        `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 22px;border-collapse:separate;">` +
        `<tr><td style="padding:16px 20px;background:#fff8c5;color:${INK};border:1px solid #e9c46a;border-radius:14px;">` +
        `<p style="margin:0 0 6px;font-family:${EMAIL_FONT};font-size:15px;line-height:22px;font-weight:700;color:${INK};">${escapeHtml(block.label)}</p>` +
        `<p style="margin:0;font-family:${EMAIL_FONT};font-size:16px;line-height:24px;color:${INK};">${segmentsHtml(block.segments, CALLOUT_HIGHLIGHT)}</p>` +
        (block.action
          ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:14px 0 0;border-collapse:separate;">` +
            `<tr><td style="background:${INK};border-radius:980px;mso-padding-alt:10px 22px;">` +
            `<a href="${escapeHtml(block.action.url)}" style="display:inline-block;padding:10px 22px;font-family:${EMAIL_FONT};` +
            `font-size:15px;line-height:18px;font-weight:600;color:#ffffff !important;background:${INK};text-decoration:none;` +
            `border-radius:980px;">${escapeHtml(block.action.label)}</a></td></tr></table>`
          : "") +
        `</td></tr></table>`
      );
    case "divider":
      return (
        `<hr class="hd-rule" style="height:0;border:0;border-top:1px solid ${RULE};margin:30px 0 14px;">\n` +
        `<p class="hd-muted" style="margin:0 0 14px;font-family:${EMAIL_FONT};font-size:12px;line-height:16px;font-weight:600;` +
        `letter-spacing:0.08em;text-transform:uppercase;color:${MUTED};">${escapeHtml(block.label)}</p>`
      );
  }
}

/** A list in body type, its markers hung in the margin. */
const LIST = `margin:0 0 18px;padding:0 0 0 22px;font-family:${EMAIL_FONT};font-size:17px;line-height:26px;color:${INK};`;

/**
 * Label and value pairs as Apple sets a receipt's details: each label small
 * and grey over its value, the pairs between hairlines. Stacked, not side by
 * side, so a long value (a document hash, a sentence) wraps across the whole
 * column on a phone instead of down a narrow one.
 */
function factsHtml(rows: readonly (readonly [label: string, value: string])[]): string {
  const cells = rows.map(([label, value], i) => {
    const edge = `border-top:1px solid ${RULE};${i === rows.length - 1 ? `border-bottom:1px solid ${RULE};` : ""}`;
    return (
      `<tr><td class="hd-rule" style="padding:12px 0;${edge}">` +
      `<p class="hd-muted" style="margin:0 0 2px;font-family:${EMAIL_FONT};font-size:13px;line-height:18px;color:${MUTED};">${escapeHtml(label)}</p>` +
      `<p class="hd-ink" style="margin:0;font-family:${EMAIL_FONT};font-size:17px;line-height:24px;color:${INK};` +
      `word-break:break-word;overflow-wrap:anywhere;">${escapeHtml(value)}</p>` +
      `</td></tr>`
    );
  });
  return (
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:4px 0 22px;">` +
    `${cells.join("")}</table>`
  );
}

/** The urgency tag's colours: red, amber, grey, each with white text. */
const TAG_TONES = { red: "#cf222e", amber: "#7d4e00", grey: "#57606a" } as const;

/** Inside the yellow box the page's highlight would vanish: a stronger one, dark ink. */
const CALLOUT_HIGHLIGHT = "#ffd54f";

/**
 * Segments as HTML: each escaped first, then wrapped. A highlight carries
 * its own ink, so dark mode never puts light text on the yellow.
 */
function segmentsHtml(segments: readonly RichSegment[], highlight = "#fff3a3"): string {
  return segments
    .map((s) => {
      let html = escapeHtml(s.text).replace(/\n/g, "<br>");
      if (s.highlight) html = `<mark style="background:${highlight};color:${INK};padding:0 2px;">${html}</mark>`;
      if (s.underline) html = `<u>${html}</u>`;
      if (s.bold) html = `<strong>${html}</strong>`;
      return html;
    })
    .join("");
}

/**
 * A footer line as HTML, everything escaped. The stop line's address is
 * printed in full and is its own link, as the text part prints it, so both
 * renderings show the reader exactly where the link goes.
 */
function footerLineHtml(line: string): string {
  const match = /^(Stop these emails: )(https:\/\/\S+|http:\/\/\S+)$/.exec(line);
  if (!match) return escapeHtml(line);
  return (
    `${escapeHtml(match[1]!)}<a href="${escapeHtml(match[2]!)}" class="hd-muted" ` +
    `style="${EMAIL_STYLES.footerLink}word-break:break-all;">${escapeHtml(match[2]!)}</a>`
  );
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
