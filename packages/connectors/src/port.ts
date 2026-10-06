import type { CapabilitySet } from "./capabilities";
import type { Result } from "./result";
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
} from "./types";

/**
 * The port every adapter implements.
 *
 * Deliberately narrow. The reads exist for attribution: the sync engine is
 * written once against three list methods and works for eight vendors,
 * including the ones that cannot do half of them.
 *
 * The writes are narrower still — there is exactly one. Add an appointment
 * the practice confirmed on the request page, or elected the assistant to book
 * on the phone. Everything else on the write side exists only to make that one
 * write safe: reading slots so we offer times that exist, reading a booking
 * back by our own key so a retry after a timeout cannot book the slot twice,
 * and cancelling a booking we ourselves created. There is no update, no
 * reschedule and no delete of anything the clinic or its staff put in their
 * calendar, and the way you stop a future contributor writing code that does
 * is to give them no method to call.
 *
 * The write methods are optional so the read-only adapters stay valid. An
 * adapter that declares `createAppointment` usable must implement all of
 * `listSlots`, `createAppointment` and `findAppointmentByKey`; the contract
 * test enforces it, because the app's write sequence needs all three.
 *
 * Note what is NOT here: no `getPatient`, no `getChart`, nothing clinical. The
 * agent cannot prescribe, diagnose or set treatment plans, and that is
 * enforced by the absence of a method, not by a prompt. See
 * docs/hipaa-compliance.md.
 *
 * Adapters must not import Drizzle, `pg`, or Next. Keeping this package free of
 * them is what lets the whole layer be contract-tested in milliseconds with no
 * database, and stops our storage shapes leaking into the "canonical" model.
 */
export interface ConnectorAdapter {
  /** Matches the platform id in @healdesk/catalog. */
  readonly id: string;
  readonly displayName: string;

  /**
   * What this adapter can do. Static per platform, not per connection —
   * Acuity's lack of an arrival concept is a property of Acuity.
   */
  readonly capabilities: CapabilitySet;

  /**
   * Check the credentials work and report what the account can reach.
   *
   * Called at connect time and periodically after. A connection that silently
   * stops working is worse than one that never worked, because the reports
   * keep arriving and quietly shrink.
   *
   * For a write-capable adapter this is also where the write target itself
   * is checked before anything is written into it: for Google Calendar, that
   * the calendar answers free/busy and that the connected account owns it.
   */
  verify(context: ConnectorContext): Promise<Result<VerifiedInfo>>;

  /**
   * Appointments changed or scheduled within the window.
   *
   * Adapters whose platform cannot list appointments return an `unsupported`
   * failure rather than an empty page. Empty means "none"; unsupported means
   * "we cannot know", and the reconciler treats them very differently.
   */
  listAppointments(
    context: ConnectorContext,
    window: TimeWindow,
    cursor?: string,
  ): Promise<Result<Page<CanonicalAppointment>>>;

  /** Settled sales within the window. Same unsupported-vs-empty rule. */
  listSales(
    context: ConnectorContext,
    window: TimeWindow,
    cursor?: string,
  ): Promise<Result<Page<CanonicalSale>>>;

  /** Contacts, for resolving appointment and sale references to a person. */
  listContacts(
    context: ConnectorContext,
    window: TimeWindow,
    cursor?: string,
  ): Promise<Result<Page<CanonicalContact>>>;

  /**
   * Free time in the calendar this connection writes into.
   *
   * Only exists so `createAppointment` can be offered a time that exists.
   * Sorted, half-open, within the window. A booking platform returns the
   * bookable slots of its event type. A calendar adapter (Google Calendar)
   * has no event type, so it returns the maximal free intervals instead, and
   * the caller lays its own opening hours, notice and slot length over them.
   *
   * `freshCredentials` asks for a token minted for this call rather than a
   * cached one: the assistant's re-check just before it books must see a
   * revoked grant now, not when a cached token expires.
   */
  listSlots?(
    context: ConnectorContext,
    window: TimeWindow,
    opts: { timeZone: string; durationMinutes?: number; freshCredentials?: boolean },
  ): Promise<Result<CanonicalSlot[]>>;

  /**
   * The one write. Adds an appointment the practice's staff confirmed or the
   * assistant booked, and returns the platform's own id for it.
   *
   * No retries inside the adapter: only the caller knows whether a read-back
   * happened, and a retry without one books the slot twice. A failure whose
   * `reason` is `timeout` or `network` means the outcome is unknown, not that
   * nothing happened — read back with `findAppointmentByKey` before trying
   * again.
   *
   * `adopted` is set when the platform already held our booking under this
   * key (Google answers 409 for an event id it has seen): the value then
   * describes that booking, whose times the caller should compare with its
   * own before treating it as the same one.
   */
  createAppointment?(
    context: ConnectorContext,
    input: CreateAppointmentInput,
  ): Promise<Result<{ externalId: string; startsAt: Date; endsAt: Date; adopted?: boolean }>>;

  /**
   * Find a booking we created, by the key we stamped on it.
   *
   * This is the only thing standing between "the create timed out" and "the
   * create ran twice". Null means the platform holds nothing under that key.
   * A platform that can only search by attendee and date (the removed
   * Cal.com adapter) needs `attendeeEmail` and looks near `around`; Google
   * Calendar reads the event straight back by the id derived from the key and
   * ignores both. A booking the clinic deleted is a `deleted_in_calendar`
   * failure, which is terminal: that key's booking is never written again.
   */
  findAppointmentByKey?(
    context: ConnectorContext,
    input: { idempotencyKey: string; attendeeEmail?: string; around: Date },
  ): Promise<Result<{ externalId: string; startsAt?: Date; endsAt?: Date } | null>>;

  /**
   * Cancel a booking we created. Adapters refuse an id that does not carry our
   * key — the clinic's own bookings are never ours to touch.
   */
  cancelAppointment?(
    context: ConnectorContext,
    externalId: string,
    reason: string,
  ): Promise<Result<void>>;

  /**
   * Verify a webhook signature and normalise the payload.
   *
   * Optional: not every platform has webhooks. Adapters that do must verify the
   * signature here rather than trusting the caller, because the caller is an
   * HTTP endpoint anyone can post to.
   */
  parseWebhook?(
    context: ConnectorContext,
    raw: string,
    headers: Record<string, string>,
  ): Result<WebhookEvent>;
}

export type WebhookEvent = {
  /** Platform's own delivery id, for deduplication. */
  deliveryId: string;
  kind: "appointment" | "sale" | "contact" | "other";
  /**
   * Whether the payload is complete or merely a hint.
   *
   * Many platforms send a thin notification and expect a read-back. Treating a
   * hint as complete silently stores a half-populated row.
   */
  complete: boolean;
  appointment?: CanonicalAppointment;
  sale?: CanonicalSale;
  contact?: CanonicalContact;
  /** Set when `complete` is false and the caller must fetch the real record. */
  fetchExternalId?: string;
};
