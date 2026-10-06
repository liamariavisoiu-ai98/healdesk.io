import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

import {
  CALENDAR_LIST_QUERY,
  GOOGLE_CALENDAR_API,
  GOOGLE_CALENDAR_PROVIDER,
  googleCalendarAdapter as adapter,
  MAX_FREEBUSY_WINDOW_MS,
  probeGoogleToken,
} from "../src/google/adapter";
import {
  fakeGoogleCalendar,
  type FakeGoogleCalendar,
  type FakeGoogleRequest,
} from "../src/google/fake";
import { GOOGLE_TIMEOUTS_MS, setGoogleFetch, setGoogleTimeouts } from "../src/google/http";
import { googleEventIdFor, isHealdeskEventId } from "../src/google/ids";
import { getAdapter } from "../src/registry";
import type { ConnectorError, Result } from "../src/result";
import type { ConnectorContext, CreateAppointmentInput } from "../src/types";

/**
 * The Google Calendar adapter against the in-memory Google, request by
 * request. Never a live call: the global fetch throws for the whole file, so
 * a request that escaped setGoogleFetch would fail here instead of reaching
 * Google.
 *
 * The contract test proves the adapter books, reads back and cancels. This
 * file proves what it sends while doing it, because that is what the calendar
 * terms promise the practice: an event carries a first name, the service and
 * the time, privately, with no guests and no reminders, in the calendar the
 * clinic chose; the watch's probe reads nothing but free/busy; and nothing
 * Google wrote, no token and no calendar id reaches an error message.
 */

const SUB = "100000000000000000001";
const ACCOUNT_EMAIL = "bookings@practice.example";
const ZONE = "America/New_York";
const KEY = "hold:5b1f4e0c-0000-4000-8000-000000000001";
const START = new Date("2026-10-07T14:00:00Z");
const WINDOW = { from: new Date("2026-10-07T13:00:00Z"), to: new Date("2026-10-07T21:00:00Z") };

const OPENID = "openid";
const EMAIL = "https://www.googleapis.com/auth/userinfo.email";
const FREEBUSY = "https://www.googleapis.com/auth/calendar.events.freebusy";
const OWNED = "https://www.googleapis.com/auth/calendar.events.owned";

/** Google's sentences, as the fake writes them: none may reach an error message. */
const GOOGLE_SENTENCES =
  /Synthetic failure|Invalid Credentials|insufficient authentication scopes|writer access|expired or revoked|administrator|Not Found/;

let google: FakeGoogleCalendar;
let refreshToken: string;

beforeAll(() => {
  vi.stubGlobal("fetch", () => {
    throw new Error("live call attempted from the Google adapter tests");
  });
});
afterAll(() => vi.unstubAllGlobals());

/** A fresh Google holding one Workspace account with all five scopes granted. */
function freshGoogle(): void {
  google = fakeGoogleCalendar();
  google.addAccount({ sub: SUB, email: ACCOUNT_EMAIL, hd: "practice.example" });
  refreshToken = google.grant({ sub: SUB }).refreshToken;
  // Installing a fetch also empties the adapter's cache of access tokens.
  setGoogleFetch(google.fetch);
}

beforeEach(freshGoogle);

afterEach(() => {
  setGoogleFetch(undefined);
  setGoogleTimeouts(undefined);
  vi.useRealTimers();
});

function contextFor(over: Partial<ConnectorContext> = {}): ConnectorContext {
  return {
    clinicId: "11111111-1111-4111-8111-111111111111",
    connectionId: "22222222-2222-4222-8222-222222222222",
    credentials: { refresh_token: refreshToken },
    metadata: { calendarId: "primary" },
    oauthClient: google.client,
    ...over,
  };
}

/** A context whose connection books into another calendar. */
const onCalendar = (calendarId: unknown) => contextFor({ metadata: { calendarId } });

function booking(over: Partial<CreateAppointmentInput> = {}): CreateAppointmentInput {
  return {
    startsAt: START,
    durationMinutes: 45,
    attendee: { name: "Avery Quinn", email: "bookings+req-1@sink.healdesk.io", timeZone: ZONE },
    origin: "assistant",
    service: "Botox",
    idempotencyKey: KEY,
    ...over,
  };
}

const create = (input: CreateAppointmentInput = booking(), ctx = contextFor()) =>
  adapter.createAppointment(ctx, input);
const find = (key = KEY, ctx = contextFor()) =>
  adapter.findAppointmentByKey(ctx, { idempotencyKey: key, around: START });
const slots = (ctx = contextFor(), opts: { freshCredentials?: boolean } = {}) =>
  adapter.listSlots(ctx, WINDOW, { timeZone: ZONE, ...opts });
const cancel = (id: string, ctx = contextFor()) => adapter.cancelAppointment(ctx, id, "test");
/** A booking whose attendee is named `name`. */
const named = (name: string, over: Partial<CreateAppointmentInput> = {}) => {
  const input = booking(over);
  return { ...input, attendee: { ...input.attendee, name } };
};

function succeeded<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`expected success, got ${JSON.stringify(result.error)}`);
  return result.value;
}

function failed(result: Result<unknown>): ConnectorError {
  if (result.ok) throw new Error(`expected a failure, got ${JSON.stringify(result.value)}`);
  return result.error;
}

const endpoints = () => google.requests.map((request) => request.endpoint);
const requestsTo = (endpoint: FakeGoogleRequest["endpoint"]) =>
  google.requests.filter((request) => request.endpoint === endpoint);
const bodiesOf = <T>(endpoint: FakeGoogleRequest["endpoint"]) =>
  requestsTo(endpoint).map((request) => request.json as T);

/** The calendar id a request addressed, from its path or its free/busy body. */
function calendarAddressed(request: FakeGoogleRequest): string | undefined {
  if (request.endpoint === "freeBusy") {
    const items = (request.json as { items?: Array<{ id: string }> }).items ?? [];
    return items.length === 1 ? items[0]?.id : undefined;
  }
  const match = /^\/calendar\/v3\/calendars\/([^/]+)\/events/.exec(request.url.pathname);
  return match?.[1] ? decodeURIComponent(match[1]) : undefined;
}

