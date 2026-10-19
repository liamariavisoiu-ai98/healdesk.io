import { CHANNELS, type Channel } from "@healdesk/catalog";
import { and, count, eq, gte, inArray, isNull, lt, or, sql } from "drizzle-orm";

import {
  appointments,
  bookingRequests,
  channelEvents,
  chatThreads,
  clinicChannels,
  conversations,
  depositPayments,
  usageEvents,
} from "@/db/schema";
import { bookingModeFor, effectiveOf } from "@/lib/booking/mode";
import type { ChannelState } from "@/lib/channels/state";
import type { TenantTx } from "@/lib/tenant";

import type { ClaimsPayload } from "./claim-words";

/**
 * The claims function (plan Part F1 and Annex X5's L13 and L14): what v1 may
 * say AYA did over a period, read once, here, for Home's week, the daily
 * summary and the weekly recap alike, so the three can never disagree.
 *
 * What it may claim is fixed by the spec ("What v1 can prove, and what it
 * cannot") and CLAUDE.md's "Claims and copy": conversations handled, the
 * appointments AYA booked (and, while bookings are requests, the requests
 * she took and how many the team confirmed), calls answered that would have
 * rung out, deposits collected, and booked value: bookings times the
 * clinic's own listed prices. Never revenue, never "collected" except as
 * "deposits collected", and nothing of attribution, which is phase two. The
 * words are lib/reporting/claim-words.ts's; this file only counts.
 *
 * Each figure, and where it comes from:
 *
 *   - **Conversations handled**, per bought channel. Phone and website chat:
 *     the `conversations` row the voice ingest and web chat write for every
 *     call and chat; a call only where AYA's opening line played
 *     (`disclosure_played_at`, ANSWERED_CALL), because one she never spoke
 *     on, put through to the clinic or closed by the pass-through or by a
 *     start that failed, is recorded but was not handled by her. Instagram,
 *     Messenger and WhatsApp keep no conversation row (they carry nothing
 *     clinical), so theirs is the usage ledger's count of Meta conversations
 *     AYA was allowed to answer (usage_events, source `meta`: one row per
 *     conversation, the 24-hour rule's, R18).
 *   - **Calls answered that would have rung out**, in the phone row: calls
 *     AYA answered whose `recovery_reason`, decided at ingestion from the
 *     clinic's coverage mode and hours (lib/voice/ingest.ts classifyRecovery),
 *     says nobody at the clinic would have taken them. Never
 *     `missed_call_callback`: v1 places no calls. Null, "unavailable", for a
 *     clinic without phone, rather than a zero that would claim we looked.
 *   - **Booking requests taken, and confirmed by the team; appointments booked
 *     by AYA.** The cohort is the booking requests AYA took in the period
 *     (`source` `assistant`; a message left on the website's contact form
 *     while she was not answering is the practice's, not hers, and is
 *     never counted here): those AYA booked herself (their appointment's `booking_origin` is
 *     `assistant`) are "booked by AYA"; every other one is a request taken,
 *     and "confirmed" counts those of them the team has confirmed so far, so
 *     it never exceeds the requests it is out of. `bookingMode` says which
 *     line leads: "requests" while the clinic's bookings are requests
 *     (lib/booking/mode.ts), "direct" once AYA books.
 *   - **Booked value**: every appointment that cohort produced, at the
 *     clinic's listed price snapshotted when it was booked
 *     (appointments.listed_price_*, drizzle/0087). Exact prices as they are,
 *     "from" and range prices at their low end; a per-unit price is counted
 *     apart and never multiplied into the total; a booking with no listed
 *     price is counted apart too. Never called revenue.
 *   - **Deposits collected**: payments the clinic's own payment links took
 *     (deposit_payments `paid`, by when they were paid). Phone books and
 *     flags a deposit, never collects one, so this is website chat and Meta.
 *   - **Urgent reports and handovers**, the daily summary's "escalated":
 *     calls and web chats the urgent screen matched, and those that asked
 *     for a person otherwise.
 *
 * Counts only: nothing here reads a name, a number, a time or a service, so
 * Home shows it without the passkey step-up. Each read writes one audit row
 * with its purpose and the count, as the weekly recap always did.
 *
 * A location bills to its billing clinic, and the usage ledger's rows live
 * on the billing clinic's tenant, so a location with a billing clinic of its
 * own sees no Meta count here; locations are not sold yet (LOCATION_CLINICS_
 * READY), and this is where that changes when they are.
 */

/** Why a claims read happened: the audit row's purpose. */
export type ClaimsPurpose = "home" | "daily_summary" | "weekly_recap";

export type ChannelClaims = {
  channel: Channel;
  handled: number;
};

