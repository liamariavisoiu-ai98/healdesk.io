/**
 * Turning activity into a revenue figure — and being explicit about which kind
 * of figure it is.
 *
 * Two modes:
 *
 *   estimated — bookings × the clinic's own average treatment value. No
 *               integration required, which is why it is the default and why
 *               most customers will only ever see this.
 *   verified  — settled sales read from the clinic's own systems.
 *
 * The rule this file exists to enforce: **an estimate must never be presented
 * as a measurement.** Every result carries the mode, a plain-English `basis`
 * describing exactly how the number was derived, and a list of `caveats` for
 * anything we could not measure.
 *
 * That last part matters most. The house rule from packages/leadgen — a cap, a
 * gap, or an unsupported capability must never render as a number — applies
 * with more force here, because this number is what the clinic decides whether
 * to keep paying us on. When we can't compute revenue, `revenueUsd` is null,
 * not zero. Zero is a claim; null is an admission.
 */

export type AttributionMode = "estimated" | "verified";

/** Plain counts, so this is trivially testable without a database. */
export type ActivityCounts = {
  /** Conversations the agent handled in the period, any channel. */
  conversationsHandled: number;
  /**
   * Conversations that would otherwise have been missed — after-hours,
   * simultaneous calls, or an automatic callback of a number that rang out.
   * This is the subset we can honestly claim credit for.
   */
  conversationsRecovered: number;
  /** Recovered conversations that produced a booking. */
  recoveredBookings: number;
  /**
   * The subset of those the clinic's own booking system has confirmed back.
   *
   * Set only by a sync reading the appointment out of their software, never by
   * the agent that created it. The difference is reported as a caveat and never
   * subtracted: a booking we made that has not synced yet is still real, but a
   * clinic is entitled to know how much of the figure it wrote itself.
   */
  recoveredBookingsConfirmed: number;
  /** All bookings from agent conversations, recovered or not. */
  totalBookings: number;
};

export type EstimatedInput = {
  mode: "estimated";
  activity: ActivityCounts;
  /** The clinic's own figure, captured at checkout. Null if never provided. */
  averageTreatmentValueUsd: number | null;
};

export type VerifiedInput = {
  mode: "verified";
  activity: ActivityCounts;
  /**
   * Settled revenue matched to recovered bookings, in USD.
   *
   * Null when no source could supply sales at all — a clinic that chose
   * verified but whose connection is broken, revoked, or on a platform that
   * cannot report money. Zero would say "the agent earned you nothing", which
   * is a claim; null says "we couldn't measure it", which is the truth.
   */
  matchedRevenueUsd: number | null;
  /** Why revenue is unmeasurable, when matchedRevenueUsd is null. */
  unmeasurableReason?: string;
  /** Sales we could not tie to an appointment. Surfaced, never absorbed. */
  unmatchedTransactionCount: number;
  unmatchedRevenueUsd: number;
  /** Which systems the money came from, for the basis line. */
  sources: readonly string[];
  /** Set when the source cannot provide history before a given date. */
  coverageStartedAt?: Date | null;
};

export type AttributionInput = EstimatedInput | VerifiedInput;

export type AttributionResult = {
  mode: AttributionMode;
  conversationsHandled: number;
  conversationsRecovered: number;
  recoveredBookings: number;
  /**
   * Null when it genuinely cannot be computed. Callers must render null as
   * "not available" and never coerce it to 0.
   */
  revenueUsd: number | null;
  /** Exactly how revenueUsd was derived, in words the clinic owner can check. */
  basis: string;
  /** What we could not measure. Rendered verbatim; never silently dropped. */
  caveats: string[];
};

const usd = (value: number): string =>
  value.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  });

/**
 * How much of the booking count did we author?
 *
 * report.ts joins bookings to appointments so that a booking is a row and not a
 * label the agent set on its way out of the call. The agent now writes those
 * rows itself, so that join no longer proves it — `external_confirmed_at`,
 * which only a sync sets, is what separates the two. The gap is disclosed and
 * never deducted: a booking we made that has not synced yet is still real.
 *
 * Shared by BOTH modes deliberately. It lived only in `estimated()` at first,
 * which meant the mode presenting dollars as measured was the one that stayed
 * quiet about authorship — the exact inversion this file's own rules forbid.
 */
function provenanceCaveat(activity: ActivityCounts): string | null {
  const unconfirmed = Math.max(
    0,
    activity.recoveredBookings - activity.recoveredBookingsConfirmed,
  );
  if (activity.recoveredBookings === 0 || unconfirmed === 0) return null;

  return unconfirmed === activity.recoveredBookings
    ? `All ${activity.recoveredBookings} ${plural(activity.recoveredBookings, "booking")} here were recorded by our agent and have not been read back from your booking system.`
    : `${unconfirmed} of ${activity.recoveredBookings} bookings were recorded by our agent and have not yet been read back from your booking system.`;
}

