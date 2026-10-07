import { plans, planStartSentence } from "@healdesk/catalog";
import { createElement as h, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";

import { type FunnelState, initialFunnel, noWebsiteOptions } from "@/lib/checkout/funnel";
import { setupFeeToday } from "@/lib/checkout/review";
import { siteReadLine } from "@/lib/checkout/site-read";
import { GUARANTEE_TEXT, LEGAL_VERSION } from "@/lib/legal";
import { usd } from "@/lib/pricing";

import { type AgreementResult, AgreementStep } from "./AgreementStep";
import { ClinicStep } from "./ClinicStep";
import { PackageStep } from "./PackageStep";
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
    ...initialFunnel({ plan: "chat-voice" }),
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

function packageStep(state: FunnelState) {
  return h(PackageStep, { state, onCard: noop, onChat: noop, onInterval: noop, onContinue: noop });
}

function clinicStep(state: FunnelState) {
  return h(ClinicStep, { state, update: noop, onPlan: noop, onBack: noop, onContinue: noop });
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
  for (const card of ["chat-single", "voice", "chat-dual", "chat-voice", "complete"]) {
    screens.push({
      name: `package, ${card}`,
      element: packageStep(initialFunnel({ plan: card })),
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
      reviewStep("web-voice", "month", {
        salesTax: true,
        siteRead: {
          kind: "read",
          text: "We read glowmedspa.com: 14 services, your hours, 3 providers. You'll confirm them in setup.",
        },
      }),
    );
    const order = [
      "Today: $997 setup fee",
      "never refunded",
      "Monthly billing ($897) starts the day AYA first answers a patient.",
      "Until every channel in your package is in service, your monthly price is the price of the channels that are.",
      "Included each month: 1,000 voice minutes and 1,000 chat conversations.",
      "Past that:",
      "Stop and fall back",
      "Plus sales tax where it applies.",
      "We read glowmedspa.com: 14 services, your hours, 3 providers. You'll confirm them in setup.",
      GUARANTEE_TEXT.heading,
      "Agreement signed",
      "I agree to the Terms of service",
      `(version ${LEGAL_VERSION})`,
      "Pay $997 and start setup",
    ];
    const positions = order.map((needle) => words.indexOf(needle));
    for (const [i, needle] of order.entries())
      expect(positions[i], needle).toBeGreaterThanOrEqual(0);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  test("the guarantee is there in full", () => {
    const words = text(reviewStep("voice", "month"));
    for (const paragraph of GUARANTEE_TEXT.paragraphs) {
      expect(words).toContain(paragraph.lead);
      expect(words).toContain(paragraph.body.replace(/\s+/g, " "));
    }
  });

  test("sales tax only when Stripe Tax is on", () => {
    expect(text(reviewStep("voice", "month", { salesTax: false }))).not.toContain("sales tax");
    expect(text(reviewStep("voice", "month", { salesTax: true }))).toContain(
      "Plus sales tax where it applies.",
    );
  });

  test("the setup fee is non-refundable before payment, with the setup window linked from the Terms", () => {
    const markup = renderToStaticMarkup(reviewStep("chat-web", "month"));
    expect(text(reviewStep("chat-web", "month"))).toContain(
      setupFeeToday(plans.find((p) => p.id === "chat-web")!).covers,
    );
    expect(markup).toContain('href="/terms#fees"');
  });

  test("the channels-in-service sentence only for a package of more than one channel", () => {
    expect(text(reviewStep("voice", "month"))).not.toContain("Until every channel");
    expect(text(reviewStep("complete", "month"))).toContain("Until every channel");
  });

  test("the site-read fallback when nothing was read", () => {
    expect(text(reviewStep("voice", "month"))).toContain(
      "Setup starts with three quick questions.",
    );
  });

  test("the terms tick-box and Pay ride in the phone's sticky bar", () => {
    const markup = renderToStaticMarkup(reviewStep("voice", "month"));
    expect(markup).toMatch(/class="hd-pay-bar[^"]*sticky bottom-0[^"]*sm:static/);
    expect(markup.indexOf("hd-pay-bar")).toBeLessThan(markup.indexOf('type="checkbox"'));
  });
});

describe("the package step", () => {
  test("five cards, the featured one Recommended, and no dates", () => {
    const words = text(packageStep(initialFunnel()));
    expect(words).toContain("Recommended");
    expect(words).not.toContain("Most clinics");
    expect(
      renderToStaticMarkup(packageStep(initialFunnel())).match(/name="package"/g),
    ).toHaveLength(5);
  });

  test("the locations line, once a package is chosen", () => {
    expect(text(packageStep(initialFunnel({ plan: "meta-voice" })))).toContain(
      "This sets up one location. Add more from Billing after setup: $897/mo + $997 setup fee each.",
    );
  });

  test("a practice with no website cannot pick website chat", () => {
    const markup = renderToStaticMarkup(
      packageStep(answered({ noWebsite: true, cardId: "chat-single", chat: "meta" })),
    );
    expect(markup).toMatch(
      /<input(?=[^>]*name="chatChannelChoice")(?=[^>]*value="web")(?=[^>]*disabled)[^>]*>/,
    );
    expect(markup).not.toMatch(
      /<input(?=[^>]*name="chatChannelChoice")(?=[^>]*value="meta")(?=[^>]*disabled)[^>]*>/,
    );
    expect(text(packageStep(answered({ noWebsite: true })))).toContain("Needs a website");
  });
});

describe("the clinic step", () => {
  test("asks its questions as radio groups, without the veterinary chip", () => {
    const markup = renderToStaticMarkup(clinicStep(initialFunnel({ plan: "voice" })));
    expect(markup.match(/role="radiogroup"/g)?.length).toBeGreaterThanOrEqual(3);
    expect(markup).not.toContain("Veterinary");
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

  test("no website: the phone first, then the Meta bot with its condition", () => {
    const words = text(clinicStep(answered({ noWebsite: true })));
    expect(words).toContain("Website chat needs a website");
    const phone = words.indexOf("AI Voice Agent Alone");
    const meta = words.indexOf("Meta Chatbot");
    expect(phone).toBeGreaterThan(0);
    expect(meta).toBeGreaterThan(phone);
    expect(words).toContain("whose patients already message it on Instagram, Facebook or WhatsApp");
  });

  test("no website: each package offered is priced for the billing period already chosen", () => {
    // Choosing one keeps the period (choosePlan), so the figures are the ones
    // the package cards and Review and pay give for it.
    const annual = text(clinicStep(answered({ noWebsite: true, interval: "year" })));
    const monthly = text(clinicStep(answered({ noWebsite: true, interval: "month" })));
    const options = noWebsiteOptions();
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
    // The review's own example: the phone alone, on annual terms.
    expect(annual).toContain("AI Voice Agent Alone: $637/mo billed annually + $997 setup fee");
  });
});

describe("the agreement step", () => {
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
    expect(markup).toContain("HEALDESK BUSINESS ASSOCIATE AGREEMENT");
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
    const words = text(agreementStep(answered(), { signed: SIGNED }));
    expect(words).toContain("Business Associate Agreement signed");
    expect(words).toContain("Continue to review");
    expect(words).toContain("Sign again with different answers");
    expect(words).not.toContain("Sign and continue");
  });
});
