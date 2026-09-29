import {
  canWriteBookings,
  getAdapter,
  type CanonicalSlot,
  type ConnectorAdapter,
  type ConnectorContext,
  type ConnectorError,
} from "@healdesk/connectors";
import { and, eq, inArray, isNotNull } from "drizzle-orm";

import { appointments, bookingRequests, clinics, contacts, providerConnections, type CalendarWriteStatus, type PhiBasis } from "@/db/schema";
import type { ActorContext } from "@/lib/audit";
import { withCredentials } from "@/lib/connections/store";
import { describeError, log } from "@/lib/log";
import { withTenant, type TenantTx } from "@/lib/tenant";

/**
 * The calendar write (design of 23 September 2026, §B.3–B.4).
 *
 * The one write the connector port allows — add the appointment the desk
 * confirmed, or the assistant booked where the practice elected direct
 * booking — reaches the vendor from here and nowhere else. Three things this
 * file guarantees, in order of how expensive it would be to get them wrong:
 *
 *   1. **Never twice.** Cal.com has no idempotency key, so a create whose
 *      reply never arrived (`timeout`, `network`, `unconfirmed`) may or may
 *      not have booked the slot. The appointment row's `calendar_write_status`
 *      is the state machine: a conditional UPDATE to `writing` stops a second
 *      click starting a second write while the first is in flight, and every
 *      attempt after the very first reads the vendor back by our own key
 *      (`bookings+{requestId}@sink.healdesk.io` + `healdesk_request_id`)
 *      before it creates anything, adopting what it finds.
 *   2. **Never inside a transaction.** The credential is decrypted in one
 *      short transaction (the pattern of lib/sync/run.ts `openContext`), the
 *      vendor is called with none open, and the outcome is recorded in
 *      another. A vendor that takes eight seconds to time out must not hold
 *      a pooled connection and a snapshot for eight seconds.
 *   3. **Never a phone number.** The port's input type has no phone field
 *      and the fixture refuses one at runtime; what crosses is a first name
 *      (plus the last name only when the practice asked for it and it was
 *      collected), a healdesk-controlled sink address, the service name and
 *      the time. The vendor holds PHI either way, which is why a connection
 *      is writable only with a recorded `phi_basis`.
 *
 * The local appointment row is never deleted on a failed write: the desk's
 * click is the booking, and the page tells the desk to add it by hand.
 */

export type CalendarWriteOutcome = "written" | "failed" | "unknown" | "not-connected";

/** The attendee address on every booking we create: a mailbox we own and nobody reads. Doubles as the read-back filter. */
export const SINK_MAIL_DOMAIN = "sink.healdesk.io";

export function attendeeEmailFor(requestId: string): string {
  return `bookings+${requestId}@${SINK_MAIL_DOMAIN}`;
}

/** Cap on what the desk page lists, and on how many of one day's slots it shows. */
export const MAX_LISTED_SLOTS = 40;
export const MAX_SLOTS_PER_DAY = 6;

/** Failure reasons after which the vendor may still hold the booking. Anything else is an answer, and the answer was no. */
const UNKNOWN_OUTCOME_REASONS: ReadonlySet<string> = new Set(["timeout", "network", "unconfirmed"]);

const WRITE_ACTOR: ActorContext = { type: "service", serviceName: "calendar-write" };

export type WritableConnection = {
  connectionId: string;
  provider: string;
  adapter: ConnectorAdapter;
  metadata: Record<string, unknown> | null;
  phiBasis: PhiBasis;
};

/**
 * The clinic's one connection we may write into, or null.
 *
 * Active, its adapter declares all three write-side methods, and — the part
 * that is policy rather than plumbing — a lawful basis for the vendor to hold
 * a name, a service and a time is recorded on the row. A Cal.com key with no
 * `phi_basis` is a read-only connection to us, whatever the API allows.
 */
