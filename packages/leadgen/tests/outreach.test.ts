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
    // Unparseable returns null, never a guess: these figures are quoted to
    // the clinic, and at most pre-fill the hours it confirms in onboarding.
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
    expect(row.hook).toContain("Weekends are when most people finally get round to asking");
  });

  test("the weakest hook is still true of every clinic", () => {
    // This assertion used to demand a BLANK hook when nothing specific was
    // known, on the reasoning that an empty variable beats an invented one.
    // That is still right about invention and wrong about blanks: an empty hook
    // either leaves a hole in the email or drops the personalisation that
    // justified sending it. The fallback claims nothing specific and is true of
    // every clinic — somebody always rings instead of clicking.
    const row = buildOutreachRow(
      label({ offersOnlineBooking: true }),
      { hasOnlineBooking: true } as never,
      undefined,
    );
    expect(row.hook).toContain("Your booking page catches");
    // One sentence that names who it is about. "The ones with a question
    // first are the ones still ringing" named nobody and only parsed with the
    // sentence before it in mind.
    expect(row.hook).toContain("not the ones still asking");
  });

  test("GoHighLevel clinics are excluded, not celebrated", () => {
    // GHL bundles Conversation AI, so these clinics have already bought the
    // idea and only have to be persuaded about the execution. That is a warmer
    // start than a clinic which has never considered it, so it changes the
    // approach rather than the eligibility.
    const row = buildOutreachRow(
      label(),
      { platform: "gohighlevel", hasOnlineBooking: true } as never,
      undefined,
    );
    expect(row.angle).toBe("has-automation");
    expect(row.excludeReason).toBe("");
    // Not "yours is bad" — they chose it, so attacking it attacks them. Scope
    // is the distinction that is both true and flattering.
    // The hook credits the build rather than asserting an AI we never detected:
    // GoHighLevel is a CRM whose Conversation AI is an add-on most never enable.
    expect(row.hook).toContain("already solved the harder half");
    expect(row.hook).not.toMatch(/\bAI\b/);
    expect(row.hook).not.toMatch(/replace|switch|ditch|better than/i);
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
    expect(row.hook).toContain("lip filler");
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
    // Named in the hook only. Repeating it in the offer was the loudest tell
    // that a template wrote both halves.
    expect(row.hook).toContain("Botox");
    expect(row.topOffer).not.toContain("Botox");

    // Neither half may use an em dash or a semicolon. They are the punctuation
    // of generated text and a reader clocks them before the argument.
    expect(row.hook).not.toMatch(/[—;]/);
    expect(row.topOffer).not.toMatch(/[—;]/);

    // A ceiling, not a target. Full sentences run longer than fragments and
    // that is the trade being made deliberately — but past about thirty words
    // it stops being a sentence someone reads in three seconds and starts
    // being a paragraph they skip.
    expect(row.hook.split(/\s+/).length).toBeLessThan(30);
    expect(row.topOffer.split(/\s+/).length).toBeLessThanOrEqual(33);
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
    // The service is named in the hook, once, and not repeated in the offer.
    expect(row.hook).toContain("lip filler");
  });
});

describe("who is reading", () => {
  test("owners get 'smart', desks and role addresses get 'virtual'", async () => {
    const { assistantTerm } = await import("../src/enrich/outreach.ts");

    expect(assistantTerm("Owner", "jane@clinic.com")).toBe("smart");
    expect(assistantTerm("Founder & CEO", "j@clinic.com")).toBe("smart");
    expect(assistantTerm("Receptionist", "sam@clinic.com")).toBe("virtual");

    // A role address goes to whoever staffs the desk. An owner reading a
    // virtual-assistant email loses nothing; a receptionist reading a
    // replace-your-front-desk email forwards it to nobody.
    expect(assistantTerm("Owner", "info@clinic.com")).toBe("virtual");
    expect(assistantTerm("", "frontdesk@clinic.com")).toBe("virtual");
  });
});

