import type { CapabilitySet } from "../capabilities";
import { phoneShapedKey } from "../guards";
import type { ConnectorAdapter } from "../port";
import { failure, fromHttpStatus, ok, type Result } from "../result";
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

import { generate } from "./generator";
import { weekdaySlots } from "./slots";

/**
 * A synthetic clinic that behaves like a real platform.
 *
 * This exists so the sync engine, the reconciler and the monthly report can be
 * built, tested and demoed to prospects before any vendor has granted access —
 * which means business development and engineering run in parallel instead of
 * one waiting on the other.
 *
 * It deliberately declares itself as `partial` on backfill and pages its
 * results, because an adapter that behaves perfectly teaches the engine
 * nothing. If the pipeline only works against a fixture with no cursors, no
 * pagination and complete history, the first real platform breaks it.
 *
 * The same idea runs the write side. The fixture books like a vendor with no
 * idempotency key — the same request twice makes two bookings — and has
 * two switches the app's calendar-write tests throw: `failNextWrite()` for
 * "the vendor said no" and `timeoutNextWrite()` for "the vendor booked it and
 * we never heard". The second is the case that double-books a slot unless the
 * caller reads back by key before retrying, and `findAppointmentByKey` finds
 * exactly what a timed-out create stored.
 */

const PAGE_SIZE = 25;
const DAY_MS = 86_400_000;

const CAPABILITIES: CapabilitySet = {
  listAppointments: { support: "full" },
  readArrival: {
    support: "partial",
    note: "A small share of appointments come back with an unknown arrival state, mimicking platforms that record check-in inconsistently.",
  },
  listSales: { support: "full" },
  backfillSales: {
    support: "partial",
    note: "Synthetic history is generated on demand rather than stored, so it is internally consistent but not a real record.",
  },
  listSlots: { support: "full" },
  createAppointment: { support: "full" },
  findAppointmentByKey: { support: "full" },
  writeBack: {
    support: "unsupported",
    note: "The fixture never writes attribution results back into its records.",
  },
};

/** One booking made through the fixture, as the app's tests inspect it. */
export type RecordedWrite = {
  externalId: string;
  input: CreateAppointmentInput;
  /** The create "timed out": the booking exists but the caller never heard so. */
  timedOut: boolean;
  /** Set by cancelAppointment, with the reason given. */
  cancelledFor: string | null;
};

export class FixtureAdapter implements ConnectorAdapter {
  readonly id = "fixture";
  readonly displayName = "Synthetic clinic";
  readonly capabilities = CAPABILITIES;

  #writes: RecordedWrite[] = [];
  #failNextWrite = false;
  #timeoutNextWrite = false;

  async verify(context: ConnectorContext): Promise<Result<VerifiedInfo>> {
    return ok({
      accountLabel: `Synthetic clinic ${context.clinicId.slice(0, 8)}`,
      coverageStartedAt: null,
    });
  }

  async listAppointments(
    context: ConnectorContext,
    window: TimeWindow,
    cursor?: string,
  ): Promise<Result<Page<CanonicalAppointment>>> {
    const { appointments } = this.#data(context, window);
    return ok(paginate(appointments, cursor));
  }

  async listSales(
    context: ConnectorContext,
    window: TimeWindow,
    cursor?: string,
  ): Promise<Result<Page<CanonicalSale>>> {
    const { sales } = this.#data(context, window);

    // Sales are keyed on when the money moved, which is not the same window as
    // the appointments that produced them — a deposit taken in June belongs to
    // a July visit. Filtering here rather than in the generator keeps that
    // distinction visible.
    const inWindow = sales.filter(
      (sale) =>
        sale.collectedAt >= window.from && sale.collectedAt < window.to,
    );

    return ok(paginate(inWindow, cursor));
  }

  async listContacts(
    context: ConnectorContext,
    window: TimeWindow,
    cursor?: string,
  ): Promise<Result<Page<CanonicalContact>>> {
    const { contacts } = this.#data(context, window);
    return ok(paginate(contacts, cursor));
  }

  // ---- The write side ------------------------------------------------------

  /** Monday to Friday, 09:00 to 16:00 in the given zone, half-hour steps. */
  async listSlots(
    _context: ConnectorContext,
    window: TimeWindow,
    opts: { timeZone: string; durationMinutes?: number },
  ): Promise<Result<CanonicalSlot[]>> {
    try {
      return ok(
        weekdaySlots(window, {
          timeZone: opts.timeZone,
          slotMinutes: opts.durationMinutes ?? 30,
          stepMinutes: 30,
        }),
      );
    } catch {
      return failure("misconfigured", "fixture listSlots: not a time zone Intl knows", {
        reason: "bad_time_zone",
      });
    }
  }

