import { randomUUID } from "node:crypto";

import { CHAT_CONVERSATION_SILENCE_MS } from "@healdesk/catalog";
import { sql } from "drizzle-orm";

import type { ChatThreadChannel } from "@/db/schema";
import { identifierRef } from "@/lib/identifier-ref";
import type { TenantTx } from "@/lib/tenant";

/**
 * Which chat conversation a message belongs to (owner decision of 5 October
 * 2026): one person's thread on one channel, from their first message until
 * 24 hours pass with no message from them (CHAT_CONVERSATION_SILENCE_MS).
 * Their next message after that starts a new conversation, with a new id.
 *
 * The conversation id is what a chat conversation is counted by. The caller
 * turns it into the usage reference (`identifierRef("chat_conversation", …)`)
 * that the answer gate asks about and `recordUsage` counts once (R18), so a
 * conversation is one usage row however many messages it carries, and a
 * message withheld at the start of a conversation does not use the
 * conversation up: the count waits for the first message the assistant may
 * answer.
 *
 * The person is never stored. `party_ref` is an HMAC of the channel and the
 * platform's sender id (lib/identifier-ref.ts): a WhatsApp sender id is the
 * sender's phone number, and a plain hash of one can be reversed by hashing
 * every number. No message content goes anywhere near this table.
 */

export type TouchedThread = {
  /** The conversation this message belongs to. */
  conversationId: string;
  /** This message started it: the person's first message, or their first after 24 quiet hours. */
  startsNew: boolean;
};

/**
 * Record an inbound message on the person's thread, in the location's
 * tenant, and say which conversation it belongs to. One statement, so two
 * messages from the same person arriving together cannot both start a
 * conversation: the second waits on the first's row and joins its
 * conversation.
 *
 * `sentAt` is when the person sent it, not when we read it. A message that
 * arrives late or out of order never starts a new conversation and never
 * moves `last_inbound_at` backwards (GREATEST): only a message sent more than
 * 24 hours after the newest one seen starts a new one.
 */
export async function touchChatThread(
  tx: TenantTx,
  input: { channel: ChatThreadChannel; partyId: string; sentAt: Date },
): Promise<TouchedThread> {
  const partyRef = identifierRef("chat_party", tx.clinicId, `${input.channel}:${input.partyId}`);
  const candidate = randomUUID();
  const silence = `${CHAT_CONVERSATION_SILENCE_MS} milliseconds`;
  // A new conversation when the newest message seen is more than the
  // silence before this one. Evaluated against the row as it stood, so every
  // column below makes the same decision.
  const fresh = sql`chat_threads.last_inbound_at < excluded.last_inbound_at - ${silence}::interval`;
  const result = await tx.db.execute<{ conversation_id: string }>(sql`
    insert into chat_threads
      (clinic_id, channel, party_ref, conversation_id, conversation_started_at, last_inbound_at, conversations_count)
    values
      (${tx.clinicId}, ${input.channel}, ${partyRef}, ${candidate}, ${input.sentAt}, ${input.sentAt}, 1)
    on conflict (clinic_id, channel, party_ref) do update set
      conversation_id = case when ${fresh} then excluded.conversation_id else chat_threads.conversation_id end,
      conversation_started_at = case when ${fresh} then excluded.conversation_started_at else chat_threads.conversation_started_at end,
      conversations_count = chat_threads.conversations_count + case when ${fresh} then 1 else 0 end,
      last_inbound_at = greatest(chat_threads.last_inbound_at, excluded.last_inbound_at)
    returning conversation_id
  `);
  const conversationId = result.rows[0]?.conversation_id;
  if (!conversationId) throw new Error("touchChatThread: the thread row was not returned.");
  return { conversationId, startsNew: conversationId === candidate };
}
