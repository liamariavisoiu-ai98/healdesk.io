import { describe, expect, test } from "vitest";

import { checkApprovalEdit } from "./approval-edit";

/**
 * What the Queues page accepts beside a decision: an email's closed fields
 * in apps/app's own range and lists, a report's choices as an object, and
 * nothing else. A typed string where a code goes is refused in a sentence,
 * never forwarded.
 */

describe("the edit a decision may carry", () => {
  test("none is none", () => {
    expect(checkApprovalEdit(undefined)).toEqual({ ok: true, edit: undefined });
    expect(checkApprovalEdit(null)).toEqual({ ok: true, edit: undefined });
  });

  test("an email's fields: days 1 to 30, a phrase from the list, a note from the list or none", () => {
    expect(checkApprovalEdit({ fields: { days: 14, note: null } })).toEqual({ ok: true, edit: { fields: { days: 14, note: null } } });
    expect(checkApprovalEdit({ fields: { phrase: "calendar", note: "thanks" } })).toEqual({ ok: true, edit: { fields: { phrase: "calendar", note: "thanks" } } });
    expect(checkApprovalEdit({ fields: {} })).toEqual({ ok: true, edit: { fields: {} } });
    for (const days of [0, 31, 1.5, "14", null]) {
      expect(checkApprovalEdit({ fields: { days } }), String(days)).toMatchObject({ ok: false, message: expect.stringContaining("whole number from 1 to 30") });
    }
    expect(checkApprovalEdit({ fields: { phrase: "Please call me on 555 0100" } })).toMatchObject({ ok: false, message: expect.stringContaining("listed parts of setup") });
    expect(checkApprovalEdit({ fields: { note: "Thanks, call me" } })).toMatchObject({ ok: false, message: expect.stringContaining("approved ones, or none") });
    expect(checkApprovalEdit({ fields: { subject: "x" } })).toMatchObject({ ok: false, message: expect.stringContaining("Only the days") });
    expect(checkApprovalEdit({ fields: "x" })).toMatchObject({ ok: false });
    expect(checkApprovalEdit({ fields: {}, body: "x" })).toMatchObject({ ok: false });
  });

  test("a report's choices pass through as an object for the ops client's own list check; anything else is refused", () => {
    const choices = { event: "other", occurredOn: null, info: [], mitigations: [], steps: [], recommendations: [], delayedByLawEnforcement: false, delayEndedOn: null };
    expect(checkApprovalEdit({ incident: choices })).toEqual({ ok: true, edit: { incident: choices } });
    expect(checkApprovalEdit({ incident: "x" })).toMatchObject({ ok: false });
    expect(checkApprovalEdit({ incident: choices, fields: {} })).toMatchObject({ ok: false });
    expect(checkApprovalEdit("fields")).toMatchObject({ ok: false });
  });
});
