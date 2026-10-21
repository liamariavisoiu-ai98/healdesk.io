import { describe, expect, test } from "vitest";

import { bookingDepositLine } from "@/lib/portal/bookings";

/**
 * What the Bookings screen says about a booking's deposit. `pending_link` is
 * written with the booking and the link is made after it, so it is "sent"
 * only once a link exists; until then it is being prepared, and if it is never
 * made the sweep hands it to the front desk (billing/deposit-sweep.ts).
 */

const line = (depositStatus: Parameters<typeof bookingDepositLine>[0]["depositStatus"], depositUsd: string | null, depositLinkMade = false) =>
  bookingDepositLine({ depositStatus, depositUsd, depositLinkMade });

describe("the deposit line on a booking", () => {
  test("a link still to be made is being prepared, never sent", () => {
    expect(line("pending_link", "50.00")).toBe("Deposit of $50: payment link being prepared, not paid yet");
    expect(line("pending_link", null)).toBe("Deposit: payment link being prepared, not paid yet");
    expect(line("pending_link", "50.00")).not.toMatch(/\bsent\b/);
  });

  test("a link that exists is sent", () => {
    expect(line("pending_link", "50.00", true)).toBe("Deposit of $50: payment link sent, not paid yet");
  });

  test("the other states read as they did", () => {
    expect(line("pending_front_desk", "50.00")).toBe("Deposit of $50 to collect: call them");
    expect(line("paid", "50.00", true)).toBe("Deposit of $50 paid");
    expect(line("waived", null)).toBe("Deposit waived");
    expect(line("none", null)).toBe("No deposit");
  });

  test("an amount that is not a positive number is left out rather than printed", () => {
    for (const bad of ["0", "-5", "abc", null]) {
      expect(line("pending_link", bad), String(bad)).toBe("Deposit: payment link being prepared, not paid yet");
    }
  });
});
