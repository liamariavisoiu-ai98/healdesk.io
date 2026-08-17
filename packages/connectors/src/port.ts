import type { CapabilitySet } from "./capabilities";
import type { Result } from "./result";
import type {
  CanonicalAppointment,
  CanonicalContact,
  CanonicalSale,
  ConnectorContext,
  Page,
  TimeWindow,
  VerifiedInfo,
} from "./types";

/**
 * The port every adapter implements.
 *
 * Deliberately narrow. It is tempting to add a method per platform feature, but
 * the value of this layer is that the sync engine can be written once against
 * four methods and work for eight vendors — including the ones that cannot do
 * half of them.
 *
 * Note what is NOT here: no `getPatient`, no `getChart`, nothing clinical. The
 * agent cannot prescribe, diagnose or set treatment plans, and the way you stop
 * a future contributor writing code that does is to give them no method to
 * call. See docs/hipaa-compliance.md.
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
