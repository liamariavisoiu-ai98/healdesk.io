/**
 * An in-memory Cal.com, for the adapter tests and the contract test.
 *
 * Answers the five endpoints the adapter uses with the shapes read from
 * https://cal.com/docs/api-reference/v2/ on 29 September 2026, checks the
 * `cal-api-version` header each endpoint documents, and records every request
 * so a test can assert on the exact wire shape. It is not a Cal.com; it is the
 * narrowest thing that lets the adapter be exercised without a live call, and
 * when the vendor's docs move, this file moves with them.
 *
 * Deterministic per API key, so the contract test's "same clinic twice" and
 * "different clinics differ" properties hold against it too.
 */

export type FakeRequest = {
  method: string;
  url: URL;
  headers: Headers;
  body: unknown;
};

export type FakeBooking = {
  id: number;
  uid: string;
  title: string;
  start: string;
  end: string;
  status: "accepted" | "pending" | "cancelled" | "rejected";
  metadata: Record<string, unknown>;
  attendees: Array<{ name: string; email: string; timeZone: string; phoneNumber?: string }>;
  eventTypeId: number;
  eventType: { id: number; slug: string };
  hosts: Array<{ name: string }>;
  createdAt: string;
  updatedAt: string;
};

export type FakeCalcomOptions = {
  eventTypeId?: number;
  slug?: string;
  /** Null means the event type does not expose the object at all. */
  emailSettings?: { disableEmailsToAttendees: boolean; disableEmailsToHosts: boolean } | null;
  workflows?: unknown[];
  /** Synthetic bookings per key, spread over `seedFrom`..`seedTo`. */
  seedBookings?: number;
  seedFrom?: Date;
  seedTo?: Date;
};

type CannedResponse = {
  status: number;
  statusText?: string;
  body?: string;
  headers?: Record<string, string>;
};

const VERSIONS = {
  slots: "2024-09-04",
  createBooking: "2026-02-25",
  cancelBooking: "2026-02-25",
  listBookings: "2026-05-01",
  eventType: "2026-06-12",
};

