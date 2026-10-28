import { describe, expect, test } from "vitest";

import { hashBaaText } from "./baa";
import {
  currentDirectBookingAddendum,
  DIRECT_BOOKING_ACCEPTANCE,
  DIRECT_BOOKING_ADDENDUMS,
  DIRECT_BOOKING_CLAUSE_BODY,
  DirectBookingAddendumError,
  getDirectBookingAddendum,
  hashDirectBookingAddendum,
  prepareDirectBookingAddendum,
  renderDirectBookingAddendum,
} from "./direct-booking-addendum";

const VARS = {
  clinicLegalName: "Golden Clinic LLC",
  signatoryName: "Alex Chen",
  signatoryTitle: "Owner",
  acceptedOn: "2026-09-13",
};

describe("the direct-booking addendum", () => {
  test("is versioned like a document, and is offered because the owner released it", () => {
    const current = currentDirectBookingAddendum();
    expect(current.version).toMatch(/^direct-booking-addendum\/\d+\.\d+\.\d+$/);
    expect(getDirectBookingAddendum(current.version)).toBe(current);
    expect(getDirectBookingAddendum("direct-booking-addendum/0.0.0")).toBeUndefined();
    expect(DIRECT_BOOKING_ADDENDUMS[0]).toBe(current);
    // Released by the owner on 28 October 2026 without external counsel (the
    // way dpa/1.0.0 was released on 20 October); infra/aws/variables.tf
    // `direct_booking_addendum_released` must equal it.
    expect(current.approvedByCounsel).toBe(true);
  });

  test("renders the clause, the acceptance sentence, and the person who accepted it", () => {
    const text = renderDirectBookingAddendum(VARS);
    expect(text).toContain('Golden Clinic LLC ("Practice")');
    expect(text).toContain("1. DIRECT BOOKING, BY PRACTICE'S ELECTION");
    expect(text).toContain("2. ACCEPTANCE");
    expect(text).toContain("Alex Chen, Owner");
    expect(text).toContain("ACCEPTED 13 September 2026");
    expect(text).toContain(`Version ${currentDirectBookingAddendum().version}`);
    // The wrapped body is the clause body, word for word.
    const unwrap = (s: string) => s.replace(/\s+/g, " ").trim();
    expect(unwrap(text)).toContain(unwrap(DIRECT_BOOKING_CLAUSE_BODY));
    expect(unwrap(text)).toContain(unwrap(DIRECT_BOOKING_ACCEPTANCE));
    for (const line of text.split("\n")) expect(line.length, line).toBeLessThanOrEqual(78);
    expect(text).not.toMatch(/\{\{|undefined|\[object/);
  });

  test("the title is optional and nothing else is", () => {
    expect(renderDirectBookingAddendum({ ...VARS, signatoryTitle: undefined })).toContain("\n  Alex Chen\n");
    expect(renderDirectBookingAddendum({ ...VARS, signatoryTitle: "  " })).toContain("\n  Alex Chen\n");
    expect(() => renderDirectBookingAddendum({ ...VARS, clinicLegalName: " " })).toThrow(DirectBookingAddendumError);
    expect(() => renderDirectBookingAddendum({ ...VARS, signatoryName: "" })).toThrow(DirectBookingAddendumError);
    expect(() => renderDirectBookingAddendum({ ...VARS, acceptedOn: "not-a-date" })).toThrow(/Invalid acceptance date/);
  });

  test("hashes the exact bytes with the same digest the BAA uses", () => {
    const prepared = prepareDirectBookingAddendum(VARS);
    expect(prepared.version).toBe(currentDirectBookingAddendum().version);
    expect(prepared.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(prepared.hash).toBe(hashBaaText(prepared.text));
    expect(hashDirectBookingAddendum(prepared.text)).toBe(prepared.hash);
    // A different signatory is a different record.
    expect(prepareDirectBookingAddendum({ ...VARS, signatoryName: "Sam Lee" }).hash).not.toBe(prepared.hash);
  });

  test("the clause body carries the allocation the design requires, and nothing about Meta", () => {
    expect(DIRECT_BOOKING_CLAUSE_BODY).toMatch(/on telephone calls only/);
    expect(DIRECT_BOOKING_CLAUSE_BODY).toMatch(/Practice is responsible for those appointments/);
    expect(DIRECT_BOOKING_CLAUSE_BODY).toMatch(/healdesk remains responsible for safeguarding the PHI/);
    expect(DIRECT_BOOKING_CLAUSE_BODY).toMatch(/withdraw the election at any time by notice/);
    expect(DIRECT_BOOKING_CLAUSE_BODY).not.toMatch(/WhatsApp|Instagram|Messenger|text message|SMS/i);
  });
});