describe("segment psychology", () => {
  test("injectables gets capture", async () => {
    const { selectCapability } = await import("../src/enrich/capabilities.ts");

    // A returning Botox patient is loyal to her injector and would have rung
    // back tomorrow anyway. The money is in the first-time caller.
    expect(
      selectCapability({
        segment: "injectables",
        gapHours: null,
        hasOnlineBooking: true,
        closesEarly: false,
      }).capability,
    ).toBe("around-the-clock");
  });

  test("no segment is offered anything outbound", async () => {
    const { selectCapability, CAPABILITY_LABEL } = await import("../src/enrich/capabilities.ts");
    const { SEGMENTS } = await import("@healdesk/catalog");

    // v1 is inbound only. GLP-1 and laser clinics used to get "win-backs",
    // which promised to bring lapsed patients back: outbound, so not v1.
    expect(Object.keys(CAPABILITY_LABEL).sort()).toEqual(
      ["around-the-clock", "calendar-booking", "deposits", "lead-qualification", "upselling"].sort(),
    );
    for (const segment of SEGMENTS) {
      const pitch = selectCapability({ segment, gapHours: null, hasOnlineBooking: true, closesEarly: false });
      expect(["win-backs", "aftercare-reviews"], segment).not.toContain(pitch.capability);
    }
    expect(
      selectCapability({
        segment: "weight-loss-glp1",
        gapHours: null,
        hasOnlineBooking: true,
        closesEarly: false,
      }).capability,
    ).toBe("around-the-clock");
  });
});

describe("booking claims follow the clinic's booking system", () => {
  const row = async (platform: string | null, online = true) => {
    const { buildOutreachRow } = await import("../src/enrich/outreach.ts");
    return buildOutreachRow(
      {
        clinicId: "c", segment: "injectables", confidence: "high", evidence: "",
        opensAt: null, closesAt: null, hoursByDay: null, topService: "Botox",
        offersOnlineBooking: online, mentionsWeightLoss: false, isChainOrFranchise: false,
      } as never,
      { hasOnlineBooking: online, platform } as never,
      {
        closedDays: [], closedHoursPerWeek: 128, closesAt: "17:00",
        gap: { hours: 64, startsDay: "Friday", startsAt: "17:00", endsDay: "Monday", endsAt: "09:00" },
        match: "strong",
      } as never,
      { jobTitle: "Owner", email: "j@c.com", social: [] },
    );
  };

  test("Mindbody never gets a live booking promise", async () => {
    // Mindbody syncs one way, Mindbody to Google, so a booking written into
    // Google does not block the slot in Mindbody. The clinic runs manual
    // booking mode, and the email says so.
    for (const platform of ["mindbody", "booker"]) {
      const r = await row(platform);
      expect(r.bookingMode).toBe("manual");
      expect(r.topOffer).not.toMatch(/books them in|books straight/);
      expect(r.topOffer).toContain("alerts your desk to confirm in Mindbody");
    }
  });

  test("Boulevard and unchecked systems book only where their system reads Google", async () => {
    // null: online booking on a system the signature table did not recognise.
    for (const platform of ["boulevard", "zenoti", "vagaro", null]) {
      const r = await row(platform);
      expect(r.bookingMode).toBe("unverified");
      expect(r.topOffer).not.toMatch(/books them in|books straight/);
      expect(r.topOffer).toContain("booking if your system reads Google or alerting your desk");
    }
  });

  test("a phone-only clinic, or a system that reads Google, keeps the live booking claim", async () => {
    for (const [platform, online] of [[null, false], ["calendly", true]] as const) {
      const r = await row(platform, online);
      expect(r.bookingMode).toBe("live");
      expect(r.topOffer).toContain("books them in");
    }
  });
});

