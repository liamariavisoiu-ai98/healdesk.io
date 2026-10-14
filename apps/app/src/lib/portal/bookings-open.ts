import { eq, sql } from "drizzle-orm";

import { bookingRequests } from "@/db/schema";
import type { ActorContext } from "@/lib/audit";
import { withTenant } from "@/lib/tenant";

/**
 * Whether the menu links Bookings (lib/portal/nav.ts): once any channel has
 * gone live (clinic_channels.live_at, which package WP1's channel events
 * write), or once a booking request exists, whichever comes first. A count,
 * never a row: the shell reads no patient.
 */
export async function bookingsOpen(input: {
  clinicId: string;
  actor: ActorContext;
  anyChannelLive: boolean;
}): Promise<boolean> {
  if (input.anyChannelLive) return true;
  return withTenant({ clinicId: input.clinicId, actor: input.actor }, async (tx) => {
    const [row] = await tx.db
      .select({ one: sql<number>`1` })
      .from(bookingRequests)
      .where(eq(bookingRequests.clinicId, tx.clinicId))
      .limit(1);
    return row !== undefined;
  });
}
