import { createHash } from "node:crypto";

import { NEVER_SAY_DEFAULTS, type Channel } from "@healdesk/catalog";
import { and, desc, eq, inArray, isNotNull, lt, sql } from "drizzle-orm";

import {
  agentConfigs,
  auditReviewQueue,
  clinicChannels,
  practiceQuestionResults,
  practiceQuestionRuns,
  type PracticeQuestionRun,
} from "@/db/schema";
import { assistantFacts } from "@/lib/assistant/facts";
import { frontDoorFacts } from "@/lib/meta/front-door";
import { enqueuePlanNotice } from "@/lib/notices/plan-notices";
import { approveAgentConfigVersion } from "@/lib/onboarding/agent-config";
import type { OpsEvent, OpsFields } from "@/lib/ops/notify";
import { publicUrl } from "@/lib/public-url";
import { replyByDay } from "@/lib/reply-by";
import { readSetupState, type SetupState } from "@/lib/setup/state";
import { answersMissing, stagesLeft, TALK_TO_AYA_BUILT } from "@/lib/setup/tracker";
import type { TenantTx } from "@/lib/tenant";

import { PRACTICE_CASES_VERSION } from "./cases";
import type { ClinicTexts } from "./checks";
import type { ChannelOutcome, PracticeChannelInput, PracticeKnowledge } from "./runner";
import { practiceInputVersion } from "./runner";
import { sectionPath } from "./sections";
import type { PracticeState } from "./state";
import {
  PRACTICE_COMPLETED_STATUSES,
  type PracticeCaseResult,
  type PracticeResultStatus,
  type PracticeRunReason,
  type PracticeRunStatus,
  type PracticeSection,
} from "./types";

/**
 * The practice questions' rows (drizzle practice_question_runs,
 * practice_question_results, audit_review_queue): asking for a run, reading
 * what the cases read, claiming a run, recording what it came to, and what
 * the tracker, Home and the go-live gate read back. Every function runs in
 * the clinic's tenant transaction (RLS, forced), and nothing here calls the
 * model: the job (job.ts) claims a run in one transaction, asks the model
 * outside any, and records the outcome in a third, so no transaction is held
 * open across a model call.
 *
 * What a run's outcome does:
 *
 *   - passed: approves the agent script's version the run read, as the
 *     operator's approval does (approveAgentConfigVersion), once, and only
 *     while that is still the current version; and once every stage of the
 *     tracker is done, queues O8;
 *   - failed on the clinic's own data: queues O9, naming the section and a
 *     count, and tells ops (practice_question_failed);
 *   - a judge's failure, or a check that failed on our side: opens a review
 *     due the next business day, and tells ops;
 *   - an error: tried again 10 and then 60 minutes later, and after that
 *     left for the next change or the hourly sweep, with ops told.
 *
 * None of them takes AYA offline: nothing here clears an approval or touches
 * a channel. The gate (practiceQuestionsGate) applies to a channel that has
 * not gone live, never to one that has.
 */

export const PRACTICE_DEBOUNCE_MS = 2 * 60_000;
/** A claimed run's lease: longer than the longest run, so a live run is never taken over. */
export const PRACTICE_LEASE_MS = 20 * 60_000;
/** After the first and second attempts that could not reach the model. */
export const PRACTICE_RETRY_DELAYS_MS = [10 * 60_000, 60 * 60_000] as const;
export const PRACTICE_MAX_ATTEMPTS = PRACTICE_RETRY_DELAYS_MS.length + 1;

/** An ops alert, raised by the caller once the transaction that decided it has committed. */
export type PendingAlert = { event: OpsEvent; fields: OpsFields };

// -----------------------------------------------------------------------------
// Asking for a run
// -----------------------------------------------------------------------------

/**
 * Ask for the practice questions to run again, two minutes after this
 * change if no other comes (plan Part G, "debounced to 2 minutes"): the
 * clinic's one queued run is moved on, or one is queued. In the caller's
 * transaction, so a change that rolls back asks for nothing. A run already
 * running finishes, sees that what it read has changed, and leaves the
 * verdict to the queued one.
 */
