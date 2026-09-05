import { describe, expect, test } from "vitest";

import { buildOutreachRow } from "../src/enrich/outreach.ts";
import { closedHoursPerWeek, matchQuality, parseRange } from "../src/enrich/places.ts";

const label = (over: Record<string, unknown> = {}) =>
  ({
    clinicId: "c1",
    segment: "injectables",
    confidence: "high",
    evidence: "",
    opensAt: null,
    closesAt: null,
    hoursByDay: null,
    offersOnlineBooking: false,
    mentionsWeightLoss: false,
    isChainOrFranchise: false,
    ...over,
  }) as never;

const hours = (over: Record<string, unknown> = {}) =>
  ({
    clinicId: "c1",
    matchedName: "X",
    opensAt: "09:00",
    closesAt: "17:00",
    hoursByDay: "",
    closedDays: [],
    closedHoursPerWeek: 128,
    reserveUrl: null,
    phone: null,
    match: "strong",
    ...over,
  }) as never;

describe("Google hours parsing", () => {
  test("handles the shapes Google actually emits", () => {
    expect(parseRange("9 AM to 5 PM")).toEqual(["09:00", "17:00"]);
    expect(parseRange("9:30 AM to 6 PM")).toEqual(["09:30", "18:00"]);
    expect(parseRange("Open 24 hours")).toEqual(["00:00", "23:59"]);
    expect(parseRange("Closed")).toBeNull();
    // A missing am/pm on the opening time takes it from the close — "9 to 5 PM"
    // is written that way and means 09:00.
    expect(parseRange("9 to 5 PM")).toEqual(["09:00", "17:00"]);
    // Unparseable returns null, never a guess: these figures reach
    // clinics.openingHours, where a wrong one mis-bills a real call.
    expect(parseRange("call for hours")).toBeNull();
  });

  test("closed hours are the number the outreach turns on", () => {
    const nineToFive = Object.fromEntries(
      ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"].map((d) => [
        d,
        ["09:00", "17:00"] as [string, string],
      ]),
    );
    // 40 open, so 128 unanswered — the figure a clinic has never worked out.
    expect(closedHoursPerWeek(nineToFive)).toBe(128);
  });
});

describe("matching the right business", () => {
  test("website agreement is strong, name alone is weak", () => {
    expect(
      matchQuality({ website: "https://www.radiance.com/" }, "radiance.com", "X"),
    ).toBe("strong");
    // "Radiance Med Spa" exists in a dozen states, so a name match cannot be
    // trusted to put THIS clinic's hours in an email addressed to it.
    expect(matchQuality({ title: "Radiance Med Spa" }, "other.com", "Radiance Med Spa")).toBe("weak");
    expect(matchQuality({ title: "Something Else" }, "other.com", "Radiance")).toBe("none");
  });
});

describe("the outreach row", () => {
  test("no online booking outranks every hours angle", () => {
    // Every appointment starts with a call, so every missed call is a missed
    // booking. That beats any hours story even when the hours are known.
    const row = buildOutreachRow(label(), undefined, hours({ closedDays: ["Sunday"] }));
    expect(row.angle).toBe("phone-only");
  });

  test("a named closed day beats a generic gap", () => {
    const row = buildOutreachRow(
      label({ offersOnlineBooking: true }),
      { hasOnlineBooking: true } as never,
      hours({ closedDays: ["Saturday", "Sunday"] }),
    );
    expect(row.angle).toBe("closed-weekends");
    expect(row.hook).toContain("shut at weekends");
  });

  test("the hook is blank rather than invented when nothing is known", () => {
    // An empty variable is recoverable in a template. A fabricated one is a lie
    // in an email to a business that can check it.
    const row = buildOutreachRow(
      label({ offersOnlineBooking: true }),
      { hasOnlineBooking: true } as never,
      undefined,
    );
    expect(row.hook).toBe("");
  });

  test("GoHighLevel clinics are excluded, not celebrated", () => {
    // GHL bundles Conversation AI. Reading this as a detection is how you pitch
    // an AI receptionist to someone who already bought a competitor's.
    const row = buildOutreachRow(
      label(),
      { platform: "gohighlevel", hasOnlineBooking: true } as never,
      undefined,
    );
    expect(row.angle).toBe("exclude");
    expect(row.excludeReason).toMatch(/already has bundled AI/);
  });

  test("unknown clinics are held for retry, not written off", () => {
    const row = buildOutreachRow(label({ segment: "unknown" }), undefined, undefined);
    expect(row.excludeReason).toMatch(/retry/);
  });
});

