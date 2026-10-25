import { expireCaseItems, proposeSupportReplyFor, type ProposeReplyOutcome } from "@/lib/approvals/support-reply";
import { describeError, log } from "@/lib/log";

/**
 * Where the support slice's three lanes meet (ops automation Phase 7, lane
 * P7e). Each lane stopped at a file it did not own; these are the calls
 * that join them, kept here so the lanes' files carry one line each and no
 * import of each other (the drafter and the cases are imported by the send
 * path, so a static import back would be a cycle: they load this file
 * lazily).
 *
 *   - a draft that passed every check is proposed for the owner's yes
 *     (lane P7b's drafter, lib/support/draft/run.ts → lane P7c's
 *     proposeSupportReplyFor), idempotent per (case, draft version);
 *   - a case that closes takes its waiting reply item off the list in the
 *     same operation (lane P7a's closeSupportCase → lane P7c's
 *     expireCaseItems), outcome `case_closed`.
 *
 * Neither ever fails its caller: the draft is written and the case is
 * closed whatever happens here. What is missed is caught again: the
 * approvals job's sweep expires an item whose case has moved on
 * (supportReplyResolved), and the executor sends nothing for a closed case
 * or a newer draft.
 */

/** The outcome code of a reply item taken off the list because its case closed. */
export const CASE_CLOSED_OUTCOME = "case_closed";

/** Propose a case's current draft after the drafter wrote one that passed every check. Null when proposing failed. */
export async function proposeAfterDraft(caseId: string, now: Date): Promise<ProposeReplyOutcome | null> {
  try {
    const outcome = await proposeSupportReplyFor({ caseId, now });
    if (outcome.status === "checks_failed" || outcome.status === "refused") {
      log.info("support draft not proposed", { outcome: outcome.status, code: outcome.status === "refused" ? outcome.code : null });
    }
    return outcome;
  } catch (error) {
    log.error("support draft proposal failed", { error: describeError(error) });
    return null;
  }
}

/** Take a closed case's waiting reply items off the list. How many; zero when it failed. */
export async function expireAfterClose(caseId: string, now: Date): Promise<number> {
  try {
    return await expireCaseItems(caseId, now, CASE_CLOSED_OUTCOME);
  } catch (error) {
    log.error("support case closed; its reply item not expired", { error: describeError(error) });
    return 0;
  }
}
