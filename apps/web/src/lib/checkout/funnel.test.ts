import {
  BOOKING_SYSTEMS,
  bookingSystemName,
  DEFAULT_STEPS,
  getPackage,
  manualBookingNotice,
  PACKAGES,
} from "@healdesk/catalog";
import { describe, expect, test } from "vitest";

import {
  agreementInputs,
  BOOKING_REQUESTS_FOR_NOW,
  bookingConsequence,
  choosePackage,
  choosePlan,
  chooseSteps,
  chosenPlan,
  clinicComplete,
  clinicIssues,
  firstIncompleteStep,
  type FunnelState,
  initialFunnel,
  noWebsiteOptions,
  packageComplete,
  packageForChannels,
  packageNeedsWebsite,
  planLink,
  RETIRED_PLAN_PACKAGES,
  sellableTo,
  parseAgreementInputs,
  parseStoredFunnel,
  purchaseWebsite,
  restoreFunnel,
  resumeStep,
  sameAgreementInputs,
  signatoryIssues,
  stepComplete,
  TOTAL_STEPS,
  websiteConflict,
  withoutWebsite,
} from "./funnel";

/**
 * The four steps' rules (plan Part A3), asserted directly. The components
 * only render these answers, so what is pinned here is what the buyer gets.
 */

/** A clinic that has answered steps 1 and 2. */
function answered(overrides: Partial<FunnelState> = {}): FunnelState {
  return {
    ...initialFunnel({ plan: "voice-webchat-500-300" }),
    clinicName: "Glow Med Spa LLC",
    website: "https://glowmedspa.com/",
    specialty: "med-spa",
    bookingSystem: "google_calendar",
    calendarAccount: "workspace_baa",
    covered: "no",
    contactName: "Laura Owner",
    contactTitle: "Owner",
    contactEmail: "Info@GlowMedSpa.com",
    ...overrides,
  };
}

describe("four steps", () => {
  test("there are four", () => {
    expect(TOTAL_STEPS).toBe(4);
  });
});

