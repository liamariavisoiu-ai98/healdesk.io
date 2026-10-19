import { createBookingRequest } from "@/lib/meta/booking-requests";
import { startOfLocalDay } from "@/lib/clinic/setup-window";
import type { DeliveryResult, EmailTransport, OutgoingEmail } from "@/lib/reporting/deliver";
import { addLocalDays, localClock } from "@/lib/scheduler/summary-clock";
import { withTenant } from "@/lib/tenant";

import { getMigratorPool } from "./db";
import { bindAgreementInEffect, inTenant, setWeekdayHours } from "./factories";
import { provisionPortalClinic, type PortalClinic } from "./portal-clinic";

/**
 * Fixtures for the claims function and the summaries (package WP4):
 * tests/claims.test.ts and tests/daily-summary.test.ts. Live production
 * clinics on weekday hours in New York, the calls, chats and requests the
 * claims count, and the clock the jobs are run at.
 */

export const ZONE = "America/New_York";
export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;
const ACTOR = { type: "service", serviceName: "claims-test" } as const;

/** Monday to Friday, 09:00 to 17:00: setWeekdayHours's week, as the clock tests read it. */
export const WEEKDAY = {
  sun: [],
  mon: [["09:00", "17:00"]],
  tue: [["09:00", "17:00"]],
  wed: [["09:00", "17:00"]],
  thu: [["09:00", "17:00"]],
  fri: [["09:00", "17:00"]],
  sat: [],
} as const;

export type Sent = { to: string; message: OutgoingEmail };
export function capture(): EmailTransport & { sent: Sent[] } {
  const sent: Sent[] = [];
  return {
    name: "capture",
    sent,
    async send(recipient, message): Promise<DeliveryResult> {
      sent.push({ to: recipient.to, message });
      return { status: "sent", messageId: `msg-${sent.length}` };
    },
  } as EmailTransport & { sent: Sent[] };
}

/**
 * The first instant at or after real time plus a margin that falls at
 * `hour`:00 on a clinic-local day `accept` takes: the clock the jobs are run
 * at. Ahead of the database's own clock, so every row written now is inside
 * a period that ends then.
 */
export function nextLocal(
  accept: (day: string) => boolean,
  hour: number,
  after: Date = new Date(Date.now() + 2 * MINUTE),
): Date {
  const today = localClock(after, ZONE).date;
  for (let i = 0; i < 21; i += 1) {
    const date = addLocalDays(today, i);
    const at = new Date(startOfLocalDay(date, ZONE).getTime() + hour * HOUR);
    if (at.getTime() >= after.getTime() && accept(localClock(at, ZONE).day)) return at;
  }
  throw new Error("no such day in three weeks");
}
export const midweek = (day: string) => day === "tue" || day === "wed" || day === "thu";

/** A clinic as provisioning leaves it, then production, on weekday hours, its channels live since `liveAt`. */
export async function liveClinic(
  label: string,
  liveAt: Date,
  plan = "voice-webchat-1000-1000",
): Promise<PortalClinic> {
  const c = await provisionPortalClinic(label, { plan });
  await bindAgreementInEffect(c.clinicId);
  await getMigratorPool().query(
    `update clinics set data_classification = 'production', baa_signed_at = now(), timezone = $2 where id = $1`,
    [c.clinicId, ZONE],
  );
  await setWeekdayHours(c.clinicId);
  await inTenant(c.clinicId, (client) =>
    client.query(
      `update clinic_channels set ready_at = $2, live_at = $2, first_answer_at = $2 where clinic_id = $1`,
      [c.clinicId, liveAt],
    ),
  );
  return c;
}

