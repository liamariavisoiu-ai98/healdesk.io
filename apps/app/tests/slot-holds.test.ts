import { afterAll, beforeAll, describe, expect, test } from "vitest";

import {
  asApp,
  at,
  bindCalendarAgreement,
  claimForWriting,
  type Client,
  futureBase,
  insertBookingRequest,
  insertGoogleConnection,
  insertHold,
  recordAgreementElection,
  seedWritableCalendar,
} from "./setup/calendar-db";
import {
  closePools,
  getAppPool,
  getMigratorPool,
  hasTestDatabase,
  runMigrations,
  truncateAll,
} from "./setup/db";
import { inTenant, seedClinic, seedContact, type SeededClinic } from "./setup/factories";

/**
 * Slot holds and the overlap guard (drizzle/0057; plan §7.1-7.3, §11.4,
 * §11.6).
 *
 * The invariant: within one clinic, no live hold overlaps another holder's
 * live hold or a live healdesk booking, and no live healdesk booking overlaps
 * either; and nothing blocks indefinitely, even with no sweeper. The
 * database enforces it on every path that occupies time, so these tests talk
 * to the database directly, on the runtime role inside a tenant, and attack
 * the places an application would get it wrong: a race, a lapsed hold, a
 * write the terms no longer allow, a field rewritten after the fact.
 */

const describeDb = hasTestDatabase ? describe : describe.skip;

/** Each test seeds clinics and calendars over many round trips; a loaded runner needs room. */
const SLOW = 60_000;