describe("step 1: the package", () => {
  test("nothing is preselected unless ?plan chose it", () => {
    expect(initialFunnel().packageId).toBeNull();
    expect(chosenPlan(initialFunnel())).toBeNull();
    expect(packageComplete(initialFunnel())).toBe(false);
    // A stale or unknown id preselects nothing rather than guessing.
    expect(initialFunnel({ plan: "starter" }).packageId).toBeNull();
    expect(initialFunnel({ plan: "voice-150" }).packageId).toBeNull();
    expect(initialFunnel({ plan: "constructor" }).packageId).toBeNull();
  });

  test("the steps start at the sheet's examples, whatever the package", () => {
    expect(initialFunnel()).toMatchObject({ voiceMinutes: 500, chatConversations: 300 });
    expect(DEFAULT_STEPS).toEqual({ voiceMinutes: 500, chatConversations: 300 });
  });

  test("a plan link opens its package at its own steps", () => {
    expect(chosenPlan(initialFunnel({ plan: "voice-metachat-800-1200" }))?.id).toBe(
      "voice-metachat-800-1200",
    );
    // A package without a product keeps that product's step at its default.
    expect(initialFunnel({ plan: "voice-900" })).toMatchObject({
      packageId: "voice",
      voiceMinutes: 900,
      chatConversations: 300,
    });
    expect(chosenPlan(initialFunnel({ plan: "webchat-1500" }))?.id).toBe("webchat-1500");
  });

  test("a package link opens the package at the default steps", () => {
    for (const pkg of PACKAGES) {
      const plan = chosenPlan(initialFunnel({ plan: pkg.id }));
      expect(plan?.packageId, pkg.id).toBe(pkg.id);
      expect(plan?.includedVoiceMinutes).toBe(pkg.voice ? 500 : 0);
      expect(plan?.includedChatConversations).toBe(pkg.chat ? 300 : 0);
    }
    expect(chosenPlan(initialFunnel({ plan: "voice-metachat" }))?.id).toBe("voice-metachat-500-300");
  });

  test("a retired package lands on the package that replaced it, never on an error", () => {
    expect(RETIRED_PLAN_PACKAGES).toEqual({
      "chat-web": "webchat",
      "chat-meta": "metachat",
      "chat-dual": "metachat",
      "web-voice": "voice-webchat",
      "meta-voice": "voice-metachat",
      complete: "voice-metachat",
      "chat-single": "webchat",
      "chat-voice": "voice-webchat",
    });
    for (const [old, pkg] of Object.entries(RETIRED_PLAN_PACKAGES)) {
      expect(getPackage(pkg), old).toBeDefined();
      expect(planLink(old)).toEqual({ packageId: pkg, ...DEFAULT_STEPS });
    }
    expect(chosenPlan(initialFunnel({ plan: "complete" }))?.id).toBe("voice-metachat-500-300");
    // "voice" is a package in both catalogs.
    expect(chosenPlan(initialFunnel({ plan: "voice" }))?.id).toBe("voice-500");
    expect(planLink(undefined)).toBeNull();
    expect(planLink(42)).toBeNull();
  });

  test("choosing a package keeps the steps; moving a step keeps the package", () => {
    const voiceMeta = choosePackage(initialFunnel(), "voice-metachat");
    expect(chosenPlan(voiceMeta)?.id).toBe("voice-metachat-500-300");
    const moved = chooseSteps(voiceMeta, { voiceMinutes: 1200 });
    expect(chosenPlan(moved)?.id).toBe("voice-metachat-1200-300");
    expect(chosenPlan(chooseSteps(moved, { chatConversations: 100 }))?.id).toBe(
      "voice-metachat-1200-100",
    );
    // The chat step survives a package without chat, and comes back with it.
    const voiceOnly = choosePackage(chooseSteps(moved, { chatConversations: 700 }), "voice");
    expect(chosenPlan(voiceOnly)?.id).toBe("voice-1200");
    expect(chosenPlan(choosePackage(voiceOnly, "metachat"))?.id).toBe("metachat-700");
  });

  test("a step off the grid, or a package that does not exist, changes nothing", () => {
    const start = choosePackage(initialFunnel(), "voice");
    for (const voiceMinutes of [0, 50, 150, 1600, 2000, Number.NaN]) {
      expect(chooseSteps(start, { voiceMinutes }), String(voiceMinutes)).toEqual(start);
    }
    expect(choosePackage(start, "complete")).toEqual(start);
    expect(choosePackage(start, "gold")).toEqual(start);
  });

  test("choosing by id: a plan picks its steps, a package or a retired one keeps them", () => {
    const moved = chooseSteps(initialFunnel(), { voiceMinutes: 800, chatConversations: 600 });
    expect(chosenPlan(choosePlan(moved, "metachat-200"))?.id).toBe("metachat-200");
    expect(chosenPlan(choosePlan(moved, "voice-webchat"))?.id).toBe("voice-webchat-800-600");
    expect(chosenPlan(choosePlan(moved, "meta-voice"))?.id).toBe("voice-metachat-800-600");
    expect(choosePlan(moved, "nope")).toEqual(moved);
  });

  test("the plan's price is the steps added up", () => {
    const plan = chosenPlan(initialFunnel({ plan: "voice-webchat-500-300" }))!;
    expect(plan.monthlyUsd).toBe(520);
    expect(plan.annualMonthlyUsd).toBe(416);
    expect(plan.setupFeeUsd).toBe(956);
  });

  test("the interval comes from the link, monthly otherwise", () => {
    expect(initialFunnel({ plan: "voice", interval: "year" }).interval).toBe("year");
    expect(initialFunnel({ plan: "voice" }).interval).toBe("month");
  });
  test("a setup request's channels add up to the package it asked for", () => {
    expect(packageForChannels(["phone"], true)).toBe("voice");
    expect(packageForChannels(["web"], true)).toBe("webchat");
    expect(packageForChannels(["instagram"], true)).toBe("metachat");
    expect(packageForChannels(["web", "whatsapp"], true)).toBe("metachat");
    expect(packageForChannels(["phone", "web"], true)).toBe("voice-webchat");
    expect(packageForChannels(["phone", "messenger"], true)).toBe("voice-metachat");
    expect(packageForChannels(["phone", "web", "instagram", "messenger", "whatsapp"], true)).toBe("voice-metachat");
    // Never Web Chat for a clinic with no website: Meta Chat includes it.
    expect(packageForChannels(["web"], false)).toBe("metachat");
    expect(packageForChannels(["phone", "web"], false)).toBe("voice-metachat");
    expect(packageForChannels(["phone"], false)).toBe("voice");
    expect(packageForChannels([], true)).toBeNull();
    expect(packageForChannels(["fax"], true)).toBeNull();
  });

  test("the request's package opens at the default steps, and ?plan wins over it", () => {
    expect(chosenPlan(initialFunnel({ packageId: "voice-webchat" }))?.id).toBe("voice-webchat-500-300");
    expect(chosenPlan(initialFunnel({ packageId: "voice-webchat", plan: "metachat-700" }))?.id).toBe("metachat-700");
    expect(initialFunnel({ packageId: "gold" }).packageId).toBeNull();
    expect(initialFunnel({ packageId: null }).packageId).toBeNull();
  });

  test("the request's name is the signatory's, until the buyer changes it", () => {
    expect(initialFunnel({ contactName: "  Alex Chen " }).contactName).toBe("Alex Chen");
    expect(initialFunnel({ contactName: "x".repeat(300) }).contactName).toHaveLength(120);
    expect(initialFunnel().contactName).toBe("");
  });
});

