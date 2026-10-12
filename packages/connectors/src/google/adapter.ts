import { createHash, randomBytes } from "node:crypto";

import type { CapabilitySet } from "../capabilities";
import { phoneShapedKey, toDate } from "../guards";
import type { ConnectorAdapter } from "../port";
import { fail, failure, ok, type Result } from "../result";
import type {
  CanonicalAppointment,
  CanonicalContact,
  CanonicalSale,
  CanonicalSlot,
  ConnectorContext,
  CreateAppointmentInput,
  Page,
  TimeWindow,
  VerifiedInfo,
} from "../types";

import { buildEventBody } from "./event";
import {
  asString,
  fetchWithTimeout,
  googleApiError,
  googleWriteError,
  isRecord,
  onGoogleFetchChange,
  reasonWord,
  type GoogleCall,
  type GoogleReply,
} from "./http";
import { googleEventIdFor, HEALDESK_EVENT_MARKER, isHealdeskEventId } from "./ids";
import { refreshGoogleAccessToken, type GoogleOAuthClient } from "./oauth";

/**
 * Google Calendar, over Calendar API v3 with no SDK: the one place v1 writes
 * bookings, on every channel.
 *
 * Registered as `google_calendar`. That is a write target, not a booking
 * system a clinic picks at checkout: a clinic on Cal.com, or with no booking
 * software at all, connects the Google account that holds the calendar its
 * own system reads, and healdesk books into that calendar.
 *
 * One calendar per location: the connection's `metadata.calendarId`, which is
 * `primary` unless the clinic chose another calendar the account owns. Every
 * call below reads and writes that calendar and no other.
 *
 * What it does:
 *
 *   - lists the calendars the account owns (calendarList, under
 *     `calendar.calendarlist.readonly`), so the clinic can choose one;
 *   - reads when the calendar is free or busy (freeBusy, under
 *     `calendar.events.freebusy`) and hands back the free intervals;
 *   - adds an event (events.insert, under `calendar.events.owned`) that
 *     carries a first name, the service and the time, private, with no guests
 *     and no reminders (event.ts), under an id derived from our booking key
 *     (ids.ts), and never with `sendUpdates`;
 *   - reads its own event straight back by that id, so a write whose reply
 *     never arrived is found rather than repeated.
 *
 * What it never does: list, read or change an event it did not create
 * (cancelling reads the event back first and refuses one without our
 * marker), keep an access token anywhere but this process's memory, or let a
 * sentence Google wrote reach an error message: only the status and one
 * reason word that passes http.ts's allowlist.
 *
 * Tokens (plan §5.5). Every call takes an access token minted from the
 * clinic's refresh token: for a read, a cached one while it has more than
 * five minutes left; for an insert, one minted within the last minute; for
 * `verify`, the watch's probe and a read asked for `freshCredentials`, one
 * minted for that call. A read that drew a cached token and got 401 drops it
 * and tries once more with a fresh one. A 401 on a token minted for the call
 * is the answer (`access_denied`).
 */

export const GOOGLE_CALENDAR_PROVIDER = "google_calendar";
export const GOOGLE_CALENDAR_API = "https://www.googleapis.com/calendar/v3";

/** Free/busy windows longer than this are refused before Google is asked (plan §5.2). */
export const MAX_FREEBUSY_WINDOW_MS = 31 * 86_400_000;

/**
 * The calendar-list request, exactly as the addendum ("Calendar-list scope")
 * specifies it: owned calendars only, hidden ones left out, and of each entry
 * only what a picker shows. The mask leaves out `nextPageToken`, so a second
 * page cannot be followed; see CALENDAR_LIST_PAGE_SIZE for what happens
 * instead.
 */
export const CALENDAR_LIST_QUERY = Object.freeze({
  minAccessRole: "owner",
  showHidden: "false",
  fields: "items(id,summary,primary,timeZone,accessRole)",
});
/**
 * Added to the list for a location whose calendar terms are covered (HRC-04,
 * owner decision of 6 October 2026): only the calendars of the connected
 * account's own Workspace organisation. Google's owner role is not ownership,
 * so without it a calendar another domain shares in with "make changes and
 * manage sharing" is listed too, and a covered practice could book into a
 * calendar outside its own Google agreement. Google applies it only to
 * Workspace users; apps/app requires a Workspace account for covered terms
 * before it asks.
 */
export const OWN_ORGANIZATION_QUERY = Object.freeze({ showOwnOrganizationOnly: "true" });
/**
 * Google's default calendarList page. A page this full may continue past
 * what the mask lets us see, so it is refused (`too_many_calendars`) rather
 * than shown to the clinic with calendars silently missing. No practice owns
 * a hundred calendars on its booking account; the primary one still works.
 */
