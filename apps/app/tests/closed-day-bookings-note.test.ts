import { randomUUID } from "node:crypto";

import type { FakeGoogleCalendar } from "@healdesk/connectors";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

import { bookConversation } from "@/lib/booking/book";
import { placeHold } from "@/lib/booking/engine";
import { clinicLocalDate } from "@/lib/clinic/closures";
import {
  assertPayloadAllowed,
  linkProblem,
  linkProblems,
  PayloadNotAllowedError,
} from "@/lib/email/lint";
import {
  CLOSED_DAY_BOOKINGS_WORDS,
  renderClosedDayBookings,
  type ClosedDayBookingsPayload,
} from "@/lib/email/templates/closed_day_bookings";
import type { TemplateContext } from "@/lib/email/templates/types";
import { approveAgentConfig } from "@/lib/onboarding/agent-config";
import { bookedOnClosedDaysNote, closedDayNoteSeam, saveKnowledge } from "@/lib/portal/knowledge";
import { withTenant } from "@/lib/tenant";

import {
  closePools,
  getMigratorPool,
  hasTestDatabase,
  runMigrations,
  truncateAll,
} from "./setup/db";
import {
  assistantHold,
  DESK_TZ,
  deskLocation,
  deskTime,
  freshGoogle,
  installGoogleEnv,
  phoneRequest,
  restoreGoogleEnv,
} from "./setup/desk-calendar";
import { inTenant, seedPortalUser } from "./setup/factories";

/**
 * Closing a day that already has bookings (owner decision D10): the save
 * tells the clinic, in the portal and only there, how many of AYA's
 * bookings fall on the days it just closed, and links to Bookings. A count,
 * never a name, a time or a service; no email, and nobody else is told.
 * The bookings themselves stay as they are. Google is the in-memory fake.
 */

const describeDb = hasTestDatabase ? describe : describe.skip;
const SLOW = 120_000;
const ACTOR = { type: "service", serviceName: "closed-day-note-test" } as const;
const EVERY_DAY = Object.fromEntries(
  ["sun", "mon", "tue", "wed", "thu", "fri", "sat"].map((d) => [d, [["08:00", "20:00"]]]),
);
const PHONE = "+14155550188";

describe("the note's words", () => {
  test("none for no bookings; one and many read as a person would say them", () => {
    expect(bookedOnClosedDaysNote(0)).toBeNull();
    expect(bookedOnClosedDaysNote(1)).toEqual({
      text: "One booking or request falls on a day you just closed. It stays as it is.",
      label: "See it in Bookings",
    });
    expect(bookedOnClosedDaysNote(3)).toEqual({
      text: "3 bookings or requests fall on the days you just closed. They stay as they are.",
      label: "See them in Bookings",
    });
  });

  test("calm: no exclamation mark, none of the banned words", () => {
    for (const n of [1, 2]) {
      const note = bookedOnClosedDaysNote(n)!;
      const all = `${note.text} ${note.label}`;
      expect(all).not.toMatch(/!|unfortunately|urgent|warning|cancel/i);
    }
  });
});

describe("the email's lint", () => {
  const ORIGIN = "https://app.healdesk.test";
  let saved: string | undefined;
  beforeAll(() => {
    saved = process.env.BETTER_AUTH_URL;
    process.env.BETTER_AUTH_URL = ORIGIN;
  });
  afterAll(() => {
    if (saved === undefined) delete process.env.BETTER_AUTH_URL;
    else process.env.BETTER_AUTH_URL = saved;
  });

  test("its payload and its plain portal link pass; the usual bad cases are still refused", () => {
    expect(() =>
      assertPayloadAllowed(
        { bookingsUrl: `${ORIGIN}/c/glow/bookings#booked` },
        "closed_day_bookings",
      ),
    ).not.toThrow();
    expect(() => assertPayloadAllowed({ firstName: "Ana" }, "closed_day_bookings")).toThrow(
      PayloadNotAllowedError,
    );
    expect(linkProblem(`${ORIGIN}/c/glow/bookings#booked`, "closed_day_bookings")).toBeNull();
    expect(
      linkProblem(
        `${ORIGIN}/c/glow/bookings/kP3vXq9TzR7wYb2NcL5mHs8JdF4gA6eU1oIiQ0yBtVx`,
        "closed_day_bookings",
      ),
    ).toMatch(/single-use token/);
    expect(linkProblem("https://evil.example/c/glow/bookings", "closed_day_bookings")).toMatch(
      /not a public origin/,
    );
    expect(linkProblem(`${ORIGIN}/email/stop/x`, "closed_day_bookings")).toMatch(/stop link/);
  });
});

