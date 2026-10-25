import { checkFreshOperatorCode } from "./fresh-code";
import { requireOperator } from "./operator";
import {
  recordAgreementAnswer as sendRecordAgreementAnswer, // raw: only here (clinic-contact-client.test.ts)
  type AgreementAnswer,
  type OpsResult,
  type SetCoveredEntityOutcome,
} from "./ops-client";

/**
 * The owner's answer to the agreement question (ops automation lane P6f;
 * design E6 §3 item 13), entered as an approval decision is
 * (lib/admin/approval-decide.ts): an operator session, then a fresh code
 * from the authenticator, checked here on Vercel, then the signed request
 * carrying the mark that it was checked. A Yes or Not sure starts the BAA
 * re-sign and pauses AYA at every location of the practice until it is
 * signed, which cannot be taken back from here, so a session alone never
 * records it. The answer is the one the owner heard, never one read off the
 * website or a reply. A wrong or missing code sends nothing. This is the
 * only file that may name the raw client.
 */

const UNAUTHENTICATED = {
  ok: false as const,
  code: "unauthenticated" as const,
  message: "Your session has ended. Sign in again to continue.",
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ANSWERS: readonly string[] = ["yes", "no", "not_sure"];

export type AgreementAnswerEntry = SetCoveredEntityOutcome | { status: "code_refused"; message: string };

export async function recordAgreementAnswerWithCode(
  clinicId: string,
  reviewId: string,
  answer: AgreementAnswer,
  code: unknown,
): Promise<OpsResult<AgreementAnswerEntry>> {
  if (!(await requireOperator())) return UNAUTHENTICATED;
  if (!UUID.test(clinicId) || !UUID.test(reviewId)) {
    return { ok: true, data: { status: "refused", message: "No such review at this clinic." } };
  }
  if (!ANSWERS.includes(answer)) return { ok: true, data: { status: "refused", message: "Pick Yes, No or Not sure." } };
  const fresh = checkFreshOperatorCode(code);
  if (!fresh.ok) return { ok: true, data: { status: "code_refused", message: fresh.message } };
  return sendRecordAgreementAnswer(clinicId, reviewId, answer);
}