  /**
   * Books, and records what it was handed so a test can assert on it.
   *
   * Refuses an input carrying anything phone-shaped, at runtime, even though
   * the type has no such field: the type stops a contributor, this stops a
   * cast. The refusal is the same shape a real adapter would give, so the
   * app's tests see it as a failed write rather than a crash.
   */
  async createAppointment(
    _context: ConnectorContext,
    input: CreateAppointmentInput,
  ): Promise<Result<{ externalId: string; startsAt: Date; endsAt: Date }>> {
    const phoneKey = phoneShapedKey(input);
    if (phoneKey) {
      return failure(
        "unsupported",
        `fixture createAppointment: refusing an input that carries "${phoneKey}"; the port has no phone field and no adapter may be handed one`,
        { reason: "phone_field_refused" },
      );
    }

    if (this.#failNextWrite) {
      this.#failNextWrite = false;
      return fromHttpStatus(409, "Conflict", "fixture createAppointment");
    }

    // No idempotency key, like the vendors this mimics: the same request twice is two
    // bookings, with distinct ids, and the caller is the one who must not
    // let that happen.
    const priorWithKey = this.#writes.filter(
      (write) => write.input.idempotencyKey === input.idempotencyKey,
    ).length;
    const externalId =
      priorWithKey === 0
        ? `fx-${input.idempotencyKey}`
        : `fx-${input.idempotencyKey}-${priorWithKey + 1}`;

    const timedOut = this.#timeoutNextWrite;
    this.#timeoutNextWrite = false;
    this.#writes.push({ externalId, input, timedOut, cancelledFor: null });

    if (timedOut) {
      return failure(
        "unavailable",
        "fixture createAppointment: no answer within the time budget",
        { reason: "timeout" },
      );
    }

    return ok({
      externalId,
      startsAt: input.startsAt,
      endsAt: new Date(input.startsAt.getTime() + (input.durationMinutes ?? 30) * 60_000),
    });
  }

  /**
   * What a prior create stored under that key — including one that timed out.
   *
   * Given an address, it matches the address and a time near `around`, like
   * a vendor that can only be searched by attendee and date. Without one it
   * matches the key alone, the way Google Calendar reads an event straight
   * back by the id derived from the key.
   */
  async findAppointmentByKey(
    _context: ConnectorContext,
    input: { idempotencyKey: string; attendeeEmail?: string; around: Date },
  ): Promise<Result<{ externalId: string } | null>> {
    const hit = this.#writes.find(
      (write) =>
        write.input.idempotencyKey === input.idempotencyKey &&
        (input.attendeeEmail === undefined ||
          (write.input.attendee.email === input.attendeeEmail &&
            Math.abs(write.input.startsAt.getTime() - input.around.getTime()) <= DAY_MS)),
    );
    return ok(hit ? { externalId: hit.externalId } : null);
  }

  /** Records the cancellation; refuses an id it did not itself hand out. */
  async cancelAppointment(
    _context: ConnectorContext,
    externalId: string,
    reason: string,
  ): Promise<Result<void>> {
    const hit = this.#writes.find((write) => write.externalId === externalId);
    if (!hit) {
      return failure(
        "unsupported",
        "fixture cancelAppointment: refusing to cancel a booking healdesk did not create",
        { reason: "not_ours" },
      );
    }
    hit.cancelledFor = reason;
    return ok(undefined);
  }

  /** The next create is refused by the "vendor": 409, nothing stored. */
  failNextWrite(): void {
    this.#failNextWrite = true;
  }

  /** The next create stores the booking but answers with a timeout. */
  timeoutNextWrite(): void {
    this.#timeoutNextWrite = true;
  }

  /** Every booking made through this adapter since the last reset, oldest first. */
  recordedWrites(): readonly RecordedWrite[] {
    return this.#writes;
  }

  /** Forget bookings and switches. The exported instance is shared by tests. */
  reset(): void {
    this.#writes = [];
    this.#failNextWrite = false;
    this.#timeoutNextWrite = false;
  }

  /**
   * Seeded from the clinic id, so the same clinic always yields the same
   * synthetic history. A demo that changes its numbers on refresh is worse
   * than no demo.
   *
   * The window is widened backwards so sales collected before it — deposits —
   * still exist to be found.
   */
  #data(context: ConnectorContext, window: TimeWindow) {
    const seed = [...context.clinicId].reduce(
      (acc, char) => (acc * 31 + char.charCodeAt(0)) >>> 0,
      7,
    );

    return generate({
      seed,
      from: new Date(window.from.getTime() - 30 * 86_400_000),
      to: window.to,
    });
  }
}

function paginate<T>(items: T[], cursor?: string): Page<T> {
  const offset = cursor ? Number(cursor) : 0;
  const slice = items.slice(offset, offset + PAGE_SIZE);
  const next = offset + PAGE_SIZE;

  return {
    items: slice,
    cursor: next < items.length ? String(next) : undefined,
  };
}

export const fixtureAdapter = new FixtureAdapter();
