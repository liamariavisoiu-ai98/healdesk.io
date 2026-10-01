import { describe, expect, test } from "vitest";

import { SEGMENTS } from "@healdesk/catalog";

import { BOOKING_MODE_LABEL, CAPABILITY_LABEL } from "../src/enrich/capabilities.ts";
import { assertSendableCopy, copyViolations } from "../src/enrich/copy-guard.ts";
import { buildOutreachRow } from "../src/enrich/outreach.ts";
import { buildUnreadableRow } from "../src/enrich/unreadable.ts";

/**
 * The pre-send copy gate.
 *
 * Every sentence the generator can put in front of a clinic, across every
 * segment, booking system, hours shape, social mix and reader, must be free of
 * what v1 cannot do or claim (docs/v1-product-spec.md → "Copy and pricing
 * changes this scope requires"). docs/outreach/STEP-BY-STEP.md makes this
 * test passing, and the CSVs regenerated after it, a condition of loading any
 * list into the sending tool.
 */

describe("the guard itself", () => {
  // The guard is only worth something if it catches what used to go out.
  test.each([
    "Our smart assistant covers your calls, and brings your lapsed patients back",
    "We run win-backs for you",
    "Automated winback sequences",
    "Reactivation of old patients",
    "and checks in after treatment",
    "a post-treatment check-in",
    "a follow-up after every call",
    "we follow up with every lead",
    "appointment reminders",
    "SMS confirmations",
    "missed-call texting",
    "which is revenue you have already banked",
    "fully HIPAA compliant",
    "live in two minutes",
    "then secures the deposit before they ring off",
    "takes a deposit on the call",
  ])("refuses %j", (text) => {
    expect(copyViolations(text)).not.toEqual([]);
  });

  test.each([
    "Our smart assistant picks up your calls, website chat and Instagram, then books them in",
    "Our smart assistant handles your calls and website chat, and takes the deposit in chat where you want one",
    "Where do the calls after 5pm go now?",
  ])("lets %j through", (text) => {
    expect(copyViolations(text)).toEqual([]);
  });

  test("assertSendableCopy refuses the file, naming the row and the column", () => {
    expect(() =>
      assertSendableCopy("all-leads.csv", [
        { email: "a@x.com", hook: "Fine.", top_offer: "and brings your lapsed patients back", closing_question: "?" },
      ]),
    ).toThrow(/all-leads\.csv.*\n.*a@x\.com top_offer/);
    expect(() =>
      assertSendableCopy("all-leads.csv", [{ email: "a@x.com", hook: "Fine.", top_offer: "", closing_question: "" }]),
    ).not.toThrow();
  });
});

describe("every sentence the generator can produce", () => {
  test("every capability and booking-mode label is clean", () => {
    for (const text of [...Object.values(CAPABILITY_LABEL), ...Object.values(BOOKING_MODE_LABEL)]) {
      expect(copyViolations(text), text).toEqual([]);
    }
  });

  test("every outreach row is clean", () => {
    const platforms = [null, "gohighlevel", "mindbody", "booker", "boulevard", "calendly", "zenoti"];
    const hoursShapes = [
      undefined,
      {
        closedDays: ["Saturday", "Sunday"], closedHoursPerWeek: 128, closesAt: "17:00",
        gap: { hours: 64, startsDay: "Friday", startsAt: "17:00", endsDay: "Monday", endsAt: "09:00" },
        match: "strong",
      },
      { closedDays: [], closedHoursPerWeek: 110, closesAt: "17:00", gap: null, match: "strong" },
      { closedDays: ["Saturday"], closedHoursPerWeek: 120, closesAt: "19:00", gap: null, match: "strong" },
    ];
    const socials = [[], ["instagram"], ["facebook"], ["whatsapp"], ["tiktok"]];
    const contacts = [
      { jobTitle: "Owner", email: "jane@clinic.com" },
      { jobTitle: "Receptionist", email: "info@clinic.com" },
    ];
    const sites = [{}, { chainTier: "multi-site-group", siteCount: 3 }];

    let checked = 0;
    for (const segment of SEGMENTS) {
      for (const online of [true, false]) {
        for (const platform of platforms) {
          for (const hours of hoursShapes) {
            for (const social of socials) {
              for (const contact of contacts) {
                for (const site of sites) {
                  const row = buildOutreachRow(
                    {
                      clinicId: "c", segment, confidence: "high", evidence: "",
                      opensAt: null, closesAt: null, hoursByDay: null, topService: "Botox",
                      offersOnlineBooking: online, mentionsWeightLoss: false,
                      isChainOrFranchise: false, ...site,
                    } as never,
                    { hasOnlineBooking: online || platform !== null, platform } as never,
                    hours as never,
                    { ...contact, social },
                  );
                  for (const [column, text] of [
                    ["hook", row.hook],
                    ["top_offer", row.topOffer],
                    ["closing_question", row.closingQuestion],
                  ] as const) {
                    expect(copyViolations(text), `${segment}/${platform}/${column}: ${text}`).toEqual([]);
                  }
                  checked += 1;
                }
              }
            }
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(1_000);
  });

  test("every unreadable-site row is clean", () => {
    for (const reason of ["no pages fetched", "too little text"] as const) {
      for (const contact of [
        { jobTitle: "Owner", email: "jane@clinic.com" },
        { jobTitle: "", email: "info@clinic.com" },
      ]) {
        const row = buildUnreadableRow({ domain: "clinic.com" } as never, contact, reason);
        for (const text of [row.hook, row.offer, row.closingQuestion]) {
          expect(copyViolations(text), text).toEqual([]);
        }
      }
    }
  });
});
