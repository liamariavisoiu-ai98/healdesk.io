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
  /** Message-ID, In-Reply-To and References as opaque ids, each "<...>" with no space. */
  messageId: string | null;
  inReplyTo: string | null;
  references: string[];
  /** Every header, by lower-case name, each value unfolded (several for a repeated header). */
  headers: Map<string, string[]>;
  /** The top-level Content-Type's media type, lower-cased ("multipart/report"). */
  contentType: string;
  /** The readable body: the text part, or the HTML part with its tags taken out. */
  body: string;
  attachments: { kind: AttachmentClass; bytes: number }[];
};

export class MailParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MailParseError";
  }
}

const ID = /<[^<>\s]{1,900}>/g;

/** The opaque ids in a header ("<a@b> <c@d>"), each kept as written with its brackets. */
export function messageIds(value: string | null | undefined): string[] {
  if (!value) return [];
  return [...value.matchAll(ID)].map((m) => m[0]).slice(0, 50);
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

/** The HTML part as plain words: tags, scripts and styles out, entities left to the screen. */
export function textOfHtml(html: string): string {
  return html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"');
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
  const body = email.text && email.text.trim() ? email.text : email.html ? textOfHtml(email.html) : "";
  return {
    from,
    subject: typeof email.subject === "string" ? email.subject : "",
    messageId: messageIds(email.messageId)[0] ?? null,
    inReplyTo: messageIds(email.inReplyTo)[0] ?? null,
    references: messageIds(email.references),
    headers,
    contentType: topContentType(raw),
    body,
    attachments: (email.attachments ?? []).map((a) => ({ kind: attachmentClass(a.mimeType ?? ""), bytes: byteLength(a.content) })),
  };
}
