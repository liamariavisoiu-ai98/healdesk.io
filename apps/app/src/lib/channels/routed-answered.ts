import { createHash } from "node:crypto";

import type { Channel } from "@healdesk/catalog";
import { and, eq, gte, lt, sql } from "drizzle-orm";

import type { Transaction } from "@/db";
import { missedContacts, routedInteractions } from "@/db/schema";
import type { ActorContext } from "@/lib/audit";
import type { PassThroughReason } from "@/lib/billing/answering";
import { describeError, log } from "@/lib/log";
import { withTenant } from "@/lib/tenant";

import {
  EXCLUDED_REASONS,
  ROUTED_OUTCOMES,
  type ExcludedReason,
  type MissedOutcome,
  type MissedReason,
  type RoutedOutcome,
  type RoutedReason,
} from "./routed-words";

/**
 * The routed/answered counter (Gate B; drizzle/0139, routed_interactions).
 *
 * Every runtime that answers a patient (the Retell process, lib/voice/
 * retell.ts; website chat, lib/chat/web-chat.ts; the Meta webhook,
 * app/api/webhooks/meta/route.ts) records here each call or conversation
 * routed to AYA for a clinic, and what became of it: answered, excluded by
 * Terms §5 ("What does not count"), or missed. The words are in
 * routed-words.ts. Counts only: the channel, the SHA-256 of the runtime's own
 * id for the call or conversation, closed words and times.
 *
 *   - **Routed** is written `pending` when the call or the message reaches
 *     us (`noteRouted`), so a process that dies before it says what happened
 *     still leaves the row, which the minute sweep then counts as missed
 *     (answer-notices.ts, `no_outcome`).
 *   - **Resolved** (`resolveRouted`) once the runtime knows: inside the
 *     transaction of its own writes where it has one (website chat's answer,
 *     the Meta reply), else in one of its own. An upsert, so the resolution
 *     stands even when the `pending` write was lost, and it only ever moves
 *     the row towards the worse outcome (the trigger holds the same), so a
 *     retry, a redelivered webhook, two processes racing, or a later message
 *     of a conversation never turns a miss into an answer.
 *
 * Nothing here may fail a patient's call or message: the outside-transaction
 * writers log and carry on. The inside ones run in a savepoint, so a counter
 * write that fails never rolls back the answer it counts.
 */

const ACTOR: ActorContext = { type: "service", serviceName: "routed-answered" };

/** The row's opaque reference: never the id itself, so the row joins to nothing that names anyone. */
export function routedRefHash(channel: Channel, ref: string): string {
  return createHash("sha256").update(`healdesk routed v1:${channel}:${ref}`).digest("hex");
}

/** What a runtime knows about one call or conversation. */
export type RoutedResolution =
  | { outcome: "answered"; answeredAt: Date }
  | { outcome: "excluded"; reason: ExcludedReason }
  | {
      outcome: "missed";
      reason: MissedReason;
      answeredAt?: Date | null;
      /** Where it went, for the missed-contact record; "nowhere" unset. */
      wentTo?: MissedOutcome;
      /** ⚠️ PHI. The caller's number, E.164, when known: kept only in missed_contacts. */
      callerPhone?: string | null;
    };

export type MissedContactInput = {
  channel: Channel;
  refHash: string;
  missedAt: Date;
  wentTo: MissedOutcome;
  callerPhone: string | null;
};

const E164 = /^\+[1-9]\d{6,14}$/;

/**
 * The 30-day missed-contact record for one unanswered call or conversation
 * (missed_contacts), once: a retry is the same row. In a savepoint of its
 * own; a refusal is logged by clinic and never by number. Returns whether it
 * inserted.
 */
