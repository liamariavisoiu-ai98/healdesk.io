import { createHash, createHmac, hkdfSync } from "node:crypto";

import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";

import { clearHoldsForErasure, holderRefOf, holdSpan } from "@/lib/booking/holds";
import { IDENTIFIER_REF_HKDF_INFO, identifierRef } from "@/lib/identifier-ref";
import { withTenant } from "@/lib/tenant";

import {
  asApp,
  at,
  claimForWriting,
  futureBase,
  insertBookingRequest,
  insertHold,
  seedWritableCalendar,
} from "./setup/calendar-db";
import { closePools, hasTestDatabase, runMigrations, truncateAll } from "./setup/db";
import { inTenant, seedClinic, seedContact } from "./setup/factories";

/**
 * Who holds a time (slot_holds.holder_ref) and how an erasure clears it.
 *
 * A holder reference stood in for its holder key as a plain sha256, which is
 * read back by hashing every candidate: a key built from a phone number or a
 * WhatsApp sender id gives the number away to anyone with a copy of the
 * table. So it is identifierRef's keyed HMAC now, and these tests pin that it
 * is keyed, bound to the clinic, and built as documented. The erasure half
 * pins clearHoldsForErasure, the call the funnel's erasePerson makes inside
 * its own transaction: every hold of the person goes, keyed or written before
 * refs were keyed, found by reference or through their contact, including a
 * hold that still blocks (which the delete guard would refuse to delete
 * unreleased); nobody else's goes; and it commits or rolls back with the
 * caller. Everything is synthetic.
 */

const CLINIC = "0c1d2e3f-0000-4000-8000-000000000000";
const OTHER_CLINIC = "9a8b7c6d-1111-4222-8333-444455556666";
const HOLDER = "retell:call_0001";

const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("holder references (holderRefOf)", () => {
  test("are 64 hex characters, the same for the same holder, and never the plain sha256 of the key", () => {
    const ref = holderRefOf(CLINIC, HOLDER);
    expect(ref).toMatch(/^[0-9a-f]{64}$/);
    expect(holderRefOf(CLINIC, HOLDER)).toBe(ref);
    expect(holderRefOf(CLINIC, "retell:call_0002")).not.toBe(ref);
    expect(ref).not.toBe(sha256(HOLDER));
    expect(holderRefOf(CLINIC, "+15550100123")).not.toBe(sha256("+15550100123"));
  });

  test("depend on the key: the same holder under another key is another reference", () => {
    const underDevelopmentKey = holderRefOf(CLINIC, HOLDER);
    vi.stubEnv("HEALDESK_IDENTIFIER_REF_KEY", "another-key-entirely-for-this-test-000000");
    const underAnotherKey = holderRefOf(CLINIC, HOLDER);
    expect(underAnotherKey).toMatch(/^[0-9a-f]{64}$/);
    expect(underAnotherKey).not.toBe(underDevelopmentKey);
  });

  test("are bound to the clinic: one clinic's references say nothing about another's", () => {
    expect(holderRefOf(OTHER_CLINIC, HOLDER)).not.toBe(holderRefOf(CLINIC, HOLDER));
  });

  test("are identifierRef's slot_holder reference without its prefix, built as documented", () => {
    const secret = "a-test-key-that-is-long-enough-to-pass-0000";
    vi.stubEnv("HEALDESK_IDENTIFIER_REF_KEY", secret);
    const key = Buffer.from(
      hkdfSync("sha256", secret, Buffer.alloc(0), IDENTIFIER_REF_HKDF_INFO, 32),
    );
    const expected = createHmac("sha256", key)
      .update(`slot_holder\u0000${CLINIC}\u0000${HOLDER}`, "utf8")
      .digest("hex");
    expect(holderRefOf(CLINIC, HOLDER)).toBe(expected);
    expect(identifierRef("slot_holder", CLINIC, HOLDER)).toBe(`v1:${expected}`);
  });
});

const describeDb = hasTestDatabase ? describe : describe.skip;

