import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

/**
 * directBookingOpen() (lib/booking/direct-switch.ts, DB-1 §3): the one check
 * the booking mode, the console's projection, the ops bookingSwitch reply
 * and the assistant's tools all ask. True only when the owner's env var is
 * the literal "true", the owner has released the addendum in this build (approvedByCounsel, true since 28 October 2026), and
 * HEALDESK_DIRECT_BOOKING_ADDENDUM names exactly the catalog's current
 * version. Every other row of the table is false. Read on every call.
 *
 * The release is mocked per row in this process; the committed catalog has
 * approvedByCounsel true. No database.
 */

const released = vi.hoisted(() => ({ addendum: false }));
vi.mock("@healdesk/catalog", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@healdesk/catalog")>();
  return {
    ...actual,
    currentDirectBookingAddendum: () => ({ ...actual.currentDirectBookingAddendum(), approvedByCounsel: released.addendum }),
  };
});

import { DIRECT_BOOKING_ADDENDUM_VERSION, DIRECT_BOOKING_ADDENDUMS } from "@healdesk/catalog";

import { directBookingToolsAllowed } from "@/lib/assistant/booking-tools";
import { directBookingOpen, directBookingSwitchParts } from "@/lib/booking/direct-switch";
import { env } from "@/lib/env";

const KEYS = ["HEALDESK_DIRECT_BOOKING_ENABLED", "HEALDESK_DIRECT_BOOKING_ADDENDUM"] as const;
let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
  released.addendum = false;
});

afterEach(() => {
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

function set(key: (typeof KEYS)[number], value: string | undefined) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

const ENV_VALUES = [undefined, "", "1", "TRUE", "True", "true ", "yes", "true"] as const;
const VERSION_VALUES = [
  undefined,
  "",
  "1.0.0",
  "direct-booking-addendum/0.9.0",
  ` ${DIRECT_BOOKING_ADDENDUM_VERSION}`,
  DIRECT_BOOKING_ADDENDUM_VERSION,
] as const;

const ROWS = ENV_VALUES.flatMap((envValue) =>
  VERSION_VALUES.flatMap((version) => [false, true].map((approved) => ({ envValue, version, approved }))),
);

describe("directBookingOpen", () => {
  test("the committed catalog has the addendum released by the owner (28 October 2026)", async () => {
    const { currentDirectBookingAddendum } = await vi.importActual<typeof import("@healdesk/catalog")>("@healdesk/catalog");
    expect(currentDirectBookingAddendum().approvedByCounsel).toBe(true);
    expect(currentDirectBookingAddendum().version).toBe(DIRECT_BOOKING_ADDENDUM_VERSION);
    expect(DIRECT_BOOKING_ADDENDUMS[0]!.version).toBe(DIRECT_BOOKING_ADDENDUM_VERSION);
  });

  test.each(ROWS)("env $envValue, version $version, released $approved", ({ envValue, version, approved }) => {
    set("HEALDESK_DIRECT_BOOKING_ENABLED", envValue);
    set("HEALDESK_DIRECT_BOOKING_ADDENDUM", version);
    released.addendum = approved;
    const expected = envValue === "true" && version === DIRECT_BOOKING_ADDENDUM_VERSION && approved;
    expect(directBookingOpen()).toBe(expected);
    // The tools ask the same check, and nothing else.
    expect(directBookingToolsAllowed()).toBe(expected);
    // The parts are the three facts, each on its own.
    expect(directBookingSwitchParts()).toEqual({
      open: expected,
      env: envValue === "true",
      released: approved,
      versionMatches: version === DIRECT_BOOKING_ADDENDUM_VERSION,
    });
    // The raw env value stays what it was, for the console's own tick.
    expect(env.directBookingEnabled()).toBe(envValue === "true");
  });

  test("only one row of the table is open", () => {
    const open = ROWS.filter(
      (row) => row.envValue === "true" && row.version === DIRECT_BOOKING_ADDENDUM_VERSION && row.approved,
    );
    expect(open).toHaveLength(1);
  });

  test("read on every call, never cached: pulling any one part closes the very next answer", () => {
    set("HEALDESK_DIRECT_BOOKING_ENABLED", "true");
    set("HEALDESK_DIRECT_BOOKING_ADDENDUM", DIRECT_BOOKING_ADDENDUM_VERSION);
    released.addendum = true;
    expect(directBookingOpen()).toBe(true);
    delete process.env.HEALDESK_DIRECT_BOOKING_ENABLED;
    expect(directBookingOpen()).toBe(false);
    process.env.HEALDESK_DIRECT_BOOKING_ENABLED = "true";
    expect(directBookingOpen()).toBe(true);
    released.addendum = false;
    expect(directBookingOpen()).toBe(false);
    released.addendum = true;
    process.env.HEALDESK_DIRECT_BOOKING_ADDENDUM = "direct-booking-addendum/1.0.1";
    expect(directBookingOpen()).toBe(false);
  });
});
