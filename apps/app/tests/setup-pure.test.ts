import { CHANNEL_NAMES, CHANNELS, NEVER_SAY_DEFAULTS } from "@healdesk/catalog";
import { afterEach, describe, expect, test } from "vitest";

import type { ChannelState } from "@/lib/channels/state";
import {
  moveSetupDeadline,
  setupDeadline,
  setupLastDay,
  setupWindowStart,
} from "@/lib/clinic/setup-window";
import { copyProblems } from "@/lib/email/lint";
import { validateAgentConfig } from "@/lib/onboarding/agent-config";
import type { CalendarConnectionView } from "@/lib/connections/google-calendar";
import { bookingLines, rightNowLine } from "@/lib/setup/calendar";
import {
  actionLine,
  channelNextStep,
  channelStatusWord,
  isClinicAction,
  setupLine,
  type ChannelNextStep,
} from "@/lib/setup/channels";
import { emailCallUrl, formatPhone, helpContacts } from "@/lib/setup/help";
import {
  KnowledgeError,
  neverSayWithDefaults,
  serviceFromProfile,
  serviceInputOf,
  validateAnswer,
  validateServices,
} from "@/lib/setup/knowledge";
import {
  carryServiceDetails,
  inferPriceKind,
  priceKindFits,
  priceKindOf,
} from "@/lib/setup/prices";
import { dueReminderNumber, isDaytime, SETUP_REMINDER_COUNT } from "@/lib/setup/reminders";
import {
  neighbours,
  resumeScreen,
  screensFor,
  stepsLeft,
  wizardFinished,
  type Progress,
  type WizardFacts,
} from "@/lib/setup/screens";
import {
  coverageModeForRouting,
  routingForCoverageMode,
  toE164,
  usNumber,
} from "@/lib/setup/settings";
import { skipCost } from "@/lib/setup/skip-costs";
import type { SetupState } from "@/lib/setup/state";
import { answersMissing, buildTracker, joinWords } from "@/lib/setup/tracker";
import { urgentHelpField, urgentHelpNumber } from "@/lib/setup/urgent";

/**
 * The setup wizard's rules that need no database (plan Part E): which screens
 * a clinic sees and where it resumes, each channel's next step in words, the
 * reminder schedule, the tracker's done-rules, the knowledge validation and
 * Help's environment handling.
 */

const SAVED: Record<string, string | undefined> = {};
const ENV = ["HEALDESK_SUPPORT_PHONE", "HEALDESK_CALL_BOOKING_URL", "BETTER_AUTH_URL"] as const;
for (const key of ENV) SAVED[key] = process.env[key];
afterEach(() => {
  for (const key of ENV) {
    if (SAVED[key] === undefined) delete process.env[key];
    else process.env[key] = SAVED[key];
  }
});

const BASE: WizardFacts = {
  channels: ["web", "voice"],
  regulatoryRegime: "hipaa-if-covered",
  agreementKind: "baa",
  isCoveredEntity: false,
  hasBackup: false,
};
const none: Progress = new Map();
const at = new Date("2026-10-07T12:00:00Z");

