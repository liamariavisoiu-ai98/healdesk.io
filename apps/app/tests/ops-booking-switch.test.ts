import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

/**
 * bookingSwitch: the owner's direct-booking switch, as apps/web's purchase
 * funnel and the console ask for it (step 2's line on whether AYA books
 * straight into the calendar; Compliance › Launch's three ticks). Its one
 * answer is directBookingOpen() (lib/booking/direct-switch.ts, DB-1): the
 * env var's literal "true" AND counsel's released addendum AND a matching
 * HEALDESK_DIRECT_BOOKING_ADDENDUM. The reply is four booleans, the same for
 * everyone, with no clinic data: `directBooking` (the answer, the key's old
 * meaning) and `env`, `released`, `versionMatches` (its parts). No database.
 *
 * Counsel's release is mocked here only; the committed catalog keeps it false.
 */

const released = vi.hoisted(() => ({ addendum: false }));
vi.mock("@healdesk/catalog", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@healdesk/catalog")>();
  return {
    ...actual,
    currentDirectBookingAddendum: () => ({ ...actual.currentDirectBookingAddendum(), approvedByCounsel: released.addendum }),
  };
});

import { DIRECT_BOOKING_ADDENDUM_VERSION } from "@healdesk/catalog";

import { isMutating, isOpName, parseEnvelope, runOperation, type Operator } from "@/lib/ops/api";

const OPERATOR: Operator = { email: "ops@healdesk.test", request: {} };
const KEYS = ["HEALDESK_DIRECT_BOOKING_ENABLED", "HEALDESK_DIRECT_BOOKING_ADDENDUM"] as const;
let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
  for (const key of KEYS) delete process.env[key];
  released.addendum = false;
});

afterEach(() => {
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

async function ask() {
  const parsed = parseEnvelope(JSON.stringify({ op: "bookingSwitch", args: {} }));
  if (!parsed.ok) throw new Error("bookingSwitch is not an operation");
  return runOperation(parsed.envelope.op, parsed.envelope.args, OPERATOR);
}

describe("bookingSwitch", () => {
  test("is a read: on the list, off the mutating half", () => {
    expect(isOpName("bookingSwitch")).toBe(true);
    expect(isMutating("bookingSwitch")).toBe(false);
  });

  test("the env var off unless the owner set exactly true, whatever else holds", async () => {
    released.addendum = true;
    process.env.HEALDESK_DIRECT_BOOKING_ADDENDUM = DIRECT_BOOKING_ADDENDUM_VERSION;
    for (const value of [undefined, "", "1", "yes", "TRUE", "true "]) {
      if (value === undefined) delete process.env.HEALDESK_DIRECT_BOOKING_ENABLED;
      else process.env.HEALDESK_DIRECT_BOOKING_ENABLED = value;
      const outcome = await ask();
      expect(outcome.status, String(value)).toBe(200);
      expect(outcome.body, String(value)).toEqual({
        data: { directBooking: false, env: false, released: true, versionMatches: true },
      });
    }
  });

  test("the env var alone, with the addendum unreleased in the build, is not on", async () => {
    process.env.HEALDESK_DIRECT_BOOKING_ENABLED = "true";
    expect((await ask()).body).toEqual({
      data: { directBooking: false, env: true, released: false, versionMatches: false },
    });
    process.env.HEALDESK_DIRECT_BOOKING_ADDENDUM = DIRECT_BOOKING_ADDENDUM_VERSION;
    expect((await ask()).body).toEqual({
      data: { directBooking: false, env: true, released: false, versionMatches: true },
    });
  });

  test("released, with the version missing or naming another addendum, is not on", async () => {
    process.env.HEALDESK_DIRECT_BOOKING_ENABLED = "true";
    released.addendum = true;
    for (const version of [undefined, "", "direct-booking-addendum/0.9.0", "1.0.0"]) {
      if (version === undefined) delete process.env.HEALDESK_DIRECT_BOOKING_ADDENDUM;
      else process.env.HEALDESK_DIRECT_BOOKING_ADDENDUM = version;
      expect((await ask()).body, String(version)).toEqual({
        data: { directBooking: false, env: true, released: true, versionMatches: false },
      });
    }
  });

  test("on only when all three hold", async () => {
    process.env.HEALDESK_DIRECT_BOOKING_ENABLED = "true";
    process.env.HEALDESK_DIRECT_BOOKING_ADDENDUM = DIRECT_BOOKING_ADDENDUM_VERSION;
    released.addendum = true;
    expect((await ask()).body).toEqual({
      data: { directBooking: true, env: true, released: true, versionMatches: true },
    });
  });
});
