import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { startOfLocalDay } from "@/lib/clinic/setup-window";
import {
  assertPayloadAllowed,
  copyProblems,
  linkProblems,
  PayloadNotAllowedError,
  subjectProblems,
  visibleText,
} from "@/lib/email/lint";
import { deliverNotice } from "@/lib/email/outbox";
import { clinicReason } from "@/lib/email/templates/context";
import {
  claimsFixture,
  DAILY_SUMMARY_ENTRY,
  renderDailySummary,
  type DailySummaryPayload,
} from "@/lib/email/templates/daily_summary";
import type { TemplateContext } from "@/lib/email/templates/types";
import { renderWeeklyRecap, WEEKLY_RECAP_ENTRY } from "@/lib/email/templates/weekly_recap";
import { unsubscribeUrl } from "@/lib/email/unsubscribe";
import { bookingRequestPath } from "@/lib/portal/booking-paths";
import { publicUrl } from "@/lib/public-url";
import type { ClaimsPayload } from "@/lib/reporting/claim-words";
import { addRecipient } from "@/lib/reporting/recipients";
import { queueDailySummaryFor } from "@/lib/scheduler/daily-summary";
import {
  addLocalDays,
  isoWeekOf,
  lastWeek,
  localClock,
  mondayOf,
  openedAt,
  workingDayOpened,
} from "@/lib/scheduler/summary-clock";
import { queueWeeklyRecapFor } from "@/lib/scheduler/weekly-recap";
import { withTenant } from "@/lib/tenant";

import {
  closePools,
  getMigratorPool,
  hasTestDatabase,
  runMigrations,
  truncateAll,
} from "./setup/db";
import { deskDecideById } from "./setup/desk";
import { inTenant, setWeekdayHours } from "./setup/factories";
import { provisionPortalClinic } from "./setup/portal-clinic";
import {
  backdate,
  capture,
  conversation,
  DAY,
  HOUR,
  liveClinic,
  midweek,
  MINUTE,
  nextLocal,
  notices,
  request,
  setServices,
  websiteMessage,
  WEEKDAY,
  ZONE,
} from "./setup/summary-fixtures";

/**
 * Package WP4's emails: L13, the daily summary (lib/scheduler/daily-summary.ts),
 * at each live clinic's opening time on its working days behind the Daily
 * summary switch, with every booking and request as a pointer and, on the
 * week's first, last week's recap; and L14, the weekly recap, moved off
 * report_recipients and getTransport onto the outbox, going alone on
 * Mondays only while no summary can carry it (lib/scheduler/weekly-recap.ts).
 * Both count through the claims function (tests/claims.test.ts).
 *
 * Every one is a pointer (Annex X1.1): no name, number, time or service, in
 * the payload or the email.
 */

const describeDb = hasTestDatabase ? describe : describe.skip;
const ACTOR = { type: "service", serviceName: "summary-test" } as const;

function payload(overrides: Partial<ClaimsPayload> = {}): ClaimsPayload {
  return claimsFixture(overrides);
}

// -----------------------------------------------------------------------------
// The clinic's clock
// -----------------------------------------------------------------------------

