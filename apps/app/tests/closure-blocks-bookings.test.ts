import { randomUUID } from "node:crypto";

import type { FakeGoogleCalendar } from "@healdesk/connectors";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

// The direct-booking switch is three facts (lib/booking/direct-switch.ts, DB-1):
// the owner's env var, counsel's released addendum and the deployed addendum
// version. The committed catalog keeps the addendum unreleased; it is released
// here, in this test process only, so these suites book as production would
// once all three are set.
vi.mock("@healdesk/catalog", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@healdesk/catalog")>();
  return {
    ...actual,
    currentDirectBookingAddendum: () => ({ ...actual.currentDirectBookingAddendum(), approvedByCounsel: true }),
  };
});

import { availableSlotsFor, checkSpan } from "@/lib/booking/availability";
import { bookConversation } from "@/lib/booking/book";
import { placeHold } from "@/lib/booking/engine";
import { holderRefOf } from "@/lib/booking/holds";
import { clinicLocalDate } from "@/lib/clinic/closures";
import { approveAgentConfig } from "@/lib/onboarding/agent-config";
import { saveKnowledge } from "@/lib/portal/knowledge";
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
 * The chain the owner asked to see (ops automation E4 step 4): a closed day
 * the clinic saves in Knowledge → Hours reaches every booking path. A clinic
 * whose Google calendar is free all day gets times on day D; the clinic
 * saves D closed through the portal's own writer (saveKnowledge "hours", as
 * the Hours form does); from then on the availability engine every channel
 * shares offers nothing on D and still offers D+1, the hold-time check calls
 * D 10:00 busy, and a caller who held D 10:00 before the save cannot book
 * it: the booking's re-check refuses it and lets the hold go. Google is the
 * in-memory fake; everything synthetic.
 */

const describeDb = hasTestDatabase ? describe : describe.skip;
const SLOW = 120_000;
const ACTOR = { type: "service", serviceName: "closure-chain-test" } as const;
const EVERY_DAY = Object.fromEntries(
  ["sun", "mon", "tue", "wed", "thu", "fri", "sat"].map((d) => [d, [["08:00", "20:00"]]]),
);

