/**
 * How far a personalised demo's build has got, as a percentage and a time
 * left, for the people waiting on it: the demo's own holding screen
 * (app/demo/[slug]) and the homepage's "See it in your own branding" window
 * after "Send it to me" (components/OwnBranding.tsx). The owner asked on
 * 13 October 2026 for the wait to say how long it will be, with a percentage,
 * in place of a spinner and "a minute or two".
 *
 * ## What is known, and what is estimated
 *
 * The row knows two things about a build in progress: when it started
 * (`buildStartedAt`), and which of its two stages it is in. `building` covers
 * reading the website (a plain fetch, then the rendering crawl, with the Google
 * listing looked up beside them) and turning it into a profile; `auditing` is
 * the handoff audit, ten test questions and a graded read (lib/demo/build.ts).
 * The stage is the server's word, so the bar never shows checking before the
 * row says so, and jumps forward when it does.
 *
 * Within a stage the bar runs on the clock, against the estimates below. No
 * real build has been timed yet (the crawl alone may take three minutes, and
 * the audit's repair round adds about two more), so they are worked from the
 * pipeline's own budgets: change them here once builds have been timed. Up
 * to its estimate a stage fills evenly, so the percentage and the time left
 * agree; past it, it slows and never fills, because only the server can say a
 * stage is over. The display never shows 100 before the demo is ready, and
 * never runs backwards (`BuildProgress` in components/demo keeps the
 * highest value it has shown).
 *
 * A build past its route's 300 s never lands; the page stops showing this and
 * hands over to the team once it is stalled (`isDemoBuildStalled`).
 */

export type BuildStage = "building" | "auditing";

/** Reading the site and writing the profile: the stage the row calls `building`. */
export const READ_ESTIMATE_MS = 100_000;

/** The handoff audit: the stage the row calls `auditing`. */
export const CHECK_ESTIMATE_MS = 80_000;

/** Within `building`, the share of the estimate spent reading before the profile is written. */
const READ_SHARE = 0.6;

/** Where each stage starts and stops on the bar. Checking never reaches 100: only the demo itself is 100. */
const BUILDING = { from: 2, to: 58 } as const;
const AUDITING = { from: 58, to: 97 } as const;

/** Of a stage's span, how much its estimate fills; the rest is the slow tail past it. */
const ON_TIME = 0.85;
/** How slowly the tail closes in, in multiples of the stage's estimate. */
const TAIL = 0.6;

export type BuildStep = "read" | "learn" | "check";

export type BuildEstimate = {
  /** Whole percent, 2 to 97. */
  percent: number;
  /** The step to show as under way. Reading and learning are split on the clock; checking is the server's word. */
  step: BuildStep;
  /** Estimated milliseconds left, 0 once past the estimate. */
  leftMs: number;
};

/** How much of a stage is done, 0 to under 1: even up to its estimate, then closing slowly on 1. */
function stageShare(elapsedMs: number, estimateMs: number): number {
  const x = Math.max(0, elapsedMs) / estimateMs;
  if (x <= 1) return ON_TIME * x;
  return 1 - (1 - ON_TIME) * Math.exp(-(x - 1) / TAIL);
}

/**
 * The estimate at `elapsedMs` since the build started. `auditingSinceMs` is
 * when the audit was first seen, in the same clock, if the watcher saw it
 * begin; a page opened mid-audit assumes it began when reading was due to
 * end, or now if that is still to come.
 */
export function estimateBuild(stage: BuildStage, elapsedMs: number, auditingSinceMs?: number | null): BuildEstimate {
  const elapsed = Math.max(0, elapsedMs);
  if (stage === "building") {
    const share = stageShare(elapsed, READ_ESTIMATE_MS);
    return {
      percent: Math.floor(BUILDING.from + (BUILDING.to - BUILDING.from) * share),
      step: elapsed < READ_ESTIMATE_MS * READ_SHARE ? "read" : "learn",
      leftMs: Math.max(0, READ_ESTIMATE_MS - elapsed) + CHECK_ESTIMATE_MS,
    };
  }
  const since = Math.min(auditingSinceMs ?? Math.min(elapsed, READ_ESTIMATE_MS), elapsed);
  const inAudit = elapsed - since;
  const share = stageShare(inAudit, CHECK_ESTIMATE_MS);
  return {
    percent: Math.floor(AUDITING.from + (AUDITING.to - AUDITING.from) * share),
    step: "check",
    leftMs: Math.max(0, CHECK_ESTIMATE_MS - inAudit),
  };
}

/** The time left in words: minutes while there are some, then "less than a minute", then "nearly there". */
export function timeLeftText(leftMs: number): string {
  if (leftMs <= 0) return "Nearly there";
  if (leftMs <= 45_000) return "Less than a minute left";
  if (leftMs <= 90_000) return "About a minute left";
  return `About ${Math.round(leftMs / 60_000)} minutes left`;
}
