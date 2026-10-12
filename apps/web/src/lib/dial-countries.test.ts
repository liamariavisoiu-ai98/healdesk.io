import { describe, expect, test } from "vitest";

import { countryByIso, formatNational, splitNumber, toInternational } from "@/lib/dial-countries";
import { normalizePhone } from "@/lib/phone";

const US = countryByIso("US");
const GB = countryByIso("GB");

describe("the Call me field", () => {
  test("a US number is written as it is typed", () => {
    expect(formatNational(US, "4")).toBe("(4");
    expect(formatNational(US, "4155")).toBe("(415) 5");
    expect(formatNational(US, "4155550123")).toBe("(415) 555-0123");
    expect(formatNational(US, "41555501239999")).toBe("(415) 555-0123");
  });

  test("elsewhere, in groups", () => {
    expect(formatNational(GB, "07911123456")).toBe("079 111 234 56");
  });

  test("what it sends is what lib/phone.ts reads as international, and that still decides", () => {
    expect(toInternational(US, "(212) 867-5309")).toBe("+12128675309");
    expect(toInternational(US, "1 212 867 5309")).toBe("+12128675309");
    expect(toInternational(GB, "07911 123456")).toBe("+447911123456");
    expect(toInternational(US, "")).toBe("");
    expect(normalizePhone(toInternational(GB, "07911 123456"))).toEqual({ ok: true, e164: "+447911123456" });
    // The fiction range is still refused by the server's own check.
    expect(normalizePhone(toInternational(US, "(555) 123-4567")).ok).toBe(false);
  });

  test("a whole number is split back into its country", () => {
    expect(splitNumber("+447911123456")).toEqual({ iso: "GB", national: "791 112 3456" });
    expect(splitNumber("+12128675309")).toEqual({ iso: "US", national: "(212) 867-5309" });
    expect(splitNumber("2128675309")).toEqual({ iso: "US", national: "(212) 867-5309" });
    expect(splitNumber(null)).toEqual({ iso: "US", national: "" });
  });
});