describe("step 2: the clinic", () => {
  test("complete once every answer is in", () => {
    expect(clinicIssues(answered())).toEqual([]);
    expect(clinicComplete(answered())).toBe(true);
    expect(purchaseWebsite(answered())).toBe("glowmedspa.com");
  });

  test("names what is missing, field by field", () => {
    const blank = initialFunnel({ plan: "voice" });
    expect(clinicIssues(blank).map((issue) => issue.field)).toEqual([
      "clinicName",
      "website",
      "specialty",
      "bookingSystem",
      "calendarAccount",
    ]);
  });

  test("the legal name is capped at 120 characters", () => {
    expect(clinicIssues(answered({ clinicName: "A".repeat(121) })).map((i) => i.field)).toEqual([
      "clinicName",
    ]);
    expect(clinicComplete(answered({ clinicName: "A".repeat(120) }))).toBe(true);
  });

  test("a website, or none: something that is not a website is neither", () => {
    expect(clinicIssues(answered({ website: "glow med spa" })).map((i) => i.field)).toEqual([
      "website",
    ]);
    expect(purchaseWebsite(answered({ website: "glow med spa" }))).toBeUndefined();
    expect(purchaseWebsite({ website: "glowmedspa.com", noWebsite: true })).toBeNull();
  });

  test("a setup request that said it has no website arrives with the box ticked", () => {
    expect(initialFunnel({ website: null }).noWebsite).toBe(true);
    expect(initialFunnel({ website: "glowmedspa.com" }).noWebsite).toBe(false);
    expect(initialFunnel().noWebsite).toBe(false);
  });

  test("the veterinary chip is not offered while its agreement is unreleased", () => {
    expect(initialFunnel({ specialty: "veterinary" }).specialty).toBeNull();
    expect(clinicIssues(answered({ specialty: "veterinary" })).map((i) => i.field)).toEqual([
      "specialty",
    ]);
    expect(initialFunnel({ specialty: "dental" }).specialty).toBe("dental");
  });
});

