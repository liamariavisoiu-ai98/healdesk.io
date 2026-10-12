import {
  googleCalendarAdapter,
  MAX_FREEBUSY_WINDOW_MS,
  partsIn,
  zonedToUtc,
  type ConnectorContext,
  type ConnectorError,
} from "@healdesk/connectors";
import { and, eq, gt, inArray, isNotNull, lt, sql } from "drizzle-orm";

import {
  agentConfigs,
  appointments,
  clinicProviders,
  clinicProviderServices,
  clinics,
  clinicSettings,
  slotHolds,
  type AgentService,
} from "@/db/schema";
import type { ActorContext } from "@/lib/audit";
import { clinicLocalDate, closedOn } from "@/lib/clinic/closures";
import {
  DAY_KEYS,
  OpeningHoursError,
  parseOpeningHours,
  type OpeningHours,
} from "@/lib/clinic/opening-hours";
import {
  calendarBreakOf,
  isTokenBreak,
  markCalendarBroken,
  serviceKeyOf,
} from "@/lib/connections/google-calendar";
import { withCredentials } from "@/lib/connections/store";
import { describeError, log } from "@/lib/log";
import { withTenant, type TenantTx } from "@/lib/tenant";

import { writableConnection, type WritableConnection } from "./calendar";

/**
 * When a location can be booked (plan §6; owner Q7): its opening hours, less
 * the days it is closed, less what its Google calendar shows busy, less what
 * healdesk itself is holding or has booked there, on a 15-minute grid, at
 * least two hours ahead, and no more than 14 days out (60 for a date the
 * person names).
 *
 * A pure core (computeCandidates) and three ways in, each reading in two
 * short transactions with Google asked between them, never inside one:
 *
 *   - availableSlotsFor: the free start times, for the desk page and, from
 *     the engine (C13), for the assistant's offers;
 *   - checkSpan: whether one start the assistant is about to hold is still a
 *     candidate (on the grid, in hours, within notice and horizon, free);
 *   - deskSpanFree: whether the exact span staff are confirming is free in
 *     Google, with none of the assistant's rules: staff may book off the
 *     grid and out of hours, and the database guard covers healdesk's own
 *     bookings.
 *
 * Named providers (addendum of 6 October): where the location books by
 * provider (`clinic_settings.booking_detail = 'named_provider'`) and an
 * active provider offers the service, times come from each such provider's
 * calendar, and each time carries the calendar it was found on; otherwise
 * from the location's own calendar. Holds and healdesk's bookings block only
 * their own calendar (migration B), a booking that names none blocking every
 * calendar of the location.
 *
 * Everything is computed in the clinic's own zone (`clinics.timezone`), and
 * only once that zone is confirmed: a guessed zone puts every offer hours
 * out.
 */

/** No offer starts sooner than this (Q7). */
export const MIN_NOTICE_MINUTES = 120;
/** How far ahead times are offered unprompted (Q7). */
export const OFFER_HORIZON_DAYS = 14;
/** How far ahead a date the person names may be (Q7). */
export const MAX_BOOKING_HORIZON_DAYS = 60;
/** Starts fall on the clinic's quarter-hours (Q7). */
export const SLOT_STEP_MINUTES = 15;
/** A service with no length of its own (plan §1.4 A3). */
export const DEFAULT_SERVICE_MINUTES = 30;
const MIN_SERVICE_MINUTES = 5;
const MAX_SERVICE_MINUTES = 480;

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

// -----------------------------------------------------------------------------
// The pure core
// -----------------------------------------------------------------------------

/** A half-open span of time. */
export type Span = { startsAt: Date; endsAt: Date };

/**
 * The service a person asked for, as the clinic's own list names it, and how
 * long it takes: a case-insensitive exact match on the name, else 30 minutes
 * and no canonical name. Clamped to 5–480 minutes, the range a hold and an
 * event accept.
 */
export function serviceDuration(
  services: readonly Pick<AgentService, "name" | "durationMinutes">[],
  name: string | null | undefined,
): { minutes: number; canonicalName: string | null } {
  const wanted = name ? serviceKeyOf(name) : "";
  const match = wanted ? services.find((s) => serviceKeyOf(s.name) === wanted) : undefined;
  const raw = match?.durationMinutes;
  const minutes =
    typeof raw === "number" && Number.isFinite(raw)
      ? Math.min(MAX_SERVICE_MINUTES, Math.max(MIN_SERVICE_MINUTES, Math.round(raw)))
      : DEFAULT_SERVICE_MINUTES;
  return { minutes, canonicalName: match?.name ?? null };
}

