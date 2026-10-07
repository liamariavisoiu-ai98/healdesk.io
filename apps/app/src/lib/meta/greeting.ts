import { randomUUID } from "node:crypto";

import { CHAT_CONVERSATION_SILENCE_MS } from "@healdesk/catalog";
import { sql } from "drizzle-orm";

import { identifierRef } from "@/lib/identifier-ref";
import type { TenantTx } from "@/lib/tenant";

import type { MetaPlatform } from "./front-door";

/**
 * Which Meta replies open with the greeting: the first of each conversation,
 * and no later one.
 *
 * BAA 1.3.0 ("What healdesk is not authorised to do") promises every practice
 * that the assistant's "first reply in each conversation says that it is an
 * AI assistant and that the channel is not secure", and metaChannelGreeting()
 * (lib/compliance/disclosure.ts) is the line that says both. It is release
 * gate 4 of 1.3.0 (docs/counsel/agreement-changes.md §12.14, PT-13).
 *
 * ## The rule
 *
 * A conversation is one person's thread on one platform, from their first
 * message until 24 hours pass with no message from them: a message sent more
 * than 24 hours after the newest one before it starts a new conversation
 * (CHAT_CONVERSATION_SILENCE_MS, the owner's decision of 5 October 2026). It
 * is the same 24 hours as Meta's customer-service window, so "a new
 * conversation" and "a window the person has just reopened" are one thing.
 * The first reply in each conversation opens with the greeting, and no later
 * reply in it does. So a reply after the window has closed greets again: the
 * person's message reopened the window, and that is a new conversation.
 *
 * ## The record
 *
 * chat_threads, the per-thread row the usage meter counts conversations by
 * (drizzle/0043): one row per person per platform, keyed by an HMAC of the
 * sender id (lib/identifier-ref.ts) and never the id, holding when they last
 * wrote and which conversation that belongs to. Nothing they wrote goes near
 * it. drizzle/0053 adds `greeted_conversation_id`, the conversation whose
 * first reply has carried the greeting; a reply in any other conversation is
 * a first reply.
 *
 * It records the conversation, not a "greeted" flag, because the message that
 * starts a conversation is not always the one that gets the first reply: a
 * reply that fails to send rolls back with the transaction it is sent in,
 * mark included, and the next reply in that conversation still opens with
 * the greeting. The thread is keyed and touched as the usage meter's design
 * does it (docs/design/stripe-launch-2026-10-05.md, D10, with the
 * identifierRef that drizzle/0050 describes, taken over the channel and the
 * sender id), so once the meter touches it too, a message both touch joins
 * one conversation, and the greeting does not depend on which touched first.
 */

export type MetaConversation = {
  platform: MetaPlatform;
  /** The HMAC of the sender id that keys the thread. Never the id. */
  partyRef: string;
  /** The conversation this message belongs to. */
  conversationId: string;
  /** No reply in this conversation has carried the greeting yet. */
  greet: boolean;
};

/**
 * Record an inbound message on the person's thread and say whether the reply
 * to it is the first of its conversation. One statement, so two messages from
 * the same person arriving together cannot both start a conversation: the
 * second waits on the first's row lock, which the reply's transaction holds
 * until it commits, and then reads the greeting that reply recorded.
 *
 * `sentAt` is when the person sent the message, not when it was read. A
 * message that arrives late or out of order never starts a new conversation
 * and never moves `last_inbound_at` backwards.
 */
export async function openMetaConversation(
  tx: TenantTx,
  input: { platform: MetaPlatform; senderId: string; sentAt: Date },
): Promise<MetaConversation> {
  const partyRef = identifierRef("chat_party", tx.clinicId, `${input.platform}:${input.senderId}`);
  const candidate = randomUUID();
  const silence = `${CHAT_CONVERSATION_SILENCE_MS} milliseconds`;
  // A new conversation when the newest message seen is more than the silence
  // before this one, judged against the row as it stood.
  const fresh = sql`chat_threads.last_inbound_at < excluded.last_inbound_at - ${silence}::interval`;
  const result = await tx.db.execute<{
    conversation_id: string;
    greeted_conversation_id: string | null;
  }>(sql`
    insert into chat_threads
      (clinic_id, channel, party_ref, conversation_id, conversation_started_at, last_inbound_at, conversations_count)
    values
      (${tx.clinicId}, ${input.platform}, ${partyRef}, ${candidate}, ${input.sentAt}, ${input.sentAt}, 1)
    on conflict (clinic_id, channel, party_ref) do update set
      conversation_id = case when ${fresh} then excluded.conversation_id else chat_threads.conversation_id end,
      conversation_started_at = case when ${fresh} then excluded.conversation_started_at else chat_threads.conversation_started_at end,
      conversations_count = chat_threads.conversations_count + case when ${fresh} then 1 else 0 end,
      last_inbound_at = greatest(chat_threads.last_inbound_at, excluded.last_inbound_at)
    returning conversation_id, greeted_conversation_id
  `);
  const row = result.rows[0];
  if (!row) throw new Error("openMetaConversation: the thread row was not returned.");
  return {
    platform: input.platform,
    partyRef,
    conversationId: row.conversation_id,
    greet: row.greeted_conversation_id !== row.conversation_id,
  };
}

/**
 * The reply to this conversation's message carries the greeting. Call it in
 * the transaction the reply is sent in, so a send that throws takes the mark
 * with it.
 */
export async function recordGreeting(tx: TenantTx, conversation: MetaConversation): Promise<void> {
  await tx.db.execute(sql`
    update chat_threads
       set greeted_conversation_id = ${conversation.conversationId}
     where clinic_id = ${tx.clinicId}
       and channel = ${conversation.platform}
       and party_ref = ${conversation.partyRef}
       and conversation_id = ${conversation.conversationId}
  `);
}