describe("no website", () => {
  test("Web Chat is not sold, and the step says so", () => {
    const webVoice = answered({ noWebsite: true });
    expect(chosenPlan(webVoice)?.id).toBe("voice-webchat-500-300");
    expect(websiteConflict(webVoice)).toBe(true);
    expect(clinicIssues(webVoice).map((i) => i.field)).toEqual(["plan"]);
  });

  test("the phone is offered first, then Meta Chat beside it, then Meta Chat, at the steps chosen", () => {
    expect(noWebsiteOptions().map((plan) => plan.id)).toEqual([
      "voice-500",
      "voice-metachat-500-300",
      "metachat-300",
    ]);
    expect(
      noWebsiteOptions({ voiceMinutes: 1000, chatConversations: 200 }).map((plan) => plan.id),
    ).toEqual(["voice-1000", "voice-metachat-1000-200", "metachat-200"]);
    for (const plan of noWebsiteOptions()) {
      expect(sellableTo(getPackage(plan.packageId)!, { noWebsite: true }), plan.id).toBe(true);
    }
  });

  test("taking an offer resolves it", () => {
    for (const plan of noWebsiteOptions()) {
      const chosen = choosePlan(answered({ noWebsite: true }), plan.id);
      expect(chosenPlan(chosen)?.id).toBe(plan.id);
      expect(websiteConflict(chosen)).toBe(false);
      expect(clinicComplete(chosen)).toBe(true);
    }
  });

  test("only the packages with Web Chat need a website; Meta Chat includes the website but needs none", () => {
    expect(PACKAGES.filter((pkg) => packageNeedsWebsite(pkg)).map((pkg) => pkg.id)).toEqual([
      "webchat",
      "voice-webchat",
    ]);
    const none = { noWebsite: true };
    expect(sellableTo(getPackage("webchat")!, none)).toBe(false);
    expect(sellableTo(getPackage("metachat")!, none)).toBe(true);
    expect(sellableTo(getPackage("webchat")!, { noWebsite: false })).toBe(true);
    const metachat = chosenPlan(choosePackage(initialFunnel(), "metachat"))!;
    expect(metachat.channels).toEqual({ web: true, meta: true, voice: false });
  });

  test("Web Chat's place is taken by Meta Chat, the rest unchanged", () => {
    expect(withoutWebsite("webchat")).toBe("metachat");
    expect(withoutWebsite("voice-webchat")).toBe("voice-metachat");
    for (const id of ["voice", "metachat", "voice-metachat"] as const) {
      expect(withoutWebsite(id)).toBe(id);
    }
  });

  test("a package that needs no website is unaffected", () => {
    expect(websiteConflict(choosePlan(answered({ noWebsite: true }), "voice"))).toBe(false);
    expect(websiteConflict(answered())).toBe(false);
  });
});

