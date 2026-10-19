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
 * The audit is the practice questions (lib/engine/practice; plan Part G). A
 * pass records it here, through `recordAuditPassed` with `via:
 * "practice_questions"`, once per channel: a `channel_events` row of kind
 * `audit_passed`, which only drizzle/0079's definer may insert (0080 widened
 * its closed list of ways) and nothing may rewrite or erase (drizzle/0044).
 * An operator can still attest a channel through the signed ops envelope's
 * `attestChannelAudit`, and the operator's approval of the agent script
 * (ops approveAgentConfig) records the same way, `via: "ops_attested"`.
 *
 * What `live` reads (channelsWithAuditPassed) is stricter than the record,
 * because the practice questions gate only a channel's first go-live: a
 * channel the questions passed counts only while practiceQuestionsGate
 * holds open for it, which a channel already live always does, and which a
 * channel not yet live does only while the latest run passed with nothing
 * changed since. A change that fails the questions before go-live holds the
 * channel back until a later run passes; one after go-live never takes it
 * offline. An operator's attestation counts for good. It fails closed: no
 * row, no pass.
 *
 * Tenant plane, no patient data: a channel, a code and who did it.
 */

/** How an `audit_passed` row was recorded. */
export type AuditPassVia = "ops_attested" | "practice_questions";

/** The channels whose audit has passed, as `live` reads it (see the header). */
export async function channelsWithAuditPassed(
  db: Transaction,
  clinicId: string,
): Promise<Set<Channel>> {
  const rows = await db
    .select({ channel: channelEvents.channel, detail: channelEvents.detail })
    .from(channelEvents)
    .where(and(eq(channelEvents.clinicId, clinicId), eq(channelEvents.kind, "audit_passed")));
  const passed = new Set<Channel>();
  for (const row of rows) {
    const channel = row.channel;
    if (channel === null || !(CHANNELS as readonly string[]).includes(channel)) continue;
    if (row.detail?.via === "practice_questions") {
      if ((await practiceQuestionsGate({ db, clinicId }, channel)).open) passed.add(channel);
    } else {
      passed.add(channel);
    }
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
 * Record that `channel`'s audit passed, once: a second attestation of the
 * same channel records nothing and says so. Refuses a channel the clinic did
 * not buy, and a clinic that has left. Recorded through drizzle/0079's
 * definer, app_channel_record_input, because the runtime role may not insert
 * an `audit_passed` row itself; it takes no row lock (a unique index makes
 * the second one a no-op), so the caller can move the channel on afterwards,
 * which locks the clinic's channel rows in their one order. This records the
 * input and nothing else.
 */
export async function recordAuditPassed(
  tx: TenantTx,
  channel: Channel,
  input: { via: AuditPassVia },
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
    sql`select app_channel_record_input(${channel}, 'audit_passed', ${input.via}) as recorded`,
  );
  const recorded = result.rows[0]?.recorded === true;
  if (recorded) {
    tx.audit.record({
      action: "update",
      resourceType: "clinic_channel",
      resourceId: tx.clinicId,
      metadata: { channel, input: "audit_passed", via: input.via },
    });
  }
  return { recorded };
}

/** The operator's attestation, as the ops envelope records it. */
export function attestChannelAudit(tx: TenantTx, channel: Channel): Promise<{ recorded: boolean }> {
  return recordAuditPassed(tx, channel, { via: "ops_attested" });
}
