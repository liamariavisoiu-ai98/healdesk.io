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
import { and, eq, inArray, sql } from "drizzle-orm";

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
 * write may start (app_appointment_write_guard, drizzle/0060). The
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
/**
 * The appointment statuses a calendar write may still go out for: a booking
 * that is on. Cancelled, showed and no-show (marked on Bookings) are never
 * written, and neither is a phase-two rescheduled row.
 */
export const WRITABLE_APPOINTMENT_STATUSES = ["scheduled", "confirmed"] as const;

/** Failure reasons after which Google may still hold the booking. Anything else is an answer. */
const UNKNOWN_OUTCOME_REASONS: ReadonlySet<string> = new Set(["timeout", "network", "unconfirmed"]);

/**
 * The retry ladder (design E3 §2.3, owner-approved 23 October 2026): after
 * the nth attempt that ends `unknown` (1-based), the desk sweep may try again
 * this many minutes later (calendar_write_next_at, drizzle/0117). The fifth
 * is recorded too, though no sixth attempt is ever made: MAX_WRITE_ATTEMPTS.
 */
export const WRITE_BACKOFF_MINUTES = [2, 10, 30, 120, 360] as const;

/** When the sweep may try a write again after its `attempt`th attempt ended unknown. */
export function nextWriteAttemptAt(attempt: number, now: Date): Date {
  const step = Math.min(Math.max(attempt, 1), WRITE_BACKOFF_MINUTES.length) - 1;
  return new Date(now.getTime() + WRITE_BACKOFF_MINUTES[step]! * 60_000);
}

/**
 * Every reason word healdesk itself can record in calendar_write_error, and
 * what the desk sweep does with a row that carries it (design E3 §2.3):
 *
 *   - `transient`: Google's answer never came or did not settle it. The row
 *     is `unknown` and the sweep tries again on the ladder, reading Google
 *     back first, until the fifth attempt or the slot's start.
 *   - `settled`: an answer that a retry would only repeat or make worse: the
 *     clinic deleted the event, our id is taken by another event or by one
 *     not ours, there is no healthy calendar, the target calendar is no
 *     longer one the location may book into, or the connection is broken
 *     (calendarBreakOf: the location books by request until it reconnects).
 *     Never retried automatically, whatever the row's status says.
 *   - `refused`: Google, or our own set-up, said no to this attempt in a way
 *     the same attempt would meet again (a bad input, healdesk's own sign-in
 *     app or Calendar API switched off). Recorded `failed` by an insert, so
 *     only an operator retries it once the cause is fixed; a read-back that
 *     meets it settles nothing and stays `unknown`.
 *
 * The words of the Google adapter (packages/connectors/src/google) and of
 * HRC-04's target check (`target_` + CalendarTargetRefusal) are all here;
 * tests/calendar-write-backoff.test.ts fails on a new one left out. Google's
 * own words, kept as Google said them where the adapter passes one through
 * (a 4xx's `badRequest`, a read-back's `backendError`, a 429's
 * `rateLimitExceeded`), are not ours to list: their row's status says what
 * they mean.
 */
export const CALENDAR_WRITE_REASONS = {
  // Ours, and the adapter's lost answers.
  timeout: "transient",
  network: "transient",
  unconfirmed: "transient",
  threw: "transient",
  malformed_response: "transient",
  rate_limited: "transient",
  target_unverified: "transient",
  // Settled: never retried automatically.
  deleted_in_calendar: "settled",
  event_id_taken: "settled",
  not_ours: "settled",
  conflict: "settled",
  calendar_not_connected: "settled",
  target_terms: "settled",
  target_unmanaged_account: "settled",
  target_account_mismatch: "settled",
  target_outside_organisation: "settled",
  target_not_owned: "settled",
  // calendarBreakOf's codes (TOKEN_BREAKS, CALENDAR_BREAKS).
  invalid_grant: "settled",
  admin_policy_enforced: "settled",
  scope_lost: "settled",
  access_denied: "settled",
  insufficient_permissions: "settled",
  calendar_not_found: "settled",
  // Refused: the same attempt would meet it again.
  api_disabled: "refused",
  oauth_client: "refused",
  missing_refresh_token: "refused",
  calendar_id: "refused",
  missing_key: "refused",
  bad_start: "refused",
  bad_duration: "refused",
  bad_time_zone: "refused",
  phone_field_refused: "refused",
  // The adapter's words for its other calls (the token exchange and revoke,
  // the calendar list, free/busy): never recorded by a write today, listed
  // so a write that ever meets one is already classified.
  missing_code: "refused",
  missing_token: "refused",
  id_token_malformed: "refused",
  not_calendar_owner: "refused",
  too_many_calendars: "refused",
  bad_window: "refused",
  window_too_long: "refused",
  calendar_error: "refused",
} as const satisfies Record<string, "transient" | "settled" | "refused">;

