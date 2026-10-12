import { randomUUID } from "node:crypto";

import { audienceFor, GOOGLE_CALENDAR_DISCLOSURE_COMPATIBLE } from "@healdesk/catalog";
import {
  GOOGLE_CALENDAR_PROVIDER,
  googleCalendarAdapter,
  type CanonicalSlot,
  type ConnectorContext,
  type ConnectorError,
  type GoogleOAuthClient,
} from "@healdesk/connectors";
import { and, eq, sql } from "drizzle-orm";

import {
  agentConfigs,
  appointments,
  bookingRequests,
  clinics,
  contacts,
  type CalendarWriteStatus,
} from "@/db/schema";
import type { ActorContext } from "@/lib/audit";
import {
  calendarBreakOf,
  confirmCalendarTarget,
  googleCalendarConnection,
  googleOAuthClient,
  markCalendarBroken,
} from "@/lib/connections/google-calendar";
import { withCredentials } from "@/lib/connections/store";
import { describeError, log } from "@/lib/log";
import { listClinics } from "@/lib/ops/clinics";
import { withTenant, type TenantTx } from "@/lib/tenant";

import { serviceDuration } from "./availability";
import { calendarTermsFor, type CalendarTermsInEffect } from "./terms";

/**
 * The desk path's calendar write (plan §7.12; design of 23 September 2026,
 * §B.3–B.4): the appointment staff confirmed from a request, added to the
 * location's Google Calendar after the decision has committed.
 *
 * v1 writes to Google Calendar and nothing else (v1 spec, "Where bookings
 * are written"), and only where the location's calendar terms let healdesk
 * write (covered or uncovered, lib/booking/terms.ts). The target is the
 * location's Google connection when it is healthy, of the account kind the
 * terms name, accepted under a notice still compatible, and the location is
 * not leaving (writableConnection); the database says the same before any
 * write may start (app_appointment_write_guard, drizzle/0059). The
 * assistant's own bookings are the engine's (lib/booking/engine.ts, C13),
 * through a hold, never through here.
 *
 * Four things this file guarantees, in order of how expensive it would be to
 * get them wrong:
 *
 *   1. **Never twice.** Google keys the event by an id derived from the
 *      booking (`calendar_event_key`, else the request's id), so a create
 *      Google has already seen answers 409 and is read back, never doubled.
 *      The appointment's `calendar_write_status` is the state machine: a
 *      conditional UPDATE to `writing` with a fresh lease is the claim, a
 *      claim stuck for two minutes is taken over, every attempt after the
 *      first reads Google back before it creates anything, and the outcome
 *      is recorded only by the lease that made the attempt. Five attempts
 *      at most.
 *   2. **Never inside a transaction.** The token is decrypted in one short
 *      transaction, Google is called with none open, and the outcome is
 *      recorded in another.
 *   3. **Never more than the terms promise.** A first name (or the
 *      practice's word for the person, "Client" at a vet), the service as
 *      the clinic's own list names it, and the time; no attendee, no
 *      address, no phone number (packages/connectors/src/google/event.ts).
 *      Every insert is preceded by HRC-04's check that the calendar is still
 *      one the location may book into (confirmCalendarTarget), failing
 *      closed.
 *   4. **Never a guess at staff's work.** Where the terms allow writing but
 *      no healthy calendar is there, the row is `failed` with
 *      `calendar_not_connected` and the desk is told to add it by hand; it
 *      is never written later on its own, so a reconnect cannot duplicate a
 *      booking staff typed in themselves. A booking the clinic deleted in
 *      Google is never written again.
 *
 * The appointment row is never deleted on a failed write: the desk's click
 * is the booking.
 */

export type CalendarWriteOutcome = "written" | "failed" | "unknown" | "not-connected";

/** Cap on what the desk page lists, and on how many of one day's slots it shows. */
export const MAX_LISTED_SLOTS = 40;
export const MAX_SLOTS_PER_DAY = 6;

/** A claim older than this is stuck: its writer died or hung, and the next attempt takes it over. */
export const STUCK_CLAIM_MINUTES = 2;
/** The desk path stops claiming a write after this many attempts. */
export const MAX_WRITE_ATTEMPTS = 5;