describe("registration", () => {
  test("google_calendar writes and reads back in full, and lists free time in part", () => {
    expect(GOOGLE_CALENDAR_PROVIDER).toBe("google_calendar");
    expect(getAdapter(GOOGLE_CALENDAR_PROVIDER)).toBe(adapter);
    const support = Object.fromEntries(
      Object.entries(adapter.capabilities).map(([name, capability]) => [name, capability.support]),
    );
    expect(support).toEqual({
      listAppointments: "unsupported",
      readArrival: "unsupported",
      listSales: "unsupported",
      backfillSales: "unsupported",
      listSlots: "partial",
      createAppointment: "full",
      findAppointmentByKey: "full",
      writeBack: "unsupported",
    });
  });

  test("the clinic's own appointments, sales and contacts are never read", async () => {
    for (const result of [
      await adapter.listAppointments(),
      await adapter.listSales(),
      await adapter.listContacts(),
    ]) {
      expect(failed(result).code).toBe("unsupported");
    }
    expect(google.requests).toHaveLength(0);
  });
});

describe("the event body (plan §5.3)", () => {
  test("a first name, the service and the time, private, with no guests or reminders, and nothing else", async () => {
    expect(succeeded(await create())).toEqual({
      externalId: googleEventIdFor(KEY),
      startsAt: START,
      endsAt: new Date("2026-10-07T14:45:00Z"),
    });

    const [insert] = requestsTo("insert");
    expect(insert?.method).toBe("POST");
    expect(insert?.url.pathname).toBe("/calendar/v3/calendars/primary/events");
    // No sendUpdates, and no query at all: the event has nobody to notify.
    expect(insert?.url.search).toBe("");
    expect(insert?.json).toEqual({
      id: googleEventIdFor(KEY),
      summary: "Avery – Botox",
      description: "Booked by your healdesk assistant.",
      start: { dateTime: "2026-10-07T14:00:00.000Z", timeZone: ZONE },
      end: { dateTime: "2026-10-07T14:45:00.000Z", timeZone: ZONE },
      visibility: "private",
      transparency: "opaque",
      reminders: { useDefault: false },
      guestsCanInviteOthers: false,
      guestsCanSeeOtherGuests: false,
      extendedProperties: { private: { healdesk: "v1" } },
    });
    // No attendee address, surname or booking reference anywhere on the wire.
    for (const request of google.requests) {
      const wire = `${request.url.href} ${request.body ?? ""}`;
      for (const secret of ["sink.healdesk.io", "Quinn", KEY, "5b1f4e0c"]) {
        expect(wire).not.toContain(secret);
      }
    }
    expect(insert?.body).not.toContain("@");
    expect(google.event(SUB, googleEventIdFor(KEY))?.inserted).toEqual(insert?.json);
  });

  test("a staff confirmation says so, and so does a booking that does not say who made it", async () => {
    await create(booking({ origin: "desk", idempotencyKey: "req-1" }));
    await create(booking({ origin: undefined, idempotencyKey: "req-2" }));
    expect(bodiesOf<{ description: string }>("insert").map((body) => body.description)).toEqual([
      "Added by healdesk after your front desk confirmed it.",
      "Added by healdesk after your front desk confirmed it.",
    ]);
  });

  test("only a clean first name and a clean service survive; anything else is Patient or Appointment", async () => {
    const cases: Array<[name: string, service: string | null, summary: string]> = [
      ["Avery Quinn", "Botox", "Avery – Botox"],
      ["  O'Brien-Smith   Jo ", "Lip filler", "O'Brien-Smith – Lip filler"],
      ["Zoë Hart", "Botox, 2 areas", "Zoë – Botox, 2 areas"],
      ["Avery", null, "Avery – Appointment"],
      ["avery@example.com", "Botox", "Patient – Botox"],
      ["5550101234", "Botox", "Patient – Botox"],
      ["", "Botox", "Patient – Botox"],
      ["Avery", "Call 555 010 1234", "Avery – Appointment"],
      ["Avery", "Consult 5550101", "Avery – Appointment"],
      ["Avery", "front@desk.example", "Avery – Appointment"],
      ["Avery", "Botox diagnosis review", "Avery – Appointment"],
      ["Avery", "Dosage check", "Avery – Appointment"],
      ["Avery", "   ", "Avery – Appointment"],
    ];
    for (const [i, [name, service]] of cases.entries()) {
      succeeded(await create(named(name, { idempotencyKey: `case-${i}`, service })));
    }
    expect(bodiesOf<{ summary: string }>("insert").map((body) => body.summary)).toEqual(
      cases.map(([, , summary]) => summary),
    );
  });

  test("no duration means 30 minutes", async () => {
    const created = succeeded(await create(booking({ durationMinutes: null })));
    expect(created.endsAt).toEqual(new Date("2026-10-07T14:30:00Z"));
  });

  test("a phone-shaped key anywhere in the input is refused before any request", async () => {
    const input = booking();
    for (const smuggled of [
      { ...input, attendee: { ...input.attendee, phoneNumber: "+15550101234" } },
      { ...input, mobile: "+15550101234" },
      { ...input, attendee: { ...input.attendee, contact: { tel: "+15550101234" } } },
    ]) {
      const error = failed(await create(smuggled as unknown as CreateAppointmentInput));
      expect(error.reason).toBe("phone_field_refused");
      expect(error.message).not.toContain("5550101234");
    }
    expect(google.requests).toHaveLength(0);
  });

  test("a bad duration, no key, an unreadable start or an unknown zone is refused unasked", async () => {
    for (const durationMinutes of [0, 4, 481, 2.5, Number.NaN]) {
      expect(failed(await create(booking({ durationMinutes }))).reason).toBe("bad_duration");
    }
    expect(failed(await create(booking({ idempotencyKey: "" }))).reason).toBe("missing_key");
    expect(failed(await create(booking({ startsAt: new Date("not a date") }))).reason).toBe(
      "bad_start",
    );
    const input = booking();
    const elsewhere = { ...input, attendee: { ...input.attendee, timeZone: "Mars/Olympus" } };
    expect(failed(await create(elsewhere))).toMatchObject({
      code: "misconfigured",
      reason: "bad_time_zone",
    });
    expect(failed(await find("")).reason).toBe("missing_key");
    expect(google.requests).toHaveLength(0);
  });
});

