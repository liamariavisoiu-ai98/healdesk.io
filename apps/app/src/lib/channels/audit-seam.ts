import { CHANNELS, type Channel } from "@healdesk/catalog";
import { and, eq, sql } from "drizzle-orm";

import type { Transaction } from "@/db";
import { channelEvents, clinicChannels } from "@/db/schema";
import type { TenantTx } from "@/lib/tenant";

/**
 * "The channel's audit passed": one of the four inputs a channel needs to go
 * live (lib/channels/events.ts; spec, "No channel goes live before its audit
 * passes").
 *
 * THE SEAM. The audit is the practice questions (plan Part G; package B),
 * which do not exist yet. Until they do, only an operator can say a channel's
 * audit passed, through the signed ops envelope's `attestChannelAudit`
 * (lib/ops/api.ts), and it is recorded: a `channel_events` row of kind
 * `audit_passed`, actor `ops`, which only drizzle/0078's definer may insert
 * and nothing may rewrite or erase (drizzle/0044), plus the operator's own
 * audit row. It fails closed: no row, no pass. Nothing records one by
 * default, and no path but the ops operation calls `attestChannelAudit`.
 *
 * When the practice questions land, they replace `channelsWithAuditPassed`
 * with their own result per channel and audit-input version, and record
 * their pass through `recordAuditPassed` with `via: "practice_questions"`
 * (widening the definer's closed list of ways), so the record of every pass
 * stays in one place. An operator's attestation
 * made before then is the record of how that channel was cleared.
 *
 * Tenant plane, no patient data: a channel, a code and who did it.
 */

/** How an `audit_passed` row was recorded. The practice questions add theirs. */
export type AuditPassVia = "ops_attested";

/** The channels whose audit has passed, as `live` reads it. */
export async function channelsWithAuditPassed(
  db: Transaction,
  clinicId: string,
): Promise<Set<Channel>> {
  const rows = await db
    .selectDistinct({ channel: channelEvents.channel })
    .from(channelEvents)
    .where(and(eq(channelEvents.clinicId, clinicId), eq(channelEvents.kind, "audit_passed")));
  return new Set(
    rows
      .map((row) => row.channel)
      .filter((c): c is Channel => c !== null && (CHANNELS as readonly string[]).includes(c)),
  );
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
 * not buy, and a clinic that has left. Recorded through drizzle/0078's
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