export type Claims = {
  /** The period, half open: [from, to). */
  from: Date;
  to: Date;
  /** The clinic's bought channels, in the catalog's order, each with what it handled. */
  channels: ChannelClaims[];
  handled: number;
  /** Calls answered that would have rung out; null where the clinic has no phone channel. */
  rangOut: number | null;
  /** "requests" while bookings are requests the team confirms; "direct" once AYA books. */
  bookingMode: "requests" | "direct";
  requestsTaken: number;
  requestsConfirmed: number;
  bookedByAya: number;
  bookedValue: {
    /** Exact prices, and the low end of "from" and range prices, summed. */
    cents: number;
    /** The bookings that total is made of. */
    priced: number;
    /** Bookings at a per-unit price: counted, never multiplied in. */
    perUnit: number;
    /** Bookings with no listed price for what was booked. */
    unpriced: number;
  };
  depositsCollected: { count: number; cents: number };
  urgent: number;
  handovers: number;
};

/**
 * The reasons that mean a call reached AYA because nobody at the clinic could
 * take it (conversations.recoveryReason). Not `missed_call_callback`: v1
 * places no calls, so that legacy value is never a call answered.
 */
export const RANG_OUT_REASONS = ["after_hours", "line_busy", "rang_unanswered"] as const;
const RANG_OUT_LIST = sql.raw(RANG_OUT_REASONS.map((r) => `'${r}'`).join(", "));

/**
 * A call AYA answered: her opening line played. The ingest records every
 * call, and leaves one without it unbilled and unrecovered
 * (lib/voice/ingest.ts); the claims count only these.
 */
// AYA spoke: her opening line played, or she said the fixed urgent reply
// (lib/voice/ingest.ts, ayaSpoke).
const ANSWERED_CALL = sql`(${conversations.channel} = 'voice' and (${conversations.disclosurePlayedAt} is not null or ${conversations.urgent}))`;

/** The claims over [from, to) for the transaction's clinic. */
export async function readClaims(
  tx: TenantTx,
  period: { from: Date; to: Date },
  purpose: ClaimsPurpose,
): Promise<Claims> {
  const { from, to } = period;
  const c = tx.clinicId;
  const bought = await boughtChannels(tx);

  const inPeriod = and(
    eq(conversations.clinicId, c),
    gte(conversations.startedAt, from),
    lt(conversations.startedAt, to),
  );
  const [talk] = await tx.db
    .select({
      voice: sql<number>`count(*) filter (where ${ANSWERED_CALL})::int`,
      web: sql<number>`count(*) filter (where ${conversations.channel} = 'web_chat')::int`,
      rangOut: sql<number>`count(*) filter (where ${ANSWERED_CALL}
        and ${conversations.recoveryReason} in (${RANG_OUT_LIST}))::int`,
      urgent: sql<number>`count(*) filter (where ${conversations.urgent})::int`,
      handovers: sql<number>`count(*) filter (where not ${conversations.urgent}
        and ${conversations.outcome} = 'escalated_to_human')::int`,
    })
    .from(conversations)
    .where(inPeriod);
  const [meta] = await tx.db
    .select({ n: count() })
    .from(usageEvents)
    .where(
      and(
        eq(usageEvents.clinicId, c),
        eq(usageEvents.locationClinicId, c),
        eq(usageEvents.source, "meta"),
        gte(usageEvents.occurredAt, from),
        lt(usageEvents.occurredAt, to),
      ),
    );

  const handledBy: Record<Channel, number> = {
    voice: talk?.voice ?? 0,
    web: talk?.web ?? 0,
    meta: meta?.n ?? 0,
  };
  const channels = CHANNELS.filter((ch) => bought.has(ch)).map((ch) => ({
    channel: ch,
    handled: handledBy[ch],
  }));
  const handled = channels.reduce((sum, ch) => sum + ch.handled, 0);

  const ayaBooked = sql`${appointments.bookingOrigin} = 'assistant'`;
  const notAyaBooked = sql`${appointments.bookingOrigin} is distinct from 'assistant'`;
  const kind = appointments.listedPriceKind;
  const [book] = await tx.db
    .select({
      taken: sql<number>`count(*) filter (where ${notAyaBooked})::int`,
      confirmed: sql<number>`count(*) filter (where ${notAyaBooked} and ${bookingRequests.status} = 'confirmed')::int`,
      bookedByAya: sql<number>`count(*) filter (where ${ayaBooked})::int`,
      valueCents: sql<number>`coalesce(sum(${appointments.listedPriceCents}) filter (where ${kind} in ('exact', 'from', 'range')), 0)::int`,
      priced: sql<number>`count(${appointments.id}) filter (where ${kind} in ('exact', 'from', 'range'))::int`,
      perUnit: sql<number>`count(${appointments.id}) filter (where ${kind} = 'per_unit')::int`,
      unpriced: sql<number>`count(${appointments.id}) filter (where ${kind} is null)::int`,
    })
    .from(bookingRequests)
    .leftJoin(
      appointments,
      and(
        eq(appointments.id, bookingRequests.appointmentId),
        eq(appointments.clinicId, bookingRequests.clinicId),
      ),
    )
    .where(
      and(
        eq(bookingRequests.clinicId, c),
        eq(bookingRequests.source, "assistant"),
        gte(bookingRequests.createdAt, from),
        lt(bookingRequests.createdAt, to),
      ),
    );

  const [deposits] = await tx.db
    .select({
      n: sql<number>`count(*)::int`,
      cents: sql<number>`coalesce(sum(${depositPayments.amountCents}), 0)::int`,
    })
    .from(depositPayments)
    .where(
      and(
        eq(depositPayments.clinicId, c),
        eq(depositPayments.status, "paid"),
        gte(depositPayments.paidAt, from),
        lt(depositPayments.paidAt, to),
      ),
    );

  // Meta never books (lib/meta/front-door.ts takes requests), so a clinic
  // with neither phone nor website chat takes requests whatever the mode.
  const books = bought.has("voice") || bought.has("web");
  const mode = books ? effectiveOf(await bookingModeFor(tx)).mode : "requests";

  tx.audit.record({
    action: "read",
    resourceType: "conversation",
    resultCount: handled,
    metadata: { purpose: `claims_${purpose}` },
  });

  return {
    from,
    to,
    channels,
    handled,
    rangOut: bought.has("voice") ? (talk?.rangOut ?? 0) : null,
    bookingMode: mode,
    requestsTaken: book?.taken ?? 0,
    requestsConfirmed: book?.confirmed ?? 0,
    bookedByAya: book?.bookedByAya ?? 0,
    bookedValue: {
      cents: book?.valueCents ?? 0,
      priced: book?.priced ?? 0,
      perUnit: book?.perUnit ?? 0,
      unpriced: book?.unpriced ?? 0,
    },
    depositsCollected: { count: deposits?.n ?? 0, cents: deposits?.cents ?? 0 },
    urgent: talk?.urgent ?? 0,
    handovers: talk?.handovers ?? 0,
  };
}