describe("free time (listSlots)", () => {
  test("the merged, sorted, half-open complement of busy, over exactly the window asked", async () => {
    google.addBusy(SUB, new Date("2026-10-07T14:00:00Z"), new Date("2026-10-07T15:00:00Z"));
    google.addBusy(SUB, new Date("2026-10-07T14:30:00Z"), new Date("2026-10-07T16:00:00Z"));
    google.addBusy(SUB, new Date("2026-10-07T18:00:00Z"), new Date("2026-10-07T18:30:00Z"));
    google.addBusy(SUB, new Date("2026-10-07T20:30:00Z"), new Date("2026-10-07T23:00:00Z"));
    // A clinic event marked "free" does not block, as in Google.
    google.addEvent(SUB, {
      start: new Date("2026-10-07T17:00:00Z"),
      end: new Date("2026-10-07T17:30:00Z"),
      transparency: "transparent",
    });

    const free = succeeded(await slots());
    expect(free.map((slot) => [slot.startsAt.toISOString(), slot.endsAt.toISOString()])).toEqual([
      ["2026-10-07T13:00:00.000Z", "2026-10-07T14:00:00.000Z"],
      ["2026-10-07T16:00:00.000Z", "2026-10-07T18:00:00.000Z"],
      ["2026-10-07T18:30:00.000Z", "2026-10-07T20:30:00.000Z"],
    ]);

    expect(endpoints()).toEqual(["token", "freeBusy"]);
    expect(bodiesOf("freeBusy")).toEqual([
      {
        timeMin: WINDOW.from.toISOString(),
        timeMax: WINDOW.to.toISOString(),
        items: [{ id: "primary" }],
      },
    ]);
  });

  test("an event ending at 10:00 frees 10:00, and a calendar busy all window is no free time", async () => {
    google.addBusy(SUB, WINDOW.from, new Date("2026-10-07T15:00:00Z"));
    expect(succeeded(await slots())[0]?.startsAt.toISOString()).toBe("2026-10-07T15:00:00.000Z");

    google.addBusy(SUB, new Date("2026-10-07T12:00:00Z"), new Date("2026-10-08T00:00:00Z"));
    expect(succeeded(await slots())).toEqual([]);
  });

  test("a window over 31 days, or an empty one, is refused before any request", async () => {
    const from = WINDOW.from;
    const lasting = (ms: number) =>
      adapter.listSlots(
        contextFor(),
        { from, to: new Date(from.getTime() + ms) },
        { timeZone: ZONE },
      );
    expect(failed(await lasting(MAX_FREEBUSY_WINDOW_MS + 1))).toMatchObject({
      code: "unsupported",
      reason: "window_too_long",
    });
    expect(failed(await lasting(0)).reason).toBe("bad_window");
    expect(google.requests).toHaveLength(0);

    expect((await lasting(31 * 86_400_000)).ok).toBe(true);
  });
});

describe("tokens (plan §5.5)", () => {
  test("a read reuses a cached token while it has more than five minutes left", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t0 = new Date("2026-10-07T12:00:00Z").getTime();
    vi.setSystemTime(t0);

    succeeded(await slots());
    succeeded(await slots());
    expect(google.tokenCalls).toBe(1);
    expect(google.freeBusyCalls).toBe(2);

    // Google's tokens last 3599 s; at 55 minutes fewer than five remain.
    vi.setSystemTime(t0 + 55 * 60_000);
    succeeded(await slots());
    expect(google.tokenCalls).toBe(2);
  });

  test("freshCredentials, verify and the probe each mint a token, whatever the cache holds", async () => {
    succeeded(await slots());
    expect(google.tokenCalls).toBe(1);
    succeeded(await slots(contextFor(), { freshCredentials: true }));
    expect(google.tokenCalls).toBe(2);
    succeeded(await adapter.verify(contextFor()));
    expect(google.tokenCalls).toBe(3);
    succeeded(await probeGoogleToken(contextFor()));
    expect(google.tokenCalls).toBe(4);
  });

  test("a 401 on a cached token drops it and tries once more with a fresh one", async () => {
    succeeded(await slots());
    google.clearRequests();

    google.failNext({ on: "freeBusy", status: 401, reason: "authError" });
    succeeded(await slots());
    expect(endpoints()).toEqual(["freeBusy", "token", "freeBusy"]);

    // The token minted for the retry is the one cached now.
    google.clearRequests();
    succeeded(await slots());
    expect(endpoints()).toEqual(["freeBusy"]);
  });

  test("a 401 on a token minted for the call is the answer, and is never retried", async () => {
    const unauthorised = (times = 1) =>
      google.failNext({ on: "freeBusy", status: 401, reason: "authError", times });

    unauthorised();
    expect(failed(await slots())).toMatchObject({
      code: "unauthorised",
      reason: "access_denied",
      retryable: false,
    });
    expect(endpoints()).toEqual(["token", "freeBusy"]);

    google.clearRequests();
    unauthorised();
    expect(failed(await slots(contextFor(), { freshCredentials: true })).reason).toBe(
      "access_denied",
    );
    expect(endpoints()).toEqual(["token", "freeBusy"]);

    // A cached token that 401s, then a fresh one that 401s too: one retry, no more.
    succeeded(await slots());
    google.clearRequests();
    unauthorised(2);
    expect(failed(await slots()).reason).toBe("access_denied");
    expect(endpoints()).toEqual(["freeBusy", "token", "freeBusy"]);

    // Neither token is kept: the next read mints.
    google.clearRequests();
    succeeded(await slots());
    expect(endpoints()).toEqual(["token", "freeBusy"]);
  });

  test("an insert uses a token minted within the last minute, and mints one otherwise", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t0 = new Date("2026-10-07T12:00:00Z").getTime();
    vi.setSystemTime(t0);
    succeeded(await slots());
    expect(google.tokenCalls).toBe(1);

    vi.setSystemTime(t0 + 59_000);
    succeeded(await create(booking({ idempotencyKey: "req-1" })));
    expect(google.tokenCalls).toBe(1);

    vi.setSystemTime(t0 + 61_000);
    succeeded(await create(booking({ idempotencyKey: "req-2" })));
    expect(google.tokenCalls).toBe(2);
  });

  test("an insert that gets 401 is not retried, and its token is dropped", async () => {
    google.failNext({ on: "insert", status: 401, reason: "authError" });
    expect(failed(await create())).toMatchObject({ code: "unauthorised", reason: "access_denied" });
    expect(endpoints()).toEqual(["token", "insert"]);

    google.clearRequests();
    succeeded(await slots());
    expect(endpoints()).toEqual(["token", "freeBusy"]);
  });

  test("a grant Google refused takes its cached token with it; a transient failure keeps it", async () => {
    succeeded(await slots());
    google.clearRequests();
    setGoogleTimeouts({ refresh: 30 });
    google.failNext({ on: "token", status: 503 });
    expect(failed(await slots(contextFor(), { freshCredentials: true })).reason).toBe(
      "server_error",
    );
    google.clearRequests();
    succeeded(await slots());
    expect(endpoints()).toEqual(["freeBusy"]);

    // The person removes healdesk in their Google Account: the cached token
    // stops working, the retry's refresh is refused, and that is the answer.
    google.revokeRefreshToken(refreshToken);
    google.clearRequests();
    expect(failed(await slots())).toMatchObject({ code: "unauthorised", reason: "invalid_grant" });
    expect(endpoints()).toEqual(["freeBusy", "token"]);
  });
});