describe("service phrasing", () => {
  test("gets the article right, including acronyms", async () => {
    const { servicePhrase } = await import("../src/enrich/outreach.ts");

    expect(servicePhrase("Botox")).toBe("a Botox appointment");
    expect(servicePhrase("Invisalign")).toBe("an Invisalign appointment");
    // Vowel SOUND, not vowel letter — "IPL" is read "eye-pee-ell".
    expect(servicePhrase("IPL")).toBe("an IPL appointment");
    expect(servicePhrase("LASIK")).toBe("a LASIK appointment");
    expect(servicePhrase("CoolSculpting")).toBe("a CoolSculpting appointment");

    // A generic sentence beats a broken one: this is what every clinic gets
    // when the page names no single lead service.
    expect(servicePhrase(null)).toBe("an appointment");
    expect(servicePhrase("  ")).toBe("an appointment");
  });

  test("the phrase reaches the hook, so no row says just 'an appointment'", async () => {
    const { buildOutreachRow } = await import("../src/enrich/outreach.ts");
    const row = buildOutreachRow(
      {
        clinicId: "c",
        segment: "injectables",
        confidence: "high",
        evidence: "",
        opensAt: null,
        closesAt: null,
        hoursByDay: null,
        topService: "lip filler",
        offersOnlineBooking: false,
        mentionsWeightLoss: false,
        isChainOrFranchise: false,
      } as never,
      undefined,
      undefined,
    );
    expect(row.servicePhrase).toBe("a lip filler appointment");
    expect(row.hook).toContain("a lip filler appointment");
  });
});

describe("the booking gap", () => {
  test("measures the longest stretch, not the average", async () => {
    const { longestGap } = await import("../src/enrich/places.ts");
    const mf = Object.fromEntries(
      ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"].map((d) => [
        d,
        ["09:00", "17:00"] as [string, string],
      ]),
    );

    // 64 unbroken hours, and where they fall is the point: Friday evening
    // through Monday morning is exactly when elective aesthetics is decided.
    expect(longestGap({ ...mf, Saturday: null, Sunday: null })).toEqual({
      hours: 64,
      startsDay: "Friday",
      startsAt: "17:00",
      endsDay: "Monday",
      endsAt: "09:00",
    });
  });

  test("opening Saturday cuts the gap by a third", async () => {
    const { longestGap } = await import("../src/enrich/places.ts");
    const mf = Object.fromEntries(
      ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"].map((d) => [
        d,
        ["09:00", "17:00"] as [string, string],
      ]),
    );
    const g = longestGap({
      ...mf,
      Saturday: ["10:00", "14:00"] as [string, string],
      Sunday: null,
    });
    // 64 -> 43. Worth knowing: it is also the strongest argument for the
    // product to a clinic that already opens Saturday.
    expect(g?.hours).toBe(43);
    expect(g?.startsDay).toBe("Saturday");
  });

  test("a gap running through Sunday into Monday is one stretch, not two", async () => {
    const { longestGap } = await import("../src/enrich/places.ts");
    // The week is laid out twice for exactly this: a single-week loop would cut
    // the most important gap in half at the Sunday/Monday boundary.
    const g = longestGap({
      Monday: ["09:00", "17:00"] as [string, string],
      Tuesday: null,
      Wednesday: null,
      Thursday: null,
      Friday: null,
      Saturday: null,
      Sunday: null,
    });
    expect(g?.hours).toBe(160);
  });

  test("no hours means no gap, never a guessed one", async () => {
    const { longestGap } = await import("../src/enrich/places.ts");
    expect(longestGap({})).toBeNull();
  });
});

describe("the offer", () => {
  test("names the clinic's own window rather than the product category", async () => {
    const { buildOutreachRow } = await import("../src/enrich/outreach.ts");
    const row = buildOutreachRow(
      {
        clinicId: "c",
        segment: "injectables",
        confidence: "high",
        evidence: "",
        opensAt: "09:00",
        closesAt: "17:00",
        hoursByDay: null,
        topService: "Botox",
        offersOnlineBooking: false,
        mentionsWeightLoss: false,
        isChainOrFranchise: false,
      } as never,
      undefined,
      {
        closedDays: ["Saturday", "Sunday"],
        closedHoursPerWeek: 128,
        closesAt: "17:00",
        gap: {
          hours: 64,
          startsDay: "Friday",
          startsAt: "17:00",
          endsDay: "Monday",
          endsAt: "09:00",
        },
        match: "strong",
      } as never,
    );

    expect(row.gapHours).toBe("64");
    expect(row.gapWindow).toBe("Friday 17:00 to Monday 09:00");
    // The number belongs in the hook, which states the problem. The offer says
    // what we do and stops — repeating the figure in both halves is how an
    // email starts sounding like a template.
    expect(row.hook).toContain("64 hours");
    expect(row.hook).toContain("5pm");
    expect(row.hook).toContain("9am");
    expect(row.topOffer).toContain("a Botox appointment");

    // Neither half may use an em dash or a semicolon. They are the punctuation
    // of generated text and a reader clocks them before the argument.
    expect(row.hook).not.toMatch(/[—;]/);
    expect(row.topOffer).not.toMatch(/[—;]/);

    // Three seconds is about twenty-five words.
    expect(row.hook.split(/\s+/).length).toBeLessThan(20);
    expect(row.topOffer.split(/\s+/).length).toBeLessThan(26);
  });

  test("falls back to something true when no hours are known", async () => {
    const { buildOutreachRow } = await import("../src/enrich/outreach.ts");
    const row = buildOutreachRow(
      {
        clinicId: "c",
        segment: "injectables",
        confidence: "high",
        evidence: "",
        opensAt: null,
        closesAt: null,
        hoursByDay: null,
        topService: "lip filler",
        offersOnlineBooking: false,
        mentionsWeightLoss: false,
        isChainOrFranchise: false,
      } as never,
      undefined,
      undefined,
    );
    expect(row.gapHours).toBe("");
    expect(row.topOffer).toContain("a lip filler appointment");
  });
});