export async function requestPracticeQuestions(
  tx: TenantTx,
  input: { reason: PracticeRunReason; section?: PracticeSection | null; now?: Date },
): Promise<void> {
  const now = input.now ?? new Date();
  const runAfter = new Date(now.getTime() + PRACTICE_DEBOUNCE_MS);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const moved = await tx.db
      .update(practiceQuestionRuns)
      .set({
        runAfter,
        reason: input.reason,
        ...(input.section ? { triggerSection: input.section } : {}),
      })
      .where(
        and(
          eq(practiceQuestionRuns.clinicId, tx.clinicId),
          eq(practiceQuestionRuns.status, "queued"),
        ),
      )
      .returning({ id: practiceQuestionRuns.id });
    if (moved.length > 0) return;
    // The partial unique index holds one queued run per clinic; a second
    // writer's insert in the same moment is skipped, and this one moves it.
    const queued = await tx.db
      .insert(practiceQuestionRuns)
      .values({
        clinicId: tx.clinicId,
        status: "queued",
        reason: input.reason,
        triggerSection: input.section ?? null,
        requestedAt: now,
        runAfter,
      })
      .onConflictDoNothing()
      .returning({ id: practiceQuestionRuns.id });
    if (queued.length > 0) return;
  }
}

// -----------------------------------------------------------------------------
// What the cases read
// -----------------------------------------------------------------------------

export type PracticeInputs = {
  /** The clinic's answers are set up (the tracker's "Your answers set up"): before then nothing is asked. */
  ready: boolean;
  slug: string;
  state: SetupState;
  channels: PracticeChannelInput[];
  knowledge: PracticeKnowledge;
  agentVersion: number | null;
  /** Every channel's input version, folded into one: what a run is about. */
  inputVersion: string;
  channelVersions: Partial<Record<Channel, string>>;
};

/** The clinic's own never-say phrases, without the built-in defaults, which are ours. */
function ownNeverSay(stored: readonly string[]): string[] {
  const defaults = new Set(NEVER_SAY_DEFAULTS.map((p) => p.trim().toLowerCase()));
  return stored.filter((p) => !defaults.has(p.trim().toLowerCase()));
}

/**
 * Read what the cases read, as it would be once approved: the facts each
 * bought channel's brain is given, the clinic's own words by Knowledge
 * section, and the agent script's version. Null for a clinic that has left.
 */
export async function readPracticeInputs(
  tx: TenantTx,
  now: Date = new Date(),
): Promise<PracticeInputs | null> {
  const state = await readSetupState(tx, { userId: null, now });
  if (!state || state.clinic.offboardingStartedAt) return null;
  const bought = state.channels.map((c) => c.channel);
  const channels: PracticeChannelInput[] = [];
  if (bought.includes("web") || bought.includes("voice")) {
    const facts = await assistantFacts(tx, { asApproved: true });
    if (facts) {
      if (bought.includes("web")) channels.push({ channel: "web", facts });
      if (bought.includes("voice")) channels.push({ channel: "voice", facts });
    }
  }
  if (bought.includes("meta")) {
    const facts = await frontDoorFacts(tx, { asApproved: true, ignoreSwitch: true });
    if (facts)
      channels.push({
        channel: "meta",
        facts,
        languages: state.settings.languages.length ? state.settings.languages : ["en"],
      });
  }
  const [agent] = await tx.db
    .select({ version: agentConfigs.version })
    .from(agentConfigs)
    .where(eq(agentConfigs.clinicId, tx.clinicId))
    .limit(1);

  const k = state.knowledge;
  const texts: ClinicTexts = {
    quick_answers: [...k.quickAnswers, ...(k.mostAsked ? [k.mostAsked] : [])].map(
      (a) => `${a.question} ${a.answer}`,
    ),
    policies: k.policies,
    promotions: k.promotions ? [k.promotions] : [],
  };
  const ready = answersMissing(state).length === 0;
  const channelVersions: Partial<Record<Channel, string>> = {};
  for (const input of channels) channelVersions[input.channel] = practiceInputVersion(input);
  const inputVersion = createHash("sha256")
    .update(
      JSON.stringify({
        cases: PRACTICE_CASES_VERSION,
        ready,
        channels: Object.entries(channelVersions).sort(([a], [b]) => a.localeCompare(b)),
      }),
    )
    .digest("hex");
  return {
    ready,
    slug: state.clinic.slug,
    state,
    channels,
    knowledge: { texts, ownNeverSay: ownNeverSay(k.neverSay) },
    agentVersion: agent?.version ?? null,
    inputVersion,
    channelVersions,
  };
}

