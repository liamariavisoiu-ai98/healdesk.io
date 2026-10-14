/**
 * How much the support chat may be used (plan Part H, "Limits: per clinic and
 * per device"): messages an hour and a day for each device, messages a day
 * for each clinic, and escalations a day for both. Past any of them the chat
 * gives a fixed line with the support phone and hello@ (chat.ts), so a person
 * is always reachable.
 *
 * The device is the browser's sign-in session (the SHA-256 of its token,
 * which is how step-ups name it too): one shared sign-in per clinic in v1, so
 * the session is the only thing that tells one front-desk computer from
 * another. The clinic's own limit is what bounds a sign-in that keeps opening
 * fresh sessions.
 *
 * In memory, on purpose. The chat stores nothing (spec, "stores nothing: the
 * browser holds the conversation"), and a counter table would be state kept
 * about who asked support what and when. The effective ceiling is therefore
 * the limit times the number of web tasks: one on the lean profile. Both
 * counters are always checked before either is taken, so tripping one never
 * spends the other.
 */

export const SUPPORT_LIMITS = {
  device: { perHour: 30, perDay: 100, escalationsPerDay: 2 },
  clinic: { perDay: 250, escalationsPerDay: 4 },
} as const;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
/** The most keys kept before the oldest are dropped: a bound on memory, not a limit. */
const MAX_KEYS = 20_000;

export type SupportUse = "message" | "escalation";

export class SupportLimiter {
  private readonly hits = new Map<string, number[]>();

  /**
   * Whether one more use is allowed for this clinic and device; if it is, it
   * is counted. Returns false, counting nothing, once any limit is reached.
   */
  take(use: SupportUse, clinicId: string, deviceKey: string, now: number = Date.now()): boolean {
    const checks: { key: string; windowMs: number; limit: number }[] =
      use === "message"
        ? [
            { key: `m:h:d:${deviceKey}`, windowMs: HOUR_MS, limit: SUPPORT_LIMITS.device.perHour },
            { key: `m:d:d:${deviceKey}`, windowMs: DAY_MS, limit: SUPPORT_LIMITS.device.perDay },
            { key: `m:d:c:${clinicId}`, windowMs: DAY_MS, limit: SUPPORT_LIMITS.clinic.perDay },
          ]
        : [
            {
              key: `e:d:d:${deviceKey}`,
              windowMs: DAY_MS,
              limit: SUPPORT_LIMITS.device.escalationsPerDay,
            },
            {
              key: `e:d:c:${clinicId}`,
              windowMs: DAY_MS,
              limit: SUPPORT_LIMITS.clinic.escalationsPerDay,
            },
          ];
    const windows = checks.map((c) => ({ ...c, times: this.recent(c.key, c.windowMs, now) }));
    if (windows.some((w) => w.times.length >= w.limit)) return false;
    for (const w of windows) {
      w.times.push(now);
      this.hits.delete(w.key);
      this.hits.set(w.key, w.times);
    }
    this.trim();
    return true;
  }

  private recent(key: string, windowMs: number, now: number): number[] {
    return (this.hits.get(key) ?? []).filter((t) => now - t < windowMs);
  }

  private trim(): void {
    while (this.hits.size > MAX_KEYS) {
      const oldest = this.hits.keys().next().value;
      if (oldest === undefined) break;
      this.hits.delete(oldest);
    }
  }
}

/** This process's limiter. */
export const supportLimiter = new SupportLimiter();
