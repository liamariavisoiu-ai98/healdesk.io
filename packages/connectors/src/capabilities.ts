/**
 * What an adapter can and cannot do — declared, not discovered.
 *
 * This is the load-bearing idea in the whole layer. Vagaro cannot list
 * appointments or supply sales history; Acuity has no arrival concept;
 * GoHighLevel only sees money it processed itself. Those are not edge cases to
 * handle with a try/catch, they are permanent properties of the platform, and
 * they have to reach the customer as a stated caveat rather than a zero.
 *
 * Every capability carries a `note` when it is anything less than full support,
 * and that note is written for the clinic to read — it ends up in the console
 * and on the monthly report. "webhook_only" is a machine value; the note is the
 * sentence that stops someone thinking their revenue fell.
 */

export type Support =
  /** Works, completely, with history. */
  | "full"
  /** Works with a stated limitation. */
  | "partial"
  /** Forward-only: we learn about events as they happen, with no backfill. */
  | "webhook_only"
  /** The platform cannot do this at all. */
  | "unsupported";

export type Capability = {
  support: Support;
  /** Required unless support is "full". Written for a clinic owner to read. */
  note?: string;
};

export type CapabilitySet = {
  /** Can we list appointments over a date range? */
  listAppointments: Capability;
  /** Can we tell whether the patient actually turned up? */
  readArrival: Capability;
  /** Can we read settled sales? */
  listSales: Capability;
  /** Can we read sales from BEFORE the connection was made? */
  backfillSales: Capability;
  /** Can we read free slots for the event type we write into? */
  listSlots: Capability;
  /** Can we write a booking in? Table stakes, not the differentiator. */
  createAppointment: Capability;
  /**
   * Can we find a booking we created, by the key we stamped on it?
   *
   * Declared rather than implied because the write path depends on it. The
   * platforms we write to have no idempotency key, so a create whose reply
   * never arrived is only made safe by reading back before retrying. A
   * platform that cannot be read back by key is one we cannot safely write
   * into, and `canWriteBookings` says so.
   */
  findAppointmentByKey: Capability;
  /** Can we annotate their records with attribution results? Channel B. */
  writeBack: Capability;
};

export const UNSUPPORTED: Capability = { support: "unsupported" };

export function isUsable(capability: Capability): boolean {
  return capability.support !== "unsupported";
}

/**
 * Every limitation on this connection, as sentences.
 *
 * Collected once and passed through to the report, so a clinic is told what we
 * could not measure in the same breath as what we could. The alternative — a
 * number with no caveat — is the failure mode this package exists to prevent.
 */
export function limitationsOf(capabilities: CapabilitySet): string[] {
  const notes: string[] = [];

  for (const capability of Object.values(capabilities)) {
    if (capability.support !== "full" && capability.note) {
      notes.push(capability.note);
    }
  }

  return notes;
}

/**
 * Whether verified revenue is possible at all through this connection alone.
 *
 * False means the clinic needs a payment processor connected too, and the
 * console should say so rather than showing an empty revenue figure.
 */
export function canMeasureRevenue(capabilities: CapabilitySet): boolean {
  return capabilities.listSales.support !== "unsupported";
}

/**
 * Whether the app may write a confirmed appointment through this connection.
 *
 * All three, not just `createAppointment`: without slots we would offer times
 * that do not exist, and without read-back a timeout followed by a retry
 * would book the slot twice. A platform missing either is read-only to us,
 * whatever its API can technically do.
 */
export function canWriteBookings(capabilities: CapabilitySet): boolean {
  return (
    isUsable(capabilities.createAppointment) &&
    isUsable(capabilities.listSlots) &&
    isUsable(capabilities.findAppointmentByKey)
  );
}