/**
 * A channel's earlier pass at exactly this input version: the same questions
 * of the same brain, answered right. Reused instead of asking the model again.
 */
export async function passedResultAt(
  tx: TenantTx,
  channel: Channel,
  inputVersion: string,
): Promise<PracticeCaseResult[] | null> {
  const [row] = await tx.db
    .select({ cases: practiceQuestionResults.cases })
    .from(practiceQuestionResults)
    .where(
      and(
        eq(practiceQuestionResults.clinicId, tx.clinicId),
        eq(practiceQuestionResults.channel, channel),
        eq(practiceQuestionResults.inputVersion, inputVersion),
        eq(practiceQuestionResults.status, "passed"),
      ),
    )
    .orderBy(desc(practiceQuestionResults.createdAt))
    .limit(1);
  return row?.cases ?? null;
}

// -----------------------------------------------------------------------------
// Claiming a run
// -----------------------------------------------------------------------------

function uniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; current && depth < 5; depth += 1) {
    if ((current as { code?: unknown }).code === "23505") return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * Claim one run: a queued run whose two minutes are up, or a running one
 * whose lease ran out (the worker that had it stopped). One running run per
 * clinic: a queued run is not claimed while another runs, and the partial
 * unique index refuses a second should two workers race. Null when there is
 * nothing to claim. Its own transaction; the caller passes `withTenant`'s.
 */
export async function claimPracticeRun(
  tx: TenantTx,
  runId: string,
  now: Date,
): Promise<PracticeQuestionRun | null> {
  const lease = new Date(now.getTime() + PRACTICE_LEASE_MS);
  try {
    const [run] = await tx.db
      .update(practiceQuestionRuns)
      .set({
        status: "running",
        leaseUntil: lease,
        attempts: sql`${practiceQuestionRuns.attempts} + 1`,
        startedAt: sql`coalesce(${practiceQuestionRuns.startedAt}, ${now.toISOString()}::timestamptz)`,
      })
      .where(
        and(
          eq(practiceQuestionRuns.id, runId),
          eq(practiceQuestionRuns.clinicId, tx.clinicId),
          sql`((${practiceQuestionRuns.status} = 'queued' and ${practiceQuestionRuns.runAfter} <= ${now.toISOString()}::timestamptz
                and not exists (select 1 from practice_question_runs o
                                 where o.clinic_id = ${tx.clinicId}::uuid and o.status = 'running' and o.id <> ${runId}::uuid))
               or (${practiceQuestionRuns.status} = 'running' and ${practiceQuestionRuns.leaseUntil} < ${now.toISOString()}::timestamptz))`,
        ),
      )
      .returning();
    return run ?? null;
  } catch (error) {
    if (uniqueViolation(error)) return null;
    throw error;
  }
}

// -----------------------------------------------------------------------------
// Recording what a run came to
// -----------------------------------------------------------------------------

export type RunVerdict =
  | { status: "passed" }
  | { status: "failed"; section: PracticeSection; count: number }
  | { status: "in_review"; count: number }
  | { status: "error" };

/**
 * A run's verdict from its channels: an error anywhere is an error (nothing
 * was learnt); any case failed on the clinic's own data is the clinic's to
 * fix, in the section that most cases failed on; any other failure, or a
 * judge's, is a review; otherwise a pass. Not-applicable cases are neither.
 */
export function runVerdict(
  outcomes: readonly Pick<ChannelOutcome, "status" | "cases">[],
): RunVerdict {
  if (outcomes.some((o) => o.status === "error")) return { status: "error" };
  const counts = new Map<PracticeSection, number>();
  let review = 0;
  for (const outcome of outcomes) {
    for (const kase of outcome.cases) {
      if (kase.status === "failed" && kase.attribution?.kind === "clinic_data") {
        counts.set(
          kase.attribution.section,
          Math.max(counts.get(kase.attribution.section) ?? 0, kase.attribution.count),
        );
      } else if (kase.status === "failed" || kase.status === "review") {
        review += 1;
      }
    }
  }
  if (counts.size > 0) {
    const [section, count] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]!;
    return { status: "failed", section, count };
  }
  if (review > 0) return { status: "in_review", count: review };
  return { status: "passed" };
}

