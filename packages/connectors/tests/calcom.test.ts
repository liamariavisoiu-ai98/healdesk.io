import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";

import { CALCOM_API_VERSIONS, CalcomAdapter, HEALDESK_REQUEST_ID_KEY } from "../src/calcom/adapter";
import { canWriteBookings } from "../src/capabilities";
import type { ConnectorContext, CreateAppointmentInput } from "../src/types";

import { fakeCalcom, type FakeCalcom } from "./calcom-fake";

/**
 * The Cal.com adapter against an in-memory Cal.com. Never a live call: the
 * global fetch is replaced with one that throws for the whole file, so a
 * request that escapes the injected fake fails loudly instead of reaching
 * api.cal.com with a test key.
 *
 * What is asserted is the wire shape — headers, query names, body fields —
 * because that is what the vendor's docs promise and what go-live must
 * re-verify. A test here failing after a docs change is the point.
 */

beforeAll(() => {
  vi.stubGlobal("fetch", () => {
    throw new Error("live call attempted from the Cal.com adapter tests");
  });
});
afterAll(() => vi.unstubAllGlobals());

const NOW = new Date("2026-09-29T15:00:00Z");
const API_KEY = "cal_test_key";
const SINK = "bookings+req-1@sink.healdesk.io";

const context = (over: Partial<ConnectorContext> = {}): ConnectorContext => ({
  clinicId: "11111111-1111-4111-8111-111111111111",
  connectionId: "22222222-2222-4222-8222-222222222222",
  credentials: { apiKey: API_KEY },
  metadata: { eventTypeId: 4242, durationMinutes: 30 },
  ...over,
});

const input = (over: Partial<CreateAppointmentInput> = {}): CreateAppointmentInput => ({
  startsAt: new Date("2026-10-06T14:00:00Z"),
  durationMinutes: 30,
  attendee: { name: "Avery", email: SINK, timeZone: "America/New_York" },
  service: "Consultation",
  idempotencyKey: "req-1",
  ...over,
});

function adapterFor(fake: FakeCalcom): CalcomAdapter {
  return new CalcomAdapter({ fetch: fake.fetch, now: () => NOW, timeoutMs: 40 });
}

function failed<T>(result: { ok: true; value: T } | { ok: false; error: unknown }) {
  if (result.ok) throw new Error(`expected a failure, got ${JSON.stringify(result.value)}`);
  return result.error as {
    code: string;
    message: string;
    retryable: boolean;
    status?: number;
    reason?: string;
    retryAfter?: number;
  };
}

describe("capabilities", () => {
  test("declares the write path and nothing it cannot honestly do", () => {
    const { capabilities } = new CalcomAdapter();
    expect(canWriteBookings(capabilities)).toBe(true);
    expect(capabilities.createAppointment.support).toBe("full");
    expect(capabilities.listSlots.support).toBe("full");
    expect(capabilities.findAppointmentByKey.support).toBe("full");
    expect(capabilities.listAppointments).toEqual({
      support: "partial",
      note: "Cal.com knows the booking exists; it does not know whether the person arrived.",
    });
    expect(capabilities.readArrival.support).toBe("unsupported");
    expect(capabilities.listSales.support).toBe("unsupported");
    expect(capabilities.writeBack.support).toBe("unsupported");
  });
});

