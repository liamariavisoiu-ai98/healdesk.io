import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { assistantFacts, type AssistantFacts } from "@/lib/assistant/facts";
import { buildAssistantPrompt } from "@/lib/assistant/prompt";
import { answerTurn, openNow } from "@/lib/assistant/turn";
import { clinicLocalDate, openGiven } from "@/lib/clinic/closures";
import { frontDoorFacts, urgentLine, type FrontDoorFacts } from "@/lib/meta/front-door";
import { withTenant } from "@/lib/tenant";

import {
  closePools,
  getMigratorPool,
  hasTestDatabase,
  runMigrations,
  truncateAll,
} from "./setup/db";
import { inTenant, seedClinic } from "./setup/factories";

/**
 * What AYA says about a day the clinic has closed (ops automation D9). The
 * booking engine already offered nothing on a closed day; what the
 * assistant said did not know about it: the model saw only the weekly
 * hours, so it could tell a person the clinic was open on its holiday, and
 * the urgent reply's "is the practice open now" read the weekly hours alone,
 * so a veterinary practice closed for the day still offered its own number
 * beside the emergency vet. Each now reads the same closed days, and the
 * same rule, the answer gate and the engine use.
 */

const WEEKDAYS = [["09:00", "17:00"]] as [string, string][];
const HOURS = {
  sun: [],
  mon: WEEKDAYS,
  tue: WEEKDAYS,
  wed: WEEKDAYS,
  thu: WEEKDAYS,
  fri: WEEKDAYS,
  sat: [],
};
/** Tuesday 13 October 2026, 11:00 in New York: open by the weekly hours. */
const TUESDAY_11 = new Date("2026-10-13T15:00:00Z");
/** Wednesday 14 October 2026, 11:00 in New York. */
const WEDNESDAY_11 = new Date("2026-10-14T15:00:00Z");
const CLOSED_TUESDAY = [{ closedOn: "2026-10-13", label: "Staff training" }];

const VET: AssistantFacts = {
  clinicId: "c0ffee00-0000-4000-8000-000000000009",
  clinicName: "Paws Animal Clinic",
  specialty: "veterinary",
  timeZone: "America/New_York",
  phone: "+14155550199",
  urgentPhone: "+14155550123",
  vetReferralPhone: "+14155550911",
  directLine: "+14155550123",
  address: "1 Main St",
  hours: ["Tuesday: 09:00-17:00"],
  openingHours: HOURS,
  services: [],
  policies: [],
  quickAnswers: [],
  promotions: null,
  notes: null,
  escalationHours: null,
  neverSay: [],
  requirements: [],
  greeting: { phone: "Thanks for calling.", chat: "How can I help you today?" },
  tone: "warm",
  languages: ["en"],
  suggestAddOns: false,
  providerNames: [],
};
const PEOPLE: AssistantFacts = {
  ...VET,
  clinicName: "Radiance Med Spa",
  specialty: "med-spa",
  vetReferralPhone: null,
};

describe("the open check", () => {
  test("a closed day is closed whatever the weekly hours say; the next day is unchanged", () => {
    const closed = ["2026-10-13"];
    expect(openGiven(HOURS, closed, TUESDAY_11, "America/New_York")).toBe(false);
    expect(openGiven(HOURS, closed, WEDNESDAY_11, "America/New_York")).toBe(true);
    expect(openGiven(HOURS, [], TUESDAY_11, "America/New_York")).toBe(true);
    // Unknown hours stay unknown, except on a day the clinic said it is shut.
    expect(openGiven(null, [], TUESDAY_11, "America/New_York")).toBeNull();
    expect(openGiven(null, closed, TUESDAY_11, "America/New_York")).toBe(false);
  });

  test("the closed day is the clinic's own date, not UTC's", () => {
    // 23:30 on Monday 12 October in New York is already the 13th in UTC.
    const lateMonday = new Date("2026-10-13T03:30:00Z");
    const lateHours = { ...HOURS, mon: [["09:00", "23:59"]] as [string, string][] };
    expect(openGiven(lateHours, ["2026-10-13"], lateMonday, "America/New_York")).toBe(true);
    expect(openGiven(lateHours, ["2026-10-12"], lateMonday, "America/New_York")).toBe(false);
  });

  test("openNow reads the facts' closed days", () => {
    expect(openNow({ ...VET, closures: CLOSED_TUESDAY }, TUESDAY_11)).toBe(false);
    expect(openNow({ ...VET, closures: CLOSED_TUESDAY }, WEDNESDAY_11)).toBe(true);
    expect(openNow(VET, TUESDAY_11)).toBe(true);
  });
});