/** Failure reasons after which Google may still hold the booking. Anything else is an answer. */
const UNKNOWN_OUTCOME_REASONS: ReadonlySet<string> = new Set(["timeout", "network", "unconfirmed"]);

const WRITE_ACTOR: ActorContext = { type: "service", serviceName: "calendar-write" };

/** The location's Google Calendar, when healdesk may write to it now. */
export type WritableConnection = {
  connectionId: string;
  provider: typeof GOOGLE_CALENDAR_PROVIDER;
  /** Where the right to write comes from: the location's calendar terms, never a basis on the row. */
  phiBasis: "calendar_terms";
  /** The connection's metadata as stored; the account's email lives here, for the clinic only. */
  metadata: Record<string, unknown>;
  /** The location's own calendar (metadata.calendarId, `primary` by default). */
  calendarId: string;
  /** Which sealing of the token this is, for markCalendarBroken. */
  credentialVersion: string;
  managed: boolean | null;
  terms: CalendarTermsInEffect;
  oauthClient: GoogleOAuthClient;
};

/**
 * The location's Google Calendar when healdesk may write to it now, or null
 * (plan §8.3): the terms allow writing; the connection is active or degraded
 * and not broken; its account is the kind the terms name; it was accepted
 * under a notice still compatible; the location is not leaving; and
 * healdesk's Google client is set. The same line as
 * app_calendar_write_permitted(clinic, false), plus the two facts only the
 * application holds (the notice and the client).
 */
export async function writableConnection(tx: TenantTx): Promise<WritableConnection | null> {
  const terms = await calendarTermsFor(tx);
  if (terms.kind !== "covered" && terms.kind !== "uncovered") return null;
  const oauthClient = googleOAuthClient();
  if (!oauthClient) return null;
  const connection = await googleCalendarConnection(tx);
  if (!connection || connection.brokenAt !== null) return null;
  if (connection.status !== "active" && connection.status !== "degraded") return null;
  if (connection.managed !== (terms.account !== "personal")) return null;
  const disclosure = connection.metadata.disclosureVersion;
  if (
    typeof disclosure !== "string" ||
    !GOOGLE_CALENDAR_DISCLOSURE_COMPATIBLE.includes(disclosure)
  ) {
    return null;
  }
  const [clinic] = await tx.db
    .select({ offboarding: clinics.offboardingStartedAt, destroyed: clinics.destroyedAt })
    .from(clinics)
    .where(eq(clinics.id, tx.clinicId))
    .limit(1);
  if (!clinic || clinic.offboarding || clinic.destroyed) return null;
  return {
    connectionId: connection.id,
    provider: GOOGLE_CALENDAR_PROVIDER,
    phiBasis: "calendar_terms",
    metadata: connection.metadata,
    calendarId: connection.calendarId,
    credentialVersion: connection.credentialVersion,
    managed: connection.managed,
    terms,
    oauthClient,
  };
}

export type CalendarSlot = { at: string; label: string };

/** "Thu 26 Sep, 2:00 PM", in the clinic's own clock. What the desk reads. */
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
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value ?? "";
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

