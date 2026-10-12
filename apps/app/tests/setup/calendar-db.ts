import { createHash, randomBytes, randomUUID } from "node:crypto";

import {
  bookingSyncFor,
  type BookingSystemId,
  type CalendarAccount,
  selectCalendarClause,
} from "@healdesk/catalog";

import { getAppPool, getMigratorPool } from "./db";
import { inTenant, type SeededClinic } from "./factories";

/**
 * SQL-level fixtures for drizzle/0057's calendar tables: the rows the
 * database checks, written the way the guards expect them, so the DB suites
 * can exercise the triggers before the calendar libraries exist (C7 and C8
 * build seedCalendarTerms and seedGoogleConnection on those libraries).
 *
 * Writes that a trigger judges run on the RUNTIME role inside the clinic's
 * tenant, so a fixture passes the same checks production writes will; rows
 * the runtime role is never given (a bound agreement) are written by the
 * migrator, as provisioning's definer function would. Everything is
 * synthetic.
 */

export type Client = {
  query: <T = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ) => Promise<{ rows: T[]; rowCount: number | null }>;
};

/** One committed transaction on the runtime role, inside the clinic's tenant. */
export async function asApp<T>(clinicId: string, fn: (c: Client) => Promise<T>): Promise<T> {
  const client = await getAppPool().connect();
  try {
    await client.query("begin");
    await client.query(`select set_config('app.clinic_id', $1, true)`, [clinicId]);
    const result = await fn(client as unknown as Client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/** sha256 hex, the shape of slot_holds.holder_ref and provider_connections.account_ref. */
export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export type CalendarTermsInput = {
  /** Default "google_calendar": a system that reads Google, so live. */
  bookingSystem?: BookingSystemId;
  /** Default "workspace_baa": covered. */
  calendarAccount?: CalendarAccount;
};

export type BoundAgreement = {
  agreementId: string;
  documentVersion: string;
  documentHash: string;
  bookingSystem: BookingSystemId;
  calendarAccount: CalendarAccount;
  termsKind: "covered" | "uncovered" | "not_used";
  clauseId: string;
  bookingSync: "live" | "manual";
};

/**
 * A 1.3.0-shaped acceptance bound to the clinic's organisation: its applied
 * clauses carry the calendar clause the catalogue derives from the booking
 * system and the account kind, beside the variables signAgreement stores.
 */
export async function bindCalendarAgreement(
  clinic: Pick<SeededClinic, "organizationId">,
  input: CalendarTermsInput = {},
): Promise<BoundAgreement> {
  const bookingSystem = input.bookingSystem ?? "google_calendar";
  const calendarAccount = input.calendarAccount ?? "workspace_baa";
  const { kind, clauseId } = selectCalendarClause({ bookingSystem, calendarAccount });
  const agreementId = randomUUID();
  const documentHash = randomBytes(32).toString("hex");
  await getMigratorPool().query(
    `insert into baa_acceptances
       (id, organization_id, document_version, document_hash, rendered_text, variables,
        assent_label, accepted_by_name, accepted_by_email, accepted_at, bound_at)
     values ($1, $2, '1.3.0', $3, 'BUSINESS ASSOCIATE AGREEMENT (synthetic test)', $4::jsonb,
             'I agree', 'Alex Chen', 'alex@radiance.test', now(), now())`,
    [
      agreementId,
      clinic.organizationId,
      documentHash,
      JSON.stringify({
        clinicLegalName: "Radiance Synthetic",
        bookingSystem,
        calendarAccount,
        appliedClauses: ["data-sources-none", clauseId, "term"],
      }),
    ],
  );
  return {
    agreementId,
    documentVersion: "1.3.0",
    documentHash,
    bookingSystem,
    calendarAccount,
    termsKind: kind,
    clauseId,
    bookingSync: bookingSyncFor(bookingSystem),
  };
}

/** The `agreement` election row provisioning records, on the runtime role (the guard judges it). */
export async function recordAgreementElection(
  clinicId: string,
  agreement: BoundAgreement,
): Promise<{ id: string; sequence: number }> {
  return asApp(clinicId, async (c) => {
    const { rows } = await c.query<{ id: string; sequence: number }>(
      `insert into calendar_elections
         (clinic_id, agreement_id, source, terms_kind, clause_id, calendar_account, booking_sync,
          booking_system, document_version, document_hash, document_released, elected_by_label)
       values ($1, $2, 'agreement', $3, $4, $5, $6, $7, $8, $9, true, 'Alex Chen')
       returning id, sequence`,
      [
        clinicId,
        agreement.agreementId,
        agreement.termsKind,
        agreement.clauseId,
        agreement.calendarAccount,
        agreement.bookingSync,
        agreement.bookingSystem,
        agreement.documentVersion,
        agreement.documentHash,
      ],
    );
    return rows[0]!;
  });
}

export type GoogleConnectionInput = {
  /** metadata.managed: a Workspace account (true) or a personal one (false). */
  managed: boolean;
  status?: "pending" | "active" | "degraded" | "revoked" | "error";
  brokenAt?: Date | null;
  brokenAlertedAt?: Date | null;
  /** Default: a fresh account reference. */
  accountRef?: string;
};

/**
 * A google_calendar connection row. The credential columns hold placeholders:
 * no test here decrypts them, and the database checks nothing about them.
 */
export async function insertGoogleConnection(
  clinicId: string,
  input: GoogleConnectionInput,
): Promise<{ id: string; accountRef: string }> {
  const accountRef = input.accountRef ?? sha256Hex(`google:${randomUUID()}`);
  return asApp(clinicId, async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `insert into provider_connections
         (clinic_id, provider, status, ciphertext, iv, auth_tag, wrapped_dek, key_version, aad_version,
          metadata, account_ref, broken_at, broken_alerted_at)
       values ($1, 'google_calendar', $2, 'x', 'x', 'x', 'x', 'v1', 1, $3::jsonb, $4, $5, $6)
       returning id`,
      [
        clinicId,
        input.status ?? "active",
        JSON.stringify({ calendarId: "primary", managed: input.managed }),
        accountRef,
        input.brokenAt ?? null,
        input.brokenAlertedAt ?? null,
      ],
    );
    return { id: rows[0]!.id, accountRef };
  });
}

/**
 * A location whose terms let healdesk write: a bound calendar agreement, its
 * `agreement` election, and a matching, healthy Google connection.
 */
export async function seedWritableCalendar(
  clinic: SeededClinic,
  input: CalendarTermsInput = {},
): Promise<{ agreement: BoundAgreement; connectionId: string; accountRef: string }> {
  const agreement = await bindCalendarAgreement(clinic, input);
  await recordAgreementElection(clinic.clinicId, agreement);
  const { id, accountRef } = await insertGoogleConnection(clinic.clinicId, {
    managed: agreement.calendarAccount !== "personal",
  });
  return { agreement, connectionId: id, accountRef };
}

/** Makes a seeded clinic a demo clinic (app_clinic_is_demo): status demo, no Stripe ids. */
export async function markDemo(clinicId: string): Promise<void> {
  await inTenant(clinicId, async (client) => {
    await client.query(
      `insert into entitlements (clinic_id, plan_code, billing_interval, status)
       values ($1, 'complete', 'month', 'demo')`,
      [clinicId],
    );
  });
}

export type HoldInput = {
  /** The holder key; holder_ref is its sha256. */
  holder: string;
  startsAt: Date;
  minutes?: number;
  channel?: "voice" | "web_chat" | "meta";
  contactId?: string | null;
  /** Place it this many seconds in the past (its 60-second window runs from then). */
  placedSecondsAgo?: number;
  /** The calendar it holds time on; `primary` unless a test names another. */
  calendarId?: string;
};

/** Inserts a held slot hold through the guard trigger, on the client given. */
export async function insertHold(c: Client, clinicId: string, input: HoldInput): Promise<string> {
  const minutes = input.minutes ?? 30;
  const ago = input.placedSecondsAgo ?? 0;
  const { rows } = await c.query<{ id: string }>(
    `insert into slot_holds
       (clinic_id, channel, holder_ref, starts_at, duration_minutes, ends_at, contact_id,
        created_at, expires_at, calendar_id)
     values ($1, $2, $3, $4::timestamptz, $5::int, $4::timestamptz + make_interval(mins => $5::int), $6,
             clock_timestamp() - make_interval(secs => $7::int),
             clock_timestamp() - make_interval(secs => $7::int) + interval '60 seconds', $8)
     returning id`,
    [
      clinicId,
      input.channel ?? "voice",
      sha256Hex(input.holder),
      input.startsAt,
      minutes,
      input.contactId ?? null,
      ago,
      input.calendarId ?? "primary",
    ],
  );
  return rows[0]!.id;
}

/** held -> writing, as the claim transaction writes it. */
export async function claimForWriting(
  c: Client,
  holdId: string,
  options: { blocksForSeconds?: number } = {},
): Promise<void> {
  await c.query(
    `update slot_holds
        set status = 'writing',
            lease_token = gen_random_uuid(),
            lease_until = clock_timestamp() + interval '30 seconds',
            insert_attempted_at = clock_timestamp(),
            blocks_until = clock_timestamp() + make_interval(secs => $2),
            updated_at = now()
      where id = $1`,
    [holdId, options.blocksForSeconds ?? 15 * 60],
  );
}

/** A requested booking request for a contact, as the voice path inserts one. */
export async function insertBookingRequest(
  c: Client,
  clinicId: string,
  contactId: string,
  options: { vendorCallId?: string | null; expiresInDays?: number } = {},
): Promise<string> {
  const { rows } = await c.query<{ id: string }>(
    `insert into booking_requests
       (clinic_id, contact_id, channel, preferred_window, status, token_hash, expires_at, vendor_call_id)
     values ($1, $2, 'voice', 'Tuesday 2pm', 'requested', $3, now() + make_interval(days => $4), $5)
     returning id`,
    [
      clinicId,
      contactId,
      randomBytes(32),
      options.expiresInDays ?? 7,
      options.vendorCallId ?? null,
    ],
  );
  return rows[0]!.id;
}

/** A whole number of minutes from `base`. */
export function at(base: Date, minutes: number): Date {
  return new Date(base.getTime() + minutes * 60_000);
}

/** A quarter-hour well in the future, so no test's times collide with now. */
export function futureBase(daysAhead = 10): Date {
  const d = new Date(Date.now() + daysAhead * 86_400_000);
  d.setUTCMinutes(0, 0, 0);
  return d;
}
