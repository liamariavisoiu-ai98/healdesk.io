import type { Channel } from "@healdesk/catalog";
import { and, asc, eq, gte, lt, or, sql } from "drizzle-orm";

import {
  appointments,
  billingNotices,
  bookingRequests,
  clinics,
  clinicSettings,
} from "@/db/schema";
import { readChannelStates } from "@/lib/channels/state";
import { closedOn } from "@/lib/clinic/closures";
import {
  OpeningHoursError,
  parseOpeningHours,
  type OpeningHours,
} from "@/lib/clinic/opening-hours";
import { MAX_NOTICE_ATTEMPTS } from "@/lib/email/outbox";
import type {
  DailySummaryPayload,
  SummaryRow,
  SummaryRowStatus,
} from "@/lib/email/templates/daily_summary";
import { describeError, log } from "@/lib/log";
import {
  openRequestCondition,
  REQUEST_LAPSED,
  type BookingChannel,
} from "@/lib/meta/booking-requests";
import { enqueuePlanNotice } from "@/lib/notices/plan-notices";
import { listClinics } from "@/lib/ops/clinics";
import { bookingRequestPath, bookingsPath } from "@/lib/portal/booking-paths";
import { publicUrl } from "@/lib/public-url";
import { claimsPayload, countHandled, quietDayIsUnusual, readClaims } from "@/lib/reporting/claims";
import { withTenant, type TenantTx } from "@/lib/tenant";

import { JOB_DAILY_SUMMARY, runJob, type JobOutcome } from "./jobs";
import {
  isoWeekOf,
  lastWeek,
  localClock,
  mondayOf,
  openedAt,
  workingDayOpened,
} from "./summary-clock";

/**
 * L13, the daily summary (Annex X5; spec, "Daily summary email"): at each
 * live clinic's opening time on each of its working days, in its own time
 * zone, while its Daily summary switch is on (clinic_settings.daily_summary,
 * on by default; the same switch F's L8 reads, which goes only while this is
 * off).
 *
 * Hourly from the tick, behind its own job switch (seeded off, drizzle/0082).
 * For each clinic the first run on a working day at or after that day's
 * first opening time, and before 20:00 its time, queues the day's summary,
 * once (`daily_summary:<local date>`). A day with no hours in the weekly
 * schedule, or a closure, is not a working day and gets none. A clinic with
 * no opening hours on file gets none either: its opening time would be a
 * guess ("unknown is not closed" cuts both ways, lib/clinic/opening-hours.ts),
 * and the weekly recap goes alone on its Mondays instead
 * (lib/scheduler/weekly-recap.ts).
 *
 * What it carries, all pointers (X1.1):
 *   - the claims since the last summary (lib/reporting/claims.ts), and the
 *     quiet-day line only when nothing was handled and the week before would
 *     have led us to expect some (quietDayIsUnusual);
 *   - every booking and booking request since the last summary, one row
 *     each with its channel, where it stands and its link: requests taken in
 *     the period, and bookings made in it on older requests;
 *   - every request still open that was taken before the period;
 *   - on the clinic's first working day of the week, last week's recap,
 *     unless L14 already went alone for that week.
 *
 * "Since the last summary" is since the end of the last one that reached the
 * clinic or is still on its way (not one the switch closed unsent, not a dead
 * one), else since the clinic's first channel went live, and never more than
 * SUMMARY_LOOKBACK_DAYS back: a summary switched off for a month and back on
 * says "in the last 7 days" rather than a month of rows.
 */

const ACTOR = { type: "service", serviceName: "daily-summary" } as const;
const DAY_MS = 86_400_000;

/** How far back a summary reaches when the last one is older, or there was none. */
export const SUMMARY_LOOKBACK_DAYS = 7;
/**
 * Rows per list. The payload allowlist caps a payload at 16 KB, and a row
 * with its link is about 160 bytes, so two lists of 30 leave room for both
 * sets of claims; past it, the email says how many more are on Bookings.
 */