export type CandidateInput = {
  now: Date;
  /** The earliest start asked for; never earlier than now plus the notice. */
  from?: Date | null;
  /** Days past the window's start. */
  horizonDays: number;
  noticeMinutes?: number;
  durationMinutes: number;
  timeZone: string;
  hours: OpeningHours;
  /** The clinic's closed days, YYYY-MM-DD in its own zone. */
  closedDates: ReadonlySet<string>;
  /** When Google shows the calendar free, maximal and sorted or not. */
  free: readonly Span[];
  /** Live holds and healdesk bookings on this calendar. */
  blocked: readonly Span[];
};

/** The window a computation covers: notice first, then the horizon, never past 60 days from now. */
export function candidateWindow(input: {
  now: Date;
  from?: Date | null;
  horizonDays: number;
  noticeMinutes?: number;
}): Span | null {
  const notice = (input.noticeMinutes ?? MIN_NOTICE_MINUTES) * MINUTE_MS;
  const start = Math.max(
    input.from?.getTime() ?? input.now.getTime(),
    input.now.getTime() + notice,
  );
  const end = Math.min(
    start + input.horizonDays * DAY_MS,
    input.now.getTime() + MAX_BOOKING_HORIZON_DAYS * DAY_MS,
  );
  return end > start ? { startsAt: new Date(start), endsAt: new Date(end) } : null;
}

/**
 * Every start time on offer, ascending (plan §6.2).
 *
 * The local dates are walked from one day before the window's first, so a
 * range that opened the evening before and runs past midnight is found. Each
 * range runs from its opening instant, rounded up to the next local
 * quarter-hour (a 09:10 opening offers 09:15 first), to its closing instant,
 * on the next local date when it closes at or before it opens. Steps are 15
 * absolute minutes: every real UTC offset is a whole number of quarter-hours,
 * so absolute steps stay on the local grid, and a clock change neither skips
 * a slot it should offer nor offers one instant twice.
 *
 * A start is kept when the whole service fits inside one stretch Google
 * shows free, overlaps no blocking hold or healdesk booking (half-open), is
 * inside the window, and neither its range's date nor its own date is a day
 * the clinic is closed.
 */
export function computeCandidates(input: CandidateInput): Date[] {
  const window = candidateWindow(input);
  if (!window) return [];
  const from = window.startsAt.getTime();
  const to = window.endsAt.getTime();
  const durationMs = input.durationMinutes * MINUTE_MS;
  const stepMs = SLOT_STEP_MINUTES * MINUTE_MS;
  const free = [...input.free]
    .map((s) => ({ start: s.startsAt.getTime(), end: s.endsAt.getTime() }))
    .sort((a, b) => a.start - b.start);
  const blocked = input.blocked.map((s) => ({
    start: s.startsAt.getTime(),
    end: s.endsAt.getTime(),
  }));
  const fitsFree = (start: number, end: number) =>
    free.some((f) => f.start <= start && end <= f.end);
  const isBlocked = (start: number, end: number) =>
    blocked.some((b) => b.start < end && start < b.end);

  const found = new Set<number>();
  const first = partsIn(new Date(from - DAY_MS), input.timeZone);
  const last = partsIn(new Date(to), input.timeZone);
  const lastKey = Date.UTC(last.year, last.month - 1, last.day);
  for (let day = Date.UTC(first.year, first.month - 1, first.day); day <= lastKey; day += DAY_MS) {
    const date = new Date(day);
    const [y, m, d] = [date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate()];
    if (input.closedDates.has(isoDate(y, m, d))) continue;
    const next = new Date(day + DAY_MS);
    for (const [open, close] of input.hours[DAY_KEYS[date.getUTCDay()]!]) {
      const [oh, om] = hhmm(open);
      const [ch, cm] = hhmm(close);
      const opens = zonedToUtc(y, m, d, oh, om, input.timeZone).getTime();
      const crosses = ch * 60 + cm <= oh * 60 + om;
      const closes = crosses
        ? zonedToUtc(
            next.getUTCFullYear(),
            next.getUTCMonth() + 1,
            next.getUTCDate(),
            ch,
            cm,
            input.timeZone,
          ).getTime()
        : zonedToUtc(y, m, d, ch, cm, input.timeZone).getTime();
      for (
        let t = roundUpToLocalQuarter(opens, input.timeZone);
        t + durationMs <= closes;
        t += stepMs
      ) {
        if (t < from || t >= to) continue;
        if (input.closedDates.has(clinicLocalDate(new Date(t), input.timeZone))) continue;
        if (!fitsFree(t, t + durationMs) || isBlocked(t, t + durationMs)) continue;
        found.add(t);
      }
    }
  }
  return [...found].sort((a, b) => a - b).map((t) => new Date(t));
}