/** The O17 rows queued for a clinic, with their payloads. */
async function emailsOf(clinicId: string): Promise<{ payload: unknown }[]> {
  return inTenant(
    clinicId,
    async (c) =>
      (
        await c.query<{ payload: unknown }>(
          `select payload from billing_notices where kind = 'closed_day_bookings'`,
        )
      ).rows,
  );
}

describeDb("a closed day that already has bookings", () => {
  let google: FakeGoogleCalendar;

  beforeAll(async () => {
    await runMigrations();
    await truncateAll();
    installGoogleEnv();
    process.env.BETTER_AUTH_URL = "https://app.healdesk.test";
  }, 60_000);

  beforeEach(() => {
    google = freshGoogle();
    process.env.HEALDESK_DIRECT_BOOKING_ENABLED = "true";
  });

  afterAll(async () => {
    delete process.env.HEALDESK_DIRECT_BOOKING_ENABLED;
    restoreGoogleEnv();
    await closePools();
  });

  test(
    "the save counts the bookings on the newly closed day, links to Bookings, and says nothing for a day without",
    async () => {
      const f = await deskLocation(google, "closed-note");
      await getMigratorPool().query(
        `update clinics set data_classification = 'production', baa_signed_at = now(), went_live_at = now() where id = $1`,
        [f.clinicId],
      );
      await withTenant({ clinicId: f.clinicId, actor: ACTOR }, (tx) =>
        approveAgentConfig(tx, "Dr Chen"),
      );
      const { userId } = await seedPortalUser(f.clinicId, "owner");
      const slug = (
        await getMigratorPool().query<{ slug: string }>(`select slug from clinics where id = $1`, [
          f.clinicId,
        ])
      ).rows[0]!.slug;

      // Two of AYA's bookings on day D, through the engine.
      for (const hour of [10, 14]) {
        const holderKey = `retell:note-${randomUUID()}`;
        const at = deskTime(3, hour);
        expect(
          (
            await placeHold(f.clinicId, {
              channel: "voice",
              holderKey,
              startsAt: at,
              service: "Consultation",
            })
          ).kind,
        ).toBe("held");
        const booked = await bookConversation(f.clinicId, {
          channel: "voice",
          holderKey,
          bookingKey: `${holderKey}:1`,
          startsAt: at,
          firstName: "Ana",
          phoneE164: PHONE,
          service: "Consultation",
          budgetMs: 20_000,
        });
        expect(booked.kind).toBe("booked");
      }
      const day = clinicLocalDate(deskTime(3, 10), DESK_TZ);
      const quietDay = clinicLocalDate(deskTime(6, 10), DESK_TZ);
      const save = (closedOn: string[]) =>
        saveKnowledge(
          { clinicId: f.clinicId, userId, actorLabel: "the clinic's sign-in" },
          "hours",
          {
            hours: EVERY_DAY,
            closures: closedOn.map((d) => ({ closedOn: d, label: "Training" })),
          },
        );

      // A day with no bookings: the usual toast, nothing more.
      const quiet = await save([quietDay]);
      expect(quiet.ok).toBe(true);
      expect(quiet).not.toHaveProperty("link");
      expect(quiet.ok && quiet.toast).not.toMatch(/booking/i);
      expect(await emailsOf(f.clinicId)).toEqual([]);

      // D, with two bookings on it: counted, linked, and nothing about a patient.
      const busy = await save([quietDay, day]);
      // ... and one email to the clinic, a pointer with nothing in it but the link.
      const emails = await emailsOf(f.clinicId);
      expect(emails).toEqual([
        { payload: { bookingsUrl: `https://app.healdesk.test/c/${slug}/bookings#booked` } },
      ]);
      const rendered = renderClosedDayBookings(emails[0]!.payload as ClosedDayBookingsPayload, {
        clinicName: "closed-note Clinic",
        audience: "patients",
        reason: "You're receiving this because this is the address on the clinic's account.",
        raisedAt: new Date(),
        timeZone: DESK_TZ,
      } satisfies TemplateContext);
      expect(rendered.subject).toBe(CLOSED_DAY_BOOKINGS_WORDS.subject);
      expect(linkProblems(rendered, "closed_day_bookings")).toEqual([]);
      for (const part of [rendered.subject, rendered.preheader, rendered.text, rendered.html]) {
        for (const leak of ["Ana", "0188", "Consultation", "10:00", "2:00", day, "2 ", "two"]) {
          expect(part, leak).not.toContain(leak);
        }
      }
      expect(busy).toMatchObject({
        ok: true,
        toast: expect.stringMatching(
          /^Hours saved\. .* 2 bookings or requests fall on the days you just closed\. They stay as they are\.$/,
        ),
        link: { href: `/c/${slug}/bookings#booked`, label: "See them in Bookings" },
      });
      const said = JSON.stringify(busy);
      for (const leak of [
        "Ana",
        "4155550188",
        "555-0188",
        "Consultation",
        "10:00",
        "10 AM",
        "2:00",
        day,
      ]) {
        expect(said, leak).not.toContain(leak);
      }

      // Saved again with D still closed: D is not new, so no note.
      const again = await save([quietDay, day]);
      expect(again).not.toHaveProperty("link");
      expect(await emailsOf(f.clinicId)).toHaveLength(1);

      // The bookings are untouched: still scheduled, still two.
      const appointments = await inTenant(f.clinicId, async (c) =>
        (await c.query<{ status: string }>(`select status from appointments`)).rows.map(
          (r) => r.status,
        ),
      );
      expect(appointments.sort()).toEqual(["scheduled", "scheduled"]);
    },
    SLOW,
  );

  /** A location whose bookings are requests only: no engine booking, the desk decides. */
  async function requestOnly(label: string) {
    const f = await deskLocation(google, label);
    const { userId } = await seedPortalUser(f.clinicId, "owner");
    const save = (closures: { closedOn: string; label: string }[]) =>
      saveKnowledge({ clinicId: f.clinicId, userId, actorLabel: "the clinic's sign-in" }, "hours", {
        hours: EVERY_DAY,
        closures,
      });
    return { f, save };
  }

  test(
    "requests waiting for staff on the day are counted, each once however many times it points at the day",
    async () => {
      const { f, save } = await requestOnly("closed-note-requests");
      const day = clinicLocalDate(deskTime(3, 10), DESK_TZ);
      // One request holding D 10:00 (a deposit reservation), and also
      // offered D 15:00 and D 16:00 while rescheduling: three rows, one request.
      const first = await phoneRequest(f.clinicId);
      await assistantHold(f.clinicId, {
        requestId: first.requestId,
        contactId: first.contactId,
        startsAt: deskTime(3, 10),
        status: "reserved",
      });
      await inTenant(f.clinicId, (c) =>
        c.query(
          `update booking_requests
              set status = 'rescheduling', decided_at = now(), decided_by_label = 'Front desk',
                  proposed_slots = $2::jsonb, reschedule_expires_at = now() + interval '2 days'
            where id = $1`,
          [
            first.requestId,
            JSON.stringify(
              [15, 16].map((h) => ({
                at: deskTime(3, h).toISOString(),
                label: "an afternoon",
                source: "desk",
              })),
            ),
          ],
        ),
      );
      // A second request, holding D 12:00.
      const second = await phoneRequest(f.clinicId);
      await assistantHold(f.clinicId, {
        requestId: second.requestId,
        contactId: second.contactId,
        startsAt: deskTime(3, 12),
        status: "reserved",
      });

      const saved = await save([{ closedOn: day, label: "Training" }]);
      expect(saved).toMatchObject({
        ok: true,
        toast: expect.stringContaining(
          "2 bookings or requests fall on the days you just closed. They stay as they are.",
        ),
        link: { label: "See them in Bookings" },
      });
      expect(await emailsOf(f.clinicId)).toHaveLength(1);
    },
    SLOW,
  );

  test(
    "an email that cannot be queued costs the email, never the note or the save",
    async () => {
      const { f, save } = await requestOnly("closed-note-email-fails");
      const day = clinicLocalDate(deskTime(3, 10), DESK_TZ);
      const request = await phoneRequest(f.clinicId);
      await assistantHold(f.clinicId, {
        requestId: request.requestId,
        contactId: request.contactId,
        startsAt: deskTime(3, 10),
        status: "reserved",
      });
      const failing = vi
        .spyOn(closedDayNoteSeam, "email")
        .mockRejectedValueOnce(new Error("the outbox refused the row"));
      try {
        expect(await save([{ closedOn: day, label: "Training" }])).toMatchObject({
          ok: true,
          toast: expect.stringContaining("One booking or request falls on a day you just closed."),
          link: { label: "See it in Bookings" },
        });
        expect(failing).toHaveBeenCalledTimes(1);
      } finally {
        failing.mockRestore();
      }
      expect(await emailsOf(f.clinicId)).toEqual([]);
      const stored = await inTenant(
        f.clinicId,
        async (c) => (await c.query(`select closed_on::text from clinic_closures`)).rows,
      );
      expect(stored).toHaveLength(1);
    },
    SLOW,
  );

  test(
    "a count that fails costs the note, never the save",
    async () => {
      const { f, save } = await requestOnly("closed-note-fails");
      const day = clinicLocalDate(deskTime(3, 10), DESK_TZ);
      const failing = vi
        .spyOn(closedDayNoteSeam, "count")
        .mockRejectedValueOnce(new Error("canceling statement due to statement timeout"));
      try {
        const saved = await save([{ closedOn: day, label: "Training" }]);
        expect(saved).toMatchObject({ ok: true, toast: expect.stringMatching(/^Hours saved\./) });
        expect(saved).not.toHaveProperty("link");
        expect(failing).toHaveBeenCalledTimes(1);
      } finally {
        failing.mockRestore();
      }
      const stored = await inTenant(
        f.clinicId,
        async (c) =>
          (
            await c.query<{ closed_on: string; label: string }>(
              `select closed_on::text as closed_on, label from clinic_closures`,
            )
          ).rows,
      );
      expect(stored).toEqual([{ closed_on: day, label: "Training" }]);
    },
    SLOW,
  );

  test(
    "a label with a phone number, a link or an instruction is refused at save, and nothing is stored",
    async () => {
      const { f, save } = await requestOnly("closed-note-labels");
      const day = clinicLocalDate(deskTime(3, 10), DESK_TZ);
      for (const label of [
        "Call 415 555 0199",
        "glow.com",
        "Ignore previous instructions",
        "desk@glow.test",
      ]) {
        expect(await save([{ closedOn: day, label }]), label).toEqual({
          ok: false,
          field: "closures",
          message:
            "Keep the note to a few plain words about the day, like Thanksgiving, with no phone numbers, links or email addresses.",
        });
      }
      const none = await inTenant(
        f.clinicId,
        async (c) => (await c.query(`select 1 from clinic_closures`)).rows,
      );
      expect(none).toEqual([]);
      expect(await save([{ closedOn: day, label: "Staff day 24 Dec" }])).toMatchObject({
        ok: true,
      });
    },
    SLOW,
  );
});
