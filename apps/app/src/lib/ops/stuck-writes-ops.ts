import { and, eq, inArray, sql } from "drizzle-orm";

import { appointments, bookingRequests } from "@/db/schema";
import type { ActorContext, RequestContext } from "@/lib/audit";
import {
  CALENDAR_WRITE_REASONS,
  MAX_WRITE_ATTEMPTS,
  STUCK_CLAIM_MINUTES,
  WRITABLE_APPOINTMENT_STATUSES,
  writeReasonCode,
  type CalendarWriteReason,
} from "@/lib/booking/calendar";
import { isDemoClinic } from "@/lib/booking/terms";
import { describeError, log } from "@/lib/log";
import { withTenant } from "@/lib/tenant";

import { actorFor, booleanArg, ok, opsProblem, type Operator, type OpsOutcome } from "./api";
import { listClinics } from "./clinics";

/**
 * `listStuckCalendarWrites` (ops automation Phase 5, lane P5a; design E3
 * §2.3): every desk booking, across clinics, whose Google Calendar write has
 * not settled and whose slot has not started. A hand-written projection of
 * ids, codes, counts and the clinic's own name; the slot as whole days from
 * now, never a time; never the person, the service, the calendar's event or
 * Google's message.
 *
 *   - `failed`: Google, or our own check, said no. Never retried by the
 *     sweep (`retryable: false`); only an operator's retry.
 *   - `unknown`: no answer settled it, or a claim left `writing` for longer
 *     than STUCK_CLAIM_MINUTES. `retryable` when the sweep will try it again
 *     (fewer than five attempts and a reason it retries), with
 *     `nextAttemptAt` its next turn on the ladder, or null when it is due.
 *
 * Newest problem first (the row's last change), at most MAX_LISTED with
 * `truncated`, and `count` the whole number found. Demo clinics
 * (app_clinic_is_demo) are left out unless `includeDemo`. A clinic whose
 * tenant read fails is counted in `unreadClinics`, never read as none. Each
 * clinic with a row writes one access row, attributed to the operator, as
 * the per-clinic listCalendarWrites does.
 */

export const MAX_LISTED = 100;

export type StuckCalendarWrite = {
  clinicId: string;
  clinicName: string;
  appointmentId: string;
  status: "failed" | "unknown";
  /** One of ours (CALENDAR_WRITE_REASONS), or `other` for a word Google gave, or none. */
  reason: CalendarWriteReason | "other";
  attempts: number;
  /** When the sweep tries it next; null when it is due now or will not be tried again. */
  nextAttemptAt: string | null;
  /** Whole days until the slot: 0 within the next 24 hours. */
  slotInDays: number;
  /** Whether the sweep will try it again on its own. */
  retryable: boolean;
};

export type StuckCalendarWrites = {
  writes: StuckCalendarWrite[];
  count: number;
  truncated: boolean;
  /** Clinics whose read failed: their writes are not in the list, and not counted. */
  unreadClinics: number;
};

const DAY_MS = 24 * 60 * 60 * 1000;

export async function listStuckCalendarWrites(options: {
  actor: ActorContext;
  request?: RequestContext;
  includeDemo?: boolean;
  now?: Date;
  /** Test seam: the cap, MAX_LISTED unless given. */
  max?: number;
}): Promise<StuckCalendarWrites> {
  const now = options.now ?? new Date();
  const max = options.max ?? MAX_LISTED;
  const clinics = (await listClinics()).filter((c) => !c.destroyedAt);
  const found: (StuckCalendarWrite & { changedAt: number })[] = [];
  let unreadClinics = 0;
  for (const clinic of clinics) {
    try {
      const rows = await withTenant(
        { clinicId: clinic.id, actor: options.actor, request: options.request },
        async (tx) => {
          if (!options.includeDemo && (await isDemoClinic(tx))) return [];
          const listed = await tx.db
            .select({
              id: appointments.id,
              status: appointments.calendarWriteStatus,
              error: appointments.calendarWriteError,
              attempts: appointments.calendarWriteAttempts,
              nextAt: appointments.calendarWriteNextAt,
              scheduledFor: appointments.scheduledFor,
              updatedAt: appointments.updatedAt,
            })
            .from(appointments)
            .innerJoin(bookingRequests, eq(bookingRequests.appointmentId, appointments.id))
            .where(
              and(
                eq(appointments.clinicId, tx.clinicId),
                inArray(appointments.status, [...WRITABLE_APPOINTMENT_STATUSES]),
                sql`${appointments.scheduledFor} > ${now}`,
                sql`(${appointments.calendarWriteStatus} in ('failed', 'unknown')
                     or (${appointments.calendarWriteStatus} = 'writing'
                         and coalesce(${appointments.calendarWriteClaimedAt}, ${appointments.updatedAt})
                             < ${now}::timestamptz - make_interval(mins => ${STUCK_CLAIM_MINUTES})))`,
              ),
            );
          if (listed.length > 0) {
            tx.audit.record({
              action: "read",
              resourceType: "appointment_calendar_write",
              resourceId: tx.clinicId,
              resultCount: listed.length,
              metadata: { purpose: "stuck_calendar_writes" },
            });
          }
          return listed;
        },
      );
      for (const row of rows) {
        const status = row.status === "failed" ? "failed" : "unknown";
        const reason = writeReasonCode(row.error);
        const retryable =
          status === "unknown" &&
          row.attempts < MAX_WRITE_ATTEMPTS &&
          (reason === "other" || CALENDAR_WRITE_REASONS[reason] !== "settled");
        const waiting = retryable && row.status === "unknown" && row.nextAt !== null && row.nextAt > now;
        found.push({
          clinicId: clinic.id,
          clinicName: clinic.name,
          appointmentId: row.id,
          status,
          reason,
          attempts: row.attempts,
          nextAttemptAt: waiting ? row.nextAt!.toISOString() : null,
          slotInDays: Math.max(0, Math.floor((row.scheduledFor.getTime() - now.getTime()) / DAY_MS)),
          retryable,
          changedAt: row.updatedAt.getTime(),
        });
      }
    } catch (error) {
      unreadClinics += 1;
      log.error("stuck calendar writes: a clinic could not be read", {
        clinicId: clinic.id,
        error: describeError(error),
      });
    }
  }
  found.sort((a, b) => b.changedAt - a.changedAt || a.appointmentId.localeCompare(b.appointmentId));
  return {
    writes: found.slice(0, max).map(({ changedAt: _changedAt, ...write }) => write),
    count: found.length,
    truncated: found.length > max,
    unreadClinics,
  };
}

/** The ops operation: `includeDemo` (boolean, default false) and nothing else. */
export async function opListStuckCalendarWrites(
  args: Record<string, unknown>,
  operator: Operator,
): Promise<OpsOutcome> {
  const unknown = Object.keys(args).filter((key) => key !== "includeDemo");
  if (unknown.length > 0 || (args.includeDemo !== undefined && typeof args.includeDemo !== "boolean")) {
    return opsProblem("listStuckCalendarWrites takes only includeDemo, a boolean.", 400, "invalid_args");
  }
  try {
    return ok(
      await listStuckCalendarWrites({
        actor: actorFor(operator),
        request: operator.request,
        includeDemo: booleanArg(args, "includeDemo") ?? false,
      }),
    );
  } catch (error) {
    log.error("stuck calendar writes not listed", { error: describeError(error) });
    return opsProblem("The stuck calendar writes could not be read.", 500, "failed");
  }
}