/** The `n` candidates nearest to `target`, earliest first among equals (plan §6.2). */
export function nearestAlternatives(candidates: readonly Date[], target: Date, n = 3): Date[] {
  return [...candidates]
    .filter((c) => c.getTime() !== target.getTime())
    .sort(
      (a, b) =>
        Math.abs(a.getTime() - target.getTime()) - Math.abs(b.getTime() - target.getTime()) ||
        a.getTime() - b.getTime(),
    )
    .slice(0, n)
    .sort((a, b) => a.getTime() - b.getTime());
}

/** The next local quarter-hour at or after an instant. */
function roundUpToLocalQuarter(instant: number, timeZone: string): number {
  const p = partsIn(new Date(instant), timeZone);
  const past = ((p.minute % SLOT_STEP_MINUTES) * 60 + p.second) * 1000 + (instant % 1000);
  return past === 0 ? instant : instant - past + SLOT_STEP_MINUTES * MINUTE_MS;
}

function hhmm(value: string): [number, number] {
  return [Number(value.slice(0, 2)), Number(value.slice(3, 5))];
}

function isoDate(y: number, m: number, d: number): string {
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

// -----------------------------------------------------------------------------
// The calendars a service books into
// -----------------------------------------------------------------------------

/** One calendar times can come from: the location's own (no provider) or a named provider's. */
export type CalendarTarget = { calendarId: string; providerId: string | null };

/**
 * Where a service is booked (addendum, named providers): with
 * `booking_detail = 'named_provider'`, the calendars of the active providers
 * who offer it, in the order the clinic added them; otherwise, or when
 * nobody offers it, the location's own calendar.
 *
 * When one provider is named (`providerId`, as for a person asking for whom
 * they saw last time), only that provider's calendar, and only while they
 * are active and offer the service; otherwise no calendar at all. A person
 * who asked for Dr Lee is never offered the shared calendar's times as if
 * they were hers.
 */
export async function calendarTargetsFor(
  tx: TenantTx,
  target: Pick<WritableConnection, "calendarId">,
  canonicalService: string | null,
  providerId?: string | null,
): Promise<CalendarTarget[]> {
  const shared: CalendarTarget[] = [{ calendarId: target.calendarId, providerId: null }];
  const unmatched = providerId ? [] : shared;
  if (!canonicalService) return unmatched;
  const [settings] = await tx.db
    .select({ bookingDetail: clinicSettings.bookingDetail })
    .from(clinicSettings)
    .where(eq(clinicSettings.clinicId, tx.clinicId))
    .limit(1);
  if (settings?.bookingDetail !== "named_provider") return unmatched;
  const rows = await tx.db
    .select({ id: clinicProviders.id, calendarId: clinicProviders.calendarId })
    .from(clinicProviders)
    .innerJoin(
      clinicProviderServices,
      and(
        eq(clinicProviderServices.providerId, clinicProviders.id),
        eq(clinicProviderServices.clinicId, clinicProviders.clinicId),
      ),
    )
    .where(
      and(
        eq(clinicProviders.clinicId, tx.clinicId),
        eq(clinicProviders.active, true),
        eq(clinicProviderServices.serviceKey, serviceKeyOf(canonicalService)),
      ),
    )
    .orderBy(clinicProviders.createdAt, clinicProviders.id);
  const mapped = rows
    .filter((r) => !providerId || r.id === providerId)
    .map((r) => ({ calendarId: r.calendarId, providerId: r.id }));
  return mapped.length ? mapped : unmatched;
}

// -----------------------------------------------------------------------------
// Reading it all
// -----------------------------------------------------------------------------

const AVAILABILITY_ACTOR: ActorContext = { type: "service", serviceName: "calendar-availability" };

/** One start time on offer, and the calendar it was found free on. */
export type AvailableSlot = { at: Date; calendarId: string; providerId: string | null };

/** Why no times can be offered at all. */
export type UnavailableReason =
  /** No calendar healdesk may read and write under the location's terms. */
  | "not_writable"
  | "opening_hours_unknown"
  | "timezone_unconfirmed"
  /** The date asked for is past the 60-day horizon, or the window is empty. */
  | "outside_horizon"
  /** The provider asked for is not active, or does not offer the service. */
  | "provider_unavailable";

export type Availability =
  | {
      status: "ok";
      timeZone: string;
      serviceMinutes: number;
      canonicalService: string | null;
      slots: AvailableSlot[];
    }
  | { status: "unavailable"; reason: UnavailableReason }
  /** Google's definitive no: the connection is marked broken, and the location books by request now. */
  | { status: "broken" }
  /** Google did not answer this time. Nothing changed. */
  | { status: "transient" };

export type AvailabilityOptions = {
  from?: Date | null;
  /** Days past `from`, default 14, at most 31 (one free/busy read). */
  days?: number;
  service?: string | null;
  /** Only this named provider's calendar. */
  providerId?: string | null;
  /** Overrides the service's length, e.g. a hold's own. */
  durationMinutes?: number;
  /** The asking holder's own holds do not block it. */
  holderRef?: string | null;
  /** Holds made for this booking request do not block it (the desk page's own request). */
  exceptRequestId?: string | null;
  /** Mint a new Google token for the read (a re-check before a write). */
  fresh?: boolean;
  now?: Date;
  actor?: ActorContext;
};

type Facts = {
  target: WritableConnection;
  context: ConnectorContext;
  timeZone: string;
  hours: OpeningHours;
  closedDates: Set<string>;
  serviceMinutes: number;
  canonicalService: string | null;
  calendars: CalendarTarget[];
  window: Span;
};

/**
 * The free start times for a service (plan §6.2's I/O wrapper):
 *
 *   1. one transaction for the facts (the target, hours, zone, closures,
 *      services, providers) and the token, its decrypt audited under
 *      `calendar_availability`;
 *   2. Google's free/busy for each calendar, with no transaction open;
 *   3. one transaction for the holds and healdesk bookings in the window;
 *   4. the pure core, per calendar.
 *
 * A definitive answer from Google (the grant gone, the location's own
 * calendar refused or missing) marks the connection broken in its own
 * committed transaction (plan §8.2): the location books by request from that
 * moment, and this answers `broken`. A named provider's calendar that is
 * refused or gone drops out of the answer and leaves the connection alone.
 */
export async function availableSlotsFor(
  clinicId: string,
  options: AvailabilityOptions = {},
): Promise<Availability> {
  const now = options.now ?? new Date();
  const actor = options.actor ?? AVAILABILITY_ACTOR;
  const days = Math.min(31, Math.max(1, Math.round(options.days ?? OFFER_HORIZON_DAYS)));
  const window = candidateWindow({ now, from: options.from, horizonDays: days });
  if (!window || window.endsAt.getTime() - window.startsAt.getTime() > MAX_FREEBUSY_WINDOW_MS) {
    return { status: "unavailable", reason: "outside_horizon" };
  }

  const facts = await withTenant(
    { clinicId, actor },
    async (tx): Promise<Facts | { status: "unavailable"; reason: UnavailableReason }> => {
      const target = await writableConnection(tx);
      if (!target) return { status: "unavailable", reason: "not_writable" };
      const [clinic] = await tx.db
        .select({
          timezone: clinics.timezone,
          confirmedAt: clinics.timezoneConfirmedAt,
          openingHours: clinics.openingHours,
        })
        .from(clinics)
        .where(eq(clinics.id, tx.clinicId))
        .limit(1);
      if (!clinic) return { status: "unavailable", reason: "not_writable" };
      if (!clinic.confirmedAt) return { status: "unavailable", reason: "timezone_unconfirmed" };
      let hours: OpeningHours;
      try {
        hours = parseOpeningHours(clinic.openingHours);
      } catch (error) {
        if (error instanceof OpeningHoursError) {
          return { status: "unavailable", reason: "opening_hours_unknown" };
        }
        throw error;
      }
      const [agent] = await tx.db
        .select({ services: agentConfigs.services })
        .from(agentConfigs)
        .where(eq(agentConfigs.clinicId, tx.clinicId))
        .limit(1);
      const service = serviceDuration(agent?.services ?? [], options.service);
      const calendars = await calendarTargetsFor(
        tx,
        target,
        service.canonicalName,
        options.providerId,
      );
      if (calendars.length === 0) return { status: "unavailable", reason: "provider_unavailable" };
      const closedDates = new Set<string>();
      for (const date of localDatesOf(window, clinic.timezone)) {
        if (await closedOn(tx.db, tx.clinicId, date)) closedDates.add(date);
      }
      const context = await openContext(tx, target, "calendar_availability");
      return {
        target,
        context,
        timeZone: clinic.timezone,
        hours,
        closedDates,
        serviceMinutes: options.durationMinutes ?? service.minutes,
        canonicalService: service.canonicalName,
        calendars,
        window,
      };
    },
  );
  if ("status" in facts) return facts;

  // Google, outside any transaction: one free/busy read per calendar, over
  // the window plus the longest service, so a start near its end can fit.
  const read = {
    from: facts.window.startsAt,
    to: new Date(facts.window.endsAt.getTime() + MAX_SERVICE_MINUTES * MINUTE_MS),
  };
  if (read.to.getTime() - read.from.getTime() > MAX_FREEBUSY_WINDOW_MS) {
    read.to = new Date(read.from.getTime() + MAX_FREEBUSY_WINDOW_MS);
  }
  const freeByCalendar = new Map<string, Span[]>();
  for (const calendar of facts.calendars) {
    const listed = await googleCalendarAdapter.listSlots(
      {
        ...facts.context,
        metadata: { ...facts.context.metadata, calendarId: calendar.calendarId },
      },
      read,
      { timeZone: facts.timeZone, freshCredentials: options.fresh === true },
    );
    if (listed.ok) {
      freeByCalendar.set(calendar.calendarId, listed.value);
      continue;
    }
    const failed = await noteReadFailure(clinicId, facts.target, calendar, listed.error, actor);
    if (failed) return failed;
  }

  const blocking = await withTenant({ clinicId, actor }, (tx) =>
    blockingSpans(tx, facts.window, options.holderRef ?? null, options.exceptRequestId ?? null),
  );

  const slots: AvailableSlot[] = [];
  const seen = new Set<number>();
  for (const calendar of facts.calendars) {
    const free = freeByCalendar.get(calendar.calendarId);
    if (!free) continue;
    const candidates = computeCandidates({
      now,
      from: options.from,
      horizonDays: days,
      durationMinutes: facts.serviceMinutes,
      timeZone: facts.timeZone,
      hours: facts.hours,
      closedDates: facts.closedDates,
      free,
      blocked: blocking.filter(
        (b) => b.calendarId === null || b.calendarId === calendar.calendarId,
      ),
    });
    for (const at of candidates) {
      if (seen.has(at.getTime())) continue;
      seen.add(at.getTime());
      slots.push({ at, calendarId: calendar.calendarId, providerId: calendar.providerId });
    }
  }
  slots.sort((a, b) => a.at.getTime() - b.at.getTime());
  return {
    status: "ok",
    timeZone: facts.timeZone,
    serviceMinutes: facts.serviceMinutes,
    canonicalService: facts.canonicalService,
    slots,
  };
}

export type SpanCheck =
  | { status: "free"; calendarId: string; providerId: string | null; minutes: number }
  | { status: "busy" }
  | { status: "unavailable"; reason: UnavailableReason }
  | { status: "broken" }
  | { status: "transient" };

/**
 * For the assistant (plan §6.2): is `startsAt` still a time it may hold and
 * book? It must be a candidate by every rule availableSlotsFor applies (on
 * the grid, inside the hours, within the notice and the horizon, free in
 * Google and of healdesk's own holds and bookings), not merely free; the
 * assistant can never book a time it would not have offered.
 */
export async function checkSpan(
  clinicId: string,
  input: {
    startsAt: Date;
    service?: string | null;
    providerId?: string | null;
    durationMinutes?: number;
    holderRef?: string | null;
    fresh: boolean;
    now?: Date;
    actor?: ActorContext;
  },
): Promise<SpanCheck> {
  const found = await availableSlotsFor(clinicId, {
    from: input.startsAt,
    days: 1,
    service: input.service,
    providerId: input.providerId,
    durationMinutes: input.durationMinutes,
    holderRef: input.holderRef,
    fresh: input.fresh,
    now: input.now,
    actor: input.actor,
  });
  if (found.status !== "ok") {
    return found.status === "unavailable" && found.reason === "outside_horizon"
      ? { status: "busy" }
      : found;
  }
  const slot = found.slots.find((s) => s.at.getTime() === input.startsAt.getTime());
  return slot
    ? {
        status: "free",
        calendarId: slot.calendarId,
        providerId: slot.providerId,
        minutes: found.serviceMinutes,
      }
    : { status: "busy" };
}

export type DeskSpanCheck =
  | { status: "free"; calendarId: string; providerId: string | null }
  /** Google shows every calendar the service books into busy; `calendarId` is the first of them. */
  | { status: "busy"; calendarId: string; providerId: string | null }
  | { status: "not_writable" }
  | { status: "broken" }
  | { status: "transient" };

/**
 * For staff confirming a request (plan §6.2, §7.10 step 2): is the exact
 * span free in Google, on the calendar the service books into (the first
 * named provider who offers it and is free, else the location's own)? A
 * forced token refresh, and none of the assistant's rules: no grid, no
 * hours, no notice, no horizon. healdesk's own holds and bookings are the
 * database guard's to refuse, in the decision's own transaction.
 *
 * `calendarId` pins the answer to one calendar: where the assistant held
 * time for the request, the desk's booking goes on that hold's calendar,
 * under the hold's key, because Google's event ids are unique only within a
 * calendar, and an assistant insert that landed late on that calendar must
 * meet the desk's event there rather than sit beside it on another.
 */
export async function deskSpanFree(
  clinicId: string,
  input: {
    startsAt: Date;
    durationMinutes: number;
    service: string | null;
    calendarId?: string | null;
    actor?: ActorContext;
  },
): Promise<DeskSpanCheck> {
  const actor = input.actor ?? AVAILABILITY_ACTOR;
  const facts = await withTenant({ clinicId, actor }, async (tx) => {
    const target = await writableConnection(tx);
    if (!target) return null;
    const offered = await calendarTargetsFor(tx, target, input.service);
    const pinned = input.calendarId;
    const calendars: CalendarTarget[] = pinned
      ? [offered.find((c) => c.calendarId === pinned) ?? { calendarId: pinned, providerId: null }]
      : offered;
    const context = await openContext(tx, target, "calendar_desk_check");
    const [clinic] = await tx.db
      .select({ timezone: clinics.timezone })
      .from(clinics)
      .where(eq(clinics.id, tx.clinicId))
      .limit(1);
    return { target, calendars, context, timeZone: clinic?.timezone ?? "UTC" };
  });
  if (!facts) return { status: "not_writable" };

  const span = {
    from: input.startsAt,
    to: new Date(input.startsAt.getTime() + input.durationMinutes * MINUTE_MS),
  };
  for (const calendar of facts.calendars) {
    const listed = await googleCalendarAdapter.listSlots(
      {
        ...facts.context,
        metadata: { ...facts.context.metadata, calendarId: calendar.calendarId },
      },
      span,
      { timeZone: facts.timeZone, freshCredentials: true },
    );
    if (!listed.ok) {
      const failed = await noteReadFailure(clinicId, facts.target, calendar, listed.error, actor);
      if (failed) return failed;
      continue;
    }
    const whole = listed.value.some(
      (free) =>
        free.startsAt.getTime() <= span.from.getTime() &&
        span.to.getTime() <= free.endsAt.getTime(),
    );
    if (whole) return { status: "free", ...calendar };
  }
  const first = facts.calendars[0]!;
  return { status: "busy", ...first };
}

// -----------------------------------------------------------------------------
// Internals
// -----------------------------------------------------------------------------

/** The adapter context for the target, its token decrypt audited under `purpose`. */
export async function openContext(
  tx: TenantTx,
  target: WritableConnection,
  purpose: string,
): Promise<ConnectorContext> {
  tx.audit.record({
    action: "decrypt",
    resourceType: "credential",
    resourceId: target.connectionId,
    metadata: { provider: target.provider, purpose },
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
    metadata: { ...target.metadata, calendarId: target.calendarId },
    oauthClient: target.oauthClient,
  };
}

/**
 * A failed free/busy read. Definitive for the location (the grant, or the
 * location's own calendar): marked broken, answered `broken`. A named
 * provider's own calendar refused or gone: that calendar drops out (null).
 * Anything else: `transient`.
 */
async function noteReadFailure(
  clinicId: string,
  target: WritableConnection,
  calendar: CalendarTarget,
  error: ConnectorError,
  actor: ActorContext,
): Promise<{ status: "broken" } | { status: "transient" } | null> {
  const code = calendarBreakOf(error);
  if (!code) {
    log.warn("calendar free/busy not read", {
      clinicId,
      connectionId: target.connectionId,
      reason: error.reason ?? error.code,
    });
    return { status: "transient" };
  }
  if (calendar.providerId && !isTokenBreak(code) && calendar.calendarId !== target.calendarId) {
    log.warn("a named provider's calendar refused a free/busy read", {
      clinicId,
      connectionId: target.connectionId,
      code,
    });
    return null;
  }
  try {
    await markCalendarBroken(clinicId, {
      code,
      connectionId: target.connectionId,
      credentialVersion: target.credentialVersion,
      actor,
    });
  } catch (failure) {
    log.error("calendar break not recorded", { clinicId, error: describeError(failure) });
  }
  return { status: "broken" };
}

/** Each local date the window touches, in the clinic's zone. */
function localDatesOf(window: Span, timeZone: string): string[] {
  const dates = new Set<string>();
  for (
    let t = window.startsAt.getTime() - DAY_MS;
    t <= window.endsAt.getTime() + DAY_MS;
    t += DAY_MS / 2
  ) {
    dates.add(clinicLocalDate(new Date(t), timeZone));
  }
  return [...dates];
}

type Blocking = Span & { calendarId: string | null };

/**
 * What healdesk itself occupies in the window, by calendar (plan §6.1): live
 * holds of other holders (and of other requests than `exceptRequestId`), by
 * the database clock, and healdesk bookings (booking_origin set) that are
 * scheduled or confirmed, whatever their write status. A booking that names
 * no calendar blocks every calendar.
 */
async function blockingSpans(
  tx: TenantTx,
  window: Span,
  holderRef: string | null,
  exceptRequestId: string | null,
): Promise<Blocking[]> {
  const lookBack = new Date(window.startsAt.getTime() - MAX_SERVICE_MINUTES * MINUTE_MS);
  const lookAhead = new Date(window.endsAt.getTime() + MAX_SERVICE_MINUTES * MINUTE_MS);
  const holds = await tx.db
    .select({
      startsAt: slotHolds.startsAt,
      endsAt: slotHolds.endsAt,
      calendarId: slotHolds.calendarId,
    })
    .from(slotHolds)
    .where(
      and(
        eq(slotHolds.clinicId, tx.clinicId),
        gt(slotHolds.startsAt, lookBack),
        lt(slotHolds.startsAt, lookAhead),
        holderRef ? sql`${slotHolds.holderRef} <> ${holderRef}` : sql`true`,
        exceptRequestId
          ? sql`${slotHolds.bookingRequestId} is distinct from ${exceptRequestId}`
          : sql`true`,
        sql`((${slotHolds.status} = 'held' and ${slotHolds.expiresAt} > clock_timestamp())
             or (${slotHolds.status} in ('writing', 'unknown', 'reserved')
                 and ${slotHolds.blocksUntil} > clock_timestamp()))`,
      ),
    );
  const booked = await tx.db
    .select({
      startsAt: appointments.scheduledFor,
      minutes: appointments.durationMinutes,
      calendarId: appointments.calendarId,
    })
    .from(appointments)
    .where(
      and(
        eq(appointments.clinicId, tx.clinicId),
        isNotNull(appointments.bookingOrigin),
        inArray(appointments.status, ["scheduled", "confirmed"]),
        gt(appointments.scheduledFor, lookBack),
        lt(appointments.scheduledFor, lookAhead),
      ),
    );
  return [
    ...holds,
    ...booked.map((b) => ({
      startsAt: b.startsAt,
      endsAt: new Date(b.startsAt.getTime() + (b.minutes ?? DEFAULT_SERVICE_MINUTES) * MINUTE_MS),
      calendarId: b.calendarId,
    })),
  ];
}
