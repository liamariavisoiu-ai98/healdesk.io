import PostalMime from "postal-mime";

/**
 * One message, parsed in memory (lane P7g). What this returns lives only for
 * the length of one request: the handler reduces it to facts from fixed lists
 * (facts.ts) and lets it go. Nothing here is logged, stored or returned to a
 * caller outside lib/support/inbound.
 *
 * postal-mime is a pure parser (no I/O, no dependencies); it is bounded here
 * on nesting, header size and part count, and the message is size-capped
 * before it gets here (config.ts MAX_INBOUND_BYTES). Attachments are never
 * opened: only their declared type and decoded size are looked at, to count
 * them by class, and their bytes go with the message.
 */

export type AttachmentClass = "image" | "pdf" | "other";

export type ParsedMail = {
  /** The From address, lower-cased; null when there is none or it is a group. */
  from: string | null;
  subject: string;
  /** Message-ID, In-Reply-To and References, each of MESSAGE_ID's shape (others left out). */
  messageId: string | null;
  inReplyTo: string | null;
  references: string[];
  /** Every header, by lower-case name, each value unfolded (several for a repeated header). */
  headers: Map<string, string[]>;
  /** The top-level Content-Type's media type, lower-cased ("multipart/report"). */
  contentType: string;
  /** The readable body: the text part, or the HTML part with its tags taken out; with the subject, at most MAX_WORDS_CHARS. */
  body: string;
  attachments: { kind: AttachmentClass; bytes: number }[];
};

export class MailParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MailParseError";
  }
}

/** Anything bracketed in a header: a candidate, checked against MESSAGE_ID before it is kept. */
const BRACKETED = /<[^<>\s]{1,998}>/g;

/** The longest message id kept, brackets included (the CHECK on support_messages says the same). */
export const MAX_MESSAGE_ID_CHARS = 250;

/**
 * The one shape of message id kept, stored or sent back in a header: "<local@domain>",
 * printable ASCII with no ":" or "/" (so never a link, which the email lint
 * would refuse in a reply's headers), no quote, space or bracket inside, at
 * most MAX_MESSAGE_ID_CHARS. drizzle/0129's support_messages_email_ids_check
 * holds the same pattern. Gmail's, Outlook's, Apple's and SES's ids all fit.
 */