export type CalendarWriteReason = keyof typeof CALENDAR_WRITE_REASONS;

/** The reasons the sweep never retries, whatever the row's status (`settled` above). */
export const NEVER_RETRIED_REASONS: readonly CalendarWriteReason[] = (
  Object.keys(CALENDAR_WRITE_REASONS) as CalendarWriteReason[]
).filter((reason) => CALENDAR_WRITE_REASONS[reason] === "settled");

/** A stored reason as one of ours, or `other` for a word Google gave (or none). */
export function writeReasonCode(stored: string | null): CalendarWriteReason | "other" {
  return stored !== null && Object.hasOwn(CALENDAR_WRITE_REASONS, stored)
    ? (stored as CalendarWriteReason)
    : "other";
}

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
  /** Which attempt this is, 1 to MAX_WRITE_ATTEMPTS: where an unknown outcome sits on the ladder. */
  attempt: number;
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
    // The write guard (drizzle/0060) refused the claim: the terms or the
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
        // The ladder: only an unknown outcome waits for another attempt.
        calendarWriteNextAt: outcome === "unknown" ? nextWriteAttemptAt(p.attempt, now) : null,
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
  // stamp existed. Five attempts at most. Only a booking still on: an
  // appointment staff marked cancelled, showed or no-show on Bookings is
  // never written, whichever path asks (the confirm, the sweep, the ops
  // retry), so a write that was still unsettled never lands afterwards.
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
        inArray(appointments.status, [...WRITABLE_APPOINTMENT_STATUSES]),
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
      attempt: claimed.attempts,
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
      calendarWriteNextAt: null,
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

/**
 * What a failed insert means for the row. A rate limit (a 429, or a 403
 * rate-limit word) and a server error answered before the insert was sent
 * (the token endpoint's 5xx) are Google's "not now", not its "no": nothing
 * was stored, so they are `unknown` and the sweep tries again on the ladder,
 * reading back first. Until 24 October 2026 they ended `failed`, and a
 * booking was left for a person after one busy minute at Google. A 5xx to
 * the insert itself is already `unconfirmed` (googleWriteError).
 */