export const SUMMARY_ROW_CAP = 30;

export type DailySummaryOutcome =
  "queued" | "already_queued" | "not_live" | "summary_off" | "no_hours" | "not_open" | "closed";

const CHANNEL_OF: Record<BookingChannel, Channel> = {
  voice: "voice",
  web_chat: "web",
  meta: "meta",
};

/** Queue today's summary for one clinic, if it is due. */
export async function queueDailySummaryFor(
  clinicId: string,
  now: Date,
): Promise<DailySummaryOutcome> {
  return withTenant({ clinicId, actor: ACTOR }, async (tx) => {
    const [clinic] = await tx.db
      .select({
        slug: clinics.slug,
        timezone: clinics.timezone,
        openingHours: clinics.openingHours,
        dataClassification: clinics.dataClassification,
        offboardingStartedAt: clinics.offboardingStartedAt,
        destroyedAt: clinics.destroyedAt,
        dailySummary: clinicSettings.dailySummary,
      })
      .from(clinics)
      .leftJoin(clinicSettings, eq(clinicSettings.clinicId, clinics.id))
      .where(eq(clinics.id, tx.clinicId))
      .limit(1);
    if (
      !clinic ||
      clinic.dataClassification !== "production" ||
      clinic.offboardingStartedAt ||
      clinic.destroyedAt
    ) {
      return "not_live";
    }
    const states = await readChannelStates(tx.db, tx.clinicId, now);
    const liveSince = earliest(states.map((s) => s.liveAt));
    if (!liveSince) return "not_live";
    // No settings row reads as the default, which is on.
    if (clinic.dailySummary === false) return "summary_off";

    const hours = hoursOf(clinic.openingHours);
    if (!hours) return "no_hours";
    if (!workingDayOpened(hours, now, clinic.timezone)) return "not_open";
    const today = localClock(now, clinic.timezone).date;
    if (await closedOn(tx.db, tx.clinicId, today)) return "closed";
    // A clinic that went live after today's opening has its first summary at
    // tomorrow's: one now would cover the minutes since.
    if (liveSince.getTime() >= openedAt(hours, today, clinic.timezone).getTime()) {
      return "not_live";
    }

    const dedupeKey = `daily_summary:${today}`;
    if (await queuedAlready(tx, "daily_summary", dedupeKey)) return "already_queued";

    // The period: since the last summary on its way, else since go-live,
    // never more than a week back.
    const lastEnd = await lastSummaryEnd(tx);
    const floor = new Date(now.getTime() - SUMMARY_LOOKBACK_DAYS * DAY_MS);
    let from = lastEnd ?? liveSince;
    const capped = from.getTime() < floor.getTime();
    if (capped) from = floor;
    const isFirstSummary = lastEnd === null && !capped;

    const day = await readClaims(tx, { from, to: now }, "daily_summary");
    const priorWeek = await countHandled(tx, new Date(from.getTime() - 7 * DAY_MS), from);

    const rows = await summaryRows(tx, clinic.slug, from, now);

    // The week's first summary carries last week's recap, unless L14 went
    // alone for that week (the summary was off on Monday morning).
    const week = lastWeek(today, clinic.timezone);
    let weekClaims: DailySummaryPayload["weekClaims"] = null;
    if (
      !(await summaryEarlierThisWeek(tx, mondayOf(today), today)) &&
      !(await queuedAlready(tx, "weekly_recap", `weekly_recap:${isoWeekOf(week.startOn)}`)) &&
      liveSince.getTime() < week.to.getTime()
    ) {
      const claims = await readClaims(tx, { from: week.from, to: week.to }, "weekly_recap");
      if (claims.handled > 0) weekClaims = claimsPayload(claims);
    }

    const payload: DailySummaryPayload = {
      periodStartAt: from.toISOString(),
      periodEndAt: now.toISOString(),
      isFirstSummary,
      isPeriodCapped: capped,
      dayClaims: claimsPayload(day),
      isQuietUnusual: quietDayIsUnusual({
        handled: day.handled,
        handledPriorWeek: priorWeek,
        periodMs: now.getTime() - from.getTime(),
      }),
      newRows: rows.fresh.slice(0, SUMMARY_ROW_CAP),
      moreNewCount: Math.max(0, rows.fresh.length - SUMMARY_ROW_CAP),
      openRows: rows.open.slice(0, SUMMARY_ROW_CAP),
      moreOpenCount: Math.max(0, rows.open.length - SUMMARY_ROW_CAP),
      bookingsUrl: publicUrl(bookingsPath(clinic.slug)),
      weekClaims,
      weekStartOn: weekClaims ? week.startOn : null,
      weekEndOn: weekClaims ? week.endOn : null,
    };
    const queued = await enqueuePlanNotice(tx.db, tx.clinicId, "daily_summary", dedupeKey, payload);
    return queued ? "queued" : "already_queued";
  });
}