export function computeAttribution(
  input: AttributionInput,
): AttributionResult {
  return input.mode === "estimated" ? estimated(input) : verified(input);
}

function estimated(input: EstimatedInput): AttributionResult {
  const { activity, averageTreatmentValueUsd: value } = input;
  const caveats: string[] = [];

  const base = {
    mode: "estimated" as const,
    conversationsHandled: activity.conversationsHandled,
    conversationsRecovered: activity.conversationsRecovered,
    recoveredBookings: activity.recoveredBookings,
  };

  // No average value means no revenue figure. Reporting $0 would read as "we
  // earned you nothing", which is a different and false claim.
  if (value === null || !Number.isFinite(value) || value <= 0) {
    return {
      ...base,
      revenueUsd: null,
      basis:
        "We don't have an average appointment value for this clinic, so we can't estimate revenue yet.",
      caveats: [
        "Add your average appointment value and we'll estimate recovered revenue from next month.",
      ],
    };
  }

  const revenueUsd = round2(activity.recoveredBookings * value);

  if (activity.recoveredBookings === 0) {
    caveats.push(
      "No recovered bookings this period, so there is nothing to attribute.",
    );
  }

  // Whose evidence is this? Say it before the clinic has to ask.
  const provenance = provenanceCaveat(activity);
  if (provenance) caveats.push(provenance);

  // Say the quiet part out loud, every time.
  caveats.push(
    `Estimated from your own average appointment value of ${usd(value)}, not read from a point-of-sale. Connect your booking system to replace these with measured figures.`,
  );

  return {
    ...base,
    revenueUsd,
    basis: `${activity.recoveredBookings} recovered ${plural(activity.recoveredBookings, "booking")} × ${usd(value)} average = ${usd(revenueUsd)}`,
    caveats,
  };
}

function verified(input: VerifiedInput): AttributionResult {
  const { activity } = input;
  const caveats: string[] = [];

  // Same disclosure as the estimated mode, and it matters MORE here: this is
  // the mode that presents a figure as measured, so a clinic reading it is
  // entitled to know how much of the booking count came from our own record
  // rather than from theirs.
  const provenance = provenanceCaveat(activity);
  if (provenance) caveats.push(provenance);

  const base = {
    mode: "verified" as const,
    conversationsHandled: activity.conversationsHandled,
    conversationsRecovered: activity.conversationsRecovered,
    recoveredBookings: activity.recoveredBookings,
  };

  // Null, not zero. See the note on matchedRevenueUsd.
  if (input.matchedRevenueUsd === null) {
    return {
      ...base,
      revenueUsd: null,
      basis:
        input.unmeasurableReason ??
        "None of your connected systems could report sales for this period, so we can't show verified revenue.",
      caveats: [
        "Your bookings figures above are measured; only the revenue line is unavailable.",
      ],
    };
  }

  if (input.unmatchedTransactionCount > 0) {
    // Money we saw but could not attribute. It belongs in front of the clinic,
    // not quietly excluded from a total that then looks smaller than reality.
    caveats.push(
      `${input.unmatchedTransactionCount} ${plural(input.unmatchedTransactionCount, "sale")} totalling ${usd(input.unmatchedRevenueUsd)} could not be matched to an appointment and are not included above.`,
    );
  }

  if (input.coverageStartedAt) {
    // Long-form, not ISO — deliberately.
    //
    // `2026-01-15` matches the date pattern the email PHI guard treats as a
    // possible date of birth, so an ISO date here made the guard refuse to send
    // the very report this caveat belongs on. The caveat is honest and the
    // guard is right; the format was the bug.
    caveats.push(
      `Revenue is available from ${longDate(input.coverageStartedAt)} onward; this source cannot provide earlier history.`,
    );
  }

  const sources = input.sources.length
    ? input.sources.join(" and ")
    : "your connected systems";

  return {
    ...base,
    revenueUsd: round2(input.matchedRevenueUsd),
    basis: `${usd(input.matchedRevenueUsd)} collected against ${activity.recoveredBookings} recovered ${plural(activity.recoveredBookings, "booking")}, read from ${sources}`,
    caveats,
  };
}

/**
 * Period-over-period change.
 *
 * Returns null rather than a percentage when the previous period had no
 * revenue: "up 100%" from zero is arithmetically true and communicates nothing.
 */
export function trend(
  current: number | null,
  previous: number | null,
): { deltaUsd: number; percent: number | null } | null {
  if (current === null || previous === null) return null;

  const deltaUsd = round2(current - previous);
  const percent =
    previous > 0 ? Math.round(((current - previous) / previous) * 100) : null;

  return { deltaUsd, percent };
}

/** "15 January 2026". Never ISO — see the note in verified(). */
function longDate(date: Date): string {
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function plural(count: number, word: string): string {
  return count === 1 ? word : `${word}s`;
}
