import { and, desc, eq, isNotNull, lte } from "drizzle-orm";

import { unsafeDb } from "@/db";
import { supportMessages } from "@/db/schema";

/**
 * Threading for a support reply (lane P7g, the follow-up lane P7c left: "In-
 * Reply-To/References only when an inbound Message-ID exists"). Once a case
 * has an inbound email, our reply names it, so the clinic's mail program
 * shows the reply under the email it answers; the subject keeps its
 * "(ref HD-xxxxx)", which is what joins the clinic's answer back to the case
 * (lib/support/inbound/match.ts).
 *
 * The email answered is the newest inbound email on the case received at or
 * before the approval, so every try of one approved reply carries the same
 * headers (a later email does not change a reply already approved). The
 * ids are opaque, each "<...>" with no space or line break, checked again
 * here; sendEmail's safeHeaders refuses a line break in any header as well.
 * They are not part of the approved hash: they are not words anyone wrote or
 * approved, they come from a row the trigger holds fixed, and they never
 * change the text the clinic reads.
 */

const ID = /^<[^<>\s]{1,900}>$/;

export type ThreadingHeaders = { "In-Reply-To": string; References: string };

/** The headers for a reply on this case, approved at `approvedAt`; null when the case has no inbound email. */
export async function threadingHeadersFor(caseId: string, approvedAt: Date): Promise<ThreadingHeaders | null> {
  const [row] = await unsafeDb
    .select({ messageId: supportMessages.messageId, inReplyTo: supportMessages.inReplyTo })
    .from(supportMessages)
    .where(
      and(
        eq(supportMessages.caseId, caseId),
        eq(supportMessages.kind, "email"),
        eq(supportMessages.direction, "in"),
        isNotNull(supportMessages.messageId),
        lte(supportMessages.receivedAt, approvedAt),
      ),
    )
    .orderBy(desc(supportMessages.receivedAt), desc(supportMessages.createdAt))
    .limit(1);
  return headersFrom(row?.messageId ?? null, row?.inReplyTo ?? null);
}

/** Pure: the headers for one inbound id and what it replied to. */
export function headersFrom(messageId: string | null, inReplyTo: string | null): ThreadingHeaders | null {
  if (!messageId || !ID.test(messageId)) return null;
  const references = inReplyTo && ID.test(inReplyTo) && inReplyTo !== messageId ? `${inReplyTo} ${messageId}` : messageId;
  return { "In-Reply-To": messageId, References: references };
}
