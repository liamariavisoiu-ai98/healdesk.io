import type { CapabilitySet } from "../capabilities";
import { toDate } from "../guards";
import type { ConnectorAdapter } from "../port";
import { fail, failure, fromHttpStatus, ok, type Result } from "../result";
import type {
  ArrivalState,
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

/**
 * Cal.com, over its v2 REST API — the first platform we write into, and in
 * this release the only one.
 *
 * The reads are what the sync expects of every adapter, narrowed to what
 * Cal.com can honestly give: it knows a booking exists, not whether the person
 * arrived, and it holds no sales. The write is the port's one write, and two
 * things are guaranteed here rather than left to the caller:
 *
 *   - Nothing about a patient reaches Cal.com beyond a name, a sink address
 *     and a time. The request body is built field by field from the input
 *     type, which has no phone field, so a number cannot be forwarded even by
 *     an input that carries one at runtime.
 *   - Nothing Cal.com says comes back in an error. A failure carries the HTTP
 *     status and a status word, never a body — an error body echoes the
 *     request, and the request is PHI.
 *
 * No retries here. Cal.com has no idempotency key, so only the caller — which
 * knows whether it has read back by `healdesk_request_id` — may decide to try
 * again (design B.4). Every call is bounded to CALCOM_TIMEOUT_MS, and a
 * failure whose reason is `timeout`, `network` or `unconfirmed` means the
 * outcome is unknown, not that nothing happened.
 *
 * Vendor facts were read from https://cal.com/docs/api-reference/v2/ on
 * 29 September 2026 and are cited at the call that relies on each. All of them
 * must be re-verified before go-live (design, "Vendor endpoints relied on");
 * the ones marked "verify" are the ones the docs were least settled on.
 */

export const CALCOM_BASE_URL = "https://api.cal.com";
export const CALCOM_TIMEOUT_MS = 8_000;

/**
 * Cal.com versions each endpoint independently through the `cal-api-version`
 * header, and sends an older shape when the header is missing or wrong.
 */
export const CALCOM_API_VERSIONS = {
  /** https://cal.com/docs/api-reference/v2/slots/get-available-time-slots-for-an-event-type */
  slots: "2024-09-04",
  /** https://cal.com/docs/api-reference/v2/bookings/create-a-booking */
  createBooking: "2026-02-25",
  /** https://cal.com/docs/api-reference/v2/bookings/cancel-a-booking */
  cancelBooking: "2026-02-25",
  /** https://cal.com/docs/api-reference/v2/bookings/get-all-bookings — verify before go-live. */
  listBookings: "2026-05-01",
  /** https://cal.com/docs/api-reference/v2/event-types/get-an-event-type — verify before go-live. */
  eventType: "2026-06-12",
} as const;

/** The metadata key a healdesk-created booking carries. The read-back matches on it. */
export const HEALDESK_REQUEST_ID_KEY = "healdesk_request_id";

const DAY_MS = 86_400_000;
const PAGE_LIMIT = 100;

const CAPABILITIES: CapabilitySet = {
  listAppointments: {
    support: "partial",
    note: "Cal.com knows the booking exists; it does not know whether the person arrived.",
  },
  readArrival: { support: "unsupported" },
  listSales: {
    support: "unsupported",
    note: "Cal.com holds no sales, so revenue needs a payment processor connected as well.",
  },
  backfillSales: { support: "unsupported" },
  listSlots: { support: "full" },
  createAppointment: { support: "full" },
  findAppointmentByKey: { support: "full" },
  writeBack: { support: "unsupported" },
};

export type CalcomAdapterOptions = {
  /** Injected for tests. Resolved at call time, so a stubbed global also works. */
  fetch?: typeof fetch;
  baseUrl?: string;
  timeoutMs?: number;
  now?: () => Date;
};

type Config = { apiKey: string; eventTypeId: number; durationMinutes: number };

type RequestSpec = {
  method: "GET" | "POST";
  path: string;
  /** Omitted for the few endpoints the docs list without a version header. */
  version?: string;
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  /** Log-safe prefix for messages, e.g. "calcom createAppointment". */
  context: string;
};

type Json = Record<string, unknown>;

export class CalcomAdapter implements ConnectorAdapter {
  readonly id = "calcom";
  readonly displayName = "Cal.com";
  readonly capabilities = CAPABILITIES;

  readonly #options: CalcomAdapterOptions;

  constructor(options: CalcomAdapterOptions = {}) {
    this.#options = options;
  }

  /**
   * Proves the key and the event type by asking for tomorrow's slots, then
   * refuses an event type that would notify anyone: we hand Cal.com a sink
   * address and never a patient's, so its own emails and workflows would go
   * out in the clinic's name to nobody, or to the clinic with a name and a
   * time in them (design B.2).
   */
  async verify(context: ConnectorContext): Promise<Result<VerifiedInfo>> {
    const config = configOf(context);
    if (!config.ok) return fail(config.error);

    const now = this.#now();
    const tomorrow = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1),
    );
    const slots = await this.#slots(
      config.value,
      { from: tomorrow, to: new Date(tomorrow.getTime() + DAY_MS) },
      "UTC",
      config.value.durationMinutes,
      "calcom verify",
    );
    if (!slots.ok) return fail(slots.error);

    const quiet = await this.#notificationsOff(config.value);
    if (!quiet.ok) return fail(quiet.error);

    return ok({
      accountLabel: quiet.value.slug
        ? `Cal.com · ${quiet.value.slug}`
        : `Cal.com event type ${config.value.eventTypeId}`,
      coverageStartedAt: null,
    });
  }

  async listAppointments(
    context: ConnectorContext,
    window: TimeWindow,
    cursor?: string,
  ): Promise<Result<Page<CanonicalAppointment>>> {
    const config = configOf(context);
    if (!config.ok) return fail(config.error);
    const ctx = "calcom listAppointments";

    // `afterStart` and `beforeEnd` filter on the booking's own start and end
    // (get-all-bookings), so a booking straddling a window edge would fall out
    // of both neighbouring windows. Over-fetch a day each side and cut to the
    // half-open window here; the sync's windows are contiguous and must not
    // lose the boundary. Verify the parameter names before go-live.
    const response = await this.#request(config.value, {
      method: "GET",
      path: "/v2/bookings",
      version: CALCOM_API_VERSIONS.listBookings,
      query: {
        eventTypeId: config.value.eventTypeId,
        afterStart: new Date(window.from.getTime() - DAY_MS).toISOString(),
        beforeEnd: new Date(window.to.getTime() + DAY_MS).toISOString(),
        sortStart: "asc",
        limit: PAGE_LIMIT,
        cursor,
      },
      context: ctx,
    });
    if (!response.ok) return fail(response.error);

    const list = bookingsOf(response.value.json);
    if (!list) return malformed(ctx, "the booking list is not an array");

    const now = this.#now();
    const items: CanonicalAppointment[] = [];
    for (const booking of list) {
      if (!isRecord(booking)) return malformed(ctx, "a booking is not an object");
      const uid = asString(booking.uid);
      const start = toDate(booking.start);
      if (!uid || !start) return malformed(ctx, "a booking has no uid or start");
      if (start < window.from || start >= window.to) continue;
      items.push(toCanonical(booking, uid, start, now));
    }

    const pagination = isRecord(response.value.json)
      ? response.value.json.pagination
      : undefined;
    const next = isRecord(pagination) ? asString(pagination.nextCursor) : undefined;

    return ok({ items, cursor: next });
  }

  async listSales(): Promise<Result<Page<CanonicalSale>>> {
    return failure(
      "unsupported",
      "calcom listSales: Cal.com holds no sales; revenue needs a payment processor",
    );
  }

  async listContacts(): Promise<Result<Page<CanonicalContact>>> {
    return failure(
      "unsupported",
      "calcom listContacts: Cal.com has no contact records, only attendees on bookings",
    );
  }

  async listSlots(
    context: ConnectorContext,
    window: TimeWindow,
    opts: { timeZone: string; durationMinutes?: number },
  ): Promise<Result<CanonicalSlot[]>> {
    const config = configOf(context);
    if (!config.ok) return fail(config.error);
    return this.#slots(
      config.value,
      window,
      opts.timeZone,
      opts.durationMinutes ?? config.value.durationMinutes,
      "calcom listSlots",
    );
  }

  /**
   * POST /v2/bookings (create-a-booking): `start` in UTC ISO, `eventTypeId`,
   * `attendee.{name,email,timeZone}`, `metadata` (≤50 keys, key ≤40 chars,
   * value ≤500 chars, inert on the vendor side). `attendee.phoneNumber` is
   * "required only if SMS reminders enabled" and is never sent; the input type
   * has nowhere to carry one, and the body below names each field it sends.
   *
   * `lengthInMinutes` is only sent when the caller asks for a length other
   * than the connection's configured one, so an event type with a single
   * fixed length never sees the field (verify before go-live whether Cal.com
   * rejects a matching value on such an event type).
   */
  async createAppointment(
    context: ConnectorContext,
    input: CreateAppointmentInput,
  ): Promise<Result<{ externalId: string; startsAt: Date; endsAt: Date }>> {
    const config = configOf(context);
    if (!config.ok) return fail(config.error);
    const ctx = "calcom createAppointment";

    const body: Json = {
      start: input.startsAt.toISOString(),
      eventTypeId: config.value.eventTypeId,
      attendee: {
        name: input.attendee.name,
        email: input.attendee.email,
        timeZone: input.attendee.timeZone,
      },
      metadata: { [HEALDESK_REQUEST_ID_KEY]: input.idempotencyKey },
    };
    if (
      input.durationMinutes !== null &&
      input.durationMinutes !== config.value.durationMinutes
    ) {
      body.lengthInMinutes = input.durationMinutes;
    }

    const response = await this.#request(config.value, {
      method: "POST",
      path: "/v2/bookings",
      version: CALCOM_API_VERSIONS.createBooking,
      body,
      context: ctx,
    });
    if (!response.ok) return fail(response.error);

    const data = dataOf(response.value.json);
    const uid = data ? asString(data.uid) : undefined;
    const startsAt = data ? toDate(data.start) : undefined;
    const endsAt = data ? toDate(data.end) : undefined;
    if (!uid || !startsAt || !endsAt) {
      // A 2xx we cannot read may still have booked the slot. Say so: the
      // caller must read back before it retries.
      return failure(
        "malformed_response",
        `${ctx}: Cal.com answered ${response.value.status} without a readable uid and times; read back before retrying`,
        { status: response.value.status, reason: "unconfirmed" },
      );
    }

    return ok({ externalId: uid, startsAt, endsAt });
  }

  /**
   * GET /v2/bookings filtered to the sink address and ±1 day around the slot,
   * then matched on `metadata.healdesk_request_id`. Filter names
   * (`attendeeEmail`, `afterStart`, `beforeEnd`) read from get-all-bookings on
   * 29 September 2026 — verify against the vendor's current docs before
   * go-live. One page: the address is unique to the request, so the list is
   * at most a handful.
   */
  async findAppointmentByKey(
    context: ConnectorContext,
    input: { idempotencyKey: string; attendeeEmail: string; around: Date },
  ): Promise<Result<{ externalId: string } | null>> {
    const config = configOf(context);
    if (!config.ok) return fail(config.error);
    const ctx = "calcom findAppointmentByKey";

    const response = await this.#request(config.value, {
      method: "GET",
      path: "/v2/bookings",
      version: CALCOM_API_VERSIONS.listBookings,
      query: {
        attendeeEmail: input.attendeeEmail,
        afterStart: new Date(input.around.getTime() - DAY_MS).toISOString(),
        beforeEnd: new Date(input.around.getTime() + DAY_MS).toISOString(),
        limit: PAGE_LIMIT,
      },
      context: ctx,
    });
    if (!response.ok) return fail(response.error);

    const list = bookingsOf(response.value.json);
    if (!list) return malformed(ctx, "the booking list is not an array");

    for (const booking of list) {
      if (!isRecord(booking) || !isRecord(booking.metadata)) continue;
      if (booking.metadata[HEALDESK_REQUEST_ID_KEY] !== input.idempotencyKey) continue;
      const uid = asString(booking.uid);
      if (uid) return ok({ externalId: uid });
    }

    return ok(null);
  }

  /**
   * POST /v2/bookings/{bookingUid}/cancel (cancel-a-booking). Looks the
   * booking up first and refuses one that does not carry our key: the port's
   * doctrine is that nothing the clinic created is ours to touch, and the
   * adapter is the last place that can enforce it.
   */
  async cancelAppointment(
    context: ConnectorContext,
    externalId: string,
    reason: string,
  ): Promise<Result<void>> {
    const config = configOf(context);
    if (!config.ok) return fail(config.error);
    const ctx = "calcom cancelAppointment";

    const lookup = await this.#request(config.value, {
      method: "GET",
      path: "/v2/bookings",
      version: CALCOM_API_VERSIONS.listBookings,
      query: { bookingUid: externalId, limit: 1 },
      context: `${ctx} (lookup)`,
    });
    if (!lookup.ok) return fail(lookup.error);

    const list = bookingsOf(lookup.value.json);
    if (!list) return malformed(ctx, "the booking list is not an array");
    const booking = list.find((b) => isRecord(b) && b.uid === externalId);
    const ours =
      isRecord(booking) &&
      isRecord(booking.metadata) &&
      typeof booking.metadata[HEALDESK_REQUEST_ID_KEY] === "string";
    if (!ours) {
      return failure(
        "unsupported",
        `${ctx}: refusing to cancel a booking healdesk did not create`,
        { reason: "not_ours" },
      );
    }

    const response = await this.#request(config.value, {
      method: "POST",
      path: `/v2/bookings/${encodeURIComponent(externalId)}/cancel`,
      version: CALCOM_API_VERSIONS.cancelBooking,
      body: { cancellationReason: reason.slice(0, 200) },
      context: ctx,
    });
    if (!response.ok) return fail(response.error);

    return ok(undefined);
  }

  // ---------------------------------------------------------------------------

  /**
   * GET /v2/slots (get-available-time-slots-for-an-event-type): `start` and
   * `end` required, UTC ISO; `eventTypeId`, `timeZone`, `duration`,
   * `format=range`; header `cal-api-version: 2024-09-04`. Response is
   * `{ status, data: { "YYYY-MM-DD": [{ start, end }] } }`.
   */
  async #slots(
    config: Config,
    window: TimeWindow,
    timeZone: string,
    duration: number,
    ctx: string,
  ): Promise<Result<CanonicalSlot[]>> {
    const response = await this.#request(config, {
      method: "GET",
      path: "/v2/slots",
      version: CALCOM_API_VERSIONS.slots,
      query: {
        eventTypeId: config.eventTypeId,
        start: window.from.toISOString(),
        end: window.to.toISOString(),
        timeZone,
        duration,
        format: "range",
      },
      context: ctx,
    });
    if (!response.ok) return fail(response.error);

    const data = dataOf(response.value.json);
    if (!data) return malformed(ctx, "the slot list is not keyed by day");

    const slots: CanonicalSlot[] = [];
    for (const day of Object.values(data)) {
      if (!Array.isArray(day)) return malformed(ctx, "a day's slots are not an array");
      for (const item of day) {
        const startsAt = isRecord(item) ? toDate(item.start) : undefined;
        const endsAt = isRecord(item) ? toDate(item.end) : undefined;
        if (!startsAt || !endsAt) return malformed(ctx, "a slot has no start or end");
        if (startsAt >= window.from && startsAt < window.to) {
          slots.push({ startsAt, endsAt });
        }
      }
    }
    slots.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());

    return ok(slots);
  }

  /**
   * Refuse an event type that would notify anyone.
   *
   * GET /v2/event-types/{id} (get-an-event-type, `cal-api-version:
   * 2026-06-12`) exposes `emailSettings.{disableEmailsToAttendees,
   * disableEmailsToHosts}`; both must be true. The docs add that personal
   * event types need an accepted organisation membership for the object to be
   * present at all, so a solo Cal.com account may not expose it — that case
   * fails closed with reason `emails_or_workflows_unconfirmed` rather than
   * letting an unverifiable event type receive a name and a time. Verify
   * before go-live whether the clinic's plan exposes the object.
   *
   * GET /v2/workflows (get-your-workflows) lists the user's event-type
   * workflows with `activation.{isActiveOnAllEventTypes, activeOnEventTypeIds}`;
   * any active on this event type is refused. Team workflows live under
   * /v2/organizations/{orgId}/teams/{teamId}/workflows and need ids the
   * connection does not hold, so they are not checked here — verify before
   * go-live that the clinic's event type is a personal one, or add the ids.
   */
  async #notificationsOff(config: Config): Promise<Result<{ slug?: string }>> {
    const ctx = "calcom verify";

    const eventType = await this.#request(config, {
      method: "GET",
      path: `/v2/event-types/${config.eventTypeId}`,
      version: CALCOM_API_VERSIONS.eventType,
      context: `${ctx} (event type)`,
    });
    if (!eventType.ok) return fail(eventType.error);

    const data = dataOf(eventType.value.json);
    const emailSettings = data && isRecord(data.emailSettings) ? data.emailSettings : undefined;
    if (
      !emailSettings ||
      typeof emailSettings.disableEmailsToAttendees !== "boolean" ||
      typeof emailSettings.disableEmailsToHosts !== "boolean"
    ) {
      return failure(
        "misconfigured",
        `${ctx}: the event type does not expose its email settings, so Cal.com cannot be confirmed silent; see CalcomAdapter for the plan requirement`,
        { reason: "emails_or_workflows_unconfirmed" },
      );
    }
    if (!emailSettings.disableEmailsToAttendees || !emailSettings.disableEmailsToHosts) {
      return failure(
        "misconfigured",
        `${ctx}: the event type still sends Cal.com's own emails; switch them off and verify again`,
        { reason: "emails_or_workflows_on" },
      );
    }

    const workflows = await this.#request(config, {
      method: "GET",
      path: "/v2/workflows",
      query: { take: 250 },
      context: `${ctx} (workflows)`,
    });
    if (!workflows.ok) return fail(workflows.error);

    const list = isRecord(workflows.value.json) ? workflows.value.json.data : undefined;
    if (!Array.isArray(list)) return malformed(ctx, "the workflow list is not an array");

    const active = list.some((workflow) => {
      if (!isRecord(workflow) || !isRecord(workflow.activation)) return false;
      const activation = workflow.activation;
      if (activation.isActiveOnAllEventTypes === true) return true;
      return (
        Array.isArray(activation.activeOnEventTypeIds) &&
        activation.activeOnEventTypeIds.some((id) => Number(id) === config.eventTypeId)
      );
    });
    if (active) {
      return failure(
        "misconfigured",
        `${ctx}: a workflow is active on the event type; switch it off and verify again`,
        { reason: "emails_or_workflows_on" },
      );
    }

    return ok({ slug: data ? asString(data.slug) : undefined });
  }

  /**
   * One bounded request. Returns the parsed JSON on 2xx; on anything else a
   * failure built from the status line alone.
   */
  async #request(
    config: Config,
    spec: RequestSpec,
  ): Promise<Result<{ status: number; json: unknown }>> {
    const url = new URL(spec.path, this.#options.baseUrl ?? CALCOM_BASE_URL);
    for (const [key, value] of Object.entries(spec.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${config.apiKey}`,
      Accept: "application/json",
    };
    if (spec.version) headers["cal-api-version"] = spec.version;
    if (spec.body !== undefined) headers["Content-Type"] = "application/json";

    const timeoutMs = this.#options.timeoutMs ?? CALCOM_TIMEOUT_MS;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      let response: Response;
      try {
        response = await this.#fetch()(url.toString(), {
          method: spec.method,
          headers,
          body: spec.body === undefined ? undefined : JSON.stringify(spec.body),
          signal: controller.signal,
        });
      } catch {
        // The thrown error can carry the request; neither its message nor its
        // shape is looked at.
        return controller.signal.aborted
          ? failure(
              "unavailable",
              `${spec.context}: no answer from Cal.com within ${timeoutMs} ms`,
              { reason: "timeout" },
            )
          : failure("unavailable", `${spec.context}: could not reach Cal.com`, {
              reason: "network",
            });
      }

      if (!response.ok) {
        const retryAfter = Number.parseInt(response.headers.get("retry-after") ?? "", 10);
        return fromHttpStatus(response.status, response.statusText, spec.context, {
          retryAfter: Number.isFinite(retryAfter) ? retryAfter : undefined,
        });
      }

      try {
        const json: unknown = await response.json();
        return ok({ status: response.status, json });
      } catch {
        return failure(
          "malformed_response",
          `${spec.context}: Cal.com answered ${response.status} with a body that is not JSON`,
          {
            status: response.status,
            reason: controller.signal.aborted ? "timeout" : "unconfirmed",
          },
        );
      }
    } finally {
      clearTimeout(timer);
    }
  }

  #fetch(): typeof fetch {
    return this.#options.fetch ?? globalThis.fetch;
  }

  #now(): Date {
    return this.#options.now ? this.#options.now() : new Date();
  }
}

/** The connection's own settings, or a `misconfigured` failure naming what is missing. */
function configOf(context: ConnectorContext): Result<Config> {
  const apiKey = context.credentials.apiKey;
  if (typeof apiKey !== "string" || apiKey.length === 0) {
    return failure("misconfigured", "calcom: the connection has no API key", {
      reason: "missing_api_key",
    });
  }

  const eventTypeId = positiveInt(context.metadata?.eventTypeId);
  if (eventTypeId === undefined) {
    return failure("misconfigured", "calcom: the connection names no event type", {
      reason: "missing_event_type",
    });
  }

  const durationMinutes = positiveInt(context.metadata?.durationMinutes);
  if (durationMinutes === undefined) {
    return failure(
      "misconfigured",
      "calcom: the connection has no duration for its event type",
      { reason: "missing_duration" },
    );
  }

  return ok({ apiKey, eventTypeId, durationMinutes });
}

/**
 * A booking as the sync sees it. Attendees are deliberately not mapped: the
 * canonical row needs no name or address, and Cal.com's attendees carry no id
 * to resolve to a contact anyway.
 */
function toCanonical(booking: Json, uid: string, start: Date, now: Date): CanonicalAppointment {
  const status = asString(booking.status);
  const arrival: ArrivalState =
    status === "cancelled" || status === "rejected"
      ? "cancelled"
      : start < now
        ? "unknown"
        : "scheduled";
  const eventType = isRecord(booking.eventType) ? booking.eventType : undefined;
  const host = Array.isArray(booking.hosts) ? booking.hosts.find(isRecord) : undefined;

  return {
    externalId: uid,
    scheduledFor: start,
    arrival,
    treatment: eventType ? asString(eventType.slug) : undefined,
    providerName: host ? asString(host.name) : undefined,
    updatedAt: toDate(booking.updatedAt),
  };
}

function positiveInt(value: unknown): number | undefined {
  const n =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim() !== ""
        ? Number(value)
        : Number.NaN;
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function dataOf(json: unknown): Json | undefined {
  return isRecord(json) && isRecord(json.data) ? json.data : undefined;
}

function bookingsOf(json: unknown): unknown[] | undefined {
  return isRecord(json) && Array.isArray(json.data) ? json.data : undefined;
}

function malformed<T>(ctx: string, what: string): Result<T> {
  return failure("malformed_response", `${ctx}: ${what}`, { reason: "malformed_response" });
}

export const calcomAdapter = new CalcomAdapter();