export async function writableConnection(tx: TenantTx): Promise<WritableConnection | null> {
  const rows = await tx.db
    .select({ id: providerConnections.id, provider: providerConnections.provider, metadata: providerConnections.metadata, phiBasis: providerConnections.phiBasis })
    .from(providerConnections)
    .where(and(eq(providerConnections.clinicId, tx.clinicId), eq(providerConnections.status, "active"), isNotNull(providerConnections.phiBasis)))
    .orderBy(providerConnections.createdAt);
  for (const row of rows) {
    const adapter = getAdapter(row.provider);
    if (!adapter || !canWriteBookings(adapter.capabilities) || !row.phiBasis) continue;
    return { connectionId: row.id, provider: row.provider, adapter, metadata: (row.metadata as Record<string, unknown> | null) ?? null, phiBasis: row.phiBasis };
  }
  return null;
}

export type CalendarSlot = { at: string; label: string };

/** "Thu 26 Sep, 2:00 PM", in the clinic's own clock. What the desk reads and what the person is told on a callback. */
export function slotLabel(at: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).formatToParts(at);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("weekday")} ${get("day")} ${get("month")}, ${get("hour")}:${get("minute")} ${get("dayPeriod")}`;
}

const WEEKDAY_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

/** The weekdays a person named in free text ("Thursday after 4", "mondays or tuesdays"), as 0–6. */
export function namedWeekdays(windows: readonly string[]): Set<number> {
  const out = new Set<number>();
  for (const window of windows) {
    for (const match of window.matchAll(/\b(sun|mon|tue|wed|thu|fri|sat)[a-z]*\b/gi)) {
      out.add(WEEKDAY_NAMES.indexOf(match[1]!.toLowerCase()));
    }
  }
  return out;
}

/**
 * Free slots for the next `days` days, from the writable connection, ordered
 * for a desk that has the person's three windows in front of it: the days
 * they named come first, then the rest, each day contributing a spread of at
 * most MAX_SLOTS_PER_DAY and the whole capped at MAX_LISTED_SLOTS. Empty when
 * the clinic has no writable connection or the vendor did not answer — the
 * page then offers the typed time and the write is still attempted.
 */
export async function slotsFor(tx: TenantTx, days = 14, opts: { preferred?: readonly string[]; now?: Date } = {}): Promise<CalendarSlot[]> {
  const writable = await writableConnection(tx);
  if (!writable || !writable.adapter.listSlots) return [];
  const [clinic] = await tx.db.select({ timezone: clinics.timezone }).from(clinics).where(eq(clinics.id, tx.clinicId)).limit(1);
  const timeZone = clinic?.timezone ?? "America/New_York";
  const now = opts.now ?? new Date();
  const window = { from: now, to: new Date(now.getTime() + days * 86_400_000) };
  const durationMinutes = positiveInt(writable.metadata?.durationMinutes);

  let slots: CanonicalSlot[];
  try {
    tx.audit.record({ action: "decrypt", resourceType: "credential", resourceId: writable.connectionId, metadata: { provider: writable.provider, purpose: "list_slots" } });
    const result = await withCredentials(tx.db, { clinicId: tx.clinicId, connectionId: writable.connectionId }, (credentials) =>
      writable.adapter.listSlots!(
        { clinicId: tx.clinicId, connectionId: writable.connectionId, credentials, metadata: writable.metadata ?? undefined },
        window,
        { timeZone, durationMinutes },
      ),
    );
    if (!result.ok) {
      log.warn("calendar slots not listed", { clinicId: tx.clinicId, connectionId: writable.connectionId, provider: writable.provider, reason: result.error.reason ?? result.error.code });
      return [];
    }
    slots = result.value;
  } catch (error) {
    log.warn("calendar slots threw", { clinicId: tx.clinicId, connectionId: writable.connectionId, provider: writable.provider, error: describeError(error) });
    return [];
  }

  return arrangeSlots(slots, { timeZone, now, named: namedWeekdays(opts.preferred ?? []) });
}

/** Pure: future slots, grouped by local day, named days first, spread and capped. Exported for tests. */
export function arrangeSlots(slots: readonly CanonicalSlot[], input: { timeZone: string; now: Date; named: Set<number> }): CalendarSlot[] {
  const dayKey = new Intl.DateTimeFormat("en-CA", { timeZone: input.timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
  const weekdayOf = new Intl.DateTimeFormat("en-US", { timeZone: input.timeZone, weekday: "short" });
  const byDay = new Map<string, { weekday: number; slots: Date[] }>();
  for (const slot of [...slots].sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime())) {
    if (slot.startsAt.getTime() <= input.now.getTime()) continue;
    const key = dayKey.format(slot.startsAt);
    let day = byDay.get(key);
    if (!day) {
      day = { weekday: WEEKDAY_NAMES.indexOf(weekdayOf.format(slot.startsAt).toLowerCase()), slots: [] };
      byDay.set(key, day);
    }
    day.slots.push(slot.startsAt);
  }
  const days = [...byDay.entries()].sort(([ka, a], [kb, b]) => {
    const na = input.named.has(a.weekday) ? 0 : 1;
    const nb = input.named.has(b.weekday) ? 0 : 1;
    return na !== nb ? na - nb : ka.localeCompare(kb);
  });
  const out: CalendarSlot[] = [];
  for (const [, day] of days) {
    for (const at of spread(day.slots, MAX_SLOTS_PER_DAY)) {
      if (out.length >= MAX_LISTED_SLOTS) return out;
      out.push({ at: at.toISOString(), label: slotLabel(at, input.timeZone) });
    }
  }
  return out;
}

/** Up to `n` items spaced evenly across the list, first and last included. */
function spread<T>(items: readonly T[], n: number): T[] {
  if (items.length <= n) return [...items];
  const out: T[] = [];
  for (let i = 0; i < n; i += 1) out.push(items[Math.round((i * (items.length - 1)) / (n - 1))]!);
  return out;
}

function positiveInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

type Prepared = {
  context: ConnectorContext;
  adapter: ConnectorAdapter;
  provider: string;
  requestId: string;
  scheduledFor: Date;
  attendeeName: string;
  service: string | null;
  timeZone: string;
  durationMinutes: number | null;
  /** What the row said before we claimed it: `none` is the very first attempt; anything else reads back first. */
  previous: CalendarWriteStatus;
};

type Prepare = { kind: "go"; prepared: Prepared } | { kind: "done"; outcome: CalendarWriteOutcome };

/**
 * Write one appointment into the clinic's calendar (§B.4), after the
 * transaction that created it has committed.
 *
 * Runs from `none` and `unknown` by default; `fromFailed` lets the ops op
 * retry a write the vendor refused, after someone has looked at why. Every
 * path returns the outcome and leaves the row in the matching state; the
 * appointment itself is never touched beyond its calendar columns.
 */
export async function writeToCalendar(
  clinicId: string,
  appointmentId: string,
  opts: { fromFailed?: boolean; actor?: ActorContext; now?: Date } = {},
): Promise<CalendarWriteOutcome> {
  const actor = opts.actor ?? WRITE_ACTOR;
  const allowed: CalendarWriteStatus[] = opts.fromFailed ? ["none", "unknown", "failed"] : ["none", "unknown"];

  // 1. Claim the row and open the credential, in one short transaction.
  const step = await withTenant({ clinicId, actor }, async (tx): Promise<Prepare> => {
    const [row] = await tx.db
      .select({
        status: appointments.calendarWriteStatus,
        scheduledFor: appointments.scheduledFor,
        treatment: appointments.treatment,
        requestId: bookingRequests.id,
        collectedFields: bookingRequests.collectedFields,
        firstName: contacts.fullName,
        timeZone: clinics.timezone,
      })
      .from(appointments)
      .innerJoin(bookingRequests, eq(bookingRequests.appointmentId, appointments.id))
      .innerJoin(contacts, eq(contacts.id, appointments.contactId))
      .innerJoin(clinics, eq(clinics.id, appointments.clinicId))
      .where(and(eq(appointments.id, appointmentId), eq(appointments.clinicId, tx.clinicId)))
      .limit(1);
    if (!row) throw new Error("Calendar write: no such appointment on a booking request.");
    if (row.status === "written") return { kind: "done", outcome: "written" };

    const writable = await writableConnection(tx);
    if (!writable || !writable.adapter.createAppointment || !writable.adapter.findAppointmentByKey) return { kind: "done", outcome: "not-connected" };

    // The guard: whoever moves the row to `writing` owns the attempt.
    const [claimed] = await tx.db
      .update(appointments)
      .set({ calendarWriteStatus: "writing", updatedAt: new Date() })
      .where(and(eq(appointments.id, appointmentId), eq(appointments.clinicId, tx.clinicId), inArray(appointments.calendarWriteStatus, allowed)))
      .returning({ id: appointments.id });
    if (!claimed) {
      // In flight, or refused and not asked to retry: report what the row says.
      return { kind: "done", outcome: row.status === "failed" ? "failed" : "unknown" };
    }

    tx.audit.record({ action: "decrypt", resourceType: "credential", resourceId: writable.connectionId, metadata: { provider: writable.provider, purpose: "calendar_write" } });
    const context = await withCredentials(tx.db, { clinicId, connectionId: writable.connectionId }, async (credentials) => ({
      clinicId,
      connectionId: writable.connectionId,
      credentials,
      metadata: writable.metadata ?? undefined,
    }));

    const lastName = row.collectedFields.last_name?.trim();
    const attendeeName = [row.firstName?.trim() || "Patient", lastName].filter(Boolean).join(" ");
    return {
      kind: "go",
      prepared: {
        context,
        adapter: writable.adapter,
        provider: writable.provider,
        requestId: row.requestId,
        scheduledFor: row.scheduledFor,
        attendeeName,
        service: row.treatment ?? row.collectedFields.service ?? null,
        timeZone: row.timeZone,
        durationMinutes: positiveInt(writable.metadata?.durationMinutes) ?? null,
        previous: row.status,
      },
    };
  });
  if (step.kind === "done") return step.outcome;
  const p = step.prepared;

  // 2. The vendor, with no transaction open.
  const attendeeEmail = attendeeEmailFor(p.requestId);
  let outcome: CalendarWriteOutcome;
  let externalId: string | null = null;
  let reason: string | null = null;
  let adopted = false;
  try {
    // Every attempt but the very first reads back first: a timed-out create
    // may have booked the slot, and creating again would book it twice.
    let found: { externalId: string } | null = null;
    let readBackFailed: ConnectorError | null = null;
    if (p.previous !== "none") {
      const back = await p.adapter.findAppointmentByKey!(p.context, { idempotencyKey: p.requestId, attendeeEmail, around: p.scheduledFor });
      if (back.ok) found = back.value;
      else readBackFailed = back.error;
    }
    if (readBackFailed) {
      outcome = "unknown";
      reason = readBackFailed.reason ?? readBackFailed.code;
    } else if (found) {
      outcome = "written";
      externalId = found.externalId;
      adopted = true;
    } else {
      const created = await p.adapter.createAppointment!(p.context, {
        startsAt: p.scheduledFor,
        durationMinutes: p.durationMinutes,
        attendee: { name: p.attendeeName, email: attendeeEmail, timeZone: p.timeZone },
        service: p.service,
        idempotencyKey: p.requestId,
      });
      if (created.ok) {
        outcome = "written";
        externalId = created.value.externalId;
      } else {
        reason = created.error.reason ?? created.error.code;
        outcome = UNKNOWN_OUTCOME_REASONS.has(reason) ? "unknown" : "failed";
      }
    }
  } catch (error) {
    // An adapter that throws rather than returning a Result has told us
    // nothing about the vendor's state: unknown, and read back next time.
    log.error("calendar write threw", { clinicId, connectionId: p.context.connectionId, provider: p.provider, error: describeError(error) });
    outcome = "unknown";
    reason = "threw";
  }

  // 3. Record it.
  const now = opts.now ?? new Date();
  await withTenant({ clinicId, actor }, async (tx) => {
    await tx.db
      .update(appointments)
      .set({
        calendarWriteStatus: outcome === "written" ? "written" : outcome,
        calendarWrittenAt: outcome === "written" ? now : null,
        calendarWriteError: outcome === "written" ? null : reason?.slice(0, 80) ?? null,
        ...(outcome === "written" && externalId ? { externalAppointmentId: externalId, externalSource: p.provider } : {}),
        updatedAt: now,
      })
      .where(and(eq(appointments.id, appointmentId), eq(appointments.clinicId, tx.clinicId)));
    tx.audit.record({
      action: "update",
      resourceType: "appointment",
      resourceId: appointmentId,
      metadata: { calendarWrite: outcome, provider: p.provider, adopted: adopted || undefined, reason: reason ?? undefined, retry: p.previous !== "none" || undefined },
    });
  });
  return outcome;
}
