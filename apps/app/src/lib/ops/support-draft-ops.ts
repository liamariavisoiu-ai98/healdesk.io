import { describeError, log } from "@/lib/log";
import { DRAFTS_PER_CASE, queueRegeneration, readDraftView, type SupportDraftView } from "@/lib/support/draft/store";

import { audit, ok, opsProblem, UUID_SHAPED, type Operator, type OpsOutcome } from "./api";

/**
 * The support drafter's ops operations (lane P7b; design E5 §2.4):
 *
 *   - `getSupportCase`'s `draft` (lib/ops/support-case-ops.ts reads it here,
 *     supportDraftFor): the newest draft on the case, its checks by id and
 *     rule, the facts it rests on, the questions for ops and the model's
 *     confidence; or the reason the last run wrote none. The draft is text
 *     the eight checks read (lib/support/draft/checks.ts), written from the
 *     account's facts; never the clinic's own words (D15).
 *   - `regenerateSupportDraft {caseId}`, MUTATING: queues a new draft for the
 *     support-draft job, which takes it on its next fire. It calls no model
 *     itself. Refused on a closed case, a case with no clinic, one being
 *     drafted, waiting on the clinic or snoozed, and one with
 *     DRAFTS_PER_CASE drafts already. A security event names the operator,
 *     with the ref, the clinic, the state it left and the attempts so far.
 */

/** The draft as getSupportCase returns it, or null when there is none. A read that fails is null, logged. */
export async function supportDraftFor(caseId: string): Promise<SupportDraftView | null> {
  try {
    return await readDraftView(caseId);
  } catch (error) {
    log.error("support draft not read", { error: describeError(error) });
    return null;
  }
}

export async function opRegenerateSupportDraft(
  args: Record<string, unknown>,
  operator: Operator,
  now: Date = new Date(),
): Promise<OpsOutcome> {
  const unknown = Object.keys(args).filter((key) => key !== "caseId");
  if (unknown.length > 0) return opsProblem("regenerateSupportDraft takes only caseId.", 400, "invalid_args");
  const raw = typeof args.caseId === "string" ? args.caseId.trim().toLowerCase() : "";
  if (!UUID_SHAPED.test(raw)) return opsProblem("The case id is a uuid.", 400, "invalid_args");
  try {
    const outcome = await queueRegeneration(raw, now);
    switch (outcome.outcome) {
      case "not_found":
        return opsProblem("No such support case.", 404, "invalid_args");
      case "closed":
        return opsProblem(`${outcome.ref} is closed. A clinic that writes again opens a new case.`, 409, "invalid_args");
      case "no_clinic":
        return opsProblem(`${outcome.ref} names no practice yet: match it first, and a draft follows.`, 409, "invalid_args");
      case "limit":
        return opsProblem(
          `${outcome.ref} has had ${DRAFTS_PER_CASE} drafts, the most a case gets. Edit the last one or write the reply yourself.`,
          409,
          "invalid_args",
        );
      case "not_allowed":
        return opsProblem(
          `${outcome.ref} cannot be drafted again while it is ${outcome.state.replace(/_/g, " ")}.`,
          409,
          "invalid_args",
        );
      case "already_queued":
        return ok({ outcome: "unchanged", ref: outcome.ref, state: "new", auditRecorded: true });
      case "queued": {
        const auditRecorded = await audit(operator, "support_draft_regenerate_asked", {
          ref: outcome.ref,
          clinicId: outcome.clinicId,
          from: outcome.from,
          to: "new",
          attempts: outcome.attempts,
        });
        return ok({ outcome: "done", ref: outcome.ref, state: "new", auditRecorded });
      }
    }
  } catch (error) {
    log.error("support draft not queued", { error: describeError(error) });
    return opsProblem("The new draft could not be asked for.", 500, "failed");
  }
}
