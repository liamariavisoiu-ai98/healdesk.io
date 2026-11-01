import { and, eq, ne, sql } from "drizzle-orm";

import { appointments } from "@/db/schema";
import type { TenantTx } from "@/lib/tenant";

/**
 * Home's week at a glance (portal redesign, owner, 1 November 2026): the
 * seven days of this week, Monday to Sunday in the clinic's own time zone,
 * each with how many appointments are on it.
 *
 * Counts only. Home opens without the passkey step-up, so it never shows a
 * patient's name, treatment, time or price: those stay on Bookings, behind
 * the step-up (lib/portal/step-up.ts). A count of appointments on a day names
 * nobody. Cancelled appointments are left out; everything else on the
 * calendar counts, whoever booked it, because this is the clinic's week.
 */

export type WeekDay = {
  /** YYYY-MM-DD in the clinic's zone. */
  date: string;
  /** "Mon". */
  label: string;
  /** Day of the month, "3". */
  dayOfMonth: number;
  isToday: boolean;
  count: number;
};

const LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

function zoneOr(timeZone: string): string {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return timeZone;
  } catch {
    return "America/New_York";
  }
}

/** The local calendar date of `at` in `timeZone`, as a UTC-noon Date (safe for day arithmetic). */
function localNoon(at: Date, timeZone: string): Date {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: zoneOr(timeZone),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(at);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return new Date(Date.UTC(get("year"), get("month") - 1, get("day"), 12));
}

function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** This week's seven days, Monday first, in the clinic's zone, with no counts yet. Pure. */
export function weekDays(now: Date, timeZone: string): WeekDay[] {
  const today = localNoon(now, timeZone);
  // getUTCDay: Sunday 0 … Saturday 6; Monday-first offset.
  const offset = (today.getUTCDay() + 6) % 7;
  const monday = new Date(today.getTime() - offset * 86_400_000);
  return LABELS.map((label, i) => {
    const d = new Date(monday.getTime() + i * 86_400_000);
    return {
      date: iso(d),
      label,
      dayOfMonth: d.getUTCDate(),
      isToday: iso(d) === iso(today),
      count: 0,
    };
  });
}

/** Fill `days` with the number of appointments on each, read in the clinic's zone. */
export async function readWeekSchedule(
  tx: TenantTx,
  now: Date,
  timeZone: string,
): Promise<WeekDay[]> {
  const days = weekDays(now, timeZone);
  const zone = zoneOr(timeZone);
  const localDay = sql<string>`to_char(${appointments.scheduledFor} at time zone ${zone}, 'YYYY-MM-DD')`;
  const rows = await tx.db
    .select({ day: localDay, n: sql<number>`count(*)::int` })
    .from(appointments)
    .where(
      and(
        eq(appointments.clinicId, tx.clinicId),
        ne(appointments.status, "cancelled"),
        sql`${localDay} between ${days[0]!.date} and ${days[6]!.date}`,
      ),
    )
    // By position: each `localDay` binds its zone as a new parameter, so
    // Postgres would not see the select and the group by as one expression.
    .groupBy(sql`1`);
  const byDay = new Map(rows.map((r) => [r.day, r.n]));
  return days.map((d) => ({ ...d, count: byDay.get(d.date) ?? 0 }));
}
