import { AUDIT_BY_MS, BUILD_BUDGET_MS, EXTRACT_BY_MS } from "./budget";

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
 * Within a stage the bar runs on the clock, against the build's own budget
 * (lib/demo/budget.ts, one minute in all): `building` is due to end when the
 * profile must be written, `auditing` when the verdict must be in. Up to its
 * estimate a stage fills evenly; past it, it slows and never fills, because
 * only the server can say a stage is over. The display never shows 100
 * before the demo is ready, and never runs backwards (`BuildProgress` in
 * components/demo keeps the highest value it has shown).
 *
 * The time left is one countdown from the minute the build is held to,
 * whatever the stage, so the seconds only ever fall and a fast site simply
 * opens before they reach zero (owner, 29 October 2026: "a little countdown
 * of seconds left").
 *
 * A build past its route's 300 s never lands; the page stops showing this and
 * hands over to the team once it is stalled (`isDemoBuildStalled`).
 */

export type BuildStage = "building" | "auditing";

/** Reading the site and writing the profile: the stage the row calls `building`. */
export const READ_ESTIMATE_MS = EXTRACT_BY_MS;

/** The handoff audit: the stage the row calls `auditing`. */
export const CHECK_ESTIMATE_MS = AUDIT_BY_MS - EXTRACT_BY_MS;

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
  /** Milliseconds left of the build's minute, 0 once it has run out. */
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
      // One short of where checking starts, however long the reading runs.
      percent: Math.min(BUILDING.to - 1, Math.floor(BUILDING.from + (BUILDING.to - BUILDING.from) * share)),
      step: elapsed < READ_ESTIMATE_MS * READ_SHARE ? "read" : "learn",
      leftMs: countdownMs(elapsed),
    };
  }
  const since = Math.min(auditingSinceMs ?? Math.min(elapsed, READ_ESTIMATE_MS), elapsed);
  const inAudit = elapsed - since;
  const share = stageShare(inAudit, CHECK_ESTIMATE_MS);
  return {
    percent: Math.floor(AUDITING.from + (AUDITING.to - AUDITING.from) * share),
    step: "check",
    leftMs: countdownMs(elapsed),
  };
}

/** What is left of the build's minute after `elapsedMs`. */
export function countdownMs(elapsedMs: number): number {
  return Math.max(0, BUILD_BUDGET_MS - Math.max(0, elapsedMs));
}

/** Whole seconds left, rounded up, so the display reads 60 at the start and 1 in its last second. */
export function secondsLeft(leftMs: number): number {
  return Math.ceil(Math.max(0, leftMs) / 1000);
}

/** The time left in words: the seconds, then "nearly there" once they have run out. */
export function timeLeftText(leftMs: number): string {
  const seconds = secondsLeft(leftMs);
  if (seconds <= 0) return "Nearly there";
  return seconds === 1 ? "1 second left" : `${seconds} seconds left`;
}
