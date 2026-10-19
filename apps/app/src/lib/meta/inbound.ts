import { metaInboundMessages } from "@/db/schema";
import { identifierRef } from "@/lib/identifier-ref";
import type { TenantTx } from "@/lib/tenant";

import type { MetaPlatform } from "./front-door";

/**
 * Record that a Meta message has been taken in, in the location's tenant,
 * and say whether this is the first time (BD24). Meta delivers every event
 * at least once and redelivers a whole batch when a delivery fails, so
 * without this a message handled before a failure would be answered, and
 * counted, again.
 *
 * The id is never stored: `message_ref` is an HMAC of it under the clinic
 * (lib/identifier-ref.ts), enough to recognise a redelivery and nothing
 * else. Rows are purged after 7 days, well past Meta's redelivery window, by
 * the nightly retention purge (lib/retention/purge.ts), and by
 * billing-housekeeping too when it is switched on. The table grants no UPDATE, so a claim can never
 * be rewritten into another message's.
 */
export async function claimMetaMessage(
  tx: TenantTx,
  platform: MetaPlatform,
  messageId: string,
): Promise<boolean> {
  const claimed = await tx.db
    .insert(metaInboundMessages)
    .values({
      clinicId: tx.clinicId,
      platform,
      messageRef: identifierRef("meta_message", tx.clinicId, messageId),
    })
    .onConflictDoNothing({
      target: [
        metaInboundMessages.clinicId,
        metaInboundMessages.platform,
        metaInboundMessages.messageRef,
      ],
    })
    .returning({ messageRef: metaInboundMessages.messageRef });
  return claimed.length > 0;
}
