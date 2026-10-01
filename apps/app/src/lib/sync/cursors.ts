// PHASE TWO: attribution (POS/EMR read-back, sync, reconciliation and the
// monthly revenue report). Not part of v1: kept, but fenced out of v1 flows,
// screens, emails and copy (HEALDESK_PHASE_TWO_ATTRIBUTION, lib/env.ts).
import { and, desc, eq, inArray, isNotNull } from "drizzle-orm";

import type { Transaction } from "@/db";
import { syncRuns } from "@/db/schema";

/**
 * Where the last run got to, and where the next one should start.
 *
 * The high-water mark is stored per (connection, resource) rather than per
 * connection, because a platform can serve appointments happily while its sales
 * endpoint is rate-limited into next week. One shared cursor would drag the
 * healthy resource back every time the sick one stalled.
 */

export type SyncResource = "appointments" | "sales" | "contacts";

export const SYNC_RESOURCES: readonly SyncResource[] = [
  // Contacts first, always. Appointments carry a NOT NULL contact_id, so an
  // appointment whose contact hasn't landed yet is skipped — syncing in this
  // order means that only happens for people created mid-run.
  "contacts",
  "appointments",
  "sales",
];

/**
 * How far back to re-read on every run.
 *
 * Not paranoia. Booking platforms let staff edit yesterday's appointment, mark
 * a check-in retrospectively, or refund a sale a week later, and those edits
 * carry the ORIGINAL date — so a cursor that trusts "nothing before here can
 * change" permanently misses them. Re-reading two days costs a page or two and
 * catches the overwhelming majority; upserts make the overlap free.
 */
export const OVERLAP_MS = 2 * 24 * 60 * 60 * 1000;

/**
 * How far back a first-ever sync reaches.
 *
 * 90 days, not "everything". A first sync that tries to pull five years of
 * history hits the rate limit, takes days, and the clinic's first report is
 * late — and we only ever report on the current month anyway. Deeper history is
 * a deliberate backfill, not the default.
 */
export const INITIAL_LOOKBACK_MS = 90 * 24 * 60 * 60 * 1000;

export async function lastCursor(
  tx: Transaction,
  connectionId: string,
  resource: SyncResource,
): Promise<Date | null> {
  const [row] = await tx
    .select({ cursorAt: syncRuns.cursorAt })
    .from(syncRuns)
    .where(
      and(
        eq(syncRuns.connectionId, connectionId),
        eq(syncRuns.resource, resource),
        // A failed run's cursor is meaningless — it may have written half a
        // window. Only runs that finished ok or partial advance the mark.
        inArray(syncRuns.status, ["ok", "partial"]),
        isNotNull(syncRuns.cursorAt),
      ),
    )
    .orderBy(desc(syncRuns.cursorAt))
    .limit(1);

  return row?.cursorAt ?? null;
}

/**
 * The window to ask the platform for.
 *
 * `to` is `now`, never a fixed end — asking for the future returns nothing on
 * some platforms and errors on others.
 */
export function windowFor(
  cursor: Date | null,
  now: Date,
): { from: Date; to: Date } {
  const from = cursor
    ? new Date(cursor.getTime() - OVERLAP_MS)
    : new Date(now.getTime() - INITIAL_LOOKBACK_MS);

  return { from, to: now };
}

/**
 * Where to set the mark after a successful run.
 *
 * Deliberately the window end and not "the newest record we saw". Using the
 * newest record means an empty window never advances the cursor, so a quiet
 * clinic re-reads the same widening range forever until the request times out.
 */
export function advanceTo(window: { to: Date }): Date {
  return window.to;
}
