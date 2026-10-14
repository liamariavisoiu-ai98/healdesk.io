import { afterEach, describe, expect, test } from "vitest";

import { isMutating, isOpName, parseEnvelope, runOperation, type Operator } from "@/lib/ops/api";

/**
 * bookingSwitch: the owner's direct-booking switch, as apps/web's purchase
 * funnel asks for it (step 2's line on whether AYA books straight into the
 * calendar). The one reader is env.directBookingEnabled(), the literal "true";
 * this op only carries its answer across, so the funnel cannot keep a second
 * switch of its own. No database.
 */

const OPERATOR: Operator = { email: "ops@healdesk.test", request: {} };
const saved = process.env.HEALDESK_DIRECT_BOOKING_ENABLED;

afterEach(() => {
  if (saved === undefined) delete process.env.HEALDESK_DIRECT_BOOKING_ENABLED;
  else process.env.HEALDESK_DIRECT_BOOKING_ENABLED = saved;
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

  test("off unless the owner set exactly true", async () => {
    for (const value of [undefined, "", "1", "yes", "TRUE", "true "]) {
      if (value === undefined) delete process.env.HEALDESK_DIRECT_BOOKING_ENABLED;
      else process.env.HEALDESK_DIRECT_BOOKING_ENABLED = value;
      const outcome = await ask();
      expect(outcome.status, String(value)).toBe(200);
      expect(outcome.body, String(value)).toEqual({ data: { directBooking: false } });
    }
  });

  test("on when the owner set it", async () => {
    process.env.HEALDESK_DIRECT_BOOKING_ENABLED = "true";
    expect((await ask()).body).toEqual({ data: { directBooking: true } });
  });
});
