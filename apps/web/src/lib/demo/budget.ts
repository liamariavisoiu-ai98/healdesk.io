/**
 * How long a personalised demo's build may take, start to finish: one minute
 * (owner, 29 October 2026: "make sure the bot building is never more than
 * 1min").
 *
 * The build (lib/demo/build.ts) runs four steps one after another, and each
 * gets a point on the clock it must be done by, measured from the build's
 * start. A step that runs out of time carries on with what it has: the
 * crawlers hand back the pages and the listing they had read by then
 * (lib/demo/apify.ts), and the model calls are cut off by an abort signal at
 * their deadline. The audit is the one step that cannot carry on with half a
 * verdict, so one that runs out of time holds the demo for a person
 * (`AuditUnavailableError`), as it always has: never shipped unaudited.
 *
 *   0 s  read the website until READ_BY_MS
 *        extract the profile (two model calls side by side) until EXTRACT_BY_MS;
 *        the Google listing is looked up beside both, until just before then
 *        audit it (the test questions, then the grade) until AUDIT_BY_MS
 *  60 s  the verdict is written and the page opens
 *
 * The waiting screens count down to BUILD_BUDGET_MS (lib/demo/build-progress.ts),
 * so what the visitor is told is what the build is held to.
 */

export const BUILD_BUDGET_MS = 60_000;

/** Reading stops here: whatever the crawlers have by now is what the demo is built from. */
export const READ_BY_MS = 24_000;

/** The profile must be written by here. */
export const EXTRACT_BY_MS = 40_000;

/** The audit's verdict must be in by here, leaving the last seconds for the row write. */
export const AUDIT_BY_MS = 57_000;

/**
 * The audit's repair round (a second extraction and a second audit) runs only
 * when at least this much of the budget is left after the first audit. Inside
 * one minute that is rare; the deterministic clean-up before the audit
 * (lib/demo/ground.ts) does most of what the repair round used to.
 */
export const REPAIR_NEEDS_MS = 28_000;

/** Milliseconds left before `deadline`, never below zero, never above `cap`. */
export function timeLeft(deadline: number, cap: number = Number.POSITIVE_INFINITY): number {
  return Math.max(0, Math.min(cap, deadline - Date.now()));
}