describeDb("a closed day saved in the portal blocks booking on that day", () => {
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
    process.env.HEALDESK_DIRECT_BOOKING_ADDENDUM = "direct-booking-addendum/1.0.0";
  });

  afterAll(async () => {
    delete process.env.HEALDESK_DIRECT_BOOKING_ENABLED;
    delete process.env.HEALDESK_DIRECT_BOOKING_ADDENDUM;
    restoreGoogleEnv();
    await closePools();
  });

  test(
    "slots on D, then the clinic closes D: none on D, D+1 unchanged, D 10:00 busy, the earlier hold refused at booking",
    async () => {
      const f = await deskLocation(google, "closure-chain");
      await getMigratorPool().query(
        `update clinics set data_classification = 'production', baa_signed_at = now(), went_live_at = now() where id = $1`,
        [f.clinicId],
      );
      await withTenant({ clinicId: f.clinicId, actor: ACTOR }, (tx) =>
        approveAgentConfig(tx, "Dr Chen"),
      );

      const tenAtD = deskTime(3, 10);
      const day = clinicLocalDate(tenAtD, DESK_TZ);
      const nextDay = clinicLocalDate(deskTime(4, 10), DESK_TZ);
      const from = deskTime(3, 0);
      const datesOf = async () => {
        const found = await availableSlotsFor(f.clinicId, {
          from,
          days: 2,
          service: "Consultation",
          actor: ACTOR,
        });
        expect(found.status).toBe("ok");
        return found.status === "ok"
          ? new Set(found.slots.map((s) => clinicLocalDate(s.at, DESK_TZ)))
          : new Set<string>();
      };

      // Before: the calendar is free, so both days offer time.
      const before = await datesOf();
      expect(before.has(day)).toBe(true);
      expect(before.has(nextDay)).toBe(true);

      // A caller holds D 10:00 while the clinic is still open that day.
      const holderKey = `retell:closure-${randomUUID()}`;
      const held = await placeHold(f.clinicId, {
        channel: "voice",
        holderKey,
        startsAt: tenAtD,
        service: "Consultation",
      });
      expect(held.kind).toBe("held");

      // The clinic closes D through the Knowledge → Hours writer.
      const { userId } = await seedPortalUser(f.clinicId, "owner");
      const saved = await saveKnowledge(
        { clinicId: f.clinicId, userId, actorLabel: "the clinic's sign-in" },
        "hours",
        { hours: EVERY_DAY, closures: [{ closedOn: day, label: "Staff training" }] },
      );
      expect(saved).toMatchObject({ ok: true });

      // The save let the caller's held minute on D go at once (lane B,
      // releaseLiveHolds' `dates`): it no longer blocks anyone.
      const released = await inTenant(f.clinicId, async (c) =>
        (await c.query<{ status: string; outcome_reason: string | null }>(`select status, outcome_reason from slot_holds`)).rows,
      );
      expect(released).toHaveLength(1);
      expect(released[0]!.outcome_reason).toBe("closure_added");
      expect(["released", "expired"]).toContain(released[0]!.status);

      // After: nothing on D, the next day as it was.
      const after = await datesOf();
      expect(after.has(day)).toBe(false);
      expect(after.has(nextDay)).toBe(true);

      // The hold-time check calls D 10:00 busy, for anyone, the holder included.
      expect(
        await checkSpan(f.clinicId, {
          startsAt: tenAtD,
          service: "Consultation",
          fresh: false,
          actor: ACTOR,
        }),
      ).toEqual({ status: "busy" });
      expect(
        await checkSpan(f.clinicId, {
          startsAt: tenAtD,
          service: "Consultation",
          holderRef: holderRefOf(f.clinicId, holderKey),
          fresh: false,
          actor: ACTOR,
        }),
      ).toEqual({ status: "busy" });

      // The caller who held D 10:00 before the save cannot book it.
      const answer = await bookConversation(f.clinicId, {
        channel: "voice",
        holderKey,
        bookingKey: `${holderKey}:1`,
        startsAt: tenAtD,
        firstName: "Ana",
        phoneE164: "+14155550188",
        service: "Consultation",
        budgetMs: 20_000,
      });
      expect(answer.kind).toBe("slot_taken");
      if (answer.kind === "slot_taken") {
        for (const alternative of answer.alternatives) {
          expect(clinicLocalDate(alternative, DESK_TZ)).not.toBe(day);
        }
      }
      const rows = await inTenant(f.clinicId, async (c) => ({
        holds: (
          await c.query<{ status: string; outcome_reason: string | null }>(
            `select status, outcome_reason from slot_holds`,
          )
        ).rows,
        appointments: (await c.query(`select id from appointments`)).rows,
      }));
      // Still the one hold, let go by the save, not by the booking's re-check.
      expect(rows.holds).toHaveLength(1);
      expect(rows.holds[0]!.outcome_reason).toBe("closure_added");
      expect(rows.appointments).toEqual([]);
      expect(google.requests.filter((r) => r.endpoint === "insert")).toHaveLength(0);
    },
    SLOW,
  );

  test(
    "a hold the save does not release (the day closed by another writer) is still refused at booking, by the booking's own re-check",
    async () => {
      const f = await deskLocation(google, "closure-recheck");
      await getMigratorPool().query(
        `update clinics set data_classification = 'production', baa_signed_at = now(), went_live_at = now() where id = $1`,
        [f.clinicId],
      );
      await withTenant({ clinicId: f.clinicId, actor: ACTOR }, (tx) => approveAgentConfig(tx, "Dr Chen"));
      const tenAtD = deskTime(3, 10);
      const day = clinicLocalDate(tenAtD, DESK_TZ);

      const holderKey = `retell:recheck-${randomUUID()}`;
      const held = await placeHold(f.clinicId, {
        channel: "voice",
        holderKey,
        startsAt: tenAtD,
        service: "Consultation",
      });
      expect(held.kind).toBe("held");

      // D closed straight in the table, bypassing saveHours, so nothing lets
      // the hold go: only the booking's re-check stands between it and D.
      await inTenant(f.clinicId, (c) =>
        c.query(`insert into clinic_closures (clinic_id, closed_on, label) values ($1, $2, 'Staff training')`, [
          f.clinicId,
          day,
        ]),
      );
      const still = await inTenant(f.clinicId, async (c) =>
        (await c.query<{ status: string }>(`select status from slot_holds`)).rows,
      );
      expect(still).toEqual([{ status: "held" }]);

      const answer = await bookConversation(f.clinicId, {
        channel: "voice",
        holderKey,
        bookingKey: `${holderKey}:1`,
        startsAt: tenAtD,
        firstName: "Ana",
        phoneE164: "+14155550188",
        service: "Consultation",
        budgetMs: 20_000,
      });
      expect(answer.kind).toBe("slot_taken");
      const rows = await inTenant(f.clinicId, async (c) => ({
        holds: (
          await c.query<{ status: string; outcome_reason: string | null }>(
            `select status, outcome_reason from slot_holds`,
          )
        ).rows,
        appointments: (await c.query(`select id from appointments`)).rows,
      }));
      expect(rows.holds).toEqual([{ status: "released", outcome_reason: "slot_taken" }]);
      expect(rows.appointments).toEqual([]);
      expect(google.requests.filter((r) => r.endpoint === "insert")).toHaveLength(0);
    },
    SLOW,
  );
});
