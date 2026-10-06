import {
  BOOKING_SYSTEMS,
  bookingSystemName,
  getPlan,
  manualBookingNotice,
} from "@healdesk/catalog";
import { describe, expect, test } from "vitest";

import {
  agreementInputs,
  BOOKING_REQUESTS_FOR_NOW,
  bookingConsequence,
  chooseCard,
  chooseChat,
  choosePlan,
  chosenPlan,
  clinicComplete,
  clinicIssues,
  DIRECT_BOOKING_OPEN,
  firstIncompleteStep,
  type FunnelState,
  initialFunnel,
  noWebsiteOptions,
  packageComplete,
  planOnSale,
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
} from "./funnel";

/**
 * The four steps' rules (plan Part A3), asserted directly. The components
 * only render these answers, so what is pinned here is what the buyer gets.
 */

/** A clinic that has answered steps 1 and 2. */
function answered(overrides: Partial<FunnelState> = {}): FunnelState {
  return {
    ...initialFunnel({ plan: "chat-voice" }),
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
  test("nothing is preselected unless a pricing card or ?plan chose it", () => {
    expect(initialFunnel().cardId).toBeNull();
    expect(chosenPlan(initialFunnel())).toBeNull();
    expect(packageComplete(initialFunnel())).toBe(false);
    // A stale or unknown id preselects nothing rather than guessing.
    expect(initialFunnel({ plan: "starter" }).cardId).toBeNull();
    expect(initialFunnel({ plan: "chat-single" }).cardId).toBe("chat-single");
  });

  test("on a twin card the chat channel picks the package id", () => {
    const single = initialFunnel({ plan: "chat-single" });
    expect(chosenPlan(single)?.id).toBe("chat-web");
    expect(chosenPlan(chooseChat(single, "meta"))?.id).toBe("chat-meta");

    const withPhone = chooseCard(initialFunnel(), "chat-voice");
    expect(chosenPlan(withPhone)?.id).toBe("web-voice");
    expect(chosenPlan(chooseChat(withPhone, "meta"))?.id).toBe("meta-voice");
  });

  test("a card without the choice ignores the chat channel", () => {
    const voice = chooseChat(chooseCard(initialFunnel(), "voice"), "meta");
    expect(chosenPlan(voice)?.id).toBe("voice");
    expect(chosenPlan(chooseChat(chooseCard(initialFunnel(), "complete"), "meta"))?.id).toBe(
      "complete",
    );
  });

  test("a package link opens its own card with its own channel", () => {
    expect(chosenPlan(initialFunnel({ plan: "meta-voice" }))?.id).toBe("meta-voice");
    expect(chosenPlan(choosePlan(initialFunnel(), "chat-meta"))?.id).toBe("chat-meta");
    expect(choosePlan(initialFunnel(), "nope").cardId).toBeNull();
  });

  test("the interval comes from the link, monthly otherwise", () => {
    expect(initialFunnel({ plan: "voice", interval: "year" }).interval).toBe("year");
    expect(initialFunnel({ plan: "voice" }).interval).toBe("month");
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
  test("website chat is not sold, and the step says so", () => {
    const webVoice = answered({ noWebsite: true });
    expect(chosenPlan(webVoice)?.id).toBe("web-voice");
    expect(websiteConflict(webVoice)).toBe(true);
    expect(clinicIssues(webVoice).map((i) => i.field)).toEqual(["plan"]);
  });

  test("the phone is offered first, then the Meta bot", () => {
    expect(noWebsiteOptions().map((plan) => plan.id)).toEqual(["voice", "meta-voice", "chat-meta"]);
    for (const plan of noWebsiteOptions()) expect(plan.channels.web, plan.id).toBe(false);
  });

  test("taking an offer resolves it", () => {
    for (const id of ["voice", "meta-voice", "chat-meta"]) {
      const chosen = choosePlan(answered({ noWebsite: true }), id);
      expect(chosenPlan(chosen)?.id).toBe(id);
      expect(websiteConflict(chosen)).toBe(false);
      expect(clinicComplete(chosen)).toBe(true);
    }
  });

  test("a twin card picked without a website sells its Meta twin", () => {
    const chosen = chooseCard({ ...answered({ noWebsite: true }), cardId: null }, "chat-single");
    expect(chosenPlan(chosen)?.id).toBe("chat-meta");
    expect(websiteConflict(chosen)).toBe(false);
  });

  test("a package that needs no website is unaffected", () => {
    expect(websiteConflict(choosePlan(answered({ noWebsite: true }), "voice"))).toBe(false);
    expect(websiteConflict(answered())).toBe(false);
  });
});

describe("Meta on its own, while Meta has not approved the app", () => {
  // The catalog flag is open today (META_SOLD_ALONE, the owner, 5 October
  // 2026); each rule takes it as a parameter so its closed branch is pinned.
  const plan = (id: string) => chosenPlan(choosePlan(initialFunnel(), id), false);

  test("the chatbot card sells its website twin, whatever was picked", () => {
    expect(plan("chat-meta")?.id).toBe("chat-web");
    expect(
      chosenPlan(chooseChat(chooseCard(initialFunnel(), "chat-single"), "meta"), false)?.id,
    ).toBe("chat-web");
    // Today, open, the pick stands.
    expect(chosenPlan(choosePlan(initialFunnel(), "chat-meta"))?.id).toBe("chat-meta");
  });

  test("Meta beside the phone stays on sale", () => {
    expect(plan("meta-voice")?.id).toBe("meta-voice");
    expect(planOnSale(getPlan("meta-voice")!, false)).toBe(true);
    expect(planOnSale(getPlan("chat-meta")!, false)).toBe(false);
    expect(planOnSale(getPlan("chat-meta")!, true)).toBe(true);
  });

  test("a practice with no website is offered the phone, then Meta beside the phone", () => {
    expect(noWebsiteOptions(false).map((p) => p.id)).toEqual(["voice", "meta-voice"]);
    expect(noWebsiteOptions(true).map((p) => p.id)).toEqual(["voice", "meta-voice", "chat-meta"]);
  });

  test("so the chatbot card has nothing to sell such a practice", () => {
    const none = { noWebsite: true };
    expect(sellableTo(getPlan("chat-web")!, none, false)).toBe(false);
    expect(sellableTo(getPlan("chat-meta")!, none, false)).toBe(false);
    expect(sellableTo(getPlan("chat-meta")!, none, true)).toBe(true);
    expect(sellableTo(getPlan("meta-voice")!, none, false)).toBe(true);
    expect(sellableTo(getPlan("chat-web")!, { noWebsite: false }, false)).toBe(true);
  });
});

describe("the consequence of where bookings live", () => {
  test("while the owner's switch is off, a live system books as requests for now", () => {
    expect(DIRECT_BOOKING_OPEN).toBe(false);
    for (const id of ["google_calendar", "calendly", "calcom", "gohighlevel", "none"] as const) {
      expect(bookingConsequence(id).text, id).toBe(BOOKING_REQUESTS_FOR_NOW);
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
    expect(sameAgreementInputs(signed, agreementInputs(choosePlan(answered(), "complete")))).toBe(
      true,
    );
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
      cardId: "gold",
      specialty: "veterinary",
      bookingSystem: "zenoti",
      calendarAccount: 1,
      covered: "maybe",
      interval: "week",
      clinicName: "x".repeat(401),
    });
    expect(parsed).toEqual({
      chat: state.chat,
      website: state.website,
      noWebsite: false,
      contactName: state.contactName,
      contactTitle: state.contactTitle,
      contactEmail: state.contactEmail,
    });
    expect(parseStoredFunnel("nope")).toBeNull();
    expect(parseStoredFunnel(null)).toBeNull();
  });

  test("a pricing card or ?plan chosen now wins over the stored package; the setup link's address always wins", () => {
    const stored = { ...answered({ step: 2 }), contactEmail: "old@else.com" };
    const seed = initialFunnel({ plan: "voice", interval: "year" });
    const restored = restoreFunnel(seed, stored, {
      explicitPlan: true,
      lockedEmail: "info@glowmedspa.com",
    });
    expect(chosenPlan(restored)?.id).toBe("voice");
    expect(restored.interval).toBe("year");
    expect(restored.contactEmail).toBe("info@glowmedspa.com");
    expect(restored.clinicName).toBe("Glow Med Spa LLC");

    const kept = restoreFunnel(initialFunnel(), stored, { explicitPlan: false });
    expect(chosenPlan(kept)?.id).toBe("web-voice");
    expect(kept.contactEmail).toBe("old@else.com");
  });

  test("a twin chosen now for a practice with no website stays on its Meta package", () => {
    const stored = answered({ noWebsite: true, chat: "meta" });
    const restored = restoreFunnel(initialFunnel({ plan: "chat-single" }), stored, {
      explicitPlan: true,
    });
    expect(chosenPlan(restored)?.id).toBe("chat-meta");
  });
});
