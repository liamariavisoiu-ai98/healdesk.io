import { and, asc, eq, gte } from "drizzle-orm";

import type { Transaction } from "@/db";
import { clinicClosures } from "@/db/schema";

import { isOpenAt, type OpeningHours } from "./opening-hours";

/**
 * The days a clinic is closed outright (a holiday, a training day), on top of
 * its weekly hours. The weekly hours stay in `clinics.opening_hours`, read by
 * `isOpenAt` in opening-hours.ts; a closure only ever adds a closed day. A gate
 * that asks whether the clinic is open combines the two, `isOpenAt` for the
 * hour and `closedOn` for the day, so the hours rule stays in one place.
 *
 * A closure is a date in the clinic's own time zone, not an instant: "closed
 * on 25 December" means the clinic's 25 December, which starts at a different
 * UTC instant in every zone and moves with daylight saving. `clinicLocalDate`
 * turns an instant into that date.
 *
 * Like lib/billing/entitlements.ts, `closedOn` takes a `Transaction` and a
 * clinic id; from a withTenant() block, pass `tx.db`.
 */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The clinic-local calendar date of an instant, YYYY-MM-DD.
 *
 * Intl, not offset arithmetic, for the reason opening-hours.ts gives: the
 * offset a zone implies changes twice a year, so a fixed one is right for
 * half the year and puts an hour around midnight on the wrong day for the
 * other half.
 */
export function clinicLocalDate(at: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(at);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

/** Whether the clinic is closed all day on `localDate`, YYYY-MM-DD in its own time zone. */
export async function closedOn(
  tx: Transaction,
  clinicId: string,
  localDate: string,
): Promise<boolean> {
  if (!ISO_DATE.test(localDate)) {
    throw new Error(`closedOn needs a YYYY-MM-DD date, not "${localDate}".`);
  }
  const [row] = await tx
    .select({ closedOn: clinicClosures.closedOn })
    .from(clinicClosures)
    .where(and(eq(clinicClosures.clinicId, clinicId), eq(clinicClosures.closedOn, localDate)))
    .limit(1);
  return row !== undefined;
}

export type Closure = { closedOn: string; label: string | null };

/**
 * The clinic's closed days on or after `fromDate` (YYYY-MM-DD, its own
 * zone), earliest first: what a reader that cannot ask `closedOn` day by day
 * holds instead, such as the facts a conversation is built from.
 */
export async function closuresFrom(
  tx: Transaction,
  clinicId: string,
  fromDate: string,
  limit = 100,
): Promise<Closure[]> {
  if (!ISO_DATE.test(fromDate)) {
    throw new Error(`closuresFrom needs a YYYY-MM-DD date, not "${fromDate}".`);
  }
  return tx
    .select({ closedOn: clinicClosures.closedOn, label: clinicClosures.label })
    .from(clinicClosures)
    .where(and(eq(clinicClosures.clinicId, clinicId), gte(clinicClosures.closedOn, fromDate)))
    .orderBy(asc(clinicClosures.closedOn))
    .limit(limit);
}

/**
 * Whether the clinic is open at `at`, from its weekly hours and the closed
 * days it has saved (`closedDates`, YYYY-MM-DD in its zone): `isOpenAt` for
 * the hour, and shut all day on a closed date, the day the answer gate and
 * the booking engine read a closure by. Null only when the hours are not
 * known and the day is not a closed one, which callers count as open.
 * Throws, as `isOpenAt` does, on a zone Intl cannot read.
 */
export function openGiven(
  hours: OpeningHours | null | undefined,
  closedDates: readonly string[],
  at: Date,
  timeZone: string,
): boolean | null {
  if (closedDates.length > 0 && closedDates.includes(clinicLocalDate(at, timeZone))) return false;
  return isOpenAt(hours, at, timeZone);
}
