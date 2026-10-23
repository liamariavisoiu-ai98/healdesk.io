import { and, eq, gt, inArray, sql } from "drizzle-orm";

import { appointments } from "@/db/schema";
import {
  DESK_SWEEP_LOOKBACK_HOURS,
  MAX_WRITE_ATTEMPTS,
  WRITABLE_APPOINTMENT_STATUSES,
} from "@/lib/booking/calendar";
import { describeError, log } from "@/lib/log";
import { withTenant } from "@/lib/tenant";

import { listClinics } from "./clinics";
import {
  coverOpsAlerts,
  notifyOps,
  notifyOpsOnce,
  opsAlertsNotYetRaised,
  type OpsFields,
} from "./notify";

/**
 * Calendar writes that need a person (design E3, "Calendar writes alert
 * nobody"; owner, 23 October 2026).
 *
 * A booking the desk confirmed is written into the location's Google
 * Calendar by writeToCalendar (lib/booking/calendar.ts). When Google refuses
 * it, the row ends `failed` and nothing retries it on its own; when Google's
 * answer never came, it is `unknown` and the desk sweep tries again, five
 * attempts at most, and only for writes touched in the last
 * DESK_SWEEP_LOOKBACK_HOURS. Either way the desk page says to add the
 * booking by hand, and until now nobody at healdesk heard of it.
 *
 * This raises calendar_write_stuck, once per write, state and attempt
 * count, through notifyOpsOnce (emailed, and posted to Slack, with the
 * clinic's name, the write's ids, its attempts and Google's reason code, and
 * its console link), for each booking still on whose write is:
 *
 *   - `failed`: settled, never retried without an operator;
 *   - `unknown` at the five attempts: the sweep has stopped;
 *   - `unknown`, or a claim left `writing`, untouched for longer than the
 *     sweep's look-back: the sweep no longer sees it, so without this it
 *     would be missed for good.
 *
 * Its own look-back is ALERT_LOOKBACK_DAYS, well past the sweep's 24 hours,
 * so a write the sweep gives up on by age is still caught by a run that
 * comes days later (a worker down for a weekend), and the once-per-key
 * alert makes every rerun a no-op. It reads, and alerts ops; it never
 * retries a write (the retry ladder is a later phase) and never contacts
 * anyone else. Hourly from the tick, unswitched, like the sweeps that only
 * tell ops.
 */

/** How far back a settled or abandoned write is still alerted. Days, not hours: see above. */
export const ALERT_LOOKBACK_DAYS = 14;

/** More new stuck writes than this in one run are told as one summary. */
export const SUMMARY_ABOVE = 5;

export type CalendarWriteAlertsResult = {
  clinics: number;
  found: number;
  /** Writes recorded as told under a summary alert this run. */
  covered: number;
  failures: number;
};

const ACTOR = { type: "service", serviceName: "calendar-write-alerts" } as const;
const CODE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;

export async function alertStuckCalendarWrites(now: Date = new Date()): Promise<CalendarWriteAlertsResult> {
  const result: CalendarWriteAlertsResult = { clinics: 0, found: 0, covered: 0, failures: 0 };
  const found: OpsFields[] = [];
  const since = new Date(now.getTime() - ALERT_LOOKBACK_DAYS * 24 * 3_600_000);
  const sweepSince = new Date(now.getTime() - DESK_SWEEP_LOOKBACK_HOURS * 3_600_000);

  let clinicIds: string[];
  try {
    clinicIds = (await listClinics()).filter((c) => !c.destroyedAt).map((c) => c.id);
  } catch (error) {
    log.error("calendar write alerts could not list clinics", { error: describeError(error) });
    return { ...result, failures: 1 };
  }

  for (const clinicId of clinicIds) {
    result.clinics += 1;
    try {
      const stuck = await withTenant({ clinicId, actor: ACTOR }, (tx) =>
        tx.db
          .select({
            id: appointments.id,
            status: appointments.calendarWriteStatus,
            attempts: appointments.calendarWriteAttempts,
            error: appointments.calendarWriteError,
          })
          .from(appointments)
          .where(
            and(
              eq(appointments.clinicId, tx.clinicId),
              gt(appointments.updatedAt, since),
              inArray(appointments.status, [...WRITABLE_APPOINTMENT_STATUSES]),
              sql`(${appointments.calendarWriteStatus} = 'failed'
                   or (${appointments.calendarWriteStatus} = 'unknown'
                       and (${appointments.calendarWriteAttempts} >= ${MAX_WRITE_ATTEMPTS}
                            or ${appointments.updatedAt} <= ${sweepSince}))
                   or (${appointments.calendarWriteStatus} = 'writing'
                       and ${appointments.updatedAt} <= ${sweepSince}))`,
            ),
          ),
      );
      for (const write of stuck) {
        const code = write.error && CODE.test(write.error) ? write.error : null;
        // attemptCount is part of the alert's key (attempts would not be: it
        // is a counter notifyOps leaves out of identity), so a write an
        // operator retries that fails again, its count one higher, is a new
        // alert, and the same failure seen by every later run is not.
        found.push({
          clinicId,
          appointmentId: write.id,
          status: write.status,
          ...(code ? { code } : {}),
          attemptCount: write.attempts,
        });
      }
    } catch (error) {
      result.failures += 1;
      log.error("calendar write alerts failed for a clinic", { clinicId, error: describeError(error) });
    }
  }
  result.found = found.length;

  // A first run, or a wide outage, would otherwise mail one alert per write:
  // past a handful not yet told, one summary with the count stands for them
  // all, and each is recorded as told so none follows it one by one.
  try {
    const fresh = await opsAlertsNotYetRaised("calendar_write_stuck", found);
    if (fresh.length > SUMMARY_ABOVE) {
      await notifyOps("calendar_writes_stuck_many", { count: fresh.length, windowStart: now.toISOString() });
      result.covered = await coverOpsAlerts("calendar_write_stuck", fresh, now);
      return result;
    }
  } catch (error) {
    // Unread, the alerts go one by one: more mail, nothing missed.
    log.error("calendar write alerts could not read the ops log", { error: describeError(error) });
  }
  for (const fields of found) await notifyOpsOnce("calendar_write_stuck", fields);
  return result;
}
