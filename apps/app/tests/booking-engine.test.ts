import { createHash, randomBytes, randomUUID } from "node:crypto";

import {
  googleEventIdFor,
  HEALDESK_EVENT_MARKER,
  setGoogleTimeouts,
  type FakeGoogleCalendar,
} from "@healdesk/connectors";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

import type { DepositFacts, DepositOutcome } from "@/lib/billing/deposits";

/**
 * The booking engine (plan §7.4-7.11, C13), called directly as the Retell
 * process will call it: holder "retell:" + call id, booking key
 * "retell:" + call id + ":" + n. Every Google call goes to the in-memory
 * fake. The clinic hears only through booking alerts (ids only), recorded
 * here as notifyBookingAlert receives them; the engine mails no desk link.
 * Everything synthetic.
 */

const state = vi.hoisted(() => ({
  alerts: [] as Array<{ clinicId: string; kind: string; ref: Record<string, unknown> }>,
  /** Per clinic: a deposit decision to give instead of D's (the reserve branch). */
  decide: new Map<string, (facts: DepositFacts) => DepositOutcome>(),
  /** Clinics whose booking mode reads as live whatever the facts say (a race with the claim). */
  forceLive: new Set<string>(),
  /** Per hold: how many of its record steps fail next with a database error the engine has no answer for. */
  failRecord: new Map<string, number>(),
  /** The locations this test made, whose unsettled writes are let go after it. */
  made: [] as string[],
}));
vi.mock("@/lib/notices/booking-alerts", () => ({
  notifyBookingAlert: async (
    tx: { clinicId: string },
    kind: string,
    ref: Record<string, unknown>,
  ) => {
    state.alerts.push({ clinicId: tx.clinicId, kind, ref });
  },
}));
vi.mock("@/lib/booking/deposit-gate", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/booking/deposit-gate")>();
  return {
    ...actual,
    depositGateFor: async (
      tx: import("@/lib/tenant").TenantTx,
      input: Parameters<typeof actual.depositGateFor>[1],
    ) => {
      const gate = await actual.depositGateFor(tx, input);
      const override = state.decide.get(tx.clinicId);
      if (!override) return gate;
      const outcome = override({} as DepositFacts);
      return { ...gate, outcome, branch: actual.depositBranch(outcome.action) };
    },
  };
});
vi.mock("@/lib/booking/mode", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/booking/mode")>();
  return {
    ...actual,
    bookingModeFor: async (tx: import("@/lib/tenant").TenantTx) => {
      const mode = await actual.bookingModeFor(tx);
      return state.forceLive.has(tx.clinicId)
        ? { ...mode, mode: "live" as const, canOfferTimes: true, reasons: [] }
        : mode;
    },
  };
});
vi.mock("@/lib/meta/booking-requests", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/meta/booking-requests")>();
  return {
    ...actual,
    recordAssistantWrite: async (...args: Parameters<typeof actual.recordAssistantWrite>) => {
      const left = state.failRecord.get(args[1]) ?? 0;
      if (left > 0) {
        state.failRecord.set(args[1], left - 1);
        throw new Error("synthetic database failure");
      }
      return actual.recordAssistantWrite(...args);
    },
  };
});

import type { AgentService, DepositPolicy } from "@/db/schema";
import { slotLabel } from "@/lib/booking/calendar";
import { bookConversation, logRequest, offerTimes, placeHold } from "@/lib/booking/engine";
import type { BookConversationInput } from "@/lib/booking/engine";
import { holderRefOf, releaseLiveHolds } from "@/lib/booking/holds";
import { bookingModeFor } from "@/lib/booking/mode";
import { sweepHolds, writeHeldBooking } from "@/lib/booking/writer";
import {
  createBookingRequest,
  decideBookingRequest,
  recordAssistantWrite,
} from "@/lib/meta/booking-requests";
import { approveAgentConfig, updateAgentConfig } from "@/lib/onboarding/agent-config";
import { withTenant } from "@/lib/tenant";
import { upsertCallerContact } from "@/lib/voice/ingest";
import { depositLine } from "@/lib/voice/tools";

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
  type DeskLocation,
} from "./setup/desk-calendar";
import { inTenant } from "./setup/factories";

const describeDb = hasTestDatabase ? describe : describe.skip;
const SLOW = 120_000;
const MIN = 60_000;
const ACTOR = { type: "service", serviceName: "test" } as const;
const PHONE = "+14155550188";
const LATE_LABEL = "assistant (calendar write confirmed after the call)";