/** The hourly job: every live clinic whose working day has opened. */
export async function runDailySummaryJob(options: { now?: Date } = {}): Promise<JobOutcome> {
  const now = options.now ?? new Date();
  return runJob(
    JOB_DAILY_SUMMARY,
    async () => {
      const counts: Partial<Record<DailySummaryOutcome | "failed", number>> = {};
      for (const clinic of await listClinics()) {
        if (clinic.destroyedAt || clinic.offboardingStartedAt) continue;
        if (clinic.dataClassification !== "production") continue;
        let outcome: DailySummaryOutcome | "failed";
        try {
          outcome = await queueDailySummaryFor(clinic.id, now);
        } catch (error) {
          outcome = "failed";
          log.error("daily summary failed for a clinic", {
            clinicId: clinic.id,
            error: describeError(error),
          });
        }
        counts[outcome] = (counts[outcome] ?? 0) + 1;
      }
      return (
        `${counts.queued ?? 0} queued, ${counts.already_queued ?? 0} already queued, ` +
        `${counts.summary_off ?? 0} switched off, ${counts.no_hours ?? 0} with no hours, ` +
        `${counts.failed ?? 0} failed.`
      );
    },
    now,
  );
}

// -----------------------------------------------------------------------------
// Internals, shared with the weekly recap
// -----------------------------------------------------------------------------

/** The weekly schedule, or null when none is on file or it does not parse. */
export function hoursOf(value: unknown): OpeningHours | null {
  try {
    return parseOpeningHours(value);
  } catch (error) {
    if (error instanceof OpeningHoursError) return null;
    throw error;
  }
}

/** The earliest of some instants, or null when there are none. */
export function earliest(values: readonly (Date | null)[]): Date | null {
  let out: Date | null = null;
  for (const value of values) {
    if (value && (!out || value.getTime() < out.getTime())) out = value;
  }
  return out;
}

/** Whether a notice of this kind and key was queued for the clinic, sent or not. */
export async function queuedAlready(
  tx: TenantTx,
  kind: "daily_summary" | "weekly_recap",
  dedupeKey: string,
): Promise<boolean> {
  const [row] = await tx.db
    .select({ id: billingNotices.id })
    .from(billingNotices)
    .where(
      and(
        eq(billingNotices.clinicId, tx.clinicId),
        eq(billingNotices.kind, kind),
        eq(billingNotices.dedupeKey, dedupeKey),
      ),
    )
    .limit(1);
  return row !== undefined;
}

/**
 * A summary on its way: sent to someone, or still pending and not dead. Not
 * one the sender closed unsent (its switch was off when it would have gone),
 * which reached nobody.
 */
export const ON_ITS_WAY = or(
  and(sql`${billingNotices.sentAt} is null`, lt(billingNotices.attempts, MAX_NOTICE_ATTEMPTS)),
  and(sql`${billingNotices.sentAt} is not null`, sql`${billingNotices.recipientsCount} > 0`),
);

