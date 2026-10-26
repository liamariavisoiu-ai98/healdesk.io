import { and, desc, eq, isNotNull, lte, sql } from "drizzle-orm";

import { unsafeDb } from "@/db";
import { supportMessages } from "@/db/schema";
import { linkProblems } from "@/lib/email/lint";

import { isMessageId } from "./parse";

/**
 * Threading for a support reply (lane P7g, the follow-up lane P7c left: "In-
 * Reply-To/References only when an inbound Message-ID exists"). Once a case
 * has an inbound email from its clinic, our reply names it, so the clinic's
 * mail program shows the reply under the email it answers; the subject keeps
 * its "(ref HD-xxxxx)", which is what joins the clinic's answer back to the
 * case (lib/support/inbound/match.ts).
 *
 * The email answered is the newest inbound email on the case that came from
 * the case's own clinic (fields_json fromClinic "yes": its authenticated
 * sign-in) and was RECORDED at or before the approval (created_at, our own
 * clock, never the sender's), so every try of one approved reply carries the
 * same headers: a later email does not change a reply already approved.
 *
 * Threading is a courtesy, never a reason not to send: an id of any other
 * shape than parse.ts's MESSAGE_ID (which the database's CHECK holds too), or
 * headers the email lint would find a problem in, means the reply goes WITHOUT
 * threading headers, and nothing about the id is logged. The ids are not part
 * of the approved hash: they are not words anyone wrote or approved, they come
 * from a row nobody can update, and they never change the text the clinic
 * reads.
 */

export type ThreadingHeaders = { "In-Reply-To": string; References: string };

/** The headers for a reply on this case, approved at `approvedAt`; null when there is nothing safe to thread under. */
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
        sql`${supportMessages.fieldsJson}->>'fromClinic' = 'yes'`,
        lte(supportMessages.createdAt, approvedAt),
      ),
    )
    .orderBy(desc(supportMessages.createdAt), desc(supportMessages.id))
    .limit(1);
  return headersFrom(row?.messageId ?? null, row?.inReplyTo ?? null);
}

/** Pure: the headers for one inbound id and what it replied to; null on any doubt. */
export function headersFrom(messageId: string | null, inReplyTo: string | null): ThreadingHeaders | null {
  if (!messageId || !isMessageId(messageId)) return null;
  const references = inReplyTo && isMessageId(inReplyTo) && inReplyTo !== messageId ? `${inReplyTo} ${messageId}` : messageId;
  const headers: ThreadingHeaders = { "In-Reply-To": messageId, References: references };
  // The sender's own check, run here first: a refusal there would kill the reply.
  if (linkProblems({ subject: "", text: "", html: "", headers }, "support_reply").length > 0) return null;
  return headers;
}