/** The claims as an email payload carries them: counts and cents only (lib/email/lint.ts). */
export function claimsPayload(claims: Claims): ClaimsPayload {
  const of = (ch: Channel) => claims.channels.find((c) => c.channel === ch)?.handled ?? null;
  return {
    handledCount: claims.handled,
    voiceCount: of("voice"),
    webCount: of("web"),
    metaCount: of("meta"),
    rangOutCount: claims.rangOut,
    isRequestMode: claims.bookingMode === "requests",
    requestsTakenCount: claims.requestsTaken,
    requestsConfirmedCount: claims.requestsConfirmed,
    bookedByAyaCount: claims.bookedByAya,
    bookedValueCents: claims.bookedValue.cents,
    pricedBookingsCount: claims.bookedValue.priced,
    perUnitBookingsCount: claims.bookedValue.perUnit,
    unpricedBookingsCount: claims.bookedValue.unpriced,
    depositsCollectedCount: claims.depositsCollected.count,
    depositsCollectedCents: claims.depositsCollected.cents,
    urgentCount: claims.urgent,
    handoverCount: claims.handovers,
  };
}

/** Conversations handled over [from, to) on the bought channels, as readClaims counts them. */
export async function countHandled(tx: TenantTx, from: Date, to: Date): Promise<number> {
  const bought = await boughtChannels(tx);
  const c = tx.clinicId;
  const kinds = [
    ...(bought.has("voice") ? (["voice"] as const) : []),
    ...(bought.has("web") ? (["web_chat"] as const) : []),
  ];
  const [talk] =
    kinds.length > 0
      ? await tx.db
          .select({ n: count() })
          .from(conversations)
          .where(
            and(
              eq(conversations.clinicId, c),
              inArray(conversations.channel, kinds),
              sql`(${conversations.channel} <> 'voice' or ${ANSWERED_CALL})`,
              gte(conversations.startedAt, from),
              lt(conversations.startedAt, to),
            ),
          )
      : [{ n: 0 }];
  const [meta] = bought.has("meta")
    ? await tx.db
        .select({ n: count() })
        .from(usageEvents)
        .where(
          and(
            eq(usageEvents.clinicId, c),
            eq(usageEvents.locationClinicId, c),
            eq(usageEvents.source, "meta"),
            gte(usageEvents.occurredAt, from),
            lt(usageEvents.occurredAt, to),
          ),
        )
    : [{ n: 0 }];
  return (talk?.n ?? 0) + (meta?.n ?? 0);
}

async function boughtChannels(tx: TenantTx): Promise<Set<Channel>> {
  const rows = await tx.db
    .select({ channel: clinicChannels.channel })
    .from(clinicChannels)
    .where(eq(clinicChannels.clinicId, tx.clinicId));
  return new Set(rows.map((r) => r.channel));
}