export const MESSAGE_ID = /^<[A-Za-z0-9!#$%&*+.=?^_{|}~-]{1,200}@[A-Za-z0-9._-]{1,200}>$/;

export function isMessageId(value: string): boolean {
  return value.length <= MAX_MESSAGE_ID_CHARS && MESSAGE_ID.test(value);
}

/** The message ids in a header ("<a@b> <c@d>"), each as written with its brackets; anything of another shape is left out. */
export function messageIds(value: string | null | undefined): string[] {
  if (!value) return [];
  return [...value.matchAll(BRACKETED)]
    .map((m) => m[0])
    .filter(isMessageId)
    .slice(0, 50);
}

function attachmentClass(mimeType: string): AttachmentClass {
  const type = mimeType.toLowerCase();
  if (type.startsWith("image/")) return "image";
  if (type === "application/pdf") return "pdf";
  return "other";
}

function byteLength(content: unknown): number {
  if (content instanceof ArrayBuffer) return content.byteLength;
  if (ArrayBuffer.isView(content)) return content.byteLength;
  if (typeof content === "string") return Buffer.byteLength(content, "utf8");
  return 0;
}

/**
 * The most of the subject and body together that anything reads: the screen,
 * the classifier and the HTML stripper all run on at most this many
 * characters, so the work for one message is bounded whatever its size
 * (a support email's words fit many times over).
 */
export const MAX_WORDS_CHARS = 64 * 1024;

const BLOCK_CLOSERS = new Set(["p", "div", "li", "tr", "h1", "h2", "h3", "h4", "h5", "h6"]);

/** The tag name at `at` (just after "<" or "</"), lower-cased; "" when there is none. */
function tagName(html: string, at: number): string {
  let end = at;
  while (end < html.length && end - at < 16) {
    const c = html.charCodeAt(end);
    const alnum = (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
    if (!alnum) break;
    end += 1;
  }
  return html.slice(at, end).toLowerCase();
}

/** Where the "</name" closing a script or style starts, from `from`; -1 when it never closes. */
function closingTag(html: string, name: string, from: number): number {
  for (let at = html.indexOf("</", from); at !== -1; at = html.indexOf("</", at + 2)) {
    if (tagName(html, at + 2) === name) return at;
  }
  return -1;
}

const ENTITIES: Record<string, string> = { nbsp: " ", amp: "&", lt: "<", gt: ">", "#39": "'", apos: "'", quot: '"' };

/**
 * The HTML part as plain words: tags, scripts and styles out, a few entities
 * decoded. One pass, left to right, with no backtracking pattern, so the time
 * is linear in the input (an unclosed "<script" or a run of "<" no longer
 * costs the square of its length). An unclosed tag or script drops the rest.
 */
export function textOfHtml(html: string): string {
  const out: string[] = [];
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt === -1) {
      out.push(html.slice(i));
      break;
    }
    out.push(html.slice(i, lt));
    const gt = html.indexOf(">", lt + 1);
    // No ">" after this "<": none after any later "<" either. The rest is a tag.
    if (gt === -1) break;
    const closing = html.charCodeAt(lt + 1) === 47; // "/"
    const name = tagName(html, lt + (closing ? 2 : 1));
    if (!closing && (name === "script" || name === "style")) {
      const end = closingTag(html, name, gt + 1);
      if (end === -1) break;
      const after = html.indexOf(">", end + 2);
      if (after === -1) break;
      out.push(" ");
      i = after + 1;
      continue;
    }
    out.push(name === "br" || (closing && BLOCK_CLOSERS.has(name)) ? "\n" : " ");
    i = gt + 1;
  }
  return out.join("").replace(/&(nbsp|amp|lt|gt|#39|apos|quot);/gi, (_, e: string) => ENTITIES[e.toLowerCase()] ?? " ");
}

/** The subject and body cut to MAX_WORDS_CHARS together, the subject first. */
export function boundedWords(subject: string, body: string): { subject: string; body: string } {
  const s = subject.slice(0, MAX_WORDS_CHARS);
  return { subject: s, body: body.slice(0, Math.max(0, MAX_WORDS_CHARS - s.length)) };
}

function topContentType(raw: Uint8Array): string {
  // Only the top-level headers, before the first blank line.
  const head = Buffer.from(raw.subarray(0, Math.min(raw.byteLength, 64 * 1024))).toString("latin1");
  const end = head.search(/\r?\n\r?\n/);
  const block = (end === -1 ? head : head.slice(0, end)).replace(/\r?\n[ \t]+/g, " ");
  const line = /^content-type:\s*([^;\r\n]+)/im.exec(block);
  return (line?.[1] ?? "text/plain").trim().toLowerCase();
}

/** Parse one raw message in memory. Throws MailParseError when it cannot be read. */
export async function parseMail(raw: Uint8Array): Promise<ParsedMail> {
  let email;
  try {
    email = await PostalMime.parse(raw, {
      attachmentEncoding: "arraybuffer",
      maxNestingDepth: 50,
      maxHeadersSize: 512 * 1024,
      maxPartCount: 500,
      maxRfc822NestingDepth: 3,
      maxForwardedAddresses: 500,
    });
  } catch (error) {
    throw new MailParseError(error instanceof Error ? error.name : "unreadable");
  }

  const headers = new Map<string, string[]>();
  for (const h of email.headers ?? []) {
    const key = h.key.toLowerCase();
    headers.set(key, [...(headers.get(key) ?? []), h.value]);
  }
  const from =
    email.from && "address" in email.from && typeof email.from.address === "string" && email.from.address.includes("@")
      ? email.from.address.trim().toLowerCase()
      : null;
  // Bounded before anything reads the words: the HTML is cut before it is
  // stripped, and the subject and body together after.
  const rawBody =
    email.text && email.text.trim()
      ? email.text
      : email.html
        ? textOfHtml(email.html.slice(0, MAX_WORDS_CHARS))
        : "";
  const words = boundedWords(typeof email.subject === "string" ? email.subject : "", rawBody);
  const body = words.body;
  return {
    from,
    subject: words.subject,
    messageId: messageIds(email.messageId)[0] ?? null,
    inReplyTo: messageIds(email.inReplyTo)[0] ?? null,
    references: messageIds(email.references),
    headers,
    contentType: topContentType(raw),
    body,
    attachments: (email.attachments ?? []).map((a) => ({ kind: attachmentClass(a.mimeType ?? ""), bytes: byteLength(a.content) })),
  };
}