const CALENDAR_LIST_PAGE_SIZE = 100;

const HOUR_MS = 3_600_000;
/** A booking with no length of its own (plan §1.4 A3). */
const DEFAULT_DURATION_MINUTES = 30;
const MIN_DURATION_MINUTES = 5;
const MAX_DURATION_MINUTES = 480;
const READ_MIN_REMAINING_MS = 5 * 60_000;
const INSERT_MAX_AGE_MS = 60_000;
const TOKEN_CACHE_LIMIT = 1_000;
/** All a read-back needs, and all it asks Google for. */
const EVENT_FIELDS = "id,status,start,end,extendedProperties/private";
const TIME_ZONE = /^[A-Za-z0-9_+\-/]{1,64}$/;

const CAPABILITIES: CapabilitySet = {
  listAppointments: {
    support: "unsupported",
    note: "healdesk reads only when the calendar is free or busy and the events it added itself, never the clinic's other appointments.",
  },
  readArrival: { support: "unsupported" },
  listSales: { support: "unsupported" },
  backfillSales: { support: "unsupported" },
  listSlots: {
    support: "partial",
    note: "Google Calendar reports when the calendar is free or busy rather than bookable slots, so healdesk applies the clinic's opening hours, notice and appointment lengths itself.",
  },
  createAppointment: { support: "full" },
  findAppointmentByKey: { support: "full" },
  writeBack: { support: "unsupported" },
};

type GoogleCredentials = {
  client: GoogleOAuthClient;
  refreshToken: string;
  /** sha256 of the refresh token: the cache never holds the token itself as a key. */
  cacheKey: string;
};

type GoogleConfig = GoogleCredentials & { calendarId: string };

/**
 * A calendar id as Google writes one: `primary`, an email-shaped id for an
 * account's own calendars, or a group calendar's longer one. Never whitespace
 * or a control character, and bounded, so a corrupted value is refused rather
 * than sent.
 */
const CALENDAR_ID = /^[^\s\p{Cc}]{1,1024}$/u;

/**
 * healdesk's client and the clinic's refresh token, or a `misconfigured`
 * failure naming what is missing, before any request.
 */
function credentialsOf(context: ConnectorContext): Result<GoogleCredentials> {
  const client = context.oauthClient;
  if (!client || client.clientId.length === 0 || client.clientSecret.length === 0) {
    return failure("misconfigured", "google: healdesk's Google OAuth client is not configured", {
      reason: "oauth_client",
    });
  }
  const refreshToken = context.credentials.refresh_token;
  if (!refreshToken) {
    return failure("misconfigured", "google: the connection holds no refresh token", {
      reason: "missing_refresh_token",
    });
  }
  return ok({
    client,
    refreshToken,
    cacheKey: createHash("sha256").update(refreshToken).digest("hex"),
  });
}

/**
 * The credentials and the calendar the connection books into:
 * `metadata.calendarId`, or `primary` when the connection names none.
 *
 * Only an absent id means primary. One that is present but unreadable (an
 * object, a number, an empty string) is refused before any request: read as
 * primary, it would put a clinic's bookings into a calendar it did not choose,
 * and verify(), which resolves the id the same way, would pass against primary
 * and hide the mistake at connect time.
 */
function configOf(context: ConnectorContext): Result<GoogleConfig> {
  const credentials = credentialsOf(context);
  if (!credentials.ok) return fail(credentials.error);
  const calendarId = context.metadata?.calendarId;
  if (calendarId === undefined || calendarId === null) {
    return ok({ ...credentials.value, calendarId: "primary" });
  }
  if (typeof calendarId !== "string" || !CALENDAR_ID.test(calendarId)) {
    return failure("misconfigured", "google: the connection's calendar id is unreadable", {
      reason: "calendar_id",
    });
  }
  return ok({ ...credentials.value, calendarId });
}

// ---- Access tokens ---------------------------------------------------------

type CachedToken = { accessToken: string; expiresAt: number; mintedAt: number };

/**
 * Access tokens, in this process only. Keyed by a hash of the refresh token
 * and capped, oldest first, so a long-running worker cannot grow it without
 * bound. Dropped whenever the fetch changes (setGoogleFetch), so a token one
 * Google minted is never shown to another.
 */
const tokenCache = new Map<string, CachedToken>();
onGoogleFetchChange(() => tokenCache.clear());

/** Forget every cached access token: for tests that reuse one fake across cases. */
export function resetGoogleTokenCache(): void {
  tokenCache.clear();
}

type Token = { value: string; minted: boolean };
type TokenNeed = "read" | "insert" | "fresh";

