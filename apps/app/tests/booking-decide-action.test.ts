import { beforeEach, describe, expect, test, vi } from "vitest";

/**
 * The desk page's "Confirm anyway" (plan §7.10 step 2): when Google shows the
 * time busy, the action answers with a second form that confirms exactly
 * that time regardless, and the confirmation is audited. It must carry who
 * confirmed it and their note as the first form had them; without them the
 * audited override names nobody. Everything below the action is mocked.
 */

const mocks = vi.hoisted(() => ({
  decide: vi.fn(),
  redirect: vi.fn((url: string) => {
    throw Object.assign(new Error("NEXT_REDIRECT"), { url });
  }),
}));

vi.mock("next/navigation", () => ({
  redirect: mocks.redirect,
  RedirectType: { replace: "replace", push: "push" },
}));
vi.mock("@/app/connect/[token]/request-context", () => ({
  connectRequestContext: async () => ({ ipAddress: null, userAgent: null }),
}));
vi.mock("@/lib/connections/attempt-limit", () => ({ withinConnectAttemptLimit: () => true }));
vi.mock("@/lib/meta/booking-requests", () => ({
  decideBookingRequest: mocks.decide,
  MAX_PROPOSED_SLOTS: 3,
}));

import { decideRequest } from "@/app/booking/[token]/actions";

const TOKEN = "T".repeat(43);

describe("Confirm anyway", () => {
  beforeEach(() => {
    mocks.decide.mockReset();
    mocks.redirect.mockClear();
  });

  test("the busy answer carries the desk's name and note into the form that confirms anyway", async () => {
    const at = new Date(Date.now() + 3 * 86_400_000).toISOString();
    mocks.decide.mockResolvedValueOnce({
      outcome: "calendar_busy",
      followUp: null,
      appointmentId: null,
      calendarWrite: null,
    });
    const first = new FormData();
    first.set("token", TOKEN);
    first.set("decision", "confirmed");
    first.set("slotAt", at);
    first.set("treatment", "Facial");
    first.set("name", "Jo");
    first.set("note", "Checked with Dr Lee");
    const busy = await decideRequest({ status: "idle" }, first);
    expect(busy).toMatchObject({
      status: "busy",
      slotAt: at,
      treatment: "Facial",
      name: "Jo",
      note: "Checked with Dr Lee",
    });

    // What the second form posts (DecideForm's hidden inputs): the same
    // time, name and note, and addAnyway.
    if (busy.status !== "busy") throw new Error("unreachable");
    mocks.decide.mockResolvedValueOnce({
      outcome: "decided",
      followUp: null,
      appointmentId: "00000000-0000-4000-8000-000000000001",
      calendarWrite: "written",
    });
    const anyway = new FormData();
    anyway.set("token", TOKEN);
    anyway.set("decision", "confirmed");
    anyway.set("slotAt", busy.slotAt);
    anyway.set("treatment", busy.treatment ?? "");
    anyway.set("name", busy.name ?? "");
    anyway.set("note", busy.note ?? "");
    anyway.set("addAnyway", "1");
    await expect(decideRequest(busy, anyway)).rejects.toThrow("NEXT_REDIRECT");
    expect(mocks.decide).toHaveBeenLastCalledWith(
      TOKEN,
      "confirmed",
      expect.objectContaining({
        confirmedFor: new Date(at),
        decidedByLabel: "Jo",
        deskNote: "Checked with Dr Lee",
        addAnyway: true,
      }),
    );
  });
});