describe("verify", () => {
  test("proves the key with tomorrow's slots, then reads the event type and its workflows", async () => {
    const fake = fakeCalcom();
    const result = await adapterFor(fake).verify(context());

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.accountLabel).toContain("consultation");

    const [slots, eventType, workflows] = fake.requests;
    expect(slots?.method).toBe("GET");
    expect(slots?.url.pathname).toBe("/v2/slots");
    expect(slots?.headers.get("cal-api-version")).toBe(CALCOM_API_VERSIONS.slots);
    expect(slots?.headers.get("authorization")).toBe(`Bearer ${API_KEY}`);
    expect(slots?.url.searchParams.get("start")).toBe("2026-09-30T00:00:00.000Z");
    expect(slots?.url.searchParams.get("end")).toBe("2026-10-01T00:00:00.000Z");
    expect(slots?.url.searchParams.get("eventTypeId")).toBe("4242");
    expect(slots?.url.searchParams.get("format")).toBe("range");

    expect(eventType?.url.pathname).toBe("/v2/event-types/4242");
    expect(eventType?.headers.get("cal-api-version")).toBe(CALCOM_API_VERSIONS.eventType);
    expect(workflows?.url.pathname).toBe("/v2/workflows");
  });

  test("refuses an event type that still sends Cal.com's own emails", async () => {
    const fake = fakeCalcom({
      emailSettings: { disableEmailsToAttendees: false, disableEmailsToHosts: true },
    });
    const error = failed(await adapterFor(fake).verify(context()));
    expect(error.reason).toBe("emails_or_workflows_on");
    expect(error.code).toBe("misconfigured");
    expect(error.retryable).toBe(false);
  });

  test("refuses an event type a workflow is active on, by id or by all", async () => {
    const byId = fakeCalcom({
      workflows: [{ id: 1, activation: { isActiveOnAllEventTypes: false, activeOnEventTypeIds: [4242] } }],
    });
    expect(failed(await adapterFor(byId).verify(context())).reason).toBe("emails_or_workflows_on");

    const onAll = fakeCalcom({
      workflows: [{ id: 2, activation: { isActiveOnAllEventTypes: true, activeOnEventTypeIds: [] } }],
    });
    expect(failed(await adapterFor(onAll).verify(context())).reason).toBe("emails_or_workflows_on");

    const elsewhere = fakeCalcom({
      workflows: [{ id: 3, activation: { isActiveOnAllEventTypes: false, activeOnEventTypeIds: [9] } }],
    });
    expect((await adapterFor(elsewhere).verify(context())).ok).toBe(true);
  });

  test("fails closed when the event type does not expose its email settings", async () => {
    // The docs say the object needs an organisation membership. An event type
    // we cannot confirm silent does not get a name and a time.
    const fake = fakeCalcom({ emailSettings: null });
    expect(failed(await adapterFor(fake).verify(context())).reason).toBe(
      "emails_or_workflows_unconfirmed",
    );
  });

  test("a rejected key is unauthorised with the status and nothing from the body", async () => {
    const fake = fakeCalcom();
    fake.respondNext({
      status: 401,
      statusText: "Unauthorized",
      body: JSON.stringify({ error: { message: "key for jane@example.com is invalid" } }),
    });
    const error = failed(await adapterFor(fake).verify(context()));
    expect(error.code).toBe("unauthorised");
    expect(error.status).toBe(401);
    expect(error.reason).toBe("unauthorized");
    expect(JSON.stringify(error)).not.toContain("jane");
  });

  test("a connection missing its key or event type is refused before any request", async () => {
    const fake = fakeCalcom();
    const noKey = failed(await adapterFor(fake).verify(context({ credentials: {} })));
    expect(noKey.reason).toBe("missing_api_key");
    expect(noKey.code).toBe("misconfigured");

    const noEventType = failed(
      await adapterFor(fake).verify(context({ metadata: { durationMinutes: 30 } })),
    );
    expect(noEventType.reason).toBe("missing_event_type");
    expect(fake.requests).toHaveLength(0);
  });
});

