import { describe, expect, test } from "vitest";

import {
  BOOKING_SYSTEMS,
  bookingSyncFor,
  bookingSystemName,
  getBookingSystem,
  isBookingSystemId,
  manualBookingNotice,
} from "./booking-systems";
import { bookingSyncForPlatform, getPlatform } from "./platforms";

/**
 * The v1 booking-system list is a contract with the funnel, which builds the
 * "Where do bookings live today?" question from it (plan addendum, 6 October
 * 2026), and with the agreement, which derives the calendar clause from it.
 * The order and every value are pinned; changing one is a decision, not a
 * refactor.
 */
describe("the v1 booking systems", () => {
  test("are the agreed eight, in the agreed order, with the agreed answers", () => {
    expect(
      BOOKING_SYSTEMS.map((s) => [s.id, s.label, s.readsGoogleCalendar, s.phaseTwoPlatformId]),
    ).toEqual([
      ["google_calendar", "Google Calendar only", "yes", null],
      ["calendly", "Calendly", "yes", null],
      ["calcom", "Cal.com", "yes", "calcom"],
      ["gohighlevel", "HighLevel", "yes", "gohighlevel"],
      ["mindbody", "Mindbody", "no", "mindbody"],
      ["boulevard", "Boulevard", "unverified", "boulevard"],
      ["other", "Something else", "unverified", null],
      ["none", "No booking system yet", "yes", null],
    ]);
  });

  test("HighLevel's card names the one setting the clinic must turn on, and links HighLevel's own page", () => {
    // The spec's table says yes only for a Google calendar the clinic turns
    // on as a conflict calendar in HighLevel; saying so before purchase is
    // the spec's "say which applies before you buy".
    const highlevel = getBookingSystem("gohighlevel")!;
    expect(highlevel.setupNote).toMatch(/conflict calendar/);
    expect(highlevel.setupNote).toMatch(
      /HighLevel then stops offering any time your assistant has booked/,
    );
    expect(highlevel.setupHelpUrl).toBe(
      "https://help.gohighlevel.com/support/solutions/articles/155000002374",
    );
    for (const system of BOOKING_SYSTEMS.filter((s) => s.id !== "gohighlevel")) {
      expect(system.setupNote, system.id).toBeNull();
      expect(system.setupHelpUrl, system.id).toBeNull();
    }
  });

  test("agree with the phase-two list wherever the same system is on both", () => {
    // An agreement before 1.3.0 names the phase-two platform, and the funnel
    // reads this list: two answers about one system would let a clinic book
    // live under one list and be told it is manual under the other.
    for (const system of BOOKING_SYSTEMS) {
      if (system.phaseTwoPlatformId === null) continue;
      const platform = getPlatform(system.phaseTwoPlatformId);
      expect(platform, system.id).toBeDefined();
      expect(platform!.readsGoogleCalendar, system.id).toBe(system.readsGoogleCalendar);
      expect(bookingSyncForPlatform(platform!.id), system.id).toBe(bookingSyncFor(system.id));
    }
  });
});

describe("the sync each answer gives", () => {
  test("only a system that reads Google Calendar books live", () => {
    const live = BOOKING_SYSTEMS.filter((s) => bookingSyncFor(s.id) === "live").map((s) => s.id);
    expect(live).toEqual(["google_calendar", "calendly", "calcom", "gohighlevel", "none"]);
    expect(bookingSyncFor("mindbody")).toBe("manual");
    expect(bookingSyncFor("boulevard")).toBe("manual");
    expect(bookingSyncFor("other")).toBe("manual");
  });

  test("an unknown answer is manual, never live", () => {
    for (const id of ["zenoti", "acuity", "Calendly", "", "none ", null, undefined, 1, {}]) {
      expect(bookingSyncFor(id), String(id)).toBe("manual");
      expect(isBookingSystemId(id), String(id)).toBe(false);
      expect(getBookingSystem(id), String(id)).toBeUndefined();
    }
    for (const system of BOOKING_SYSTEMS) expect(isBookingSystemId(system.id)).toBe(true);
  });
});

describe("naming the clinic's system in a sentence", () => {
  test("names products, and never an answer that is not one", () => {
    expect(bookingSystemName("calendly")).toBe("Calendly");
    expect(bookingSystemName("calcom")).toBe("Cal.com");
    expect(bookingSystemName("gohighlevel")).toBe("HighLevel");
    expect(bookingSystemName("mindbody")).toBe("Mindbody");
    expect(bookingSystemName("boulevard")).toBe("Boulevard");
    // Google Calendar alone is the calendar healdesk connects to, not a
    // system it holds no credentials to; the other two are not names.
    expect(bookingSystemName("google_calendar")).toBeNull();
    expect(bookingSystemName("other")).toBeNull();
    expect(bookingSystemName("none")).toBeNull();
  });

  const UNNAMED_NOTICE =
    "Your booking system doesn't read Google Calendar, or we haven't confirmed that it does, " +
    "so your assistant takes each booking as a request and your staff confirm it in your " +
    "booking system.";

  test("the manual-booking notice, worded as the plan gives it", () => {
    expect(manualBookingNotice("Mindbody")).toBe(
      "Mindbody doesn't read Google Calendar, or we haven't confirmed that it does, so your " +
        "assistant takes each booking as a request and your staff confirm it in Mindbody.",
    );
    // "Something else" names no product, so the notice does not pretend it
    // does, called the way the funnel calls it: with the answer's label.
    expect(manualBookingNotice(getBookingSystem("other")!.label)).toBe(UNNAMED_NOTICE);
    expect(manualBookingNotice(bookingSystemName("other"))).toBe(UNNAMED_NOTICE);
    expect(manualBookingNotice("  ")).toBe(UNNAMED_NOTICE);
    expect(manualBookingNotice(null)).toBe(UNNAMED_NOTICE);
    // A phase-two platform's name is a product's name.
    expect(manualBookingNotice("Zenoti")).toMatch(/^Zenoti doesn't read Google Calendar/);
  });

  test("every manual answer gets the same notice by its label, its id or its name", () => {
    const manual = BOOKING_SYSTEMS.filter((s) => bookingSyncFor(s.id) === "manual");
    expect(manual.map((s) => s.id)).toEqual(["mindbody", "boulevard", "other"]);
    for (const system of manual) {
      const expected = manualBookingNotice(bookingSystemName(system.id));
      for (const asked of [system.label, ` ${system.label} `, system.id]) {
        const notice = manualBookingNotice(asked);
        expect(notice, asked).toBe(expected);
        expect(notice, asked).not.toContain("Something else");
        expect(notice, asked).toMatch(/takes each booking as a request/);
      }
    }
    expect(manualBookingNotice("Boulevard")).toMatch(/confirm it in Boulevard\.$/);
  });
});