export async function recordMissedContact(db: Transaction, clinicId: string, input: MissedContactInput): Promise<boolean> {
  try {
    return await db.transaction(async (savepoint) => {
      const rows = await savepoint
        .insert(missedContacts)
        .values({
          clinicId,
          channel: input.channel,
          refHash: input.refHash,
          missedAt: input.missedAt,
          callerPhone: input.callerPhone && E164.test(input.callerPhone) ? input.callerPhone : null,
          outcome: input.wentTo,
          reachedDirectLine: input.wentTo === "direct_line",
        })
        .onConflictDoNothing({ target: [missedContacts.clinicId, missedContacts.channel, missedContacts.refHash] })
        .returning({ id: missedContacts.id });
      return rows.length > 0;
    });
  } catch (error) {
    log.error("missed contact not recorded", { clinicId, channel: input.channel, error: describeError(error) });
    return false;
  }
}

export type RoutedKey = { channel: Channel; ref: string; routedAt: Date };

const RANK: Readonly<Record<RoutedOutcome, number>> = Object.fromEntries(
  ROUTED_OUTCOMES.map((o, i) => [o, i]),
) as Record<RoutedOutcome, number>;

/** The rank the database compares, as SQL: pending 0, excluded 1, answered 2, missed 3. */
function rankSql(column: unknown) {
  return sql`array_position(array['pending','excluded','answered','missed']::text[], ${column})`;
}

/** Whether `next` would move a row at `current` (the trigger's rule, in code). */
export function movesTowardsWorse(current: RoutedOutcome, next: RoutedOutcome): boolean {
  return RANK[next] > RANK[current];
}

/**
 * Where a refusal by the answer gate puts the call or conversation (Terms §5):
 * the clinic's own state or choice does not count; a lapsed vendor's or
 * host's agreement is ours to keep in force, so it is a miss.
 */
export function passThroughResolution(reason: PassThroughReason, wentTo?: MissedOutcome): RoutedResolution {
  if (reason === "host_agreement_lapsed" || reason === "vendor_agreement_lapsed") {
    return { outcome: "missed", reason, ...(wentTo ? { wentTo } : {}) };
  }
  if ((EXCLUDED_REASONS as readonly string[]).includes(reason)) {
    return { outcome: "excluded", reason: reason as ExcludedReason };
  }
  // A reason added to the gate and not here: fail towards the clinic, as Terms §5 reads against us.
  return { outcome: "missed", reason: "error", ...(wentTo ? { wentTo } : {}) };
}

/** Insert the row `pending`, once: a retry is the same row. Inside the caller's transaction. */
export async function recordRouted(db: Transaction, clinicId: string, key: RoutedKey): Promise<void> {
  await db
    .insert(routedInteractions)
    .values({
      clinicId,
      channel: key.channel,
      refHash: routedRefHash(key.channel, key.ref),
      routedAt: key.routedAt,
    })
    .onConflictDoNothing({
      target: [routedInteractions.clinicId, routedInteractions.channel, routedInteractions.refHash],
    });
}

/**
 * Resolve the row, inserting it when the `pending` write never landed, and
 * moving it only towards the worse outcome. Inside the caller's transaction,
 * in a savepoint: a failure here is logged and never rolls back the caller.
 * Returns whether the row now holds this resolution's outcome.
 */
export async function resolveRouted(
  db: Transaction,
  clinicId: string,
  key: RoutedKey,
  resolution: RoutedResolution,
  now: Date = new Date(),
): Promise<boolean> {
  const reason: RoutedReason | null = resolution.outcome === "answered" ? null : resolution.reason;
  const answeredAt = resolution.outcome === "excluded" ? null : (resolution.answeredAt ?? null);
  try {
    return await db.transaction(async (savepoint) => {
      const rows = await savepoint
        .insert(routedInteractions)
        .values({
          clinicId,
          channel: key.channel,
          refHash: routedRefHash(key.channel, key.ref),
          routedAt: key.routedAt,
          outcome: resolution.outcome,
          reason,
          answeredAt,
          resolvedAt: now,
        })
        .onConflictDoUpdate({
          target: [routedInteractions.clinicId, routedInteractions.channel, routedInteractions.refHash],
          set: {
            outcome: sql`excluded.outcome`,
            reason: sql`excluded.reason`,
            // The first answer is kept: a later miss of an answered conversation leaves it.
            answeredAt: sql`coalesce(${routedInteractions.answeredAt}, excluded.answered_at)`,
            resolvedAt: sql`excluded.resolved_at`,
          },
          setWhere: sql`${rankSql(sql`excluded.outcome`)} > ${rankSql(routedInteractions.outcome)}`,
        })
        .returning({ id: routedInteractions.id, routedAt: routedInteractions.routedAt });
      const moved = rows[0];
      // Not answered at all (a late answer was one): the 30-day missed-contact
      // record, once per call or conversation, in a savepoint of its own so a
      // refusal (the BAA gate, a number of the wrong shape) never undoes the count.
      if (moved && resolution.outcome === "missed" && resolution.reason !== "late") {
        await recordMissedContact(savepoint, clinicId, {
          channel: key.channel,
          refHash: routedRefHash(key.channel, key.ref),
          missedAt: moved.routedAt,
          wentTo: resolution.wentTo ?? "nowhere",
          callerPhone: resolution.callerPhone ?? null,
        });
      }
      return moved !== undefined;
    });
  } catch (error) {
    log.error("routed interaction not resolved", {
      clinicId,
      channel: key.channel,
      outcome: resolution.outcome,
      error: describeError(error),
    });
    return false;
  }
}