export async function conversation(
  clinicId: string,
  input: {
    channel: "voice" | "web_chat";
    at: Date;
    reason?: string | null;
    urgent?: boolean;
    outcome?: string;
    /** False for a call AYA never spoke on: no opening line played. */
    answered?: boolean;
  },
): Promise<void> {
  await inTenant(clinicId, (client) =>
    client.query(
      `insert into conversations (clinic_id, channel, recovery_reason, outcome, urgent, started_at, disclosure_played_at)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      [
        clinicId,
        input.channel,
        input.reason ?? null,
        input.outcome ?? "qualified_no_booking",
        input.urgent ?? false,
        input.at,
        input.answered === false ? null : input.at,
      ],
    ),
  );
}

export async function contact(clinicId: string, name: string, phone: string): Promise<string> {
  return inTenant(clinicId, async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `insert into contacts (clinic_id, phone, full_name) values ($1, $2, $3) returning id`,
      [clinicId, phone, name],
    );
    return rows[0]!.id;
  });
}

/** A request the phone took, for a named person, as the booking engine logs one. */
export async function request(
  clinicId: string,
  person: { name: string; phone: string },
  treatment: string | null = "Consultation",
  channel: "voice" | "web_chat" = "voice",
): Promise<string> {
  const contactId = await contact(clinicId, person.name, person.phone);
  const created = await withTenant({ clinicId, actor: ACTOR }, (tx) =>
    createBookingRequest(tx, {
      channel,
      contactId,
      conversationId: null,
      preferredWindow: "Thursday afternoon",
      treatment,
    }),
  );
  return created.id;
}

/**
 * A message left on the website's contact form while AYA was not answering
 * (package F's L20): a request on Bookings, `source` `contact_form`, that AYA
 * did not take.
 */
export async function websiteMessage(
  clinicId: string,
  person: { name: string; phone: string },
): Promise<string> {
  const contactId = await contact(clinicId, person.name, person.phone);
  const created = await withTenant({ clinicId, actor: ACTOR }, (tx) =>
    createBookingRequest(tx, {
      channel: "web_chat",
      contactId,
      conversationId: null,
      preferredWindow: "This afternoon",
      treatment: null,
      source: "contact_form",
    }),
  );
  return created.id;
}

/** Move a request's creation, as the owner with the no-rewrite trigger off. */
export async function backdate(
  clinicId: string,
  requestId: string,
  set: string,
  values: unknown[] = [],
): Promise<void> {
  const pool = getMigratorPool();
  await pool.query(`alter table booking_requests disable trigger booking_requests_no_rewrite`);
  try {
    await inTenant(clinicId, (client) =>
      client.query(`update booking_requests set ${set} where id = $1`, [requestId, ...values]),
    );
  } finally {
    await pool.query(`alter table booking_requests enable trigger booking_requests_no_rewrite`);
  }
}

export async function setServices(clinicId: string): Promise<void> {
  await inTenant(clinicId, (client) =>
    client.query(`update agent_configs set services = $2::jsonb where clinic_id = $1`, [
      clinicId,
      JSON.stringify([
        {
          name: "Consultation",
          priceKind: "exact",
          priceFromUsd: 150,
          priceToUsd: 150,
          durationMinutes: 30,
        },
        {
          name: "Peel",
          priceKind: "range",
          priceFromUsd: 200,
          priceToUsd: 350,
          durationMinutes: 45,
        },
        {
          name: "Toxin",
          priceKind: "per_unit",
          priceFromUsd: 14,
          priceToUsd: null,
          unit: "unit",
          durationMinutes: 30,
        },
        {
          name: "Assessment",
          priceKind: null,
          priceFromUsd: null,
          priceToUsd: null,
          durationMinutes: 30,
        },
      ]),
    ]),
  );
}

export async function notices(
  clinicId: string,
  kind: string,
): Promise<{ id: string; dedupe_key: string; payload: Record<string, unknown> }[]> {
  return inTenant(clinicId, async (client) => {
    const { rows } = await client.query<{
      id: string;
      dedupe_key: string;
      payload: Record<string, unknown>;
    }>(
      `select id, dedupe_key, payload from billing_notices where clinic_id = $1 and kind = $2 order by created_at`,
      [clinicId, kind],
    );
    return rows;
  });
}