async function tokenFor(config: GoogleCredentials, need: TokenNeed): Promise<Result<Token>> {
  const now = Date.now();
  const cached = need === "fresh" ? undefined : tokenCache.get(config.cacheKey);
  if (cached) {
    const usable =
      need === "read"
        ? cached.expiresAt - now > READ_MIN_REMAINING_MS
        : now - cached.mintedAt <= INSERT_MAX_AGE_MS && cached.expiresAt > now;
    if (usable) return ok({ value: cached.accessToken, minted: false });
  }

  const minted = await refreshGoogleAccessToken({
    client: config.client,
    refreshToken: config.refreshToken,
  });
  if (!minted.ok) {
    // A grant Google refused is not coming back on its own. A transient
    // failure leaves the cache as it was.
    if (!minted.error.retryable) tokenCache.delete(config.cacheKey);
    return fail(minted.error);
  }
  remember(config.cacheKey, {
    accessToken: minted.value.accessToken,
    expiresAt: minted.value.expiresAt.getTime(),
    mintedAt: Date.now(),
  });
  return ok({ value: minted.value.accessToken, minted: true });
}

function remember(key: string, entry: CachedToken): void {
  tokenCache.delete(key);
  if (tokenCache.size >= TOKEN_CACHE_LIMIT) {
    const oldest = tokenCache.keys().next();
    if (!oldest.done) tokenCache.delete(oldest.value);
  }
  tokenCache.set(key, entry);
}

// ---- Requests --------------------------------------------------------------

type ApiRequest = {
  method: "GET" | "POST" | "DELETE";
  url: string;
  body?: unknown;
  call: GoogleCall;
  context: string;
};

function send(token: string, request: ApiRequest): Promise<Result<GoogleReply>> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
  };
  if (request.body !== undefined) headers["Content-Type"] = "application/json";
  return fetchWithTimeout(
    request.url,
    {
      method: request.method,
      headers,
      body: request.body === undefined ? undefined : JSON.stringify(request.body),
    },
    request.call,
    request.context,
  );
}

/**
 * One request with a token: drawn from the cache for "read", minted for
 * "fresh", or one already minted earlier in the same call. Only a read that
 * drew a cached token is retried after a 401, once, with a token minted now.
 * Any 401 drops the cached token.
 */
async function call(
  config: GoogleCredentials,
  source: "read" | "fresh" | Token,
  request: ApiRequest,
): Promise<Result<GoogleReply>> {
  const token = typeof source === "string" ? await tokenFor(config, source) : ok(source);
  if (!token.ok) return fail(token.error);

  const reply = await send(token.value.value, request);
  if (!reply.ok || reply.value.status !== 401) return reply;
  tokenCache.delete(config.cacheKey);
  if (source !== "read" || token.value.minted) return reply;

  const fresh = await tokenFor(config, "fresh");
  if (!fresh.ok) return fail(fresh.error);
  const retried = await send(fresh.value.value, request);
  if (retried.ok && retried.value.status === 401) tokenCache.delete(config.cacheKey);
  return retried;
}

function eventsUrl(calendarId: string): string {
  return `${GOOGLE_CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/events`;
}

function eventUrl(calendarId: string, eventId: string, fields?: string): string {
  const url = `${eventsUrl(calendarId)}/${encodeURIComponent(eventId)}`;
  return fields ? `${url}?${new URLSearchParams({ fields }).toString()}` : url;
}

// ---- Free/busy -------------------------------------------------------------

type Busy = { start: Date; end: Date };

/**
 * POST /freeBusy for the connection's calendar over the window.
 *
 * Google keys the answer by the calendar id asked for. Only one is ever
 * asked for, so a lone entry under another key is still that calendar. A
 * per-calendar `notFound` is `calendar_not_found`, as a 404 would be.
 */