/** When the period of the last summary on its way ended, or null when none is. */
async function lastSummaryEnd(tx: TenantTx): Promise<Date | null> {
  const [row] = await tx.db
    .select({ end: sql<string | null>`${billingNotices.payload} ->> 'periodEndAt'` })
    .from(billingNotices)
    .where(
      and(
        eq(billingNotices.clinicId, tx.clinicId),
        eq(billingNotices.kind, "daily_summary"),
        ON_ITS_WAY,
      ),
    )
    .orderBy(sql`${billingNotices.createdAt} desc`)
    .limit(1);
  const end = row?.end ? new Date(row.end) : null;
  return end && !Number.isNaN(end.getTime()) ? end : null;
}

/** Whether a summary on its way was queued for an earlier day of this local week. */
async function summaryEarlierThisWeek(
  tx: TenantTx,
  monday: string,
  today: string,
): Promise<boolean> {
  const [row] = await tx.db
    .select({ id: billingNotices.id })
    .from(billingNotices)
    .where(
      and(
        eq(billingNotices.clinicId, tx.clinicId),
        eq(billingNotices.kind, "daily_summary"),
        gte(billingNotices.dedupeKey, `daily_summary:${monday}`),
        lt(billingNotices.dedupeKey, `daily_summary:${today}`),
        ON_ITS_WAY,
      ),
    )
    .limit(1);
  return row !== undefined;
}

/**
 * The summary's two lists: every booking and booking request since `from`
 * (taken in the period, or booked in it on an older request), and every
 * request still open taken before it. Ids, channels and statuses only:
 * nothing of the person is read.
 */
async function summaryRows(
  tx: TenantTx,
  slug: string,
  from: Date,
  to: Date,
): Promise<{ fresh: SummaryRow[]; open: SummaryRow[] }> {
  const status = sql<SummaryRowStatus>`case
      when ${appointments.bookingOrigin} = 'assistant' then 'booked'
      when ${bookingRequests.status} = 'confirmed' then 'confirmed'
      when ${bookingRequests.status} = 'declined' then 'declined'
      when ${bookingRequests.status} = 'expired' or ${REQUEST_LAPSED} then 'missed'
      else 'waiting' end`;
  const joined = and(
    eq(appointments.id, bookingRequests.appointmentId),
    eq(appointments.clinicId, bookingRequests.clinicId),
  );
  const fresh = await tx.db
    .select({ id: bookingRequests.id, channel: bookingRequests.channel, status })
    .from(bookingRequests)
    .leftJoin(appointments, joined)
    .where(
      and(
        eq(bookingRequests.clinicId, tx.clinicId),
        or(
          and(gte(bookingRequests.createdAt, from), lt(bookingRequests.createdAt, to)),
          and(gte(appointments.createdAt, from), lt(appointments.createdAt, to)),
        ),
      ),
    )
    .orderBy(asc(bookingRequests.createdAt), asc(bookingRequests.id))
    .limit(500);
  const open = await tx.db
    .select({ id: bookingRequests.id, channel: bookingRequests.channel })
    .from(bookingRequests)
    .where(
      and(
        eq(bookingRequests.clinicId, tx.clinicId),
        openRequestCondition(),
        lt(bookingRequests.createdAt, from),
      ),
    )
    .orderBy(asc(bookingRequests.createdAt), asc(bookingRequests.id))
    .limit(500);
  const row = (id: string, channel: BookingChannel, s: SummaryRowStatus): SummaryRow => ({
    channel: CHANNEL_OF[channel],
    status: s,
    linkUrl: publicUrl(bookingRequestPath(slug, id)),
  });
  return {
    fresh: fresh.map((r) => row(r.id, r.channel, r.status)),
    open: open.map((r) => row(r.id, r.channel, "waiting")),
  };
}