// -----------------------------------------------------------------------------
// A quiet day, and a quiet channel
// -----------------------------------------------------------------------------

const DAY_MS = 86_400_000;

/**
 * A quiet day is worth a line in the daily summary only when it is unusual
 * (Annex X5, L13): nothing handled in the period, where the seven days
 * before it would have led us to expect at least three. At that rate a
 * period with none happens about one time in twenty by chance (a Poisson
 * zero at a mean of three is e^-3, 5%); below it a quiet day is ordinary,
 * and a line every quiet morning would teach the clinic to ignore it. The
 * expectation is scaled to the period's length, so Monday's summary, which
 * covers the weekend since Friday's, expects a weekend's worth.
 */
export const QUIET_DAY_EXPECTED = 3;

export function quietDayIsUnusual(input: {
  handled: number;
  handledPriorWeek: number;
  periodMs: number;
}): boolean {
  if (input.handled > 0 || input.periodMs <= 0) return false;
  const expected = (input.handledPriorWeek * input.periodMs) / (7 * DAY_MS);
  return expected >= QUIET_DAY_EXPECTED;
}

/**
 * How long a live channel may hear nothing before Home's Needs attention says
 * so: seven days. A week holds every day of the clinic's own pattern, so a
 * practice shut at weekends, one with a Monday off or a long weekend never
 * trips it; at an elective clinic a channel that is really answering hears
 * from someone within a week, and one that does not has usually stopped
 * reaching AYA for a reason the clinic can fix itself (forwarding undone by
 * the carrier, the chat snippet gone from a redesigned site, Instagram
 * disconnected). Counted from the later of the channel going live and AYA
 * last being turned back on, so a pause or a channel switched Off is never
 * mistaken for quiet. Not the internal health flags (48 hours with nothing on
 * any channel, 14 days without a call), which are WP5's and go to ops only.
 */
export const QUIET_CHANNEL_DAYS = 7;

/**
 * The live channels that have heard nothing for QUIET_CHANNEL_DAYS: no call,
 * no web chat, no Meta message reaching AYA. Only channels answering now
 * (status `live`: switched On, gone live, not paused).
 */
export async function readQuietChannels(
  tx: TenantTx,
  states: readonly ChannelState[],
  now: Date,
): Promise<Channel[]> {
  const since = new Date(now.getTime() - QUIET_CHANNEL_DAYS * DAY_MS);
  const answering = states.filter((s) => s.status === "live" && s.liveAt !== null);
  if (answering.length === 0) return [];
  const c = tx.clinicId;

  const quiet: Channel[] = [];
  for (const state of answering) {
    if (state.liveAt!.getTime() > since.getTime()) continue;
    // The last time AYA was turned back on here: a resume (clinic-wide) or
    // the channel's own switch turned On.
    const [back] = await tx.db
      .select({ at: sql<Date | null>`max(${channelEvents.occurredAt})` })
      .from(channelEvents)
      .where(
        and(
          eq(channelEvents.clinicId, c),
          or(
            and(
              eq(channelEvents.kind, "resumed"),
              or(isNull(channelEvents.channel), eq(channelEvents.channel, state.channel)),
            ),
            and(eq(channelEvents.kind, "turned_on"), eq(channelEvents.channel, state.channel)),
          ),
        ),
      );
    const resumedAt = back?.at ? new Date(back.at) : null;
    if (resumedAt && resumedAt.getTime() > since.getTime()) continue;
    if (!(await heardSince(tx, state.channel, since))) quiet.push(state.channel);
  }
  return quiet;
}

/** Whether anything reached AYA on the channel since `since`: a call, a chat, a Meta message. */
async function heardSince(tx: TenantTx, channel: Channel, since: Date): Promise<boolean> {
  const c = tx.clinicId;
  if (channel === "voice" || channel === "web") {
    const [row] = await tx.db
      .select({ id: conversations.id })
      .from(conversations)
      .where(
        and(
          eq(conversations.clinicId, c),
          eq(conversations.channel, channel === "voice" ? "voice" : "web_chat"),
          gte(conversations.startedAt, since),
        ),
      )
      .limit(1);
    if (row) return true;
    if (channel === "voice") return false;
  }
  const threads =
    channel === "web" ? (["web_chat"] as const) : (["messenger", "instagram", "whatsapp"] as const);
  const [thread] = await tx.db
    .select({ at: chatThreads.lastInboundAt })
    .from(chatThreads)
    .where(
      and(
        eq(chatThreads.clinicId, c),
        inArray(chatThreads.channel, [...threads]),
        gte(chatThreads.lastInboundAt, since),
      ),
    )
    .limit(1);
  return thread !== undefined;
}