/** Each test seeds clinics and holds over many round trips; a loaded runner needs room. */
const SLOW = 60_000;

const ACTOR = { type: "service", serviceName: "test" } as const;

/** The person being erased, and their thread reference as the Meta path makes it. */
const PHONE = "+15550100123";
const threadRefAt = (clinicId: string) =>
  identifierRef("chat_party", clinicId, "whatsapp:15550100123");

function erase(clinicId: string, person: { phones: string[]; threadRefs: string[] }) {
  return withTenant({ clinicId, actor: ACTOR }, (tx) => clearHoldsForErasure(tx, person));
}

/** A hold through the engine's own path, so its reference is the one holderRefOf makes. */
async function held(
  clinicId: string,
  holderKey: string,
  startsAt: Date,
  contactId: string | null = null,
): Promise<string> {
  const placed = await holdSpan(clinicId, {
    channel: "voice",
    holderKey,
    calendarId: "primary",
    startsAt,
    minutes: 30,
    contactId,
  });
  if (placed.kind !== "held") throw new Error(`hold not placed: ${placed.kind}`);
  return placed.holdId;
}

async function holdsAt(clinicId: string): Promise<{ id: string; status: string }[]> {
  return inTenant(clinicId, async (client) => {
    const { rows } = await client.query<{ id: string; status: string }>(
      `select id, status from slot_holds where clinic_id = $1 order by created_at`,
      [clinicId],
    );
    return rows;
  });
}

async function exists(clinicId: string, table: string, id: string): Promise<boolean> {
  return inTenant(clinicId, async (client) => {
    const { rows } = await client.query(`select 1 from ${table} where id = $1`, [id]);
    return rows.length === 1;
  });
}

