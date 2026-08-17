import { describe, expect, test } from "vitest";

import { assertNoPhi, PhiInAuditError } from "@/lib/audit";
import { assertNoPhiInPayload, PayloadContentError } from "@/lib/queue/boss";

/**
 * Two guards that protect places PHI could sit outside every other control.
 *
 * The queue's tables live in pg-boss's own schema, which has no clinic_id and
 * no RLS. The audit log is protected, but an audit row that quotes the data it
 * describes defeats the point of having one. Both are enforced in code because
 * both are the kind of rule that erodes the first time someone is in a hurry.
 */

describe("job payloads", () => {
  test("ids and period keys are allowed through", () => {
    expect(() =>
      assertNoPhiInPayload({
        clinicId: "11111111-1111-4111-8111-111111111111",
        connectionId: "22222222-2222-4222-8222-222222222222",
        periodKey: "2026-07",
      }),
    ).not.toThrow();
  });

  test("anything not on the allowlist is refused, however innocent it looks", () => {
    // An allowlist, not a blocklist: `patientName` would sail past any
    // pattern-matching check, and this is the field someone adds "just for
    // logging" at 2am.
    expect(() => assertNoPhiInPayload({ patientName: "Jane Doe" })).toThrow(
      PayloadContentError,
    );
    expect(() => assertNoPhiInPayload({ amountUsd: "550.00" })).toThrow(
      PayloadContentError,
    );
  });

  test("payload values must be strings, so nothing nests out of sight", () => {
    expect(() =>
      assertNoPhiInPayload({ clinicId: { id: "nested" } as never }),
    ).toThrow(PayloadContentError);
  });
});

describe("audit metadata", () => {
  test("a phone number in metadata fails the write", () => {
    expect(() => assertNoPhi({ note: "called +1 555 010 1234" })).toThrow(
      PhiInAuditError,
    );
  });

  test("an email in metadata fails the write", () => {
    expect(() => assertNoPhi({ note: "jane@example.test" })).toThrow(
      PhiInAuditError,
    );
  });

  test("our own uuids are not phone numbers", () => {
    // Regression: PHONE_LIKE matches the digit-heavy middle of some uuids
    // ("…-5678-4901-…"), so before the fix this threw for roughly one uuid in
    // a handful — at random, with a message accusing the caller of leaking a
    // phone number. Intermittent false positives get diagnosed as flakiness,
    // and then the guard gets weakened.
    const awkward = [
      "0d1e2f34-5678-4901-a234-56789abcdef0",
      "11111111-2222-3333-4444-555555555555",
      "4ce8543a-aeb7-4ec4-922c-3abd12dc2689",
    ];

    for (const id of awkward) {
      expect(() => assertNoPhi({ syncRunId: id }), id).not.toThrow();
    }
  });

  test("a phone number sitting next to a uuid is still caught", () => {
    expect(() =>
      assertNoPhi({
        note: "11111111-2222-3333-4444-555555555555 called +15550101234",
      }),
    ).toThrow(PhiInAuditError);
  });
});
