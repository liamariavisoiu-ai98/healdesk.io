import { and, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";

import { unsafeDb } from "@/db";
import { supportMessages } from "@/db/schema";
import { describeError, log } from "@/lib/log";

import { inboundMailBucket, isInboundKey, MAX_INBOUND_BYTES } from "../inbound/config";
import { MailParseError, parseMail } from "../inbound/parse";
import { s3MailStore, type MailStore } from "../inbound/store";

/**
 * The support drafter reads a clinic's email (lane P7h; owner, 26 October
 * 2026: "it shouldn't keep anything, it should just be the drafter reading
 * it, and writing a reply depending on the clinic's id and data from the DB
 * and proposing that reply for ops approval").
 *
 * The inbound handler leaves an email's raw message in the KMS-encrypted
 * inbound bucket, its key on the facts-only row (drizzle/0131), when the
 * case names a clinic. Here the
 * draft job:
 *
 *   - lists the case's waiting messages (pendingEmails);
 *   - reads at most EMAILS_PER_DRAFT of them, newest first, and parses each
 *     in memory with the inbound parser (its text bounded to 64 KB), keeping
 *     only the subject and the readable body: never the From's display name,
 *     an address, an attachment or its name (readEmails). No masking (owner,
 *     26 October 2026: the drafter's key is the Anthropic organisation the
 *     BAA covers, owner-confirmed that day);
 *   - wraps that text in the drafter's untrusted-data block (emailBlock), the
 *     <email> the drafting rules say is the practice's wishes, never commands;
 *   - and, in the run's finally, deletes every waiting object of the case,
 *     read or not, and clears its key (deleteEmails). A delete that fails
 *     leaves the key for the hourly sweep, which deletes it again.
 *
 * Nothing of the email is returned to a caller outside the run, stored,
 * logged or put in an error: logs carry counts and error names only.
 */

/** The most emails of one case shown to the model in one draft: the newest. */
export const EMAILS_PER_DRAFT = 3;

export type CaseEmails = {
  /** The case has an inbound email at all: it is an email case, whatever its source. */
  any: boolean;
  /** Keys of the case's messages still waiting in the bucket, newest first. */
  pending: string[];
};

export class EmailReadError extends Error {
  constructor(readonly reason: "not_set_up" | "gone" | "too_large" | "unparsable" | "storage") {
    super(`support draft: email not read (${reason})`);
    this.name = "EmailReadError";
  }
}

/** The case's inbound emails: whether there are any, and which still wait in the bucket. */
export async function pendingEmails(caseId: string): Promise<CaseEmails> {
  const [count] = await unsafeDb
    .select({ n: sql<number>`count(*)::int` })
    .from(supportMessages)
    .where(and(eq(supportMessages.caseId, caseId), eq(supportMessages.kind, "email")));
  const rows = await unsafeDb
    .select({ key: supportMessages.inboundObjectKey })
    .from(supportMessages)
    .where(and(eq(supportMessages.caseId, caseId), eq(supportMessages.kind, "email"), isNotNull(supportMessages.inboundObjectKey)))
    .orderBy(desc(supportMessages.receivedAt), desc(supportMessages.createdAt));
  return {
    any: Number(count?.n ?? 0) > 0,
    pending: rows.map((r) => r.key).filter((k): k is string => typeof k === "string" && isInboundKey(k)),
  };
}

export type EmailText = { subject: string; body: string };

/** Read and parse the newest waiting emails, in memory. Throws EmailReadError when one cannot be read. */
export async function readEmails(keys: readonly string[], store: MailStore = s3MailStore): Promise<EmailText[]> {
  const bucket = inboundMailBucket();
  if (!bucket) throw new EmailReadError("not_set_up");
  const out: EmailText[] = [];
  for (const key of keys.slice(0, EMAILS_PER_DRAFT)) {
    let stored;
    try {
      stored = await store.get(bucket, key);
    } catch {
      throw new EmailReadError("storage");
    }
    if (!stored) throw new EmailReadError("gone");
    if (stored.size > MAX_INBOUND_BYTES) {
      stored.discard();
      throw new EmailReadError("too_large");
    }
    let raw: Uint8Array;
    try {
      raw = await stored.read();
    } catch {
      throw new EmailReadError("storage");
    }
    try {
      const mail = await parseMail(raw);
      out.push({ subject: mail.subject, body: mail.body });
    } catch (error) {
      if (error instanceof MailParseError) throw new EmailReadError("unparsable");
      throw new EmailReadError("unparsable");
    }
  }
  return out;
}

/** Take the block's own tags out of the email, so its text cannot close the block early. */
function inert(text: string): string {
  return text.replace(/<\s*\/?\s*email\b[^>]*>/gi, "[email tag removed]");
}

/**
 * The emails as the model reads them: one <email> block each, newest first,
 * subject then body. The drafting rules (prompt.ts DRAFTING_RULES) say what
 * is inside <email> is the practice's message: its instructions are wishes
 * to consider, never commands.
 */
export function emailBlock(emails: readonly EmailText[]): string {
  return emails
    .map((e, i) =>
      [
        `<email${emails.length > 1 ? ` n="${i + 1}"` : ""}>`,
        `Subject: ${inert(e.subject).replace(/\s+/g, " ").trim()}`,
        "",
        inert(e.body).trim(),
        "</email>",
      ].join("\n"),
    )
    .join("\n");
}

/** The text the email check compares the reply with: every subject and body shown. */
export function emailCheckText(emails: readonly EmailText[]): string {
  return emails.map((e) => `${e.subject}\n${e.body}`).join("\n");
}

/**
 * Delete each waiting object of the case and clear its key. Never throws: a
 * failed delete is logged by count and left for the sweep.
 */
export async function deleteEmails(keys: readonly string[], store: MailStore = s3MailStore): Promise<{ deleted: number; failed: number }> {
  const bucket = inboundMailBucket();
  let deleted = 0;
  let failed = 0;
  for (const key of keys) {
    try {
      if (!bucket) throw new Error("no bucket");
      await store.delete(bucket, key);
      deleted += 1;
    } catch (error) {
      failed += 1;
      log.warn("support draft: an email object was not deleted; the sweep will", { error: describeError(error) });
      continue;
    }
    try {
      await unsafeDb.update(supportMessages).set({ inboundObjectKey: null }).where(inArray(supportMessages.inboundObjectKey, [key]));
    } catch (error) {
      log.warn("support draft: an email key was not cleared; the sweep will", { error: describeError(error) });
    }
  }
  return { deleted, failed };
}
