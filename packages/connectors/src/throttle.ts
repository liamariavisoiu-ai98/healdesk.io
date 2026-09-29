/**
 * Rate budgets.
 *
 * These limits shape the architecture, not just the retry logic. Zenoti allows
 * 60 requests a minute; PatientNow allows 1,000 a DAY. A naive nightly
 * full-poll blows through the second one on a single mid-sized clinic, which is
 * why sync is delta-based and webhook-first.
 *
 * The interactive reserve is the part people leave out. Without it, a
 * month-end backfill consumes the whole daily budget and an operator clicking
 * "test connection" gets a rate-limit error — so the tool appears broken at
 * exactly the moment someone is checking whether it works.
 */

export type RateBudget = {
  /** Requests per minute, or null when the platform has no minute limit. */
  perMinute: number | null;
  /** Requests per day, or null. */
  perDay: number | null;
  /**
   * Share of the daily budget held back for operator-triggered work.
   * Background jobs cannot touch it.
   */
  interactiveReserve: number;
};

export const BUDGETS: Record<string, RateBudget> = {
  // 60/min, token bucket. Higher is a paid add-on via their account manager.
  zenoti: { perMinute: 60, perDay: null, interactiveReserve: 0 },
  // 1,000/DAY. The tightest on the board — delta sync is mandatory, not an
  // optimisation, and a backfill has to be spread over days.
  patientnow: { perMinute: null, perDay: 1_000, interactiveReserve: 50 },
  vagaro: { perMinute: 200, perDay: null, interactiveReserve: 0 },
  gohighlevel: { perMinute: 600, perDay: 200_000, interactiveReserve: 500 },
  // Documented but the numbers are JS-rendered and unread. Assume tight.
  boulevard: { perMinute: 60, perDay: null, interactiveReserve: 0 },
  acuity: { perMinute: 600, perDay: null, interactiveReserve: 0 },
  fixture: { perMinute: null, perDay: null, interactiveReserve: 0 },
  // Cal.com publishes a per-key limit the adapter has not verified; 60/min is
  // the package default and comfortably below anything a clinic's calendar
  // needs. Raise it only from the vendor's current docs.
  calcom: { perMinute: 60, perDay: null, interactiveReserve: 0 },
};

export function budgetFor(platformId: string): RateBudget {
  return (
    BUDGETS[platformId] ?? {
      perMinute: 60,
      perDay: null,
      interactiveReserve: 0,
    }
  );
}

/**
 * A token bucket with an optional daily cap.
 *
 * In-memory, which is correct for a single worker process and wrong across
 * several — the effective limit becomes (limit × workers). Acceptable while
 * there is one worker; move the counters to Postgres before scaling out, or a
 * clinic's daily budget gets spent twice over and the sync starts failing at
 * 3am for reasons nobody can reproduce.
 */
export class Throttle {
  #tokens: number;
  #lastRefill: number;
  #dayCount = 0;
  #dayStart: number;

  constructor(
    private readonly budget: RateBudget,
    private readonly now: () => number = Date.now,
  ) {
    this.#tokens = budget.perMinute ?? Number.POSITIVE_INFINITY;
    this.#lastRefill = now();
    this.#dayStart = now();
  }

  /**
   * Wait until a request is allowed, or refuse if the daily budget is gone.
   *
   * `interactive` requests may use the reserve; background work may not.
   */
  async take(
    options: { interactive?: boolean } = {},
  ): Promise<{ allowed: true } | { allowed: false; reason: string }> {
    const now = this.now();

    // Roll the day.
    if (now - this.#dayStart >= 86_400_000) {
      this.#dayStart = now;
      this.#dayCount = 0;
    }

    if (this.budget.perDay !== null) {
      const ceiling = options.interactive
        ? this.budget.perDay
        : this.budget.perDay - this.budget.interactiveReserve;

      if (this.#dayCount >= ceiling) {
        return {
          allowed: false,
          reason: options.interactive
            ? `Daily budget of ${this.budget.perDay} requests is exhausted.`
            : `Background daily budget exhausted (${ceiling} of ${this.budget.perDay}; ${this.budget.interactiveReserve} held back for operator use).`,
        };
      }
    }

    if (this.budget.perMinute !== null) {
      this.#refill(now);
      if (this.#tokens < 1) {
        // Wait for one token rather than failing — a minute limit is a pacing
        // problem, unlike a daily budget which is a real ceiling.
        const waitMs = Math.ceil(60_000 / this.budget.perMinute);
        await new Promise((resolve) => setTimeout(resolve, waitMs));
        this.#refill(this.now());
      }
      this.#tokens -= 1;
    }

    this.#dayCount += 1;
    return { allowed: true };
  }

  get requestsToday(): number {
    return this.#dayCount;
  }

  #refill(now: number): void {
    if (this.budget.perMinute === null) return;
    const elapsed = now - this.#lastRefill;
    const refilled = (elapsed / 60_000) * this.budget.perMinute;
    if (refilled > 0) {
      this.#tokens = Math.min(this.budget.perMinute, this.#tokens + refilled);
      this.#lastRefill = now;
    }
  }
}
