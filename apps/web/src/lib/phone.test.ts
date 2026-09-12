import { describe, expect, it } from "vitest";

import { maskPhone, normalizePhone } from "./phone";

describe("normalizePhone", () => {
  it("accepts a bare 10-digit US number and assumes +1", () => {
    expect(normalizePhone("415 555 0100")).toEqual({
      ok: false,
      reason: "We can't call that number.",
    });
    expect(normalizePhone("415 867 5309")).toEqual({
      ok: true,
      e164: "+14158675309",
    });
  });

  it("strips the punctuation people actually type", () => {
    for (const input of [
      "(415) 867-5309",
      "415.867.5309",
      " 415-867-5309 ",
      "+1 (415) 867 5309",
      "14158675309",
    ]) {
      expect(normalizePhone(input)).toEqual({ ok: true, e164: "+14158675309" });
    }
  });

  it("keeps an international number that carries its own country code", () => {
    expect(normalizePhone("+44 20 7946 0958")).toEqual({
      ok: true,
      e164: "+442079460958",
    });
  });

  // A bare 10-digit string is assumed North American, so "20 7946 0958" is
  // accepted as +1 207-946-0958 (Maine) rather than a London number. That is
  // not a bug to fix here, the two are genuinely indistinguishable without a
  // country code, and the field's placeholder asks for one.
  it("refuses to guess a country code for anything that isn't 10 or 11 digits", () => {
    expect(normalizePhone("7946 0958")).toMatchObject({ ok: false });
    expect(normalizePhone("2079460958")).toEqual({ ok: true, e164: "+12079460958" });
  });

  // The whole point of the module: an endpoint that dials anything is a
  // harassment tool, and 911 is the worst thing it could dial.
  it("blocks service codes and the fiction range", () => {
    for (const input of ["911 867 5309", "411 867 5309", "555 867 5309"]) {
      expect(normalizePhone(input)).toEqual({
        ok: false,
        reason: "We can't call that number.",
      });
    }
    expect(normalizePhone("415 555 0100")).toMatchObject({ ok: false });
  });

  it("rejects NANP numbers whose area code or exchange starts with 0 or 1", () => {
    expect(normalizePhone("015 867 5309")).toMatchObject({ ok: false });
    expect(normalizePhone("415 067 5309")).toMatchObject({ ok: false });
  });

  it("rejects junk", () => {
    for (const input of ["", "   ", "abc", "+", "0", 4158675309, null, undefined]) {
      expect(normalizePhone(input as unknown)).toMatchObject({ ok: false });
    }
    expect(normalizePhone("+9999999999999999999")).toMatchObject({ ok: false });
  });
});

describe("maskPhone", () => {
  it("returns only the last four digits", () => {
    expect(maskPhone("+14158675309")).toBe("5309");
  });
});
