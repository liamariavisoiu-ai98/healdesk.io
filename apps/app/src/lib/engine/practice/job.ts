import { sql } from "drizzle-orm";

import { unsafeDb } from "@/db";
import { anthropicAssistantResponder } from "@/lib/assistant/responder";
import { describeError, log } from "@/lib/log";
import { anthropicResponder } from "@/lib/meta/front-door";
import { listClinics } from "@/lib/ops/clinics";
import { notifyOps, notifyOpsOnce } from "@/lib/ops/notify";
import {
  getJob,
  JOB_PRACTICE_QUESTIONS,
  runSwitchedJob,
  type JobOutcome,
} from "@/lib/scheduler/jobs";
import { withTenant } from "@/lib/tenant";

import { anthropicPracticeJudge } from "./judge";
import {
  channelStatus,
  runPracticeChannel,
  type ChannelOutcome,
  type PracticeRunDeps,
} from "./runner";
import {
  claimPastDueReviews,
  claimPracticeRun,
  closePracticeRun,
  latestRunVersion,
  passedResultAt,
  queueReadyEmail,
  readPracticeInputs,
  recordPracticeRun,
  requestPracticeQuestions,
  type PendingAlert,
} from "./store";

/**
 * The practice questions' job (plan Part G), behind the `practice-questions`
 * job row's switch, which ships off: every run asks the model, and that
 * spends real tokens.
 *
 * Every minute, from its own pg-boss queue: each clinic's due run (queued two
 * minutes after the last change that asked for it, or a run whose lease ran
 * out), one at a time per clinic. A run is claimed in one transaction, asks
 * the model outside any, and is recorded in a third (store.ts). A channel
 * whose inputs are unchanged since an earlier pass reuses that pass and asks
 * nothing.
 *
 * Every hour, from the tick: the sweep. A clinic whose inputs changed with no
 * run asked for (a writer that does not ask, such as the ops console's
 * script edit) gets one; an open review past the day the clinic was given
 * raises practice_question_review_past_due once; and once Talk to your AYA
 * exists, a clinic whose tracker is complete gets O8 if it has not yet.
 */

const ACTOR = { type: "service", serviceName: "practice-questions" } as const;

/** Runs claimed per minute, at most: each can take minutes, and the next minute's fire takes the rest. */
const RUNS_PER_FIRE = 3;

export type PracticeJobDeps = Partial<PracticeRunDeps> & { talkToAyaBuilt?: boolean };

/** The model, the front door's model and the judge, on healdesk's key. Null where the key is not set. */
export function realPracticeDeps(now: Date): PracticeRunDeps {
  return {
    responder: anthropicAssistantResponder(),
    metaResponder: anthropicResponder(),
    judge: anthropicPracticeJudge(),
    now,
  };
}

/** Runs due across every clinic, through the tenant walk (drizzle app_due_practice_runs). Ids only. */
export async function duePracticeRuns(limit: number): Promise<{ clinicId: string; id: string }[]> {
  const result = await unsafeDb.execute<{ clinic_id: string; id: string }>(
    sql`select clinic_id, id from app_due_practice_runs(${limit})`,
  );
  const rows = (result as unknown as { rows: Record<string, unknown>[] }).rows;
  return rows.map((row) => ({ clinicId: String(row.clinic_id), id: String(row.id) }));
}

async function raise(alerts: readonly PendingAlert[]): Promise<void> {
  for (const alert of alerts) await notifyOps(alert.event, alert.fields);
}

/** One clinic's run, from claim to record. The status it came to, or null when it was not ours to run. */
export async function runOnePracticeRun(
  clinicId: string,
  runId: string,
  deps: PracticeJobDeps = {},
): Promise<string | null> {
  const now = deps.now ?? new Date();
  const run = await withTenant({ clinicId, actor: ACTOR }, (tx) =>
    claimPracticeRun(tx, runId, now),
  );
  if (!run) return null;
  const read = await withTenant({ clinicId, actor: ACTOR }, (tx) => readPracticeInputs(tx, now));
  const full: PracticeRunDeps = { ...realPracticeDeps(now), ...deps, now };

  const outcomes: (ChannelOutcome & { reused?: boolean })[] = [];
  if (read && read.ready) {
    for (const input of read.channels) {
      const version = read.channelVersions[input.channel]!;
      const earlier = await withTenant({ clinicId, actor: ACTOR }, (tx) =>
        passedResultAt(tx, input.channel, version),
      );
      if (earlier) {
        outcomes.push({
          channel: input.channel,
          inputVersion: version,
          status: channelStatus(earlier),
          cases: earlier,
          reused: true,
        });
        continue;
      }
      try {
        outcomes.push(await runPracticeChannel(input, read.knowledge, full));
      } catch (error) {
        log.error("practice questions channel threw", {
          clinicId,
          runId,
          channel: input.channel,
          error: describeError(error),
        });
        outcomes.push({
          channel: input.channel,
          inputVersion: version,
          status: "error",
          cases: [],
        });
      }
    }
  }

  if (!read) {
    // The clinic has left: the run is closed, and nothing is asked.
    await withTenant({ clinicId, actor: ACTOR }, (tx) => closePracticeRun(tx, run, now));
    return "not_ready";
  }

  const recorded = await withTenant({ clinicId, actor: ACTOR }, (tx) =>
    recordPracticeRun(tx, {
      run,
      read,
      outcomes,
      now: deps.now ?? new Date(),
      talkToAyaBuilt: deps.talkToAyaBuilt,
    }),
  );
  await raise(recorded.alerts);
  log.info("practice questions run", { clinicId, runId, status: recorded.status });
  return recorded.status;
}

