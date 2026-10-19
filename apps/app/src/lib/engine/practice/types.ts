/**
 * The practice questions' vocabulary (plan Part G; spec, "The pre-launch
 * audit"): the cases, what each can come to, what a run and a review can be,
 * and the shape of a case's result as the results table stores it.
 *
 * Pure data and types with no imports: db/schema.ts reads it, and drizzle-kit
 * loads db/schema.ts outside the app.
 *
 * Nothing here is about a patient. Every case is synthetic, templated from the
 * clinic's own profile, and what is kept of a run is the synthetic person's
 * words, AYA's answers to them and what the checks made of them.
 */

/**
 * The spec's nine cases, plus the disclosure line every channel opens with,
 * which the plan's deterministic checks include. In the order they run.
 */
export const PRACTICE_CASE_IDS = [
  "disclosure",
  "listed_price",
  "off_menu_price",
  "booking",
  "deposit_booking",
  "clinical",
  "complication",
  "hostile",
  "unknown",
  "language",
] as const;
export type PracticeCaseId = (typeof PRACTICE_CASE_IDS)[number];

/**
 * What one case came to:
 *   - passed: every check held (and the judge, where it reads the case, passed it);
 *   - failed: a deterministic check failed;
 *   - review: only the judge failed it, or could not say: a person decides;
 *   - not_applicable: the case cannot be checked against this runtime (the
 *     booking cases, until the brain has tools), or does not apply to the
 *     clinic (a second language it does not serve); never counted as a pass.
 *     One the clinic does not need is simply not asked. One the runtime
 *     cannot ask is a case the spec's "Pass means every case" still needs:
 *     while any is, Gate B names the practice questions as not built
 *     (lib/compliance/gate-b.ts, casesNotAskable) and no clinic goes live on
 *     them, whatever its run passed;
 *   - error: the model or the judge could not be reached, so nothing was learnt.
 */
export const PRACTICE_CASE_STATUSES = [
  "passed",
  "failed",
  "review",
  "not_applicable",
  "error",
] as const;
export type PracticeCaseStatus = (typeof PRACTICE_CASE_STATUSES)[number];

/** Why a case was not checked. */
export const PRACTICE_NOT_APPLICABLE = [
  /** The booking and deposit cases: the brain has no tools yet, so it holds and writes nothing to check. */
  "runtime_has_no_tools",
  /** The language case: the clinic answers in English only. */
  "serves_english_only",
  /** The language case on Instagram, Messenger and WhatsApp: the front door answers in English only. */
  "channel_english_only",
] as const;
export type PracticeNotApplicable = (typeof PRACTICE_NOT_APPLICABLE)[number];

/**
 * Where a failure that is the clinic's own data can be fixed: a Knowledge
 * section, or the two Settings cards a case reads (the greeting, and the
 * urgent-help or emergency referral number). O9 names the section and a
 * count, never the service.
 */
export const PRACTICE_SECTIONS = [
  "practice",
  "prices",
  "policies",
  "promotions",
  "quick_answers",
  "never_say",
  "hours",
  "how_aya_talks",
  "safety_net",
] as const;
export type PracticeSection = (typeof PRACTICE_SECTIONS)[number];

/** Who a failure belongs to: the clinic, which can fix its own data, or us. */
export type PracticeAttribution =
  { kind: "clinic_data"; section: PracticeSection; count: number } | { kind: "engine" };

export type PracticeCheck = { name: string; ok: boolean; detail?: string };

export type PracticeJudgeVerdict = { verdict: "pass" | "fail" | "unavailable"; reason: string };

/** One case's result, as practice_question_results.cases stores it. Synthetic, so no PHI. */
export type PracticeCaseResult = {
  id: PracticeCaseId;
  status: PracticeCaseStatus;
  /** The synthetic person's words, turn by turn. */
  asked: string[];
  /** What AYA answered, turn by turn, as the channel would have sent it. */
  answered: string[];
  /** Who wrote each answer: the model, the urgent line, the guard's line, a refusal, a failure. */
  sources: string[];
  checks: PracticeCheck[];
  judge?: PracticeJudgeVerdict;
  notApplicable?: PracticeNotApplicable;
  attribution?: PracticeAttribution;
};

/**
 * A run:
 *   - queued: asked for, and waiting for two minutes without another change;
 *   - running: claimed by the job, under a lease;
 *   - not_ready: the clinic's answers are not set up yet, so nothing was asked;
 *   - passed: every channel passed; the agent script is approved by it;
 *   - failed: a case failed on the clinic's own data (O9 tells it what to fix);
 *   - in_review: a judge failed a case, or a check failed on our side: a
 *     person at healdesk decides, by the next business day;
 *   - error: the model could not be reached; tried again later;
 *   - superseded: what it read changed while it ran, so its answer is about
 *     a version that no longer exists.
 */
export const PRACTICE_RUN_STATUSES = [
  "queued",
  "running",
  "not_ready",
  "passed",
  "failed",
  "in_review",
  "error",
  "superseded",
] as const;
export type PracticeRunStatus = (typeof PRACTICE_RUN_STATUSES)[number];

/** The runs whose outcome stands for the clinic: the tracker and the gate read the latest of these. */
export const PRACTICE_COMPLETED_STATUSES = [
  "passed",
  "failed",
  "in_review",
  "error",
] as const satisfies readonly PracticeRunStatus[];

/**
 * What asked for a run: a Knowledge save, a Settings save, a setup screen,
 * an operator, the hourly sweep (inputs changed and nothing asked), or an
 * operator's approval recorded as an override.
 */
export const PRACTICE_RUN_REASONS = [
  "knowledge",
  "settings",
  "wizard",
  "ops",
  "sweep",
  "override",
] as const;
export type PracticeRunReason = (typeof PRACTICE_RUN_REASONS)[number];

/** One channel's result within a run. */
export const PRACTICE_RESULT_STATUSES = ["passed", "failed", "in_review", "error"] as const;
export type PracticeResultStatus = (typeof PRACTICE_RESULT_STATUSES)[number];

/** A review: open until an operator decides it, or superseded by a later run. */
export const AUDIT_REVIEW_STATUSES = ["open", "passed", "failed", "superseded"] as const;
export type AuditReviewStatus = (typeof AUDIT_REVIEW_STATUSES)[number];

/**
 * What a review is about. `practice_questions`: a run of the practice
 * questions, the queue's first use, whose `run_id` it names.
 * `agreement_kind`: the misclassification signal (package WP9, plan Part L),
 * a practice that signed the Data Protection Agreement as billing no
 * insurance electronically while its own website says it accepts insurance;
 * no run, and an operator decides it by recording the practice's answer
 * (lib/agreements/misclassification.ts). Every reader of the practice
 * questions' reviews filters on its own kind.
 */
export const AUDIT_REVIEW_KINDS = ["practice_questions", "agreement_kind"] as const;
export type AuditReviewKind = (typeof AUDIT_REVIEW_KINDS)[number];