describe("the clinic's screens", () => {
  test("four steps in order, the phone's two questions only with voice, the backup last", () => {
    expect(screensFor(BASE, none)).toEqual([
      "basics",
      "hours",
      "services",
      "question",
      "tone",
      "coverage",
      "direct_line",
      "deposits",
      "urgent",
      "calendar",
      "providers",
      "channels",
      "backup",
    ]);
    const chat = screensFor({ ...BASE, channels: ["web"] }, none);
    expect(chat).not.toContain("coverage");
    expect(chat).not.toContain("direct_line");
  });

  test("the insurance question only for a BAA practice that was not sure, and never for a vet or a DPA", () => {
    expect(screensFor({ ...BASE, isCoveredEntity: null }, none)).toContain("insurance");
    expect(screensFor({ ...BASE, isCoveredEntity: true }, none)).not.toContain("insurance");
    expect(
      screensFor({ ...BASE, isCoveredEntity: null, regulatoryRegime: "hipaa" }, none),
    ).not.toContain("insurance");
    expect(
      screensFor({ ...BASE, isCoveredEntity: null, agreementKind: "dpa" }, none),
    ).not.toContain("insurance");
    expect(
      screensFor({ ...BASE, isCoveredEntity: null, regulatoryRegime: "non-hipaa" }, none),
    ).not.toContain("insurance");
  });

  test("a screen already left stays in the list when its reason has gone, so its tick stays", () => {
    const answered: Progress = new Map([["insurance", { outcome: "done", at }]]);
    expect(screensFor({ ...BASE, isCoveredEntity: true }, answered)).toContain("insurance");
    const withBackup = screensFor({ ...BASE, hasBackup: true }, none);
    expect(withBackup).not.toContain("backup");
    expect(
      screensFor({ ...BASE, hasBackup: true }, new Map([["backup", { outcome: "done", at }]])),
    ).toContain("backup");
  });

  test("resumes on the first screen nobody answered or skipped, and counts the steps left", () => {
    const screens = screensFor(BASE, none);
    expect(resumeScreen(screens, none)).toBe("basics");
    expect(stepsLeft(screens, none)).toBe(4);
    const progress: Progress = new Map([
      ["basics", { outcome: "done", at }],
      ["hours", { outcome: "skipped", at }],
      ["services", { outcome: "done", at }],
      ["question", { outcome: "done", at }],
    ]);
    expect(resumeScreen(screens, progress)).toBe("tone");
    expect(stepsLeft(screens, progress)).toBe(3);
    expect(wizardFinished(screens, progress)).toBe(false);
    const all: Progress = new Map(
      screens.filter((s) => s !== "backup").map((s) => [s, { outcome: "done" as const, at }]),
    );
    expect(wizardFinished(screens, all)).toBe(true);
    expect(resumeScreen(screens, all)).toBe("backup");
    expect(neighbours(screens, "basics")).toEqual({ previous: null, next: "hours" });
    expect(neighbours(screens, "backup")).toEqual({ previous: "channels", next: null });
  });
});

function state(
  channel: ChannelState["channel"],
  status: ChannelState["status"],
  waitingOn: ChannelState["waitingOn"] = null,
) {
  return { channel, status, waitingOn };
}

