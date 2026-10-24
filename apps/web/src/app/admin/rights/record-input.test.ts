import { describe, expect, test } from "vitest";

import { checkRecordInput } from "./record-input";

/**
 * The Record a request form's input, checked on the server against apps/app's
 * own rules (lib/ops/rights-ops.ts opRecordRightsIntake) before anything is
 * sent: each refusal is one plain sentence, and what passes is exactly the
 * shape the ops client sends.
 */

const CLINIC = "3FA85F64-5717-4562-B3FC-2C963F66AFA6";
const KEY = "0b5e1c2d-3f40-4a51-8b62-7c83d94ea5f6";
const TODAY = "2026-10-24";
const good = { clinicId: CLINIC, requestKey: KEY, kind: "erasure", receivedOn: "2026-10-21", verifiedVia: "notice_address" };

describe("checkRecordInput", () => {
  test("passes a request from the lists, lower-casing the ids, and carries what was asked only for a patient's own request", () => {
    expect(checkRecordInput(good, TODAY)).toEqual({
      ok: true,
      input: { clinicId: CLINIC.toLowerCase(), requestKey: KEY, kind: "erasure", receivedOn: "2026-10-21", verifiedVia: "notice_address" },
    });
    expect(checkRecordInput({ ...good, kind: "patient_request", askedFor: "accounting" }, TODAY)).toMatchObject({
      ok: true,
      input: { kind: "patient_request", askedFor: "accounting" },
    });
    // An empty asked-for on another kind is the form's select left out, not a value.
    expect(checkRecordInput({ ...good, askedFor: "" }, TODAY)).toMatchObject({ ok: true });
    expect(checkRecordInput({ ...good, askedFor: null }, TODAY)).toMatchObject({ ok: true });
  });

  test("a day ahead of UTC's is allowed (a clinic east of UTC can be in tomorrow); later is not", () => {
    expect(checkRecordInput({ ...good, receivedOn: TODAY }, TODAY)).toMatchObject({ ok: true });
    expect(checkRecordInput({ ...good, receivedOn: "2026-10-25" }, TODAY)).toMatchObject({ ok: true });
    expect(checkRecordInput({ ...good, receivedOn: "2026-10-26" }, TODAY)).toEqual({ ok: false, message: "A request cannot be received after today." });
  });

  test("refuses, in a sentence, everything off the lists or out of shape", () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ ...good, clinicId: "radiance" }, "Choose a clinic."],
      [{ ...good, requestKey: "not-a-key" }, "This form has no request key. Reload the page and record it again."],
      [{ ...good, kind: "refund" }, "Choose what the request asks for."],
      [{ ...good, verifiedVia: "email" }, "Say how the request was verified."],
      [{ ...good, receivedOn: "2026-02-30" }, "Enter the day the request reached us."],
      [{ ...good, receivedOn: "21/10/2026" }, "Enter the day the request reached us."],
      [{ ...good, kind: "patient_request" }, "Say what the patient asked for."],
      [{ ...good, kind: "patient_request", askedFor: "money" }, "Say what the patient asked for."],
      [{ ...good, askedFor: "access" }, "What was asked for is recorded for a patient's own request only."],
    ];
    for (const [input, message] of cases) expect(checkRecordInput(input, TODAY), JSON.stringify(input)).toEqual({ ok: false, message });
    expect(checkRecordInput(null, TODAY)).toEqual({ ok: false, message: "Nothing was sent." });
    expect(checkRecordInput("x", TODAY)).toEqual({ ok: false, message: "Nothing was sent." });
  });
});