/** `recordRouted` in a transaction of its own, for a runtime outside one. Never throws. */
export async function noteRouted(clinicId: string, key: RoutedKey): Promise<void> {
  try {
    await withTenant({ clinicId, actor: ACTOR }, (tx) => recordRouted(tx.db, clinicId, key));
  } catch (error) {
    log.error("routed interaction not recorded", { clinicId, channel: key.channel, error: describeError(error) });
  }
}

/** `resolveRouted` in a transaction of its own, for a runtime outside one. Never throws. */
export async function noteResolved(
  clinicId: string,
  key: RoutedKey,
  resolution: RoutedResolution,
  now: Date = new Date(),
): Promise<void> {
  try {
    await withTenant({ clinicId, actor: ACTOR }, (tx) => resolveRouted(tx.db, clinicId, key, resolution, now));
  } catch (error) {
    log.error("routed interaction not resolved", {
      clinicId,
      channel: key.channel,
      outcome: resolution.outcome,
      error: describeError(error),
    });
  }
}

/** A reply's outcome by its timing: answered within `withinMs` of reaching us, else a late miss. */
export function timedAnswer(routedAt: Date, answeredAt: Date, withinMs: number): RoutedResolution {
  return answeredAt.getTime() - routedAt.getTime() <= withinMs
    ? { outcome: "answered", answeredAt }
    : { outcome: "missed", reason: "late", answeredAt };
}

/** The counts for one channel over a period: what was routed, and what became of it. */
export type RoutedCounts = {
  routed: number;
  answered: number;
  excluded: number;
  missed: number;
  pending: number;
};

/**
 * The counter itself: per channel, the calls and conversations routed to AYA
 * for the clinic `tx` is scoped to in [from, to), and what became of them.
 * The portal's Home and the guarantee's check read the same numbers.
 */
export async function routedAnsweredCounts(
  db: Transaction,
  clinicId: string,
  period: { from: Date; to: Date },
): Promise<Record<Channel, RoutedCounts>> {
  const rows = await db
    .select({
      channel: routedInteractions.channel,
      outcome: routedInteractions.outcome,
      count: sql<number>`count(*)::int`,
    })
    .from(routedInteractions)
    .where(
      and(
        eq(routedInteractions.clinicId, clinicId),
        gte(routedInteractions.routedAt, period.from),
        lt(routedInteractions.routedAt, period.to),
      ),
    )
    .groupBy(routedInteractions.channel, routedInteractions.outcome);
  const empty = (): RoutedCounts => ({ routed: 0, answered: 0, excluded: 0, missed: 0, pending: 0 });
  const out: Record<Channel, RoutedCounts> = { voice: empty(), web: empty(), meta: empty() };
  for (const row of rows) {
    const counts = out[row.channel as Channel];
    if (!counts) continue;
    const n = Number(row.count);
    counts.routed += n;
    counts[row.outcome as RoutedOutcome] += n;
  }
  return out;
}
