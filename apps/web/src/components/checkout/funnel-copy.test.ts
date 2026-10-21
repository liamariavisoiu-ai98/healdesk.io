import { getPlan, PACKAGES, type Plan, planStartSentence } from "@healdesk/catalog";
import { createElement as h, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";

import { type FunnelState, initialFunnel, noWebsiteOptions } from "@/lib/checkout/funnel";
import { type SetupOffer, setupFeeToday } from "@/lib/checkout/review";
import { siteReadLine } from "@/lib/checkout/site-read";
import { GUARANTEE_TEXT, LEGAL_VERSION } from "@/lib/legal";
import { usd } from "@/lib/pricing";

import { type AgreementResult, AgreementStep } from "./AgreementStep";
import { ClinicStep } from "./ClinicStep";
import { type DemoCheckout } from "./DemoPackageExtras";
import { DEMO_INCLUDES, PackageStep } from "./PackageStep";
import { ReviewStep } from "./ReviewStep";
import { SetupRequestForm } from "./SetupRequestForm";

/**
 * What the four steps actually say, rendered and read as text (plan Part A3,
 * and the owner's rules of 6 October 2026):
 *
 * - nothing client-facing signals that we are new: never "pilot", "beta",
 *   "early access", "first clinics", "founding" or "cohort";
 * - no opening dates and no timing before purchase: how a channel goes live,
 *   never when, and no backstop date on the plan start;
 * - never "with every clinic": not every practice signs the same agreement;
 * - the plan-start sentence is on Review and pay, for every package.
 *
 * Rendered to static markup, the way the other checkout tests read their
 * components: no DOM and no testing library, because the question is what
 * the buyer is told.
 */

const noop = () => undefined;

/**
 * Every package at the sheet's example steps, and at both ends of the grid:
 * 495 plans would render the same sentences 495 times.
 */
const plans: Plan[] = [
  "voice-500",
  "webchat-300",
  "metachat-300",
  "voice-webchat-500-300",
  "voice-metachat-500-300",
  "voice-100",
  "webchat-1500",
  "metachat-100",
  "voice-webchat-1500-1500",
  "voice-metachat-100-1500",
].map((id) => getPlan(id)!);

const ENDS = "2099-01-01T00:00:00.000Z";
const OFFERS: SetupOffer[] = [
  { kind: "site", endsAt: ENDS },
  { kind: "demo", endsAt: ENDS },
  { kind: "cohort", endsAt: ENDS },
];

function text(element: ReactElement): string {
  return renderToStaticMarkup(element)
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&apos;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const NEWNESS = /\b(?:pilot|beta|early access|first clinics|founding|cohort)\b/i;

const MONTHS =
  "Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?";

/** When a channel opens or answers, in any of the ways it has been said. */
const TIMING: readonly { pattern: RegExp; label: string }[] = [
  { pattern: /\bsame[\s-](?:day|session)\b/i, label: "same day" },
  { pattern: /\bno later than\b/i, label: "a backstop date" },
  { pattern: /\bopening dates?\b|\bopens? (?:on|in|by)\b/i, label: "an opening date" },
  {
    pattern: new RegExp(`\\b\\d{1,2} (?:${MONTHS})\\b|\\b(?:${MONTHS}) \\d{1,2}\\b`),
    label: "a date",
  },
  {
    pattern: /\b(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\b/,
    label: "a weekday",
  },
  {
    // "go live today", "is answering within…": not "Where do bookings live today?", which is where they reside.
    pattern:
      /\b(?:(?:go(?:es)?|be|is|are) live|ready|answering)\s+(?:today|tomorrow|tonight|this week|within|in (?:a|one|two|three|\d+) (?:minutes?|hours?|days?))\b/i,
    label: "live by a time",
  },
  {
    pattern:
      /\b(?:within|in under|in about) (?:\d+|a few|one|two|five|ten|fifteen) (?:minutes?|hours?)\b/i,
    label: "a duration",
  },
  { pattern: /\bfifteen minutes\b/i, label: "fifteen minutes" },
];

/** A clinic that has answered the first two steps. */
function answered(overrides: Partial<FunnelState> = {}): FunnelState {
  return {
    ...initialFunnel({ plan: "voice-webchat-500-300" }),
    step: 2,
    clinicName: "Glow Med Spa LLC",
    website: "glowmedspa.com",
    specialty: "med-spa",
    bookingSystem: "google_calendar",
    calendarAccount: "workspace_baa",
    covered: "no",
    contactName: "Laura Owner",
    contactTitle: "Owner",
    contactEmail: "info@glowmedspa.com",
    ...overrides,
  };
}

const SIGNED: AgreementResult = {
  agreementId: "6f1b0c9e-8f2a-4d31-9c77-1a2b3c4d5e6f",
  version: "1.2.1",
  hash: "a".repeat(64),
  text: "HEALDESK BUSINESS ASSOCIATE AGREEMENT\n\n1. Definitions...",
  acceptedAt: "2026-10-06T10:00:00.000Z",
  approvedByCounsel: true,
};

function packageStep(state: FunnelState, offer: SetupOffer | null = null) {
  return h(PackageStep, {
    state,
    offer,
    onPackage: noop,
    onSteps: noop,
    onInterval: noop,
    onContinue: noop,
  });
}

function clinicStep(state: FunnelState, offer: SetupOffer | null = null) {
  return h(ClinicStep, { state, offer, update: noop, onPlan: noop, onBack: noop, onContinue: noop });
}

function agreementStep(
  state: FunnelState,
  extra: Partial<Parameters<typeof AgreementStep>[0]> = {},
) {
  return h(AgreementStep, {
    step: 3,
    totalSteps: 4,
    onBack: noop,
    clinicName: state.clinicName,
    specialty: state.specialty!,
    bookingSystem: state.bookingSystem!,
    calendarAccount: state.calendarAccount!,
    covered: state.covered,
    onCovered: noop,
    contactName: state.contactName,
    contactTitle: state.contactTitle,
    contactEmail: state.contactEmail,
    onContact: noop,
    signed: null,
    onSigned: noop,
    onContinue: noop,
    onResign: noop,
    ...extra,
  });
}

function reviewStep(
  planId: string,
  interval: "month" | "year",
  extra: Partial<Parameters<typeof ReviewStep>[0]> = {},
) {
  const plan = plans.find((p) => p.id === planId)!;
  return h(ReviewStep, {
    plan,
    interval,
    specialty: "med-spa",
    clinicName: "Glow Med Spa LLC",
    siteRead: siteReadLine(null, "glowmedspa.com"),
    salesTax: false,
    agreement: SIGNED,
    copyLink: h("a", { href: "#" }, "Download"),
    termsAccepted: false,
    onTerms: noop,
    submitting: false,
    error: null,
    onPay: noop,
    onBack: noop,
    ...extra,
  });
}

/** Every screen of the four steps, in the states a buyer can reach. */
function everyScreen(): { name: string; element: ReactElement; dated: boolean }[] {
  const screens: { name: string; element: ReactElement; dated: boolean }[] = [
    { name: "package, nothing chosen", element: packageStep(initialFunnel()), dated: false },
    {
      name: "package, no website",
      element: packageStep(answered({ noWebsite: true })),
      dated: false,
    },
    { name: "clinic, blank", element: clinicStep(initialFunnel({ plan: "voice" })), dated: false },
    {
      name: "clinic, no website",
      element: clinicStep(answered({ noWebsite: true })),
      dated: false,
    },
    {
      name: "agreement, unanswered",
      element: agreementStep(answered({ covered: null })),
      dated: true,
    },
    { name: "agreement, answered", element: agreementStep(answered()), dated: true },
    {
      name: "agreement, signed",
      element: agreementStep(answered(), { signed: SIGNED }),
      dated: true,
    },
  ];
  for (const pkg of PACKAGES) {
    for (const interval of ["month", "year"] as const) {
      screens.push({
        name: `package, ${pkg.id} ${interval}`,
        element: packageStep(initialFunnel({ plan: pkg.id, interval })),
        dated: false,
      });
    }
  }
  for (const offer of OFFERS) {
    screens.push({
      name: `package, ${offer.kind} offer`,
      element: packageStep(initialFunnel({ plan: "voice-metachat" }), offer),
      dated: false,
    });
    screens.push({
      name: `clinic, no website, ${offer.kind} offer`,
      element: clinicStep(answered({ noWebsite: true }), offer),
      dated: false,
    });
    screens.push({
      name: `review, ${offer.kind} offer`,
      element: reviewStep("voice-metachat-500-300", "month", { offer }),
      dated: false,
    });
  }
  for (const system of ["google_calendar", "gohighlevel", "mindbody", "other"] as const) {
    screens.push({
      name: `clinic, ${system}`,
      element: clinicStep(answered({ bookingSystem: system })),
      dated: false,
    });
  }
  for (const plan of plans) {
    for (const interval of ["month", "year"] as const) {
      screens.push({
        name: `review, ${plan.id} ${interval}`,
        element: reviewStep(plan.id, interval, { salesTax: true }),
        dated: false,
      });
    }
  }
  return screens;
}

describe("the rules", () => {
  test("catch what they are for, so a pass means the words are absent", () => {
    const examples: Record<string, string> = {
      "same day": "Your phone, once call forwarding is set, usually the same day.",
      "a backstop date":
        "Monthly billing starts the day AYA first answers a patient, and no later than 4 Dec.",
      "an opening date": "Phone opens on the date in your dashboard.",
      "a date": "Opens Mon 20 Oct",
      "a weekday": "We'll reply by Tuesday 7 October.",
      "live by a time": "Website chat goes live today.",
      "a duration": "Answering within 5 minutes of setup.",
      "fifteen minutes": "Setup takes about fifteen minutes.",
    };
    for (const rule of TIMING) expect(examples[rule.label], rule.label).toMatch(rule.pattern);
    for (const word of ["pilot", "Beta", "early access", "first clinics", "founding", "cohort"]) {
      expect(`Join our ${word} programme`).toMatch(NEWNESS);
    }
    expect("Where do bookings live today?").not.toMatch(
      TIMING.find((r) => r.label === "live by a time")!.pattern,
    );
  });
});

describe("no newness words, anywhere in the purchase", () => {
  test.each(everyScreen().map((screen) => [screen.name, screen] as const))(
    "%s",
    (_name, screen) => {
      expect(text(screen.element)).not.toMatch(NEWNESS);
    },
  );

  test("nor in the form that asks for a setup link", () => {
    expect(text(h(SetupRequestForm, { replyBy: "Tuesday 7 October" }))).not.toMatch(NEWNESS);
  });
});

describe("no opening dates and no timing before purchase", () => {
  const undated = everyScreen().filter((screen) => !screen.dated);
  test.each(TIMING.map((rule) => [rule.label, rule] as const))("no %s", (_label, { pattern }) => {
    const offenders = undated
      .filter((screen) => pattern.test(text(screen.element)))
      .map((screen) => screen.name);
    expect(offenders).toEqual([]);
  });

  test("the agreement step's own words carry no timing either, beside the dated document", () => {
    // The document carries its effective date and its own legal terms, and
    // "Signing as" the date of signing: dates of the signature, not of a
    // channel. The step's own words are everything but the document.
    for (const screen of everyScreen().filter((s) => s.dated)) {
      const words = renderToStaticMarkup(screen.element)
        .replace(/<pre[\s\S]*?<\/pre>/g, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ");
      for (const rule of TIMING.filter((r) => r.label !== "a date")) {
        expect(words, `${screen.name}: ${rule.label}`).not.toMatch(rule.pattern);
      }
    }
  });
});

describe('never "with every clinic"', () => {
  test.each(everyScreen().map((screen) => [screen.name, screen] as const))(
    "%s",
    (_name, screen) => {
      expect(text(screen.element)).not.toMatch(/with every clinic/i);
    },
  );
});

/**
 * Overage is billed per started block of 100 since 6 October 2026
 * (docs/v1-product-spec.md, "Overage prices"), so no screen of the purchase
 * may quote a rate per minute or per conversation. The block prices
 * themselves are held to the catalog in src/lib/overage-copy.test.ts.
 */
const PER_UNIT =
  /\/min\b|\/conversation|\bper (?:voice |phone )?minute|\bper (?:chat )?conversation|\ba voice minute|\ba chat conversation|\$0\.\d\d/i;

describe("no per-unit overage rate, anywhere in the purchase", () => {
  test("the rule catches the wording it replaced", () => {
    for (const old of [
      "$0.80/min",
      "$0.30/conversation",
      "Past that: $0.80 a voice minute and $0.30 a chat conversation",
      "billed per minute or per conversation",
    ]) {
      expect(old).toMatch(PER_UNIT);
    }
    expect("$80 for each started block of 100 extra voice minutes").not.toMatch(PER_UNIT);
  });

  test.each(everyScreen().map((screen) => [screen.name, screen] as const))(
    "%s",
    (_name, screen) => {
      expect(text(screen.element)).not.toMatch(PER_UNIT);
    },
  );
});

describe("Review and pay", () => {
  test.each(
    plans.flatMap((plan) =>
      (["month", "year"] as const).map((interval) => [plan.id, interval] as const),
    ),
  )("%s %s carries the plan-start sentence", (planId, interval) => {
    const plan = plans.find((p) => p.id === planId)!;
    expect(text(reviewStep(planId, interval))).toContain(
      planStartSentence(plan, interval, "patient"),
    );
  });

  test("says it all, in the plan's order", () => {
    const words = text(
      reviewStep("voice-webchat-500-300", "month", {
        salesTax: true,
        siteRead: {
          kind: "read",
          text: "We read glowmedspa.com: 14 services, your hours, 3 providers. You'll confirm them in setup.",
        },
      }),
    );
    const order = [
      "Glow Med Spa LLC · AYA Voice + Web Chat, 500 minutes and 300 conversations, billed monthly",
      "Today: $956 setup fee",
      "never refunded",
      "Monthly billing ($520) starts the day AYA first answers a patient.",
      "Until every channel in your package is in service, your monthly price is the price of the channels that are.",
      "Included each month: 500 voice minutes and 300 chat conversations.",
      "Past that:",
      "We email you at 90% of your included amount",
      "Stop and fall back",
      "Plus sales tax where it applies.",
      "We read glowmedspa.com: 14 services, your hours, 3 providers. You'll confirm them in setup.",
      GUARANTEE_TEXT.heading,
      "Agreement signed",
      "I agree to the Terms of service",
      `(version ${LEGAL_VERSION})`,
      "Pay $956 and start setup",
    ];
    const positions = order.map((needle) => words.indexOf(needle));
    for (const [i, needle] of order.entries())
      expect(positions[i], needle).toBeGreaterThanOrEqual(0);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  test("the guarantee is there in full", () => {
    const words = text(reviewStep("voice-500", "month"));
    for (const paragraph of GUARANTEE_TEXT.paragraphs) {
      expect(words).toContain(paragraph.lead);
      expect(words).toContain(paragraph.body.replace(/\s+/g, " "));
    }
  });

  test("sales tax only when Stripe Tax is on", () => {
    expect(text(reviewStep("voice-500", "month", { salesTax: false }))).not.toContain("sales tax");
    expect(text(reviewStep("voice-500", "month", { salesTax: true }))).toContain(
      "Plus sales tax where it applies.",
    );
  });

  test("the setup fee is non-refundable before payment, with the setup window linked from the Terms", () => {
    const markup = renderToStaticMarkup(reviewStep("webchat-300", "month"));
    expect(text(reviewStep("webchat-300", "month"))).toContain(
      setupFeeToday(getPlan("webchat-300")!).covers,
    );
    expect(markup).toContain('href="/terms#fees"');
  });

  test("the channels-in-service sentence only for a package of more than one channel", () => {
    expect(text(reviewStep("voice-500", "month"))).not.toContain("Until every channel");
    expect(text(reviewStep("voice-metachat-500-300", "month"))).toContain("Until every channel");
  });

  test("the site-read fallback when nothing was read", () => {
    expect(text(reviewStep("voice-500", "month"))).toContain(
      "Setup starts with three quick questions.",
    );
  });

  test("today's figure, the line under it and the button are the price after the offer", () => {
    const words = text(reviewStep("voice-metachat-500-300", "month", { offer: OFFERS[0] }));
    expect(words).toContain("Today: $976 setup fee");
    expect(words).toContain("$1,394 less $418: 30% off setup. Our website offer.");
    expect(words).toContain("Pay $976 and start setup");
    // The plan still starts at the first answer, at its own price.
    expect(words).toContain("Monthly billing ($580) starts the day AYA first answers a patient.");
    const demo = text(reviewStep("voice-500", "month", { offer: OFFERS[1] }));
    expect(demo).toContain("Today: $349 setup fee");
    expect(demo).toContain("Pay $349 and start setup");
    expect(text(reviewStep("voice-500", "month"))).not.toContain(" less ");
  });

  test("the terms tick-box and Pay ride in the phone's sticky bar", () => {
    const markup = renderToStaticMarkup(reviewStep("voice-500", "month"));
    expect(markup).toMatch(/class="hd-pay-bar[^"]*sticky bottom-0[^"]*sm:static/);
    expect(markup.indexOf("hd-pay-bar")).toBeLessThan(markup.indexOf('type="checkbox"'));
  });
});

describe("the package step", () => {
  test("five packages, the featured one Recommended, the sheet's words, and no dates", () => {
    const words = text(packageStep(initialFunnel()));
    expect(words).toContain("Recommended");
    expect(words).toContain(
      "Pick what your clinic needs. Pay by usage, in simple steps of 100. Prices are per location.",
    );
    expect(words).not.toContain("Most clinics");
    expect(
      renderToStaticMarkup(packageStep(initialFunnel())).match(/name="package"/g),
    ).toHaveLength(5);
  });

  test("a step control per product the package has, 100 to 1,500 in steps of 100", () => {
    const sliders = (state: FunnelState) =>
      renderToStaticMarkup(packageStep(state)).match(/<input[^>]*type="range"[^>]*>/g) ?? [];
    expect(sliders(initialFunnel())).toHaveLength(0);
    expect(sliders(initialFunnel({ plan: "voice" }))).toHaveLength(1);
    expect(sliders(initialFunnel({ plan: "metachat" }))).toHaveLength(1);
    const both = sliders(initialFunnel({ plan: "voice-metachat-500-300" }));
    expect(both).toHaveLength(2);
    for (const slider of both) {
      expect(slider).toMatch(/min="100"/);
      expect(slider).toMatch(/max="1500"/);
      expect(slider).toMatch(/step="100"/);
    }
    expect(both[0]).toMatch(/value="500"/);
    expect(both[0]).toContain('aria-valuetext="500 minutes a month, $400 a month"');
    expect(both[1]).toContain('aria-valuetext="300 conversations a month, $180 a month"');
  });

  test("the price moves with the steps, and the extra 100 is quoted as provisional", () => {
    const words = text(packageStep(initialFunnel({ plan: "voice-webchat-500-300" })));
    expect(words).toContain("AYA Voice + Web Chat, 500 minutes and 300 conversations");
    expect(words).toContain("$520/mo");
    expect(words).toContain("Each extra 100 minutes: $104, provisional.");
    expect(words).toContain("Each extra 100 conversations: $52, provisional.");
    const annual = text(packageStep(initialFunnel({ plan: "voice-500", interval: "year" })));
    expect(annual).toContain("$320 /mo billed annually, $3,840 a year");
  });

  test("what happens at 90%, and that moving up is the better deal", () => {
    expect(text(packageStep(initialFunnel({ plan: "voice" })))).toContain(
      "When you reach 90% of your included amount, we email you. You can move up a step, or do nothing and let each next 100 bill at the extra-100 price. If you regularly go over, moving up a step is the better deal.",
    );
  });

  test("the setup fee: list price struck, the price after the offer, and its clock", () => {
    const plain = text(packageStep(initialFunnel({ plan: "voice-metachat" })));
    expect(plain).toContain("Setup fee $1,394, once");
    expect(plain).not.toContain("off your setup fee");

    const markup = renderToStaticMarkup(packageStep(initialFunnel({ plan: "voice-metachat" }), OFFERS[0]));
    expect(markup).toMatch(/<s[^>]*>.*\$1,394<\/s>/);
    const words = text(packageStep(initialFunnel({ plan: "voice-metachat" }), OFFERS[0]));
    expect(words).toContain("30% off your setup fee");
    expect(words).toContain("Ends in");
    expect(words).toContain("was $1,394 now $976");
    expect(markup).toContain('role="timer"');

    expect(text(packageStep(initialFunnel({ plan: "voice" }), OFFERS[1]))).toContain(
      "was $697 now $349",
    );
  });

  test("the locations line, once a package is chosen", () => {
    expect(text(packageStep(initialFunnel({ plan: "voice-metachat" })))).toContain(
      "This sets up one location. Add more from Billing after setup: $580/mo + $1,394 setup fee each. One AYA answers for all of them.",
    );
  });

  test("a demo buyer is told the support there is, and one thing about locations", () => {
    // Until 19 October 2026 the demo's package step said "+ 24/7 support
    // included · unlimited modifications", where support is the portal's help
    // chat and hello@ (plan Decisions, "Support"), and offered "Get a quote
    // from sales" for more locations two lines above a fixed price for them.
    const demo: DemoCheckout = {
      clinicName: "Glow Med Spa",
      audience: "patients",
      roi: { priceUsd: 450, priceSource: "the clinic's site", bookingRate: 0.3, repeat: null },
    };
    const words = text(
      h(PackageStep, {
        state: initialFunnel({ plan: "voice-metachat" }),
        demo,
        onPackage: noop,
        onSteps: noop,
        onInterval: noop,
        onContinue: noop,
      }),
    );
    expect(words).toContain(DEMO_INCLUDES);
    expect(words).toContain("support in your portal and at hello@healdesk.io");
    expect(words).not.toMatch(/24\/7 support|unlimited modifications/i);
    expect(words).not.toMatch(/quote from sales|More than one location\?/i);
    // The one locations line, with its fixed price, as every buyer reads it.
    expect(words.match(/This sets up one location\. Add more from Billing after setup: /g)).toHaveLength(1);
  });

  test("a practice with no website cannot pick Web Chat", () => {
    const markup = renderToStaticMarkup(packageStep(answered({ noWebsite: true })));
    expect(markup).toMatch(/<input(?=[^>]*name="package")(?=[^>]*value="webchat")(?=[^>]*disabled)[^>]*>/);
    expect(markup).not.toMatch(
      /<input(?=[^>]*name="package")(?=[^>]*value="metachat")(?=[^>]*disabled)[^>]*>/,
    );
    expect(text(packageStep(answered({ noWebsite: true })))).toContain("Needs a website");
  });
});

describe("the clinic step", () => {
  test("asks its questions as radio groups, with the veterinary chip since the DPA's release", () => {
    const markup = renderToStaticMarkup(clinicStep(initialFunnel({ plan: "voice" })));
    expect(markup.match(/role="radiogroup"/g)?.length).toBeGreaterThanOrEqual(3);
    // A veterinary practice signs the Data Protection Agreement, released on
    // 20 October 2026; until then the chip was not offered.
    expect(markup).toContain("Veterinary");
    expect(text(clinicStep(initialFunnel({ plan: "voice" })))).toContain(
      "Where do bookings live today?",
    );
    expect(text(clinicStep(initialFunnel({ plan: "voice" })))).toContain(
      "Which Google account will bookings go into?",
    );
  });

  test("the consequence is said the moment the booking system is chosen", () => {
    expect(text(clinicStep(answered()))).toContain(
      "For now your team confirms each booking AYA takes; live booking switches on once your calendar is connected and checked.",
    );
    expect(text(clinicStep(answered({ bookingSystem: "mindbody" })))).toContain(
      "confirm it in Mindbody",
    );
    expect(renderToStaticMarkup(clinicStep(answered({ bookingSystem: "gohighlevel" })))).toContain(
      'href="https://help.gohighlevel.com/support/solutions/articles/155000002374"',
    );
  });

  test("the consequence follows the owner's direct-booking switch, as the page hands it in", () => {
    const on = h(ClinicStep, {
      state: answered(),
      directBooking: true,
      update: noop,
      onPlan: noop,
      onBack: noop,
      onContinue: noop,
    });
    expect(text(on)).toContain("AYA books straight into your Google Calendar once it is connected and checked.");
    expect(text(on)).not.toContain("For now your team confirms");
    // A system that never books live says so whatever the switch.
    expect(text(h(ClinicStep, { ...on.props, state: answered({ bookingSystem: "mindbody" }) }))).toContain(
      "confirm it in Mindbody",
    );
  });

  test("no website: the phone first, then Meta Chat beside it, then Meta Chat with its condition", () => {
    const words = text(clinicStep(answered({ noWebsite: true })));
    expect(words).toContain("AYA Web Chat needs a website");
    const phone = words.indexOf("AYA Voice, 500 minutes:");
    const both = words.indexOf("AYA Voice + Meta Chat, 500 minutes and 300 conversations:");
    const meta = words.indexOf("AYA Meta Chat, 300 conversations:");
    expect(phone).toBeGreaterThan(0);
    expect(both).toBeGreaterThan(phone);
    expect(meta).toBeGreaterThan(both);
    expect(words).toContain("whose patients already message it on Instagram, Facebook or WhatsApp");
    expect(words).toContain("if your patients already message you on Instagram, Facebook or WhatsApp");
  });

  test("no website: a vet's packages say clients, and before the specialty is chosen both words", () => {
    const vet = text(clinicStep(answered({ noWebsite: true, specialty: "veterinary", covered: null })));
    expect(vet).toContain("whose clients already message it on Instagram, Facebook or WhatsApp");
    expect(vet).toContain("if your clients already message you on Instagram, Facebook or WhatsApp");
    expect(vet).not.toMatch(/\bpatients?\b/i);

    const unknown = text(clinicStep(answered({ noWebsite: true, specialty: null })));
    expect(unknown).toContain(
      "whose patients or clients already message it on Instagram, Facebook or WhatsApp",
    );
  });

  test("no website: each package offered is priced for the billing period already chosen", () => {
    // Choosing one keeps the period (choosePlan), so the figures are the ones
    // the package cards and Review and pay give for it.
    const annual = text(clinicStep(answered({ noWebsite: true, interval: "year" })));
    const monthly = text(clinicStep(answered({ noWebsite: true, interval: "month" })));
    const options = noWebsiteOptions(answered());
    expect(options.length).toBeGreaterThan(0);
    for (const plan of options) {
      const setup = `+ ${usd.format(plan.setupFeeUsd)} setup fee`;
      expect(annual).toContain(
        `${plan.name}: ${usd.format(plan.annualMonthlyUsd)}/mo billed annually ${setup}`,
      );
      expect(annual).not.toContain(`${plan.name}: ${usd.format(plan.monthlyUsd)}/mo`);
      expect(monthly).toContain(`${plan.name}: ${usd.format(plan.monthlyUsd)}/mo ${setup}`);
    }
    expect(monthly).not.toContain("billed annually");
    // The sheet's own example: the phone alone, 500 minutes, on annual terms.
    expect(annual).toContain("AYA Voice, 500 minutes: $320/mo billed annually + $697 setup fee");
  });

  test("no website: each package offered carries the setup offer's price", () => {
    expect(text(clinicStep(answered({ noWebsite: true }), OFFERS[0]))).toContain(
      "AYA Voice, 500 minutes: $400/mo + $488 setup fee",
    );
  });
});

describe("the agreement step", () => {
  /**
   * The check of 19 October 2026: "or sent by a person if it can't go at
   * once" promised a person whom no relay reaches while the host is off, or
   * while apps/app predates the operation. The page itself always says when
   * a copy did not go, and how to get it.
   */
  test("promises only what the page itself does about a copy", () => {
    const said = text(agreementStep(answered()));
    expect(said).toContain("A copy is emailed to you, and this page says if it can't be.");
    expect(said).not.toMatch(/sent by a person/i);
  });

  test("the Inbound only box names a practice's patients (AgreementStep.audience.test.ts: a vet's clients)", () => {
    const said = text(agreementStep(answered()));
    const box = said.slice(said.indexOf("Inbound only"), said.indexOf("placed in your name"));
    expect(box).toContain("It never calls or texts your patients");
    expect(box).toContain("every conversation it has is one a patient started");
  });

  test("asks the covered-entity question in terms of billing", () => {
    expect(text(agreementStep(answered({ covered: null })))).toContain(
      "Do you bill any health insurance electronically, yourself or through a clearinghouse?",
    );
    expect(text(agreementStep(answered({ covered: null })))).toContain(
      "Answer the question above and your agreement will appear here.",
    );
  });

  test("shows the document once it is answered, with a marker at its end", () => {
    const markup = renderToStaticMarkup(agreementStep(answered()));
    // "No": the Data Protection Agreement, since its release; "Yes": the BAA.
    expect(markup).toContain("HEALDESK DATA PROTECTION AGREEMENT");
    expect(markup).not.toContain("HEALDESK BUSINESS ASSOCIATE AGREEMENT");
    expect(renderToStaticMarkup(agreementStep(answered({ covered: "yes" })))).toContain(
      "HEALDESK BUSINESS ASSOCIATE AGREEMENT",
    );
    const vet = renderToStaticMarkup(
      agreementStep(answered({ specialty: "veterinary", covered: null })),
    );
    expect(vet).toContain("HEALDESK DATA PROTECTION AGREEMENT");
    // A veterinary practice is never asked the covered-entity question.
    expect(vet).not.toContain("Do you bill any health insurance electronically");
    expect(markup).toContain("data-agreement-end");
    // Inline below 640px, a scroll box above: never a box on a phone.
    expect(markup).toMatch(/sm:max-h-80 sm:overflow-y-auto/);
    expect(markup).not.toMatch(/(?<![\w:-])max-h-80/);
    expect(renderToStaticMarkup(agreementStep(answered(), { signed: SIGNED }))).not.toMatch(
      /(?<![\w:-])max-h-80/,
    );
  });

  test("the email is the clinic's one address, and the setup link's address cannot change", () => {
    expect(text(agreementStep(answered()))).toContain(
      "This is where healdesk signs you in and sends everything.",
    );
    const locked = renderToStaticMarkup(
      agreementStep(answered(), { lockedEmail: "info@glowmedspa.com" }),
    );
    expect(locked).toMatch(
      /value="info@glowmedspa.com"[^>]*readOnly|readOnly[^>]*value="info@glowmedspa.com"/i,
    );
  });

  test("a signature for these answers is shown, not offered again", () => {
    const words = text(agreementStep(answered({ covered: "yes" }), { signed: SIGNED }));
    expect(words).toContain("Business Associate Agreement signed");
    const dpa = text(
      agreementStep(answered(), {
        signed: { ...SIGNED, version: "dpa/1.0.0", text: "HEALDESK DATA PROTECTION AGREEMENT\n\n1. DEFINITIONS..." },
      }),
    );
    expect(dpa).toContain("Data Protection Agreement signed");
    expect(dpa).not.toContain("Business Associate Agreement signed");
    expect(words).toContain("Continue to review");
    expect(words).toContain("Sign again with different answers");
    expect(words).not.toContain("Sign and continue");
  });
});
