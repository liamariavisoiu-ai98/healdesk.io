import { describe, expect, test } from "vitest";

import {
  appointmentStatusBadge,
  bookingsGlance,
  depositBadge,
  nextActionLine,
} from "@/lib/portal/bookings-view";

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
  test("front desk deposits are an action, links out are waiting", () => {
    expect(depositBadge({ depositStatus: "pending_front_desk", status: "confirmed" })?.tone).toBe("action");
    expect(depositBadge({ depositStatus: "pending_link", status: "confirmed" })?.tone).toBe("waiting");
  });
  test("paid, waived, none and cancelled bookings are not flagged", () => {
    for (const depositStatus of ["paid", "waived", "none"] as const) {
      expect(depositBadge({ depositStatus, status: "confirmed" })).toBeNull();
    }
    expect(depositBadge({ depositStatus: "pending_front_desk", status: "cancelled" })).toBeNull();
  });
});

describe("glance and next action", () => {
  const screen = {
    open: [{}, {}],
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
    expect(nextActionLine({ awaitingStaff: 1, depositsToCollect: 0, askedForPerson: 0, upcoming: 0 })).toMatch(
      /^1 request is waiting/,
    );
    expect(nextActionLine({ awaitingStaff: 0, depositsToCollect: 2, askedForPerson: 1, upcoming: 0 })).toMatch(
      /^2 deposits are waiting/,
    );
    expect(nextActionLine({ awaitingStaff: 0, depositsToCollect: 0, askedForPerson: 1, upcoming: 0 })).toMatch(
      /^1 person has asked/,
    );
  });
  test("all clear, and no sentence claims revenue", () => {
    expect(nextActionLine({ awaitingStaff: 0, depositsToCollect: 0, askedForPerson: 0, upcoming: 3 })).toBe(
      "Nothing needs you right now.",
    );
    expect(nextActionLine({ awaitingStaff: 3, depositsToCollect: 3, askedForPerson: 3, upcoming: 3 })).not.toMatch(
      /revenue/i,
    );
  });
});