/** Postgres' error code, wherever node-postgres or drizzle put it. */
function codeOf(error: unknown): string | undefined {
  for (let current: unknown = error, depth = 0; current && depth < 5; depth += 1) {
    if (typeof current !== "object") return undefined;
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string") return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Live holds overlapping [start, start + minutes) on the clinic, read as the migrator in its tenant. */
async function liveHoldsOver(clinicId: string, start: Date, minutes: number): Promise<number> {
  return inTenant(clinicId, async (client) => {
    const { rows } = await client.query<{ n: number }>(
      `select count(*)::int as n from slot_holds h
        where h.clinic_id = $1::uuid
          and h.starts_at < $2::timestamptz + make_interval(mins => $3::int) and $2::timestamptz < h.ends_at
          and ((h.status = 'held' and h.expires_at > clock_timestamp())
               or (h.status in ('writing', 'unknown', 'reserved') and h.blocks_until > clock_timestamp()))`,
      [clinicId, start, minutes],
    );
    return rows[0]!.n;
  });
}

async function insertAppointment(
  c: Client,
  clinicId: string,
  contactId: string,
  input: {
    at: Date;
    minutes?: number | null;
    origin?: "assistant" | "desk" | null;
    status?: string;
  },
): Promise<string> {
  const { rows } = await c.query<{ id: string }>(
    `insert into appointments (clinic_id, contact_id, scheduled_for, duration_minutes, booking_origin, status)
     values ($1, $2, $3, $4, $5, $6::appointment_status) returning id`,
    [
      clinicId,
      contactId,
      input.at,
      input.minutes ?? null,
      input.origin ?? null,
      input.status ?? "scheduled",
    ],
  );
  return rows[0]!.id;
}

describeDb("slot holds and the overlap guard (0057)", () => {
  beforeAll(async () => {
    await runMigrations();
    await truncateAll();
  }, 60_000);

  afterAll(async () => {
    await closePools();
  });

  /* ------------------------------------------------------------- placing */

  test(
    "a hold over another holder's live hold is refused (23P01); adjacent half-open spans coexist",
    async () => {
      const { clinicId } = await seedClinic("hold-overlap");
      const base = futureBase();
      await asApp(clinicId, (c) => insertHold(c, clinicId, { holder: "voice:a", startsAt: base }));

      for (const [start, minutes] of [
        [at(base, 15), 30],
        [at(base, -15), 30],
        [at(base, 5), 10],
        [at(base, -60), 120],
      ] as const) {
        await expect(
          asApp(clinicId, (c) =>
            insertHold(c, clinicId, { holder: "voice:b", startsAt: start, minutes }),
          ),
          start.toISOString(),
        ).rejects.toMatchObject({ code: "23P01" });
      }

      // [10:00, 10:30) and [10:30, 11:00) share no instant; nor do [9:30, 10:00) and [10:00, 10:30).
      await asApp(clinicId, (c) =>
        insertHold(c, clinicId, { holder: "voice:b", startsAt: at(base, 30) }),
      );
      await asApp(clinicId, (c) =>
        insertHold(c, clinicId, { holder: "voice:c", startsAt: at(base, -30) }),
      );
    },
    SLOW,
  );

  test(
    "two holds racing for one time on separate connections: exactly one wins, the other gets 23P01",
    async () => {
      const { clinicId } = await seedClinic("hold-race");
      const base = futureBase(11);

      const attempt = async (holder: string, startsAt: Date): Promise<string> => {
        const client = await getAppPool().connect();
        try {
          await client.query("begin");
          await client.query(`select set_config('app.clinic_id', $1, true)`, [clinicId]);
          await insertHold(client as unknown as Client, clinicId, { holder, startsAt });
          await client.query("commit");
          return "won";
        } catch (error) {
          await client.query("rollback").catch(() => {});
          return codeOf(error) ?? String(error);
        } finally {
          client.release();
        }
      };

      // Several rounds, each at a different time: a race declared won on one
      // lucky interleaving is not won.
      for (let round = 0; round < 5; round += 1) {
        const startsAt = at(base, round * 60);
        const results = await Promise.all([
          attempt(`voice:race-${round}-x`, startsAt),
          attempt(`voice:race-${round}-y`, at(startsAt, 10)),
        ]);
        expect(results.sort(), `round ${round}`).toEqual(["23P01", "won"]);
        expect(await liveHoldsOver(clinicId, startsAt, 40)).toBe(1);
      }
    },
    SLOW,
  );

  test(
    "a lapsed hold blocks nothing, with no sweeper",
    async () => {
      const { clinicId } = await seedClinic("hold-lapsed");
      const base = futureBase(12);
      // Placed 90 seconds ago: its 60-second window closed 30 seconds ago, and
      // nothing has marked it expired. The row still says `held`.
      const lapsed = await asApp(clinicId, (c) =>
        insertHold(c, clinicId, { holder: "voice:slow", startsAt: base, placedSecondsAgo: 90 }),
      );
      await asApp(clinicId, (c) =>
        insertHold(c, clinicId, { holder: "voice:next", startsAt: base }),
      );

      const { rows } = await inTenant(clinicId, (client) =>
        client.query<{ status: string }>(`select status from slot_holds where id = $1`, [lapsed]),
      );
      expect(rows[0]!.status).toBe("held");
    },
    SLOW,
  );

  test(
    "a new hold is born held, with nothing leased, written or decided, and never in the future",
    async () => {
      const { clinicId } = await seedClinic("hold-born");
      const base = futureBase(13);
      const insertWith = (columns: string, values: string) =>
        asApp(clinicId, (c) =>
          c.query(
            `insert into slot_holds (clinic_id, channel, holder_ref, calendar_id, starts_at, duration_minutes, ends_at${columns})
           values ($1, 'voice', repeat('a', 64), 'primary', $2::timestamptz, 30, $2::timestamptz + interval '30 minutes'${values})`,
            [clinicId, base],
          ),
        );

      await expect(insertWith(", status", ", 'writing'")).rejects.toMatchObject({ code: "23514" });
      await expect(insertWith(", status", ", 'reserved'")).rejects.toMatchObject({ code: "23514" });
      await expect(insertWith(", lease_token", ", gen_random_uuid()")).rejects.toMatchObject({
        code: "23514",
      });
      await expect(insertWith(", blocks_until", ", clock_timestamp()")).rejects.toMatchObject({
        code: "23514",
      });
      await expect(insertWith(", outcome_reason", ", 'superseded'")).rejects.toMatchObject({
        code: "23514",
      });
      // A window measured from a time the writer chose could block for as long as it liked.
      await expect(
        insertWith(
          ", created_at, expires_at",
          ", clock_timestamp() + interval '1 day', clock_timestamp() + interval '1 day 1 minute'",
        ),
      ).rejects.toMatchObject({ code: "23514" });
      // The window itself: more than two minutes, or none, is refused by its CHECK.
      await expect(
        insertWith(", expires_at", ", clock_timestamp() + interval '3 minutes'"),
      ).rejects.toMatchObject({ code: "23514", constraint: "slot_holds_expiry_check" });
      // ends_at must be starts_at + the duration.
      await expect(
        asApp(clinicId, (c) =>
          c.query(
            `insert into slot_holds (clinic_id, channel, holder_ref, calendar_id, starts_at, duration_minutes, ends_at)
           values ($1, 'voice', repeat('b', 64), 'primary', $2::timestamptz, 30, $2::timestamptz + interval '20 minutes')`,
            [clinicId, base],
          ),
        ),
      ).rejects.toMatchObject({ code: "23514", constraint: "slot_holds_ends_check" });
      // A holder_ref is a sha256, never the raw key.
      await expect(
        asApp(clinicId, (c) =>
          c.query(
            `insert into slot_holds (clinic_id, channel, holder_ref, calendar_id, starts_at, duration_minutes, ends_at)
           values ($1, 'voice', 'voice:CA123', 'primary', $2::timestamptz, 30, $2::timestamptz + interval '30 minutes')`,
            [clinicId, base],
          ),
        ),
      ).rejects.toMatchObject({ code: "23514", constraint: "slot_holds_holder_ref_check" });
    },
    SLOW,
  );

  test(
    "a web chat hold names the contact who asked; voice may hold before it has one",
    async () => {
      const { clinicId } = await seedClinic("hold-webchat");
      const base = futureBase(14);
      await expect(
        asApp(clinicId, (c) =>
          insertHold(c, clinicId, { holder: "web:anon", startsAt: base, channel: "web_chat" }),
        ),
      ).rejects.toMatchObject({ code: "23514" });

      const contactId = await seedContact(clinicId, "+15550100101");
      await asApp(clinicId, (c) =>
        insertHold(c, clinicId, {
          holder: "web:known",
          startsAt: base,
          channel: "web_chat",
          contactId,
        }),
      );
      await asApp(clinicId, (c) =>
        insertHold(c, clinicId, { holder: "voice:caller", startsAt: at(base, 60) }),
      );
    },
    SLOW,
  );

  /* ------------------------------------------------- holds and bookings */

  test(
    "healdesk's own bookings and holds exclude each other; a vendor row (no booking_origin) is not guarded",
    async () => {
      const { clinicId } = await seedClinic("hold-appointments");
      const contactId = await seedContact(clinicId, "+15550100102");
      const base = futureBase(15);

      // A live desk booking at 10:00 for the default 30 minutes blocks a hold at 10:15.
      await asApp(clinicId, (c) =>
        insertAppointment(c, clinicId, contactId, { at: base, origin: "desk" }),
      );
      await expect(
        asApp(clinicId, (c) =>
          insertHold(c, clinicId, { holder: "voice:a", startsAt: at(base, 15) }),
        ),
      ).rejects.toMatchObject({ code: "23P01" });
      // ...and another booking through healdesk at 10:20.
      await expect(
        asApp(clinicId, (c) =>
          insertAppointment(c, clinicId, contactId, {
            at: at(base, 20),
            minutes: 15,
            origin: "assistant",
          }),
        ),
      ).rejects.toMatchObject({ code: "23P01" });

      // A cancelled booking blocks nothing.
      await asApp(clinicId, (c) =>
        insertAppointment(c, clinicId, contactId, {
          at: at(base, 120),
          origin: "desk",
          status: "cancelled",
        }),
      );
      await asApp(clinicId, (c) =>
        insertHold(c, clinicId, { holder: "voice:b", startsAt: at(base, 120) }),
      );

      // A booking over another holder's live hold is refused...
      await expect(
        asApp(clinicId, (c) =>
          insertAppointment(c, clinicId, contactId, { at: at(base, 130), origin: "desk" }),
        ),
      ).rejects.toMatchObject({ code: "23P01" });
      // ...but a phase-two vendor row, with no booking_origin, never asks.
      await asApp(clinicId, (c) =>
        insertAppointment(c, clinicId, contactId, { at: at(base, 130) }),
      );

      // Moving a healdesk booking into a live hold is refused too.
      const later = await asApp(clinicId, (c) =>
        insertAppointment(c, clinicId, contactId, { at: at(base, 300), origin: "desk" }),
      );
      await expect(
        asApp(clinicId, (c) =>
          c.query(`update appointments set scheduled_for = $2 where id = $1`, [
            later,
            at(base, 125),
          ]),
        ),
      ).rejects.toMatchObject({ code: "23P01" });
      // A status change on its own time is not a conflict with itself.
      await asApp(clinicId, (c) =>
        c.query(`update appointments set status = 'confirmed' where id = $1`, [later]),
      );
    },
    SLOW,
  );

  test(
    "a booking made from a hold may sit on it once the hold is converted",
    async () => {
      const clinic = await seedClinic("hold-convert");
      await seedWritableCalendar(clinic);
      const { clinicId } = clinic;
      const contactId = await seedContact(clinicId, "+15550100103");
      const base = futureBase(16);

      const holdId = await asApp(clinicId, (c) =>
        insertHold(c, clinicId, { holder: "voice:a", startsAt: base }),
      );
      await asApp(clinicId, (c) => claimForWriting(c, holdId));
      // While the write is in flight the hold blocks every booking, healdesk's own included.
      await expect(
        asApp(clinicId, (c) =>
          insertAppointment(c, clinicId, contactId, { at: base, origin: "assistant" }),
        ),
      ).rejects.toMatchObject({ code: "23P01" });

      // The record step: convert, then insert, then link, in one transaction.
      const appointmentId = await asApp(clinicId, async (c) => {
        await c.query(
          `update slot_holds set status = 'converted', updated_at = now() where id = $1`,
          [holdId],
        );
        const id = await insertAppointment(c, clinicId, contactId, {
          at: base,
          minutes: 30,
          origin: "assistant",
        });
        await c.query(`update slot_holds set appointment_id = $2 where id = $1`, [holdId, id]);
        return id;
      });
      expect(appointmentId).toBeTruthy();
      // And the booking now holds the time against everyone else.
      await expect(
        asApp(clinicId, (c) =>
          insertHold(c, clinicId, { holder: "voice:b", startsAt: at(base, 10) }),
        ),
      ).rejects.toMatchObject({ code: "23P01" });
    },
    SLOW,
  );

  test(
    "the 480-minute lower bound still finds a 480-minute booking",
    async () => {
      const { clinicId } = await seedClinic("hold-long");
      const contactId = await seedContact(clinicId, "+15550100104");
      const base = futureBase(17);
      await asApp(clinicId, (c) =>
        insertAppointment(c, clinicId, contactId, { at: base, minutes: 480, origin: "desk" }),
      );
      // Its last half hour, 470 minutes in, is still taken; the instant it ends is free.
      await expect(
        asApp(clinicId, (c) =>
          insertHold(c, clinicId, { holder: "voice:a", startsAt: at(base, 470) }),
        ),
      ).rejects.toMatchObject({ code: "23P01" });
      await asApp(clinicId, (c) =>
        insertHold(c, clinicId, { holder: "voice:a", startsAt: at(base, 480) }),
      );
    },
    SLOW,
  );

  test(
    "booking_origin is written once, at insert",
    async () => {
      const { clinicId } = await seedClinic("hold-origin");
      const contactId = await seedContact(clinicId, "+15550100105");
      const base = futureBase(18);
      const vendor = await asApp(clinicId, (c) =>
        insertAppointment(c, clinicId, contactId, { at: base }),
      );
      const desk = await asApp(clinicId, (c) =>
        insertAppointment(c, clinicId, contactId, { at: at(base, 60), origin: "desk" }),
      );
      for (const [id, origin] of [
        [vendor, "desk"],
        [desk, "assistant"],
      ] as const) {
        await expect(
          asApp(clinicId, (c) =>
            c.query(`update appointments set booking_origin = $2 where id = $1`, [id, origin]),
          ),
        ).rejects.toMatchObject({ code: "42501" });
      }
      await expect(
        inTenant(clinicId, (client) =>
          client.query(`update appointments set booking_origin = null where id = $1`, [desk]),
        ),
      ).rejects.toMatchObject({ code: "42501" });
    },
    SLOW,
  );

  /* ---------------------------------------------------------- transitions */

  test(
    "held -> writing needs a live hold and the database's own write permission",
    async () => {
      const base = futureBase(19);

      // The baseline: everything in place, the claim goes through.
      const ok = await seedClinic("claim-ok");
      await seedWritableCalendar(ok);
      const okHold = await asApp(ok.clinicId, (c) =>
        insertHold(c, ok.clinicId, { holder: "voice:a", startsAt: base }),
      );
      await asApp(ok.clinicId, (c) => claimForWriting(c, okHold));

      // Degraded (three transient misses) is not broken: the calendar still
      // takes writes, the assistant's and the desk's (plan §11.6, condition 4).
      const degraded = await seedClinic("claim-degraded");
      await seedWritableCalendar(degraded);
      await inTenant(degraded.clinicId, (client) =>
        client.query(
          `update provider_connections set status = 'degraded', transient_failures = 3 where clinic_id = $1`,
          [degraded.clinicId],
        ),
      );
      const degradedAnswers = await asApp(degraded.clinicId, async (c) => {
        const { rows } = await c.query<{ assistant: boolean; desk: boolean }>(
          `select app_calendar_write_permitted($1, true) as assistant, app_calendar_write_permitted($1, false) as desk`,
          [degraded.clinicId],
        );
        return rows[0]!;
      });
      expect(degradedAnswers).toEqual({ assistant: true, desk: true });
      const degradedHold = await asApp(degraded.clinicId, (c) =>
        insertHold(c, degraded.clinicId, { holder: "voice:a", startsAt: base }),
      );
      await asApp(degraded.clinicId, (c) => claimForWriting(c, degradedHold));

      // A hold that lapsed while the caller spelled their name is not claimed.
      const lapsed = await asApp(ok.clinicId, (c) =>
        insertHold(c, ok.clinicId, {
          holder: "voice:b",
          startsAt: at(base, 120),
          placedSecondsAgo: 61,
        }),
      );
      await expect(asApp(ok.clinicId, (c) => claimForWriting(c, lapsed))).rejects.toMatchObject({
        code: "23514",
        message: expect.stringMatching(/lapsed/),
      });

      // Each way the terms, the connection or Auto-confirm can say no.
      const refusals: [string, (clinic: SeededClinic) => Promise<void>][] = [
        [
          "no agreement in effect",
          async (clinic) => {
            await getMigratorPool().query(
              `update baa_acceptances set terminated_at = now() where organization_id = $1`,
              [clinic.organizationId],
            );
          },
        ],
        [
          "a broken connection",
          async (clinic) => {
            await inTenant(clinic.clinicId, (client) =>
              client.query(
                `update provider_connections set broken_at = now() where clinic_id = $1`,
                [clinic.clinicId],
              ),
            );
          },
        ],
        [
          "a degraded connection that is also broken",
          async (clinic) => {
            await inTenant(clinic.clinicId, (client) =>
              client.query(
                `update provider_connections set status = 'degraded', broken_at = now() where clinic_id = $1`,
                [clinic.clinicId],
              ),
            );
          },
        ],
        [
          "a connection in error",
          async (clinic) => {
            await inTenant(clinic.clinicId, (client) =>
              client.query(
                `update provider_connections set status = 'error' where clinic_id = $1`,
                [clinic.clinicId],
              ),
            );
          },
        ],
        [
          "a personal account under Workspace terms",
          async (clinic) => {
            await inTenant(clinic.clinicId, (client) =>
              client.query(
                `update provider_connections set metadata = jsonb_set(metadata, '{managed}', 'false') where clinic_id = $1`,
                [clinic.clinicId],
              ),
            );
          },
        ],
        [
          "Auto-confirm off",
          async (clinic) => {
            await asApp(clinic.clinicId, (c) =>
              c.query(
                `insert into clinic_settings (clinic_id, auto_confirm_bookings, auto_confirm_changed_at, auto_confirm_changed_by_label)
             values ($1, false, now(), 'test')`,
                [clinic.clinicId],
              ),
            );
          },
        ],
        [
          "offboarding",
          async (clinic) => {
            await getMigratorPool().query(
              `update clinics set offboarding_started_at = now() where id = $1`,
              [clinic.clinicId],
            );
          },
        ],
      ];
      for (const [label, breakIt] of refusals) {
        const clinic = await seedClinic(`claim-no-${refusals.findIndex(([l]) => l === label)}`);
        await seedWritableCalendar(clinic);
        const holdId = await asApp(clinic.clinicId, (c) =>
          insertHold(c, clinic.clinicId, { holder: "voice:a", startsAt: base }),
        );
        await breakIt(clinic);
        await expect(
          asApp(clinic.clinicId, (c) => claimForWriting(c, holdId)),
          label,
        ).rejects.toMatchObject({
          code: "23514",
          message: expect.stringMatching(/no longer let the assistant write/),
        });
      }

      // Terms that never write: a one-way booking system elects `not_used`.
      const manual = await seedClinic("claim-manual");
      await seedWritableCalendar(manual, { bookingSystem: "mindbody" });
      const manualHold = await asApp(manual.clinicId, (c) =>
        insertHold(c, manual.clinicId, { holder: "voice:a", startsAt: base }),
      );
      await expect(
        asApp(manual.clinicId, (c) => claimForWriting(c, manualHold)),
      ).rejects.toMatchObject({
        code: "23514",
      });
    },
    SLOW,
  );

  test(
    "Auto-confirm off stops the assistant's write, never a staff confirmation's",
    async () => {
      const clinic = await seedClinic("claim-autoconfirm");
      await seedWritableCalendar(clinic);
      await asApp(clinic.clinicId, (c) =>
        c.query(
          `insert into clinic_settings (clinic_id, auto_confirm_bookings, auto_confirm_changed_at, auto_confirm_changed_by_label)
         values ($1, false, now(), 'test')`,
          [clinic.clinicId],
        ),
      );
      const answers = await asApp(clinic.clinicId, async (c) => {
        const { rows } = await c.query<{ assistant: boolean; desk: boolean }>(
          `select app_calendar_write_permitted($1, true) as assistant, app_calendar_write_permitted($1, false) as desk`,
          [clinic.clinicId],
        );
        return rows[0]!;
      });
      expect(answers).toEqual({ assistant: false, desk: true });
    },
    SLOW,
  );

  test(
    "the transition takes the calendar lock: a claim racing an overlapping hold never leaves two live",
    async () => {
      const clinic = await seedClinic("claim-lock");
      await seedWritableCalendar(clinic);
      const { clinicId } = clinic;
      const base = futureBase(20);
      // A hold with twenty seconds to live: room for both writers to queue
      // on a loaded runner before it lapses.
      const holdId = await asApp(clinicId, (c) =>
        insertHold(c, clinicId, { holder: "voice:a", startsAt: base, placedSecondsAgo: 40 }),
      );
      const lockKey = `hashtextextended('healdesk:calendar-time:' || $1::text, 0)`;
      /** Sessions queued on this clinic's calendar lock (pg_locks splits the key in two). */
      const waiting = async (): Promise<number> => {
        const { rows } = await getMigratorPool().query<{ n: number }>(
          `select count(*)::int as n from pg_locks
            where locktype = 'advisory' and not granted and objsubid = 1
              and ((classid::bigint << 32) | objid::bigint) = ${lockKey}`,
          [clinicId],
        );
        return rows[0]!.n;
      };
      const holdIsLive = async (): Promise<boolean> => {
        const { rows } = await inTenant(clinicId, (client) =>
          client.query<{ live: boolean }>(
            `select expires_at > clock_timestamp() as live from slot_holds where id = $1`,
            [holdId],
          ),
        );
        return rows[0]!.live;
      };

      // Someone else holds the clinic's calendar lock while both writers start:
      // the claim (no app-level lock, only the trigger's) and another caller's
      // overlapping hold.
      const blocker = await getAppPool().connect();
      let released = false;
      try {
        await blocker.query("begin");
        await blocker.query(`select pg_advisory_xact_lock(${lockKey})`, [clinicId]);
        const claim = asApp(clinicId, (c) => claimForWriting(c, holdId));
        const rival = asApp(clinicId, (c) =>
          insertHold(c, clinicId, { holder: "voice:b", startsAt: at(base, 10) }),
        );
        claim.catch(() => {});
        rival.catch(() => {});

        // Both queue on the lock, whatever the runner's speed: a claim that
        // skipped it would already have finished, and never be counted here.
        let queued = 0;
        for (let i = 0; i < 100 && queued < 2; i += 1) {
          queued = await waiting();
          if (queued < 2) await sleep(100);
        }
        expect(queued, "the claim and the rival both wait on the calendar lock").toBe(2);
        // The claim reached the lock while the hold was live, so only a check
        // made after the lock is granted can refuse it.
        expect(await holdIsLive()).toBe(true);

        // Then the hold lapses while they wait.
        for (let i = 0; i < 400 && (await holdIsLive()); i += 1) await sleep(100);
        expect(await holdIsLive()).toBe(false);
        await blocker.query("commit");
        released = true;

        const [claimed, held] = await Promise.allSettled([claim, rival]);
        // The claim judged expiry after the lock, by the database clock, so it lost.
        expect(claimed.status).toBe("rejected");
        expect((claimed as PromiseRejectedResult).reason).toMatchObject({
          code: "23514",
          message: expect.stringMatching(/lapsed/),
        });
        expect(held.status).toBe("fulfilled");
        expect(await liveHoldsOver(clinicId, base, 40)).toBe(1);
      } finally {
        if (!released) await blocker.query("rollback").catch(() => {});
        blocker.release();
      }
    },
    // It waits out the hold's own clock.
    2 * SLOW,
  );

  test(
    "a writing hold blocks until blocks_until and then stops, with no sweeper",
    async () => {
      const clinic = await seedClinic("claim-blocks");
      await seedWritableCalendar(clinic);
      const { clinicId } = clinic;
      const base = futureBase(21);

      const live = await asApp(clinicId, (c) =>
        insertHold(c, clinicId, { holder: "voice:a", startsAt: base }),
      );
      await asApp(clinicId, (c) => claimForWriting(c, live));
      await expect(
        asApp(clinicId, (c) => insertHold(c, clinicId, { holder: "voice:b", startsAt: base })),
      ).rejects.toMatchObject({ code: "23P01" });

      // A write whose blocking window has passed (as if the attempt were 15
      // minutes old) holds nothing, though nobody has resolved it.
      const stale = await asApp(clinicId, (c) =>
        insertHold(c, clinicId, { holder: "voice:c", startsAt: at(base, 120) }),
      );
      await asApp(clinicId, (c) => claimForWriting(c, stale, { blocksForSeconds: -1 }));
      await asApp(clinicId, (c) =>
        insertHold(c, clinicId, { holder: "voice:d", startsAt: at(base, 120) }),
      );
    },
    SLOW,
  );

  test(
    "held -> reserved names the request and blocks a day at most, then stops blocking",
    async () => {
      const { clinicId } = await seedClinic("reserve");
      const contactId = await seedContact(clinicId, "+15550100106");
      const base = futureBase(22);
      const reserve = (holdId: string, requestId: string | null, minutes: number) =>
        asApp(clinicId, (c) =>
          c.query(
            `update slot_holds
              set status = 'reserved', booking_request_id = $2,
                  blocks_until = clock_timestamp() + make_interval(mins => $3::int), updated_at = now()
            where id = $1`,
            [holdId, requestId, minutes],
          ),
        );

      const first = await asApp(clinicId, (c) =>
        insertHold(c, clinicId, { holder: "voice:a", startsAt: base }),
      );
      // No request to confirm: no reservation.
      await expect(reserve(first, null, 60)).rejects.toMatchObject({ code: "23514" });
      const requestId = await asApp(clinicId, (c) => insertBookingRequest(c, clinicId, contactId));
      // More than a day: no.
      await expect(reserve(first, requestId, 1445)).rejects.toMatchObject({ code: "23514" });
      await reserve(first, requestId, 60);
      await expect(
        asApp(clinicId, (c) => insertHold(c, clinicId, { holder: "voice:b", startsAt: base })),
      ).rejects.toMatchObject({ code: "23P01" });

      // A reservation whose window has passed blocks nothing, with no sweeper.
      const second = await asApp(clinicId, (c) =>
        insertHold(c, clinicId, { holder: "voice:c", startsAt: at(base, 180) }),
      );
      const otherRequest = await asApp(clinicId, (c) =>
        insertBookingRequest(c, clinicId, contactId),
      );
      await reserve(second, otherRequest, -1);
      await asApp(clinicId, (c) =>
        insertHold(c, clinicId, { holder: "voice:d", startsAt: at(base, 180) }),
      );
    },
    SLOW,
  );

  test(
    "only the listed transitions happen, and a final state is final",
    async () => {
      const clinic = await seedClinic("transitions");
      await seedWritableCalendar(clinic);
      const { clinicId } = clinic;
      const base = futureBase(23);
      const setStatus = (id: string, status: string, extra = "") =>
        asApp(clinicId, (c) =>
          c.query(`update slot_holds set status = $2${extra}, updated_at = now() where id = $1`, [
            id,
            status,
          ]),
        );

      const a = await asApp(clinicId, (c) =>
        insertHold(c, clinicId, { holder: "voice:a", startsAt: base }),
      );
      await expect(setStatus(a, "converted")).rejects.toMatchObject({ code: "42501" });
      await expect(setStatus(a, "unknown")).rejects.toMatchObject({ code: "42501" });
      await setStatus(a, "released", ", outcome_reason = 'superseded', released_at = now()");
      await expect(setStatus(a, "held")).rejects.toMatchObject({ code: "42501" });
      await expect(
        asApp(clinicId, (c) =>
          c.query(`update slot_holds set outcome_reason = 'slot_taken' where id = $1`, [a]),
        ),
      ).rejects.toMatchObject({ code: "42501" });

      const b = await asApp(clinicId, (c) =>
        insertHold(c, clinicId, { holder: "voice:b", startsAt: at(base, 60) }),
      );
      await asApp(clinicId, (c) => claimForWriting(c, b));
      await expect(setStatus(b, "reserved")).rejects.toMatchObject({ code: "42501" });
      await expect(setStatus(b, "expired")).rejects.toMatchObject({ code: "42501" });
      // unknown needs its next read-back time.
      await expect(setStatus(b, "unknown")).rejects.toMatchObject({ code: "23514" });
      await setStatus(b, "unknown", ", next_check_at = clock_timestamp() + interval '2 minutes'");
      await expect(setStatus(b, "writing")).rejects.toMatchObject({ code: "42501" });
      // Backing off is a plain update of an unknown hold.
      await asApp(clinicId, (c) =>
        c.query(
          `update slot_holds set next_check_at = clock_timestamp() + interval '5 minutes', check_attempts = 1 where id = $1`,
          [b],
        ),
      );
      await setStatus(b, "converted");
      await expect(setStatus(b, "released")).rejects.toMatchObject({ code: "42501" });

      // held -> expired, and nothing after.
      const d = await asApp(clinicId, (c) =>
        insertHold(c, clinicId, { holder: "voice:d", startsAt: at(base, 180) }),
      );
      await setStatus(d, "expired");
      await expect(setStatus(d, "released")).rejects.toMatchObject({ code: "42501" });
    },
    SLOW,
  );

  test(
    "a hold that still blocks is released, never deleted; a spent one is purged",
    async () => {
      const clinic = await seedClinic("hold-delete");
      await seedWritableCalendar(clinic);
      const { clinicId } = clinic;
      const contactId = await seedContact(clinicId, "+15550100108");
      const base = futureBase(28);
      const remove = (id: string) =>
        asApp(clinicId, async (c) => {
          const result = await c.query(`delete from slot_holds where id = $1`, [id]);
          return result.rowCount;
        });
      const blocking = {
        code: "42501",
        message: expect.stringMatching(/released, never deleted/),
      };

      // Each state that blocks, while its clock runs: held...
      const held = await asApp(clinicId, (c) =>
        insertHold(c, clinicId, { holder: "voice:a", startsAt: base }),
      );
      await expect(remove(held)).rejects.toMatchObject(blocking);
      // (the owner too, whom no grant stops)
      await expect(
        inTenant(clinicId, (client) =>
          client.query(`delete from slot_holds where id = $1`, [held]),
        ),
      ).rejects.toMatchObject(blocking);

      // ...writing, whose Google insert may still land...
      const writing = await asApp(clinicId, (c) =>
        insertHold(c, clinicId, { holder: "voice:b", startsAt: at(base, 60) }),
      );
      await asApp(clinicId, (c) => claimForWriting(c, writing));
      await expect(remove(writing)).rejects.toMatchObject(blocking);
      // ...so its time stays taken.
      await expect(
        asApp(clinicId, (c) =>
          insertHold(c, clinicId, { holder: "voice:c", startsAt: at(base, 60) }),
        ),
      ).rejects.toMatchObject({ code: "23P01" });

      // ...unknown, waiting to be read back...
      const unknown = await asApp(clinicId, (c) =>
        insertHold(c, clinicId, { holder: "voice:d", startsAt: at(base, 120) }),
      );
      await asApp(clinicId, (c) => claimForWriting(c, unknown));
      await asApp(clinicId, (c) =>
        c.query(
          `update slot_holds set status = 'unknown', next_check_at = clock_timestamp() + interval '2 minutes'
            where id = $1`,
          [unknown],
        ),
      );
      await expect(remove(unknown)).rejects.toMatchObject(blocking);

      // ...and reserved for a deposit.
      const reserved = await asApp(clinicId, (c) =>
        insertHold(c, clinicId, { holder: "voice:e", startsAt: at(base, 180), contactId }),
      );
      const requestId = await asApp(clinicId, (c) => insertBookingRequest(c, clinicId, contactId));
      await asApp(clinicId, (c) =>
        c.query(
          `update slot_holds
              set status = 'reserved', booking_request_id = $2,
                  blocks_until = clock_timestamp() + interval '1 hour', updated_at = now()
            where id = $1`,
          [reserved, requestId],
        ),
      );
      await expect(remove(reserved)).rejects.toMatchObject(blocking);

      // Spent, it is purged: released, lapsed, or a write whose window passed.
      await asApp(clinicId, (c) =>
        c.query(
          `update slot_holds set status = 'released', outcome_reason = 'superseded',
                                 released_at = now(), updated_at = now() where id = $1`,
          [held],
        ),
      );
      expect(await remove(held)).toBe(1);
      const lapsed = await asApp(clinicId, (c) =>
        insertHold(c, clinicId, {
          holder: "voice:f",
          startsAt: at(base, 240),
          placedSecondsAgo: 90,
        }),
      );
      expect(await remove(lapsed)).toBe(1);
      const stale = await asApp(clinicId, (c) =>
        insertHold(c, clinicId, { holder: "voice:g", startsAt: at(base, 300) }),
      );
      await asApp(clinicId, (c) => claimForWriting(c, stale, { blocksForSeconds: -1 }));
      expect(await remove(stale)).toBe(1);
    },
    SLOW,
  );

  test(
    "who holds what and when never changes, and the claim's fields are written once",
    async () => {
      const clinic = await seedClinic("frozen");
      await seedWritableCalendar(clinic);
      const { clinicId } = clinic;
      const base = futureBase(24);
      const id = await asApp(clinicId, (c) =>
        insertHold(c, clinicId, { holder: "voice:a", startsAt: base }),
      );

      // The runtime role has no UPDATE on these columns at all...
      for (const assignment of [
        `starts_at = starts_at + interval '15 minutes'`,
        `expires_at = expires_at + interval '1 minute'`,
        `holder_ref = repeat('f', 64)`,
        `clinic_id = clinic_id`,
      ]) {
        await expect(
          asApp(clinicId, (c) =>
            c.query(`update slot_holds set ${assignment} where id = $1`, [id]),
          ),
          assignment,
        ).rejects.toMatchObject({ code: "42501" });
      }
      // ...and the trigger refuses the owner the same.
      await expect(
        inTenant(clinicId, (client) =>
          client.query(
            `update slot_holds set starts_at = starts_at + interval '15 minutes',
                                 ends_at = ends_at + interval '15 minutes' where id = $1`,
            [id],
          ),
        ),
      ).rejects.toMatchObject({ code: "42501" });

      // A held hold cannot be given a blocking window or a lease without the claim.
      await expect(
        asApp(clinicId, (c) =>
          c.query(
            `update slot_holds set blocks_until = clock_timestamp() + interval '1 hour' where id = $1`,
            [id],
          ),
        ),
      ).rejects.toMatchObject({ code: "42501" });

      await asApp(clinicId, (c) => claimForWriting(c, id));
      for (const assignment of [
        `lease_token = gen_random_uuid()`,
        `blocks_until = blocks_until + interval '1 hour'`,
        `insert_attempted_at = clock_timestamp()`,
      ]) {
        await expect(
          asApp(clinicId, (c) =>
            c.query(`update slot_holds set ${assignment} where id = $1`, [id]),
          ),
          assignment,
        ).rejects.toMatchObject({ code: "42501" });
      }
      // The lease itself may be renewed.
      await asApp(clinicId, (c) =>
        c.query(
          `update slot_holds set lease_until = clock_timestamp() + interval '30 seconds' where id = $1`,
          [id],
        ),
      );
    },
    SLOW,
  );

  test(
    "the foreign keys go to NULL in any state, and a converted hold names its appointment exactly once",
    async () => {
      const clinic = await seedClinic("hold-fks");
      await seedWritableCalendar(clinic);
      const { clinicId } = clinic;
      const contactId = await seedContact(clinicId, "+15550100107");
      const base = futureBase(25);

      // A held hold cannot name an appointment.
      const held = await asApp(clinicId, (c) =>
        insertHold(c, clinicId, { holder: "voice:a", startsAt: base, contactId }),
      );
      const vendorAppointment = await asApp(clinicId, (c) =>
        insertAppointment(c, clinicId, contactId, { at: at(base, 600) }),
      );
      await expect(
        asApp(clinicId, (c) =>
          c.query(`update slot_holds set appointment_id = $2 where id = $1`, [
            held,
            vendorAppointment,
          ]),
        ),
      ).rejects.toMatchObject({ code: "42501" });

      // Converted: one appointment, once.
      const converted = await asApp(clinicId, (c) =>
        insertHold(c, clinicId, { holder: "voice:b", startsAt: at(base, 60), contactId }),
      );
      await asApp(clinicId, (c) => claimForWriting(c, converted));
      await asApp(clinicId, (c) =>
        c.query(`update slot_holds set status = 'converted', updated_at = now() where id = $1`, [
          converted,
        ]),
      );
      const first = await asApp(clinicId, (c) =>
        insertAppointment(c, clinicId, contactId, { at: at(base, 60), origin: "assistant" }),
      );
      await asApp(clinicId, (c) =>
        c.query(`update slot_holds set appointment_id = $2 where id = $1`, [converted, first]),
      );
      await expect(
        asApp(clinicId, (c) =>
          c.query(`update slot_holds set appointment_id = $2 where id = $1`, [
            converted,
            vendorAppointment,
          ]),
        ),
      ).rejects.toMatchObject({ code: "42501" });

      // Erasing the person nulls the holds' contact, whatever their state, and
      // the appointment's deletion nulls the converted hold's link.
      await asApp(clinicId, (c) =>
        c.query(`delete from appointments where contact_id = $1`, [contactId]),
      );
      await asApp(clinicId, (c) => c.query(`delete from contacts where id = $1`, [contactId]));
      const { rows } = await inTenant(clinicId, (client) =>
        client.query<{
          id: string;
          status: string;
          contact_id: string | null;
          appointment_id: string | null;
        }>(
          `select id, status, contact_id, appointment_id from slot_holds where id = any($1::uuid[]) order by starts_at`,
          [[held, converted]],
        ),
      );
      expect(rows).toEqual([
        { id: held, status: "held", contact_id: null, appointment_id: null },
        { id: converted, status: "converted", contact_id: null, appointment_id: null },
      ]);
    },
    SLOW,
  );

  /* ------------------------------------------------------- tenancy, gate */

  test(
    "one clinic's holds are invisible from another's tenant and cannot be written into it",
    async () => {
      const a = await seedClinic("holds-iso-a");
      const b = await seedClinic("holds-iso-b");
      const base = futureBase(26);
      const holdId = await asApp(a.clinicId, (c) =>
        insertHold(c, a.clinicId, { holder: "voice:a", startsAt: base }),
      );

      await asApp(b.clinicId, async (c) => {
        const { rows } = await c.query(`select id from slot_holds where id = $1`, [holdId]);
        expect(rows).toEqual([]);
        const updated = await c.query(`update slot_holds set status = 'released' where id = $1`, [
          holdId,
        ]);
        expect(updated.rowCount).toBe(0);
      });
      // Writing a hold for clinic A from B's tenant fails the policy, not the overlap check.
      await expect(
        asApp(b.clinicId, (c) =>
          insertHold(c, a.clinicId, { holder: "voice:b", startsAt: at(base, 60) }),
        ),
      ).rejects.toMatchObject({ code: "42501" });
      // And B's own calendar is its own: the same time is free there.
      await asApp(b.clinicId, (c) =>
        insertHold(c, b.clinicId, { holder: "voice:a", startsAt: base }),
      );
    },
    SLOW,
  );

  test(
    "the BAA gate refuses a hold for a production clinic without an agreement",
    async () => {
      const { clinicId } = await seedClinic("hold-gate");
      // Only the owner can flip the class; a production clinic with no signed
      // agreement is exactly the state the gate exists for.
      await getMigratorPool().query(
        `update clinics set data_classification = 'production' where id = $1`,
        [clinicId],
      );
      await expect(
        asApp(clinicId, (c) =>
          insertHold(c, clinicId, { holder: "voice:a", startsAt: futureBase(27) }),
        ),
      ).rejects.toMatchObject({
        code: "23514",
        message: expect.stringMatching(/refusing to write PHI to slot_holds/),
      });
    },
    SLOW,
  );

  test(
    "a connection the terms do not name never makes the write permission true",
    async () => {
      // A personal account under personal terms writes; a Workspace account
      // under personal terms does not (plan §4.11's mismatch rows).
      const personal = await seedClinic("perm-personal");
      const seeded = await seedWritableCalendar(personal, { calendarAccount: "personal" });
      expect(seeded.agreement.termsKind).toBe("uncovered");
      const permitted = (clinicId: string) =>
        asApp(clinicId, async (c) => {
          const { rows } = await c.query<{ ok: boolean }>(
            `select app_calendar_write_permitted($1, true) as ok`,
            [clinicId],
          );
          return rows[0]!.ok;
        });
      expect(await permitted(personal.clinicId)).toBe(true);

      await inTenant(personal.clinicId, (client) =>
        client.query(
          `update provider_connections set metadata = jsonb_set(metadata, '{managed}', 'true') where clinic_id = $1`,
          [personal.clinicId],
        ),
      );
      expect(await permitted(personal.clinicId)).toBe(false);

      // A connection that is revoked, or still pending, or none at all: no.
      const revoked = await seedClinic("perm-revoked");
      await seedWritableCalendar(revoked);
      await inTenant(revoked.clinicId, (client) =>
        client.query(`update provider_connections set status = 'revoked' where clinic_id = $1`, [
          revoked.clinicId,
        ]),
      );
      expect(await permitted(revoked.clinicId)).toBe(false);

      const pending = await seedClinic("perm-pending");
      await recordAgreementElection(pending.clinicId, await bindCalendarAgreement(pending));
      expect(await permitted(pending.clinicId)).toBe(false);
      await insertGoogleConnection(pending.clinicId, { managed: true, status: "pending" });
      expect(await permitted(pending.clinicId)).toBe(false);
      // The same terms with the connection active: yes. The control that makes
      // the two falses above about the connection, not the terms.
      await inTenant(pending.clinicId, (client) =>
        client.query(`update provider_connections set status = 'active' where clinic_id = $1`, [
          pending.clinicId,
        ]),
      );
      expect(await permitted(pending.clinicId)).toBe(true);

      // Outside a tenant the function sees nothing and answers false, never NULL.
      const { rows } = await getAppPool().query<{ ok: boolean }>(
        `select app_calendar_write_permitted($1, true) as ok`,
        [personal.clinicId],
      );
      expect(rows[0]!.ok).toBe(false);
    },
    SLOW,
  );
});
