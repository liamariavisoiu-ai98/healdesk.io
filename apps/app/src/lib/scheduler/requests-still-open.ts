import { and, eq, gt, lt, sql } from "drizzle-orm";

import { bookingRequests, clinics, clinicSettings } from "@/db/schema";
import { clinicLocalDate, closedOn } from "@/lib/clinic/closures";
import {
  DAY_KEYS,
  isOpenAt,
  parseOpeningHours,
  type DayKey,
  type OpeningHours,
} from "@/lib/clinic/opening-hours";
import { describeError, log } from "@/lib/log";
import { BOOKING_REQUEST_TTL_DAYS } from "@/lib/meta/booking-requests";
import { queueRequestsStillOpen } from "@/lib/notices/booking-alerts";
import { listClinics } from "@/lib/ops/clinics";
import { withTenant } from "@/lib/tenant";

import { JOB_REQUESTS_STILL_OPEN, runJob, type JobOutcome } from "./jobs";

/**
 * L8, "Request still open" (Annex X5): at the clinic's opening hour, only
 * while its daily summary is off, one email saying how many booking requests
 * taken before that opening are still waiting for the desk.
 *
 * The daily summary (L13) lists every request still open each morning; a
 * clinic that has switched the summary off would otherwise hear about a
 * request only twice, when it is taken (L7, at any hour) and when it expires
 * unanswered (L9). L8 is that morning line on its own: a request taken at
 * 22:00 is in the next morning's L8 if nobody has answered it, and in each
 * opening's after that until the desk answers it or it expires.
 *
 * Hourly from the tick, behind its switch (seeded off). For each clinic the
 * first run at which it is open on a clinic-local day, on or after that day's
 * first opening time, queues the day's L8, once (the outbox dedupes on
 * `request_still_open:<date>`). A day the clinic is shut, by its weekly hours
 * or a closure, sends nothing; a clinic with no opening hours on file is
 * never reminded, because "unknown is not closed" cuts both ways
 * (lib/clinic/opening-hours.ts) and an opening hour we would have to guess is
 * not one. The count is of requests in `requested` taken before today's
 * opening: one taken during the day was alerted minutes ago and is
 * tomorrow's.
 */

const ACTOR = { type: "service", serviceName: "requests-still-open" } as const;

export type StillOpenOutcome =
  "queued" | "already_queued" | "summary_on" | "no_hours" | "not_open" | "none_waiting";

/** The clinic-local weekday and minute of the day at an instant. */
function localDayAndMinute(at: Date, timeZone: string): { day: DayKey; minutes: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(at);
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const day = part("weekday").toLowerCase().slice(0, 3) as DayKey;
  return { day, minutes: (Number(part("hour")) % 24) * 60 + Number(part("minute")) };
}

function minutesOf(hhmm: string): number {
  const [h, m] = hhmm.split(":");
  return Number(h) * 60 + Number(m);
}

/**
 * Today's first opening, as an instant, once it has come: null on a day with
 * no hours, or before the day's first opening time. `now`'s seconds are
 * dropped, so the instant is the opening minute itself.
 */
export function openedToday(hours: OpeningHours, now: Date, timeZone: string): Date | null {
  const { day, minutes } = localDayAndMinute(now, timeZone);
  if (!DAY_KEYS.includes(day)) return null;
  const opens = (hours[day] ?? []).map((range) => minutesOf(range[0]));
  if (opens.length === 0) return null;
  const first = Math.min(...opens);
  if (minutes < first) return null;
  const minuteStart = now.getTime() - (now.getTime() % 60_000);
  return new Date(minuteStart - (minutes - first) * 60_000);
}

/** Queue today's L8 for one clinic, if it is due. */
export async function queueRequestsStillOpenFor(
  clinicId: string,
  now: Date,
): Promise<StillOpenOutcome> {
  return withTenant({ clinicId, actor: ACTOR }, async (tx) => {
    const [row] = await tx.db
      .select({
        timezone: clinics.timezone,
        openingHours: clinics.openingHours,
        dailySummary: clinicSettings.dailySummary,
      })
      .from(clinics)
      .leftJoin(clinicSettings, eq(clinicSettings.clinicId, clinics.id))
      .where(eq(clinics.id, tx.clinicId))
      .limit(1);
    // No settings row reads as the default, which is on.
    if (!row || row.dailySummary !== false) return "summary_on";

    let hours: OpeningHours;
    try {
      hours = parseOpeningHours(row.openingHours);
    } catch {
      return "no_hours";
    }
    const localDate = clinicLocalDate(now, row.timezone);
    const opening = openedToday(hours, now, row.timezone);
    if (!opening || isOpenAt(hours, now, row.timezone) !== true) return "not_open";
    if (await closedOn(tx.db, tx.clinicId, localDate)) return "not_open";

    const [waiting] = await tx.db
      .select({ n: sql<number>`count(*)::int` })
      .from(bookingRequests)
      .where(
        and(
          eq(bookingRequests.clinicId, tx.clinicId),
          eq(bookingRequests.status, "requested"),
          gt(bookingRequests.expiresAt, now),
          lt(bookingRequests.createdAt, opening),
        ),
      );
    const openCount = waiting?.n ?? 0;
    if (openCount === 0) return "none_waiting";

    const queued = await queueRequestsStillOpen(tx, {
      localDate,
      openCount,
      closesAfterDays: BOOKING_REQUEST_TTL_DAYS,
    });
    return queued ? "queued" : "already_queued";
  });
}

/** The hourly job: every clinic whose opening hour has come and whose summary is off. */
export async function runRequestsStillOpenJob(options: { now?: Date } = {}): Promise<JobOutcome> {
  const now = options.now ?? new Date();
  return runJob(
    JOB_REQUESTS_STILL_OPEN,
    async () => {
      const counts: Partial<Record<StillOpenOutcome | "failed", number>> = {};
      for (const clinic of await listClinics()) {
        if (clinic.destroyedAt || clinic.offboardingStartedAt) continue;
        let outcome: StillOpenOutcome | "failed";
        try {
          outcome = await queueRequestsStillOpenFor(clinic.id, now);
        } catch (error) {
          outcome = "failed";
          log.error("requests-still-open failed for a clinic", {
            clinicId: clinic.id,
            error: describeError(error),
          });
        }
        counts[outcome] = (counts[outcome] ?? 0) + 1;
      }
      return (
        `${counts.queued ?? 0} queued, ${counts.already_queued ?? 0} already queued, ` +
        `${counts.none_waiting ?? 0} with nothing waiting, ${counts.failed ?? 0} failed.`
      );
    },
    now,
  );
}
