import type { Channel } from "@healdesk/catalog";
import { and, count, eq, gte, isNotNull } from "drizzle-orm";

import { clinics, conversations } from "@/db/schema";
import type { ActorContext } from "@/lib/audit";
import { readGoLiveCheck } from "@/lib/channels/events";
import type { ChannelState } from "@/lib/channels/state";
import { isUndeliverable } from "@/lib/email/events";
import type { PracticeState } from "@/lib/engine/practice/state";
import { readPracticeState } from "@/lib/engine/practice/store";
import { goLiveSummary, type GoLiveSummary } from "@/lib/onboarding/go-live";
import { readClaims, readQuietChannels, type Claims } from "@/lib/reporting/claims";
import { withTenant, type TenantTx } from "@/lib/tenant";
import { countWebsiteChanges } from "@/lib/website/store";

import { readWaitingCounts, type WaitingCounts } from "./bookings";
import { readAnswerAttention, type AnswerAttention } from "./missed-contacts";
import { readOpenPatientRequests, type OpenPatientRequest } from "./patient-requests";

/**
 * The facts Home reads beyond the setup state, in one tenant transaction:
 * whether the clinic's one address has bounced (Annex X3), whether its
 * Stripe account was disconnected and nothing replaced it, where its
 * practice questions stand (lib/engine/practice), and where go-live stands,
 * for the tracker's "Going live" (lib/onboarding/go-live.ts). After go-live,
 * also the "Waiting for you" counts (lib/portal/bookings.ts), the week's
 * claims (lib/reporting/claims.ts) and the live channels that have gone
 * quiet. And, before go-live and after, each patient's request passed to the
 * practice that nobody has marked received (L32), by its id and its reply-by
 * day only: the request opens on its own page, behind the step-up. Counts,
 * ids, days and the practice's own account only: none of it names a patient,
 * so Home needs no step-up.
 */
export type HomeFacts = {
  addressUndeliverable: boolean;
  paymentAccountDisconnected: boolean;
  /** The drift list's changes nobody has confirmed or ignored (lib/website). */
  websiteChanges: number;
  /** Where the practice questions stand: the tracker's last two stages and "double-checking". */
  practice: PracticeState;
  /** Where go-live stands, in the practice's words: the tracker's "Going live". Null for no clinic. */
  goLive: GoLiveSummary | null;
  /** After go-live: what is waiting on Bookings, as counts. Null before. */
  waiting: WaitingCounts | null;
  /** After go-live: the last seven days' claims. Null before. */
  week: Claims | null;
  /** After go-live: live channels that have heard nothing for a week (QUIET_CHANNEL_DAYS). */
  quietChannels: Channel[];
  /** Patients' requests passed to the practice and not yet marked received (L32): ids and days. */
  patientRequests: OpenPatientRequest[];
  /** An open outage, and the missed calls and chats nobody has called back (missed_contacts): counts only. */
  answering: AnswerAttention;
  /**
   * After go-live: calls in the last seven days that ended unexpectedly
   * (lib/voice/ended-early.ts). A count and a pointer to Conversations, where
   * each is marked; nobody is named here. 0 before go-live.
   */
  endedEarly: number;
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
      // The drift list (plan Part F3, "Changes on your website"): the
      // changes still waiting, each only while Knowledge does not say it.
      websiteChanges: await countWebsiteChanges(tx),
      practice: await readPracticeState(tx),
      goLive: await readGoLiveSummary(tx),
      waiting: live ? await readWaitingCounts(tx, now) : null,
      week: live
        ? await readClaims(
            tx,
            { from: new Date(now.getTime() - HOME_WEEK_DAYS * 86_400_000), to: now },
            "home",
          )
        : null,
      quietChannels: live ? await readQuietChannels(tx, channels, now) : [],
      patientRequests: await readOpenPatientRequests(tx),
      answering: await readAnswerAttention(tx, now),
      endedEarly: live ? await countEndedEarly(tx, new Date(now.getTime() - HOME_WEEK_DAYS * 86_400_000)) : 0,
    };
  });
}

/** Calls flagged as ended early since `since`, by when they started. */
export async function countEndedEarly(tx: TenantTx, since: Date): Promise<number> {
  const [row] = await tx.db
    .select({ n: count() })
    .from(conversations)
    .where(
      and(
        eq(conversations.clinicId, tx.clinicId),
        isNotNull(conversations.endedEarlyReason),
        gte(conversations.startedAt, since),
      ),
    );
  return Number(row?.n ?? 0);
}

/**
 * The same pointer for a clinic that has started to leave, whose Home shows
 * nothing else: the BAA's duty to pass a patient's request on lasts while
 * healdesk holds it.
 */
export async function readHomePatientRequests(input: {
  clinicId: string;
  actor: ActorContext;
}): Promise<OpenPatientRequest[]> {
  return withTenant({ clinicId: input.clinicId, actor: input.actor }, (tx) =>
    readOpenPatientRequests(tx),
  );
}

/** What go-live waits on, as Home says it (lib/onboarding/go-live.ts, goLiveSummary). */
async function readGoLiveSummary(tx: TenantTx): Promise<GoLiveSummary | null> {
  const read = await readGoLiveCheck(tx);
  return read ? goLiveSummary(read.production, read.check) : null;
}
