import type { BookedAppointment } from "./bookings";
import { depositBadge } from "./bookings-view";
import { weekDays } from "./week-schedule";

/**
 * Bookings' week calendar (portal redesign, third slice, owner, 1 November
 * 2026): AYA's appointments laid out Monday to Sunday in the clinic's own
 * zone, each with its time, the person's first name, the treatment and
 * whether a deposit is still owed, and a tap down to its card.
 *
 * Drawn only from what the Bookings screen has already read inside its
 * patient transaction, behind the passkey step-up, with every row in the
 * access log (readBookingsScreen): it reads nothing of its own. Pure, so
 * the layout is one table test.
 */

/** How far the calendar may be moved: the screen holds the last 30 days and everything ahead. */
export const WEEK_OFFSET_MIN = -4;
export const WEEK_OFFSET_MAX = 8;

export type WeekItem = {
  id: string;
  /** "2:00 pm". */
  time: string;
  name: string;
  treatment: string | null;
  /** "Deposit to collect" or "Deposit not paid yet", else null. */
  deposit: string | null;
  /** Cancelled or moved: drawn struck through rather than hidden. */
  inactive: boolean;
};

export type WeekColumn = {
  date: string;
  label: string;
  dayOfMonth: number;
  isToday: boolean;
  items: WeekItem[];
};

export type BookingsWeek = {
  offset: number;
  /** "This week", "Next week", "Last week", or "Week of 16 November". */
  title: string;
  days: WeekColumn[];
  /** Appointments in the week that are not cancelled or moved. */
  count: number;
};

/** The `?week=` query as a bounded whole number of weeks from this one. */
export function weekOffsetOf(value: unknown): number {
  const n = typeof value === "string" && /^-?\d{1,2}$/.test(value) ? Number(value) : 0;
  return Math.min(WEEK_OFFSET_MAX, Math.max(WEEK_OFFSET_MIN, n));
}

function zoneOr(timeZone: string): string {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return timeZone;
  } catch {
    return "America/New_York";
  }
}

function localDate(at: Date, zone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(at);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function localTime(at: Date, zone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).formatToParts(at);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("hour")}:${get("minute")} ${get("dayPeriod").toLowerCase()}`;
}

function titleOf(offset: number, monday: { date: string }): string {
  if (offset === 0) return "This week";
  if (offset === 1) return "Next week";
  if (offset === -1) return "Last week";
  const [y, m, d] = monday.date.split("-").map(Number) as [number, number, number];
  const month = new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", month: "long" }).format(
    new Date(Date.UTC(y, m - 1, d, 12)),
  );
  return `Week of ${d} ${month}`;
}

export function bookingsWeek(
  booked: readonly Pick<
    BookedAppointment,
    "id" | "firstName" | "scheduledFor" | "treatment" | "status" | "depositStatus"
  >[],
  input: { now: Date; timeZone: string; offset?: number },
): BookingsWeek {
  const zone = zoneOr(input.timeZone);
  const offset = Math.min(WEEK_OFFSET_MAX, Math.max(WEEK_OFFSET_MIN, input.offset ?? 0));
  const today = localDate(input.now, zone);
  const shifted = new Date(input.now.getTime() + offset * 7 * 86_400_000);
  const days: WeekColumn[] = weekDays(shifted, zone).map((d) => ({
    date: d.date,
    label: d.label,
    dayOfMonth: d.dayOfMonth,
    isToday: d.date === today,
    items: [],
  }));
  const byDate = new Map(days.map((d) => [d.date, d]));
  const sorted = [...booked].sort((a, b) => a.scheduledFor.getTime() - b.scheduledFor.getTime());
  let count = 0;
  for (const a of sorted) {
    const column = byDate.get(localDate(a.scheduledFor, zone));
    if (!column) continue;
    const inactive = a.status === "cancelled" || a.status === "rescheduled";
    if (!inactive) count += 1;
    column.items.push({
      id: a.id,
      time: localTime(a.scheduledFor, zone),
      name: a.firstName ?? "Someone",
      treatment: a.treatment,
      deposit: depositBadge(a, input.now)?.label ?? null,
      inactive,
    });
  }
  return { offset, title: titleOf(offset, days[0]!), days, count };
}