async function freeBusy(
  config: GoogleConfig,
  source: "read" | "fresh" | Token,
  window: TimeWindow,
  ctx: string,
): Promise<Result<Busy[]>> {
  const reply = await call(config, source, {
    method: "POST",
    url: `${GOOGLE_CALENDAR_API}/freeBusy`,
    body: {
      timeMin: window.from.toISOString(),
      timeMax: window.to.toISOString(),
      items: [{ id: config.calendarId }],
    },
    call: "freeBusy",
    context: ctx,
  });
  if (!reply.ok) return fail(reply.error);
  const { status, json } = reply.value;
  if (!reply.value.ok) return googleApiError(reply.value, ctx);

  const calendars = isRecord(json) && isRecord(json.calendars) ? json.calendars : undefined;
  const entries = calendars ? Object.values(calendars) : [];
  const entry = calendars?.[config.calendarId] ?? (entries.length === 1 ? entries[0] : undefined);
  if (!isRecord(entry)) {
    return malformed(ctx, "Google's free/busy answer does not name the calendar", status);
  }

  if (Array.isArray(entry.errors) && entry.errors.length > 0) {
    const reason = entry.errors
      .map((e) => (isRecord(e) ? reasonWord(e.reason) : undefined))
      .find(Boolean);
    if (reason === "notFound") {
      return fail({
        code: "misconfigured",
        message: `${ctx}: Google cannot find the calendar (notFound)`,
        retryable: false,
        status,
        reason: "calendar_not_found",
      });
    }
    if (reason === "internalError" || reason === "backendError") {
      return fail({
        code: "unavailable",
        message: `${ctx}: Google answered ${reason}`,
        retryable: true,
        status,
        reason,
      });
    }
    return fail({
      code: "unknown",
      message: `${ctx}: Google could not answer for the calendar (${reason ?? "no reason"})`,
      retryable: false,
      status,
      reason: reason ?? "calendar_error",
    });
  }

  if (entry.busy === undefined) return ok([]);
  if (!Array.isArray(entry.busy)) return malformed(ctx, "the busy list is not a list", status);
  const busy: Busy[] = [];
  for (const period of entry.busy) {
    const start = isRecord(period) ? dateOf(period.start) : undefined;
    const end = isRecord(period) ? dateOf(period.end) : undefined;
    if (!start || !end || end < start) {
      return malformed(ctx, "a busy period has no readable start and end", status);
    }
    busy.push({ start, end });
  }
  return ok(busy);
}

/**
 * The free intervals of a half-open window: busy periods clipped to it,
 * merged where they touch or overlap, and the gaps between them returned,
 * sorted and maximal. Every busy period is half-open too, so an event ending
 * at 10:00 frees 10:00.
 */
function freeIntervals(window: TimeWindow, busy: readonly Busy[]): CanonicalSlot[] {
  const sorted = [...busy].sort((a, b) => a.start.getTime() - b.start.getTime());
  const free: CanonicalSlot[] = [];
  let cursor = window.from.getTime();
  const end = window.to.getTime();
  for (const period of sorted) {
    const start = Math.max(period.start.getTime(), window.from.getTime());
    const stop = Math.min(period.end.getTime(), end);
    if (stop <= start) continue;
    if (start > cursor) free.push({ startsAt: new Date(cursor), endsAt: new Date(start) });
    cursor = Math.max(cursor, stop);
  }
  if (cursor < end) free.push({ startsAt: new Date(cursor), endsAt: new Date(end) });
  return free;
}

// ---- Events ----------------------------------------------------------------

type ReadEvent = {
  id: string;
  status: string | undefined;
  startsAt: Date | undefined;
  endsAt: Date | undefined;
  /** Carries HEALDESK_EVENT_MARKER: the only proof the event is ours. */
  ours: boolean;
};

function eventOf(json: unknown): ReadEvent | undefined {
  if (!isRecord(json)) return undefined;
  const id = asString(json.id);
  if (!id) return undefined;
  const props =
    isRecord(json.extendedProperties) && isRecord(json.extendedProperties.private)
      ? json.extendedProperties.private
      : undefined;
  return {
    id,
    status: asString(json.status),
    startsAt: isRecord(json.start) ? dateOf(json.start.dateTime) : undefined,
    endsAt: isRecord(json.end) ? dateOf(json.end.dateTime) : undefined,
    ours: props?.healdesk === HEALDESK_EVENT_MARKER.healdesk,
  };
}

function dateOf(value: unknown): Date | undefined {
  return typeof value === "string" ? toDate(value) : undefined;
}

type Booked = { externalId: string; startsAt: Date; endsAt: Date; adopted?: boolean };

/**
 * A 409 on insert: Google has already seen this event id. Read it back. Our
 * own live event is the booking we were making, so it is adopted, with its
 * own times for the caller to compare. A deleted one means the clinic removed
 * that booking, and the id is never written again; it is checked before the
 * marker because Google only promises a deleted event's id. An event without
 * our marker is a conflict nobody can resolve by retrying. A read-back that
 * fails or cannot be read leaves the outcome unknown (`unconfirmed`, a
 * timeout or a network failure), never a plain no.
 */
