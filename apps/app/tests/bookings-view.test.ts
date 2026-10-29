import { describe, expect, test } from "vitest";

import {
  appointmentStatusBadge,
  bookingsGlance,
  depositBadge,
  nextActionLine,
  requestStatusBadge,
} from "@/lib/portal/bookings-view";
import { isDepositToCollect } from "@/lib/portal/bookings";

const NOW = new Date("2026-03-10T12:00:00Z");
const LATER = new Date("2026-03-11T12:00:00Z");
const EARLIER = new Date("2026-03-09T12:00:00Z");

describe("appointment status words", () => {
  test("an appointment ahead is Booked; one that has started asks for an outcome", () => {
    expect(appointmentStatusBadge("confirmed", false)).toEqual({ label: "Booked", tone: "done" });
    expect(appointmentStatusBadge("scheduled", true).tone).toBe("action");
  });
  test("settled outcomes use plain words", () => {
    expect(appointmentStatusBadge("showed", true).label).toBe("Came in");
    expect(appointmentStatusBadge("no_show", true).label).toBe("Did not come");
    expect(appointmentStatusBadge("cancelled", false).label).toBe("Cancelled");
    expect(appointmentStatusBadge("rescheduled", false).label).toBe("Moved to another time");
  });
});

describe("deposit flag", () => {
  const ahead = { scheduledFor: LATER };
  test("front desk deposits are an action, links out are waiting", () => {
    expect(depositBadge({ depositStatus: "pending_front_desk", status: "confirmed", ...ahead }, NOW)?.tone).toBe("action");
    expect(depositBadge({ depositStatus: "pending_link", status: "confirmed", ...ahead }, NOW)?.tone).toBe("waiting");
  });
  test("paid, waived, none and cancelled bookings are not flagged", () => {
    for (const depositStatus of ["paid", "waived", "none"] as const) {
      expect(depositBadge({ depositStatus, status: "confirmed", ...ahead }, NOW)).toBeNull();
    }
    expect(depositBadge({ depositStatus: "pending_front_desk", status: "cancelled", ...ahead }, NOW)).toBeNull();
  });
  test("'Deposit to collect' agrees with the chip: only ahead and live", () => {
    for (const status of ["scheduled", "confirmed", "showed", "no_show"] as const) {
      for (const scheduledFor of [LATER, EARLIER]) {
        const a = { depositStatus: "pending_front_desk" as const, status, scheduledFor };
        const badge = depositBadge(a, NOW);
        expect(badge?.label === "Deposit to collect").toBe(isDepositToCollect(a, NOW));
      }
    }
  });
});

describe("glance and next action", () => {
  const screen = {
    open: [{ status: "requested" as const }, { status: "requested" as const }],
    deposits: [{}],
    openHandoverCount: 0,
    booked: [
      { status: "confirmed" as const, scheduledFor: LATER, bookedBy: "assistant" as const },
      { status: "cancelled" as const, scheduledFor: LATER, bookedBy: "assistant" as const },
      { status: "confirmed" as const, scheduledFor: EARLIER, bookedBy: "assistant" as const },
    ],
  };
  test("counts only what is ahead and live", () => {
    expect(bookingsGlance(screen, NOW)).toEqual({
      awaitingStaff: 2,
      toDecide: 2,
      toArrange: 0,
      depositsToCollect: 1,
      askedForPerson: 0,
      upcoming: 1,
    });
  });
  test("team-confirmed bookings are not counted as booked by AYA", () => {
    const booked = [
      { status: "confirmed" as const, scheduledFor: LATER, bookedBy: "assistant" as const },
      ...[1, 2, 3].map(() => ({ status: "confirmed" as const, scheduledFor: LATER, bookedBy: "team" as const })),
    ];
    expect(bookingsGlance({ ...screen, booked }, NOW).upcoming).toBe(1);
  });
  test("requests come first in the next-action sentence", () => {
    expect(nextActionLine(bookingsGlance(screen, NOW))).toMatch(/^2 requests are waiting/);
    expect(nextActionLine({ awaitingStaff: 1, toDecide: 1, toArrange: 0, depositsToCollect: 0, askedForPerson: 0, upcoming: 0 })).toMatch(
      /^1 request is waiting/,
    );
    expect(nextActionLine({ awaitingStaff: 0, toDecide: 0, toArrange: 0, depositsToCollect: 2, askedForPerson: 1, upcoming: 0 })).toMatch(
      /^2 deposits are waiting/,
    );
    expect(nextActionLine({ awaitingStaff: 0, toDecide: 0, toArrange: 0, depositsToCollect: 0, askedForPerson: 1, upcoming: 0 })).toMatch(
      /^1 person has asked/,
    );
  });
  test("accepted and rescheduling requests are a call to make, not a decision", () => {
    const g = bookingsGlance(
      { ...screen, open: [{ status: "accepted" as const }, { status: "rescheduling" as const }] },
      NOW,
    );
    expect(g).toMatchObject({ awaitingStaff: 2, toDecide: 0, toArrange: 2 });
    const line = nextActionLine(g);
    expect(line).toBe("2 requests need a call to arrange a time.");
    expect(line).not.toMatch(/confirm|decline|propose/);
    const mixed = bookingsGlance(
      { ...screen, open: [{ status: "requested" as const }, { status: "accepted" as const }] },
      NOW,
    );
    expect(nextActionLine(mixed)).toMatch(/^1 request is waiting for you to confirm.*1 more needs a call/);
  });
  test("request badges: rescheduling is an action, never a wait on the person", () => {
    expect(requestStatusBadge("requested").label).toMatch(/confirm, propose or decline/);
    for (const status of ["accepted", "rescheduling"] as const) {
      expect(requestStatusBadge(status)).toEqual({ label: "Call to arrange a time", tone: "action" });
    }
  });
  test("all clear, and no sentence claims revenue", () => {
    expect(nextActionLine({ awaitingStaff: 0, toDecide: 0, toArrange: 0, depositsToCollect: 0, askedForPerson: 0, upcoming: 3 })).toBe(
      "Nothing needs you right now.",
    );
    expect(nextActionLine({ awaitingStaff: 3, toDecide: 3, toArrange: 0, depositsToCollect: 3, askedForPerson: 3, upcoming: 3 })).not.toMatch(
      /revenue/i,
    );
  });
});