export function fakeCalcom(options: FakeCalcomOptions = {}) {
  const eventTypeId = options.eventTypeId ?? 4242;
  const slug = options.slug ?? "consultation";
  const emailSettings =
    options.emailSettings === undefined
      ? { disableEmailsToAttendees: true, disableEmailsToHosts: true }
      : options.emailSettings;
  const workflows = options.workflows ?? [];
  const seedFrom = options.seedFrom ?? new Date("2026-06-01T00:00:00Z");
  const seedTo = options.seedTo ?? new Date("2026-08-01T00:00:00Z");

  const requests: FakeRequest[] = [];
  const bookingsByKey = new Map<string, FakeBooking[]>();
  let canned: CannedResponse | null = null;
  let hang = false;
  let throwNext = false;
  let nextId = 1000;

  function storeFor(apiKey: string): FakeBooking[] {
    let list = bookingsByKey.get(apiKey);
    if (!list) {
      list = seed(apiKey, options.seedBookings ?? 0, seedFrom, seedTo, eventTypeId, slug);
      bookingsByKey.set(apiKey, list);
    }
    return list;
  }

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(
      input instanceof URL ? input.href : typeof input === "string" ? input : input.url,
    );
    const headers = new Headers(init?.headers);
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    requests.push({ method, url, headers, body });

    if (throwNext) {
      throwNext = false;
      throw new TypeError("fetch failed");
    }
    if (hang) {
      hang = false;
      return new Promise<Response>((_, reject) => {
        const signal = init?.signal;
        if (signal?.aborted) reject(abortError());
        signal?.addEventListener("abort", () => reject(abortError()));
      });
    }
    if (canned) {
      const response = canned;
      canned = null;
      return new Response(response.body ?? JSON.stringify({ status: "error" }), {
        status: response.status,
        statusText: response.statusText ?? "",
        headers: { "content-type": "application/json", ...response.headers },
      });
    }

    const auth = headers.get("authorization") ?? "";
    const apiKey = auth.startsWith("Bearer cal_") ? auth.slice("Bearer ".length) : undefined;
    if (!apiKey) return json(401, { status: "error" }, "Unauthorized");

    const version = headers.get("cal-api-version");
    const path = url.pathname;
    const q = url.searchParams;

    if (method === "GET" && path === "/v2/slots") {
      if (version !== VERSIONS.slots) return json(400, { status: "error" }, "Bad Request");
      const start = q.get("start");
      const end = q.get("end");
      if (!start || !end) return json(400, { status: "error" }, "Bad Request");
      if (q.get("eventTypeId") !== String(eventTypeId)) {
        return json(404, { status: "error" }, "Not Found");
      }
      const duration = Number(q.get("duration") ?? 30);
      const range = q.get("format") === "range";
      return json(200, { status: "success", data: slotsBetween(new Date(start), new Date(end), duration, range) });
    }

    if (method === "POST" && path === "/v2/bookings") {
      if (version !== VERSIONS.createBooking) return json(400, { status: "error" }, "Bad Request");
      const b = body as Record<string, unknown> | undefined;
      const attendee = b?.attendee as Record<string, string> | undefined;
      const start = typeof b?.start === "string" ? new Date(b.start) : undefined;
      if (!start || Number.isNaN(start.getTime()) || !attendee?.name || !attendee.timeZone) {
        return json(400, { status: "error" }, "Bad Request");
      }
      if (b?.eventTypeId !== eventTypeId) return json(404, { status: "error" }, "Not Found");
      const length = typeof b?.lengthInMinutes === "number" ? b.lengthInMinutes : 30;
      const booking: FakeBooking = {
        id: nextId,
        uid: `uid_${nextId}`,
        title: `${length} min between Dr Chen and ${attendee.name}`,
        start: start.toISOString(),
        end: new Date(start.getTime() + length * 60_000).toISOString(),
        status: "accepted",
        metadata: (b?.metadata as Record<string, unknown>) ?? {},
        attendees: [
          {
            name: attendee.name,
            email: attendee.email ?? "",
            timeZone: attendee.timeZone,
            ...(attendee.phoneNumber ? { phoneNumber: attendee.phoneNumber } : {}),
          },
        ],
        eventTypeId,
        eventType: { id: eventTypeId, slug },
        hosts: [{ name: "Dr Chen" }],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      nextId += 1;
      storeFor(apiKey).push(booking);
      return json(201, { status: "success", data: booking });
    }

    if (method === "GET" && path === "/v2/bookings") {
      if (version !== VERSIONS.listBookings) return json(400, { status: "error" }, "Bad Request");
      const attendeeEmail = q.get("attendeeEmail");
      const afterStart = q.get("afterStart");
      const beforeEnd = q.get("beforeEnd");
      const eventTypeFilter = q.get("eventTypeId");
      const bookingUid = q.get("bookingUid");
      const limit = Math.min(Math.max(Number(q.get("limit") ?? 50), 1), 100);
      const offset = Number(q.get("cursor") ?? 0);

      const matching = storeFor(apiKey)
        .filter((b) => !attendeeEmail || b.attendees.some((a) => a.email === attendeeEmail))
        .filter((b) => !afterStart || b.start > new Date(afterStart).toISOString())
        .filter((b) => !beforeEnd || b.end < new Date(beforeEnd).toISOString())
        .filter((b) => !eventTypeFilter || String(b.eventTypeId) === eventTypeFilter)
        .filter((b) => !bookingUid || b.uid === bookingUid)
        .sort((a, b) => a.start.localeCompare(b.start));

      const page = matching.slice(offset, offset + limit);
      const next = offset + limit;
      return json(200, {
        status: "success",
        data: page,
        pagination: {
          nextCursor: next < matching.length ? String(next) : null,
          hasMore: next < matching.length,
        },
      });
    }

    const cancel = /^\/v2\/bookings\/([^/]+)\/cancel$/.exec(path);
    if (method === "POST" && cancel) {
      if (version !== VERSIONS.cancelBooking) return json(400, { status: "error" }, "Bad Request");
      const uid = decodeURIComponent(cancel[1]!);
      const booking = storeFor(apiKey).find((b) => b.uid === uid);
      if (!booking) return json(404, { status: "error" }, "Not Found");
      booking.status = "cancelled";
      booking.updatedAt = new Date().toISOString();
      return json(200, { status: "success", data: booking });
    }

    if (method === "GET" && path === `/v2/event-types/${eventTypeId}`) {
      if (version !== VERSIONS.eventType) return json(400, { status: "error" }, "Bad Request");
      return json(200, {
        status: "success",
        data: {
          id: eventTypeId,
          slug,
          title: "Consultation",
          lengthInMinutes: 30,
          ...(emailSettings ? { emailSettings } : {}),
        },
      });
    }

    if (method === "GET" && path === "/v2/workflows") {
      return json(200, { status: "success", data: workflows });
    }

    return json(404, { status: "error" }, "Not Found");
  };

  return {
    fetch: fetchImpl,
    requests,
    /** The next request gets this answer instead of being routed. */
    respondNext(response: CannedResponse): void {
      canned = response;
    },
    /** The next request never answers until its signal aborts. */
    hangNext(): void {
      hang = true;
    },
    /** The next request throws, as a DNS or TLS failure would. */
    throwNext(): void {
      throwNext = true;
    },
    bookings(apiKey: string): FakeBooking[] {
      return storeFor(apiKey);
    },
    /** Put a booking in as if the clinic had made it in Cal.com itself. */
    addBooking(apiKey: string, booking: Partial<FakeBooking> & { start: string }): FakeBooking {
      const full: FakeBooking = {
        id: nextId,
        uid: `uid_${nextId}`,
        title: "Consultation",
        end: new Date(new Date(booking.start).getTime() + 30 * 60_000).toISOString(),
        status: "accepted",
        metadata: {},
        attendees: [{ name: "Rowan Okonkwo", email: "rowan@example.com", timeZone: "America/New_York" }],
        eventTypeId,
        eventType: { id: eventTypeId, slug },
        hosts: [{ name: "Dr Chen" }],
        createdAt: booking.start,
        updatedAt: booking.start,
        ...booking,
      };
      nextId += 1;
      storeFor(apiKey).push(full);
      return full;
    },
    lastRequest(): FakeRequest {
      const last = requests[requests.length - 1];
      if (!last) throw new Error("no request was made");
      return last;
    },
  };
}

