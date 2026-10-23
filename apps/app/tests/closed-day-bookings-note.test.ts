import { randomUUID } from "node:crypto";

import type { FakeGoogleCalendar } from "@healdesk/connectors";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { bookConversation } from "@/lib/booking/book";
import { placeHold } from "@/lib/booking/engine";
import { clinicLocalDate } from "@/lib/clinic/closures";
import { approveAgentConfig } from "@/lib/onboarding/agent-config";
import { bookedOnClosedDaysNote, saveKnowledge } from "@/lib/portal/knowledge";
import { withTenant } from "@/lib/tenant";

import {
  closePools,
  getMigratorPool,
  hasTestDatabase,
  runMigrations,
  truncateAll,
} from "./setup/db";
import {
  DESK_TZ,
  deskLocation,
  deskTime,
  freshGoogle,
  installGoogleEnv,
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
      text: "One booking falls on a day you just closed. It stays booked as it is.",
      label: "See it in Bookings",
    });
    expect(bookedOnClosedDaysNote(3)).toEqual({
      text: "3 bookings fall on the days you just closed. They stay booked as they are.",
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

      // D, with two bookings on it: counted, linked, and nothing about a patient.
      const busy = await save([quietDay, day]);
      expect(busy).toMatchObject({
        ok: true,
        toast: expect.stringMatching(
          /^Hours saved\. .* 2 bookings fall on the days you just closed\. They stay booked as they are\.$/,
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
});