describeDb("clearHoldsForErasure", () => {
  beforeAll(async () => {
    await runMigrations();
    await truncateAll();
  }, 60_000);

  afterAll(async () => {
    await closePools();
  });

  test(
    "deletes the person's holds by number and by thread reference, keyed and legacy, live ones included, and nobody else's",
    async () => {
      const { clinicId } = await seedClinic("erase-refs");
      const other = await seedClinic("erase-refs-other");
      const threadRef = threadRefAt(clinicId);
      const base = futureBase(20);

      // Theirs: two under keyed references, both still blocking; two
      // written before references were keyed, one lapsed and one live.
      await held(clinicId, PHONE, base);
      await held(clinicId, threadRef, at(base, 60));
      await asApp(clinicId, (c) =>
        insertHold(c, clinicId, { holder: PHONE, startsAt: at(base, 120), placedSecondsAgo: 90 }),
      );
      await asApp(clinicId, (c) =>
        insertHold(c, clinicId, { holder: threadRef, startsAt: at(base, 180) }),
      );
      // Not theirs: another caller, a legacy holder, and the same number at another clinic.
      const someoneElse = await held(clinicId, "+15550100999", at(base, 240));
      const legacyOther = await asApp(clinicId, (c) =>
        insertHold(c, clinicId, { holder: "voice:someone-else", startsAt: at(base, 300) }),
      );
      const elsewhere = await held(other.clinicId, PHONE, base);

      expect(await erase(clinicId, { phones: [PHONE], threadRefs: [threadRef] })).toBe(4);

      expect((await holdsAt(clinicId)).map((h) => h.id).sort()).toEqual(
        [someoneElse, legacyOther].sort(),
      );
      expect((await holdsAt(other.clinicId)).map((h) => h.id)).toEqual([elsewhere]);
      // The live holds were let go before they were deleted, so their time is free.
      await held(clinicId, "retell:next", base);
      // And a second erasure finds nothing left.
      expect(await erase(clinicId, { phones: [PHONE], threadRefs: [threadRef] })).toBe(0);
    },
    SLOW,
  );

  test(
    "deletes holds linked to the person's contacts, whatever the holder: its own contact, its request's, its appointment's; a write in flight is let go first",
    async () => {
      const clinic = await seedClinic("erase-links");
      await seedWritableCalendar(clinic);
      const { clinicId } = clinic;
      const theirs = await seedContact(clinicId, PHONE);
      const notTheirs = await seedContact(clinicId, "+15550100998");
      const base = futureBase(21);

      // The hold's own contact, mid-write: it blocks for fifteen minutes.
      const writing = await held(clinicId, "retell:call_a", base, theirs);
      await asApp(clinicId, (c) => claimForWriting(c, writing));

      // Through their request: a deposit reservation, blocking for an hour.
      const requestId = await asApp(clinicId, (c) => insertBookingRequest(c, clinicId, theirs));
      const reserved = await held(clinicId, "retell:call_b", at(base, 60));
      await asApp(clinicId, (c) =>
        c.query(
          `update slot_holds set status = 'reserved', booking_request_id = $2,
                  blocks_until = clock_timestamp() + interval '1 hour', updated_at = now()
            where id = $1`,
          [reserved, requestId],
        ),
      );

      // Through the appointment it became.
      const converted = await held(clinicId, "retell:call_c", at(base, 120));
      await asApp(clinicId, (c) => claimForWriting(c, converted));
      const appointmentId = await asApp(clinicId, async (c) => {
        await c.query(
          `update slot_holds set status = 'converted', updated_at = now() where id = $1`,
          [converted],
        );
        const { rows } = await c.query<{ id: string }>(
          `insert into appointments (clinic_id, contact_id, scheduled_for, duration_minutes, status)
           values ($1, $2, $3, 30, 'scheduled') returning id`,
          [clinicId, theirs, at(base, 120)],
        );
        await c.query(`update slot_holds set appointment_id = $2 where id = $1`, [
          converted,
          rows[0]!.id,
        ]);
        return rows[0]!.id;
      });

      // Another person's hold stays.
      const othersHold = await held(clinicId, "retell:call_d", at(base, 180), notTheirs);

      expect(await erase(clinicId, { phones: [PHONE], threadRefs: [] })).toBe(3);
      expect((await holdsAt(clinicId)).map((h) => h.id)).toEqual([othersHold]);
      // The hold is gone, not what it pointed at: the request and the
      // appointment are the erasure's to delete (app_erase_contacts), and
      // nothing refers to a hold.
      expect(await exists(clinicId, "booking_requests", requestId)).toBe(true);
      expect(await exists(clinicId, "appointments", appointmentId)).toBe(true);
      // The write in flight no longer blocks its time.
      await held(clinicId, "retell:next", base);
    },
    SLOW,
  );

  test(
    "returns 0 with nothing to clear, and never throws for it",
    async () => {
      const { clinicId } = await seedClinic("erase-nothing");
      const kept = await held(clinicId, "retell:call_kept", futureBase(22));

      expect(await erase(clinicId, { phones: [], threadRefs: [] })).toBe(0);
      expect(await erase(clinicId, { phones: [""], threadRefs: [""] })).toBe(0);
      expect(
        await erase(clinicId, {
          phones: ["+15550100777"],
          threadRefs: [threadRefAt(clinicId)],
        }),
      ).toBe(0);
      expect((await holdsAt(clinicId)).map((h) => h.id)).toEqual([kept]);
    },
    SLOW,
  );

  test(
    "runs inside the caller's transaction and rolls back with it",
    async () => {
      const { clinicId } = await seedClinic("erase-rollback");
      const hold = await held(clinicId, PHONE, futureBase(23));

      await expect(
        withTenant({ clinicId, actor: ACTOR }, async (tx) => {
          expect(await clearHoldsForErasure(tx, { phones: [PHONE], threadRefs: [] })).toBe(1);
          throw new Error("the rest of the erasure failed");
        }),
      ).rejects.toThrow("the rest of the erasure failed");
      // Neither the release nor the delete happened.
      expect(await holdsAt(clinicId)).toEqual([{ id: hold, status: "held" }]);

      expect(await erase(clinicId, { phones: [PHONE], threadRefs: [] })).toBe(1);
      expect(await holdsAt(clinicId)).toEqual([]);
    },
    SLOW,
  );
});