describe("verify (plan §4.9)", () => {
  test("a fresh token, free/busy for the next hour, then a list of no events for role and zone", async () => {
    succeeded(await slots());
    google.clearRequests();

    expect(succeeded(await adapter.verify(contextFor()))).toEqual({
      accountLabel: "Google Calendar",
      coverageStartedAt: null,
      calendar: { timeZone: "America/New_York", accessRole: "owner" },
    });
    expect(endpoints()).toEqual(["token", "freeBusy", "list"]);

    const [busy] = bodiesOf<{ timeMin: string; timeMax: string; items: unknown }>("freeBusy");
    expect(busy?.items).toEqual([{ id: "primary" }]);
    expect(Date.parse(busy?.timeMax ?? "") - Date.parse(busy?.timeMin ?? "")).toBe(3_600_000);

    const [list] = requestsTo("list");
    expect(list?.url.pathname).toBe("/calendar/v3/calendars/primary/events");
    const query = Object.fromEntries(list?.url.searchParams ?? []);
    expect(Object.keys(query).sort()).toEqual([
      "fields",
      "maxResults",
      "privateExtendedProperty",
      "timeMax",
      "timeMin",
    ]);
    expect(query.maxResults).toBe("1");
    expect(query.fields).toBe("accessRole,timeZone");
    // A property no event carries, so the list reads nothing.
    expect(query.privateExtendedProperty).toMatch(/^healdeskProbe=[0-9a-f]{16}$/);
    expect(Date.parse(query.timeMax ?? "") - Date.parse(query.timeMin ?? "")).toBe(60_000);

    // Nothing is ever written to check a calendar.
    expect(google.insertCount).toBe(0);
    expect(google.events(SUB)).toEqual([]);
  });

  test("refuses a calendar the account can write to but does not own", async () => {
    google.setAccessRole(SUB, "writer");
    const error = failed(await adapter.verify(contextFor()));
    expect(error).toMatchObject({
      code: "misconfigured",
      reason: "not_calendar_owner",
      retryable: false,
    });
    expect(error.message).not.toContain("@");
    expect(endpoints()).toEqual(["token", "freeBusy", "list"]);
  });

  test("a calendar Google cannot find is calendar_not_found, and is not listed", async () => {
    const error = failed(await adapter.verify(onCalendar("gone@group.calendar.fake.test")));
    expect(error).toMatchObject({ code: "misconfigured", reason: "calendar_not_found" });
    expect(error.message).not.toContain("gone@");
    expect(google.eventsListCalls).toBe(0);
  });
});

describe("the watch's probe (plan §9.2, owner decision 5)", () => {
  test("one forced refresh and one free/busy on the calendar, nothing else, even when cached", async () => {
    succeeded(await slots());
    google.clearRequests();

    expect(await probeGoogleToken(contextFor())).toEqual({ ok: true, value: undefined });
    expect(endpoints()).toEqual(["token", "freeBusy"]);
    expect(google.eventsListCalls).toBe(0);
    const [busy] = bodiesOf<{ timeMin: string; timeMax: string; items: unknown }>("freeBusy");
    expect(busy?.items).toEqual([{ id: "primary" }]);
    expect(Date.parse(busy?.timeMax ?? "") - Date.parse(busy?.timeMin ?? "")).toBe(3_600_000);
  });

  test("checks no access role: a calendar the account only writes to still probes healthy", async () => {
    google.setAccessRole(SUB, "writer");
    expect((await probeGoogleToken(contextFor())).ok).toBe(true);
    expect(google.eventsListCalls).toBe(0);
  });

  test("reports each definitive answer the watch acts on", async () => {
    const forbidden = { on: "freeBusy", status: 403, reason: "forbidden" } as const;
    const cases: Array<[arrange: () => void, expected: string]> = [
      [() => google.revokeRefreshToken(refreshToken), "unauthorised/invalid_grant"],
      [() => google.restrictByAdmin(SUB), "unauthorised/admin_policy_enforced"],
      [() => google.dropScope(refreshToken, FREEBUSY), "unauthorised/scope_lost"],
      [() => google.failNext({ on: "freeBusy", status: 401 }), "unauthorised/access_denied"],
      [() => google.failNext(forbidden), "unauthorised/insufficient_permissions"],
      [
        () => google.failNext({ on: "freeBusy", calendarError: "notFound" }),
        "misconfigured/calendar_not_found",
      ],
    ];
    for (const [arrange, expected] of cases) {
      freshGoogle();
      arrange();
      const error = failed(await probeGoogleToken(contextFor()));
      expect(`${error.code}/${error.reason}`).toBe(expected);
      expect(google.eventsListCalls).toBe(0);
    }
  });
});

