/**
 * The canonical model.
 *
 * Every adapter maps its platform onto these shapes, and nothing downstream
 * ever sees a vendor's own field names. That is the whole point of the layer:
 * eight vendors disagree about whether "the patient showed up" and "we got paid"
 * are even representable, and without a canonical model that disagreement leaks
 * into the reconciler, the reports, and eventually the customer's inbox.
 *
 * Two rules the shapes enforce:
 *
 *   1. **Money is a string, not a number.** Floating point loses cents, and
 *      cents are the entire product. Parsed at the database boundary into
 *      numeric(12,2).
 *
 *   2. **Unknown is a value, not a null.** `arrival: "unknown"` says the
 *      platform cannot tell us; `arrival: "no_show"` says it can and they
 *      didn't. Collapsing both to null makes an unmeasurable thing look
 *      measured-and-negative, which is how a report ends up quietly wrong.
 */

/** Money in USD, as a decimal string. Never a float. */
export type Money = string;

export type ArrivalState =
  /** Confirmed present — a check-in event, not an inference. */
  | "arrived"
  /** Confirmed absent. */
  | "no_show"
  /** Cancelled before it happened. */
  | "cancelled"
  /** Booked, outcome not yet known. */
  | "scheduled"
  /**
   * The platform genuinely cannot tell us. Acuity has no arrival concept at
   * all. This must survive to the report as "not available", never as zero.
   */
  | "unknown";

export type CanonicalContact = {
  /** The platform's own id. Our join key back to the source system. */
  externalId: string;
  /** ⚠️ PHI. E.164 where the platform gives us something parseable. */
  phone?: string;
  email?: string;
  fullName?: string;
};

export type CanonicalAppointment = {
  externalId: string;
  /** Null when the platform doesn't link appointments to a contact record. */
  contactExternalId?: string;
  scheduledFor: Date;
  arrival: ArrivalState;
  /** When the platform recorded them arriving, where it records that at all. */
  checkedInAt?: Date;
  treatment?: string;
  providerName?: string;
  /** Taken at booking. Crucially NOT evidence of attendance — see reconcile. */
  depositUsd?: Money;
  /** Last modification the platform reports, for delta sync. */
  updatedAt?: Date;
};

export type CanonicalSaleLine = {
  description: string;
  amountUsd: Money;
  quantity?: number;
};

export type CanonicalSale = {
  externalId: string;
  contactExternalId?: string;
  /** Set when the platform ties the sale to a visit. Often it doesn't. */
  appointmentExternalId?: string;
  amountUsd: Money;
  /**
   * When the money was actually taken.
   *
   * Compared against the appointment time to decide whether payment implies
   * attendance. A deposit paid at booking proves nothing about showing up —
   * getting that backwards counts every forfeited deposit as a successful
   * visit, inflating the exact number this product exists to report honestly.
   */
  collectedAt: Date;
  lineItems?: CanonicalSaleLine[];
  updatedAt?: Date;
};

/** A half-open window. Consecutive pages never double-count. */
export type TimeWindow = { from: Date; to: Date };

export type Page<T> = {
  items: T[];
  /** Opaque; hand it back to continue. Absent means the last page. */
  cursor?: string;
  /**
   * What this page could NOT include, in words. Rendered verbatim rather than
   * dropped — a page that silently omits a rate-limited tail looks complete.
   */
  notes?: string[];
};

/** Everything an adapter needs to talk to one clinic's account. */
export type ConnectorContext = {
  clinicId: string;
  connectionId: string;
  credentials: Record<string, string>;
  /** Non-secret identifiers: location id, site id, merchant id. */
  metadata?: Record<string, unknown>;
};

export type VerifiedInfo = {
  /** Platform's own name for the account, for the console. */
  accountLabel?: string;
  /** Earliest data this connection can reach. Null means no known limit. */
  coverageStartedAt?: Date | null;
};
