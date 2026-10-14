import { CHANNELS, type Channel } from "@healdesk/catalog";
import { and, eq } from "drizzle-orm";

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
 * `audit_passed`, actor `ops`, which the runtime role can neither rewrite nor
 * erase (drizzle/0044), plus the operator's own audit row. It fails closed:
 * no row, no pass. Nothing records one by default, and no path but the ops
 * operation calls `attestChannelAudit`.
 *
 * When the practice questions land, they replace `channelsWithAuditPassed`
 * with their own result per channel and audit-input version, and record
 * their pass through `recordAuditPassed` with `via: "practice_questions"`,
 * so the record of every pass stays in one place. An operator's attestation
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
 * not buy. The caller then asks lib/channels/events.ts whether the channel
 * can go live; this records the input and nothing else.
 */
export async function recordAuditPassed(
  tx: TenantTx,
  channel: Channel,
  input: { via: AuditPassVia; actor: "ops" | "system"; now?: Date },
): Promise<{ recorded: boolean }> {
  if (!(CHANNELS as readonly string[]).includes(channel)) {
    throw new AuditSeamError("That isn't a channel.");
  }
  const now = input.now ?? new Date();
  // The channel's own row, locked: two attestations at once record one pass.
  const [row] = await tx.db
    .select({ channel: clinicChannels.channel })
    .from(clinicChannels)
    .where(and(eq(clinicChannels.clinicId, tx.clinicId), eq(clinicChannels.channel, channel)))
    .for("update");
  if (!row) throw new AuditSeamError("The clinic didn't buy that channel.");
  if ((await channelsWithAuditPassed(tx.db, tx.clinicId)).has(channel)) return { recorded: false };
  await tx.db.insert(channelEvents).values({
    clinicId: tx.clinicId,
    channel,
    kind: "audit_passed",
    actor: input.actor,
    detail: { via: input.via },
    occurredAt: now,
  });
  tx.audit.record({
    action: "update",
    resourceType: "clinic_channel",
    resourceId: tx.clinicId,
    metadata: { channel, input: "audit_passed", via: input.via },
  });
  return { recorded: true };
}

/** The operator's attestation, as the ops envelope records it. */
export function attestChannelAudit(
  tx: TenantTx,
  channel: Channel,
  now?: Date,
): Promise<{ recorded: boolean }> {
  return recordAuditPassed(tx, channel, { via: "ops_attested", actor: "ops", now });
}