describe("the chosen calendar (addendum, calendar-list scope)", () => {
  test("a second owned calendar is the one free/busy, insert, get, verify and the probe use", async () => {
    const frontDesk = google.addCalendar(SUB, {
      summary: "Front desk",
      timeZone: "America/Chicago",
    });
    const ctx = onCalendar(frontDesk);

    succeeded(await slots(ctx));
    const created = succeeded(await create(booking(), ctx));
    expect(succeeded(await find(KEY, ctx))).toEqual(created);
    expect(succeeded(await adapter.verify(ctx)).calendar).toEqual({
      timeZone: "America/Chicago",
      accessRole: "owner",
    });
    succeeded(await probeGoogleToken(ctx));
    // A second insert under the same key reads back from the same calendar.
    expect(succeeded(await create(booking(), ctx)).adopted).toBe(true);

    const addressed = google.requests.filter((request) => request.endpoint !== "token");
    expect(new Set(addressed.map((request) => request.endpoint))).toEqual(
      new Set(["freeBusy", "insert", "get", "list"]),
    );
    for (const request of addressed) {
      expect(calendarAddressed(request), request.endpoint).toBe(frontDesk);
    }

    expect(google.events(SUB, frontDesk).map((event) => event.id)).toEqual([created.externalId]);
    expect(google.events(SUB)).toEqual([]);
  });

  test("only an absent calendar id means primary; an unreadable one is refused unasked", async () => {
    for (const metadata of [undefined, {}, { calendarId: null }]) {
      google.clearRequests();
      succeeded(await probeGoogleToken(contextFor({ metadata })));
      expect(requestsTo("freeBusy").map(calendarAddressed)).toEqual(["primary"]);
    }

    google.clearRequests();
    const frontDesk = google.addCalendar(SUB, { summary: "Front desk" });
    const unreadable = [{ id: frontDesk }, 42, true, "", "  ", "front desk", "x".repeat(1025)];
    for (const calendarId of unreadable) {
      const ctx = onCalendar(calendarId);
      for (const result of [
        await adapter.verify(ctx),
        await slots(ctx),
        await create(booking(), ctx),
        await find(KEY, ctx),
        await cancel(googleEventIdFor(KEY), ctx),
        await probeGoogleToken(ctx),
      ]) {
        expect(failed(result)).toMatchObject({
          code: "misconfigured",
          reason: "calendar_id",
          retryable: false,
        });
      }
    }
    expect(google.requests).toHaveLength(0);
    expect(google.events(SUB, frontDesk)).toEqual([]);
    expect(google.events(SUB)).toEqual([]);
  });
});

describe("listCalendars (addendum, calendar-list scope)", () => {
  test("the calendars the account owns, primary first, without hidden ones or ones it cannot write", async () => {
    const frontDesk = google.addCalendar(SUB, {
      summary: "Front desk",
      timeZone: "America/Chicago",
    });
    google.addCalendar(SUB, { summary: "Shared with the practice", accessRole: "writer" });
    google.addCalendar(SUB, { summary: "Holidays", accessRole: "reader" });
    google.addCalendar(SUB, { summary: "Old bookings", hidden: true });

    expect(succeeded(await adapter.listCalendars(contextFor()))).toEqual([
      { id: ACCOUNT_EMAIL, summary: ACCOUNT_EMAIL, primary: true, timeZone: "America/New_York" },
      { id: frontDesk, summary: "Front desk", primary: false, timeZone: "America/Chicago" },
    ]);

    expect(endpoints()).toEqual(["token", "calendarList"]);
    const [request] = requestsTo("calendarList");
    expect(request?.method).toBe("GET");
    expect(request?.url.pathname).toBe("/calendar/v3/users/me/calendarList");
    const query = Object.fromEntries(request?.url.searchParams ?? []);
    expect(query).toEqual({
      minAccessRole: "owner",
      showHidden: "false",
      fields: "items(id,summary,primary,timeZone,accessRole)",
    });
    expect(query).toEqual({ ...CALENDAR_LIST_QUERY });
  });

  test("drops any entry it could not write into and puts primary first, in any order Google lists", async () => {
    google.respondNext("calendarList", {
      items: [
        { id: "c_one@group.calendar.fake.test", summary: "Room one", accessRole: "owner" },
        { id: "c_shared@group.calendar.fake.test", summary: "Shared", accessRole: "writer" },
        { id: "c_two@group.calendar.fake.test", accessRole: "owner", timeZone: "not a zone" },
        {
          id: "owner@practice.example",
          summary: "Main",
          primary: true,
          accessRole: "owner",
          timeZone: "Europe/London",
        },
      ],
    });
    expect(succeeded(await adapter.listCalendars(contextFor()))).toEqual([
      { id: "owner@practice.example", summary: "Main", primary: true, timeZone: "Europe/London" },
      { id: "c_one@group.calendar.fake.test", summary: "Room one", primary: false, timeZone: null },
      { id: "c_two@group.calendar.fake.test", summary: null, primary: false, timeZone: null },
    ]);
  });

  test("a full page of a hundred is refused rather than shown with calendars missing", async () => {
    const page = (n: number) => ({
      items: Array.from({ length: n }, (_, i) => ({
        id: `c_${i}@group.calendar.fake.test`,
        accessRole: "owner",
      })),
    });
    google.respondNext("calendarList", page(100));
    expect(failed(await adapter.listCalendars(contextFor()))).toMatchObject({
      code: "unsupported",
      reason: "too_many_calendars",
    });
    google.respondNext("calendarList", page(99));
    expect(succeeded(await adapter.listCalendars(contextFor()))).toHaveLength(99);
  });

  test("no matching calendar is an empty list; an entry without a usable id fails the list", async () => {
    google.respondNext("calendarList", {});
    expect(succeeded(await adapter.listCalendars(contextFor()))).toEqual([]);
    const unusable = [
      [{ summary: "No id", accessRole: "owner" }],
      [{ id: "two words", accessRole: "owner" }],
      "x",
    ];
    for (const items of unusable) {
      google.respondNext("calendarList", { items });
      expect(failed(await adapter.listCalendars(contextFor())).code).toBe("malformed_response");
    }
  });

  test("needs the calendar-list scope: a grant without it is scope_lost at the refresh", async () => {
    refreshToken = google.grant({
      sub: SUB,
      scopes: [OPENID, EMAIL, FREEBUSY, OWNED],
    }).refreshToken;
    expect(failed(await adapter.listCalendars(contextFor()))).toMatchObject({
      code: "unauthorised",
      reason: "scope_lost",
    });
    expect(endpoints()).toEqual(["token"]);
  });

  test("works without a calendar target, so a clinic whose stored choice broke can choose again", async () => {
    const calendars = succeeded(await adapter.listCalendars(onCalendar(42)));
    expect(calendars.map((calendar) => calendar.id)).toEqual([ACCOUNT_EMAIL]);
  });
});

