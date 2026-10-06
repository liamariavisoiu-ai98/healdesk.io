import { randomBytes, randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { closePools, getAppPool, getMigratorPool, hasTestDatabase, runMigrations, truncateAll } from "./setup/db";
import { inTenant, seedClinic, seedContact, seedConversation } from "./setup/factories";

/**
 * The booking_requests transition table (drizzle/0040, §A.13 of the design
 * of 23 September 2026), asserted pair by pair.
 *
 * The trigger is the authority on what a request may become and which of its
 * columns may ever move; the column-scoped grant is the authority on what the
 * runtime role may even try. Both are tested here as the application would
 * meet them — as the runtime role, inside a declared tenant — and the frozen
 * columns are additionally tested as the table owner, so that the freeze is
 * shown to be the trigger's doing and not merely the grant's.
 */

const describeDb = hasTestDatabase ? describe : describe.skip;
const DAY = 24 * 60 * 60 * 1000;

type Status = "requested" | "accepted" | "rescheduling" | "confirmed" | "declined" | "expired";
const STATUSES: readonly Status[] = ["requested", "accepted", "rescheduling", "confirmed", "declined", "expired"];
const TERMINAL: readonly Status[] = ["confirmed", "declined", "expired"];

/** A.13, verbatim. Everything not listed here must raise 42501. */
const PERMITTED: Record<Status, readonly Status[]> = {
  requested: ["accepted", "rescheduling", "confirmed", "declined", "expired"],
  accepted: ["rescheduling", "confirmed", "expired"],
  rescheduling: ["confirmed", "declined", "expired"],
  confirmed: [],
  declined: [],
  expired: [],
};

const PAIRS = STATUSES.flatMap((from) => STATUSES.filter((to) => to !== from).map((to) => [from, to] as const));

const SLOT = (n: number) => ({ at: new Date(Date.now() + n * DAY).toISOString(), label: `Slot ${n}`, source: "desk" as const });

type Client = {
  query: <T = Record<string, unknown>>(text: string, values?: unknown[]) => Promise<{ rows: T[] }>;
};

/** One statement as the runtime role inside a declared tenant, always rolled back. */
async function asTenant<T>(clinicId: string, fn: (c: Client) => Promise<T>): Promise<T> {
  const client = await getAppPool().connect();
  try {
    await client.query("begin");
    await client.query(`select set_config('app.clinic_id', $1, true)`, [clinicId]);
    return await fn(client as unknown as Client);
  } finally {
    await client.query("rollback").catch(() => {});
    client.release();
  }
}

type Fixture = { clinicId: string; contactId: string; appointmentId: string; conversationId: string };

async function fixture(label: string): Promise<Fixture> {
  const { clinicId } = await seedClinic(label);
  const contactId = await seedContact(clinicId, "+15550104040");
  const seeded = await seedConversation(clinicId, { startedAt: new Date(), booked: true, contactId });
  return { clinicId, contactId, appointmentId: seeded.appointmentId!, conversationId: seeded.conversationId };
}

/**
 * A request in a given status, inserted as the owner. The trigger is BEFORE
 * UPDATE only, so any shape the CHECKs accept can be inserted directly —
 * which is exactly how a direct booking lands (tested below as the app role).
 */
async function seedRequest(
  f: Fixture,
  status: Status,
  overrides: Partial<{ conversationId: string | null; proposedSlots: unknown[]; vendorCallId: string | null }> = {},
): Promise<string> {
  const terminal = TERMINAL.includes(status);
  const rescheduling = status === "rescheduling";
  return inTenant(f.clinicId, async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `insert into booking_requests
         (clinic_id, contact_id, channel, preferred_window, alternative_windows, status, token_hash, expires_at,
          decided_at, confirmed_for, appointment_id, proposed_slots, reschedule_expires_at, conversation_id, vendor_call_id)
       values ($1, $2, 'voice', 'weekday mornings', '{"Thursday after 4"}', $3, $4, now() + interval '7 days',
               $5, $6, $7, $8::jsonb, $9, $10, $11)
       returning id`,
      [
        f.clinicId,
        f.contactId,
        status,
        randomBytes(32),
        terminal ? new Date() : null,
        status === "confirmed" ? new Date(Date.now() + 3 * DAY) : null,
        status === "confirmed" ? f.appointmentId : null,
        JSON.stringify(overrides.proposedSlots ?? (rescheduling ? [SLOT(2), SLOT(3)] : [])),
        rescheduling ? new Date(Date.now() + DAY) : null,
        overrides.conversationId ?? null,
        overrides.vendorCallId ?? null,
      ],
    );
    return rows[0]!.id;
  });
}

