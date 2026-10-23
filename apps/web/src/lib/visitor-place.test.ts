import { describe, expect, test } from "vitest";

import { placeFromHeaders } from "@/lib/visitor-place";

const place = (sent: Record<string, string>) => placeFromHeaders(new Headers(sent));

describe("the visitor's place, the finest the lookup is sure of", () => {
  test("the city, decoded from the percent-encoding Vercel applies", () => {
    expect(place({ "x-vercel-ip-city": "Scottsdale" })).toBe("Scottsdale");
    expect(place({ "x-vercel-ip-city": "San%20Francisco" })).toBe("San Francisco");
    expect(place({ "x-vercel-ip-city": "S%C3%A3o%20Paulo" })).toBe("São Paulo");
    expect(place({ "x-vercel-ip-city": "Winston-Salem" })).toBe("Winston-Salem");
    expect(place({ "x-vercel-ip-city": "St.%20John%27s" })).toBe("St. John's");
  });

  test("the city wins over the state and the country", () => {
    expect(place({ "x-vercel-ip-city": "Tempe", "x-vercel-ip-country-region": "AZ", "x-vercel-ip-country": "US" })).toBe("Tempe");
  });

  test("no city: a US visitor gets the state", () => {
    expect(place({ "x-vercel-ip-country-region": "AZ", "x-vercel-ip-country": "US" })).toBe("Arizona");
  });

  test("a region code is read only with the United States, never beside another country", () => {
    // "CA" is California here and nowhere else.
    expect(place({ "x-vercel-ip-country-region": "CA", "x-vercel-ip-country": "NO" })).toBe("Norway");
  });

  test("no city and no US state: the country, in English", () => {
    expect(place({ "x-vercel-ip-country": "NO" })).toBe("Norway");
    expect(place({ "x-vercel-ip-country": "gb" })).toBe("United Kingdom");
    expect(place({ "x-vercel-ip-country": "US" })).toBe("United States");
  });

  test("nothing at all is null, which the screen reads as Current Location", () => {
    expect(place({})).toBeNull();
    expect(place({ "x-vercel-ip-city": "%20%20" })).toBeNull();
    expect(place({ "x-vercel-ip-country": "XX" })).toBeNull();
    expect(place({ "x-vercel-ip-country": "USA" })).toBeNull();
  });

  test("a header that is not a place is ignored, so a forged one cannot put words on the screen", () => {
    expect(place({ "x-vercel-ip-city": "%E0%A4%A" })).toBeNull();
    expect(place({ "x-vercel-ip-city": "<script>alert(1)</script>" })).toBeNull();
    expect(place({ "x-vercel-ip-city": "Call%20555-0100" })).toBeNull();
    expect(place({ "x-vercel-ip-city": "A".repeat(41) })).toBeNull();
    // A forged city falls to the next rung rather than to nothing.
    expect(place({ "x-vercel-ip-city": "Call%20555-0100", "x-vercel-ip-country": "NO" })).toBe("Norway");
  });
});