describe("writing and reading back (plan §5.2, §5.4)", () => {
  test("the event id is derived from the key, so the same key always names the same event", async () => {
    const created = succeeded(await create());
    expect(created.externalId).toBe(googleEventIdFor(KEY));
    expect(created.externalId).toMatch(/^hd[0-9a-f]{40}$/);
    expect(isHealdeskEventId(created.externalId)).toBe(true);
    expect(googleEventIdFor(`${KEY}x`)).not.toBe(created.externalId);
  });

  test("read-back by key: nothing is null, ours and live is the booking, nothing else is asked", async () => {
    expect(await find()).toEqual({ ok: true, value: null });

    const created = succeeded(await create());
    google.clearRequests();
    const found = await adapter.findAppointmentByKey(contextFor(), {
      idempotencyKey: KEY,
      attendeeEmail: "bookings+req-1@sink.healdesk.io",
      around: new Date("2027-01-01T00:00:00Z"),
    });
    expect(succeeded(found)).toEqual({
      externalId: created.externalId,
      startsAt: created.startsAt,
      endsAt: created.endsAt,
    });

    const [get] = requestsTo("get");
    expect(get?.url.pathname).toBe(`/calendar/v3/calendars/primary/events/${created.externalId}`);
    expect(Object.fromEntries(get?.url.searchParams ?? [])).toEqual({
      fields: "id,status,start,end,extendedProperties/private",
    });
    expect(get?.url.href).not.toContain("sink.healdesk.io");
  });

  test("the same key twice is one event: the 409 is read back and adopted, with its own times", async () => {
    const first = succeeded(await create());
    google.clearRequests();

    expect(succeeded(await create())).toEqual({ ...first, adopted: true });
    expect(endpoints()).toEqual(["insert", "get"]);

    // A retry for another time still names the same event, and is answered
    // with the time that event holds, for the caller to compare.
    const moved = succeeded(await create(booking({ startsAt: new Date("2026-10-07T16:00:00Z") })));
    expect(moved).toEqual({ ...first, adopted: true });
    expect(google.events(SUB)).toHaveLength(1);
  });

  test("a booking the clinic deleted is never written again, and the read-back says so", async () => {
    const created = succeeded(await create());
    google.deleteEventAsClinic(SUB, created.externalId);

    expect(failed(await create())).toMatchObject({
      code: "unknown",
      reason: "deleted_in_calendar",
      retryable: false,
    });
    expect(failed(await find())).toMatchObject({ reason: "deleted_in_calendar", retryable: false });
    expect(google.event(SUB, created.externalId)?.status).toBe("cancelled");

    // Google may also answer a deleted event with 410.
    google.failNext({ on: "get", status: 410, reason: "deleted" });
    expect(failed(await create()).reason).toBe("deleted_in_calendar");
    google.failNext({ on: "get", status: 410, reason: "deleted" });
    expect(failed(await find()).reason).toBe("deleted_in_calendar");
  });

  test("an event under our id without our marker is never adopted, read back as ours, or deleted", async () => {
    const id = googleEventIdFor(KEY);
    google.addEvent(SUB, { id, start: START, end: new Date("2026-10-07T15:00:00Z") });

    expect(failed(await create())).toMatchObject({
      code: "unknown",
      reason: "conflict",
      status: 409,
      retryable: false,
    });
    expect(failed(await find())).toMatchObject({ code: "unknown", reason: "not_ours" });

    google.clearRequests();
    expect(failed(await cancel(id)).reason).toBe("not_ours");
    expect(endpoints()).toEqual(["get"]);
    expect(google.deleteCalls).toBe(0);
    expect(google.event(SUB, id)?.status).toBe("confirmed");
  });

  test("cancel deletes only our own event, refuses any other id unasked, and leaves a deleted one", async () => {
    expect(failed(await cancel("clinic-event-1")).reason).toBe("not_ours");
    expect(google.requests).toHaveLength(0);

    const created = succeeded(await create());
    succeeded(await cancel(created.externalId));
    expect(google.event(SUB, created.externalId)?.status).toBe("cancelled");
    expect(google.deleteCalls).toBe(1);

    succeeded(await cancel(created.externalId));
    succeeded(await cancel(googleEventIdFor("never-booked")));
    expect(google.deleteCalls).toBe(1);
  });
});