/** Midnight at the end of `isoDay` in `timeZone`, as an instant. */
export function endOfDay(isoDay: string, timeZone = "America/New_York"): Date {
  const [y, m, d] = isoDay.split("-").map(Number) as [number, number, number];
  const guess = Date.UTC(y, m - 1, d + 1, 0, 0, 0);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(guess));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const wall = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour"),
    get("minute"),
    get("second"),
  );
  return new Date(guess - (wall - guess));
}

export type RecordedOutcome = { status: PracticeRunStatus; alerts: PendingAlert[] };

/**
 * Record a claimed run's outcome, in the clinic's tenant transaction. The
 * run must still be ours (running, at the attempt we claimed); otherwise
 * nothing is written. `read` is what the run read when it started: when
 * what the cases read has changed since, the run is superseded and a
 * queued run is made sure of.
 */
export async function recordPracticeRun(
  tx: TenantTx,
  input: {
    run: PracticeQuestionRun;
    read: PracticeInputs;
    outcomes: readonly (ChannelOutcome & { reused?: boolean })[];
    now: Date;
    /** Tests only: whether Talk to your AYA exists, for O8. */
    talkToAyaBuilt?: boolean;
  },
): Promise<RecordedOutcome> {
  const { run, read, now } = input;
  const alerts: PendingAlert[] = [];
  const [current] = await tx.db
    .select({ status: practiceQuestionRuns.status, attempts: practiceQuestionRuns.attempts })
    .from(practiceQuestionRuns)
    .where(and(eq(practiceQuestionRuns.id, run.id), eq(practiceQuestionRuns.clinicId, tx.clinicId)))
    .for("update")
    .limit(1);
  if (!current || current.status !== "running" || current.attempts !== run.attempts) {
    return { status: current?.status ?? run.status, alerts };
  }

  const finish = (patch: Partial<typeof practiceQuestionRuns.$inferInsert>) =>
    tx.db
      .update(practiceQuestionRuns)
      .set({
        leaseUntil: null,
        finishedAt: now,
        agentVersion: read.agentVersion,
        casesVersion: PRACTICE_CASES_VERSION,
        inputVersion: read.inputVersion,
        ...patch,
      })
      .where(eq(practiceQuestionRuns.id, run.id));

  if (!read.ready || read.channels.length === 0) {
    await finish({ status: "not_ready" });
    return { status: "not_ready", alerts };
  }

  const verdict = runVerdict(input.outcomes);
  if (verdict.status === "error") {
    const delay = PRACTICE_RETRY_DELAYS_MS[run.attempts - 1];
    const [queued] = await tx.db
      .select({ id: practiceQuestionRuns.id })
      .from(practiceQuestionRuns)
      .where(
        and(
          eq(practiceQuestionRuns.clinicId, tx.clinicId),
          eq(practiceQuestionRuns.status, "queued"),
        ),
      )
      .limit(1);
    if (delay !== undefined && !queued) {
      await tx.db
        .update(practiceQuestionRuns)
        .set({
          status: "queued",
          leaseUntil: null,
          runAfter: new Date(now.getTime() + delay),
          lastError: "model_unreachable",
        })
        .where(eq(practiceQuestionRuns.id, run.id));
      return { status: "queued", alerts };
    }
    await finish({ status: "error", lastError: "model_unreachable" });
    if (!queued)
      alerts.push({
        event: "practice_question_failed",
        fields: { clinicId: tx.clinicId, runId: run.id, outcome: "error" },
      });
    return { status: "error", alerts };
  }

  for (const outcome of input.outcomes) {
    await tx.db.insert(practiceQuestionResults).values({
      clinicId: tx.clinicId,
      runId: run.id,
      channel: outcome.channel,
      inputVersion: outcome.inputVersion,
      status: outcome.status,
      cases: outcome.cases,
      reused: outcome.reused === true,
    });
  }

  // What the cases read now, against what they read when the run started.
  const now2 = await readPracticeInputs(tx, now);
  if (!now2 || now2.inputVersion !== read.inputVersion) {
    await finish({ status: "superseded" });
    // The change that moved the inputs asked for a run, which already waits
    // its two minutes and is left alone; one made by a writer that does not
    // ask (the sweep's case) gets one now.
    const [waiting] = await tx.db
      .select({ id: practiceQuestionRuns.id })
      .from(practiceQuestionRuns)
      .where(
        and(
          eq(practiceQuestionRuns.clinicId, tx.clinicId),
          eq(practiceQuestionRuns.status, "queued"),
        ),
      )
      .limit(1);
    if (now2 && !waiting)
      await requestPracticeQuestions(tx, {
        reason: run.reason === "override" ? "sweep" : run.reason,
        section: run.triggerSection,
        now,
      });
    return { status: "superseded", alerts };
  }

  // An open review of an earlier run is about words that have changed since.
  await tx.db
    .update(auditReviewQueue)
    .set({ status: "superseded" })
    .where(and(eq(auditReviewQueue.clinicId, tx.clinicId), eq(auditReviewQueue.status, "open")));

  if (verdict.status === "failed") {
    await finish({ status: "failed", failedSection: verdict.section, failedCount: verdict.count });
    await enqueuePlanNotice(
      tx.db,
      tx.clinicId,
      "practice_questions_failed",
      `practice_questions_failed:${read.inputVersion}`,
      {
        section: verdict.section,
        count: verdict.count,
        fixUrl: publicUrl(sectionPath(read.slug, verdict.section)),
      },
    );
    alerts.push({
      event: "practice_question_failed",
      fields: {
        clinicId: tx.clinicId,
        runId: run.id,
        outcome: "failed",
        section: verdict.section,
        count: verdict.count,
      },
    });
    return { status: "failed", alerts };
  }

  if (verdict.status === "in_review") {
    await finish({ status: "in_review" });
    const dueOn = replyByDay(now);
    await tx.db
      .insert(auditReviewQueue)
      .values({ clinicId: tx.clinicId, runId: run.id, dueOn, dueAt: endOfDay(dueOn) });
    alerts.push({
      event: "practice_question_failed",
      fields: { clinicId: tx.clinicId, runId: run.id, outcome: "in_review", count: verdict.count },
    });
    return { status: "in_review", alerts };
  }

  await finish({ status: "passed" });
  await afterPass(tx, {
    runId: run.id,
    agentVersion: read.agentVersion,
    slug: read.slug,
    now,
    talkToAyaBuilt: input.talkToAyaBuilt,
  });
  return { status: "passed", alerts };
}