/** The UPDATE the application would issue to move a request to `to`, shaped so only the trigger can refuse it. */
function transition(to: Status, f: Fixture): { text: string; values: unknown[] } {
  if (to === "confirmed") {
    return {
      text: `update booking_requests set status = 'confirmed', decided_at = now(), confirmed_for = $2, appointment_id = $3 where id = $1`,
      values: [new Date(Date.now() + 3 * DAY), f.appointmentId],
    };
  }
  if (to === "rescheduling") {
    return {
      text: `update booking_requests set status = 'rescheduling', proposed_slots = $2::jsonb, reschedule_expires_at = now() + interval '1 day',
               confirmed_for = null, appointment_id = null where id = $1`,
      values: [JSON.stringify([SLOT(2)])],
    };
  }
  return {
    text: `update booking_requests set status = $2, decided_at = now(), confirmed_for = null, appointment_id = null where id = $1`,
    values: [to],
  };
}

describeDb("booking_requests transitions (0040)", () => {
  let f: Fixture;

  beforeAll(async () => {
    await runMigrations();
    await truncateAll();
    f = await fixture("transitions");
  }, 60_000);

  afterAll(async () => {
    await closePools();
  });

  test("the table is exhaustive: 30 ordered pairs, 11 permitted", () => {
    expect(PAIRS).toHaveLength(30);
    expect(Object.values(PERMITTED).flat()).toHaveLength(11);
  });

  test.each(PAIRS)("%s -> %s", async (from, to) => {
    const id = await seedRequest(f, from);
    const { text, values } = transition(to, f);
    const attempt = asTenant(f.clinicId, (c) => c.query(text, [id, ...values]));
    if (PERMITTED[from].includes(to)) {
      await expect(attempt).resolves.toBeTruthy();
    } else {
      await expect(attempt).rejects.toMatchObject({ code: "42501", message: expect.stringMatching(/not a permitted transition/) });
    }
  });

  test("rescheduling needs at least one proposed slot and a deadline, by CHECK", async () => {
    const id = await seedRequest(f, "requested");
    await expect(
      asTenant(f.clinicId, (c) => c.query(`update booking_requests set status = 'rescheduling' where id = $1`, [id])),
    ).rejects.toMatchObject({ code: "23514", constraint: "booking_requests_rescheduling_shape" });
    await expect(
      asTenant(f.clinicId, (c) =>
        c.query(`update booking_requests set status = 'rescheduling', proposed_slots = $2::jsonb where id = $1`, [id, JSON.stringify([SLOT(1)])]),
      ),
    ).rejects.toMatchObject({ code: "23514", constraint: "booking_requests_rescheduling_shape" });
    await expect(
      asTenant(f.clinicId, (c) =>
        c.query(`update booking_requests set status = 'rescheduling', reschedule_expires_at = now() + interval '1 day' where id = $1`, [id]),
      ),
    ).rejects.toMatchObject({ code: "23514", constraint: "booking_requests_rescheduling_shape" });
    // Four slots is one too many.
    await expect(
      asTenant(f.clinicId, (c) =>
        c.query(
          `update booking_requests set status = 'rescheduling', proposed_slots = $2::jsonb, reschedule_expires_at = now() + interval '1 day' where id = $1`,
          [id, JSON.stringify([SLOT(1), SLOT(2), SLOT(3), SLOT(4)])],
        ),
      ),
    ).rejects.toMatchObject({ code: "23514", constraint: "booking_requests_proposed_slots_max_three" });
  });

  test("proposed_slots may be replaced while rescheduling and are frozen once terminal", async () => {
    const open = await seedRequest(f, "rescheduling");
    const replaced = await asTenant(f.clinicId, (c) =>
      c.query<{ n: number }>(
        `update booking_requests set proposed_slots = $2::jsonb, reschedule_expires_at = now() + interval '2 days' where id = $1 returning jsonb_array_length(proposed_slots)::int as n`,
        [open, JSON.stringify([SLOT(4), SLOT(5), SLOT(6)])],
      ),
    );
    expect(replaced.rows[0]!.n).toBe(3);

    for (const status of TERMINAL) {
      const id = await seedRequest(f, status);
      await expect(
        asTenant(f.clinicId, (c) => c.query(`update booking_requests set proposed_slots = $2::jsonb where id = $1`, [id, JSON.stringify([SLOT(1)])])),
      ).rejects.toMatchObject({ code: "42501", message: expect.stringMatching(/frozen/) });
    }
  });

  test("the decision-side set moves while open and not once terminal", async () => {
    const open = await seedRequest(f, "accepted");
    await expect(
      asTenant(f.clinicId, (c) =>
        c.query(
          `update booking_requests
              set collected_fields = '{"service":"consultation"}'::jsonb,
                  last_inbound_at = now()
            where id = $1`,
          [open],
        ),
      ),
    ).resolves.toBeTruthy();

    const done = await seedRequest(f, "declined");
    for (const set of [
      `collected_fields = '{"service":"consultation"}'::jsonb`,
      `last_inbound_at = now()`,
      `reschedule_expires_at = now()`,
    ]) {
      await expect(
        asTenant(f.clinicId, (c) => c.query(`update booking_requests set ${set} where id = $1`, [done])),
      ).rejects.toMatchObject({ code: "42501", message: expect.stringMatching(/frozen/) });
    }
  });

  test("the facts of the request never move, even for the table owner", async () => {
    const id = await seedRequest(f, "requested", { vendorCallId: "call_frozen_1" });
    // The owner is bound by the trigger like everyone else; this shows the
    // freeze is the trigger's, not only the grant's.
    for (const set of [
      `expires_at = now() + interval '30 days'`,
      `token_hash = decode(repeat('ab', 32), 'hex')`,
      `preferred_window = 'any time at all'`,
      `alternative_windows = '{}'`,
      `booked_via = 'agent_direct'`,
      `vendor_call_id = 'call_frozen_2'`,
      `treatment = 'botox'`,
      `channel = 'meta', platform = 'messenger', external_id = 'p', sender_id = 's'`,
    ]) {
      await expect(
        inTenant(f.clinicId, (c) => c.query(`update booking_requests set ${set} where id = $1`, [id])),
      ).rejects.toMatchObject({ code: "42501", message: expect.stringMatching(/only the decision columns may change/) });
    }
  });

  test("conversation_id is set exactly once from null, and never changed after", async () => {
    const unlinked = await seedRequest(f, "requested");
    await expect(
      asTenant(f.clinicId, (c) => c.query(`update booking_requests set conversation_id = $2 where id = $1`, [unlinked, f.conversationId])),
    ).resolves.toBeTruthy();

    const linked = await seedRequest(f, "requested", { conversationId: f.conversationId });
    const other = await seedConversation(f.clinicId, { startedAt: new Date(), contactId: f.contactId });
    await expect(
      asTenant(f.clinicId, (c) => c.query(`update booking_requests set conversation_id = $2 where id = $1`, [linked, other.conversationId])),
    ).rejects.toMatchObject({ code: "42501", message: expect.stringMatching(/only the decision columns may change/) });
    // The foreign key's ON DELETE SET NULL must still be able to pass.
    await expect(
      asTenant(f.clinicId, (c) => c.query(`update booking_requests set conversation_id = null where id = $1`, [linked])),
    ).resolves.toBeTruthy();
  });

  test("desk_notified_at is a delivery stamp and is updatable on a terminal row", async () => {
    for (const status of TERMINAL) {
      const id = await seedRequest(f, status);
      const { rows } = await asTenant(f.clinicId, (c) =>
        c.query<{ desk_notified_at: Date | null }>(`update booking_requests set desk_notified_at = now() where id = $1 returning desk_notified_at`, [id]),
      );
      expect(rows[0]!.desk_notified_at).not.toBeNull();
    }
  });

  test("confirmed_shape holds: confirmed means a slot and an appointment, never one without the other", async () => {
    const id = await seedRequest(f, "requested");
    await expect(
      asTenant(f.clinicId, (c) => c.query(`update booking_requests set status = 'confirmed', decided_at = now(), confirmed_for = now() + interval '1 day' where id = $1`, [id])),
    ).rejects.toMatchObject({ code: "23514", constraint: "booking_requests_confirmed_shape" });
    await expect(
      asTenant(f.clinicId, (c) => c.query(`update booking_requests set status = 'confirmed', decided_at = now(), appointment_id = $2 where id = $1`, [id, f.appointmentId])),
    ).rejects.toMatchObject({ code: "23514", constraint: "booking_requests_confirmed_shape" });
    await expect(
      asTenant(f.clinicId, (c) => c.query(`update booking_requests set confirmed_for = now() + interval '1 day', appointment_id = $2 where id = $1`, [id, f.appointmentId])),
    ).rejects.toMatchObject({ code: "23514", constraint: "booking_requests_confirmed_shape" });
  });

  test("the grant: the runtime role may UPDATE exactly the decision columns, and preferred_window is refused before the trigger", async () => {
    const { rows } = await getMigratorPool().query<{ attname: string }>(`
      select a.attname
        from pg_attribute a
       where a.attrelid = 'booking_requests'::regclass and a.attnum > 0 and not a.attisdropped
         and has_column_privilege('healdesk_app'::name, a.attrelid, a.attnum, 'UPDATE')
       order by a.attname
    `);
    expect(rows.map((r) => r.attname)).toEqual(
      [
        "status", "desk_notified_at", "decided_at", "decided_by_label", "desk_note", "confirmed_for", "appointment_id",
        "conversation_id", "proposed_slots", "reschedule_expires_at", "collected_fields", "last_inbound_at",
      ].sort(),
    );

    const id = await seedRequest(f, "requested");
    await expect(
      asTenant(f.clinicId, (c) => c.query(`update booking_requests set preferred_window = 'whenever' where id = $1`, [id])),
    ).rejects.toMatchObject({ code: "42501", message: expect.stringMatching(/permission denied/) });
    await expect(asTenant(f.clinicId, (c) => c.query(`delete from booking_requests where id = $1`, [id]))).rejects.toMatchObject({
      code: "42501",
    });
  });

  test("a direct booking INSERTs a confirmed row as the runtime role, idempotent on the vendor call id", async () => {
    const vendorCallId = `call_${randomUUID()}`;
    const inserted = await asTenant(f.clinicId, async (c) => {
      const { rows: appt } = await c.query<{ id: string }>(
        `insert into appointments (clinic_id, contact_id, scheduled_for) values ($1, $2, now() + interval '2 days') returning id`,
        [f.clinicId, f.contactId],
      );
      const { rows } = await c.query<{ id: string; status: string; booked_via: string }>(
        `insert into booking_requests
           (clinic_id, contact_id, channel, preferred_window, status, token_hash, expires_at,
            decided_at, decided_by_label, confirmed_for, appointment_id, booked_via, vendor_call_id, conversation_id)
         values ($1, $2, 'voice', 'Tuesday 2pm', 'confirmed', $3, now() + interval '7 days',
                 now(), 'AYA (direct booking)', now() + interval '2 days', $4, 'agent_direct', $5, $6)
         returning id, status, booked_via`,
        [f.clinicId, f.contactId, randomBytes(32), appt[0]!.id, vendorCallId, f.conversationId],
      );
      // Same call id again, same clinic: the partial unique index refuses.
      await expect(
        c.query(
          `insert into booking_requests
             (clinic_id, contact_id, channel, preferred_window, status, token_hash, expires_at, booked_via, vendor_call_id)
           values ($1, $2, 'voice', 'Tuesday 2pm', 'requested', $3, now() + interval '7 days', 'agent_direct', $4)`,
          [f.clinicId, f.contactId, randomBytes(32), vendorCallId],
        ),
      ).rejects.toMatchObject({ code: "23505", constraint: "booking_requests_vendor_call_idx" });
      return rows[0]!;
    });
    expect(inserted).toMatchObject({ status: "confirmed", booked_via: "agent_direct" });
  });

  test("a third alternative window and an unknown provenance are refused at insert", async () => {
    await expect(
      inTenant(f.clinicId, (c) =>
        c.query(
          `insert into booking_requests (clinic_id, contact_id, channel, preferred_window, alternative_windows, token_hash, expires_at)
           values ($1, $2, 'voice', 'mornings', '{"a","b","c"}', $3, now() + interval '7 days')`,
          [f.clinicId, f.contactId, randomBytes(32)],
        ),
      ),
    ).rejects.toMatchObject({ code: "23514", constraint: "booking_requests_alternatives_max_two" });
    await expect(
      inTenant(f.clinicId, (c) =>
        c.query(
          `insert into booking_requests (clinic_id, contact_id, channel, preferred_window, booked_via, token_hash, expires_at)
           values ($1, $2, 'voice', 'mornings', 'robot', $3, now() + interval '7 days')`,
          [f.clinicId, f.contactId, randomBytes(32)],
        ),
      ),
    ).rejects.toMatchObject({ code: "23514", constraint: "booking_requests_booked_via_known" });
    // drizzle/0041: healdesk places no calls, so 'callback' is no longer a provenance.
    await expect(
      inTenant(f.clinicId, (c) =>
        c.query(
          `insert into booking_requests (clinic_id, contact_id, channel, preferred_window, booked_via, token_hash, expires_at)
           values ($1, $2, 'voice', 'mornings', 'callback', $3, now() + interval '7 days')`,
          [f.clinicId, f.contactId, randomBytes(32)],
        ),
      ),
    ).rejects.toMatchObject({ code: "23514", constraint: "booking_requests_booked_via_known" });
  });
});
