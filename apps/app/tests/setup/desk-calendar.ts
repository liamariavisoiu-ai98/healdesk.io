import { randomUUID } from "node:crypto";

import type { BookingSystemId, CalendarAccount } from "@healdesk/catalog";
import {
  FAKE_GOOGLE_CLIENT,
  fakeGoogleCalendar,
  resetGoogleTokenCache,
  setGoogleFetch,
  setGoogleTimeouts,
  type FakeGoogleCalendar,
} from "@healdesk/connectors";
import { vi } from "vitest";

import { createBookingRequest, type DeskRef } from "@/lib/meta/booking-requests";
import { updateAgentConfig } from "@/lib/onboarding/agent-config";
import { withTenant } from "@/lib/tenant";

import { getMigratorPool } from "./db";
import { deskRef } from "./desk-view";
import {
  inTenant,
  seedCalendarTerms,
  seedClinic,
  seedContact,
  seedConversation,
  seedGoogleConnection,
} from "./factories";

/**
 * The desk path against the in-memory Google (plan §7.10-7.12): a location
 * whose terms let healdesk write, its Google account and connection, its
 * hours, zone and services, and one phone request for the desk to decide.
 * Everything synthetic; no request leaves the process (the global fetch
 * throws).
 */

export const DESK_TZ = "America/New_York";
const ACTOR = { type: "service", serviceName: "test" } as const;
const ENV = ["GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET"] as const;
const saved: Record<string, string | undefined> = {};

/** Point apps/app at a fresh fake Google, with healdesk's client set. Call in beforeEach. */
export function freshGoogle(): FakeGoogleCalendar {
  const google = fakeGoogleCalendar();
  setGoogleFetch(google.fetch);
  resetGoogleTokenCache();
  return google;
}

/** In beforeAll: no live call, and healdesk's (fake) OAuth client configured. */
export function installGoogleEnv(): void {
  vi.stubGlobal("fetch", () => {
    throw new Error("live call attempted from a desk-calendar test");
  });
  for (const key of ENV) saved[key] = process.env[key];
  process.env.GOOGLE_OAUTH_CLIENT_ID = FAKE_GOOGLE_CLIENT.clientId;
  process.env.GOOGLE_OAUTH_CLIENT_SECRET = FAKE_GOOGLE_CLIENT.clientSecret;
}

/** In afterAll. */
export function restoreGoogleEnv(): void {
  setGoogleFetch(undefined);
  setGoogleTimeouts(undefined);
  vi.unstubAllGlobals();
  for (const key of ENV) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
}

export type DeskLocation = {
  clinicId: string;
  organizationId: string;
  sub: string;
  refreshToken: string;
  connectionId: string | null;
};

/**
 * A location with calendar terms (covered by default: a booking system that
 * reads Google, a Workspace account under Google's BAA), a connected Google
 * account, hours every day 08:00–20:00 in New York with the zone confirmed,
 * and two services. `connect: false` leaves it with terms and no connection.
 */
export async function deskLocation(
  google: FakeGoogleCalendar,
  label: string,
  options: {
    bookingSystem?: BookingSystemId;
    calendarAccount?: CalendarAccount;
    connect?: boolean;
    specialty?: string;
  } = {},
): Promise<DeskLocation> {
  const clinic = await seedClinic(label);
  await getMigratorPool().query(
    `update clinics
        set timezone = $2, timezone_confirmed_at = now(), specialty = $3,
            opening_hours = $4::jsonb
      where id = $1`,
    [
      clinic.clinicId,
      DESK_TZ,
      options.specialty ?? "med-spa",
      JSON.stringify(
        Object.fromEntries(
          ["sun", "mon", "tue", "wed", "thu", "fri", "sat"].map((d) => [d, [["08:00", "20:00"]]]),
        ),
      ),
    ],
  );
  await inTenant(clinic.clinicId, (client) =>
    client.query(
      `insert into report_recipients (clinic_id, email, added_by) values ($1, $2, 'test')`,
      [clinic.clinicId, "desk@example-clinic.test"],
    ),
  );
  await withTenant({ clinicId: clinic.clinicId, actor: ACTOR }, (tx) =>
    updateAgentConfig(tx, {
      greeting: "Hi",
      services: [
        { name: "Consultation", priceFromUsd: 0, priceToUsd: 0, durationMinutes: 30 },
        { name: "Facial", priceFromUsd: 100, priceToUsd: 100, durationMinutes: 60 },
      ],
      escalationPhone: null,
      escalationHours: "Weekdays 9 to 5",
      notes: null,
      depositPolicy: null,
    }),
  );
  const calendarAccount = options.calendarAccount ?? "workspace_baa";
  await seedCalendarTerms(clinic, {
    bookingSystem: options.bookingSystem ?? "google_calendar",
    calendarAccount,
  });
  const sub = `3${Date.now()}${Math.floor(Math.random() * 1e6)}`;
  const managed = calendarAccount !== "personal";
  google.addAccount({
    sub,
    email: `desk-${sub}@radiance.test`,
    ...(managed ? { hd: "radiance.test" } : {}),
  });
  const { refreshToken } = google.grant({ sub });
  let connectionId: string | null = null;
  if (options.connect !== false) {
    ({ connectionId } = await seedGoogleConnection(clinic.clinicId, { managed, refreshToken }));
  }
  return {
    clinicId: clinic.clinicId,
    organizationId: clinic.organizationId,
    sub,
    refreshToken,
    connectionId,
  };
}