/** Close a claimed run with nothing asked: the clinic has left. Only while it is still ours. */
export async function closePracticeRun(
  tx: TenantTx,
  run: PracticeQuestionRun,
  now: Date,
): Promise<void> {
  await tx.db
    .update(practiceQuestionRuns)
    .set({ status: "not_ready", leaseUntil: null, finishedAt: now })
    .where(
      and(
        eq(practiceQuestionRuns.id, run.id),
        eq(practiceQuestionRuns.clinicId, tx.clinicId),
        eq(practiceQuestionRuns.status, "running"),
        eq(practiceQuestionRuns.attempts, run.attempts),
      ),
    );
}

/**
 * What a pass does, whether the questions passed or a review passed them:
 * approve the version they read, and O8 once the tracker is complete.
 */
export async function afterPass(
  tx: TenantTx,
  input: {
    runId: string;
    agentVersion: number | null;
    slug: string;
    now: Date;
    talkToAyaBuilt?: boolean;
  },
): Promise<void> {
  if (input.agentVersion !== null) {
    const approved = await approveAgentConfigVersion(
      tx,
      input.agentVersion,
      `the practice questions (run ${input.runId})`,
    );
    if (approved) {
      await tx.db
        .update(practiceQuestionRuns)
        .set({ approvedVersion: input.agentVersion })
        .where(eq(practiceQuestionRuns.id, input.runId));
    }
  }
  await queueReadyEmail(tx, {
    slug: input.slug,
    now: input.now,
    talkToAyaBuilt: input.talkToAyaBuilt,
  });
}

