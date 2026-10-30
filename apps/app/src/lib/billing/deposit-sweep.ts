import { and, eq, inArray, lt, ne, notExists, sql } from "drizzle-orm";

import { unsafeDb } from "@/db";
import { appointments, depositPayments } from "@/db/schema";
import type { ActorContext } from "@/lib/audit";
import { flagForFrontDesk } from "@/lib/billing/deposits";
import { describeError, log } from "@/lib/log";
import { withTenant } from "@/lib/tenant";

/**
 * The backstop for a chat deposit whose link was never made (DEPOSIT-01).
 *
 * A website chat booking that owes a deposit (`collect`) is written as
 * `pending_link`, with its amount, in the booking's own transaction
 * (lib/meta/booking-requests.ts insertAppointment); the link is made after
 * that, outside it (lib/booking/deposit-gate.ts chatDepositFor), because
 * createDepositLink never calls Stripe inside a transaction. A process that
 * dies between the two, or a fault that escapes chatDepositFor, used to leave
 * the booking owing a deposit nobody had been asked for or told about. Now
 * the obligation is on the row before anything else can fail, and this sweep
 * finds any `pending_link` appointment with no link that is open or paid
 * once the grace below has passed.
 *
 * It only ever hands the deposit to the front desk (flagForFrontDesk:
 * `pending_front_desk` and the L10 alert, ids only). It never makes the link
 * late: the chat that would have shown it has moved on, and sending it to the
 * patient afterwards would be contacting them after the conversation, which
 * v1 never does. One flag per booking however often it runs: the move is
 * conditional on `pending_link`, and the alert goes only with the move.
 *
 * A link that was made and then expires or fails unpaid is handed to the
 * desk by recordDepositLapsed when Stripe says so; flagStaleOpenDepositsFor,
 * below, is the backstop when Stripe's word never arrives.
 */

/**
 * Long enough that the chat's own link, made seconds after the booking (a
 * Stripe call has a 20-second timeout and one retry), is never raced; short
 * enough that the desk hears while the patient may still be reachable.
 */
export const UNLINKED_DEPOSIT_GRACE_MS = 10 * 60 * 1000;

const SWEEP_ACTOR: ActorContext = { type: "service", serviceName: "deposit-sweep" };

/** Flag one clinic's unlinked deposits older than the grace; returns how many were flagged. */
export async function flagUnlinkedDepositsFor(clinicId: string, now: Date): Promise<number> {
  return withTenant({ clinicId, actor: SWEEP_ACTOR }, async (tx) => {
    const due = await tx.db
      .select({ id: appointments.id })
      .from(appointments)
      .where(
        and(
          eq(appointments.clinicId, tx.clinicId),
          eq(appointments.depositStatus, "pending_link"),
          ne(appointments.status, "cancelled"),
          lt(appointments.createdAt, new Date(now.getTime() - UNLINKED_DEPOSIT_GRACE_MS)),
          notExists(
            tx.db
              .select({ one: sql`1` })
              .from(depositPayments)
              .where(
                and(
                  eq(depositPayments.clinicId, tx.clinicId),
                  eq(depositPayments.appointmentId, appointments.id),
                  inArray(depositPayments.status, ["open", "paid"]),
                ),
              ),
          ),
        ),
      )
      .for("update", { of: appointments, skipLocked: true });
    let flagged = 0;
    for (const row of due) {
      if (!(await flagForFrontDesk(tx, row.id))) continue;
      flagged += 1;
      tx.audit.record({
        action: "update",
        resourceType: "appointment",
        resourceId: row.id,
        metadata: { outcome: "deposit_to_front_desk", reason: "link_never_made" },
      });
    }
    return flagged;
  });
}

/**
 * How long after a link's expiry Stripe's checkout.session.expired event is
 * waited for before the sweep hands the deposit over itself.
 */
export const OPEN_LINK_EXPIRY_GRACE_MS = 30 * 60 * 1000;

/**
 * The backstop for a link that was made and is past its expiry with no word
 * from Stripe: the event lost (the host in standby, a dropped webhook), or
 * a process that died after making the link (the payment-link text after a
 * call, lib/sms/payment-text.ts, between the link and the send). The booking
 * would otherwise sit `pending_link`, "Deposit not paid yet", and nobody
 * would be told. Nobody checked whether it was paid, so it goes to the
 * front desk as possibly paid (the L10 that says to check Stripe first),
 * keyed by the link, and only from `pending_link`: once per link however
 * often it runs, and a late Stripe event that follows changes nothing.
 */
export async function flagStaleOpenDepositsFor(clinicId: string, now: Date): Promise<number> {
  return withTenant({ clinicId, actor: SWEEP_ACTOR }, async (tx) => {
    const due = await tx.db
      .select({ id: depositPayments.id, appointmentId: depositPayments.appointmentId })
      .from(depositPayments)
      .innerJoin(
        appointments,
        and(eq(appointments.id, depositPayments.appointmentId), eq(appointments.clinicId, depositPayments.clinicId)),
      )
      .where(
        and(
          eq(depositPayments.clinicId, tx.clinicId),
          eq(depositPayments.status, "open"),
          lt(depositPayments.expiresAt, new Date(now.getTime() - OPEN_LINK_EXPIRY_GRACE_MS)),
          eq(appointments.depositStatus, "pending_link"),
          ne(appointments.status, "cancelled"),
        ),
      )
      .for("update", { of: appointments, skipLocked: true });
    let flagged = 0;
    for (const row of due) {
      if (!row.appointmentId) continue;
      if (!(await flagForFrontDesk(tx, row.appointmentId, { mayBePaid: true, depositId: row.id }))) continue;
      flagged += 1;
      tx.audit.record({
        action: "update",
        resourceType: "appointment",
        resourceId: row.appointmentId,
        metadata: { outcome: "deposit_to_front_desk", reason: "link_expired_unannounced" },
      });
    }
    return flagged;
  });
}

/** Every clinic's unlinked deposits: from the billing minute clock, and the hourly tick as its backstop. */
type ClinicSweep = (clinicId: string, now: Date) => Promise<number>;

/** The sweep's checks, each run on its own so one failing never skips another. */
const CHECKS: ReadonlyArray<{ check: ClinicSweep; failed: string }> = [
  { check: flagUnlinkedDepositsFor, failed: "unlinked deposits not swept" },
  { check: flagStaleOpenDepositsFor, failed: "expired open deposit links not swept" },
];

/** Every clinic's unlinked deposits: from the billing minute clock, and the hourly tick as its backstop. */
export async function sweepUnlinkedDeposits(
  now: Date = new Date(),
  /** The checks, for a test that makes one fail; the two above otherwise. */
  checks: ReadonlyArray<{ check: ClinicSweep; failed: string }> = CHECKS,
): Promise<{ clinics: number; flagged: number; failures: number }> {
  const result = await unsafeDb.execute<{ id: string }>(
    sql`select id from app_clinics_overview() where destroyed_at is null`,
  );
  const ids = ((result as unknown as { rows?: { id: string }[] }).rows ?? []).map((r) =>
    String(r.id),
  );
  const summary = { clinics: ids.length, flagged: 0, failures: 0 };
  for (const clinicId of ids) {
    for (const { check, failed } of checks) {
      try {
        summary.flagged += await check(clinicId, now);
      } catch (error) {
        summary.failures += 1;
        log.error(failed, { clinicId, error: describeError(error) });
      }
    }
  }
  if (summary.flagged > 0) {
    log.warn("deposits whose link was never made, left to the front desk", {
      count: summary.flagged,
    });
  }
  return summary;
}