describe("when the outcome of a write is unknown", () => {
  test("an insert that lands but whose reply never arrives is a timeout, and the read-back finds it", async () => {
    setGoogleTimeouts({ insert: 30 });
    google.insertThenHang();
    const error = failed(await create());
    expect(error).toMatchObject({ code: "unavailable", reason: "timeout", retryable: true });
    expect(error.status).toBeUndefined();
    expect(google.events(SUB).map((event) => event.id)).toEqual([googleEventIdFor(KEY)]);

    expect(succeeded(await find())).toMatchObject({ externalId: googleEventIdFor(KEY) });
  });

  test("an insert Google completes after the caller gave up is found once it lands, and adopted", async () => {
    setGoogleTimeouts({ insert: 30 });
    const late = google.insertThenHang({ land: "later" });
    expect(failed(await create()).reason).toBe("timeout");
    expect(await find()).toEqual({ ok: true, value: null });

    late.land();
    expect(succeeded(await find())).toMatchObject({ externalId: googleEventIdFor(KEY) });
    expect(succeeded(await create()).adopted).toBe(true);
    expect(google.events(SUB)).toHaveLength(1);
  });

  test("a 5xx on an insert is unconfirmed, not a no: Google may have stored the event", async () => {
    for (const status of [500, 502, 503]) {
      google.failNext({ on: "insert", status, reason: "backendError" });
      const error = failed(await create());
      expect(error).toMatchObject({
        code: "unavailable",
        reason: "unconfirmed",
        retryable: true,
        status,
      });
      expect(error.message).not.toMatch(GOOGLE_SENTENCES);
    }
  });

  test("a 2xx whose body cannot be read, or names another event, is unconfirmed", async () => {
    google.failNext({ on: "insert", status: 200, rawBody: "<html>Service Unavailable</html>" });
    expect(failed(await create())).toMatchObject({
      code: "malformed_response",
      reason: "unconfirmed",
      status: 200,
    });
    const another = { id: googleEventIdFor("another"), status: "confirmed" };
    google.failNext({ on: "insert", status: 200, body: another });
    expect(failed(await create()).reason).toBe("unconfirmed");
  });

  test("after a 409, a read-back that fails or cannot be read leaves the outcome unknown", async () => {
    succeeded(await create());

    google.failNext({ on: "get", status: 503, reason: "backendError" });
    expect(failed(await create())).toMatchObject({
      code: "unavailable",
      reason: "unconfirmed",
      status: 503,
    });

    google.failNext({ on: "get", status: 200, rawBody: "not json" });
    expect(failed(await create())).toMatchObject({
      code: "malformed_response",
      reason: "unconfirmed",
    });

    setGoogleTimeouts({ get: 30 });
    google.hangNext("get");
    expect(failed(await create()).reason).toBe("timeout");
    expect(google.events(SUB)).toHaveLength(1);
  });
});

