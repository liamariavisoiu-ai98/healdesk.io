import { describeError, log } from "@/lib/log";
import { draftNextCase, type DraftDeps } from "@/lib/support/draft/run";

import { getJob, runSwitchedJob, type JobOutcome } from "./jobs";

/**
 * The support drafter's job (design E5 §2.3; lane P7b): every minute from
 * its own `support-draft` queue, behind the `support-draft` job row's
 * switch, which ships off, because every run asks the model and spends real
 * tokens. Each fire drafts up to CASES_PER_FIRE cases that are `new` and
 * name a clinic, the most urgent first, and takes back a case left
 * `drafting` past its lease (lib/support/draft/store.ts).
 *
 * It never throws into the queue: a case it could not draft ends
 * `needs_edit` with the reason on the case, and the job's note counts what
 * happened. It leases its own rows (a compare-and-set on each case's state),
 * so it runs without runJob's hour-long lock (runSwitchedJob), as the
 * email sender does.
 *
 * The job row itself is seeded by a migration (lane P7b handed the INSERT to
 * the lead for drizzle/0126). Until that row exists this job does nothing and
 * says so, rather than throwing "Unknown job" every minute.
 */

export const JOB_SUPPORT_DRAFT = "support-draft";
export const QUEUE_SUPPORT_DRAFT = "support-draft";
/** Cases per fire, at most: each is a few model calls, and the next minute's fire takes the rest. */
export const CASES_PER_FIRE = 3;

export async function runSupportDraftJob(deps: DraftDeps = {}): Promise<JobOutcome> {
  const now = deps.now ?? new Date();
  if (!(await getJob(JOB_SUPPORT_DRAFT))) {
    log.warn("support-draft: no job row yet; nothing drafted", { job: JOB_SUPPORT_DRAFT });
    return { status: "disabled" };
  }
  return runSwitchedJob(
    JOB_SUPPORT_DRAFT,
    async () => {
      const counts = { drafted: 0, needsEdit: 0, failed: 0, superseded: 0, errors: 0 };
      for (let i = 0; i < CASES_PER_FIRE; i += 1) {
        let outcome;
        try {
          outcome = await draftNextCase({ ...deps, now });
        } catch (error) {
          counts.errors += 1;
          log.error("support-draft: a run failed", { error: describeError(error) });
          continue;
        }
        if (outcome.outcome === "nothing_to_draft" || outcome.outcome === "no_clinic") break;
        if (outcome.outcome === "drafted") counts.drafted += 1;
        else if (outcome.outcome === "needs_edit") counts.needsEdit += 1;
        else if (outcome.outcome === "failed") counts.failed += 1;
        else counts.superseded += 1;
      }
      return `${counts.drafted} drafted, ${counts.needsEdit} need an edit, ${counts.failed} not drafted, ${counts.superseded} superseded, ${counts.errors} errors`;
    },
    now,
  );
}