/** The minute's work: up to RUNS_PER_FIRE due runs, each clinic's in turn. */
export async function runDuePracticeQuestions(
  deps: PracticeJobDeps = {},
): Promise<{ ran: number; statuses: string[] }> {
  const due = await duePracticeRuns(RUNS_PER_FIRE * 4);
  const seen = new Set<string>();
  const statuses: string[] = [];
  for (const { clinicId, id } of due) {
    if (statuses.length >= RUNS_PER_FIRE) break;
    if (seen.has(clinicId)) continue;
    seen.add(clinicId);
    try {
      const status = await runOnePracticeRun(clinicId, id, deps);
      if (status) statuses.push(status);
    } catch (error) {
      log.error("practice questions run threw", {
        clinicId,
        runId: id,
        error: describeError(error),
      });
    }
  }
  return { ran: statuses.length, statuses };
}

/** The `practice-questions` queue's job, every minute. */
export async function runPracticeQuestionsJob(options: PracticeJobDeps = {}): Promise<JobOutcome> {
  const now = options.now ?? new Date();
  return runSwitchedJob(
    JOB_PRACTICE_QUESTIONS,
    async () => {
      const { ran, statuses } = await runDuePracticeQuestions(options);
      return `${ran} run(s)${ran ? `: ${statuses.join(", ")}` : ""}.`;
    },
    now,
  );
}

export type PracticeSweepSummary = {
  requested: number;
  pastDue: number;
  ready: number;
  failures: number;
};

/**
 * The hourly sweep, behind the same switch: a run for a clinic whose inputs
 * no longer match its latest run's and none is waiting; the past-due alert
 * for each open review past its day, once; O8 for a complete tracker.
 */
export async function sweepPracticeQuestions(
  options: PracticeJobDeps = {},
): Promise<PracticeSweepSummary> {
  const now = options.now ?? new Date();
  const summary: PracticeSweepSummary = { requested: 0, pastDue: 0, ready: 0, failures: 0 };
  for (const clinic of await listClinics()) {
    if (clinic.offboardingStartedAt) continue;
    try {
      const outcome = await withTenant({ clinicId: clinic.id, actor: ACTOR }, async (tx) => {
        const pastDue = await claimPastDueReviews(tx, now);
        const read = await readPracticeInputs(tx, now);
        let requested = false;
        let ready = false;
        if (read?.ready) {
          const latest = await latestRunVersion(tx);
          if (!latest || (!latest.pending && latest.inputVersion !== read.inputVersion)) {
            await requestPracticeQuestions(tx, { reason: "sweep", now });
            requested = true;
          }
          ready = await queueReadyEmail(tx, {
            slug: read.slug,
            now,
            talkToAyaBuilt: options.talkToAyaBuilt,
          });
        }
        return { pastDue, requested, ready };
      });
      for (const reviewId of outcome.pastDue) {
        summary.pastDue += 1;
        await notifyOpsOnce("practice_question_review_past_due", { clinicId: clinic.id, reviewId });
      }
      if (outcome.requested) summary.requested += 1;
      if (outcome.ready) summary.ready += 1;
    } catch (error) {
      summary.failures += 1;
      log.error("practice questions sweep could not read a clinic", {
        clinicId: clinic.id,
        error: describeError(error),
      });
    }
  }
  return summary;
}

/** The sweep as the tick runs it: behind the job's switch, recorded on its row. */
export async function runPracticeQuestionsSweep(
  options: PracticeJobDeps = {},
): Promise<JobOutcome> {
  const now = options.now ?? new Date();
  const job = await getJob(JOB_PRACTICE_QUESTIONS);
  if (!job?.enabled) return { status: "disabled" };
  try {
    const s = await sweepPracticeQuestions({ ...options, now });
    return {
      status: s.failures ? "failed" : "ok",
      note: `${s.requested} run(s) asked for, ${s.pastDue} review(s) past due, ${s.ready} ready email(s)${s.failures ? `, ${s.failures} clinic(s) unread` : ""}.`,
    };
  } catch (error) {
    return { status: "failed", note: describeError(error).slice(0, 500) };
  }
}
