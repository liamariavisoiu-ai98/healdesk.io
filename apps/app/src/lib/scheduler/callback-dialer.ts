import { and, eq, lt, notExists, sql } from "drizzle-orm";

import { appointments, auditLog } from "@/db/schema";
import { writeToCalendar } from "@/lib/booking/calendar";
import { dialDue, sweepOutboundCalls } from "@/lib/callbacks/dial";
import { listClinics } from "@/lib/ops/clinics";
import { expireLapsedRequests } from "@/lib/meta/booking-requests";
import { withTenant } from "@/lib/tenant";
import type { VoiceOutboundClient } from "@/lib/voice/outbound";

import { JOB_CALLBACK_DIALER, runJob } from "./jobs";

/**
 * The callback-dialer job (design of 23 September 2026, §F.11): every
 * fifteen minutes, under the `scheduled_jobs` switch like every other job,
 * so an operator turns it on deliberately once the counsel answers in §I.6
 * are on file — and the environment switch, the clinic switch and the
 * consent row still each say no on their own.
 *
 * Four things, in an order that matters:
 *
 *   1. The ledger sweeps (§F.4, §F.6): a `placed` call with no webhook for
 *      two hours becomes `unknown`, and an attempt-1 row that positively
 *      went unanswered gets its attempt-2 row. Before the dial, so a second
 *      attempt whose time has come is dialled in the same run.
 *   2. Expiry (§C.4): lapsed reschedules and expired links become
 *      `expired`, and their queued calls are cancelled. Before the dial, so
 *      no call is placed about a request that lapsed a minute ago.
 *   3. The dial (§F.5).
 *   4. The calendar read-back (§B.4): each appointment whose write timed out
 *      is retried once, which reads the vendor back before creating
 *      anything, so a slot is never booked twice.
 *
 * The vendor client is a parameter, never chosen here from the environment:
 * the worker passes the Synthflow client, a test passes the fixture.
 */
export async function runCallbackDialerJob(options: { now?: Date; client: VoiceOutboundClient }) {
  const now = options.now ?? new Date();
  return runJob(
    JOB_CALLBACK_DIALER,
    async () => {
      const swept = await sweepOutboundCalls(now);
      const lapsed = await expireLapsedRequests(now);
      const dialled = await dialDue(now, { client: options.client });
      const readBack = await retryUnknownCalendarWrites(now);
      return (
        `Placed ${dialled.placed}, failed ${dialled.failed}, refused ${dialled.refused}, deferred ${dialled.deferred} of ${dialled.considered} due; ` +
        `${swept.unknown} unknown, ${swept.secondAttempts} second attempt(s); ` +
        `${lapsed.expired} request(s) expired, ${lapsed.cancelledCalls} call(s) cancelled; ` +
        `${readBack.retried} calendar write(s) read back.`
      );
    },
    now,
  );
}

/** The unknown calendar-write read-back is not retried within this long of the write, so an in-flight vendor call is not raced. */
const READ_BACK_AFTER_MINUTES = 15;

/**
 * Retry, once, every appointment whose calendar write ended `unknown` (a
 * timeout or a dropped connection). `writeToCalendar` reads the vendor back
 * under the request's key before it creates anything, so this cannot book
 * a slot twice; "once" is enforced by the audit trail — a write that
 * already carries a `retry` row is left for the ops op `retryCalendarWrite`,
 * so an unreachable vendor does not cost one vendor call per appointment
 * per quarter hour forever.
 */
export async function retryUnknownCalendarWrites(now: Date): Promise<{ retried: number; written: number }> {
  let retried = 0;
  let written = 0;
  for (const clinic of await listClinics()) {
    const candidates = await withTenant({ clinicId: clinic.id, actor: { type: "service", serviceName: "callback-dialer" } }, (tx) =>
      tx.db
        .select({ id: appointments.id })
        .from(appointments)
        .where(
          and(
            eq(appointments.clinicId, tx.clinicId),
            eq(appointments.calendarWriteStatus, "unknown"),
            lt(appointments.updatedAt, new Date(now.getTime() - READ_BACK_AFTER_MINUTES * 60_000)),
            notExists(
              tx.db
                .select({ one: sql`1` })
                .from(auditLog)
                .where(and(eq(auditLog.clinicId, tx.clinicId), eq(auditLog.resourceType, "appointment"), sql`${auditLog.resourceId} = ${appointments.id}::text`, sql`${auditLog.metadata}->>'retry' = 'true'`)),
            ),
          ),
        ),
    );
    for (const { id } of candidates) {
      retried += 1;
      if ((await writeToCalendar(clinic.id, id, { now })) === "written") written += 1;
    }
  }
  return { retried, written };
}