export type FakeCalcom = ReturnType<typeof fakeCalcom>;

function json(status: number, body: unknown, statusText = ""): Response {
  return new Response(JSON.stringify(body), {
    status,
    statusText,
    headers: { "content-type": "application/json" },
  });
}

function abortError(): Error {
  const error = new Error("This operation was aborted");
  error.name = "AbortError";
  return error;
}

/** 09:00–16:00 UTC each day, keyed by day, the way /v2/slots answers. */
function slotsBetween(start: Date, end: Date, duration: number, range: boolean) {
  const data: Record<string, Array<{ start: string; end?: string }>> = {};
  const day = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()));
  for (let guard = 0; guard < 60 && day < end; guard += 1) {
    const key = day.toISOString().slice(0, 10);
    for (let minutes = 9 * 60; minutes + duration <= 16 * 60; minutes += duration) {
      const at = new Date(day.getTime() + minutes * 60_000);
      if (at < start || at >= end) continue;
      const item: { start: string; end?: string } = { start: at.toISOString() };
      if (range) item.end = new Date(at.getTime() + duration * 60_000).toISOString();
      (data[key] ??= []).push(item);
    }
    day.setUTCDate(day.getUTCDate() + 1);
  }
  return data;
}

function seed(
  apiKey: string,
  count: number,
  from: Date,
  to: Date,
  eventTypeId: number,
  slug: string,
): FakeBooking[] {
  const hash = [...apiKey].reduce((acc, char) => (acc * 31 + char.charCodeAt(0)) >>> 0, 17);
  const span = to.getTime() - from.getTime();
  const bookings: FakeBooking[] = [];
  for (let i = 0; i < count; i += 1) {
    const start = new Date(from.getTime() + Math.floor((i * span) / count) + ((hash + i) % 5) * 60_000);
    bookings.push({
      id: i + 1,
      uid: `bk_${hash.toString(36)}_${i}`,
      title: "Consultation",
      start: start.toISOString(),
      end: new Date(start.getTime() + 30 * 60_000).toISOString(),
      status: (hash + i) % 9 === 0 ? "cancelled" : "accepted",
      metadata: {},
      attendees: [{ name: `Attendee ${i}`, email: `attendee${i}@example.com`, timeZone: "UTC" }],
      eventTypeId,
      eventType: { id: eventTypeId, slug },
      hosts: [{ name: "Dr Chen" }],
      createdAt: start.toISOString(),
      updatedAt: start.toISOString(),
    });
  }
  return bookings;
}