describe("the urgent reply on a closed day", () => {
  const ask = (facts: AssistantFacts, now: Date) =>
    answerTurn({
      facts,
      channel: "web_chat",
      history: [],
      text: "he's not breathing",
      responder: null,
      now,
    });

  test("a veterinary practice closed for the day gives the emergency vet, not its own number", async () => {
    const closed = await ask({ ...VET, closures: CLOSED_TUESDAY }, TUESDAY_11);
    expect(closed).toMatchObject({ source: "urgent", urgent: true });
    expect(closed.reply).toContain("(415) 555-0911");
    expect(closed.reply).not.toContain("(415) 555-0123");
    expect(closed.reply).toMatch(/AI/);
  });

  test("the day after, and the same day with no closure, are as before", async () => {
    for (const [facts, now] of [
      [{ ...VET, closures: CLOSED_TUESDAY }, WEDNESDAY_11],
      [VET, TUESDAY_11],
    ] as const) {
      const reply = await ask(facts, now);
      expect(reply.reply).toContain("(415) 555-0911");
      expect(reply.reply).toContain("Otherwise, please call Paws Animal Clinic on (415) 555-0123.");
    }
  });

  test("elsewhere the urgent-help number stays, because it reaches a person on any day", async () => {
    const closed = await ask({ ...PEOPLE, closures: CLOSED_TUESDAY }, TUESDAY_11);
    const open = await ask(PEOPLE, TUESDAY_11);
    expect(closed.reply).toBe(open.reply);
    expect(closed.reply).toContain("(415) 555-0123");
  });

  test("the Meta front door's urgent line reads the closed day too", () => {
    const meta: Parameters<typeof urgentLine>[0] = {
      clinicName: "Paws Animal Clinic",
      phone: "+14155550199",
      urgentPhone: "+14155550123",
      vetReferralPhone: "+14155550911",
      specialty: "veterinary",
      openingHours: HOURS,
      timeZone: "America/New_York",
    };
    const finding = { emergency: "veterinary" } as const;
    const closed = urgentLine({ ...meta, closedDates: ["2026-10-13"] }, finding, TUESDAY_11);
    expect(closed).toContain("+14155550911");
    expect(closed).not.toContain("+14155550123");
    expect(urgentLine(meta, finding, TUESDAY_11)).toContain("+14155550123");
    expect(urgentLine({ ...meta, closedDates: ["2026-10-13"] }, finding, WEDNESDAY_11)).toContain(
      "+14155550123",
    );
  });
});

describe("the closed days in the facts the model sees", () => {
  test("the prompt lists each closed day with its label; with none it says nothing new", () => {
    const prompt = buildAssistantPrompt(
      { ...PEOPLE, closures: [...CLOSED_TUESDAY, { closedOn: "2026-11-26", label: null }] },
      "voice",
    );
    expect(prompt).toContain("Closed all day on these dates, whatever the opening hours say:");
    expect(prompt).toContain("Tuesday, October 13, 2026 (Staff training)");
    expect(prompt).toContain("Thursday, November 26, 2026");
    const plain = buildAssistantPrompt(PEOPLE, "voice");
    expect(plain).not.toContain("Closed all day");
    expect(buildAssistantPrompt({ ...PEOPLE, closures: [] }, "voice")).toBe(plain);
  });
});

const describeDb = hasTestDatabase ? describe : describe.skip;
const ACTOR = { type: "service", serviceName: "closed-day-statements-test" } as const;

describeDb("assistantFacts and frontDoorFacts read the closed days", () => {
  beforeAll(async () => {
    await runMigrations();
    await truncateAll();
  }, 60_000);

  afterAll(async () => {
    await closePools();
  });

  test("from today on in the clinic's zone, earliest first, past ones left out", async () => {
    const { clinicId } = await seedClinic("closed-day-facts");
    await getMigratorPool().query(
      `update clinics set timezone = 'America/New_York', opening_hours = $2::jsonb where id = $1`,
      [clinicId, JSON.stringify(HOURS)],
    );
    const now = new Date();
    const day = (offset: number) =>
      clinicLocalDate(new Date(now.getTime() + offset * 86_400_000), "America/New_York");
    await inTenant(clinicId, (c) =>
      c.query(
        `insert into clinic_closures (clinic_id, closed_on, label)
         values ($1, $2, 'Thanksgiving'), ($1, $3, null), ($1, $4, 'Long ago')`,
        [clinicId, day(9), day(2), day(-5)],
      ),
    );
    const facts = await withTenant({ clinicId, actor: ACTOR }, (tx) => assistantFacts(tx, { now }));
    expect(facts?.closures).toEqual([
      { closedOn: day(2), label: null },
      { closedOn: day(9), label: "Thanksgiving" },
    ]);
    expect(buildAssistantPrompt(facts!, "web_chat")).toContain("(Thanksgiving)");
    const front: FrontDoorFacts | null = await withTenant({ clinicId, actor: ACTOR }, (tx) =>
      frontDoorFacts(tx, { ignoreSwitch: true, now }),
    );
    expect(front?.closedDates).toEqual([day(2), day(9)]);
  });
});
