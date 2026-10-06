import { describe, expect, test } from "vitest";

import { bookingSyncForPlatform, NO_PLATFORM_ID, platforms } from "./platforms";

/**
 * The phase-two platform list's sync direction. Pinned because a wrong "yes"
 * lets the assistant book live into a calendar the clinic's own system never
 * reads, which is a double booking the AI made: the spec's "single most
 * damaging failure this product can produce".
 */
describe("which platforms read Google Calendar", () => {
  test("every platform answers the question", () => {
    for (const platform of platforms) {
      expect(["yes", "no", "unverified"], platform.id).toContain(platform.readsGoogleCalendar);
    }
  });

  test("only the ones the spec says read it are live", () => {
    // No booking software (Google Calendar alone), Cal.com, and HighLevel once
    // the clinic turns on the conflict calendar (spec table, commit a45cd9a).
    // Calendly is not on this list; it is a v1 booking system only.
    const live = platforms.filter((p) => bookingSyncForPlatform(p.id) === "live").map((p) => p.id);
    expect(live.sort()).toEqual([NO_PLATFORM_ID, "calcom", "gohighlevel"].sort());
  });

  test("one-way and unconfirmed systems are manual, each for its stated reason", () => {
    const answer = (id: string) => platforms.find((p) => p.id === id)!.readsGoogleCalendar;
    // Spec: Mindbody syncs one way only, Mindbody to Google.
    expect(answer("mindbody")).toBe("no");
    // Spec: Boulevard is "treat as no until confirmed in writing"; the rest
    // have no written confirmation (plan Q4).
    for (const id of ["boulevard", "zenoti", "patientnow", "acuity", "vagaro"]) {
      expect(answer(id), id).toBe("unverified");
      expect(bookingSyncForPlatform(id), id).toBe("manual");
    }
  });

  test("an unknown id, or something that is not an id, is manual", () => {
    for (const id of [
      "calendly",
      "not-a-platform",
      "",
      " calcom",
      "CALCOM",
      null,
      undefined,
      7,
      {},
    ]) {
      expect(bookingSyncForPlatform(id), String(id)).toBe("manual");
    }
  });
});