function failureOutcome(error: ConnectorError): {
  outcome: CalendarWriteOutcome;
  reason: string;
} {
  const reason = error.reason ?? error.code;
  // The clinic deleted the event: never written again (plan §7.12).
  if (reason === "deleted_in_calendar") return { outcome: "failed", reason };
  if (UNKNOWN_OUTCOME_REASONS.has(reason)) return { outcome: "unknown", reason };
  const notNow = error.code === "rate_limited" || error.code === "unavailable";
  return { outcome: notNow && calendarBreakOf(error) === null ? "unknown" : "failed", reason };
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

/** The write guard's refusal of a claim (drizzle/0060, app_appointment_write_guard). */
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

/** How many writes one run of the sweep takes on, across every location. */
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
 * The rows the sweep may take now (design E3 §2.3): a booking still on, its
 * slot not yet started, fewer than five attempts, and either `unknown` whose
 * next attempt on the ladder is due (calendar_write_next_at, null for a row
 * written before the ladder existed) and whose reason is not one of the
 * settled ones, or a `writing` claim stuck for two minutes. Exported for the
 * stuck-writes view and the alert, so the three can never disagree about
 * what is still waiting.
 */
export function sweepable(now: Date) {
  return and(
    sql`${appointments.calendarWriteAttempts} < ${MAX_WRITE_ATTEMPTS}`,
    // A booking staff marked cancelled, showed or no-show is never written.
    inArray(appointments.status, [...WRITABLE_APPOINTMENT_STATUSES]),
    // A slot that has started is never written: the booking is past.
    sql`${appointments.scheduledFor} > ${now}`,
    sql`((${appointments.calendarWriteStatus} = 'unknown'
          and (${appointments.calendarWriteNextAt} is null or ${appointments.calendarWriteNextAt} <= ${now})
          and coalesce(${appointments.calendarWriteError}, '') not in (${sql.join(
            NEVER_RETRIED_REASONS.map((reason) => sql`${reason}`),
            sql`, `,
          )}))
         or (${appointments.calendarWriteStatus} = 'writing'
             and coalesce(${appointments.calendarWriteClaimedAt}, ${appointments.updatedAt})
                 < clock_timestamp() - make_interval(mins => ${STUCK_CLAIM_MINUTES})))`,
  );
}

/**
 * Staff confirmations whose Google write never settled (plan §7.12, §9.2;
 * the ladder of design E3 §2.3): `unknown` (a timeout, a lost reply, a rate
 * limit, a target Google could not vouch for) once its next attempt is due,
 * or a `writing` claim stuck for two minutes (a writer that died), for as
 * long as the slot has not started, each through writeToCalendar, which
 * reads Google back before it creates anything and stops at five attempts.
 * At most DESK_SWEEP_LIMIT a run, taken in turn from each location (the
 * longest-waiting of each first), so one location's outage cannot hold up
 * another's writes. `failed` is never swept: it is retried only by ops
 * (`retryCalendarWrite`), after someone has looked at why. Nor is a booking
 * staff marked cancelled, showed or no-show on Bookings: its write would put
 * a cancelled appointment in the clinic's calendar, busy on every channel.
 *
 * Until 24 October 2026 the sweep looked back only 24 hours and took a due
 * write at every run, so five attempts could go in one Google outage and a
 * slot next week was never tried again after a weekend down.
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

  let clinicIds: string[];
  try {
    clinicIds = (await listClinics()).filter((c) => !c.destroyedAt).map((c) => c.id);
  } catch (error) {
    log.error("desk write sweep could not list its locations", { error: describeError(error) });
    return { ...result, errors: 1 };
  }

  // Each location's due writes, the longest-waiting first.
  const queues: { clinicId: string; due: string[] }[] = [];
  for (const clinicId of clinicIds) {
    try {
      const due = await withTenant({ clinicId, actor }, async (tx) => {
        const rows = await tx.db
          .select({ id: appointments.id })
          .from(appointments)
          .innerJoin(bookingRequests, eq(bookingRequests.appointmentId, appointments.id))
          .where(and(eq(appointments.clinicId, tx.clinicId), sweepable(now)))
          .orderBy(sql`coalesce(${appointments.calendarWriteNextAt}, ${appointments.updatedAt})`, appointments.id)
          .limit(limit);
        return rows.map((r) => r.id);
      });
      if (due.length > 0) queues.push({ clinicId, due });
    } catch (error) {
      result.errors += 1;
      log.error("desk write sweep failed for a location", {
        clinicId,
        error: describeError(error),
      });
    }
  }

  // In turn: one from each location, then the next from each, to the limit.
  const turns: { clinicId: string; appointmentId: string }[] = [];
  for (let round = 0; turns.length < limit; round += 1) {
    let took = false;
    for (const queue of queues) {
      const appointmentId = queue.due[round];
      if (appointmentId === undefined || turns.length >= limit) continue;
      turns.push({ clinicId: queue.clinicId, appointmentId });
      took = true;
    }
    if (!took) break;
  }

  for (const { clinicId, appointmentId } of turns) {
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
  return result;
}
