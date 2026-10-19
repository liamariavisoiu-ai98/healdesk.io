import type { Channel } from "@healdesk/catalog";
import { eq } from "drizzle-orm";

import { clinics } from "@/db/schema";
import type { ActorContext } from "@/lib/audit";
import type { ChannelState } from "@/lib/channels/state";
import { isUndeliverable } from "@/lib/email/events";
import type { PracticeState } from "@/lib/engine/practice/state";
import { readPracticeState } from "@/lib/engine/practice/store";
import { readClaims, readQuietChannels, type Claims } from "@/lib/reporting/claims";
import { withTenant } from "@/lib/tenant";

import { readWaitingCounts, type WaitingCounts } from "./bookings";

/**
 * The facts Home reads beyond the setup state, in one tenant transaction:
 * whether the clinic's one address has bounced (Annex X3), whether its
 * Stripe account was disconnected and nothing replaced it, and where its
 * practice questions stand (lib/engine/practice). After go-live, also the
 * "Waiting for you" counts (lib/portal/bookings.ts), the week's claims
 * (lib/reporting/claims.ts) and the live channels that have gone quiet.
 * Counts and the practice's own account only: none of it names a patient,
 * so Home needs no step-up.
 */
export type HomeFacts = {
  addressUndeliverable: boolean;
  paymentAccountDisconnected: boolean;
  /** The drift check's unconfirmed website changes (M7); always 0 until it exists. */
  websiteChanges: number;
  /** Where the practice questions stand: the tracker's last two stages and "double-checking". */
  practice: PracticeState;
  /** After go-live: what is waiting on Bookings, as counts. Null before. */
  waiting: WaitingCounts | null;
  /** After go-live: the last seven days' claims. Null before. */
  week: Claims | null;
  /** After go-live: live channels that have heard nothing for a week (QUIET_CHANNEL_DAYS). */
  quietChannels: Channel[];
};

/** Home's week: the seven days to now, the stretch the spec's "this week" covers on any day. */
export const HOME_WEEK_DAYS = 7;

export async function readHomeFacts(input: {
  clinicId: string;
  address: string | null;
  actor: ActorContext;
  /** The clinic's channels as the page read them; after go-live, Home reads its numbers. */
  channels?: readonly ChannelState[];
  now?: Date;
}): Promise<HomeFacts> {
  const now = input.now ?? new Date();
  const channels = input.channels ?? [];
  const live = channels.some((c) => c.liveAt !== null);
  return withTenant({ clinicId: input.clinicId, actor: input.actor }, async (tx) => {
    const undeliverable = input.address ? await isUndeliverable(tx, input.address) : false;
    const [clinic] = await tx.db
      .select({
        accountId: clinics.stripeConnectAccountId,
        disconnectedAt: clinics.stripeConnectDisconnectedAt,
      })
      .from(clinics)
      .where(eq(clinics.id, tx.clinicId))
      .limit(1);
    return {
      addressUndeliverable: undeliverable,
      paymentAccountDisconnected: Boolean(clinic && !clinic.accountId && clinic.disconnectedAt),
      // M7 seam: the drift list (plan Part F3, "Changes on your website") is
      // read here once it exists.
      websiteChanges: 0,
      practice: await readPracticeState(tx),
      waiting: live ? await readWaitingCounts(tx, now) : null,
      week: live
        ? await readClaims(
            tx,
            { from: new Date(now.getTime() - HOME_WEEK_DAYS * 86_400_000), to: now },
            "home",
          )
        : null,
      quietChannels: live ? await readQuietChannels(tx, channels, now) : [],
    };
  });
}