/**
 * O8, once per clinic, when every stage of the build tracker is done and
 * Talk to your AYA exists, before any channel has gone live. True when it
 * was queued now.
 */
export async function queueReadyEmail(
  tx: TenantTx,
  input: { slug: string; now: Date; talkToAyaBuilt?: boolean },
): Promise<boolean> {
  if (!(input.talkToAyaBuilt ?? TALK_TO_AYA_BUILT)) return false;
  const state = await readSetupState(tx, { userId: null, now: input.now });
  if (!state || state.clinic.offboardingStartedAt) return false;
  if (state.channels.some((c) => c.liveAt !== null)) return false;
  if (stagesLeft(state, await readPracticeState(tx)).length > 0) return false;
  return enqueuePlanNotice(tx.db, tx.clinicId, "assistant_ready", "assistant_ready", {
    homeUrl: publicUrl(`/c/${input.slug}`),
  });
}

// -----------------------------------------------------------------------------
// What the tracker, Home and the gate read
// -----------------------------------------------------------------------------

export async function readPracticeState(tx: TenantTx): Promise<PracticeState> {
  const [pending] = await tx.db
    .select({ id: practiceQuestionRuns.id })
    .from(practiceQuestionRuns)
    .where(
      and(
        eq(practiceQuestionRuns.clinicId, tx.clinicId),
        inArray(practiceQuestionRuns.status, ["queued", "running"]),
      ),
    )
    .limit(1);
  const [latest] = await tx.db
    .select()
    .from(practiceQuestionRuns)
    .where(
      and(
        eq(practiceQuestionRuns.clinicId, tx.clinicId),
        inArray(practiceQuestionRuns.status, [...PRACTICE_COMPLETED_STATUSES]),
        isNotNull(practiceQuestionRuns.finishedAt),
      ),
    )
    .orderBy(desc(practiceQuestionRuns.finishedAt))
    .limit(1);
  if (!latest) return { pending: Boolean(pending), latest: null };
  let reviewDueOn: string | null = null;
  if (latest.status === "in_review") {
    const [review] = await tx.db
      .select({ dueOn: auditReviewQueue.dueOn })
      .from(auditReviewQueue)
      .where(
        and(
          eq(auditReviewQueue.runId, latest.id),
          eq(auditReviewQueue.clinicId, tx.clinicId),
          eq(auditReviewQueue.status, "open"),
        ),
      )
      .limit(1);
    reviewDueOn = review?.dueOn ?? null;
  }
  return {
    pending: Boolean(pending),
    latest: {
      id: latest.id,
      status: latest.status as "passed" | "failed" | "in_review" | "error",
      finishedAt: latest.finishedAt,
      failedSection: latest.failedSection,
      failedCount: latest.failedCount,
      triggerSection: latest.triggerSection,
      overridden: latest.overrideLabel !== null,
      reviewDueOn,
    },
  };
}

export type PracticeGate =
  | { open: true; why: "live" | "passed" | "override" }
  | {
      open: false;
      why: "not_run" | "pending" | "failed" | "in_review" | "error" | "channel_not_passed";
    };

/**
 * Whether the practice questions let a channel go live (plan Part G: they
 * "gate only a clinic's first go-live, or a new channel's, never a live
 * channel"). A channel already live is never held back, whatever the latest
 * run says. One that is not live needs the latest run passed, with its own
 * result passed (or the operator's override), and nothing changed since.
 * For the go-live event's writer (WP1, WP2), which asks it per channel.
 */
