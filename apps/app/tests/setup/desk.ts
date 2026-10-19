import { createHash, randomUUID } from "node:crypto";

import {
  decideBookingRequest,
  deskFreeTimes,
  readBookingRequestViews,
  type BookingDecision,
  type BookingRequestView,
  type DecisionInput,
  type DecisionOutcome,
  type DeskActor,
} from "@/lib/meta/booking-requests";
import type { MetaSender } from "@/lib/meta/channels";
import { withTenant } from "@/lib/tenant";

import { getMigratorPool } from "./db";
import { inTenant } from "./factories";

/**
 * The desk path for the tests that exercise the decision core below the
 * portal: the calendar, the holds, the Meta follow-up. Since M5 staff decide
 * on Bookings, through `decideBookingRequest({ clinicId, requestId }, …)`
 * with the sign-in and the passkey step-up as the actor; these tests reach a
 * request by the token its desk email carried, so this finds the request the
 * token names (as the migrator, never through the app) and decides it as a
 * desk actor of the clinic's own sign-in. tests/bookings-screen.test.ts
 * drives the portal itself, behind a real step-up.
 */

const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const VIEW_ACTOR = { type: "service", serviceName: "test-desk-view" } as const;

/** The clinic and request a desk token names, or null. */
export async function requestForToken(
  token: string,
): Promise<{ clinicId: string; requestId: string } | null> {
  if (!TOKEN.test(token)) return null;
  const hash = createHash("sha256").update(token, "utf8").digest();
  const { rows } = await getMigratorPool().query<{ clinic_id: string | null }>(
    `select app_booking_request_clinic($1::bytea) as clinic_id`,
    [hash],
  );
  const clinicId = rows[0]?.clinic_id;
  if (!clinicId) return null;
  const found = await inTenant(clinicId, (client) =>
    client.query<{ id: string }>(`select id from booking_requests where token_hash = $1`, [hash]),
  );
  const requestId = found.rows[0]?.id;
  return requestId ? { clinicId, requestId } : null;
}

/** A desk actor on the clinic's own sign-in (its first member), with a passkey and step-up id. */
export async function deskActorFor(
  clinicId: string,
  deviceLabel = "Front desk Mac",
): Promise<DeskActor> {
  const members = await inTenant(clinicId, (client) =>
    client.query<{ user_id: string }>(
      `select user_id from clinic_memberships where clinic_id = $1 order by granted_at, user_id limit 1`,
      [clinicId],
    ),
  );
  let userId = members.rows[0]?.user_id;
  if (!userId) {
    userId = `usr_desk_${randomUUID().slice(0, 8)}`;
    await getMigratorPool().query(
      `insert into "user" (id, name, email, email_verified, created_at, updated_at)
       values ($1, 'desk', $2, true, now(), now())`,
      [userId, `${userId}@example-clinic.test`],
    );
  }
  return { userId, passkeyId: randomUUID(), stepUpId: randomUUID(), deviceLabel };
}

const INVALID: DecisionOutcome = {
  outcome: "invalid",
  followUp: null,
  appointmentId: null,
  calendarWrite: null,
};

/** Decide the request a token names, as the clinic's desk. An unknown token is `invalid`. */
export async function deskDecide(
  token: string,
  decision: BookingDecision,
  input: Omit<DecisionInput, "actor"> & { actor?: DeskActor },
  send?: MetaSender,
): Promise<DecisionOutcome> {
  const target = await requestForToken(token);
  if (!target) return INVALID;
  return decideBookingRequest(
    target,
    decision,
    { ...input, actor: input.actor ?? (await deskActorFor(target.clinicId)) },
    send,
  );
}

/** Decide a request by its id, as the clinic's desk. */
export async function deskDecideById(
  clinicId: string,
  requestId: string,
  decision: BookingDecision,
  input: Omit<DecisionInput, "actor"> & { actor?: DeskActor },
  send?: MetaSender,
): Promise<DecisionOutcome> {
  return decideBookingRequest(
    { clinicId, requestId },
    decision,
    { ...input, actor: input.actor ?? (await deskActorFor(clinicId)) },
    send,
  );
}

/**
 * The request a token names as Bookings reads it, with its calendar's free
 * times when it is open, or null once its link's expiry has passed (as the
 * emailed page answered before M5).
 */
export async function deskView(token: string): Promise<BookingRequestView | null> {
  const target = await requestForToken(token);
  if (!target) return null;
  const view = await withTenant({ clinicId: target.clinicId, actor: VIEW_ACTOR }, async (tx) => {
    const [found] = await readBookingRequestViews(tx, { kind: "ids", ids: [target.requestId] });
    return found ?? null;
  });
  if (!view || view.expiresAt.getTime() <= Date.now()) return null;
  if (!view.lapsed && ["requested", "accepted", "rescheduling"].includes(view.status)) {
    view.calendar = await deskFreeTimes(target.clinicId, view, VIEW_ACTOR);
  }
  return view;
}
