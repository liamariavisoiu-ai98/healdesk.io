import { describe, expect, test } from "vitest";

import type { AttentionItem } from "@/lib/portal/attention";
import { needItems, needsYouEmptyLine, weekHeadline } from "@/lib/portal/home-summary";
import type { ClaimsPayload } from "@/lib/reporting/claim-words";

const NOW = new Date("2026-03-10T12:00:00Z");

const base: ClaimsPayload = {
  handledCount: 0,
  voiceCount: null,
  webCount: null,
  metaCount: null,
  rangOutCount: null,
  isRequestMode: false,
  requestsTakenCount: 0,
  requestsConfirmedCount: 0,
  bookedByAyaCount: 0,
  bookedValueCents: 0,
  pricedBookingsCount: 0,
  perUnitBookingsCount: 0,
  unpricedBookingsCount: 0,
  depositsCollectedCount: 0,
  depositsCollectedCents: 0,
  urgentCount: 0,
  handoverCount: 0,
};

describe("weekHeadline", () => {
  test("empty week says AYA is designed to answer, with no figure", () => {
    expect(weekHeadline(base)).toBe(
      "No conversations in the last 7 days yet. AYA is designed to answer the moment someone gets in touch.",
    );
  });
  test("one conversation, singular", () => {
    expect(weekHeadline({ ...base, handledCount: 1 })).toBe("AYA handled 1 conversation.");
  });
  test("conversations, bookings and requests", () => {
    expect(
      weekHeadline({ ...base, handledCount: 12, bookedByAyaCount: 3, requestsTakenCount: 2 }),
    ).toBe("AYA handled 12 conversations, booked 3 appointments and took 2 booking requests.");
  });
  test("calls that would have rung out", () => {
    expect(weekHeadline({ ...base, handledCount: 4, voiceCount: 4, rangOutCount: 2 })).toBe(
      "AYA handled 4 conversations. 2 calls would otherwise have rung out.",
    );
  });
  test("never claims revenue or payments", () => {
    const text = weekHeadline({
      ...base,
      handledCount: 9,
      bookedByAyaCount: 2,
      depositsCollectedCount: 1,
      depositsCollectedCents: 5000,
    });
    expect(text).not.toMatch(/revenue|collected|recovered/i);
  });
});

describe("needItems", () => {
  const attention: AttentionItem[] = [
    { id: "passkey", text: "Add a device.", action: { label: "Add", href: "/c/x/step-up" } },
  ];
  const input = {
    waiting: null,
    endedEarly: 0,
    attention,
    bookingsHref: "/c/x/bookings",
    conversationsHref: "/c/x/conversations",
    now: NOW,
    weekDays: 7,
  };
  test("only attention items when nothing waits", () => {
    expect(needItems(input).map((i) => i.key)).toEqual(["passkey"]);
  });
  test("waiting and ended-early come first, with their links", () => {
    const items = needItems({
      ...input,
      waiting: { toCallBack: 2, oldestSince: null, depositsToCollect: 0 },
      endedEarly: 1,
    });
    expect(items.map((i) => i.key)).toEqual(["waiting", "ended_early", "passkey"]);
    expect(items[0]!.text).toBe("Waiting for you: 2 people to call back");
    expect(items[0]!.action?.href).toBe("/c/x/bookings");
    expect(items[1]!.text).toContain("1 call ended early in the last 7 days");
  });
  test("zero waiting counts add nothing; an unbuilt screen leaves no dead link", () => {
    const items = needItems({
      ...input,
      waiting: { toCallBack: 0, oldestSince: null, depositsToCollect: 0 },
      endedEarly: 3,
      conversationsHref: null,
    });
    expect(items.map((i) => i.key)).toEqual(["ended_early", "passkey"]);
    expect(items[0]!.action).toBeNull();
  });
  test("empty when there is nothing", () => {
    expect(needItems({ ...input, attention: [] })).toEqual([]);
  });
});

describe("needsYouEmptyLine", () => {
  test("says AYA is answering only when she is", () => {
    expect(needsYouEmptyLine(true)).toMatch(/AYA is answering/);
    expect(needsYouEmptyLine(false)).toBe("Nothing needs you right now.");
  });
});