async function adoptOrRefuse(
  config: GoogleConfig,
  token: Token,
  eventId: string,
  ctx: string,
): Promise<Result<Booked>> {
  const readBack = `${ctx} (read-back)`;
  const back = await call(config, token, {
    method: "GET",
    url: eventUrl(config.calendarId, eventId, EVENT_FIELDS),
    call: "get",
    context: readBack,
  });
  if (!back.ok) return fail(back.error);
  const { status } = back.value;
  if (status === 410) return deletedInCalendar(ctx, 409);
  if (status === 404) return conflict(ctx);
  if (!back.value.ok) return googleWriteError(back.value, readBack);

  const event = eventOf(back.value.json);
  if (!event || event.id !== eventId) return unconfirmed(readBack, status);
  if (event.status === "cancelled") return deletedInCalendar(ctx, 409);
  if (!event.ours) return conflict(ctx);
  const live = event.status === "confirmed" || event.status === "tentative";
  if (!live || !event.startsAt || !event.endsAt) return unconfirmed(readBack, status);
  return ok({
    externalId: event.id,
    startsAt: event.startsAt,
    endsAt: event.endsAt,
    adopted: true,
  });
}

/**
 * Google answered, but not in a way that says whether our booking exists:
 * read back before retrying.
 */
function unconfirmed<T>(ctx: string, status: number): Result<T> {
  return failure(
    "malformed_response",
    `${ctx}: Google answered ${status} without a readable event; read back before retrying`,
    { status, reason: "unconfirmed" },
  );
}

function deletedInCalendar<T>(ctx: string, status: number): Result<T> {
  return fail({
    code: "unknown",
    message: `${ctx}: the clinic deleted this booking's event in Google Calendar, so its id is not written again`,
    retryable: false,
    status,
    reason: "deleted_in_calendar",
  });
}

function conflict<T>(ctx: string): Result<T> {
  return fail({
    code: "unknown",
    message: `${ctx}: Google holds an event under this booking's id that healdesk cannot adopt`,
    retryable: false,
    status: 409,
    reason: "conflict",
  });
}

function malformed<T>(ctx: string, what: string, status: number): Result<T> {
  return failure("malformed_response", `${ctx}: ${what}`, { status, reason: "malformed_response" });
}