describe("listSlots", () => {
  const window_ = { from: new Date("2026-10-05T00:00:00Z"), to: new Date("2026-10-07T00:00:00Z") };

  test("asks /v2/slots by the documented names and maps to CanonicalSlot[]", async () => {
    const fake = fakeCalcom();
    const result = await adapterFor(fake).listSlots(context(), window_, {
      timeZone: "America/New_York",
      durationMinutes: 30,
    });

    const request = fake.lastRequest();
    expect(request.method).toBe("GET");
    expect(request.url.pathname).toBe("/v2/slots");
    expect(request.headers.get("cal-api-version")).toBe("2024-09-04");
    expect(request.headers.get("authorization")).toBe(`Bearer ${API_KEY}`);
    expect(Object.fromEntries(request.url.searchParams)).toEqual({
      eventTypeId: "4242",
      start: "2026-10-05T00:00:00.000Z",
      end: "2026-10-07T00:00:00.000Z",
      timeZone: "America/New_York",
      duration: "30",
      format: "range",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.length).toBeGreaterThan(0);
    for (const [i, slot] of result.value.entries()) {
      expect(slot.startsAt).toBeInstanceOf(Date);
      expect(slot.endsAt.getTime()).toBeGreaterThan(slot.startsAt.getTime());
      expect(slot.startsAt.getTime()).toBeGreaterThanOrEqual(window_.from.getTime());
      expect(slot.startsAt.getTime()).toBeLessThan(window_.to.getTime());
      if (i > 0) {
        expect(slot.startsAt.getTime()).toBeGreaterThan(result.value[i - 1]!.startsAt.getTime());
      }
    }
  });

  test("falls back to the connection's duration", async () => {
    const fake = fakeCalcom();
    await adapterFor(fake).listSlots(context(), window_, { timeZone: "UTC" });
    expect(fake.lastRequest().url.searchParams.get("duration")).toBe("30");
  });

  test("a body that is not keyed by day is malformed, not empty", async () => {
    const fake = fakeCalcom();
    fake.respondNext({ status: 200, body: JSON.stringify({ status: "success", data: "nope" }) });
    const error = failed(await adapterFor(fake).listSlots(context(), window_, { timeZone: "UTC" }));
    expect(error.code).toBe("malformed_response");
  });
});

describe("createAppointment", () => {
  test("posts exactly the documented fields, and nothing phone-shaped even when handed one", async () => {
    const fake = fakeCalcom();
    // A caller casting past the type must still not get a number through.
    const smuggled = {
      ...input(),
      attendee: { ...input().attendee, phoneNumber: "+15550101234", phone: "555" },
    } as unknown as CreateAppointmentInput;

    const result = await adapterFor(fake).createAppointment(context(), smuggled);

    const request = fake.lastRequest();
    expect(request.method).toBe("POST");
    expect(request.url.pathname).toBe("/v2/bookings");
    expect(request.headers.get("cal-api-version")).toBe("2026-02-25");
    expect(request.headers.get("content-type")).toBe("application/json");
    expect(request.headers.get("authorization")).toBe(`Bearer ${API_KEY}`);

    const body = request.body as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["attendee", "eventTypeId", "metadata", "start"]);
    expect(Object.keys(body.attendee as object).sort()).toEqual(["email", "name", "timeZone"]);
    expect(body.start).toBe("2026-10-06T14:00:00.000Z");
    expect(body.eventTypeId).toBe(4242);
    expect(body.metadata).toEqual({ [HEALDESK_REQUEST_ID_KEY]: "req-1" });
    expect(JSON.stringify(body)).not.toMatch(/phone/i);
    expect(JSON.stringify(body)).not.toContain("5550101234");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.externalId).toMatch(/^uid_/);
    expect(result.value.startsAt).toEqual(new Date("2026-10-06T14:00:00Z"));
    expect(result.value.endsAt).toEqual(new Date("2026-10-06T14:30:00Z"));
  });

  test("sends lengthInMinutes only for a length other than the connection's", async () => {
    const fake = fakeCalcom();
    const adapter = adapterFor(fake);

    await adapter.createAppointment(context(), input({ durationMinutes: 30 }));
    expect(fake.lastRequest().body).not.toHaveProperty("lengthInMinutes");

    await adapter.createAppointment(context(), input({ durationMinutes: null }));
    expect(fake.lastRequest().body).not.toHaveProperty("lengthInMinutes");

    await adapter.createAppointment(context(), input({ durationMinutes: 60 }));
    expect(fake.lastRequest().body).toHaveProperty("lengthInMinutes", 60);
  });

  test("the service is not sent: the event type already says what the booking is", async () => {
    const fake = fakeCalcom();
    await adapterFor(fake).createAppointment(context(), input({ service: "Lip filler" }));
    expect(JSON.stringify(fake.lastRequest().body)).not.toContain("Lip filler");
  });

  test("a vendor refusal carries the status and a word, never the body", async () => {
    const fake = fakeCalcom();
    fake.respondNext({
      status: 409,
      statusText: "Conflict",
      body: JSON.stringify({
        status: "error",
        error: { message: `Avery <${SINK}> already has a booking at that time` },
      }),
    });
    const error = failed(await adapterFor(fake).createAppointment(context(), input()));
    expect(error.status).toBe(409);
    expect(error.reason).toBe("conflict");
    expect(error.code).toBe("unknown");
    expect(error.retryable).toBe(false);
    expect(JSON.stringify(error)).not.toContain("Avery");
    expect(JSON.stringify(error)).not.toContain("sink.healdesk.io");
  });

  test("an empty reason phrase still yields a word", async () => {
    const fake = fakeCalcom();
    fake.respondNext({ status: 422, statusText: "" });
    expect(failed(await adapterFor(fake).createAppointment(context(), input())).reason).toBe(
      "unprocessable",
    );
  });

  test("429 backs off with the vendor's Retry-After; 5xx is unavailable and retryable", async () => {
    const fake = fakeCalcom();
    fake.respondNext({ status: 429, statusText: "Too Many Requests", headers: { "retry-after": "12" } });
    const limited = failed(await adapterFor(fake).createAppointment(context(), input()));
    expect(limited.code).toBe("rate_limited");
    expect(limited.retryAfter).toBe(12);
    expect(limited.retryable).toBe(true);

    fake.respondNext({ status: 503, statusText: "Service Unavailable" });
    const down = failed(await adapterFor(fake).createAppointment(context(), input()));
    expect(down.code).toBe("unavailable");
    expect(down.status).toBe(503);
    expect(down.retryable).toBe(true);
  });

  test("a timeout is an unknown outcome: reason timeout, no status, no retry inside", async () => {
    const fake = fakeCalcom();
    fake.hangNext();
    const error = failed(await adapterFor(fake).createAppointment(context(), input()));
    expect(error.reason).toBe("timeout");
    expect(error.status).toBeUndefined();
    expect(error.code).toBe("unavailable");
    expect(fake.requests).toHaveLength(1);
  });

  test("a network failure is reported as network, with nothing from the thrown error", async () => {
    const fake = fakeCalcom();
    fake.throwNext();
    const error = failed(await adapterFor(fake).createAppointment(context(), input()));
    expect(error.reason).toBe("network");
    expect(error.status).toBeUndefined();
  });

  test("a 2xx that cannot be read is unconfirmed, because the slot may be booked", async () => {
    const fake = fakeCalcom();
    fake.respondNext({ status: 201, statusText: "Created", body: "<html>" });
    const error = failed(await adapterFor(fake).createAppointment(context(), input()));
    expect(error.reason).toBe("unconfirmed");
    expect(error.status).toBe(201);
    expect(error.code).toBe("malformed_response");
  });
});