describeDb("the booking engine (C13)", () => {
  let google: FakeGoogleCalendar;

  beforeAll(async () => {
    await runMigrations();
    await truncateAll();
    installGoogleEnv();
    process.env.BETTER_AUTH_URL = "https://app.healdesk.test";
  }, 60_000);

  beforeEach(() => {
    google = freshGoogle();
    state.alerts.length = 0;
    state.decide.clear();
    state.forceLive.clear();
    state.failRecord.clear();
    state.made.length = 0;
    process.env.HEALDESK_DIRECT_BOOKING_ENABLED = "true";
  });

  afterEach(async () => {
    setGoogleTimeouts(undefined);
    delete process.env.HEALDESK_DIRECT_BOOKING_ENABLED;
    // A write a test left unsettled would be read back by a later test's
    // sweep, against that test's Google: let it go here.
    for (const clinicId of state.made) {
      await inTenant(clinicId, (client) =>
        client.query(
          `update slot_holds set status = 'released', outcome_reason = 'test_done', released_at = clock_timestamp()
            where status in ('writing', 'unknown')`,
        ),
      );
    }
  });

  afterAll(async () => {
    restoreGoogleEnv();
    await closePools();
  });

  type Deposits = {
    enabled?: boolean;
    connected?: boolean;
    bookVoiceWithoutDeposit?: boolean;
    policy?: DepositPolicy | null;
    services?: AgentService[];
  };

  /** A live location: covered terms, a connected Google account, production, its script approved. */
  async function location(
    label: string,
    deposits?: Deposits,
    options: Parameters<typeof deskLocation>[2] = {},
  ): Promise<DeskLocation> {
    const f = await deskLocation(google, label, options);
    state.made.push(f.clinicId);
    await getMigratorPool().query(
      `update clinics set data_classification = 'production', baa_signed_at = now(), went_live_at = now() where id = $1`,
      [f.clinicId],
    );
    await withTenant({ clinicId: f.clinicId, actor: ACTOR }, async (tx) => {
      if (deposits) {
        await updateAgentConfig(tx, {
          greeting: "Hi",
          services: deposits.services ?? [
            { name: "Consultation", priceFromUsd: 0, priceToUsd: 0, durationMinutes: 30 },
          ],
          escalationPhone: null,
          escalationHours: null,
          notes: null,
          depositPolicy: deposits.policy ?? null,
        });
      }
      await approveAgentConfig(tx, "Dr Chen");
    });
    if (deposits) {
      if (deposits.connected !== false) {
        await getMigratorPool().query(
          `update clinics set stripe_connect_account_id = 'acct_1Engine', stripe_connect_connected_at = now() where id = $1`,
          [f.clinicId],
        );
      }
      await inTenant(f.clinicId, (client) =>
        client.query(
          `insert into clinic_settings (clinic_id, deposits_enabled, book_voice_without_deposit) values ($1, $2, $3)
           on conflict (clinic_id) do update set deposits_enabled = excluded.deposits_enabled,
             book_voice_without_deposit = excluded.book_voice_without_deposit`,
          [f.clinicId, deposits.enabled !== false, deposits.bookVoiceWithoutDeposit !== false],
        ),
      );
    }
    return f;
  }

  const book = (
    clinicId: string,
    call: string,
    at: Date,
    extra: Partial<BookConversationInput> = {},
  ) =>
    bookConversation(clinicId, {
      channel: "voice",
      holderKey: `retell:${call}`,
      bookingKey: `retell:${call}:1`,
      startsAt: at,
      firstName: "Ana",
      phoneE164: PHONE,
      service: "Consultation",
      budgetMs: 20_000,
      ...extra,
    });
  const hold = (
    clinicId: string,
    call: string,
    at: Date,
    service = "Consultation",
    providerId?: string,
  ) =>
    placeHold(clinicId, {
      channel: "voice",
      holderKey: `retell:${call}`,
      startsAt: at,
      service,
      providerId,
    });
  const inserts = () => google.requests.filter((r) => r.endpoint === "insert");
  const alertsOf = (clinicId: string) =>
    state.alerts.filter((a) => a.clinicId === clinicId).map(({ kind, ref }) => ({ kind, ref }));

  const rows = (clinicId: string) =>
    inTenant(clinicId, async (client) => ({
      appointments: (
        await client.query<{
          id: string;
          scheduled_for: Date;
          duration_minutes: number | null;
          treatment: string | null;
          booking_origin: string | null;
          calendar_write_status: string;
          calendar_event_key: string | null;
          calendar_id: string | null;
          deposit_status: string;
          deposit_usd: string | null;
        }>(
          `select id, scheduled_for, duration_minutes, treatment, booking_origin, calendar_write_status,
                  calendar_event_key, calendar_id, deposit_status, deposit_usd
             from appointments order by created_at`,
        )
      ).rows,
      requests: (
        await client.query<{
          id: string;
          status: string;
          booked_via: string;
          vendor_call_id: string | null;
          treatment: string | null;
          appointment_id: string | null;
          decided_by_label: string | null;
          desk_notified_at: Date | null;
        }>(
          `select id, status, booked_via, vendor_call_id, treatment, appointment_id, decided_by_label, desk_notified_at
             from booking_requests order by created_at`,
        )
      ).rows,
      holds: (
        await client.query<{
          id: string;
          status: string;
          starts_at: Date;
          duration_minutes: number;
          calendar_id: string;
          outcome_reason: string | null;
          appointment_id: string | null;
          booking_request_id: string | null;
          next_check_at: Date | null;
          check_attempts: number;
        }>(
          `select id, status, starts_at, duration_minutes, calendar_id, outcome_reason, appointment_id,
                  booking_request_id, next_check_at, check_attempts
             from slot_holds order by created_at`,
        )
      ).rows,
    }));

  const connectionBroken = (clinicId: string) =>
    inTenant(
      clinicId,
      async (client) =>
        (
          await client.query<{ broken: boolean }>(
            `select broken_at is not null as broken from provider_connections where provider = 'google_calendar'`,
          )
        ).rows[0]?.broken === true,
    );

  /**
   * Staff decide in the portal from the funnel's M5 (the design record's §9,
   * item 11); until then the desk path is reached by a request's token,
   * which the engine never mails. The test gives the request one.
   */
  async function deskToken(clinicId: string, requestId: string): Promise<string> {
    const token = randomBytes(32).toString("base64url");
    const hash = createHash("sha256").update(token, "utf8").digest();
    const ok = await inTenant(
      clinicId,
      async (client) =>
        (
          await client.query<{ ok: boolean }>(
            `select app_reissue_undelivered_booking_token($1, $2) as ok`,
            [requestId, hash],
          )
        ).rows[0]?.ok,
    );
    if (!ok) throw new Error("the request took no token");
    return token;
  }

  /**
   * The claim as the engine commits it (plan §7.7 step 6), for a write the
   * test then drives: a request booked `agent_direct` under `call`'s key and
   * its hold `writing` under a known lease.
   */
  async function claimed(
    f: DeskLocation,
    call: string,
    at: Date,
    options: { leaseSecondsLeft?: number; attemptedSecondsAgo?: number; service?: string } = {},
  ): Promise<{ holdId: string; lease: string; requestId: string }> {
    const placed = await hold(f.clinicId, call, at, options.service ?? "Consultation");
    if (placed.kind !== "held") throw new Error(`not held: ${placed.kind}`);
    const requestId = await withTenant({ clinicId: f.clinicId, actor: ACTOR }, async (tx) => {
      const contactId = await upsertCallerContact(tx.db, {
        clinicId: f.clinicId,
        phone: PHONE,
        name: "Ana",
        clinicTimezone: DESK_TZ,
      });
      const created = await createBookingRequest(tx, {
        channel: "voice",
        contactId,
        conversationId: null,
        preferredWindow: slotLabel(at, DESK_TZ),
        treatment: options.service ?? "Consultation",
        vendorCallId: `retell:${call}:1`,
        bookedVia: "agent_direct",
      });
      return created.id;
    });
    const lease = randomUUID();
    await inTenant(f.clinicId, (client) =>
      client.query(
        `update slot_holds set status = 'writing', booking_request_id = $2, lease_token = $3,
                lease_until = clock_timestamp() + make_interval(secs => $4::int),
                insert_attempted_at = clock_timestamp() - make_interval(secs => $5::int),
                blocks_until = clock_timestamp() + interval '15 minutes', updated_at = now()
          where id = $1`,
        [
          placed.holdId,
          requestId,
          lease,
          options.leaseSecondsLeft ?? 30,
          options.attemptedSecondsAgo ?? 0,
        ],
      ),
    );
    return { holdId: placed.holdId, lease, requestId };
  }

  const makeDue = (clinicId: string) =>
    inTenant(clinicId, (client) =>
      client.query(
        `update slot_holds set next_check_at = clock_timestamp() - interval '1 second' where status = 'unknown'`,
      ),
    );

  async function until(what: string, check: () => Promise<boolean>, tries = 80): Promise<void> {
    for (let i = 0; i < tries; i += 1) {
      if (await check()) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`timed out waiting for ${what}`);
  }

  /** Until `n` sessions wait on a lock, for ten seconds at most. */
  async function untilWaiting(n: number): Promise<void> {
    await until(
      `${n} waiters`,
      async () => {
        const { rows: found } = await getMigratorPool().query<{ n: number }>(
          `select count(*)::int as n from pg_locks where not granted and locktype = 'advisory'`,
        );
        return found[0]!.n >= n;
      },
      100,
    );
  }

  /** A named provider on `calendarId` who offers `serviceKey`, with the location booking by provider. */
  const namedProvider = (clinicId: string, calendarId: string, serviceKey: string, name: string) =>
    inTenant(clinicId, async (client) => {
      await client.query(
        `insert into clinic_settings (clinic_id, booking_detail) values ($1, 'named_provider')
         on conflict (clinic_id) do update set booking_detail = 'named_provider'`,
        [clinicId],
      );
      const { rows: created } = await client.query<{ id: string }>(
        `insert into clinic_providers (clinic_id, display_name, calendar_id) values ($1, $2, $3) returning id`,
        [clinicId, name, calendarId],
      );
      await client.query(
        `insert into clinic_provider_services (clinic_id, provider_id, service_key) values ($1, $2, $3)`,
        [clinicId, created[0]!.id, serviceKey],
      );
      return created[0]!.id;
    });

  test(
    "offer, hold, book: one event, one booking recorded as the assistant's, the hold converted and linked, the request confirmed, and no alert",
    async () => {
      const f = await location("eng-book");
      const at = deskTime(3, 10);
      const offered = await offerTimes(f.clinicId, {
        channel: "voice",
        holderKey: "retell:c1",
        service: "facial",
      });
      expect(offered).toMatchObject({
        status: "ok",
        timeZone: DESK_TZ,
        serviceMinutes: 60,
        canonicalService: "Facial",
      });
      expect(offered.status === "ok" && offered.slots).toContainEqual({ at, providerId: null });

      const held = await hold(f.clinicId, "c1", at, "facial");
      expect(held).toMatchObject({ kind: "held", startsAt: at, minutes: 60, providerId: null });

      const booked = await book(f.clinicId, "c1", at, {
        service: "facial",
        firstName: "Ana Maria",
      });
      expect(booked).toEqual({
        kind: "booked",
        startsAt: at,
        minutes: 60,
        canonicalService: "Facial",
        providerId: null,
        replayed: false,
        deposit: null,
      });

      const { appointments, requests, holds } = await rows(f.clinicId);
      expect(appointments).toHaveLength(1);
      const [appointment] = appointments;
      expect(appointment).toMatchObject({
        scheduled_for: at,
        duration_minutes: 60,
        treatment: "Facial",
        booking_origin: "assistant",
        calendar_write_status: "written",
        calendar_event_key: `hold:${held.kind === "held" ? held.holdId : ""}`,
        deposit_status: "none",
      });
      expect(requests).toEqual([
        expect.objectContaining({
          status: "confirmed",
          booked_via: "agent_direct",
          vendor_call_id: "retell:c1:1",
          treatment: "Facial",
          appointment_id: appointment!.id,
          decided_by_label: "assistant (direct booking)",
          // No desk email, and so no desk link, went anywhere.
          desk_notified_at: null,
        }),
      ]);
      expect(holds).toEqual([
        expect.objectContaining({
          status: "converted",
          appointment_id: appointment!.id,
          outcome_reason: "written",
        }),
      ]);

      // One event, a first name and the clinic's own name for the service.
      expect(inserts()).toHaveLength(1);
      const events = google.events(f.sub);
      expect(events).toHaveLength(1);
      expect(events[0]!.inserted).toMatchObject({ summary: "Ana – Facial" });
      expect(JSON.stringify(events[0]!.inserted)).not.toMatch(/Maria|555|0188/);

      // A booking the assistant made raises nothing (Annex X6).
      expect(alertsOf(f.clinicId)).toEqual([]);
    },
    SLOW,
  );

  test(
    "a booking made twice is one event, one after the other and at once",
    async () => {
      const f = await location("eng-twice");
      const first = deskTime(3, 11);
      expect((await book(f.clinicId, "c2", first)).kind).toBe("booked");
      const again = await book(f.clinicId, "c2", first);
      expect(again).toMatchObject({ kind: "booked", startsAt: first, replayed: true });
      expect(inserts()).toHaveLength(1);

      const second = deskTime(3, 14);
      const both = await Promise.all([
        book(f.clinicId, "c3", second),
        book(f.clinicId, "c3", second),
      ]);
      expect(both.map((b) => b.kind)).toEqual(["booked", "booked"]);
      expect(both.filter((b) => b.kind === "booked" && b.replayed)).toHaveLength(1);
      expect(inserts()).toHaveLength(2);
      const { appointments, requests } = await rows(f.clinicId);
      expect(appointments).toHaveLength(2);
      expect(requests.map((r) => r.vendor_call_id).sort()).toEqual(["retell:c2:1", "retell:c3:1"]);
      expect(alertsOf(f.clinicId)).toEqual([]);
    },
    SLOW,
  );

  test(
    "a hold at 10:00 and a booking at 11:00, or a 30-minute hold and a 60-minute service: a fresh hold, the old one let go",
    async () => {
      const f = await location("eng-moved");
      const ten = deskTime(4, 10);
      const eleven = deskTime(4, 11);
      const held = await hold(f.clinicId, "c4", ten);
      expect(await book(f.clinicId, "c4", eleven)).toMatchObject({
        kind: "booked",
        startsAt: eleven,
      });
      let { holds } = await rows(f.clinicId);
      expect(holds).toEqual([
        expect.objectContaining({
          starts_at: ten,
          status: "released",
          outcome_reason: "superseded",
        }),
        expect.objectContaining({ starts_at: eleven, status: "converted" }),
      ]);
      expect(holds[0]!.id).toBe(held.kind === "held" ? held.holdId : "");
      expect(google.events(f.sub).map((e) => e.start)).toEqual([eleven.toISOString()]);

      const noon = deskTime(4, 13);
      await hold(f.clinicId, "c5", noon, "Consultation");
      expect(await book(f.clinicId, "c5", noon, { service: "Facial" })).toMatchObject({
        kind: "booked",
        minutes: 60,
      });
      ({ holds } = await rows(f.clinicId));
      expect(holds.slice(2)).toEqual([
        expect.objectContaining({
          duration_minutes: 30,
          status: "released",
          outcome_reason: "superseded",
        }),
        expect.objectContaining({ duration_minutes: 60, status: "converted" }),
      ]);
    },
    SLOW,
  );

  test(
    "a hold that ran out: re-held when the time is still free, slot_taken when another caller has it, never a 23505",
    async () => {
      const f = await location("eng-expired");
      const lapsed = (holder: string, at: Date) =>
        inTenant(f.clinicId, (client) =>
          client.query(
            `insert into slot_holds (clinic_id, channel, holder_ref, calendar_id, starts_at, duration_minutes, ends_at,
                                     created_at, expires_at)
             values ($1, 'voice', $2, 'primary', $3::timestamptz, 30,
                     $3::timestamptz + interval '30 minutes', clock_timestamp() - interval '90 seconds',
                     clock_timestamp() - interval '30 seconds')`,
            [f.clinicId, holderRefOf(f.clinicId, holder), at],
          ),
        );
      const free = deskTime(5, 10);
      await lapsed("retell:c6", free);
      expect(await book(f.clinicId, "c6", free)).toMatchObject({ kind: "booked", startsAt: free });
      const { holds } = await rows(f.clinicId);
      expect(holds.map((h) => h.status)).toEqual(["expired", "converted"]);

      const taken = deskTime(5, 12);
      await lapsed("retell:c7", taken);
      expect((await hold(f.clinicId, "c8", taken)).kind).toBe("held");
      const refused = await book(f.clinicId, "c7", taken);
      expect(refused.kind).toBe("slot_taken");
      expect(refused.kind === "slot_taken" && refused.alternatives.length).toBe(3);
      expect(
        refused.kind === "slot_taken" &&
          refused.alternatives.every((a) => a.getTime() !== taken.getTime()),
      ).toBe(true);
    },
    SLOW,
  );

  test(
    "Google busy at the re-check: slot_taken with three nearest times, and the caller's hold let go",
    async () => {
      const f = await location("eng-busy");
      const at = deskTime(3, 15);
      await hold(f.clinicId, "c9", at);
      google.addBusy(f.sub, at, new Date(at.getTime() + 30 * MIN));
      const answer = await book(f.clinicId, "c9", at);
      expect(answer).toMatchObject({ kind: "slot_taken" });
      expect(answer.kind === "slot_taken" && answer.alternatives).toHaveLength(3);
      const { holds, requests } = await rows(f.clinicId);
      expect(holds).toEqual([
        expect.objectContaining({ status: "released", outcome_reason: "slot_taken" }),
      ]);
      expect(requests).toEqual([]);
      expect(inserts()).toHaveLength(0);
      expect(alertsOf(f.clinicId)).toEqual([]);
    },
    SLOW,
  );

  test(
    "a definitive no at the re-check: the connection broken (token erased, revoked), manual booking in the same turn, a request in the call with its one booking_request alert",
    async () => {
      const f = await location("eng-revoked");
      const at = deskTime(3, 9);
      await hold(f.clinicId, "c10", at);
      google.revokeRefreshToken(f.refreshToken);
      const answer = await book(f.clinicId, "c10", at);
      expect(answer).toMatchObject({ kind: "request_logged", reason: "calendar_broken" });

      const connection = await inTenant(f.clinicId, async (client) => {
        const { rows: found } = await client.query<{ status: string; broken: boolean }>(
          `select status, broken_at is not null as broken from provider_connections where provider = 'google_calendar'`,
        );
        return found[0];
      });
      expect(connection).toEqual({ status: "revoked", broken: true });
      const mode = await withTenant({ clinicId: f.clinicId, actor: ACTOR }, (tx) =>
        bookingModeFor(tx),
      );
      expect(mode.mode).toBe("manual");

      const { requests, holds, appointments } = await rows(f.clinicId);
      expect(appointments).toEqual([]);
      expect(requests).toEqual([
        expect.objectContaining({
          status: "requested",
          booked_via: "desk",
          vendor_call_id: "retell:c10:1",
          desk_notified_at: null,
        }),
      ]);
      expect(holds.every((h) => h.status === "released")).toBe(true);
      expect(inserts()).toHaveLength(0);
      expect(alertsOf(f.clinicId)).toEqual([
        { kind: "booking_request", ref: { bookingRequestId: requests[0]!.id } },
      ]);
    },
    SLOW,
  );

  test(
    "Google refusing the insert: the location's calendar forbidden breaks the connection, anything else is a refusal; either way the request is the desk's with booking_request alone",
    async () => {
      const f = await location("eng-insert-refused");
      google.failNext({ on: "insert", status: 400, reason: "badRequest" });
      expect(await book(f.clinicId, "c30", deskTime(3, 10))).toMatchObject({
        kind: "request_logged",
        reason: "write_refused",
      });
      expect(await connectionBroken(f.clinicId)).toBe(false);

      // The hold is let go, with its alert, before the break is recorded:
      // otherwise letting the location's holds go would take this one too
      // and tell the clinic to check a calendar nothing reached.
      google.failNext({ on: "insert", status: 403, reason: "forbidden" });
      expect(await book(f.clinicId, "c31", deskTime(3, 12))).toMatchObject({
        kind: "request_logged",
        reason: "calendar_broken",
      });
      expect(await connectionBroken(f.clinicId)).toBe(true);

      const { holds, requests, appointments } = await rows(f.clinicId);
      expect(appointments).toEqual([]);
      expect(holds.map((h) => [h.status, h.outcome_reason])).toEqual([
        ["released", "write_badrequest"],
        ["released", "calendar_broken"],
      ]);
      expect(alertsOf(f.clinicId)).toEqual(
        requests.map((r) => ({ kind: "booking_request", ref: { bookingRequestId: r.id } })),
      );
    },
    SLOW,
  );

  test(
    "a key used again for a different booking or request: key_reused, nothing written and no alert; a request asked for raises booking_request once",
    async () => {
      const f = await location("eng-reused");
      const at = deskTime(6, 10);
      await book(f.clinicId, "c11", at);
      const other = await book(f.clinicId, "c11", deskTime(6, 11));
      expect(other).toEqual({ kind: "key_reused", first: "booked", firstStartsAt: at });
      const otherService = await book(f.clinicId, "c11", at, { service: "Facial" });
      expect(otherService).toMatchObject({ kind: "key_reused", first: "booked" });
      expect(inserts()).toHaveLength(1);
      expect(alertsOf(f.clinicId)).toEqual([]);

      const request = {
        channel: "voice" as const,
        holderKey: "retell:c12",
        bookingKey: "retell:c12:1",
        firstName: "Ana",
        phoneE164: PHONE,
        preferredWindow: "Friday morning",
        alternativeWindows: ["Monday after 4"],
        service: "Consultation",
      };
      expect(await logRequest(f.clinicId, request)).toEqual({
        kind: "request_logged",
        replayed: false,
      });
      expect(await logRequest(f.clinicId, request)).toEqual({
        kind: "request_logged",
        replayed: true,
      });
      expect(
        await logRequest(f.clinicId, { ...request, preferredWindow: "Saturday evening" }),
      ).toEqual({ kind: "key_reused", first: "request_logged" });
      const { requests } = await rows(f.clinicId);
      const logged = requests.filter((r) => r.vendor_call_id === "retell:c12:1");
      expect(logged).toHaveLength(1);
      expect(alertsOf(f.clinicId)).toEqual([
        { kind: "booking_request", ref: { bookingRequestId: logged[0]!.id } },
      ]);
    },
    SLOW,
  );

  test(
    "an insert that times out: request_logged (unconfirmed), the hold unknown and calendar_check raised with it; the watch's read-back confirms it and raises nothing more",
    async () => {
      const f = await location("eng-timeout");
      const at = deskTime(3, 12);
      const late = google.insertThenHang({ land: "later" });
      setGoogleTimeouts({ insert: 150 });
      const answer = await book(f.clinicId, "c13", at);
      setGoogleTimeouts(undefined);
      expect(answer).toMatchObject({ kind: "request_logged", reason: "unconfirmed" });
      let { holds, requests } = await rows(f.clinicId);
      expect(holds).toEqual([expect.objectContaining({ status: "unknown" })]);
      expect(requests).toEqual([
        expect.objectContaining({ status: "requested", booked_via: "agent_direct" }),
      ]);
      expect(alertsOf(f.clinicId)).toEqual([
        { kind: "calendar_check", ref: { bookingRequestId: requests[0]!.id } },
      ]);

      late.land();
      await makeDue(f.clinicId);
      expect(await sweepHolds()).toMatchObject({ confirmed: 1, errors: 0 });
      ({ holds, requests } = await rows(f.clinicId));
      expect(holds).toEqual([
        expect.objectContaining({ status: "converted", outcome_reason: "written_late" }),
      ]);
      expect(requests).toEqual([
        expect.objectContaining({ status: "confirmed", decided_by_label: LATE_LABEL }),
      ]);
      expect(alertsOf(f.clinicId)).toHaveLength(1);
      expect(google.events(f.sub).filter((e) => e.status !== "cancelled")).toHaveLength(1);
    },
    SLOW,
  );

  test(
    "the budget runs out with the insert in flight: the caller hears a request, booking_request is raised once (a retry adds none), and the write that lands raises nothing and reads as booked after the call",
    async () => {
      const f = await location("eng-budget");
      const at = deskTime(3, 13);
      google.insertThenHang({ land: "now" });
      setGoogleTimeouts({ insert: 4000 });
      const answer = await book(f.clinicId, "c14", at, { budgetMs: 100 });
      expect(answer).toMatchObject({ kind: "request_logged", reason: "budget", replayed: false });
      let { holds, requests } = await rows(f.clinicId);
      const requestId = requests[0]!.id;
      expect(holds).toEqual([
        expect.objectContaining({ status: "writing", outcome_reason: "answered_as_request" }),
      ]);
      expect(alertsOf(f.clinicId)).toEqual([
        { kind: "booking_request", ref: { bookingRequestId: requestId } },
      ]);

      // A retry of the same tool call while the write is still out: the same
      // answer, and the alert is not raised twice.
      expect(await book(f.clinicId, "c14", at, { budgetMs: 100 })).toMatchObject({
        kind: "request_logged",
        reason: "budget",
        replayed: true,
      });
      expect(alertsOf(f.clinicId)).toHaveLength(1);

      await until(
        "the late write",
        async () => (await rows(f.clinicId)).holds[0]?.status === "converted",
        200,
      );
      ({ holds, requests } = await rows(f.clinicId));
      expect(holds).toEqual([
        expect.objectContaining({ status: "converted", outcome_reason: "written_late" }),
      ]);
      // Whoever calls the caller back sees it booked, after the call.
      expect(requests).toEqual([
        expect.objectContaining({
          id: requestId,
          status: "confirmed",
          decided_by_label: LATE_LABEL,
        }),
      ]);
      expect(alertsOf(f.clinicId)).toEqual([
        { kind: "booking_request", ref: { bookingRequestId: requestId } },
      ]);
      expect(google.events(f.sub)).toHaveLength(1);
      expect(await book(f.clinicId, "c14", at)).toMatchObject({ kind: "booked", replayed: true });
    },
    SLOW,
  );

  test(
    "the process dies after the claim: the watch lapses the write with calendar_check, reads it back and records it, raising nothing more",
    async () => {
      const f = await location("eng-death");
      const at = deskTime(3, 16);
      // The claim committed (request, writing, lease), then the process died:
      // the lease has run out.
      const c = await claimed(f, "c15", at, { leaseSecondsLeft: -1, attemptedSecondsAgo: 180 });
      google.addEvent(f.sub, {
        id: googleEventIdFor(`hold:${c.holdId}`),
        start: at,
        end: new Date(at.getTime() + 30 * MIN),
        privateProperties: { ...HEALDESK_EVENT_MARKER },
      });

      const swept = await sweepHolds();
      expect(swept).toMatchObject({ lapsed: 1, confirmed: 1, errors: 0 });
      const { holds, requests, appointments } = await rows(f.clinicId);
      expect(holds).toEqual([expect.objectContaining({ status: "converted" })]);
      expect(requests).toEqual([
        expect.objectContaining({
          id: c.requestId,
          status: "confirmed",
          appointment_id: appointments[0]!.id,
          decided_by_label: LATE_LABEL,
          desk_notified_at: null,
        }),
      ]);
      expect(alertsOf(f.clinicId)).toEqual([
        { kind: "calendar_check", ref: { bookingRequestId: c.requestId } },
      ]);
      expect(inserts()).toHaveLength(0);
    },
    SLOW,
  );

  test(
    "an assistant write found after its time was retaken: released (record_conflict) with calendar_check in the same step, never retried",
    async () => {
      const f = await location("eng-conflict");
      const at = deskTime(4, 15);
      // The assistant's write, unknown, its block lapsed (as C12's desk test).
      const first = await withTenant({ clinicId: f.clinicId, actor: ACTOR }, async (tx) => {
        const contactId = await upsertCallerContact(tx.db, {
          clinicId: f.clinicId,
          phone: PHONE,
          name: "Ana",
          clinicTimezone: DESK_TZ,
        });
        const created = await createBookingRequest(tx, {
          channel: "voice",
          contactId,
          conversationId: null,
          preferredWindow: slotLabel(at, DESK_TZ),
          treatment: "Consultation",
          vendorCallId: "retell:c16:1",
          bookedVia: "agent_direct",
        });
        return { requestId: created.id, contactId };
      });
      const holdId = await inTenant(f.clinicId, async (client) => {
        const { rows: inserted } = await client.query<{ id: string }>(
          `insert into slot_holds (clinic_id, channel, holder_ref, calendar_id, starts_at, duration_minutes, ends_at, contact_id)
           values ($1, 'voice', repeat('d', 64), 'primary', $2::timestamptz, 30, $2::timestamptz + interval '30 minutes', $3)
           returning id`,
          [f.clinicId, at, first.contactId],
        );
        const id = inserted[0]!.id;
        await client.query(
          `update slot_holds set status = 'writing', booking_request_id = $2, lease_token = gen_random_uuid(),
                  lease_until = clock_timestamp() + interval '30 seconds',
                  insert_attempted_at = clock_timestamp() - interval '20 minutes',
                  blocks_until = clock_timestamp() - interval '1 minute', updated_at = now()
            where id = $1`,
          [id, first.requestId],
        );
        await client.query(
          `update slot_holds set status = 'unknown', next_check_at = clock_timestamp() - interval '1 second' where id = $1`,
          [id],
        );
        return id;
      });
      google.addEvent(f.sub, {
        id: googleEventIdFor(`hold:${holdId}`),
        start: at,
        end: new Date(at.getTime() + 30 * MIN),
        privateProperties: { ...HEALDESK_EVENT_MARKER },
      });
      // Meanwhile staff confirmed someone else at that time.
      const other = await logRequest(f.clinicId, {
        channel: "voice",
        holderKey: "retell:c17",
        bookingKey: "retell:c17:1",
        firstName: "Ben",
        phoneE164: "+14155550177",
        preferredWindow: "that afternoon",
        service: "Consultation",
      });
      expect(other.kind).toBe("request_logged");
      const otherId = (await rows(f.clinicId)).requests.find(
        (r) => r.vendor_call_id === "retell:c17:1",
      )!.id;
      const decided = await decideBookingRequest(
        await deskToken(f.clinicId, otherId),
        "confirmed",
        {
          decidedByLabel: "Jo",
          deskNote: null,
          confirmedFor: at,
          addAnyway: true,
        },
      );
      expect(decided.outcome).toBe("decided");
      state.alerts.length = 0;
      const insertsBefore = inserts().length;

      await sweepHolds();
      const { holds } = await rows(f.clinicId);
      expect(holds.find((h) => h.id === holdId)).toMatchObject({
        status: "released",
        outcome_reason: "record_conflict",
        appointment_id: null,
      });
      expect(alertsOf(f.clinicId)).toEqual([
        { kind: "calendar_check", ref: { bookingRequestId: first.requestId } },
      ]);
      await sweepHolds();
      expect(inserts()).toHaveLength(insertsBefore);
      expect(alertsOf(f.clinicId)).toHaveLength(1);
    },
    SLOW,
  );

  test(
    "a lost lease: a writer holding another lease records nothing and asks Google nothing",
    async () => {
      const f = await location("eng-lease");
      const c = await claimed(f, "c18", deskTime(3, 17));
      expect(
        await writeHeldBooking(f.clinicId, c.holdId, randomUUID(), { firstName: "Ana" }),
      ).toEqual({ kind: "lost" });
      expect(
        await withTenant({ clinicId: f.clinicId, actor: ACTOR }, (tx) =>
          recordAssistantWrite(tx, c.holdId, "hd-synthetic", new Date(), { lease: randomUUID() }),
        ),
      ).toEqual({ kind: "settled" });
      expect(inserts()).toHaveLength(0);
      expect((await rows(f.clinicId)).holds).toEqual([
        expect.objectContaining({ status: "writing", outcome_reason: null }),
      ]);
      expect(alertsOf(f.clinicId)).toEqual([]);
    },
    SLOW,
  );

  test(
    "a writer that finishes after the watch took its lapsed hold: lost, nothing recorded and no alert of its own; the watch records it later",
    async () => {
      const f = await location("eng-lapsed-writer");
      const at = deskTime(3, 18);
      const c = await claimed(f, "c19", at);
      google.insertThenHang({ land: "now" });
      setGoogleTimeouts({ insert: 4000 });
      const writing = writeHeldBooking(f.clinicId, c.holdId, c.lease, { firstName: "Ana" });
      await until("the insert", async () => inserts().length === 1);
      // The writer hangs past its lease: the watch makes the hold unknown,
      // and tells the clinic to check its request.
      await inTenant(f.clinicId, (client) =>
        client.query(
          `update slot_holds set lease_until = clock_timestamp() - interval '1 second' where id = $1`,
          [c.holdId],
        ),
      );
      await sweepHolds();
      expect((await rows(f.clinicId)).holds).toEqual([
        expect.objectContaining({ status: "unknown" }),
      ]);
      expect(alertsOf(f.clinicId)).toEqual([
        { kind: "calendar_check", ref: { bookingRequestId: c.requestId } },
      ]);

      expect(await writing).toEqual({ kind: "lost" });
      let { holds, appointments } = await rows(f.clinicId);
      expect(holds).toEqual([expect.objectContaining({ status: "unknown" })]);
      expect(appointments).toEqual([]);
      expect(alertsOf(f.clinicId)).toHaveLength(1);

      await makeDue(f.clinicId);
      expect(await sweepHolds()).toMatchObject({ confirmed: 1 });
      ({ holds, appointments } = await rows(f.clinicId));
      expect(holds).toEqual([expect.objectContaining({ status: "converted" })]);
      expect(appointments).toHaveLength(1);
      expect(alertsOf(f.clinicId)).toHaveLength(1);
      expect(inserts()).toHaveLength(1);
    },
    SLOW,
  );

  test(
    "a writer whose hold the watch already recorded answers booked, with the deposit the watch recorded",
    async () => {
      const peel: AgentService = {
        name: "Chemical peel",
        priceFromUsd: 150,
        priceToUsd: 250,
        durationMinutes: 60,
        depositUsd: 75,
      };
      const f = await location("eng-converted-under", {
        services: [peel],
        policy: { required: true, amountUsd: 100, collection: "front_desk" },
      });
      const at = deskTime(3, 10);
      const c = await claimed(f, "c20", at, { service: "Chemical peel" });
      google.insertThenHang({ land: "now" });
      setGoogleTimeouts({ insert: 4000 });
      const writing = writeHeldBooking(f.clinicId, c.holdId, c.lease, { firstName: "Ana" });
      await until("the insert", async () => inserts().length === 1);
      await inTenant(f.clinicId, (client) =>
        client.query(
          `update slot_holds set lease_until = clock_timestamp() - interval '1 second' where id = $1`,
          [c.holdId],
        ),
      );
      await sweepHolds();
      await makeDue(f.clinicId);
      expect(await sweepHolds()).toMatchObject({ confirmed: 1 });

      expect(await writing).toMatchObject({
        kind: "booked",
        startsAt: at,
        minutes: 60,
        deposit: { action: "book_and_flag", amountUsd: 75 },
      });
      expect((await rows(f.clinicId)).appointments).toEqual([
        expect.objectContaining({ deposit_status: "pending_front_desk", deposit_usd: "75.00" }),
      ]);
    },
    SLOW,
  );

  test(
    "a write in flight when the location's holds are let go raises calendar_check for its request, in the same step; unknown, reserved and answered holds raise nothing more",
    async () => {
      const f = await location("eng-release-live");
      const flying = await claimed(f, "c21", deskTime(3, 10));
      const answered = await claimed(f, "c22", deskTime(3, 12));
      await inTenant(f.clinicId, (client) =>
        client.query(`update slot_holds set outcome_reason = 'answered_as_request' where id = $1`, [
          answered.holdId,
        ]),
      );
      const unknown = await claimed(f, "c23", deskTime(3, 14));
      await inTenant(f.clinicId, (client) =>
        client.query(
          `update slot_holds set status = 'unknown', next_check_at = clock_timestamp() + interval '2 minutes'
            where id = $1`,
          [unknown.holdId],
        ),
      );
      await hold(f.clinicId, "c24", deskTime(3, 16));

      const released = await withTenant({ clinicId: f.clinicId, actor: ACTOR }, (tx) =>
        releaseLiveHolds(tx, "calendar_broken"),
      );
      expect(released).toBe(4);
      expect((await rows(f.clinicId)).holds.every((h) => h.status === "released")).toBe(true);
      expect(alertsOf(f.clinicId)).toEqual([
        { kind: "calendar_check", ref: { bookingRequestId: flying.requestId } },
      ]);

      // The writer finds its hold gone: nothing reaches Google, nothing more is raised.
      expect(
        await writeHeldBooking(f.clinicId, flying.holdId, flying.lease, { firstName: "Ana" }),
      ).toEqual({ kind: "lost" });
      expect(inserts()).toHaveLength(0);
      expect(alertsOf(f.clinicId)).toHaveLength(1);
    },
    SLOW,
  );

  test(
    "the same caller cannot hold or book over its own unsettled write: in_progress, and the write that lands is recorded, not a conflict",
    async () => {
      const f = await location("eng-same-caller");
      const at = deskTime(3, 12);
      const late = google.insertThenHang({ land: "later" });
      setGoogleTimeouts({ insert: 150 });
      expect(await book(f.clinicId, "s1", at)).toMatchObject({
        kind: "request_logged",
        reason: "unconfirmed",
      });
      setGoogleTimeouts(undefined);

      expect(await hold(f.clinicId, "s1", at)).toEqual({ kind: "in_progress" });
      expect(await hold(f.clinicId, "s1", deskTime(3, 15))).toEqual({ kind: "in_progress" });
      expect(await book(f.clinicId, "s1", deskTime(3, 15), { bookingKey: "retell:s1:2" })).toEqual({
        kind: "in_progress",
      });

      late.land();
      await makeDue(f.clinicId);
      await sweepHolds();
      const { holds, requests, appointments } = await rows(f.clinicId);
      expect(holds).toEqual([expect.objectContaining({ status: "converted" })]);
      expect(requests).toEqual([expect.objectContaining({ status: "confirmed" })]);
      expect(appointments).toHaveLength(1);
      expect(google.events(f.sub)).toHaveLength(1);
      expect(alertsOf(f.clinicId).map((a) => a.kind)).toEqual(["calendar_check"]);
    },
    SLOW,
  );

  test(
    "the write permission lost between the mode and the claim (Auto-confirm off): the database refuses the claim, and a request is taken with its alert, nothing inserted",
    async () => {
      const f = await location("eng-23514");
      state.forceLive.add(f.clinicId);
      await inTenant(f.clinicId, (client) =>
        client.query(
          `insert into clinic_settings (clinic_id, auto_confirm_bookings) values ($1, false)
           on conflict (clinic_id) do update set auto_confirm_bookings = false`,
          [f.clinicId],
        ),
      );
      const answer = await book(f.clinicId, "c25", deskTime(3, 10));
      expect(answer).toMatchObject({ kind: "request_logged", reason: "calendar_not_permitted" });
      const { requests, holds } = await rows(f.clinicId);
      expect(requests).toEqual([
        expect.objectContaining({ status: "requested", vendor_call_id: "retell:c25:1" }),
      ]);
      expect(holds).toEqual([]);
      expect(inserts()).toHaveLength(0);
      expect(alertsOf(f.clinicId)).toEqual([
        { kind: "booking_request", ref: { bookingRequestId: requests[0]!.id } },
      ]);
    },
    SLOW,
  );

  test(
    "one caller's two bookings claimed at once under keys :1 and :2: one booked, one in_progress (the holder's one write in flight), one insert",
    async () => {
      const f = await location("eng-two-keys");
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      let locked!: () => void;
      const holding = new Promise<void>((resolve) => (locked = resolve));
      // Both pass the in-flight check and the re-check, then queue on the
      // calendar lock, so the second meets the first's write at the claim.
      const blocker = inTenant(f.clinicId, async (client) => {
        await client.query(
          `select pg_advisory_xact_lock(hashtextextended('healdesk:calendar-time:' || $1::text, 0))`,
          [f.clinicId],
        );
        locked();
        await gate;
      });
      await holding;
      const both = Promise.all([
        book(f.clinicId, "c26", deskTime(3, 10), { bookingKey: "retell:c26:1" }),
        book(f.clinicId, "c26", deskTime(3, 14), { bookingKey: "retell:c26:2" }),
      ]);
      await untilWaiting(2);
      release();
      await blocker;
      const answers = await both;
      expect(answers.map((a) => a.kind).sort()).toEqual(["booked", "in_progress"]);
      expect(inserts()).toHaveLength(1);
      const { requests, appointments } = await rows(f.clinicId);
      expect(requests).toHaveLength(1);
      expect(appointments).toHaveLength(1);
    },
    SLOW,
  );

  describe("named providers and HRC-04 at the write", () => {
    test(
      "a provider's time is offered, held and booked on that provider's calendar, and a booking that names nobody keeps the provider the caller held",
      async () => {
        const f = await location("eng-provider");
        const lee = google.addCalendar(f.sub, {
          summary: "Dr Lee",
          id: "lee-eng@group.calendar.fake.test",
        });
        const kim = google.addCalendar(f.sub, {
          summary: "Dr Kim",
          id: "kim-eng@group.calendar.fake.test",
        });
        const leeId = await namedProvider(f.clinicId, lee, "facial", "Dr Lee");
        const kimId = await namedProvider(f.clinicId, kim, "facial", "Dr Kim");
        const at = deskTime(3, 10);

        const offered = await offerTimes(f.clinicId, {
          channel: "voice",
          holderKey: "retell:p1",
          service: "Facial",
          providerId: kimId,
        });
        expect(offered.status === "ok" && offered.slots).toContainEqual({ at, providerId: kimId });
        const anyone = await offerTimes(f.clinicId, {
          channel: "voice",
          holderKey: "retell:p1",
          service: "Facial",
        });
        expect(anyone.status === "ok" && anyone.slots).toContainEqual({ at, providerId: leeId });

        const held = await hold(f.clinicId, "p1", at, "Facial", kimId);
        expect(held).toMatchObject({ kind: "held", providerId: kimId });
        // Dr Lee is free at that time too, and first in the clinic's list.
        const booked = await book(f.clinicId, "p1", at, { service: "Facial" });
        expect(booked).toMatchObject({ kind: "booked", startsAt: at, providerId: kimId });

        const { holds, appointments } = await rows(f.clinicId);
        expect(holds).toEqual([expect.objectContaining({ status: "converted", calendar_id: kim })]);
        expect(appointments).toEqual([expect.objectContaining({ calendar_id: kim })]);
        expect(google.events(f.sub, kim)).toHaveLength(1);
        expect(google.events(f.sub, lee)).toHaveLength(0);
        expect(await book(f.clinicId, "p1", at, { service: "Facial" })).toMatchObject({
          kind: "booked",
          replayed: true,
          providerId: kimId,
        });
      },
      SLOW,
    );

    test(
      "a covered location's provider calendar from outside its organisation is refused at the write: nothing inserted, the hold let go, the request the desk's",
      async () => {
        const f = await location("eng-hrc04");
        const outside = google.addCalendar(f.sub, {
          summary: "Dr Ray",
          id: "ray-elsewhere@group.calendar.fake.test",
          organization: "elsewhere.test",
        });
        const rayId = await namedProvider(f.clinicId, outside, "facial", "Dr Ray");
        const at = deskTime(3, 11);
        const answer = await book(f.clinicId, "p2", at, { service: "Facial", providerId: rayId });
        expect(answer).toMatchObject({ kind: "request_logged", reason: "write_refused" });
        const { holds, requests } = await rows(f.clinicId);
        expect(holds).toEqual([
          expect.objectContaining({
            status: "released",
            calendar_id: outside,
            outcome_reason: "write_target_outside_organisation",
          }),
        ]);
        expect(requests).toEqual([expect.objectContaining({ status: "requested" })]);
        expect(inserts()).toHaveLength(0);
        expect(await connectionBroken(f.clinicId)).toBe(false);
        expect(alertsOf(f.clinicId)).toEqual([
          { kind: "booking_request", ref: { bookingRequestId: requests[0]!.id } },
        ]);
      },
      SLOW,
    );

    test(
      "a provider's calendar answering 404 at the write sends that booking to the desk and leaves the location live",
      async () => {
        const f = await location("eng-provider-404");
        const lee = google.addCalendar(f.sub, {
          summary: "Dr Lee",
          id: "lee-404@group.calendar.fake.test",
        });
        const leeId = await namedProvider(f.clinicId, lee, "facial", "Dr Lee");
        google.failNext({ on: "insert", status: 404, reason: "notFound" });
        const answer = await book(f.clinicId, "p3", deskTime(3, 12), {
          service: "Facial",
          providerId: leeId,
        });
        expect(answer).toMatchObject({ kind: "request_logged", reason: "write_refused" });
        expect(await connectionBroken(f.clinicId)).toBe(false);
        const mode = await withTenant({ clinicId: f.clinicId, actor: ACTOR }, (tx) =>
          bookingModeFor(tx),
        );
        expect(mode.mode).toBe("live");
        const { holds, requests } = await rows(f.clinicId);
        expect(holds).toEqual([
          expect.objectContaining({
            status: "released",
            outcome_reason: "write_calendar_not_found",
          }),
        ]);
        expect(alertsOf(f.clinicId)).toEqual([
          { kind: "booking_request", ref: { bookingRequestId: requests[0]!.id } },
        ]);
      },
      SLOW,
    );
  });

  describe("the watch's settling of unknown writes", () => {
    test(
      "a finished hold whose request staff can still decide outlives the day's purge, so the desk's write keys on it and adopts the assistant's event",
      async () => {
        const f = await location("eng-purge");
        const at = deskTime(3, 10);
        const requestId = await withTenant({ clinicId: f.clinicId, actor: ACTOR }, async (tx) => {
          const contactId = await upsertCallerContact(tx.db, {
            clinicId: f.clinicId,
            phone: PHONE,
            name: "Ana",
            clinicTimezone: DESK_TZ,
          });
          const created = await createBookingRequest(tx, {
            channel: "voice",
            contactId,
            conversationId: null,
            preferredWindow: slotLabel(at, DESK_TZ),
            treatment: "Consultation",
            vendorCallId: "retell:c27:1",
            bookedVia: "agent_direct",
          });
          return created.id;
        });
        // Two holds finished more than a day ago: the assistant's for that
        // request (let go with its write in flight, the event landed after),
        // and one carrying nothing.
        const old = (holder: string, startsAt: Date, request: string | null) =>
          inTenant(f.clinicId, async (client) => {
            const { rows: made } = await client.query<{ id: string }>(
              `insert into slot_holds (clinic_id, channel, holder_ref, calendar_id, starts_at, duration_minutes, ends_at,
                                       created_at, expires_at)
               values ($1, 'voice', repeat($2, 64), 'primary', $3::timestamptz, 30,
                       $3::timestamptz + interval '30 minutes', clock_timestamp() - interval '2 days',
                       clock_timestamp() - interval '2 days' + interval '60 seconds')
               returning id`,
              [f.clinicId, holder, startsAt],
            );
            if (request) {
              await client.query(`update slot_holds set booking_request_id = $2 where id = $1`, [
                made[0]!.id,
                request,
              ]);
            }
            await client.query(`update slot_holds set status = 'released' where id = $1`, [
              made[0]!.id,
            ]);
            return made[0]!.id;
          });
        const keep = await old("e", at, requestId);
        const drop = await old("f", deskTime(3, 15), null);
        google.addEvent(f.sub, {
          id: googleEventIdFor(`hold:${keep}`),
          start: at,
          end: new Date(at.getTime() + 30 * MIN),
          privateProperties: { ...HEALDESK_EVENT_MARKER },
        });

        await sweepHolds();
        const ids = (await rows(f.clinicId)).holds.map((h) => h.id);
        expect(ids).toEqual([keep]);
        expect(ids).not.toContain(drop);

        // Staff confirm the request: the write goes under the hold's key and
        // meets the assistant's event there, one event in all.
        const decided = await decideBookingRequest(
          await deskToken(f.clinicId, requestId),
          "confirmed",
          { decidedByLabel: "Jo", deskNote: null, confirmedFor: at, addAnyway: true },
        );
        expect(decided).toMatchObject({ outcome: "decided", calendarWrite: "written" });
        expect((await rows(f.clinicId)).appointments).toEqual([
          expect.objectContaining({ calendar_event_key: `hold:${keep}` }),
        ]);
        expect(google.events(f.sub)).toHaveLength(1);
      },
      SLOW,
    );

    test(
      "with nowhere to read back from, an unknown write waits until its time instead of being given up, and is recorded once the calendar is back",
      async () => {
        const f = await location("eng-no-target");
        const at = deskTime(3, 11);
        const c = await claimed(f, "c28", at, { attemptedSecondsAgo: 180 });
        await inTenant(f.clinicId, (client) =>
          client.query(
            `update slot_holds set status = 'unknown', next_check_at = clock_timestamp() - interval '1 second'
              where id = $1`,
            [c.holdId],
          ),
        );
        google.addEvent(f.sub, {
          id: googleEventIdFor(`hold:${c.holdId}`),
          start: at,
          end: new Date(at.getTime() + 30 * MIN),
          privateProperties: { ...HEALDESK_EVENT_MARKER },
        });
        const saved = process.env.GOOGLE_OAUTH_CLIENT_ID;
        delete process.env.GOOGLE_OAUTH_CLIENT_ID;
        try {
          await sweepHolds();
        } finally {
          process.env.GOOGLE_OAUTH_CLIENT_ID = saved;
        }
        const [waiting] = (await rows(f.clinicId)).holds;
        expect(waiting).toMatchObject({ status: "unknown", check_attempts: 0 });
        expect(waiting!.next_check_at!.getTime()).toBeGreaterThan(Date.now());
        expect(waiting!.next_check_at!.getTime()).toBeLessThanOrEqual(at.getTime());

        await makeDue(f.clinicId);
        await sweepHolds();
        expect((await rows(f.clinicId)).holds).toEqual([
          expect.objectContaining({ status: "converted" }),
        ]);
        expect(alertsOf(f.clinicId)).toEqual([]);
      },
      SLOW,
    );

    test(
      "a record the database keeps refusing counts as a try, and once they are spent the write is given up with calendar_check, not read back for ever",
      async () => {
        const f = await location("eng-record-fails");
        const at = deskTime(3, 13);
        const c = await claimed(f, "c29", at, { attemptedSecondsAgo: 180 });
        await inTenant(f.clinicId, (client) =>
          client.query(
            `update slot_holds set status = 'unknown', next_check_at = clock_timestamp() - interval '1 second'
              where id = $1`,
            [c.holdId],
          ),
        );
        google.addEvent(f.sub, {
          id: googleEventIdFor(`hold:${c.holdId}`),
          start: at,
          end: new Date(at.getTime() + 30 * MIN),
          privateProperties: { ...HEALDESK_EVENT_MARKER },
        });

        state.failRecord.set(c.holdId, 1);
        expect((await sweepHolds()).errors).toBeGreaterThanOrEqual(1);
        let [h] = (await rows(f.clinicId)).holds;
        expect(h).toMatchObject({ status: "unknown", check_attempts: 1 });
        expect(h!.next_check_at!.getTime()).toBeGreaterThan(Date.now());

        // The last try: given up, and the clinic told to check, in one step.
        await inTenant(f.clinicId, (client) =>
          client.query(`update slot_holds set check_attempts = 4 where id = $1`, [c.holdId]),
        );
        await makeDue(f.clinicId);
        state.failRecord.set(c.holdId, 1);
        expect((await sweepHolds()).errors).toBeGreaterThanOrEqual(1);
        [h] = (await rows(f.clinicId)).holds;
        expect(h).toMatchObject({ status: "released", outcome_reason: "unresolved" });
        expect(alertsOf(f.clinicId)).toEqual([
          { kind: "calendar_check", ref: { bookingRequestId: c.requestId } },
        ]);
        await sweepHolds();
        expect(alertsOf(f.clinicId)).toHaveLength(1);
      },
      SLOW,
    );
  });

  describe("deposits on a call (D's rules, through the engine)", () => {
    const peel: AgentService = {
      name: "Chemical peel",
      priceFromUsd: 150,
      priceToUsd: 250,
      durationMinutes: 60,
      depositUsd: 75,
    };
    const consult: AgentService = {
      name: "Consultation",
      priceFromUsd: 0,
      priceToUsd: 0,
      durationMinutes: 30,
      depositUsd: 0,
    };
    const policy: DepositPolicy = { required: true, amountUsd: 100, collection: "front_desk" };
    const appointmentsOf = async (clinicId: string) => (await rows(clinicId)).appointments;

    test(
      "On: books, leaves the service's own deposit to the desk with D's one L10 alert; $0 asks nothing; an unlisted service gets the default; a retry hears the same",
      async () => {
        const f = await location("eng-dep-on", { services: [peel, consult], policy });
        const first = deskTime(3, 10);
        const booked = await book(f.clinicId, "d1", first, { service: "chemical peel" });
        expect(booked).toMatchObject({
          kind: "booked",
          canonicalService: "Chemical peel",
          deposit: { action: "book_and_flag", amountUsd: 75 },
        });
        expect(
          booked.kind === "booked" && depositLine({ ...booked.deposit!, scope: "booking" }),
        ).toBe(
          "A deposit of 75 dollars is required to hold the appointment. The front desk will call you to take it; nothing is charged on this call.",
        );
        const [appointment] = await appointmentsOf(f.clinicId);
        expect(appointment).toMatchObject({
          deposit_status: "pending_front_desk",
          deposit_usd: "75.00",
        });
        expect(alertsOf(f.clinicId)).toEqual([
          { kind: "deposit_to_collect", ref: { appointmentId: appointment!.id } },
        ]);

        // A service set to $0 asks for nothing, even with a clinic default.
        expect(await book(f.clinicId, "d2", deskTime(3, 13))).toMatchObject({
          kind: "booked",
          deposit: null,
        });
        expect((await appointmentsOf(f.clinicId))[1]).toMatchObject({
          deposit_status: "none",
          deposit_usd: null,
        });

        // A service the clinic never listed gets the clinic default, not a guess.
        await book(f.clinicId, "d3", deskTime(3, 15), { service: "Something new" });
        expect((await appointmentsOf(f.clinicId))[2]).toMatchObject({
          deposit_status: "pending_front_desk",
          deposit_usd: "100.00",
        });
        expect(alertsOf(f.clinicId).map((a) => a.kind)).toEqual([
          "deposit_to_collect",
          "deposit_to_collect",
        ]);

        // The retry hears exactly what the first call heard, deposit included, and raises nothing.
        expect(await book(f.clinicId, "d1", first, { service: "chemical peel" })).toMatchObject({
          kind: "booked",
          replayed: true,
          deposit: { action: "book_and_flag", amountUsd: 75 },
        });
        expect(alertsOf(f.clinicId)).toHaveLength(2);
      },
      SLOW,
    );

    test(
      "Off: nothing held, offered or written; the request goes to the desk with deposit_to_collect instead of booking_request, and a retry gets the same answer",
      async () => {
        const f = await location("eng-dep-off", { bookVoiceWithoutDeposit: false, policy });
        const at = deskTime(3, 10);
        expect(
          await offerTimes(f.clinicId, {
            channel: "voice",
            holderKey: "retell:d4",
            service: "Consultation",
          }),
        ).toEqual({ status: "request_only", reasons: ["deposit_required"] });
        expect(await hold(f.clinicId, "d4", at)).toEqual({
          kind: "request_only",
          reasons: ["deposit_required"],
        });
        const refused = await book(f.clinicId, "d4", at);
        expect(refused).toEqual({
          kind: "request_logged",
          reason: "deposit_required",
          replayed: false,
          deposit: { action: "decline_and_alert", amountUsd: 100 },
        });
        const { appointments, requests, holds } = await rows(f.clinicId);
        expect(appointments).toEqual([]);
        expect(holds).toEqual([]);
        expect(requests).toEqual([
          expect.objectContaining({
            status: "requested",
            booked_via: "desk",
            vendor_call_id: "retell:d4:1",
            appointment_id: null,
          }),
        ]);
        // One alert for the one event: the most specific (the funnel, 12 October).
        expect(alertsOf(f.clinicId)).toEqual([
          { kind: "deposit_to_collect", ref: { bookingRequestId: requests[0]!.id } },
        ]);
        expect(inserts()).toHaveLength(0);

        const retried = await book(f.clinicId, "d4", at);
        expect(retried).toMatchObject({
          kind: "request_logged",
          reason: "deposit_required",
          replayed: true,
        });
        expect((await rows(f.clinicId)).requests).toHaveLength(1);
        expect(alertsOf(f.clinicId)).toHaveLength(1);
      },
      SLOW,
    );

    test(
      "deposits off, or no connected account: no deposit, whatever the policy says, and no alert",
      async () => {
        const off = await location("eng-dep-disabled", { enabled: false, policy });
        expect(await book(off.clinicId, "d5", deskTime(3, 10))).toMatchObject({
          kind: "booked",
          deposit: null,
        });
        expect((await appointmentsOf(off.clinicId))[0]).toMatchObject({
          deposit_status: "none",
          deposit_usd: null,
        });

        const loose = await location("eng-dep-loose", { connected: false, policy });
        expect(await book(loose.clinicId, "d6", deskTime(3, 10))).toMatchObject({
          kind: "booked",
          deposit: null,
        });
        expect((await appointmentsOf(loose.clinicId))[0]).toMatchObject({ deposit_status: "none" });
        expect(alertsOf(off.clinicId)).toEqual([]);
        expect(alertsOf(loose.clinicId)).toEqual([]);
      },
      SLOW,
    );

    test(
      "the answer gate runs after the replay: a booked call's retry still answers, a new booking is refused with nothing written",
      async () => {
        const f = await location("eng-gate");
        let calls = 0;
        let answer = true;
        const gate = async () => {
          calls += 1;
          return answer;
        };
        const at = deskTime(3, 11);
        expect(await book(f.clinicId, "g1", at, { gate })).toMatchObject({ kind: "booked" });
        expect(calls).toBe(1);

        answer = false;
        expect(await book(f.clinicId, "g1", at, { gate })).toMatchObject({
          kind: "booked",
          replayed: true,
        });
        expect(calls).toBe(1);

        expect(await book(f.clinicId, "g2", deskTime(3, 14), { gate })).toEqual({
          kind: "refused",
        });
        expect(calls).toBe(2);
        const { appointments, requests } = await rows(f.clinicId);
        expect(appointments).toHaveLength(1);
        expect(requests).toHaveLength(1);
      },
      SLOW,
    );

    test(
      "a med spa's own service named for a condition is the one the caller books: its name kept, its own deposit found",
      async () => {
        // The everyday skin and hair conditions are the Meta channels' rule. On
        // a call the BAA covers, "Acne Facial" is a service like any other:
        // were its name dropped, the booking would carry no treatment and the
        // clinic default of 100 dollars.
        const acneFacial: AgentService = {
          name: "Acne Facial",
          priceFromUsd: 150,
          priceToUsd: 150,
          durationMinutes: 60,
          depositUsd: 40,
        };
        const f = await location("eng-acne", { services: [acneFacial, consult], policy });
        const booked = await book(f.clinicId, "d7", deskTime(3, 10), {
          firstName: "Riya",
          service: "Acne Facial",
        });
        expect(booked).toMatchObject({
          kind: "booked",
          canonicalService: "Acne Facial",
          deposit: { action: "book_and_flag", amountUsd: 40 },
        });
        expect(
          booked.kind === "booked" && depositLine({ ...booked.deposit!, scope: "booking" }),
        ).toMatch(/^A deposit of 40 dollars/);
        const stored = await inTenant(f.clinicId, async (client) => ({
          requests: (
            await client.query<{ treatment: string | null }>(
              `select treatment from booking_requests`,
            )
          ).rows,
          appointments: (
            await client.query<{ treatment: string | null; deposit_usd: string | null }>(
              `select treatment, deposit_usd from appointments`,
            )
          ).rows,
          services: (
            await client.query<{ services: AgentService[] }>(`select services from agent_configs`)
          ).rows[0]!.services.map((s) => s.name),
        }));
        expect(stored).toEqual({
          requests: [{ treatment: "Acne Facial" }],
          appointments: [{ treatment: "Acne Facial", deposit_usd: "40.00" }],
          services: ["Acne Facial", "Consultation"],
        });
      },
      SLOW,
    );

    test(
      "hold and alert: the time reserved, blocking other callers, nothing in Google, D's one L10 alert; staff confirming that time turn the reservation into the booking with the service's own deposit and no second alert",
      async () => {
        const f = await location("eng-reserve", { services: [peel, consult], policy });
        state.decide.set(f.clinicId, () => ({
          action: "hold_and_alert",
          isRequired: true,
          amountUsd: 75,
          rule: "chat_uncollectable",
        }));
        const at = deskTime(3, 10);
        const reserved = await book(f.clinicId, "d8", at, { service: "Chemical peel" });
        expect(reserved).toMatchObject({
          kind: "request_logged",
          reason: "deposit_hold",
          deposit: { action: "hold_and_alert", amountUsd: 75 },
        });
        const { holds, requests } = await rows(f.clinicId);
        expect(holds).toEqual([
          expect.objectContaining({ status: "reserved", booking_request_id: requests[0]!.id }),
        ]);
        expect(requests).toEqual([
          expect.objectContaining({ status: "requested", booked_via: "desk" }),
        ]);
        expect(alertsOf(f.clinicId)).toEqual([
          { kind: "deposit_to_collect", ref: { bookingRequestId: requests[0]!.id } },
        ]);
        expect(inserts()).toHaveLength(0);

        state.decide.clear();
        expect((await hold(f.clinicId, "d9", at, "Chemical peel")).kind).toBe("slot_taken");

        const decided = await decideBookingRequest(
          await deskToken(f.clinicId, requests[0]!.id),
          "confirmed",
          { decidedByLabel: "Jo", deskNote: null, confirmedFor: at },
        );
        expect(decided).toMatchObject({ outcome: "decided", calendarWrite: "written" });
        const after = await rows(f.clinicId);
        expect(after.holds[0]).toMatchObject({
          status: "converted",
          appointment_id: decided.appointmentId,
        });
        // The peel's own 75 dollars, not the clinic default of 100.
        expect(after.appointments).toEqual([
          expect.objectContaining({ deposit_status: "pending_front_desk", deposit_usd: "75.00" }),
        ]);
        expect(alertsOf(f.clinicId)).toHaveLength(1);
        expect(google.events(f.sub)).toHaveLength(1);
      },
      SLOW,
    );
  });
});