describe("the error table (plan §5.6)", () => {
  /** What Google does, then the code/reason and retryability the caller sees. */
  type Row = [name: string, arrange: () => void, expected: string, retryable: boolean];

  const tokenRows = (): Row[] => [
    [
      "token invalid_grant",
      () => google.revokeRefreshToken(refreshToken),
      "unauthorised/invalid_grant",
      false,
    ],
    [
      "admin_policy_enforced",
      () => google.restrictByAdmin(SUB),
      "unauthorised/admin_policy_enforced",
      false,
    ],
    ["a scope lost", () => google.dropScope(refreshToken, OWNED), "unauthorised/scope_lost", false],
    ["client deleted", () => google.deleteClient(), "misconfigured/oauth_client", false],
    [
      "token invalid_client",
      () => google.failNext({ on: "token", status: 401, reason: "invalid_client" }),
      "misconfigured/oauth_client",
      false,
    ],
  ];

  /** Every row runs against a second calendar, so a calendar id in a message would be caught. */
  async function expectRows(rows: Row[], run: (ctx: ConnectorContext) => Promise<Result<unknown>>) {
    setGoogleTimeouts({ refresh: 30, freeBusy: 30, insert: 30, get: 30 });
    for (const [name, arrange, expected, retryable] of rows) {
      freshGoogle();
      const frontDesk = google.addCalendar(SUB, { summary: "Front desk" });
      arrange();

      const error = failed(await run(onCalendar(frontDesk)));
      expect({ name, got: `${error.code}/${error.reason}`, retryable: error.retryable }).toEqual({
        name,
        got: expected,
        retryable,
      });
      expect(error.message, name).not.toMatch(GOOGLE_SENTENCES);
      expect(error.message, name).not.toContain(refreshToken);
      expect(error.message, name).not.toMatch(/ya29|1\/\//);
      expect(error.message, name).not.toContain("@");
    }
  }

  test("reads: definitive, ours and transient told apart, and nothing Google wrote repeated", async () => {
    const api = (status: number, reason?: string, body?: unknown) => () =>
      google.failNext({ on: "freeBusy", status, reason, body });
    const perCalendar = (calendarError: string) => () =>
      google.failNext({ on: "freeBusy", calendarError });
    const denied = "unauthorised/insufficient_permissions";
    await expectRows(
      [
        ...tokenRows(),
        ["401 on a fresh token", api(401, "authError"), "unauthorised/access_denied", false],
        ["403 forbidden", api(403, "forbidden"), denied, false],
        ["403 insufficientPermissions", api(403, "insufficientPermissions"), denied, false],
        ["403 requiredAccessLevel", api(403, "requiredAccessLevel"), denied, false],
        ["403, a word nobody listed", api(403, "domainPolicy"), denied, false],
        [
          "403 with no readable body",
          () => google.failNext({ on: "freeBusy", status: 403, rawBody: "" }),
          denied,
          false,
        ],
        ["404", api(404, "notFound"), "misconfigured/calendar_not_found", false],
        ["free/busy notFound", perCalendar("notFound"), "misconfigured/calendar_not_found", false],
        [
          "403 accessNotConfigured",
          api(403, "accessNotConfigured"),
          "misconfigured/api_disabled",
          false,
        ],
        [
          "403 rateLimitExceeded",
          api(403, "rateLimitExceeded"),
          "rate_limited/rateLimitExceeded",
          true,
        ],
        [
          "403 userRateLimitExceeded",
          api(403, "userRateLimitExceeded"),
          "rate_limited/userRateLimitExceeded",
          true,
        ],
        ["403 quotaExceeded", api(403, "quotaExceeded"), "rate_limited/quotaExceeded", true],
        ["429", api(429, "rateLimitExceeded"), "rate_limited/rateLimitExceeded", true],
        ["500", api(500, "backendError"), "unavailable/backendError", true],
        ["503 with no word", api(503, undefined, {}), "unavailable/unavailable", true],
        [
          "free/busy internalError",
          perCalendar("internalError"),
          "unavailable/internalError",
          true,
        ],
        ["a hang", () => google.hangNext("freeBusy"), "unavailable/timeout", true],
        [
          "a network failure",
          () => google.failNext({ on: "freeBusy", network: true }),
          "unavailable/network",
          true,
        ],
      ],
      (ctx) => slots(ctx),
    );
  });

  test("inserts: Google's no is a no, and anything that may have landed is unknown", async () => {
    const api = (status: number, reason?: string) => () =>
      google.failNext({ on: "insert", status, reason });
    const denied = "unauthorised/insufficient_permissions";
    await expectRows(
      [
        ...tokenRows(),
        ["401", api(401, "authError"), "unauthorised/access_denied", false],
        ["403 forbidden", api(403, "forbidden"), denied, false],
        ["403, a word nobody listed", api(403, "domainPolicy"), denied, false],
        ["404", api(404, "notFound"), "misconfigured/calendar_not_found", false],
        [
          "403 accessNotConfigured",
          api(403, "accessNotConfigured"),
          "misconfigured/api_disabled",
          false,
        ],
        ["429", api(429, "rateLimitExceeded"), "rate_limited/rateLimitExceeded", true],
        ["400", api(400, "timeRangeEmpty"), "unknown/timeRangeEmpty", false],
        ["503", api(503, "backendError"), "unavailable/unconfirmed", true],
        ["a hang", () => google.hangNext("insert"), "unavailable/timeout", true],
        [
          "a network failure",
          () => google.failNext({ on: "insert", network: true }),
          "unavailable/network",
          true,
        ],
        [
          "a 2xx that cannot be read",
          () => google.failNext({ on: "insert", status: 200, rawBody: "{" }),
          "malformed_response/unconfirmed",
          true,
        ],
      ],
      (ctx) => create(booking(), ctx),
    );
  });
});

describe("timeouts (plan §5.7)", () => {
  test("each kind of call has the plan's bound", () => {
    expect(GOOGLE_TIMEOUTS_MS).toEqual({
      exchange: 5_000,
      refresh: 3_000,
      freeBusy: 3_000,
      insert: 5_000,
      get: 2_000,
      delete: 4_000,
      revoke: 4_000,
      list: 4_000,
      calendarList: 4_000,
    });
  });

  test("each adapter call waits on its own call's bound and no other", async () => {
    setGoogleTimeouts({
      refresh: 21,
      freeBusy: 22,
      insert: 23,
      get: 24,
      list: 25,
      calendarList: 26,
      delete: 27,
    });
    /** The bound a call gave up after when `hung` never answered, read from its message. */
    const boundOf = async (
      hung: Exclude<FakeGoogleRequest["endpoint"], "unknown">,
      run: () => Promise<Result<unknown>>,
    ) => {
      google.hangNext(hung);
      const error = failed(await run());
      expect(error.reason).toBe("timeout");
      return /within (\d+) ms/.exec(error.message)?.[1];
    };

    expect(await boundOf("token", () => slots())).toBe("21");
    expect(await boundOf("freeBusy", () => slots())).toBe("22");
    expect(await boundOf("insert", () => create())).toBe("23");
    expect(await boundOf("get", () => find())).toBe("24");
    expect(await boundOf("list", () => adapter.verify(contextFor()))).toBe("25");
    expect(await boundOf("calendarList", () => adapter.listCalendars(contextFor()))).toBe("26");

    const created = succeeded(await create(booking({ idempotencyKey: "req-9" })));
    expect(await boundOf("delete", () => cancel(created.externalId))).toBe("27");
  });
});

describe("no client, no grant", () => {
  test("no OAuth client, or no refresh token, is misconfigured with no request made", async () => {
    const contexts: Array<[ConnectorContext, string]> = [
      [contextFor({ oauthClient: undefined }), "oauth_client"],
      [contextFor({ oauthClient: { ...google.client, clientSecret: "" } }), "oauth_client"],
      [contextFor({ oauthClient: { ...google.client, clientId: "" } }), "oauth_client"],
      [contextFor({ credentials: {} }), "missing_refresh_token"],
      [contextFor({ credentials: { refresh_token: "" } }), "missing_refresh_token"],
    ];
    for (const [ctx, reason] of contexts) {
      for (const result of [
        await adapter.verify(ctx),
        await adapter.listCalendars(ctx),
        await slots(ctx),
        await create(booking(), ctx),
        await find(KEY, ctx),
        await cancel(googleEventIdFor(KEY), ctx),
        await probeGoogleToken(ctx),
      ]) {
        expect(failed(result)).toMatchObject({ code: "misconfigured", reason, retryable: false });
      }
    }
    expect(google.requests).toHaveLength(0);
  });
});

describe("the fake holds the adapter to Google's rules", () => {
  /** An access token for a grant, minted at the fake's token endpoint directly. */
  async function accessTokenFor(grantToken: string): Promise<string> {
    const response = await google.fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: grantToken,
        client_id: google.client.clientId,
        client_secret: google.client.clientSecret,
      }).toString(),
    });
    return ((await response.json()) as { access_token: string }).access_token;
  }

  test("the calendar list answers only a token that carries a calendar-list scope", async () => {
    const without = google.grant({ sub: SUB, scopes: [OPENID, EMAIL, FREEBUSY, OWNED] });
    const list = async (grantToken: string) =>
      google.fetch(`${GOOGLE_CALENDAR_API}/users/me/calendarList`, {
        headers: { Authorization: `Bearer ${await accessTokenFor(grantToken)}` },
      });
    expect((await list(without.refreshToken)).status).toBe(403);
    expect((await list(refreshToken)).status).toBe(200);
  });

  test("events.owned cannot insert into a calendar the account only writes to", async () => {
    const shared = google.addCalendar(SUB, { summary: "Shared", accessRole: "writer" });
    expect(failed(await create(booking(), onCalendar(shared)))).toMatchObject({
      code: "unauthorised",
      reason: "insufficient_permissions",
    });
    expect(google.events(SUB, shared)).toEqual([]);
  });
});
