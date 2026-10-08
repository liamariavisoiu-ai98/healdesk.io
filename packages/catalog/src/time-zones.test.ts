import { describe, expect, test } from "vitest";

import {
  clinicTimeZone,
  DEFAULT_CLINIC_TIME_ZONE,
  isKnownTimeZone,
  timeZoneForUsAddress,
  US_TIME_ZONES,
} from "./time-zones";

/**
 * Provisioning places a clinic in a time zone from its address, then the
 * buyer's browser, then New York. The address rule must be right for the
 * common case and never confidently wrong: an address it cannot read is null.
 */

describe("timeZoneForUsAddress", () => {
  test("reads the state from the abbreviation and ZIP almost every US address ends in", () => {
    expect(timeZoneForUsAddress("1200 Congress Ave, Austin, TX 78701")).toBe("America/Chicago");
    expect(timeZoneForUsAddress("88 Pine St, Suite 4, New York, NY 10005-1801")).toBe(
      "America/New_York",
    );
    expect(timeZoneForUsAddress("500 Main Street, Boise, ID 83702")).toBe("America/Denver");
    expect(timeZoneForUsAddress("2 Camelback Rd, Phoenix, AZ 85016")).toBe("America/Phoenix");
    expect(timeZoneForUsAddress("1 Market St, San Francisco, CA, 94105")).toBe(
      "America/Los_Angeles",
    );
    expect(timeZoneForUsAddress("1450 Ala Moana Blvd, Honolulu, HI 96814")).toBe(
      "Pacific/Honolulu",
    );
  });

  test("a street named after a state does not outrank the state the address ends in", () => {
    expect(timeZoneForUsAddress("1 Washington St, Austin, TX 78701")).toBe("America/Chicago");
    expect(timeZoneForUsAddress("1600 Pennsylvania Ave NW, Washington, DC 20500")).toBe(
      "America/New_York",
    );
  });

  test("reads a trailing abbreviation without a ZIP, and a state written out", () => {
    expect(timeZoneForUsAddress("42 Elm St, Denver, CO")).toBe("America/Denver");
    expect(timeZoneForUsAddress("42 Elm St, Seattle, Washington 98101")).toBe(
      "America/Los_Angeles",
    );
    expect(timeZoneForUsAddress("10 Main St, Charleston, west virginia")).toBe("America/New_York");
  });

  test("gives null rather than a guess for an address it cannot place", () => {
    expect(timeZoneForUsAddress(null)).toBeNull();
    expect(timeZoneForUsAddress("")).toBeNull();
    expect(timeZoneForUsAddress("Unit 3, the old mill")).toBeNull();
    expect(timeZoneForUsAddress("10 Downing Street, London SW1A 2AA")).toBeNull();
    // Two lower-case letters are a word, not a state.
    expect(timeZoneForUsAddress("12 Oak Lane, come in")).toBeNull();
  });

  test("every zone it can give is one the runtime knows and the wizard offers", () => {
    const offered = new Set(US_TIME_ZONES.map((z) => z.id));
    for (const zone of US_TIME_ZONES) expect(isKnownTimeZone(zone.id), zone.id).toBe(true);
    const states = ["TX", "NY", "CA", "AZ", "HI", "AK", "PR", "MI", "IN", "ID", "CO"];
    for (const code of states) {
      const zone = timeZoneForUsAddress(`1 Main St, Town, ${code} 00000`);
      expect(zone, code).not.toBeNull();
      expect(offered.has(zone!), code).toBe(true);
    }
  });
});

describe("clinicTimeZone", () => {
  test("the address first, then the browser, then New York", () => {
    expect(
      clinicTimeZone({
        address: "1200 Congress Ave, Austin, TX 78701",
        browserTimeZone: "America/Los_Angeles",
      }),
    ).toBe("America/Chicago");
    expect(clinicTimeZone({ address: null, browserTimeZone: "America/Los_Angeles" })).toBe(
      "America/Los_Angeles",
    );
    expect(clinicTimeZone({ address: "somewhere", browserTimeZone: "Not/AZone" })).toBe(
      DEFAULT_CLINIC_TIME_ZONE,
    );
    expect(clinicTimeZone({})).toBe("America/New_York");
  });
});
