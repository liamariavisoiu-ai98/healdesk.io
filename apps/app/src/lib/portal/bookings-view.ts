import type { AppointmentStatus, BookedAppointment } from "./bookings";

/**
 * Plain words for the Bookings screen: pure functions over fields the screen
 * already holds, so what each badge says is tested rather than scattered in
 * markup. Nothing here reads or adds patient data, and nothing writes a
 * booking: the only actions on the screen stay the existing decide, outcome
 * and handover forms.
 *
 * Claims: counts of appointments AYA booked and deposits. Never "revenue".
 */

/** How a badge is drawn; the words always carry the meaning, never the colour alone. */
export type BadgeTone = "action" | "waiting" | "done" | "neutral";

export type Badge = { label: string; tone: BadgeTone };

/** What an appointment's status means to the front desk, in plain words. */
export function appointmentStatusBadge(status: AppointmentStatus, started: boolean): Badge {
  switch (status) {
    case "scheduled":
    case "confirmed":
      return started
        ? { label: "Mark how it went", tone: "action" }
        : { label: "Booked", tone: "done" };
    case "showed":
      return { label: "Came in", tone: "done" };
    case "no_show":
      return { label: "Did not come", tone: "neutral" };
    case "cancelled":
      return { label: "Cancelled", tone: "neutral" };
    case "rescheduled":
      return { label: "Moved to another time", tone: "neutral" };
  }
}

/**
 * The deposit flag on a booking, or null when there is nothing to flag (no
 * deposit, waived or paid are said by the deposit line alone). A deposit the
 * front desk must take is an action; one with a link out is waiting on the
 * person.
 */
export function depositBadge(a: Pick<BookedAppointment, "depositStatus" | "status">): Badge | null {
  if (a.status === "cancelled" || a.status === "rescheduled") return null;
  switch (a.depositStatus) {
    case "pending_front_desk":
      return { label: "Deposit to collect", tone: "action" };
    case "pending_link":
      return { label: "Deposit not paid yet", tone: "waiting" };
    default:
      return null;
  }
}

/** The numbers at the top of the screen. */
export type BookingsGlance = {
  awaitingStaff: number;
  depositsToCollect: number;
  askedForPerson: number;
  /** Appointments AYA herself booked (not team-confirmed requests) that are still ahead. */
  upcoming: number;
};

export function bookingsGlance(
  screen: {
    open: readonly unknown[];
    deposits: readonly unknown[];
    openHandoverCount: number;
    booked: readonly Pick<BookedAppointment, "status" | "scheduledFor" | "bookedBy">[];
  },
  now: Date,
): BookingsGlance {
  return {
    awaitingStaff: screen.open.length,
    depositsToCollect: screen.deposits.length,
    askedForPerson: screen.openHandoverCount,
    upcoming: screen.booked.filter(
      (b) =>
        // "Booked by AYA" is her own bookings; a request the team confirmed is
        // in the list below but is not hers to claim.
        b.bookedBy === "assistant" &&
        (b.status === "scheduled" || b.status === "confirmed") &&
        b.scheduledFor.getTime() > now.getTime(),
    ).length,
  };
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** One sentence naming what to do first, or the all-clear. */
export function nextActionLine(g: BookingsGlance): string {
  if (g.awaitingStaff > 0) {
    return `${plural(g.awaitingStaff, "request is", "requests are")} waiting for you to confirm, propose another time or decline.`;
  }
  if (g.depositsToCollect > 0) {
    return `${plural(g.depositsToCollect, "deposit is", "deposits are")} waiting for you to collect.`;
  }
  if (g.askedForPerson > 0) {
    return `${plural(g.askedForPerson, "person has", "people have")} asked for someone on your team.`;
  }
  return "Nothing needs you right now.";
}