describe("findAppointmentByKey", () => {
  test("reads back by the sink address and a day either side, matching on our key", async () => {
    const fake = fakeCalcom();
    const adapter = adapterFor(fake);
    const created = await adapter.createAppointment(context(), input());
    if (!created.ok) throw new Error("setup");
    // Same address, a different request: must not be adopted.
    fake.addBooking(API_KEY, {
      start: "2026-10-06T16:00:00.000Z",
      attendees: [{ name: "Avery", email: SINK, timeZone: "UTC" }],
      metadata: { [HEALDESK_REQUEST_ID_KEY]: "req-other" },
    });

    const around = new Date("2026-10-06T14:00:00Z");
    const found = await adapter.findAppointmentByKey(context(), {
      idempotencyKey: "req-1",
      attendeeEmail: SINK,
      around,
    });

    const request = fake.lastRequest();
    expect(request.method).toBe("GET");
    expect(request.url.pathname).toBe("/v2/bookings");
    expect(request.headers.get("cal-api-version")).toBe("2026-05-01");
    expect(request.url.searchParams.get("attendeeEmail")).toBe(SINK);
    expect(request.url.searchParams.get("afterStart")).toBe("2026-10-05T14:00:00.000Z");
    expect(request.url.searchParams.get("beforeEnd")).toBe("2026-10-07T14:00:00.000Z");

    expect(found).toEqual({ ok: true, value: { externalId: created.value.externalId } });
  });

  test("null when the platform holds nothing under the key — not a failure", async () => {
    const fake = fakeCalcom();
    const adapter = adapterFor(fake);
    await adapter.createAppointment(context(), input());
    const found = await adapter.findAppointmentByKey(context(), {
      idempotencyKey: "req-never",
      attendeeEmail: SINK,
      around: new Date("2026-10-06T14:00:00Z"),
    });
    expect(found).toEqual({ ok: true, value: null });
  });
});

