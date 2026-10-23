import { isDemoActive, isDemoBuildStalled, isDemoExpired, SELF_SERVE_DEMO, type DemoSession } from "./sessions";

/**
 * The demo pipeline in numbers: what was asked for, what got built, what
 * sold, over the last 7 and 30 days, from the `demo_sessions` rows the
 * console already lists (lib/demo/sessions.ts). Pure: the rows go in, the
 * counts come out, and the row at the top of /admin/demos
 * (components/admin/DemoPipelineRow.tsx) prints them in plain words.
 *
 * ## Why 30 days is the longest window
 *
 * An unclaimed row is deleted 30 days after its link expired, and a link
 * lives seven days (`purgeExpiredDemoSessions`, DEMO_RETENTION_AFTER_EXPIRY_DAYS),
 * so every row created in the last 37 days is still there. A window longer
 * than that would count the claimed rows, which are kept, against a
 * denominator the purge has eaten, and print a conversion that flatters.
 *
 * ## What the words mean
 *
 * A window holds the rows *created* in it. "Requested" is all of them;
 * "built" is the ones whose audit passed them or an operator released them,
 * so the link opened at some point (`readyAt`); "claimed" is the ones that
 * paid (the Stripe webhook's `markDemoClaimed`); "expired unclaimed" is a
 * built link whose week ran out with no sale. The states a row is in *now*,
 * live, held, failed and stalled, are counted over every row read, not only
 * the window's: a two-month-old demo an operator rebuilt yesterday is as
 * stalled as a new one, and the sweep retries it all the same.
 *
 * "Claimed per built" is the conversion, by where the request came from:
 * the console (an operator's address in `created_by`), the outreach webhook
 * (`"webhook"`, api/demo-sessions, an Instantly reply rule) or the homepage
 * (`"homepage"`, api/own-demo). The share is left out, never shown as 0%,
 * when nothing was built to convert from.
 */

export type DemoSource = "operator" | "outreach" | "homepage";

export const DEMO_SOURCES: readonly DemoSource[] = ["operator", "outreach", "homepage"];

/** `createdBy` on a demo the outreach webhook asked for (api/demo-sessions). */
const OUTREACH_DEMO = "webhook";

/**
 * Where a demo came from. Anything that is not the homepage or the webhook
 * is an operator's doing (their console address, or nothing at all on a row
 * a script wrote), as lib/demo/sessions.ts reads `createdBy`.
 */
export function demoSource(session: Pick<DemoSession, "createdBy">): DemoSource {
  if (session.createdBy === SELF_SERVE_DEMO) return "homepage";
  if (session.createdBy === OUTREACH_DEMO) return "outreach";
  return "operator";
}

/** The build finished and the link opened at some point: the audit passed it, or an operator released it. */
export function wasBuilt(session: Pick<DemoSession, "readyAt" | "status" | "claimed">): boolean {
  return session.readyAt !== null || session.status === "ready" || session.claimed;
}

export type PipelineCounts = {
  requested: number;
  built: number;
  live: number;
  held: number;
  failed: number;
  stalled: number;
  expired: number;
  claimed: number;
};

export type SourceConversion = { source: DemoSource; built: number; claimed: number };

export type PipelineWindow = PipelineCounts & {
  days: number;
  bySource: readonly SourceConversion[];
};

export type DemoPipeline = {
  /** The 7-day window, then the 30-day one. */
  windows: readonly PipelineWindow[];
  /** The states over every row read, not only a window's. */
  now: Pick<PipelineCounts, "live" | "held" | "failed" | "stalled">;
  /** How many rows went in. */
  rows: number;
  /**
   * The read hit its cap with rows still inside the longest window, so the
   * 30-day numbers are a floor, not a total. The row says so when it is set.
   */
  truncated: boolean;
};

export const PIPELINE_WINDOW_DAYS: readonly number[] = [7, 30];

/** How many rows the console reads for the pipeline: newest first, plenty for a month of demos. */
export const PIPELINE_ROWS = 500;

const DAY_MS = 24 * 60 * 60 * 1000;

export function countDemos(sessions: readonly DemoSession[], now: number = Date.now()): PipelineCounts {
  const counts: PipelineCounts = { requested: 0, built: 0, live: 0, held: 0, failed: 0, stalled: 0, expired: 0, claimed: 0 };
  for (const s of sessions) {
    counts.requested += 1;
    if (wasBuilt(s)) counts.built += 1;
    if (isDemoActive(s, now)) counts.live += 1;
    if (s.status === "held") counts.held += 1;
    if (s.status === "failed") counts.failed += 1;
    if (isDemoBuildStalled(s, now)) counts.stalled += 1;
    if (s.claimed) counts.claimed += 1;
    else if (s.status === "ready" && isDemoExpired(s, now)) counts.expired += 1;
  }
  return counts;
}

export function conversionBySource(sessions: readonly DemoSession[]): SourceConversion[] {
  return DEMO_SOURCES.map((source) => {
    const own = sessions.filter((s) => demoSource(s) === source);
    return { source, built: own.filter(wasBuilt).length, claimed: own.filter((s) => s.claimed).length };
  });
}

/** Claimed as a share of built, or null when nothing was built to convert from. */
export function claimedShare(counts: Pick<PipelineCounts, "built" | "claimed">): number | null {
  return counts.built > 0 ? counts.claimed / counts.built : null;
}

export function demoPipeline(
  sessions: readonly DemoSession[],
  now: number = Date.now(),
  readLimit: number = PIPELINE_ROWS,
): DemoPipeline {
  const longest = Math.max(...PIPELINE_WINDOW_DAYS);
  const windows = PIPELINE_WINDOW_DAYS.map((days) => {
    const since = now - days * DAY_MS;
    const inWindow = sessions.filter((s) => s.createdAt.getTime() >= since && s.createdAt.getTime() <= now);
    return { days, ...countDemos(inWindow, now), bySource: conversionBySource(inWindow) };
  });
  const all = countDemos(sessions, now);
  const oldest = sessions.reduce((min, s) => Math.min(min, s.createdAt.getTime()), Number.POSITIVE_INFINITY);
  return {
    windows,
    now: { live: all.live, held: all.held, failed: all.failed, stalled: all.stalled },
    rows: sessions.length,
    truncated: sessions.length >= readLimit && oldest >= now - longest * DAY_MS,
  };
}