/** Pure: future slots, grouped by local day, named days first, spread and capped. Exported for tests. */
export function arrangeSlots(
  slots: readonly CanonicalSlot[],
  input: { timeZone: string; now: Date; named: Set<number> },
): CalendarSlot[] {
  const dayKey = new Intl.DateTimeFormat("en-CA", {
    timeZone: input.timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const weekdayOf = new Intl.DateTimeFormat("en-US", {
    timeZone: input.timeZone,
    weekday: "short",
  });
  const byDay = new Map<string, { weekday: number; slots: Date[] }>();
  for (const slot of [...slots].sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime())) {
    if (slot.startsAt.getTime() <= input.now.getTime()) continue;
    const key = dayKey.format(slot.startsAt);
    let day = byDay.get(key);
    if (!day) {
      day = {
        weekday: WEEKDAY_NAMES.indexOf(weekdayOf.format(slot.startsAt).toLowerCase()),
        slots: [],
      };
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

// -----------------------------------------------------------------------------
// The write (plan §7.12)
// -----------------------------------------------------------------------------

type Prepared = {
  context: ConnectorContext;
  target: WritableConnection;
  calendarId: string;
  lease: string;
  /** The key the event id is derived from: calendar_event_key, else the request's id. */
  eventKey: string;
  scheduledFor: Date;
  durationMinutes: number | null;
  firstName: string;
  service: string | null;
  timeZone: string;
  audience: "patients" | "clients";
  origin: "assistant" | "desk";
  /** An attempt was made before this one (a retry or a takeover): read Google back first. */
  readBackFirst: boolean;
};

type Prepare = { kind: "go"; prepared: Prepared } | { kind: "done"; outcome: CalendarWriteOutcome };

/**
 * Write one appointment into the location's Google Calendar (plan §7.12),
 * after the transaction that created it has committed.
 *
 * Claims from `none` and `unknown` by default, and from a `writing` claim
 * stuck for two minutes; `fromFailed` lets the ops op retry a write Google
 * refused, after someone has looked at why. Every path returns the outcome
 * and leaves the row in the matching state; the appointment itself is never
 * touched beyond its calendar columns.
 */
export async function writeToCalendar(
  clinicId: string,
  appointmentId: string,
  opts: { fromFailed?: boolean; actor?: ActorContext; now?: Date } = {},
): Promise<CalendarWriteOutcome> {
  const actor = opts.actor ?? WRITE_ACTOR;
  const allowed: CalendarWriteStatus[] = opts.fromFailed
    ? ["none", "unknown", "failed"]
    : ["none", "unknown"];

  // 1. Claim the row and open the credential, in one short transaction.
  let step: Prepare;
  try {
    step = await withTenant({ clinicId, actor }, (tx) => claim(tx, appointmentId, allowed));
  } catch (error) {
    // The write guard (drizzle/0059) refused the claim: the terms or the
    // connection changed between our read and the claim, and nothing was
    // written. The terms allowed writing a moment ago, so this is the
    // no-healthy-calendar case: staff add it by hand, and it is never
    // written later on its own (plan §7.12). Any other refusal is a bug.
    if (codeOf(error) !== "23514" || constraintOf(error) !== WRITE_PERMITTED) throw error;
    return withTenant({ clinicId, actor }, (tx) => recordNotConnected(tx, appointmentId, allowed));
  }
  if (step.kind === "done") return step.outcome;
  const p = step.prepared;

  // 2. Google, with no transaction open.
  let outcome: CalendarWriteOutcome;
  let externalId: string | null = null;
  let reason: string | null = null;
  let adopted = false;
  let broken: ConnectorError | null = null;
  try {
    const checked = await confirmCalendarTarget({
      context: p.context,
      calendarId: p.calendarId,
      account: p.target.terms.account,
      writes: p.target.terms.allowsWrite,
      managed: p.target.managed,
    });
    const targetBreak = !checked.allowed && checked.error ? calendarBreakOf(checked.error) : null;
    if (!checked.allowed && targetBreak) {
      // Google refused to list the account's calendars for good (the grant
      // gone, the access taken away): the connection is broken, and no
      // later attempt can write this. Staff add it by hand.
      outcome = "failed";
      reason = targetBreak;
      broken = checked.error ?? null;
    } else if (!checked.allowed) {
      // HRC-04, at every write: a calendar that stopped being one the
      // location may book into is refused; one Google could not vouch for
      // this time is tried again later, read back first.
      outcome = checked.reason === "unverified" ? "unknown" : "failed";
      reason = checked.reason === "unverified" ? "target_unverified" : `target_${checked.reason}`;
    } else {
      const found = p.readBackFirst
        ? await googleCalendarAdapter.findAppointmentByKey(p.context, {
            idempotencyKey: p.eventKey,
            around: p.scheduledFor,
          })
        : null;
      if (found && !found.ok) {
        ({ outcome, reason } = readBackOutcome(found.error));
        broken = found.error;
      } else if (found?.ok && found.value && !sameSpan(found.value, p)) {
        // Our key, another time: the assistant's booking for this request,
        // already in Google (plan §7.12, as for a 409 below). Never adopted
        // as this booking, never moved, never doubled; the desk is told
        // where it is.
        outcome = "failed";
        reason = "event_id_taken";
      } else if (found?.ok && found.value) {
        outcome = "written";
        externalId = found.value.externalId;
        adopted = true;
      } else {
        const created = await googleCalendarAdapter.createAppointment(p.context, {
          startsAt: p.scheduledFor,
          durationMinutes: p.durationMinutes,
          attendee: { name: p.firstName, timeZone: p.timeZone },
          origin: p.origin,
          audience: p.audience,
          service: p.service,
          idempotencyKey: p.eventKey,
        });
        if (!created.ok) {
          ({ outcome, reason } = failureOutcome(created.error));
          broken = created.error;
        } else if (created.value.adopted && !sameSpan(created.value, p)) {
          // Google already holds our event under this key at another time:
          // the assistant's booking for this request. Never moved, never
          // doubled; the desk is told where it is.
          outcome = "failed";
          reason = "event_id_taken";
        } else {
          outcome = "written";
          externalId = created.value.externalId;
          adopted = created.value.adopted === true;
        }
      }
    }
  } catch (error) {
    // An adapter that throws rather than returning a Result has told us
    // nothing about Google's state: unknown, and read back next time.
    log.error("calendar write threw", {
      clinicId,
      connectionId: p.target.connectionId,
      error: describeError(error),
    });
    outcome = "unknown";
    reason = "threw";
  }

  // A definitive answer breaks the connection, in its own transaction
  // (plan §8.2): the location books by request from now on.
  const code = broken ? calendarBreakOf(broken) : null;
  if (code) {
    try {
      await markCalendarBroken(clinicId, {
        code,
        connectionId: p.target.connectionId,
        credentialVersion: p.target.credentialVersion,
        actor,
      });
    } catch (error) {
      log.error("calendar break not recorded", { clinicId, error: describeError(error) });
    }
  }

  // 3. Record it, fenced by the lease: a takeover's attempt records its own.
  const now = opts.now ?? new Date();
  const recorded = await withTenant({ clinicId, actor }, async (tx) => {
    const [row] = await tx.db
      .update(appointments)
      .set({
        calendarWriteStatus: outcome === "written" ? "written" : (outcome as CalendarWriteStatus),
        calendarWrittenAt: outcome === "written" ? now : null,
        calendarWriteError: outcome === "written" ? null : (reason?.slice(0, 80) ?? null),
        ...(outcome === "written" && externalId
          ? { externalAppointmentId: externalId, externalSource: GOOGLE_CALENDAR_PROVIDER }
          : {}),
        updatedAt: now,
      })
      .where(
        and(
          eq(appointments.id, appointmentId),
          eq(appointments.clinicId, tx.clinicId),
          eq(appointments.calendarWriteStatus, "writing"),
          eq(appointments.calendarWriteLease, p.lease),
        ),
      )
      .returning({ id: appointments.id });
    tx.audit.record({
      action: "update",
      resourceType: "appointment",
      resourceId: appointmentId,
      metadata: {
        calendarWrite: outcome,
        provider: GOOGLE_CALENDAR_PROVIDER,
        adopted: adopted || undefined,
        reason: reason ?? undefined,
        retry: p.readBackFirst || undefined,
        leaseLost: row ? undefined : true,
      },
    });
    return row !== undefined;
  });
  return recorded ? outcome : "unknown";
}

async function claim(
  tx: TenantTx,
  appointmentId: string,
  allowed: CalendarWriteStatus[],
): Promise<Prepare> {
  const [row] = await tx.db
    .select({
      status: appointments.calendarWriteStatus,
      scheduledFor: appointments.scheduledFor,
      durationMinutes: appointments.durationMinutes,
      treatment: appointments.treatment,
      bookingOrigin: appointments.bookingOrigin,
      eventKey: appointments.calendarEventKey,
      calendarId: appointments.calendarId,
      requestId: bookingRequests.id,
      fullName: contacts.fullName,
      timeZone: clinics.timezone,
      specialty: clinics.specialty,
    })
    .from(appointments)
    .innerJoin(bookingRequests, eq(bookingRequests.appointmentId, appointments.id))
    .innerJoin(contacts, eq(contacts.id, appointments.contactId))
    .innerJoin(clinics, eq(clinics.id, appointments.clinicId))
    .where(and(eq(appointments.id, appointmentId), eq(appointments.clinicId, tx.clinicId)))
    .limit(1);
  if (!row) throw new Error("Calendar write: no such appointment on a booking request.");
  if (row.status === "written") return { kind: "done", outcome: "written" };

  // Under terms that never write (not used, none, an election still owed)
  // nothing happens: the confirmation is recorded in healdesk only.
  const terms = await calendarTermsFor(tx);
  if (terms.kind !== "covered" && terms.kind !== "uncovered") {
    return { kind: "done", outcome: "not-connected" };
  }

  const target = await writableConnection(tx);
  if (!target) {
    // The terms allow writing but there is no healthy calendar: staff add it
    // by hand, and it is never written later on its own (plan §7.12).
    return { kind: "done", outcome: await recordNotConnected(tx, appointmentId, allowed) };
  }

  // The claim. Whoever moves the row to `writing` with a new lease owns the
  // attempt; a claim older than two minutes is taken over (a writer that
  // died or hung), the coalesce covering a row claimed before the claim
  // stamp existed. Five attempts at most.
  const lease = randomUUID();
  const [claimed] = await tx.db
    .update(appointments)
    .set({
      calendarWriteStatus: "writing",
      calendarWriteClaimedAt: sql`clock_timestamp()`,
      calendarWriteAttempts: sql`${appointments.calendarWriteAttempts} + 1`,
      calendarWriteLease: lease,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(appointments.id, appointmentId),
        eq(appointments.clinicId, tx.clinicId),
        sql`${appointments.calendarWriteAttempts} < ${MAX_WRITE_ATTEMPTS}`,
        claimable(allowed),
      ),
    )
    .returning({ attempts: appointments.calendarWriteAttempts });
  if (!claimed) {
    // In flight, refused and not asked to retry, or out of attempts: report
    // what the row says.
    return { kind: "done", outcome: row.status === "failed" ? "failed" : "unknown" };
  }

  // The calendar the booking occupies: a named provider's, or the
  // location's own. Every Google call of this attempt goes to it.
  const calendarId = row.calendarId ?? target.calendarId;
  const context = await openWriteContext(tx, target, calendarId);
  // The service as the clinic's own list names it, and nothing else: what
  // the terms promise the calendar carries. The appointment's treatment can
  // be the desk's typed text or the caller's own words ("lip filler after my
  // surgery"), which never reach Google; a service the list does not name
  // is written as "Appointment".
  const [agent] = await tx.db
    .select({ services: agentConfigs.services })
    .from(agentConfigs)
    .where(eq(agentConfigs.clinicId, tx.clinicId))
    .limit(1);
  const service = serviceDuration(agent?.services ?? [], row.treatment).canonicalName;
  return {
    kind: "go",
    prepared: {
      context,
      target,
      calendarId,
      lease,
      eventKey: row.eventKey ?? row.requestId,
      scheduledFor: row.scheduledFor,
      durationMinutes: row.durationMinutes,
      // The first name only: the event carries nothing more of the person.
      firstName: (row.fullName ?? "").trim().split(/\s+/u)[0] ?? "",
      service,
      timeZone: row.timeZone,
      audience: audienceFor(row.specialty),
      origin: row.bookingOrigin === "assistant" ? "assistant" : "desk",
      readBackFirst: claimed.attempts > 1,
    },
  };
}

/**
 * The rows an attempt may claim: one of the `allowed` states, or a `writing`
 * claim stuck for two minutes (a writer that died or hung), the coalesce
 * covering a row claimed before the claim stamp existed.
 */
function claimable(allowed: CalendarWriteStatus[]) {
  return sql`(${appointments.calendarWriteStatus} in (${sql.join(
    allowed.map((status) => sql`${status}`),
    sql`, `,
  )})
    or (${appointments.calendarWriteStatus} = 'writing'
        and coalesce(${appointments.calendarWriteClaimedAt}, ${appointments.updatedAt})
            < clock_timestamp() - make_interval(mins => ${STUCK_CLAIM_MINUTES})))`;
}

/**
 * Terms that write, and no healthy calendar to write to: the row becomes
 * `failed` with `calendar_not_connected`, from any state this attempt could
 * have claimed (a stuck claim included, whose writer will never record), and
 * the desk page says to add it by hand. What the row says otherwise, when
 * someone else settled it first.
 */
async function recordNotConnected(
  tx: TenantTx,
  appointmentId: string,
  allowed: CalendarWriteStatus[],
): Promise<CalendarWriteOutcome> {
  const [failed] = await tx.db
    .update(appointments)
    .set({
      calendarWriteStatus: "failed",
      calendarWriteError: "calendar_not_connected",
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(appointments.id, appointmentId),
        eq(appointments.clinicId, tx.clinicId),
        claimable(allowed),
      ),
    )
    .returning({ id: appointments.id });
  if (failed) {
    tx.audit.record({
      action: "update",
      resourceType: "appointment",
      resourceId: appointmentId,
      metadata: { calendarWrite: "failed", reason: "calendar_not_connected" },
    });
    return "failed";
  }
  const [row] = await tx.db
    .select({ status: appointments.calendarWriteStatus })
    .from(appointments)
    .where(and(eq(appointments.id, appointmentId), eq(appointments.clinicId, tx.clinicId)))
    .limit(1);
  return row?.status === "written" ? "written" : row?.status === "failed" ? "failed" : "unknown";
}

/** The adapter context for a write to `calendarId`, its token decrypt audited. */
async function openWriteContext(
  tx: TenantTx,
  target: WritableConnection,
  calendarId: string,
): Promise<ConnectorContext> {
  tx.audit.record({
    action: "decrypt",
    resourceType: "credential",
    resourceId: target.connectionId,
    metadata: { provider: target.provider, purpose: "calendar_write" },
  });
  const refreshToken = await withCredentials(
    tx.db,
    { clinicId: tx.clinicId, connectionId: target.connectionId },
    async (credentials) => credentials.refresh_token ?? "",
  );
  return {
    clinicId: tx.clinicId,
    connectionId: target.connectionId,
    credentials: { refresh_token: refreshToken },
    metadata: { ...target.metadata, calendarId },
    oauthClient: target.oauthClient,
  };
}

/** What a failed insert means for the row. */
function failureOutcome(error: ConnectorError): {
  outcome: CalendarWriteOutcome;
  reason: string;
} {
  const reason = error.reason ?? error.code;
  // The clinic deleted the event: never written again (plan §7.12).
  if (reason === "deleted_in_calendar") return { outcome: "failed", reason };
  return { outcome: UNKNOWN_OUTCOME_REASONS.has(reason) ? "unknown" : "failed", reason };
}

/**
 * What a failed read-back means for the row. A read is answered in Google's
 * own words (a 503 says `backendError`, not `unconfirmed`), and an earlier
 * insert may still be in Google, so only an answer that settles it is
 * `failed`: a break (the connection is marked broken, and nothing will be
 * written), an event the clinic deleted (never written again), or one under
 * our id that is not ours. Everything else is `unknown`, read back again on
 * the next attempt, never `failed` with a booking possibly in the calendar.
 */
function readBackOutcome(error: ConnectorError): {
  outcome: CalendarWriteOutcome;
  reason: string;
} {
  const reason = error.reason ?? error.code;
  const settled =
    calendarBreakOf(error) !== null || reason === "deleted_in_calendar" || reason === "not_ours";
  return { outcome: settled ? "failed" : "unknown", reason };
}

function sameSpan(
  event: { startsAt: Date; endsAt: Date },
  p: Pick<Prepared, "scheduledFor" | "durationMinutes">,
): boolean {
  const end = p.scheduledFor.getTime() + (p.durationMinutes ?? 30) * 60_000;
  return event.startsAt.getTime() === p.scheduledFor.getTime() && event.endsAt.getTime() === end;
}

/** The write guard's refusal of a claim (drizzle/0059, app_appointment_write_guard). */
const WRITE_PERMITTED = "appointments_write_permitted";

function codeOf(error: unknown): string | undefined {
  return pgField(error, "code");
}

function constraintOf(error: unknown): string | undefined {
  return pgField(error, "constraint");
}

/** A field of the Postgres error, through drizzle's wrapping. */
function pgField(error: unknown, field: "code" | "constraint"): string | undefined {
  for (let current: unknown = error, depth = 0; current && depth < 5; depth += 1) {
    if (typeof current !== "object") return undefined;
    const value = (current as Record<string, unknown>)[field];
    if (typeof value === "string") return value;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

// -----------------------------------------------------------------------------
// The desk sweep (plan §9.2 step 5; called by the five-minute calendar watch)
// -----------------------------------------------------------------------------

/** How far back the sweep looks, and how many writes one run takes on. */
export const DESK_SWEEP_LOOKBACK_HOURS = 24;
export const DESK_SWEEP_LIMIT = 20;

export type DeskSweepResult = {
  /** Appointments the sweep tried again. */
  attempted: number;
  /** Their outcomes, by kind. */
  written: number;
  failed: number;
  unknown: number;
  /** Locations the sweep could not read; logged, never fatal. */
  errors: number;
};

const SWEEP_ACTOR: ActorContext = { type: "service", serviceName: "calendar-watch" };

/**
 * Staff confirmations whose Google write never settled (plan §7.12, §9.2):
 * `unknown` (a timeout, a lost reply, a target Google could not vouch for),
 * or a `writing` claim stuck for two minutes (a writer that died), from the
 * last 24 hours, at most 20 a run, oldest first, each through
 * writeToCalendar, which reads Google back before it creates anything and
 * stops at five attempts. `failed` is never swept: it is retried only by ops
 * (`retryCalendarWrite`), after someone has looked at why.
 *
 * Exported for the calendar watch (lib/scheduler/calendar-watch.ts), which
 * calls it once per run; it never throws.
 */
export async function sweepDeskWrites(
  options: { now?: Date; limit?: number; actor?: ActorContext } = {},
): Promise<DeskSweepResult> {
  const now = options.now ?? new Date();
  const limit = options.limit ?? DESK_SWEEP_LIMIT;
  const actor = options.actor ?? SWEEP_ACTOR;
  const result: DeskSweepResult = { attempted: 0, written: 0, failed: 0, unknown: 0, errors: 0 };
  const since = new Date(now.getTime() - DESK_SWEEP_LOOKBACK_HOURS * 3_600_000);

  let clinicIds: string[];
  try {
    clinicIds = (await listClinics()).filter((c) => !c.destroyedAt).map((c) => c.id);
  } catch (error) {
    log.error("desk write sweep could not list its locations", { error: describeError(error) });
    return { ...result, errors: 1 };
  }

  for (const clinicId of clinicIds) {
    if (result.attempted >= limit) break;
    let due: string[];
    try {
      due = await withTenant({ clinicId, actor }, async (tx) => {
        const rows = await tx.db
          .select({ id: appointments.id })
          .from(appointments)
          .innerJoin(bookingRequests, eq(bookingRequests.appointmentId, appointments.id))
          .where(
            and(
              eq(appointments.clinicId, tx.clinicId),
              sql`${appointments.updatedAt} > ${since}`,
              sql`${appointments.calendarWriteAttempts} < ${MAX_WRITE_ATTEMPTS}`,
              sql`(${appointments.calendarWriteStatus} = 'unknown'
                   or (${appointments.calendarWriteStatus} = 'writing'
                       and coalesce(${appointments.calendarWriteClaimedAt}, ${appointments.updatedAt})
                           < clock_timestamp() - make_interval(mins => ${STUCK_CLAIM_MINUTES})))`,
            ),
          )
          .orderBy(appointments.updatedAt)
          .limit(limit - result.attempted);
        return rows.map((r) => r.id);
      });
    } catch (error) {
      result.errors += 1;
      log.error("desk write sweep failed for a location", {
        clinicId,
        error: describeError(error),
      });
      continue;
    }
    for (const appointmentId of due) {
      result.attempted += 1;
      try {
        const outcome = await writeToCalendar(clinicId, appointmentId, { actor, now });
        if (outcome === "written") result.written += 1;
        else if (outcome === "failed") result.failed += 1;
        else result.unknown += 1;
      } catch (error) {
        result.errors += 1;
        log.error("desk write sweep could not retry a write", {
          clinicId,
          error: describeError(error),
        });
      }
    }
  }
  return result;
}