describe("cancelAppointment", () => {
  test("refuses a booking without our key, and sends no cancel for it", async () => {
    const fake = fakeCalcom();
    const theirs = fake.addBooking(API_KEY, { start: "2026-10-08T14:00:00.000Z" });
    const error = failed(await adapterFor(fake).cancelAppointment(context(), theirs.uid, "test"));
    expect(error.reason).toBe("not_ours");
    expect(fake.requests.some((r) => r.url.pathname.endsWith("/cancel"))).toBe(false);
    expect(fake.bookings(API_KEY).find((b) => b.uid === theirs.uid)?.status).toBe("accepted");
  });

  test("cancels a booking we created, with the reason", async () => {
    const fake = fakeCalcom();
    const adapter = adapterFor(fake);
    const created = await adapter.createAppointment(context(), input());
    if (!created.ok) throw new Error("setup");

    const result = await adapter.cancelAppointment(context(), created.value.externalId, "desk cancelled");
    expect(result.ok).toBe(true);

    const request = fake.lastRequest();
    expect(request.method).toBe("POST");
    expect(request.url.pathname).toBe(`/v2/bookings/${created.value.externalId}/cancel`);
    expect(request.headers.get("cal-api-version")).toBe("2026-02-25");
    expect(request.body).toEqual({ cancellationReason: "desk cancelled" });
    expect(fake.bookings(API_KEY).find((b) => b.uid === created.value.externalId)?.status).toBe(
      "cancelled",
    );
  });
});

describe("listAppointments", () => {
  const window_ = { from: new Date("2026-09-15T00:00:00Z"), to: new Date("2026-10-31T00:00:00Z") };

  test("maps bookings to the canonical shape and carries no attendee", async () => {
    const fake = fakeCalcom();
    fake.addBooking(API_KEY, { start: "2026-10-01T14:00:00.000Z" });
    fake.addBooking(API_KEY, { start: "2026-10-02T14:00:00.000Z", status: "cancelled" });
    fake.addBooking(API_KEY, { start: "2026-09-20T14:00:00.000Z" });

    const result = await adapterFor(fake).listAppointments(context(), window_);

    const request = fake.lastRequest();
    expect(request.headers.get("cal-api-version")).toBe("2026-05-01");
    expect(request.url.searchParams.get("eventTypeId")).toBe("4242");
    expect(request.url.searchParams.get("afterStart")).toBe("2026-09-14T00:00:00.000Z");
    expect(request.url.searchParams.get("beforeEnd")).toBe("2026-11-01T00:00:00.000Z");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const byStart = new Map(result.value.items.map((a) => [a.scheduledFor.toISOString(), a]));
    expect(byStart.get("2026-10-01T14:00:00.000Z")?.arrival).toBe("scheduled");
    expect(byStart.get("2026-10-02T14:00:00.000Z")?.arrival).toBe("cancelled");
    expect(byStart.get("2026-09-20T14:00:00.000Z")?.arrival).toBe("unknown");
    for (const item of result.value.items) {
      expect(item.treatment).toBe("consultation");
      expect(item.providerName).toBe("Dr Chen");
    }
    const serialised = JSON.stringify(result.value);
    expect(serialised).not.toContain("Rowan");
    expect(serialised).not.toContain("rowan@example.com");
    expect(serialised).not.toContain("attendees");
  });

  test("cuts to the half-open window despite over-fetching a day each side", async () => {
    const fake = fakeCalcom();
    fake.addBooking(API_KEY, { start: window_.from.toISOString() });
    fake.addBooking(API_KEY, { start: window_.to.toISOString() });
    fake.addBooking(API_KEY, { start: "2026-09-14T12:00:00.000Z" });

    const result = await adapterFor(fake).listAppointments(context(), window_);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.items.map((a) => a.scheduledFor.toISOString())).toEqual([
      window_.from.toISOString(),
    ]);
  });

  test("passes the vendor's cursor through", async () => {
    const fake = fakeCalcom({ seedBookings: 130, seedFrom: window_.from, seedTo: window_.to });
    const adapter = adapterFor(fake);

    const first = await adapter.listAppointments(context(), window_);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.items).toHaveLength(100);
    expect(first.value.cursor).toBe("100");

    const second = await adapter.listAppointments(context(), window_, first.value.cursor);
    expect(fake.lastRequest().url.searchParams.get("cursor")).toBe("100");
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.items).toHaveLength(30);
    expect(second.value.cursor).toBeUndefined();
  });
});

describe("what Cal.com cannot do", () => {
  test("sales and contacts are unsupported, and ask nothing of the vendor", async () => {
    const fake = fakeCalcom();
    const adapter = adapterFor(fake);
    expect(failed(await adapter.listSales()).code).toBe("unsupported");
    expect(failed(await adapter.listContacts()).code).toBe("unsupported");
    expect(fake.requests).toHaveLength(0);
  });
});