export async function practiceQuestionsGate(tx: TenantTx, channel: Channel): Promise<PracticeGate> {
  const [row] = await tx.db
    .select({ liveAt: clinicChannels.liveAt })
    .from(clinicChannels)
    .where(and(eq(clinicChannels.clinicId, tx.clinicId), eq(clinicChannels.channel, channel)))
    .limit(1);
  if (row?.liveAt) return { open: true, why: "live" };
  const state = await readPracticeState(tx);
  if (state.pending) return { open: false, why: "pending" };
  if (!state.latest) return { open: false, why: "not_run" };
  if (state.latest.status !== "passed") return { open: false, why: state.latest.status };
  if (state.latest.overridden) return { open: true, why: "override" };
  const [result] = await tx.db
    .select({ status: practiceQuestionResults.status })
    .from(practiceQuestionResults)
    .where(
      and(
        eq(practiceQuestionResults.runId, state.latest.id),
        eq(practiceQuestionResults.channel, channel),
      ),
    )
    .limit(1);
  return result?.status === "passed"
    ? { open: true, why: "passed" }
    : { open: false, why: "channel_not_passed" };
}

// -----------------------------------------------------------------------------
// The operator's approval, kept as an override
// -----------------------------------------------------------------------------

/**
 * The operator approved the agent script (ops approveAgentConfig): recorded
 * as a passed run with the operator's label, so the tracker and the gate
 * read it as the practice questions would, and the record says it was a
 * person, not the questions. Any open review is superseded by it.
 */
export async function recordOperatorOverride(
  tx: TenantTx,
  input: { label: string; now?: Date },
): Promise<string> {
  const now = input.now ?? new Date();
  const read = await readPracticeInputs(tx, now);
  await tx.db
    .update(auditReviewQueue)
    .set({ status: "superseded" })
    .where(and(eq(auditReviewQueue.clinicId, tx.clinicId), eq(auditReviewQueue.status, "open")));
  const [run] = await tx.db
    .insert(practiceQuestionRuns)
    .values({
      clinicId: tx.clinicId,
      status: "passed",
      reason: "override",
      requestedAt: now,
      runAfter: now,
      startedAt: now,
      finishedAt: now,
      agentVersion: read?.agentVersion ?? null,
      casesVersion: PRACTICE_CASES_VERSION,
      inputVersion: read?.inputVersion ?? null,
      approvedVersion: read?.agentVersion ?? null,
      overrideLabel: input.label.slice(0, 200),
    })
    .returning({ id: practiceQuestionRuns.id });
  tx.audit.record({
    action: "update",
    resourceType: "practice_question_run",
    resourceId: run!.id,
    metadata: { override: true, version: read?.agentVersion ?? null },
  });
  return run!.id;
}

// -----------------------------------------------------------------------------
// Reviews past their day
// -----------------------------------------------------------------------------

/** Open reviews past the day the clinic was given, not yet alerted: stamped, and returned to alert. */
export async function claimPastDueReviews(tx: TenantTx, now: Date): Promise<string[]> {
  const rows = await tx.db
    .update(auditReviewQueue)
    .set({ pastDueAlertedAt: now })
    .where(
      and(
        eq(auditReviewQueue.clinicId, tx.clinicId),
        eq(auditReviewQueue.status, "open"),
        lt(auditReviewQueue.dueAt, now),
        sql`${auditReviewQueue.pastDueAlertedAt} is null`,
      ),
    )
    .returning({ id: auditReviewQueue.id });
  return rows.map((r) => r.id);
}

/** The clinic's latest run whose outcome stands, for the sweep. */
export async function latestRunVersion(
  tx: TenantTx,
): Promise<{ inputVersion: string | null; pending: boolean } | null> {
  const [latest] = await tx.db
    .select({
      inputVersion: practiceQuestionRuns.inputVersion,
      status: practiceQuestionRuns.status,
    })
    .from(practiceQuestionRuns)
    .where(eq(practiceQuestionRuns.clinicId, tx.clinicId))
    .orderBy(desc(practiceQuestionRuns.requestedAt))
    .limit(1);
  if (!latest) return null;
  return {
    inputVersion: latest.inputVersion,
    pending: latest.status === "queued" || latest.status === "running",
  };
}

export type { PracticeResultStatus };