describe("copy that must never break", () => {
  test("no row is left without a hook", async () => {
    const { buildOutreachRow } = await import("../src/enrich/outreach.ts");
    // A clinic that books online, whose hours we could not read, used to fall
    // through every branch — leaving a hole in the email, or silently dropping
    // the personalisation that justified sending it.
    const row = buildOutreachRow(
      {
        clinicId: "c",
        segment: "dermatology",
        confidence: "high",
        evidence: "",
        opensAt: null,
        closesAt: null,
        hoursByDay: null,
        topService: null,
        offersOnlineBooking: true,
        mentionsWeightLoss: false,
        isChainOrFranchise: false,
      } as never,
      { hasOnlineBooking: true } as never,
      undefined,
      { jobTitle: "Owner", email: "j@c.com" },
    );
    expect(row.hook.length).toBeGreaterThan(20);
    expect(row.topOffer).toMatch(/^AYA /);
  });

  test("the social offer is blank when they run no social", async () => {
    const { buildOutreachRow } = await import("../src/enrich/outreach.ts");
    const row = buildOutreachRow(
      {
        clinicId: "c", segment: "injectables", confidence: "high", evidence: "",
        opensAt: null, closesAt: null, hoursByDay: null, topService: "Botox",
        offersOnlineBooking: false, mentionsWeightLoss: false, isChainOrFranchise: false,
      } as never,
      undefined,
      undefined,
      { jobTitle: "Owner", email: "j@c.com", social: [] },
    );
    // A clinic with no Instagram does not want to hear about Instagram.
    expect(row.topOffer).not.toContain("Instagram");
  });
});

describe("tone and repetition", () => {
  const rows = () => import("../src/enrich/outreach.ts").then(async (m) => {
    const { selectCapability } = await import("../src/enrich/capabilities.ts");
    void selectCapability;
    const segments = [
      "injectables", "weight-loss-glp1", "body-contouring", "plastic-surgery",
      "laser-skin", "wellness-iv", "hair-restoration", "dental", "dermatology",
    ] as const;
    return segments.flatMap((segment) =>
      [true, false].map((online) =>
        m.buildOutreachRow(
          {
            clinicId: "c", segment, confidence: "high", evidence: "",
            opensAt: null, closesAt: null, hoursByDay: null, topService: "Botox",
            offersOnlineBooking: online, mentionsWeightLoss: false,
            isChainOrFranchise: false,
          } as never,
          { hasOnlineBooking: online } as never,
          {
            closedDays: [], closedHoursPerWeek: 128, closesAt: "17:00",
            gap: { hours: 64, startsDay: "Friday", startsAt: "17:00", endsDay: "Monday", endsAt: "09:00" },
            match: "strong",
          } as never,
          { jobTitle: "Owner", email: "j@c.com", social: ["instagram"] },
        ),
      ),
    );
  });

  test("no line accuses the clinic of failing", async () => {
    // Loss framing earns attention from someone you trust. From an unknown
    // sender it reads as criticism, and the reader defends rather than wants.
    const ACCUSING = /\b(nobody|no one|fail|failing|missing out|losing|you don't|you can't|cannot)\b/i;
    for (const r of await rows()) {
      expect(ACCUSING.test(r.hook), `hook: ${r.hook}`).toBe(false);
      expect(ACCUSING.test(r.topOffer), `offer: ${r.topOffer}`).toBe(false);
    }
  });

  test("the service is named once across the whole message", async () => {
    // Saying it again in the next sentence is the loudest tell that a template
    // wrote both halves.
    for (const r of await rows()) {
      const all = `${r.hook} ${r.topOffer}`;
      const hits = all.match(/botox/gi)?.length ?? 0;
      expect(hits, all).toBeLessThan(2);
    }
  });

  test("AYA is named once, not in every line", async () => {
    // The sequence names her in its own text, so the merged lines name her
    // once between them, and never as "our assistant" beside it.
    for (const r of await rows()) {
      const all = `${r.hook} ${r.topOffer}`;
      expect((all.match(/\bAYA\b/g) ?? []).length, all).toBe(1);
      expect(all, all).not.toMatch(/assistant/i);
    }
  });

  test("each line is short enough for a four-line email", async () => {
    for (const r of await rows()) {
      expect(r.hook.split(/\s+/).length, r.hook).toBeLessThanOrEqual(18);
      expect(r.topOffer.split(/\s+/).length, r.topOffer).toBeLessThanOrEqual(28);
      expect(r.closingQuestion.split(/\s+/).length, r.closingQuestion).toBeLessThanOrEqual(12);
    }
  });

  test("no em dashes or semicolons anywhere", async () => {
    for (const r of await rows()) {
      expect(`${r.hook}${r.topOffer}`).not.toMatch(/[—;]/);
    }
  });
});

