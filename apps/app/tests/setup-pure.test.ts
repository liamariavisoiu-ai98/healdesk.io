import { CHANNEL_NAMES, CHANNELS, NEVER_SAY_DEFAULTS } from "@healdesk/catalog";
import { afterEach, describe, expect, test } from "vitest";

import type { ChannelState } from "@/lib/channels/state";
import { copyProblems } from "@/lib/email/lint";
import { calendarStep, providersAvailable, rightNowLine } from "@/lib/setup/calendar";
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
import { toE164, usNumber } from "@/lib/setup/settings";
import type { SetupState } from "@/lib/setup/state";
import { answersMissing, buildTracker, joinWords } from "@/lib/setup/tracker";

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

describe("the calendar seam", () => {
  test("without the calendar backend, bookings arrive as requests and named providers wait", async () => {
    const step = await calendarStep("0c1d2e3f-0000-4000-8000-000000000000");
    expect(step).toEqual({ kind: "requests_only" });
    expect(providersAvailable(step)).toBe(false);
    expect(rightNowLine(step)).toBe("Right now: your team confirms each booking AYA takes.");
  });
});

describe("the build tracker", () => {
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

  test("each stage's done-rule reads the data, and the preview stays locked while the engine is not built", () => {
    const fresh = buildTracker(setupState());
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
    });
    expect(answersMissing(answered)).toEqual([]);
    const tracker = buildTracker(answered);
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

  test("the calendar never blocks the preview", () => {
    const calendar = buildTracker(setupState()).stages.find((s) => s.id === "calendar")!;
    expect(calendar.blocks).toBe(false);
    expect(calendar.detail).toBe("Bookings arrive as requests your team confirms.");
  });
});