describe("the consequence of where bookings live", () => {
  test("while the owner's switch is off, or not known, a live system books as requests for now", () => {
    for (const id of ["google_calendar", "calendly", "calcom", "gohighlevel", "none"] as const) {
      expect(bookingConsequence(id).text, id).toBe(BOOKING_REQUESTS_FOR_NOW);
      expect(bookingConsequence(id, false).text, id).toBe(BOOKING_REQUESTS_FOR_NOW);
    }
    expect(BOOKING_REQUESTS_FOR_NOW).toBe(
      "For now your team confirms each booking AYA takes; live booking switches on once your calendar is connected and checked.",
    );
  });

  test("a one-way or unverified system says so in the catalog's words, by the system's own name", () => {
    expect(bookingConsequence("mindbody").text).toBe(
      manualBookingNotice(bookingSystemName("mindbody")),
    );
    expect(bookingConsequence("mindbody").text).toContain("confirm it in Mindbody");
    expect(bookingConsequence("boulevard").text).toContain("confirm it in Boulevard");
    // "Something else" is no product's name.
    expect(bookingConsequence("other").text).toContain("your booking system");
    expect(bookingConsequence("other").text).not.toContain("Something else");
    // Requests for good, so never "for now".
    for (const id of ["mindbody", "boulevard", "other"] as const) {
      expect(bookingConsequence(id).text).not.toContain("For now");
      expect(bookingConsequence(id, true).text).toBe(bookingConsequence(id, false).text);
    }
  });

  test("HighLevel's one setting is said before purchase, with its help page", () => {
    const highlevel = bookingConsequence("gohighlevel");
    expect(highlevel.setup?.note).toMatch(/conflict calendar/);
    expect(highlevel.setup?.helpUrl).toMatch(/^https:\/\/help\.gohighlevel\.com\//);
    for (const system of BOOKING_SYSTEMS.filter((s) => s.id !== "gohighlevel")) {
      expect(bookingConsequence(system.id).setup, system.id).toBeNull();
    }
  });

  test("once the switch is on, a live system books live", () => {
    expect(bookingConsequence("google_calendar", true).text).not.toBe(BOOKING_REQUESTS_FOR_NOW);
  });
});

describe("step 3: the agreement's inputs", () => {
  test("are named only once the clinic is complete and the question is answered", () => {
    expect(agreementInputs(answered({ covered: null }))).toBeNull();
    expect(agreementInputs(answered({ bookingSystem: null }))).toBeNull();
    expect(agreementInputs(answered())).toMatchObject({
      kind: "baa",
      clinicLegalName: "Glow Med Spa LLC",
      covered: "no",
      platform: "none",
      signatoryEmail: "info@glowmedspa.com",
    });
    expect(agreementInputs(answered({ bookingSystem: "mindbody" }))?.platform).toBe("mindbody");
  });

  test("a signature is reused only while every document input matches", () => {
    const signed = agreementInputs(answered());
    expect(sameAgreementInputs(signed, agreementInputs(answered()))).toBe(true);
    for (const change of [
      { clinicName: "Glow Aesthetics LLC" },
      { specialty: "hair-restoration" as const },
      { covered: "yes" as const },
      { bookingSystem: "calendly" as const },
      { calendarAccount: "personal" as const },
      { contactName: "Someone Else" },
      { contactTitle: "Manager" },
      { contactEmail: "billing@glowmedspa.com" },
    ]) {
      expect(
        sameAgreementInputs(signed, agreementInputs(answered(change))),
        JSON.stringify(change),
      ).toBe(false);
    }
  });

  test("the package is not a document input", () => {
    const signed = agreementInputs(answered());
    expect(
      sameAgreementInputs(signed, agreementInputs(choosePlan(answered(), "voice-metachat-1500-1500"))),
    ).toBe(true);
    expect(sameAgreementInputs(signed, agreementInputs({ ...answered(), interval: "year" }))).toBe(
      true,
    );
  });

  test("stored inputs are read back only whole", () => {
    const inputs = agreementInputs(answered())!;
    expect(parseAgreementInputs(JSON.parse(JSON.stringify(inputs)))).toEqual(inputs);
    expect(parseAgreementInputs({ ...inputs, bookingSystem: "zenoti" })).toBeNull();
    expect(parseAgreementInputs({ ...inputs, kind: "nda" })).toBeNull();
    expect(parseAgreementInputs(undefined)).toBeNull();
  });

  test("the signatory needs a name and the clinic's address", () => {
    expect(signatoryIssues(answered())).toEqual([]);
    expect(
      signatoryIssues(answered({ contactName: "L", contactEmail: "info@" })).map((i) => i.field),
    ).toEqual(["contactName", "contactEmail"]);
  });
});

describe("moving between steps", () => {
  test("a step is complete only when its answers are", () => {
    expect(stepComplete(1, initialFunnel(), false)).toBe(false);
    expect(stepComplete(1, answered(), false)).toBe(true);
    expect(stepComplete(2, answered(), false)).toBe(true);
    expect(stepComplete(3, answered(), false)).toBe(false);
    expect(stepComplete(3, answered(), true)).toBe(true);
    expect(stepComplete(4, answered(), true)).toBe(false);
  });

  test("a restored funnel opens where the buyer was, never past an incomplete step", () => {
    expect(resumeStep({ ...answered(), step: 4 }, true, false)).toBe(4);
    expect(resumeStep({ ...answered(), step: 4 }, false, false)).toBe(3);
    expect(resumeStep({ ...answered({ clinicName: "" }), step: 4 }, true, false)).toBe(2);
    expect(resumeStep({ ...initialFunnel(), step: 3 }, false, false)).toBe(1);
    expect(firstIncompleteStep(answered(), false)).toBe(3);
  });

  test("back from the payment page, review and pay whenever it can be reached", () => {
    expect(resumeStep({ ...answered(), step: 1 }, true, true)).toBe(4);
    expect(resumeStep({ ...answered(), step: 1 }, false, true)).toBe(3);
  });
});

describe("the answers kept for the tab", () => {
  test("round-trip, and anything malformed is dropped rather than repaired", () => {
    const state = answered({ step: 3 });
    expect(parseStoredFunnel(JSON.parse(JSON.stringify(state)))).toEqual(state);
    const parsed = parseStoredFunnel({
      ...state,
      step: 9,
      packageId: "complete",
      voiceMinutes: 550,
      chatConversations: 1600,
      specialty: "veterinary",
      bookingSystem: "zenoti",
      calendarAccount: 1,
      covered: "maybe",
      interval: "week",
      clinicName: "x".repeat(401),
    });
    expect(parsed).toEqual({
      website: state.website,
      noWebsite: false,
      contactName: state.contactName,
      contactTitle: state.contactTitle,
      contactEmail: state.contactEmail,
    });
    expect(parseStoredFunnel("nope")).toBeNull();
    expect(parseStoredFunnel(null)).toBeNull();
  });

  test("a funnel stored before the steps keeps its answers and asks for the package again", () => {
    const old = { ...answered({ step: 3 }), cardId: "complete", chat: "meta" } as Record<string, unknown>;
    delete old.packageId;
    delete old.voiceMinutes;
    delete old.chatConversations;
    const restored = restoreFunnel(initialFunnel(), parseStoredFunnel(old), { explicitPlan: false });
    expect(restored.packageId).toBeNull();
    expect(restored.clinicName).toBe("Glow Med Spa LLC");
    expect(resumeStep(restored, true, false)).toBe(1);
  });

  test("?plan chosen now wins over the stored package and steps; the setup link's address always wins", () => {
    const stored = { ...answered({ step: 2 }), contactEmail: "old@else.com" };
    const seed = initialFunnel({ plan: "voice-1100", interval: "year" });
    const restored = restoreFunnel(seed, stored, {
      explicitPlan: true,
      lockedEmail: "info@glowmedspa.com",
    });
    expect(chosenPlan(restored)?.id).toBe("voice-1100");
    expect(restored.interval).toBe("year");
    expect(restored.contactEmail).toBe("info@glowmedspa.com");
    expect(restored.clinicName).toBe("Glow Med Spa LLC");

    const kept = restoreFunnel(initialFunnel(), stored, { explicitPlan: false });
    expect(chosenPlan(kept)?.id).toBe("voice-webchat-500-300");
    expect(kept.contactEmail).toBe("old@else.com");
  });

  test("a Web Chat link for a practice with no website opens the same package with Meta Chat", () => {
    const stored = answered({ noWebsite: true });
    for (const [link, plan] of [
      ["webchat-400", "metachat-400"],
      ["voice-webchat-600-200", "voice-metachat-600-200"],
      ["chat-web", "metachat-300"],
      ["voice", "voice-500"],
    ] as const) {
      const restored = restoreFunnel(initialFunnel({ plan: link }), stored, { explicitPlan: true });
      expect(chosenPlan(restored)?.id, link).toBe(plan);
      expect(websiteConflict(restored), link).toBe(false);
    }
  });
});