/** A phone request at the location, for `service`, and the reference staff decide it by. */
export async function phoneRequest(
  clinicId: string,
  options: { service?: string; phone?: string } = {},
): Promise<{ desk: DeskRef; requestId: string; contactId: string }> {
  const contactId = await seedContact(
    clinicId,
    options.phone ?? `+1555010${String(Math.floor(Math.random() * 9000) + 1000)}`,
  );
  const { conversationId } = await seedConversation(clinicId, { startedAt: new Date(), contactId });
  const created = await withTenant({ clinicId, actor: ACTOR }, (tx) =>
    createBookingRequest(tx, {
      channel: "voice",
      contactId,
      conversationId,
      preferredWindow: "Thursday afternoon",
      treatment: options.service ?? "Consultation",
      alternativeWindows: ["Friday morning"],
    }),
  );
  return { desk: deskRef(clinicId, created.id), requestId: created.id, contactId };
}

/** A whole hour `days` ahead, at `hour` on the clinic's clock (New York). */
export function deskTime(days: number, hour: number, minute = 0): Date {
  const base = new Date(Date.now() + days * 86_400_000);
  const ymd = new Intl.DateTimeFormat("en-CA", {
    timeZone: DESK_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(base);
  // New York is UTC-4 or UTC-5; read the offset at noon that day.
  const noon = new Date(`${ymd}T12:00:00Z`);
  const offsetHours =
    Number(
      new Intl.DateTimeFormat("en-US", {
        timeZone: DESK_TZ,
        hour: "numeric",
        hourCycle: "h23",
      }).format(noon),
    ) - 12;
  return new Date(
    Date.UTC(
      Number(ymd.slice(0, 4)),
      Number(ymd.slice(5, 7)) - 1,
      Number(ymd.slice(8, 10)),
      hour - offsetHours,
      minute,
    ),
  );
}

/** A slot hold row for a request, as the engine leaves one, written as the migrator in the tenant. */
export async function assistantHold(
  clinicId: string,
  input: {
    requestId: string;
    contactId: string;
    startsAt: Date;
    minutes?: number;
    status: "unknown" | "writing" | "reserved";
    /** Seconds since the insert attempt (unknown and writing). */
    attemptedSecondsAgo?: number;
    calendarId?: string;
  },
): Promise<string> {
  const minutes = input.minutes ?? 30;
  const ago = input.attemptedSecondsAgo ?? 0;
  return inTenant(clinicId, async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `insert into slot_holds (clinic_id, channel, holder_ref, calendar_id, starts_at, duration_minutes, ends_at, contact_id)
       values ($1, 'voice', $2, $3, $4::timestamptz, $5::int, $4::timestamptz + make_interval(mins => $5::int), $6)
       returning id`,
      [
        clinicId,
        randomUUID().replace(/-/g, "").padEnd(64, "0"),
        input.calendarId ?? "primary",
        input.startsAt,
        minutes,
        input.contactId,
      ],
    );
    const id = rows[0]!.id;
    if (input.status === "reserved") {
      await client.query(
        `update slot_holds set status = 'reserved', booking_request_id = $2,
                blocks_until = clock_timestamp() + interval '30 minutes', updated_at = now()
          where id = $1`,
        [id, input.requestId],
      );
      return id;
    }
    // The claim (held -> writing) needs the write permission and a live hold.
    await client.query(
      `update slot_holds set status = 'writing', booking_request_id = $2, lease_token = gen_random_uuid(),
              lease_until = clock_timestamp() + interval '30 seconds',
              insert_attempted_at = clock_timestamp() - make_interval(secs => $3::int),
              blocks_until = clock_timestamp() + interval '15 minutes', updated_at = now()
        where id = $1`,
      [id, input.requestId, ago],
    );
    if (input.status === "unknown") {
      await client.query(
        `update slot_holds set status = 'unknown', next_check_at = clock_timestamp() + interval '2 minutes',
                updated_at = now()
          where id = $1`,
        [id],
      );
    }
    return id;
  });
}