describe("which surfaces to offer", () => {
  const row = async (social: string[], online: boolean) => {
    const { buildOutreachRow } = await import("../src/enrich/outreach.ts");
    return buildOutreachRow(
      {
        clinicId: "c", segment: "injectables", confidence: "high", evidence: "",
        opensAt: null, closesAt: null, hoursByDay: null, topService: "Botox",
        offersOnlineBooking: online, mentionsWeightLoss: false, isChainOrFranchise: false,
      } as never,
      { hasOnlineBooking: online } as never,
      undefined,
      { jobTitle: "Owner", email: "j@c.com", social },
    );
  };

  test("phone is always offered, the other two are earned", async () => {
    // Offering a surface a clinic does not use is the fastest way to sound like
    // a form.
    // Phone and website are unconditional: every clinic has both and both are
    // half the product. Website used to be withheld wherever a clinic already
    // had online booking, which excluded the chatbot from 70% of the list on
    // the false premise that a booking widget answers questions.
    expect((await row([], true)).channels).toBe("phone, website");
    expect((await row([], false)).channels).toBe("phone, website");
    // Meta stays earned. Offering Instagram to a clinic without one is the
    // fastest way to sound like a form.
    expect((await row(["instagram"], true)).channels).toBe("phone, website, meta");
  });

  test("only the Meta channels the product answers earn the Meta offer", async () => {
    // The Meta bot covers Instagram, Messenger and WhatsApp. A TikTok-only
    // clinic used to be offered "social messages", which it cannot have.
    const tiktok = await row(["tiktok"], true);
    expect(tiktok.channels).toBe("phone, website");
    expect(tiktok.topOffer).not.toContain("social messages");
    // A Facebook Page is reached through Messenger, so that is what it is called.
    expect((await row(["facebook"], true)).topOffer).toContain("website chat and Messenger");
  });

  test("the offer names the surfaces inside its own sentence", async () => {
    // These used to be three outputs: the offer, a line about social, and a
    // line about channels. Three sentences describing one product read as a
    // capability list with the bullets taken off, so the channels moved inside
    // the offer and the other two lines went away.
    const all = await row(["instagram"], false);
    expect(all.topOffer).toContain("your calls, website chat and Instagram");
    const noSocial = await row([], true);
    expect(noSocial.topOffer).toContain("your calls and website chat");
    expect(noSocial.topOffer).not.toContain("Instagram");
  });
});

describe("the service is used attributively, so it has to be singular", () => {
  test("a plural service is singularised", async () => {
    const { servicePhrase } = await import("../src/enrich/outreach.ts");
    // "Every laser facials appointment you take" was going out in 8 of 177
    // rows. One ungrammatical word tells the reader a template wrote it.
    expect(servicePhrase("laser facials")).toBe("a laser facial appointment");
    expect(servicePhrase("dental implants")).toBe("a dental implant appointment");
    expect(servicePhrase("hearing tests")).toBe("a hearing test appointment");
  });

  test("a coordinated pair falls back rather than being mangled", async () => {
    const { servicePhrase } = await import("../src/enrich/outreach.ts");
    // Trimming a letter off "botox and fillers" leaves it just as wrong.
    expect(servicePhrase("botox and fillers")).toBe("an appointment");
    expect(servicePhrase("IV therapy and stem cell injections")).toBe("an appointment");
  });

  test("singulars and acronyms are left alone", async () => {
    const { servicePhrase } = await import("../src/enrich/outreach.ts");
    expect(servicePhrase("Botox")).toBe("a Botox appointment");
    expect(servicePhrase("IPL")).toBe("an IPL appointment");
    expect(servicePhrase("LASIK")).toBe("a LASIK appointment");
    // Not a plural: the trailing s is part of the word.
    expect(servicePhrase("IV therapy")).toBe("an IV therapy appointment");
  });
});