describe("the clinic's clock", () => {
  test("a working day has opened from its first opening time until the evening, on its own clock", () => {
    // Thursday 15 October 2026: 08:59, 09:00, 19:59 and 20:00 in New York (EDT).
    expect(workingDayOpened(WEEKDAY, new Date("2026-10-15T12:59:00Z"), ZONE)).toBe(false);
    expect(workingDayOpened(WEEKDAY, new Date("2026-10-15T13:00:00Z"), ZONE)).toBe(true);
    expect(workingDayOpened(WEEKDAY, new Date("2026-10-15T23:59:00Z"), ZONE)).toBe(true);
    expect(workingDayOpened(WEEKDAY, new Date("2026-10-16T00:00:00Z"), ZONE)).toBe(false);
    // 09:00 in New York is 06:00 in Los Angeles: not yet there.
    expect(workingDayOpened(WEEKDAY, new Date("2026-10-15T13:00:00Z"), "America/Los_Angeles")).toBe(
      false,
    );
    // Saturday has no hours: not a working day.
    expect(workingDayOpened(WEEKDAY, new Date("2026-10-17T15:00:00Z"), ZONE)).toBe(false);
  });

  test("weeks start on Monday, and last week runs Monday to Sunday on the clinic's calendar, across a clock change", () => {
    expect(mondayOf("2026-10-15")).toBe("2026-10-12");
    expect(mondayOf("2026-10-12")).toBe("2026-10-12");
    expect(mondayOf("2026-10-18")).toBe("2026-10-12");
    expect(isoWeekOf("2026-09-14")).toBe("2026-W38");
    expect(isoWeekOf("2026-01-01")).toBe("2026-W01");
    expect(addLocalDays("2026-10-31", 1)).toBe("2026-11-01");
    // The week holding the change back to EST on Sunday 1 November.
    const week = lastWeek("2026-11-02", ZONE);
    expect(week.startOn).toBe("2026-10-26");
    expect(week.endOn).toBe("2026-11-01");
    expect(week.from).toEqual(new Date("2026-10-26T04:00:00Z"));
    expect(week.to).toEqual(new Date("2026-11-02T05:00:00Z"));
    expect(localClock(new Date("2026-11-02T14:00:00Z"), ZONE)).toMatchObject({
      date: "2026-11-02",
      day: "mon",
      hour: 9,
    });
    // The day's first opening, as an instant: 09:00 EDT, then 09:00 EST.
    expect(openedAt(WEEKDAY, "2026-10-15", ZONE)).toEqual(new Date("2026-10-15T13:00:00Z"));
    expect(openedAt(WEEKDAY, "2026-11-02", ZONE)).toEqual(new Date("2026-11-02T14:00:00Z"));
  });
});

// -----------------------------------------------------------------------------
// The two emails' templates
// -----------------------------------------------------------------------------

