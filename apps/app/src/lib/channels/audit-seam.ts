import { CHANNELS, type Channel } from "@healdesk/catalog";
import { and, eq, sql } from "drizzle-orm";

import type { Transaction } from "@/db";
import { channelEvents, clinicChannels } from "@/db/schema";
import { practiceQuestionsGate } from "@/lib/engine/practice/store";
import type { TenantTx } from "@/lib/tenant";

/**
 * "The channel's audit passed": one of the four inputs a channel needs to go
 * live (lib/channels/events.ts; spec, "No channel goes live before its audit
 * passes").
 *
 * The audit is the practice questions (lib/engine/practice; plan Part G;
 * spec, Stage 3), and only they pass it: a run passes a channel by itself
 * when every case it asked passed, or an operator passes a run the audit
 * flagged by deciding its review (lib/engine/practice/review.ts, the review
 * queue), which approves that run's own cases at the audit-input version it
 * read. Either way the pass records it here, through `recordAuditPassed`,
 * once per channel: a `channel_events` row of kind `audit_passed` and `via:
 * "practice_questions"`, which only drizzle/0079's definer may insert
 * (0097 narrowed its closed list of ways to that one) and nothing may
 * rewrite or erase (drizzle/0044).
 *
 * There is no other way. Until 19 October 2026 an operator could attest a
 * channel with no run behind it (ops `attestChannelAudit`), and the
 * operator's approval of the agent script (ops `approveAgentConfig`)
 * recorded a passed run with no cases and attested every bought channel,
 * both as `via: "ops_attested"`. Both operations are retired (lib/ops/api.ts,
 * RETIRED_OPERATIONS), the definer refuses that way (0097), and what they
 * wrote no longer counts: the override's run is not read as a run of the
 * questions (store.ts, readPracticeState), and an `ops_attested` row is read
 * as every record is, below, so it passes nothing by itself.
 *
 * What `live` reads (channelsWithAuditPassed) is stricter than the record:
 * a channel's record counts only while practiceQuestionsGate holds open for
 * it, which a channel already live always does, and which a channel not yet
 * live does only while the latest run of the questions passed, with that
 * channel's own result passed and nothing changed since. So the pass that
 * counts is always a run's cases, whoever wrote the row: a channel holding a
 * retired attestation's row goes live only once the questions pass it (the
 * unique index keeps one record per channel, so that pass records nothing
 * beside the old row), and a channel already live is never taken offline. A
 * change that fails the questions before go-live holds the channel back
 * until a later run passes; one after go-live never takes it offline. It
 * fails closed: no record, or no run passed, no pass. drizzle/0097's
 * app_channel_audit_ok is the SQL.
 *
 * Tenant plane, no patient data: a channel, a code and who did it.
 */

/** How an `audit_passed` row is recorded: by the practice questions, and nothing else. */
const VIA = "practice_questions";

/** The channels whose audit has passed, as `live` reads it (see the header). */
export async function channelsWithAuditPassed(
  db: Transaction,
  clinicId: string,
): Promise<Set<Channel>> {
  const rows = await db
    .select({ channel: channelEvents.channel })
    .from(channelEvents)
    .where(and(eq(channelEvents.clinicId, clinicId), eq(channelEvents.kind, "audit_passed")));
  const passed = new Set<Channel>();
  for (const row of rows) {
    const channel = row.channel;
    if (channel === null || !(CHANNELS as readonly string[]).includes(channel)) continue;
    // Whoever wrote the row (a retired attestation's `ops_attested` too),
    // only a run of the questions passes the channel.
    if ((await practiceQuestionsGate({ db, clinicId }, channel)).open) passed.add(channel);
  }
  return passed;
}

export class AuditSeamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuditSeamError";
  }
}

/**
 * Record that the practice questions passed `channel`'s audit, once: a
 * second record of the same channel records nothing and says so. Refuses a
 * channel the clinic did not buy, and a clinic that has left. Recorded
 * through drizzle/0079's definer, app_channel_record_input, because the
 * runtime role may not insert an `audit_passed` row itself; it takes no row
 * lock (a unique index makes the second one a no-op), so the caller can move
 * the channel on afterwards, which locks the clinic's channel rows in their
 * one order. This records the input and nothing else. Its one caller is a
 * pass (lib/engine/practice/store.ts, afterPass).
 */
export async function recordAuditPassed(
  tx: TenantTx,
  channel: Channel,
): Promise<{ recorded: boolean }> {
  if (!(CHANNELS as readonly string[]).includes(channel)) {
    throw new AuditSeamError("That isn't a channel.");
  }
  const [row] = await tx.db
    .select({ channel: clinicChannels.channel })
    .from(clinicChannels)
    .where(and(eq(clinicChannels.clinicId, tx.clinicId), eq(clinicChannels.channel, channel)))
    .limit(1);
  if (!row) throw new AuditSeamError("The clinic didn't buy that channel.");
  const result = await tx.db.execute<{ recorded: boolean }>(
    sql`select app_channel_record_input(${channel}, 'audit_passed', ${VIA}) as recorded`,
  );
  const recorded = result.rows[0]?.recorded === true;
  if (recorded) {
    tx.audit.record({
      action: "update",
      resourceType: "clinic_channel",
      resourceId: tx.clinicId,
      metadata: { channel, input: "audit_passed", via: VIA },
    });
  }
  return { recorded };
}
