import { describe, expect, test, vi } from "vitest";

const links = vi.hoisted(() => ({
  calls: [] as { clinicId: string; appointmentId: string; channel: string }[],
  answer: null as
    null | { status: "open"; url: string } | { status: "unavailable"; reason: string },
}));
vi.mock("@/lib/billing/deposit-link", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/billing/deposit-link")>();
  return {
    ...actual,
    createDepositLink: async (
      clinicId: string,
      appointmentId: string,
      options: { channel: string },
    ) => {
      links.calls.push({ clinicId, appointmentId, channel: options.channel });
      return links.answer;
    },
  };
});

import { depositLinkText } from "@/lib/billing/deposit-link";
import { depositDecision, type DepositFacts } from "@/lib/billing/deposits";
import {
  bookedDepositOutcome,
  depositBranch,
  depositLinkMessage,
} from "@/lib/booking/deposit-gate";

/**
 * The booking engine's deposit gate (plan §7.6; design record §6): D's
 * decision decides, and the engine takes one of three branches from it.
 * Voice never collects; chat sends a link only through createDepositLink
 * and depositLinkText.
 */

const voice: DepositFacts = {
  channel: "voice",
  depositsEnabled: true,
  isConnected: true,
  amountUsd: 75,
  bookVoiceWithoutDeposit: true,
  bookChatWithoutDeposit: false,
  uncollectable: "hold_and_alert",
};

describe("the deposit gate", () => {
  test("each decision takes one branch: write, reserve or decline", () => {
    expect(depositBranch("book")).toBe("write");
    expect(depositBranch("book_and_flag")).toBe("write");
    expect(depositBranch("hold_and_alert")).toBe("reserve");
    // The chat's link is made for the booked appointment, so `collect` books first.
    expect(depositBranch("collect")).toBe("write");
    expect(depositBranch("decline_and_alert")).toBe("decline");
  });

  test("on a call: no deposit books; the phone switch decides between flag and decline, before the general setting", () => {
    const none = depositDecision({ ...voice, amountUsd: 0 });
    expect([none.action, depositBranch(none.action)]).toEqual(["book", "write"]);
    expect(depositDecision({ ...voice, depositsEnabled: false }).action).toBe("book");
    expect(depositDecision({ ...voice, isConnected: false }).action).toBe("book");

    const on = depositDecision(voice);
    expect(on).toMatchObject({ action: "book_and_flag", amountUsd: 75, isRequired: true });
    expect(depositBranch(on.action)).toBe("write");

    // "When a deposit cannot be collected" says hold; the phone switch, Off, wins.
    const off = depositDecision({ ...voice, bookVoiceWithoutDeposit: false });
    expect(off).toMatchObject({ action: "decline_and_alert", amountUsd: 75 });
    expect(depositBranch(off.action)).toBe("decline");
  });

  test("a booking already in the calendar can only flag a deposit that is due", () => {
    const off = depositDecision({ ...voice, bookVoiceWithoutDeposit: false });
    expect(bookedDepositOutcome(off)).toMatchObject({ action: "book_and_flag", amountUsd: 75 });
    const hold = depositDecision({ ...voice, channel: "web", uncollectable: "hold_and_alert" });
    expect(hold.action).toBe("hold_and_alert");
    expect(bookedDepositOutcome(hold).action).toBe("book_and_flag");
    const none = depositDecision({ ...voice, amountUsd: null });
    expect(bookedDepositOutcome(none)).toBe(none);
    const collect = depositDecision({ ...voice, channel: "web", canCollectNow: true });
    expect(bookedDepositOutcome(collect).action).toBe("collect");
  });

  test("on Meta (a desk confirmation, DEP-META slice 1): a link only when it can be sent now, otherwise the front desk once booked", () => {
    const meta: DepositFacts = { ...voice, channel: "meta", uncollectable: "decline_and_alert" };
    expect(depositDecision({ ...meta, canCollectNow: true })).toMatchObject({ action: "collect", amountUsd: 75, rule: "chat_collect" });
    // The window closing, or the switches withholding the line: never a link,
    // and a booking the desk already made is never declined for its deposit.
    const closed = depositDecision({ ...meta, canCollectNow: false });
    expect(closed.action).toBe("decline_and_alert");
    expect(bookedDepositOutcome(closed)).toMatchObject({ action: "book_and_flag", amountUsd: 75 });
    expect(bookedDepositOutcome(depositDecision({ ...meta, uncollectable: "hold_and_alert" })).action).toBe("book_and_flag");
    // "Book by chat without a deposit" flags it even with the window open.
    expect(depositDecision({ ...meta, bookChatWithoutDeposit: true, canCollectNow: true }).action).toBe("book_and_flag");
    // No deposit due: nothing to collect, on Meta as anywhere.
    expect(depositDecision({ ...meta, depositsEnabled: false, canCollectNow: true }).action).toBe("book");
    expect(depositDecision({ ...meta, isConnected: false, canCollectNow: true }).action).toBe("book");
  });

  test("a chat channel's deposit message is createDepositLink's URL inside depositLinkText, nothing more", async () => {
    links.answer = { status: "open", url: "https://checkout.stripe.test/c/pay/cs_synthetic" };
    const message = await depositLinkMessage("clinic-1", "appointment-1", "meta");
    expect(message).toBe(depositLinkText("https://checkout.stripe.test/c/pay/cs_synthetic"));
    expect(links.calls).toEqual([
      { clinicId: "clinic-1", appointmentId: "appointment-1", channel: "meta" },
    ]);

    links.answer = { status: "unavailable", reason: "not_connected" };
    expect(await depositLinkMessage("clinic-1", "appointment-1", "web")).toBeNull();
  });
});