describe("L13 and L14 templates", () => {
  const SAVED: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const key of ["BETTER_AUTH_URL", "BETTER_AUTH_SECRET", "HEALDESK_APP_URL"])
      SAVED[key] = process.env[key];
    process.env.BETTER_AUTH_URL = "https://app.healdesk.test";
    process.env.BETTER_AUTH_SECRET = "test-secret-not-used-outside-tests";
    delete process.env.HEALDESK_APP_URL;
  });
  afterEach(() => {
    for (const [key, value] of Object.entries(SAVED)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  function ctx(
    kind: "daily_summary" | "weekly_recap",
    audience: "patients" | "clients" = "patients",
  ): TemplateContext {
    return {
      clinicName: "Radiance Med Spa",
      audience,
      reason: clinicReason("Radiance Med Spa"),
      ...(kind === "daily_summary"
        ? {
            unsubscribeUrl: unsubscribeUrl("0c1d2e3f-0000-4000-8000-000000000000", "daily_summary"),
          }
        : {}),
      raisedAt: new Date("2026-10-16T13:00:00Z"),
      timeZone: ZONE,
    };
  }

  function variants(): [string, DailySummaryPayload][] {
    const base = DAILY_SUMMARY_ENTRY.fixture;
    return [
      ["a working day", base],
      ["the first", { ...base, isFirstSummary: true }],
      ["after a long gap", { ...base, isPeriodCapped: true, newRows: [], openRows: [] }],
      [
        "an unusually quiet day",
        {
          ...base,
          isQuietUnusual: true,
          dayClaims: payload({
            handledCount: 0,
            voiceCount: 0,
            webCount: 0,
            rangOutCount: 0,
            requestsTakenCount: 0,
            requestsConfirmedCount: 0,
            pricedBookingsCount: 0,
            bookedValueCents: 0,
            depositsCollectedCount: 0,
            urgentCount: 0,
            handoverCount: 0,
          }),
          newRows: [],
        },
      ],
      [
        "the week's first, with last week's recap",
        {
          ...base,
          weekClaims: payload({ handledCount: 61 }),
          weekStartOn: "2026-10-05",
          weekEndOn: "2026-10-11",
        },
      ],
      [
        "more rows than the cap",
        {
          ...base,
          moreNewCount: 12,
          moreOpenCount: 1,
          newRows: [
            ...base.newRows,
            { channel: "meta", status: "missed", linkUrl: base.newRows[0]!.linkUrl },
            { channel: "voice", status: "booked", linkUrl: base.newRows[0]!.linkUrl },
            { channel: "web", status: "declined", linkUrl: base.newRows[0]!.linkUrl },
          ],
        },
      ],
    ];
  }

  test("every daily summary: the allowlist, the copy lint, the link scanner, a short subject, the stop link", () => {
    for (const [name, p] of variants()) {
      expect(() => assertPayloadAllowed(p, "daily_summary"), name).not.toThrow();
      for (const audience of ["patients", "clients"] as const) {
        const r = renderDailySummary(p, ctx("daily_summary", audience));
        expect(
          copyProblems([r.subject, r.preheader, r.text, visibleText(r.html)].join("\n")),
          name,
        ).toEqual([]);
        expect(linkProblems(r, "daily_summary"), name).toEqual([]);
        expect(subjectProblems(r.subject), name).toEqual([]);
        expect(r.text, name).toContain("Stop these emails: https://app.healdesk.test/email/stop/");
      }
    }
  });

  test("the summary says what happened and where each row stands, with its link, and nothing of the person", () => {
    const r = renderDailySummary(DAILY_SUMMARY_ENTRY.fixture, ctx("daily_summary"));
    expect(r.subject).toBe("Your daily summary from AYA");
    expect(r.preheader).toBe("14 conversations handled · 3 waiting for you.");
    expect(r.text).toContain("Here's what AYA did at Radiance Med Spa since your last summary.");
    expect(r.text).toContain("Conversations handled: 14");
    expect(r.text).toContain("Phone: 9 calls · 6 would otherwise have rung out");
    expect(r.text).toContain(
      "Sent to you as they happened: 1 urgent report and 2 requests to speak with a person.",
    );
    expect(r.text).toContain(
      "- Phone call · Confirmed by your team: https://app.healdesk.test/c/radiance-med-spa/bookings?request=5d0c1a2b-3c4d-4e5f-8a6b-7c8d9e0f1a2b",
    );
    expect(r.text).toContain("- Website chat · Waiting for you: ");
    expect(r.text).toContain("Booking requests from before that are still waiting for your team:");
    expect(r.text).toContain(
      "- 1 person left a message on your website: https://app.healdesk.test/c/radiance-med-spa/bookings",
    );
    expect(r.html).toMatch(
      /<a href="https:\/\/app\.healdesk\.test\/c\/radiance-med-spa\/bookings\?request=5d0c1a2b-3c4d-4e5f-8a6b-7c8d9e0f1a2b"[^>]*>Open in healdesk<\/a>/,
    );
    expect(r.text).toContain("This email carries no patient details on purpose");
    expect(
      renderDailySummary(DAILY_SUMMARY_ENTRY.fixture, ctx("daily_summary", "clients")).text,
    ).toContain("This email carries no client details on purpose");
    // No flag exists on Conversations, so neither email mentions one; and the
    // old recap's "reply with anything that looked wrong" is gone.
    expect(r.text).not.toMatch(/flag|reply to this email with anything/i);
  });

  test("the week's first summary carries last week's recap, and its subject says so", () => {
    const [, recap] = variants()[4]!;
    const r = renderDailySummary(recap, ctx("daily_summary"));
    expect(r.subject).toBe("Your daily summary, and your week with AYA");
    expect(r.text).toContain("Your week with AYA, Monday 5 October to Sunday 11 October:");
    const quiet = renderDailySummary(variants()[3]![1], ctx("daily_summary"));
    expect(quiet.text).toContain("That's unusually quiet for Radiance Med Spa.");
    expect(quiet.text).toContain("No bookings or booking requests since your last summary.");
    expect(renderDailySummary(variants()[2]![1], ctx("daily_summary")).text).toContain(
      "Here's what AYA did at Radiance Med Spa in the last 7 days.",
    );
    expect(renderDailySummary(variants()[5]![1], ctx("daily_summary")).text).toContain(
      "And 12 more, in Bookings.",
    );
  });

  test("the payload allowlist refuses anything of the person, at the top and inside the claims or a row", () => {
    const base = DAILY_SUMMARY_ENTRY.fixture;
    expect(() => assertPayloadAllowed({ ...base, firstName: "Maria" }, "daily_summary")).toThrow(
      PayloadNotAllowedError,
    );
    expect(() =>
      assertPayloadAllowed(
        { ...base, dayClaims: { ...base.dayClaims, service: "Lip filler" } },
        "daily_summary",
      ),
    ).toThrow(PayloadNotAllowedError);
    expect(() =>
      assertPayloadAllowed(
        { ...base, newRows: [{ ...base.newRows[0]!, phone: "+14155550134" }] },
        "daily_summary",
      ),
    ).toThrow(PayloadNotAllowedError);
    expect(() =>
      assertPayloadAllowed(
        { ...base, newRows: [{ ...base.newRows[0]!, status: "Maria at 3pm" }] },
        "daily_summary",
      ),
    ).toThrow(PayloadNotAllowedError);
  });

  test("L14 alone: the week's claims, why it came alone, and the one change that folds it into a summary", () => {
    const p = WEEKLY_RECAP_ENTRY.fixture;
    expect(() => assertPayloadAllowed(p, "weekly_recap")).not.toThrow();
    for (const variant of [
      p,
      { ...p, isSummaryOff: false, settingsUrl: publicUrl("/c/radiance-med-spa/knowledge#hours") },
    ]) {
      const r = renderWeeklyRecap(variant, ctx("weekly_recap"));
      expect(
        copyProblems([r.subject, r.preheader, r.text, visibleText(r.html)].join("\n")),
      ).toEqual([]);
      expect(linkProblems(r, "weekly_recap")).toEqual([]);
      expect(r.subject).toBe("Your week with AYA");
      // A correction goes through Flag this answer (plan Annex X6), never a reply.
      expect(r.text).not.toMatch(/reply to this email with anything/i);
      expect(r.text).toContain("Something look wrong? Open the conversation and use Flag this answer.");
      // Part of the service: no stop link of its own.
      expect(r.text).not.toContain("Stop these emails");
    }
    const off = renderWeeklyRecap(p, ctx("weekly_recap"));
    expect(off.text).toContain("Your week with AYA, Monday 5 October to Sunday 11 October:");
    expect(off.text).toContain(
      "Booked value at your listed prices: $3,125 across 9 bookings · 2 bookings priced per unit, not added in",
    );
    expect(off.text).toContain("Your daily summary is off, so this comes on its own each Monday.");
  });
});

// -----------------------------------------------------------------------------
// Against the database
// -----------------------------------------------------------------------------

describeDb("the summaries, against the database", () => {
  beforeAll(async () => {
    await runMigrations();
  }, 60_000);

  beforeEach(async () => {
    await truncateAll();
  }, 120_000);

  afterAll(async () => {
    await closePools();
  });

  test("L13 goes at opening time on working days only, once a day, behind the Daily summary switch", async () => {
    const at = nextLocal(midweek, 10);
    const c = await liveClinic("summary-when", new Date(at.getTime() - 20 * DAY));
    const local = localClock(at, ZONE).date;
    const opening = new Date(startOfLocalDay(local, ZONE).getTime() + 9 * HOUR);
    expect(await queueDailySummaryFor(c.clinicId, new Date(opening.getTime() - MINUTE))).toBe(
      "not_open",
    );
    expect(await queueDailySummaryFor(c.clinicId, opening)).toBe("queued");
    expect(await queueDailySummaryFor(c.clinicId, at)).toBe("already_queued");
    expect((await notices(c.clinicId, "daily_summary")).map((n) => n.dedupe_key)).toEqual([
      `daily_summary:${local}`,
    ]);
    // The weekend is not a working day; nor is a closure.
    const saturday = nextLocal((d) => d === "sat", 10, at);
    expect(await queueDailySummaryFor(c.clinicId, saturday)).toBe("not_open");
    const nextDay = new Date(at.getTime() + DAY);
    await inTenant(c.clinicId, (client) =>
      client.query(
        `insert into clinic_closures (clinic_id, closed_on, label) values ($1, $2, 'Training day')`,
        [c.clinicId, localClock(nextDay, ZONE).date],
      ),
    );
    // The day after a midweek day is a working day too, closed for training.
    expect(await queueDailySummaryFor(c.clinicId, nextDay)).toBe("closed");

    // The switch off: nothing. The same switch L8 reads.
    await inTenant(c.clinicId, (client) =>
      client.query(`update clinic_settings set daily_summary = false where clinic_id = $1`, [
        c.clinicId,
      ]),
    );
    expect(await queueDailySummaryFor(c.clinicId, new Date(at.getTime() + 7 * DAY))).toBe(
      "summary_off",
    );
    await inTenant(c.clinicId, (client) =>
      client.query(`update clinic_settings set daily_summary = true where clinic_id = $1`, [
        c.clinicId,
      ]),
    );
    // No opening hours on file: no opening time to send at.
    await getMigratorPool().query(`update clinics set opening_hours = null where id = $1`, [
      c.clinicId,
    ]);
    expect(await queueDailySummaryFor(c.clinicId, new Date(at.getTime() + 7 * DAY))).toBe(
      "no_hours",
    );

    // Not live, or not production: nothing.
    const notLive = await provisionPortalClinic("summary-setup");
    await getMigratorPool().query(
      `update clinics set data_classification = 'production', baa_signed_at = now(), timezone = $2 where id = $1`,
      [notLive.clinicId, ZONE],
    );
    await setWeekdayHours(notLive.clinicId);
    expect(await queueDailySummaryFor(notLive.clinicId, at)).toBe("not_live");

    // Live since after today's opening: the first summary is tomorrow's, not
    // one now about the minutes since.
    const lateLive = await liveClinic("summary-late", new Date(opening.getTime() + 2 * HOUR));
    expect(
      await queueDailySummaryFor(lateLive.clinicId, new Date(opening.getTime() + 3 * HOUR)),
    ).toBe("not_live");
    expect(await queueDailySummaryFor(lateLive.clinicId, new Date(opening.getTime() + DAY))).toBe(
      "queued",
    );
    const [first] = await notices(lateLive.clinicId, "daily_summary");
    expect(first!.payload).toMatchObject({
      isFirstSummary: true,
      periodStartAt: new Date(opening.getTime() + 2 * HOUR).toISOString(),
    });
  });

  test("L13 lists every booking and request since the last summary and every one still open, as pointers, and carries last week's recap once", async () => {
    const at = nextLocal(midweek, 10);
    const c = await liveClinic("summary-what", new Date(at.getTime() - 20 * DAY));
    await setServices(c.clinicId);
    // Before the last summary: one still open, one confirmed then.
    const stillOpen = await request(c.clinicId, { name: "Maria Lopez", phone: "+14155550134" });
    const lastSummaryEnd = new Date(Date.now() - 3 * HOUR);
    await backdate(c.clinicId, stillOpen, `created_at = $2`, [
      new Date(lastSummaryEnd.getTime() - DAY),
    ]);
    // A summary yesterday, ending three hours ago.
    await inTenant(c.clinicId, (client) =>
      client.query(
        `insert into billing_notices (clinic_id, kind, dedupe_key, payload, sent_at, recipients_count, attempts)
         values ($1, 'daily_summary', $2, $3::jsonb, now(), 1, 1)`,
        [
          c.clinicId,
          `daily_summary:${addLocalDays(localClock(at, ZONE).date, -1)}`,
          JSON.stringify({ periodEndAt: lastSummaryEnd.toISOString(), weekClaims: null }),
        ],
      ),
    );
    // A message left on the website before then, still waiting.
    const oldMessage = await websiteMessage(c.clinicId, {
      name: "Zoe Hart",
      phone: "+14155550109",
    });
    await backdate(c.clinicId, oldMessage, `created_at = $2`, [
      new Date(lastSummaryEnd.getTime() - DAY),
    ]);
    // Since then: a phone request waiting, a website chat request confirmed,
    // and another message left on the website.
    const waiting = await request(c.clinicId, { name: "Ben Ortiz", phone: "+14155550177" });
    await websiteMessage(c.clinicId, { name: "Ida Moss", phone: "+14155550108" });
    const confirmed = await request(
      c.clinicId,
      { name: "Cleo Park", phone: "+14155550199" },
      "Consultation",
      "web_chat",
    );
    await deskDecideById(c.clinicId, confirmed, "confirmed", {
      decidedByLabel: "Jo",
      deskNote: null,
      confirmedFor: new Date(Date.now() + 2 * DAY),
    });
    await conversation(c.clinicId, {
      channel: "voice",
      at: new Date(Date.now() - HOUR),
      reason: "after_hours",
    });
    // Last week, for the recap.
    const week = lastWeek(localClock(at, ZONE).date, ZONE);
    await conversation(c.clinicId, {
      channel: "web_chat",
      at: new Date(week.from.getTime() + DAY),
    });

    expect(await queueDailySummaryFor(c.clinicId, at)).toBe("queued");
    const [, summary] = await notices(c.clinicId, "daily_summary");
    const p = summary!.payload as unknown as DailySummaryPayload;
    expect(p.periodStartAt).toBe(lastSummaryEnd.toISOString());
    expect(p.isFirstSummary).toBe(false);
    const link = (id: string) => publicUrl(bookingRequestPath(c.clinicSlug, id));
    expect(p.newRows).toEqual([
      { channel: "voice", status: "waiting", linkUrl: link(waiting) },
      { channel: "web", status: "confirmed", linkUrl: link(confirmed) },
    ]);
    expect(p.openRows).toEqual([{ channel: "voice", status: "waiting", linkUrl: link(stillOpen) }]);
    // The two website messages, the new one and the one still waiting, are
    // their own line: never rows, never requests AYA took.
    expect(p.websiteMessageCount).toBe(2);
    expect(p.dayClaims).toMatchObject({
      handledCount: 1,
      voiceCount: 1,
      rangOutCount: 1,
      requestsTakenCount: 2,
      requestsConfirmedCount: 1,
      bookedValueCents: 15_000,
    });
    // Yesterday's summary, midweek, was this week's first: no recap today.
    expect(mondayOf(addLocalDays(localClock(at, ZONE).date, -1))).toBe(
      mondayOf(localClock(at, ZONE).date),
    );
    expect(p.weekClaims).toBeNull();
    expect(() => assertPayloadAllowed(p, "daily_summary")).not.toThrow();
    expect(JSON.stringify(p)).not.toMatch(
      /Maria|Ben|Cleo|Zoe|Ida|Lopez|Hart|Moss|4155550|Consultation/,
    );

    // Delivered through the outbox to the clinic's one address, never to a
    // report recipient, with the stop link, and nothing of anyone.
    await withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) =>
      addRecipient(tx, { email: "frontdesk@other.test", addedBy: "test" }),
    );
    const transport = capture();
    expect(
      await deliverNotice(c.clinicId, summary!.id, {
        now: new Date(Date.now() + MINUTE),
        transport,
      }),
    ).toBe("sent");
    expect(transport.sent.map((s) => s.to)).toEqual([c.email.toLowerCase()]);
    const email = transport.sent[0]!.message;
    expect(email.subject).toMatch(/^Your daily summary/);
    expect(email.text).toContain(`- Phone call · Waiting for you: ${link(waiting)}`);
    expect(email.text).toContain(
      `- 2 people left a message on your website: ${publicUrl(`/c/${c.clinicSlug}/bookings`)}`,
    );
    expect(email.text).toContain("Stop these emails: ");
    expect(email.text).not.toMatch(
      /Maria|Ben|Cleo|Zoe|Ida|Lopez|Ortiz|Park|Hart|Moss|4155550|Consultation|Thursday afternoon|This afternoon/,
    );
  });

  test("the week's first summary carries last week's recap, and the next day's does not", async () => {
    const monday = nextLocal((d) => d === "mon", 10);
    const c = await liveClinic("summary-week", new Date(monday.getTime() - 30 * DAY));
    const week = lastWeek(localClock(monday, ZONE).date, ZONE);
    await conversation(c.clinicId, {
      channel: "voice",
      at: new Date(week.from.getTime() + 2 * DAY),
      reason: "rang_unanswered",
    });
    expect(await queueDailySummaryFor(c.clinicId, monday)).toBe("queued");
    const tuesday = new Date(monday.getTime() + DAY);
    expect(await queueDailySummaryFor(c.clinicId, tuesday)).toBe("queued");
    const [first, second] = await notices(c.clinicId, "daily_summary");
    expect(first!.payload.weekClaims).toMatchObject({
      handledCount: 1,
      voiceCount: 1,
      rangOutCount: 1,
    });
    expect([first!.payload.weekStartOn, first!.payload.weekEndOn]).toEqual([
      week.startOn,
      week.endOn,
    ]);
    expect(first!.payload.isFirstSummary).toBe(false);
    expect(first!.payload.isPeriodCapped).toBe(true);
    expect(second!.payload.weekClaims).toBeNull();
    // Tuesday's period starts where Monday's ended.
    expect(second!.payload.periodStartAt).toBe(monday.toISOString());
    // And with the summary carrying it, L14 does not go alone.
    expect(await queueWeeklyRecapFor(c.clinicId, monday)).toBe("in_summary");
    expect(await notices(c.clinicId, "weekly_recap")).toEqual([]);
    // Turned off after it was queued and before it went, the summary closes
    // unsent (lib/email/outbox.ts), and the recap then goes alone.
    await inTenant(c.clinicId, async (client) => {
      await client.query(
        `update billing_notices set sent_at = now(), recipients_count = 0,
                last_error = 'not sent: the daily_summary switch is off'
          where clinic_id = $1 and kind = 'daily_summary'`,
        [c.clinicId],
      );
      await client.query(`update clinic_settings set daily_summary = false where clinic_id = $1`, [
        c.clinicId,
      ]);
    });
    expect(await queueWeeklyRecapFor(c.clinicId, new Date(monday.getTime() + HOUR))).toBe("queued");
  });

  test("L14 goes alone on Monday only while no summary can carry it, once, to the clinic's address, and never for an empty week", async () => {
    const monday = nextLocal((d) => d === "mon", 9);
    const c = await liveClinic("recap-alone", new Date(monday.getTime() - 30 * DAY));
    const week = lastWeek(localClock(monday, ZONE).date, ZONE);
    // The summary on, with hours: it rides the summary.
    expect(await queueWeeklyRecapFor(c.clinicId, monday)).toBe("in_summary");
    await inTenant(c.clinicId, (client) =>
      client.query(`update clinic_settings set daily_summary = false where clinic_id = $1`, [
        c.clinicId,
      ]),
    );
    // An empty week sends nothing: an email saying zero is worse than silence.
    expect(await queueWeeklyRecapFor(c.clinicId, monday)).toBe("empty");
    await conversation(c.clinicId, {
      channel: "voice",
      at: new Date(week.from.getTime() + DAY),
      reason: "after_hours",
    });
    await conversation(c.clinicId, {
      channel: "web_chat",
      at: new Date(week.from.getTime() + 2 * DAY),
    });
    // Before 08:00 on Monday, and on Tuesday: not due.
    expect(await queueWeeklyRecapFor(c.clinicId, new Date(monday.getTime() - 2 * HOUR))).toBe(
      "not_due",
    );
    expect(await queueWeeklyRecapFor(c.clinicId, new Date(monday.getTime() + DAY))).toBe("not_due");
    expect(await queueWeeklyRecapFor(c.clinicId, monday)).toBe("queued");
    expect(await queueWeeklyRecapFor(c.clinicId, new Date(monday.getTime() + HOUR))).toBe(
      "already_queued",
    );
    const [recap] = await notices(c.clinicId, "weekly_recap");
    expect(recap!.dedupe_key).toBe(`weekly_recap:${isoWeekOf(week.startOn)}`);
    expect(recap!.payload).toMatchObject({
      weekStartOn: week.startOn,
      weekEndOn: week.endOn,
      isSummaryOff: true,
      weekClaims: { handledCount: 2, voiceCount: 1, webCount: 1, rangOutCount: 1 },
      settingsUrl: publicUrl(`/c/${c.clinicSlug}/settings#alerts`),
    });

    // Retargeted: the clinic's one address through the outbox, not the old
    // report recipients list.
    await withTenant({ clinicId: c.clinicId, actor: ACTOR }, (tx) =>
      addRecipient(tx, { email: "frontdesk@other.test", addedBy: "test" }),
    );
    const transport = capture();
    expect(
      await deliverNotice(c.clinicId, recap!.id, {
        now: new Date(Math.max(Date.now(), monday.getTime()) + MINUTE),
        transport,
      }),
    ).toBe("sent");
    expect(transport.sent.map((s) => s.to)).toEqual([c.email.toLowerCase()]);
    expect(transport.sent[0]!.message.subject).toBe("Your week with AYA");
    expect(transport.sent[0]!.message.text).toContain("Conversations handled: 2");

    // With the summary on but no hours on file, it still goes alone, saying why.
    const noHours = await liveClinic("recap-no-hours", new Date(monday.getTime() - 30 * DAY));
    await getMigratorPool().query(`update clinics set opening_hours = null where id = $1`, [
      noHours.clinicId,
    ]);
    await conversation(noHours.clinicId, {
      channel: "voice",
      at: new Date(week.from.getTime() + DAY),
    });
    expect(await queueWeeklyRecapFor(noHours.clinicId, monday)).toBe("queued");
    const [alone] = await notices(noHours.clinicId, "weekly_recap");
    expect(alone!.payload).toMatchObject({
      isSummaryOff: false,
      settingsUrl: publicUrl(`/c/${noHours.clinicSlug}/knowledge#hours`),
    });
  });
});