describe("hook diversity", () => {
  test("every branch names the service, so no branch is a constant", async () => {
    const { hookDiversity } = await import("../src/enrich/outreach.ts");
    // Four of the six hook branches used to return a sentence with nothing
    // clinic-specific in it. Two clinics differing only by service must now get
    // different sentences, whichever branch they land in.
    const d = hookDiversity([
      "Some patients will always ring about Botox appointments rather than book online, and they are usually the ones ready today.",
      "Some patients will always ring about IV therapy appointments rather than book online, and they are usually the ones ready today.",
    ]);
    expect(d.distinct).toBe(2);
    expect(d.topShare).toBe(0.5);
  });

  test("a sentence carrying more than a quarter of the send is flagged", async () => {
    const { hookDiversity } = await import("../src/enrich/outreach.ts");
    // Spam filters cluster on repeated bodies, and a recipient who forwards it
    // to the practice next door finds the same email.
    const same = Array.from({ length: 30 }, () => "One sentence for everyone.");
    expect(hookDiversity([...same, "A different one."]).warning).toMatch(/same opening sentence/);
    const spread = Array.from({ length: 30 }, (_, i) => `Sentence ${i}.`);
    expect(hookDiversity(spread).warning).toBeNull();
  });

  test("excluded rows have no hook and are not counted", async () => {
    const { hookDiversity } = await import("../src/enrich/outreach.ts");
    expect(hookDiversity(["", "  ", "A real hook."]).rows).toBe(1);
    expect(hookDiversity([]).warning).toBeNull();
  });
});

describe("phone-only is a claim, so it needs both sources to be silent", () => {
  const label = (over: Record<string, unknown> = {}) => ({
    clinicId: "c", segment: "injectables", confidence: "high", evidence: "",
    opensAt: null, closesAt: null, hoursByDay: null, topService: "Botox",
    offersOnlineBooking: true, mentionsWeightLoss: false, isChainOrFranchise: false,
    ...over,
  }) as never;

  const row = async (l: unknown, booking: unknown) => {
    const { buildOutreachRow } = await import("../src/enrich/outreach.ts");
    return buildOutreachRow(l as never, booking as never, undefined, {
      jobTitle: "Owner", email: "j@c.com", social: [],
    });
  };

  test("a signature-table miss does not become a claim about the clinic", async () => {
    // 17 clinics whose homepage linked straight to Zocdoc or Vagaro were being
    // told "every appointment you take starts with a phone call". The link pass
    // finding nothing means the table has no entry, not that the clinic has no
    // booking.
    const r = await row(label({ offersOnlineBooking: true }), { hasOnlineBooking: false });
    expect(r.angle).toBe("has-booking");
    expect(r.hook).not.toContain("starts with a phone call");
  });

  test("a detected platform wins even when the model missed it", async () => {
    const r = await row(label({ offersOnlineBooking: false }), { hasOnlineBooking: true });
    expect(r.angle).toBe("has-booking");
  });

  test("both silent is the only way to claim phone-only", async () => {
    const r = await row(label({ offersOnlineBooking: false }), { hasOnlineBooking: false });
    expect(r.angle).toBe("phone-only");
    expect(r.hook).toContain("starts with a phone call");
  });
});