function knownTimeZone(timeZone: unknown): boolean {
  if (typeof timeZone !== "string" || timeZone.length === 0) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** Everything wrong with a create's input, found before a token is minted or a request made. */
function refusedInput<T>(input: CreateAppointmentInput, ctx: string): Result<T> | null {
  const phoneKey = phoneShapedKey(input);
  if (phoneKey) {
    return failure(
      "unsupported",
      `${ctx}: refusing an input that carries "${phoneKey}"; the port has no phone field and no adapter may be handed one`,
      { reason: "phone_field_refused" },
    );
  }
  if (typeof input.idempotencyKey !== "string" || input.idempotencyKey.length === 0) {
    return failure("unsupported", `${ctx}: no booking key`, { reason: "missing_key" });
  }
  if (!(input.startsAt instanceof Date) || Number.isNaN(input.startsAt.getTime())) {
    return failure("unsupported", `${ctx}: no start time`, { reason: "bad_start" });
  }
  const minutes = input.durationMinutes ?? DEFAULT_DURATION_MINUTES;
  if (
    !Number.isInteger(minutes) ||
    minutes < MIN_DURATION_MINUTES ||
    minutes > MAX_DURATION_MINUTES
  ) {
    return failure("unsupported", `${ctx}: a booking lasts 5 to 480 minutes`, {
      reason: "bad_duration",
    });
  }
  if (!knownTimeZone(input.attendee.timeZone)) {
    return failure("misconfigured", `${ctx}: the clinic's time zone is not one Intl knows`, {
      reason: "bad_time_zone",
    });
  }
  return null;
}

// ---- The adapter -------------------------------------------------------------

/** One calendar the connected account owns, as a picker shows it. */
export type OwnedGoogleCalendar = {
  /**
   * Google's id for the calendar. The primary calendar's id is usually the
   * account's own email address, so a caller storing the choice stores
   * `primary` for it, and no caller puts an id in an audit row or a log line.
   */
  id: string;
  /** The name its owner gave it: the clinic's own words, shown to the clinic, never audited or logged. */
  summary: string | null;
  primary: boolean;
  timeZone: string | null;
};

export class GoogleCalendarAdapter implements ConnectorAdapter {
  readonly id = GOOGLE_CALENDAR_PROVIDER;
  readonly displayName = "Google Calendar";
  readonly capabilities = CAPABILITIES;

  /**
   * The connect-time check (plan §4.9), also the ops "verify now" and the
   * re-check after a clinic chooses another calendar: a token minted now,
   * free/busy for the next hour on the connection's calendar, then
   * events.list on that same calendar, filtered on a private property no
   * event carries and asking only for its access role and time zone. It reads
   * zero events and inserts nothing, and it refuses a calendar the connected
   * account does not own, because `calendar.events.owned` could not write
   * there. The watch does not use it (probeGoogleToken below).
   */
  async verify(context: ConnectorContext): Promise<Result<VerifiedInfo>> {
    const ctx = "google verify";
    const config = configOf(context);
    if (!config.ok) return fail(config.error);
    const token = await tokenFor(config.value, "fresh");
    if (!token.ok) return fail(token.error);

    const now = Date.now();
    const busy = await freeBusy(
      config.value,
      token.value,
      { from: new Date(now), to: new Date(now + HOUR_MS) },
      ctx,
    );
    if (!busy.ok) return fail(busy.error);

    const url = new URL(eventsUrl(config.value.calendarId));
    url.searchParams.set("maxResults", "1");
    url.searchParams.set("timeMin", new Date(now).toISOString());
    url.searchParams.set("timeMax", new Date(now + 60_000).toISOString());
    url.searchParams.set(
      "privateExtendedProperty",
      `healdeskProbe=${randomBytes(8).toString("hex")}`,
    );
    url.searchParams.set("fields", "accessRole,timeZone");
    const listed = await call(config.value, token.value, {
      method: "GET",
      url: url.toString(),
      call: "list",
      context: ctx,
    });
    if (!listed.ok) return fail(listed.error);
    const { status, json } = listed.value;
    if (!listed.value.ok) return googleApiError(listed.value, ctx);

    const accessRole = isRecord(json) ? reasonWord(json.accessRole) : undefined;
    const timeZone =
      isRecord(json) && typeof json.timeZone === "string" && TIME_ZONE.test(json.timeZone)
        ? json.timeZone
        : undefined;
    if (!accessRole || !timeZone) {
      return malformed(
        ctx,
        "Google did not report the calendar's access role and time zone",
        status,
      );
    }
    if (accessRole !== "owner") {
      return failure(
        "misconfigured",
        `${ctx}: the connected account is ${accessRole} on this calendar, not its owner`,
        { status, reason: "not_calendar_owner" },
      );
    }
    return ok({
      accountLabel: "Google Calendar",
      coverageStartedAt: null,
      calendar: { timeZone, accessRole },
    });
  }

  /**
   * The calendars the connected account owns, primary first, for the picker a
   * clinic sees when it owns more than one (addendum, "Calendar-list scope").
   *
   * One GET of /users/me/calendarList with CALENDAR_LIST_QUERY: owned,
   * unhidden calendars only, and only the fields a picker shows. Every entry
   * whose role is not `owner` is dropped here even so: `calendar.events.owned`
   * writes only to calendars the account owns, so any other calendar on the
   * list is one healdesk could never book into. An entry that cannot be read,
   * or a page so full it may continue, fails the whole list rather than
   * showing a picker with a calendar silently missing. The names are the
   * clinic's own words for its own portal: nothing here logs or audits them.
   *
   * It needs the connection's credentials but not its calendar, so a clinic
   * whose stored choice has become unusable can still choose again.
   *
   * `ownOrganizationOnly` adds OWN_ORGANIZATION_QUERY: the list a covered
   * location chooses from, and the one its every write is checked against.
   */
  async listCalendars(
    context: ConnectorContext,
    options: { ownOrganizationOnly?: boolean } = {},
  ): Promise<Result<OwnedGoogleCalendar[]>> {
    const ctx = "google listCalendars";
    const config = credentialsOf(context);
    if (!config.ok) return fail(config.error);

    const url = new URL(`${GOOGLE_CALENDAR_API}/users/me/calendarList`);
    const query = options.ownOrganizationOnly
      ? { ...CALENDAR_LIST_QUERY, ...OWN_ORGANIZATION_QUERY }
      : CALENDAR_LIST_QUERY;
    for (const [name, value] of Object.entries(query)) {
      url.searchParams.set(name, value);
    }
    const reply = await call(config.value, "read", {
      method: "GET",
      url: url.toString(),
      call: "calendarList",
      context: ctx,
    });
    if (!reply.ok) return fail(reply.error);
    const { status, json } = reply.value;
    if (!reply.value.ok) return googleApiError(reply.value, ctx);
    if (!isRecord(json)) {
      return malformed(ctx, "Google answered without a readable calendar list", status);
    }
    // An account with no calendar matching the query comes back with no `items` at all.
    const items = json.items ?? [];
    if (!Array.isArray(items)) return malformed(ctx, "the calendar list is not a list", status);
    if (items.length >= CALENDAR_LIST_PAGE_SIZE) {
      return failure(
        "unsupported",
        `${ctx}: the account owns more calendars than one page of Google's list holds`,
        { status, reason: "too_many_calendars" },
      );
    }

    const owned: OwnedGoogleCalendar[] = [];
    for (const item of items) {
      const id = isRecord(item) ? asString(item.id) : undefined;
      if (!isRecord(item) || !id || !CALENDAR_ID.test(id)) {
        return malformed(ctx, "a calendar list entry has no usable id", status);
      }
      if (item.accessRole !== "owner") continue;
      owned.push({
        id,
        summary: typeof item.summary === "string" ? item.summary : null,
        primary: item.primary === true,
        timeZone:
          typeof item.timeZone === "string" && TIME_ZONE.test(item.timeZone) ? item.timeZone : null,
      });
    }
    return ok([...owned.filter((c) => c.primary), ...owned.filter((c) => !c.primary)]);
  }

  async listAppointments(): Promise<Result<Page<CanonicalAppointment>>> {
    return failure(
      "unsupported",
      "google listAppointments: healdesk reads only free and busy times and its own events from Google Calendar",
    );
  }

  async listSales(): Promise<Result<Page<CanonicalSale>>> {
    return failure("unsupported", "google listSales: Google Calendar holds no sales");
  }

  async listContacts(): Promise<Result<Page<CanonicalContact>>> {
    return failure("unsupported", "google listContacts: healdesk reads no contacts from Google");
  }

  /**
   * The calendar's free intervals over the window: the merged, sorted,
   * half-open complement of what Google reports busy. The time zone and
   * duration the port passes are not needed: the answer is instants, and the
   * caller lays its own hours and lengths over it.
   */
  async listSlots(
    context: ConnectorContext,
    window: TimeWindow,
    opts: { timeZone: string; durationMinutes?: number; freshCredentials?: boolean },
  ): Promise<Result<CanonicalSlot[]>> {
    const ctx = "google listSlots";
    const span = window.to.getTime() - window.from.getTime();
    if (!(span > 0)) {
      return failure("unsupported", `${ctx}: the window is empty`, { reason: "bad_window" });
    }
    if (span > MAX_FREEBUSY_WINDOW_MS) {
      return failure("unsupported", `${ctx}: windows over 31 days are not asked of Google`, {
        reason: "window_too_long",
      });
    }
    const config = configOf(context);
    if (!config.ok) return fail(config.error);

    const busy = await freeBusy(
      config.value,
      opts.freshCredentials ? "fresh" : "read",
      window,
      ctx,
    );
    if (!busy.ok) return fail(busy.error);
    return ok(freeIntervals(window, busy.value));
  }

  /**
   * POST /calendars/{id}/events with the event.ts body, under the id derived
   * from the booking key, with a token minted within the last minute. No
   * `sendUpdates`: the event has no guests to notify.
   *
   * A 409 means Google has seen the id: see adoptOrRefuse. A 2xx whose body
   * cannot be read and a 5xx (`unconfirmed`), a timeout and a network failure
   * all mean the outcome is unknown: read back before anything is tried
   * again. Any other answer is Google's no, mapped by googleApiError.
   */
  async createAppointment(
    context: ConnectorContext,
    input: CreateAppointmentInput,
  ): Promise<Result<Booked>> {
    const ctx = "google createAppointment";
    const refused = refusedInput<Booked>(input, ctx);
    if (refused) return refused;
    const config = configOf(context);
    if (!config.ok) return fail(config.error);

    const eventId = googleEventIdFor(input.idempotencyKey);
    const minutes = input.durationMinutes ?? DEFAULT_DURATION_MINUTES;
    const body = buildEventBody({
      eventId,
      firstName: input.attendee.name,
      service: input.service,
      startsAt: input.startsAt,
      endsAt: new Date(input.startsAt.getTime() + minutes * 60_000),
      timeZone: input.attendee.timeZone,
      origin: input.origin ?? "desk",
    });

    const token = await tokenFor(config.value, "insert");
    if (!token.ok) return fail(token.error);
    const reply = await send(token.value.value, {
      method: "POST",
      url: eventsUrl(config.value.calendarId),
      body,
      call: "insert",
      context: ctx,
    });
    if (!reply.ok) return fail(reply.error);
    const { status } = reply.value;
    if (status === 401) tokenCache.delete(config.value.cacheKey);
    if (status === 409) return adoptOrRefuse(config.value, token.value, eventId, ctx);
    if (!reply.value.ok) return googleWriteError(reply.value, ctx);

    const created = eventOf(reply.value.json);
    // A 2xx we cannot read may still have booked the slot. Say so: the caller
    // must read back before it retries.
    if (!created || created.id !== eventId || !created.startsAt || !created.endsAt) {
      return unconfirmed(ctx, status);
    }
    return ok({ externalId: created.id, startsAt: created.startsAt, endsAt: created.endsAt });
  }

  /**
   * GET the event under the id derived from the key, asking only for what the
   * read-back needs. Ours and live: the booking. 404: nothing under the key.
   * Deleted by the clinic (cancelled, or 410): `deleted_in_calendar`, which
   * is terminal. `attendeeEmail` and `around` are not needed and not sent.
   */
  async findAppointmentByKey(
    context: ConnectorContext,
    input: { idempotencyKey: string; attendeeEmail?: string; around: Date },
  ): Promise<Result<{ externalId: string; startsAt: Date; endsAt: Date } | null>> {
    const ctx = "google findAppointmentByKey";
    if (typeof input.idempotencyKey !== "string" || input.idempotencyKey.length === 0) {
      return failure("unsupported", `${ctx}: no booking key`, { reason: "missing_key" });
    }
    const config = configOf(context);
    if (!config.ok) return fail(config.error);

    const eventId = googleEventIdFor(input.idempotencyKey);
    const reply = await call(config.value, "read", {
      method: "GET",
      url: eventUrl(config.value.calendarId, eventId, EVENT_FIELDS),
      call: "get",
      context: ctx,
    });
    if (!reply.ok) return fail(reply.error);
    const { status } = reply.value;
    if (status === 404) return ok(null);
    if (status === 410) return deletedInCalendar(ctx, status);
    if (!reply.value.ok) return googleApiError(reply.value, ctx);

    const event = eventOf(reply.value.json);
    if (!event || event.id !== eventId) {
      return malformed(ctx, "Google answered without a readable event", status);
    }
    if (event.status === "cancelled") return deletedInCalendar(ctx, status);
    if (!event.ours) {
      return fail({
        code: "unknown",
        message: `${ctx}: the event under this booking's id does not carry healdesk's marker`,
        retryable: false,
        status,
        reason: "not_ours",
      });
    }
    if (!event.startsAt || !event.endsAt) {
      return malformed(ctx, "the event has no readable start and end", status);
    }
    return ok({ externalId: event.id, startsAt: event.startsAt, endsAt: event.endsAt });
  }

  /**
   * Delete an event healdesk created. Refused, with no request, unless the id
   * has our shape; then refused unless Google shows our marker on it. No v1
   * product path calls this: it exists so the contract test can prove the
   * adapter will not touch the clinic's own events. Nothing left under the
   * id, or an event already deleted, is the state the caller asked for, and
   * is answered without a DELETE whatever the deleted event still shows.
   */
  async cancelAppointment(
    context: ConnectorContext,
    externalId: string,
    _reason: string,
  ): Promise<Result<void>> {
    const ctx = "google cancelAppointment";
    if (!isHealdeskEventId(externalId)) {
      return failure("unsupported", `${ctx}: refusing to cancel an event healdesk did not create`, {
        reason: "not_ours",
      });
    }
    const config = configOf(context);
    if (!config.ok) return fail(config.error);

    const looked = await call(config.value, "read", {
      method: "GET",
      url: eventUrl(config.value.calendarId, externalId, EVENT_FIELDS),
      call: "get",
      context: `${ctx} (lookup)`,
    });
    if (!looked.ok) return fail(looked.error);
    if (looked.value.status === 404 || looked.value.status === 410) return ok(undefined);
    if (!looked.value.ok) return googleApiError(looked.value, `${ctx} (lookup)`);
    const event = eventOf(looked.value.json);
    if (event?.status === "cancelled") return ok(undefined);
    if (!event || !event.ours) {
      return failure(
        "unsupported",
        `${ctx}: refusing to cancel an event that does not carry healdesk's marker`,
        {
          reason: "not_ours",
        },
      );
    }

    const deleted = await call(config.value, "read", {
      method: "DELETE",
      url: eventUrl(config.value.calendarId, externalId),
      call: "delete",
      context: ctx,
    });
    if (!deleted.ok) return fail(deleted.error);
    if (deleted.value.ok || deleted.value.status === 410) return ok(undefined);
    return googleApiError(deleted.value, ctx);
  }
}

export const googleCalendarAdapter = new GoogleCalendarAdapter();

/**
 * The watch's probe (plan §9.2 step 3, owner decision 5): a refresh-token
 * exchange forced on every run, never a cached access token, then one
 * minimal free/busy query on the connection's calendar for the next hour.
 * Nothing else: no events.list, no access-role check, nothing read or
 * written. A failure's code and reason are what the watch classifies.
 */
export async function probeGoogleToken(context: ConnectorContext): Promise<Result<void>> {
  const ctx = "google probe";
  const config = configOf(context);
  if (!config.ok) return fail(config.error);
  const token = await tokenFor(config.value, "fresh");
  if (!token.ok) return fail(token.error);
  const now = Date.now();
  const busy = await freeBusy(
    config.value,
    token.value,
    { from: new Date(now), to: new Date(now + HOUR_MS) },
    ctx,
  );
  return busy.ok ? ok(undefined) : fail(busy.error);
}
