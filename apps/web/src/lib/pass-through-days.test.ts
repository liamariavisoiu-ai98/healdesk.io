import { FORWARDING_PASS_THROUGH_DAYS } from "@healdesk/catalog";
import { describe, expect, test } from "vitest";

import { POLICY } from "@/lib/legal";

/**
 * Terms § 7 promises that forwarded calls are passed straight through to the
 * Practice's direct line for at least POLICY.forwardingPassThroughDays after
 * the service ends. apps/app's end-of-service email (`canceled`) states the
 * number too, and it cannot import apps/web, so it reads the catalog's
 * FORWARDING_PASS_THROUGH_DAYS. Two copies of a promise drift unless one is
 * held to the other: change either and this fails until both say the same.
 */
describe("the pass-through promise", () => {
  test("the terms and the catalog promise the same number of days", () => {
    expect(POLICY.forwardingPassThroughDays).toBe(FORWARDING_PASS_THROUGH_DAYS);
  });
});