describe("each channel's next step", () => {
  test("nothing for a live, paused or switched-off channel; setup first; then what the channel waits on", () => {
    expect(channelNextStep(state("web", "live"), false)).toBe("none");
    expect(channelNextStep(state("web", "off"), true)).toBe("none");
    expect(channelNextStep(state("web", "setting_up"), false)).toBe("finish_setup");
    expect(channelNextStep(state("web", "waiting", "snippet"), false)).toBe("finish_setup");
    expect(channelNextStep(state("web", "waiting", "snippet"), true)).toBe("snippet");
    expect(channelNextStep(state("voice", "waiting", "setup"), true)).toBe("finish_setup");
    expect(channelNextStep(state("voice", "setting_up"), true)).toBe("preparing");
    expect(isClinicAction("preparing")).toBe(false);
    expect(isClinicAction("forwarding")).toBe(true);
  });

  test("every line is plain words: no dates, no newness, no claims the copy lint refuses", () => {
    const steps: ChannelNextStep[] = [
      "finish_setup",
      "snippet",
      "forwarding",
      "meta_connect",
      "whatsapp_payment_method",
      "preparing",
      "none",
    ];
    for (const channel of CHANNELS) {
      for (const step of steps) {
        const line = setupLine(channel, step);
        expect(line.startsWith(`${CHANNEL_NAMES[channel]}: `), line).toBe(true);
        expect(copyProblems(line), line).toEqual([]);
        expect(line, line).not.toMatch(/\d/);
      }
    }
    expect(actionLine("voice", "forwarding")).toBe("Set call forwarding on your main line");
    expect(channelStatusWord("setting_up")).toBe("Being prepared");
    expect(channelStatusWord("waiting")).toBe("Waiting on you");
  });

  test("phone never asks for forwarding before voice is ready", () => {
    expect(setupLine("voice", "preparing")).toMatch(/Don't change your call forwarding yet/);
    expect(setupLine("voice", "finish_setup")).toMatch(
      /Don't change your call forwarding until then/,
    );
  });
});

describe("the reminder schedule", () => {
  test("day 5, 10, 15, 20, 25 and 30, the latest that has arrived, six in all", () => {
    expect(SETUP_REMINDER_COUNT).toBe(6);
    expect(dueReminderNumber("2026-10-07", "2026-10-07")).toBeNull();
    expect(dueReminderNumber("2026-10-07", "2026-10-11")).toBeNull();
    expect(dueReminderNumber("2026-10-07", "2026-10-12")).toBe(1);
    expect(dueReminderNumber("2026-10-07", "2026-10-16")).toBe(1);
    expect(dueReminderNumber("2026-10-07", "2026-10-17")).toBe(2);
    // Across the clocks going back on 1 November: calendar days, not hours.
    expect(dueReminderNumber("2026-10-07", "2026-11-06")).toBe(6);
    expect(dueReminderNumber("2026-10-07", "2026-12-01")).toBe(6);
  });

  test("queued only in the clinic's daytime, 07:00 to 20:00 where it is", () => {
    expect(isDaytime(new Date("2026-10-07T13:00:00Z"), "America/New_York")).toBe(true);
    expect(isDaytime(new Date("2026-10-07T10:59:00Z"), "America/New_York")).toBe(false);
    expect(isDaytime(new Date("2026-10-07T11:00:00Z"), "America/New_York")).toBe(true);
    expect(isDaytime(new Date("2026-10-08T00:00:00Z"), "America/New_York")).toBe(false);
    expect(isDaytime(new Date("2026-10-08T00:00:00Z"), "America/Los_Angeles")).toBe(true);
  });
});

describe("knowledge", () => {
  test("services keep their price kind, and a per-unit price is a price, not dosing", () => {
    const [service] = validateServices(
      [
        {
          name: "Laser session",
          priceKind: "per_unit",
          price: 14.5,
          maxPrice: null,
          unit: "pulse",
          durationMinutes: 30,
        },
      ],
      "med-spa",
    );
    expect(service).toMatchObject({
      name: "Laser session",
      priceKind: "per_unit",
      priceFromUsd: 14.5,
      priceToUsd: null,
      unit: "pulse",
    });
    expect(serviceInputOf(service!)).toMatchObject({
      priceKind: "per_unit",
      price: 14.5,
      unit: "pulse",
    });
    const [range] = validateServices(
      [
        {
          name: "Facial",
          priceKind: "range",
          price: "150",
          maxPrice: "$250",
          unit: null,
          durationMinutes: 60,
        },
      ],
      "med-spa",
    );
    expect(range).toMatchObject({ priceFromUsd: 150, priceToUsd: 250, priceKind: "range" });
  });

  test("refuses clinical words in a name, naming the phrase, and a broken range", () => {
    const refuse = (rows: unknown[], specialty = "med-spa") => {
      try {
        validateServices(rows, specialty);
      } catch (error) {
        return error as KnowledgeError;
      }
      return null;
    };
    const clinical = refuse([{ name: "Safe peel for pregnancy", priceKind: null }]);
    expect(clinical?.message).toMatch(/safety claim|pregnancy/);
    expect(clinical?.field).toBe("services[0]");
    expect(
      refuse([{ name: "Peel", priceKind: "range", price: 200, maxPrice: 100 }])?.message,
    ).toMatch(/top of the range/);
    expect(refuse([{ name: "Peel", priceKind: "exact", price: null }])?.message).toMatch(
      /needs a price/,
    );
    expect(
      refuse([
        { name: "Peel", priceKind: null },
        { name: "peel", priceKind: null },
      ])?.message,
    ).toMatch(/twice/);
    // A vet's menu is medical words; only the claims apply to its names.
    expect(
      refuse([{ name: "Senior diagnostics", priceKind: "exact", price: 120 }], "veterinary"),
    ).toBeNull();
  });

  test("a deposit stays inside BD27's $0 to $10,000, the range the ops console's save holds it to", () => {
    const row = {
      name: "Bridal glow package",
      priceKind: "exact",
      price: 15_000,
      maxPrice: null,
      unit: null,
      durationMinutes: 90,
    };
    expect(() => validateServices([{ ...row, depositUsd: 10_000.01 }], "med-spa")).toThrow(
      /a deposit can be up to \$10,000/,
    );
    const [kept] = validateServices([{ ...row, depositUsd: 10_000 }], "med-spa");
    expect(kept).toMatchObject({ priceFromUsd: 15_000, depositUsd: 10_000 });
    // What Knowledge stores, the console's own check accepts when it is sent back.
    expect(() =>
      validateAgentConfig({
        greeting: "Hi",
        services: [kept!],
        escalationPhone: null,
        escalationHours: null,
        notes: null,
      }),
    ).not.toThrow();
  });

  test("a website service is stored with its kind", () => {
    expect(
      serviceFromProfile({
        name: "Facial",
        priceKind: "from",
        priceUsd: 99,
        maxUsd: null,
        unit: null,
        durationMinutes: 45,
      }),
    ).toEqual({
      name: "Facial",
      priceKind: "from",
      priceFromUsd: 99,
      priceToUsd: null,
      unit: null,
      durationMinutes: 45,
    });
  });

  test("the most-asked question is screened like everything else", () => {
    expect(
      validateAnswer(
        { question: "Where do I park?", answer: "Free parking behind the building." },
        "q",
      ),
    ).toEqual({
      question: "Where do I park?",
      answer: "Free parking behind the building.",
    });
    expect(() => validateAnswer({ question: "Is it safe?", answer: "Yes." }, "q")).toThrow(
      KnowledgeError,
    );
    expect(() => validateAnswer({ question: "Hours?", answer: "" }, "q")).toThrow(
      /Write the answer/,
    );
  });

  test("never-say starts with the clinical defaults, then the clinic's own, without repeats", () => {
    expect(neverSayWithDefaults()).toEqual([...NEVER_SAY_DEFAULTS]);
    const list = neverSayWithDefaults(["Painless", "cheapest in town"]);
    expect(list.slice(0, NEVER_SAY_DEFAULTS.length)).toEqual([...NEVER_SAY_DEFAULTS]);
    expect(list.at(-1)).toBe("cheapest in town");
    expect(list.filter((p) => p.toLowerCase() === "painless")).toHaveLength(1);
  });
});

describe("numbers", () => {
  test("a US number as people type it, or international form", () => {
    expect(usNumber("(415) 555-0100")).toBe("+14155550100");
    expect(usNumber("1 415 555 0100")).toBe("+14155550100");
    expect(usNumber("555-0100")).toBeNull();
    expect(toE164("+44 20 7946 0958")).toBe("+442079460958");
    expect(toE164("call me")).toBeNull();
    expect(formatPhone("+18886889404")).toBe("(888) 688-9404");
    expect(formatPhone("+442079460958")).toBe("+442079460958");
  });
});

describe("Help", () => {
  test("hides the voicemail line and the call while they are unset or malformed", () => {
    delete process.env.HEALDESK_SUPPORT_PHONE;
    delete process.env.HEALDESK_CALL_BOOKING_URL;
    expect(helpContacts()).toEqual({
      email: "hello@healdesk.io",
      phoneE164: null,
      callBookingUrl: null,
    });
    expect(emailCallUrl()).toBeNull();
    process.env.HEALDESK_SUPPORT_PHONE = "888 688 9404";
    process.env.HEALDESK_CALL_BOOKING_URL = "http://calendly.example/call";
    expect(helpContacts()).toMatchObject({ phoneE164: null, callBookingUrl: null });
  });

  test("shows them once set, and emails link the call through this app's own origin", () => {
    process.env.HEALDESK_SUPPORT_PHONE = "+18885550100";
    process.env.HEALDESK_CALL_BOOKING_URL = "https://calendly.example/team/call";
    process.env.BETTER_AUTH_URL = "https://app.healdesk.test";
    expect(helpContacts()).toEqual({
      email: "hello@healdesk.io",
      phoneE164: "+18885550100",
      callBookingUrl: "https://calendly.example/team/call",
    });
    expect(emailCallUrl()).toBe("https://app.healdesk.test/help/call");
  });
});

describe("Auto-confirm's Right now line", () => {
  const live = { bookingSystem: "google_calendar" as const, autoConfirm: true };

  test("every booking is a request today, whatever is connected; the line names a reason only the clinic set or can fix", () => {
    for (const calendar of ["requests_only", "not_connected", "connected"] as const) {
      expect(rightNowLine({ ...live, calendar })).toBe(
        "Right now: your team confirms each booking AYA takes.",
      );
    }
    expect(rightNowLine({ ...live, calendar: "broken" })).toBe(
      "Right now: your team confirms each booking AYA takes, because your calendar connection stopped working.",
    );
    expect(rightNowLine({ ...live, autoConfirm: false, calendar: "connected" })).toBe(
      "Right now: your team confirms each booking AYA takes, because Auto-confirm is off.",
    );
    expect(
      rightNowLine({ bookingSystem: "mindbody", autoConfirm: false, calendar: "connected" }),
    ).toBe("Right now: your team confirms each booking AYA takes in Mindbody.");
    expect(
      rightNowLine({ bookingSystem: "other", autoConfirm: false, calendar: "connected" }),
    ).toBe("Right now: your team confirms each booking AYA takes in your booking system.");
  });

  test("the picker's answer on screen decides Auto-confirm as saving it would", () => {
    const lines = bookingLines(
      { bookingSystem: "google_calendar", autoConfirmBookings: false },
      "not_connected",
    );
    // The saved system keeps the clinic's own switch; another follows its sync.
    expect(lines.google_calendar!.autoConfirm).toBe(false);
    expect(lines.calendly!.autoConfirm).toBe(true);
    expect(lines.mindbody).toEqual({
      autoConfirm: false,
      rightNow: "Right now: your team confirms each booking AYA takes in Mindbody.",
    });
    expect(lines[""]).toEqual(lines.google_calendar);
  });
});

/** A clinic's setup state with nothing answered, for the rules that read it. */
function setupState(overrides: Partial<SetupState> = {}): SetupState {
  return {
    clinic: {
      id: "c",
      slug: "glow",
      name: "Glow",
      specialty: "med-spa",
      timezone: "America/New_York",
      timezoneConfirmed: false,
      address: null,
      website: "glowmedspa.com",
      publishedPhoneE164: null,
      openingHours: null,
      siteProfile: null,
      regulatoryRegime: "hipaa-if-covered",
      agreementKind: "baa",
      isCoveredEntity: false,
      onboarding: {},
      offboardingStartedAt: null,
      createdAt: at,
    },
    channels: [],
    settings: {} as SetupState["settings"],
    knowledge: {
      services: [],
      policies: [],
      quickAnswers: [],
      mostAsked: null,
      neverSay: [],
      promotions: null,
    },
    closures: [],
    progress: new Map(),
    screens: [],
    billing: {
      boughtPlanId: "web-voice",
      interval: "month",
      status: "active",
      firstPaidAt: at,
      setupDeadlineAt: null,
      planStartedAt: null,
    },
    address: "owner@glow.test",
    hasPasskey: true,
    hasBackup: false,
    ...overrides,
  };
}

const NOT_CONNECTED: CalendarConnectionView = { status: "not_connected", accessRemovedAt: null };

function connection(
  status: "active" | "degraded" | "error" | "pending",
): Exclude<CalendarConnectionView, { status: "not_connected" }> {
  return {
    status,
    account: { email: "bookings@glow.test", kind: "workspace", domain: "glow.test" },
    calendar: { id: "primary", primary: true },
    connectedAt: at.toISOString(),
    lastVerifiedAt: at,
    brokenAt: status === "error" ? at : null,
    lastError: status === "error" ? "calendar_not_found" : null,
    disclosureCurrent: true,
  };
}

describe("the build tracker", () => {
  test("each stage's done-rule reads the data, and the preview stays locked while the engine is not built", () => {
    const fresh = buildTracker(setupState(), NOT_CONNECTED);
    expect(fresh.stages.map((s) => [s.id, s.state])).toEqual([
      ["agreement", "done"],
      ["payment", "done"],
      ["website", "not_done"],
      ["answers", "not_done"],
      ["calendar", "info"],
      ["built", "not_done"],
      ["practice_questions", "not_done"],
    ]);
    expect(fresh.previewUnlocked).toBe(false);
    expect(fresh.left).toEqual([
      "Your website read",
      "Your answers set up",
      "Assistant built",
      "Practice questions passed",
    ]);
    expect(fresh.stages[2]!.detail).toBe(
      "We couldn't read your website, so setup asks three questions instead.",
    );

    const answered = setupState({
      clinic: {
        ...setupState().clinic,
        openingHours: {
          sun: [],
          mon: [["09:00", "17:00"]],
          tue: [],
          wed: [],
          thu: [],
          fri: [],
          sat: [],
        },
        onboarding: { hours_confirmed: at.toISOString() },
      },
      knowledge: {
        services: [{ name: "Facial", priceFromUsd: 120, priceToUsd: 120, durationMinutes: 60 }],
        policies: [],
        quickAnswers: [],
        mostAsked: { question: "Parking?", answer: "Behind the building." },
        neverSay: [],
        promotions: null,
      },
      progress: new Map([["services", { outcome: "done", at }]]),
    });
    expect(answersMissing(answered)).toEqual([]);
    const tracker = buildTracker(answered, NOT_CONNECTED);
    expect(tracker.stages.find((s) => s.id === "website")!.state).toBe("done");
    expect(tracker.stages.find((s) => s.id === "answers")!.state).toBe("done");
    expect(tracker.left).toEqual(["Assistant built", "Practice questions passed"]);
  });

  test("names what is missing in words", () => {
    expect(answersMissing(setupState())).toEqual([
      "a service with its price",
      "your hours",
      "your most-asked question",
    ]);
    expect(joinWords(["a", "b", "c"])).toBe("a, b and c");
    expect(joinWords(["a"])).toBe("a");
  });

  test("the calendar stage follows the connection, and never blocks the preview", () => {
    const stage = (view: CalendarConnectionView) =>
      buildTracker(setupState(), view).stages.find((s) => s.id === "calendar")!;
    expect(stage(NOT_CONNECTED)).toEqual({
      id: "calendar",
      label: "Calendar",
      state: "info",
      detail: "Bookings arrive as requests your team confirms.",
      blocks: false,
    });
    for (const healthy of ["active", "degraded"] as const) {
      expect(stage(connection(healthy))).toEqual({
        id: "calendar",
        label: "Calendar connected",
        state: "done",
        detail: "Connected as bookings@glow.test.",
        blocks: false,
      });
    }
    expect(stage(connection("error"))).toMatchObject({
      state: "info",
      detail:
        "Your calendar connection stopped working, so bookings arrive as requests your team confirms until you reconnect it.",
      blocks: false,
    });
    expect(stage(connection("pending")).state).toBe("info");
    expect(
      stage({ ...connection("active"), account: { email: null, kind: null, domain: null } }).detail,
    ).toBe("Your Google Calendar is connected.");
    // Connected or not, what is left is the same.
    expect(buildTracker(setupState(), connection("active")).left).toEqual(
      buildTracker(setupState(), NOT_CONNECTED).left,
    );
  });
});

describe("price kinds through a writer that does not know them", () => {
  const laser = {
    name: "Laser session",
    priceKind: "per_unit" as const,
    priceFromUsd: 14.5,
    priceToUsd: null,
    unit: "pulse",
    durationMinutes: 30,
    depositUsd: 50,
  };

  test("a start with no top reads as a from price, never an exact one", () => {
    expect(inferPriceKind(null, null)).toBeNull();
    expect(inferPriceKind(150, null)).toBe("from");
    expect(inferPriceKind(199, 199)).toBe("exact");
    expect(inferPriceKind(150, 300)).toBe("range");
    expect(priceKindFits("per_unit", 14.5, null)).toBe(true);
    expect(priceKindFits("per_unit", 14.5, 20)).toBe(false);
    expect(priceKindFits("exact", 150, 199)).toBe(false);
    // What the ops console used to leave of "$14.50 per pulse": the wizard
    // read it as an exact $15 and would have saved that.
    expect(
      serviceInputOf({
        name: "Laser session",
        priceFromUsd: 15,
        priceToUsd: null,
        durationMinutes: 30,
      }),
    ).toMatchObject({ priceKind: "from", price: 15, maxPrice: null });
    expect(priceKindOf({ ...laser, unit: null })).toBe("from");
  });

  test("keeps the stored kind, unit and deposit for a service sent without them", () => {
    const sent = {
      name: "Laser session",
      priceFromUsd: 14.5,
      priceToUsd: null,
      durationMinutes: 30,
    };
    expect(carryServiceDetails([laser], [sent])).toEqual([laser]);
    // Matched ignoring case and spacing; a key that was sent is the answer.
    expect(
      carryServiceDetails([laser], [{ ...sent, name: " laser  SESSION", depositUsd: null }]),
    ).toEqual([
      {
        name: " laser  SESSION",
        priceKind: "per_unit",
        priceFromUsd: 14.5,
        priceToUsd: null,
        unit: "pulse",
        durationMinutes: 30,
      },
    ]);
  });

  test("re-reads the kind from the prices once they no longer fit it", () => {
    const ranged = carryServiceDetails(
      [laser],
      [{ name: "Laser session", priceFromUsd: 14.5, priceToUsd: 20, durationMinutes: 30 }],
    );
    expect(ranged[0]).toMatchObject({ priceKind: "range", unit: null, depositUsd: 50 });
    const unpriced = carryServiceDetails(
      [laser],
      [{ name: "Laser session", priceFromUsd: null, priceToUsd: null, durationMinutes: 30 }],
    );
    expect(unpriced[0]).toMatchObject({ priceKind: null, unit: null });
    // A service with nothing stored takes the kind its prices say.
    expect(
      carryServiceDetails(
        [],
        [{ name: "Peel", priceFromUsd: 150, priceToUsd: 150, durationMinutes: 45 }],
      )[0],
    ).toMatchObject({ priceKind: "exact", unit: null });
  });
});

describe("which calls reach AYA, both ways round", () => {
  test("call_routing and coverage_mode always mean the same thing", () => {
    expect(routingForCoverageMode("all_calls")).toBe("always");
    expect(routingForCoverageMode("overflow_after_hours")).toBe("conditional");
    expect(routingForCoverageMode("after_hours_only")).toBe("conditional");
    expect(coverageModeForRouting("always", "after_hours_only")).toBe("all_calls");
    expect(coverageModeForRouting("conditional", "all_calls")).toBe("overflow_after_hours");
    expect(coverageModeForRouting("conditional", "after_hours_only")).toBe("after_hours_only");
    expect(coverageModeForRouting("conditional", null)).toBe("overflow_after_hours");
  });
});

describe("the setup window on the clinic's calendar", () => {
  // 22:00 in Los Angeles on 7 October is 01:00 on the 8th in New York.
  const lateEvening = new Date("2026-10-08T05:00:00Z");
  // 22:00 in New York on 7 October.
  const evening = new Date("2026-10-08T02:00:00Z");

  test("the last day is the day the deadline ends, and the window counts back from it", () => {
    const deadline = setupDeadline(evening, "America/Los_Angeles");
    expect(deadline.toISOString()).toBe("2026-11-07T07:59:59.999Z");
    expect(setupLastDay(deadline, "America/Los_Angeles")).toBe("2026-11-06");
    expect(setupWindowStart(deadline, "America/Los_Angeles")).toBe("2026-10-07");
    // A deadline that is not the end of a day where the clinic is names the
    // last day it outlives, never the day it closes during.
    expect(setupLastDay(deadline, "America/New_York")).toBe("2026-11-06");
  });

  test("a corrected zone keeps the named day and moves the instant to its end there", () => {
    const deadline = setupDeadline(evening, "America/Los_Angeles");
    const moved = moveSetupDeadline(deadline, "America/Los_Angeles", "America/New_York");
    expect(moved.toISOString()).toBe("2026-11-07T04:59:59.999Z");
    expect(setupLastDay(moved, "America/New_York")).toBe("2026-11-06");
    // The other way round: the account no longer closes three hours before
    // the end of the day the emails name.
    const eastern = setupDeadline(evening, "America/New_York");
    expect(eastern.toISOString()).toBe("2026-11-07T04:59:59.999Z");
    const western = moveSetupDeadline(eastern, "America/New_York", "America/Los_Angeles");
    expect(western.toISOString()).toBe("2026-11-07T07:59:59.999Z");
  });

  test("the sixth reminder falls on the last day after a correction across midnight", () => {
    const deadline = moveSetupDeadline(
      setupDeadline(lateEvening, "America/Los_Angeles"),
      "America/Los_Angeles",
      "America/New_York",
    );
    const start = setupWindowStart(deadline, "America/New_York");
    expect(dueReminderNumber(start, "2026-11-06")).toBe(6);
    expect(dueReminderNumber(start, "2026-11-01")).toBe(5);
    // Counted forward from the purchase in New York (8 October), the 6 November
    // reminder was the fifth, and the sixth fell after the account had closed.
    expect(dueReminderNumber("2026-10-08", "2026-11-06")).toBe(5);
  });
});

describe("the urgent-help number", () => {
  const voice = [{ channel: "voice" }] as unknown as SetupState["channels"];
  const settings = (over: Partial<SetupState["settings"]>) =>
    ({ urgentHelpE164: null, directLineE164: "+15125550177", ...over }) as SetupState["settings"];

  test("the field holds only the clinic's own number; the default is named beside it", () => {
    const fresh = setupState({ channels: voice, settings: settings({}) });
    expect(urgentHelpField(fresh)).toEqual({
      value: "",
      placeholder: "(512) 555-0177",
      hint: "Leave it empty and AYA gives your direct line, (512) 555-0177, and follows it if that number changes. AYA never gives your main number, which forwards to her.",
    });
    const own = setupState({
      channels: voice,
      settings: settings({ urgentHelpE164: "+15125550188" }),
    });
    expect(urgentHelpField(own).value).toBe("(512) 555-0188");
  });

  test("the default is resolved when it is read, so it follows the direct line", () => {
    const before = setupState({ channels: voice, settings: settings({}) });
    expect(urgentHelpNumber(before)).toBe("+15125550177");
    const after = setupState({
      channels: voice,
      settings: settings({ directLineE164: "+15125550199" }),
    });
    expect(urgentHelpNumber(after)).toBe("+15125550199");
    // Without phone, the main number.
    const chat = setupState({
      settings: settings({}),
      clinic: { ...setupState().clinic, publishedPhoneE164: "+15125550142" },
    });
    expect(urgentHelpNumber(chat)).toBe("+15125550142");
  });
});

describe("what skipping step 1 costs, from what is stored", () => {
  const read = { website: "glowmedspa.com" } as unknown as SetupState["clinic"]["siteProfile"];
  const prefilled = setupState({
    clinic: {
      ...setupState().clinic,
      siteProfile: read,
      address: "1200 Congress Ave, Austin, TX 78701",
      publishedPhoneE164: "+15125550142",
    },
    knowledge: {
      ...setupState().knowledge,
      services: [
        { name: "Laser session", priceFromUsd: 14.5, priceToUsd: null, durationMinutes: 30 },
      ],
    },
  });

  test("a screen the website read filled says it keeps what was read, unchecked", () => {
    expect(skipCost(prefilled, "basics")).toBe(
      "AYA gives callers the address and number we read from your website, unchecked.",
    );
    expect(skipCost(prefilled, "services")).toBe(
      "the prices we read from your website stay unchecked, and AYA isn't built until you check them.",
    );
    // An empty practice: the old lines, which are true of it.
    expect(skipCost(setupState(), "basics")).toBe(
      "AYA can't tell callers your address or the number to reach you on.",
    );
    expect(skipCost(setupState(), "services")).toBe(
      "AYA quotes no prices; she offers to book a consultation instead.",
    );
  });

  test("read prices count as set up only once the services screen is saved", () => {
    expect(answersMissing(prefilled)).toContain("a check of your prices");
    const skipped = { ...prefilled, progress: new Map([["services", { outcome: "skipped", at }]]) };
    expect(answersMissing(skipped as SetupState)).toContain("a check of your prices");
    const saved = { ...prefilled, progress: new Map([["services", { outcome: "done", at }]]) };
    expect(answersMissing(saved as SetupState)).not.toContain("a check of your prices");
    expect(skipCost(saved as SetupState, "services")).toBe("AYA keeps the prices you saved.");
  });
});