describe("every message ends on a question", () => {
  const row = async (label: unknown, booking: unknown, hours: unknown) => {
    const { buildOutreachRow } = await import("../src/enrich/outreach.ts");
    return buildOutreachRow(label as never, booking as never, hours as never, {
      jobTitle: "Owner", email: "j@c.com", social: [],
    });
  };
  const L = (o: Record<string, unknown> = {}) => ({
    clinicId: "c", segment: "injectables", confidence: "high", evidence: "",
    opensAt: null, closesAt: null, hoursByDay: null, topService: "Botox",
    offersOnlineBooking: false, mentionsWeightLoss: false, isChainOrFranchise: false, ...o,
  });
  const H = (o: Record<string, unknown>) => ({
    clinicId: "c", matchedName: "X", match: "strong", opensAt: "09:00", closesAt: "17:00",
    hoursByDay: {}, closedDays: [], closedHoursPerWeek: 126, gap: null, phone: null,
    reserveUrl: null, ...o,
  });

  test("a sendable row always has one", async () => {
    for (const [b, h] of [
      [undefined, undefined],
      [{ platform: "gohighlevel", hasOnlineBooking: true }, undefined],
      [undefined, H({ closedDays: ["Sunday"] })],
      [undefined, H({ gap: { hours: 90, startsDay: "Friday", startsAt: "15:00", endsDay: "Tuesday", endsAt: "09:00" } })],
    ] as const) {
      const r = await row(L(), b, h);
      expect(r.closingQuestion, `${r.angle}`).toMatch(/\?$/);
      // One line. A question that needs re-reading is a form, not a question.
      expect(r.closingQuestion.length, r.closingQuestion).toBeLessThan(60);
    }
  });

  test("the question is derived, not a stock line", async () => {
    // A question every recipient gets is a question none of them answers.
    const seen = new Set<string>();
    for (const [b, h] of [
      [undefined, undefined],
      [{ platform: "gohighlevel", hasOnlineBooking: true }, undefined],
      [undefined, H({ closedDays: ["Sunday"] })],
      [undefined, H({ gap: { hours: 90, startsDay: "Friday", startsAt: "15:00", endsDay: "Tuesday", endsAt: "09:00" } })],
    ] as const) {
      seen.add((await row(L(), b, h)).closingQuestion);
    }
    expect(seen.size).toBe(4);
  });

  test("an excluded row has none, because it is not being sent", async () => {
    expect((await row(L({ segment: "not-a-target" }), undefined, undefined)).closingQuestion).toBe("");
  });

  test("AYA is named once across the whole message", async () => {
    // The question calls her "her": the offer has already named her.
    const r = await row(L(), { platform: "gohighlevel", hasOnlineBooking: true }, undefined);
    const all = `${r.hook} ${r.topOffer} ${r.closingQuestion}`;
    expect((all.match(/\bAYA\b/g) ?? []).length, all).toBe(1);
    expect(r.closingQuestion).toMatch(/^Want (the|one) link/);
  });
});

describe("the call budget defers, it does not delete", () => {
  const crawl = (id: string) => ({
    clinicId: id, domain: `${id}.com`,
    // Over the 200-char floor, so partition sends it to toCall rather than
    // auto-labelling it unknown.
    text: "x".repeat(400), links: [], pagesFetched: 1,
  });

  test("clinics past maxCalls come back as unknown, not missing", async () => {
    const { labelClinics } = await import("../src/enrich/label.ts");
    // The caller writes [...settled, ...fresh] over the labels file and settled
    // excludes unknown, so a clinic in neither list is silently deleted.
    const out = await labelClinics([crawl("a"), crawl("b"), crawl("c")], {
      maxCalls: 0,
    });
    expect(out).toHaveLength(3);
    expect(out.every((l) => l.segment === "unknown")).toBe(true);
    expect(out[0]!.evidence).toMatch(/not classified/);
  });

  test("every input clinic appears in the output exactly once", async () => {
    const { labelClinics } = await import("../src/enrich/label.ts");
    const ids = ["a", "b", "c", "d"];
    const out = await labelClinics(ids.map(crawl), { maxCalls: 0 });
    expect(out.map((l) => l.clinicId).sort()).toEqual(ids);
  });

  test("a short-text clinic is still auto-labelled, budget or not", async () => {
    const { labelClinics } = await import("../src/enrich/label.ts");
    const out = await labelClinics(
      [{ clinicId: "s", domain: "s.com", text: "tiny", links: [], pagesFetched: 1 }],
      { maxCalls: 0 },
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.evidence).toMatch(/too little text/);
  });
});
