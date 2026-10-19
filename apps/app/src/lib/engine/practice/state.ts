import type { PracticeRunStatus, PracticeSection } from "./types";

/**
 * Where a clinic's practice questions stand, as the tracker, Home's "Needs
 * attention", O8 and the go-live gate read it (lib/engine/practice/store.ts
 * reads it from the database). Pure: no imports beyond the vocabulary, so
 * the setup and portal modules can take it without the engine.
 */
export type PracticeState = {
  /** A run is queued or running: something changed and has not been checked yet. */
  pending: boolean;
  /**
   * The latest run of the questions whose outcome stands (passed, failed, in
   * review, error), or null before the first. Never an operator's override:
   * a pass is a run's cases, the questions' own or a review's.
   */
  latest: {
    id: string;
    status: Extract<PracticeRunStatus, "passed" | "failed" | "in_review" | "error">;
    finishedAt: Date | null;
    /** A failure on the clinic's own data: the section O9 named, and how many things in it. */
    failedSection: PracticeSection | null;
    failedCount: number | null;
    /** The section whose change asked for the run, when one did. */
    triggerSection: PracticeSection | null;
    /** The review's promised day (YYYY-MM-DD, New York), while one is open. */
    reviewDueOn: string | null;
  } | null;
};

/** Before the first run is asked for. */
export const NO_PRACTICE_STATE: PracticeState = { pending: false, latest: null };

/** Whether the latest outcome is a pass with nothing changed since. */
export function practicePassed(state: PracticeState): boolean {
  return !state.pending && state.latest?.status === "passed";
}

/** Whether the latest outcome is a failure or a review: what Home's "double-checking" line is about. */
export function practiceDoubleChecking(state: PracticeState): boolean {
  return state.latest?.status === "failed" || state.latest?.status === "in_review";
}
