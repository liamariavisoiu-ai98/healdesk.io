import { GOOGLE_CALENDAR_PROVIDER } from "@healdesk/connectors";
import { and, eq } from "drizzle-orm";

import { clinicChannels, providerConnections } from "@/db/schema";
import type { TenantTx } from "@/lib/tenant";

/**
 * Two of the facts switch-rules.ts weighs, read raw in the caller's tenant
 * transaction: whether the calendar is connected and whether phone was bought.
 * Kept apart from switch-resets.ts, which reads the rest through the deposit
 * module, so that module can read these without an import cycle.
 */

/**
 * The location's Google Calendar is connected and working, so the assistant
 * can write a booking itself: a row that is not pending, revoked or in error
 * and carries no broken stamp. `degraded` (Google briefly unreachable) still
 * counts, as it keeps its token and recovers by itself. The same reading of
 * the row as the booking mode's (lib/booking/mode.ts, decideBookingMode),
 * without the mode's other gates, which are not about the calendar.
 */
export async function readCalendarConnected(tx: TenantTx): Promise<boolean> {
  const [row] = await tx.db
    .select({ status: providerConnections.status, brokenAt: providerConnections.brokenAt })
    .from(providerConnections)
    .where(
      and(
        eq(providerConnections.clinicId, tx.clinicId),
        eq(providerConnections.provider, GOOGLE_CALENDAR_PROVIDER),
      ),
    )
    .limit(1);
  return calendarRowConnected(row ?? null);
}

/** The rule over the row, for its table test. */
export function calendarRowConnected(
  row: { status: string; brokenAt: Date | null } | null,
): boolean {
  if (!row) return false;
  return (row.status === "active" || row.status === "degraded") && row.brokenAt === null;
}

/** The clinic bought phone. */
export async function readHasVoice(tx: TenantTx): Promise<boolean> {
  const [row] = await tx.db
    .select({ channel: clinicChannels.channel })
    .from(clinicChannels)
    .where(and(eq(clinicChannels.clinicId, tx.clinicId), eq(clinicChannels.channel, "voice")))
    .limit(1);
  return Boolean(row);
}
