import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { HostStandbyNotice } from "@/components/admin/HostStandbyNotice";
import { Failure, Section } from "@/components/admin/ui";
import { requireOperator } from "@/lib/admin/operator";
import { recordAgreementAnswerWithCode } from "@/lib/admin/agreement-answer";
import { isUuid } from "@/lib/admin/issue-link";
import { fetchAgreementReviews, proposeAgreementQuestion, type CoveredAnswer } from "@/lib/admin/ops-client";
import { isHostUnreachable } from "@/lib/host/state";

import { AgreementChecks } from "./AgreementChecks";

/**
 * Queues › Agreement checks (plan Part L): a practice that signed the Data
 * Protection Agreement as billing no insurance electronically, whose website
 * says it accepts insurance, waits here until the operator asks it and
 * records its answer, which apps/app carries out (the covered-entity write). Until
 * the admin redesign (23 October 2026) this was the foot of /admin/reviews.
 * "Ask the practice" (lane P6j) proposes the question email in Approvals;
 * it sends nothing, so it asks for no code.
 */

const PATH = "/admin/queues";

// Every answer needs the code from the operator's authenticator (lane P6f):
// a Yes or Not sure pauses AYA at every location of the practice.
async function decide(clinicId: string, reviewId: string, answer: CoveredAnswer, code: string) {
  "use server";
  const result = await recordAgreementAnswerWithCode(clinicId, reviewId, answer, code);
  revalidatePath(PATH);
  return result;
}

// The question's proposal: the ids are the row's, drawn by this section.
async function ask(clinicId: string, reviewId: string) {
  "use server";
  if (!isUuid(clinicId) || !isUuid(reviewId)) {
    return { ok: false as const, code: "refused" as const, message: "That review is not one on this page. Reload and try again." };
  }
  const result = await proposeAgreementQuestion(clinicId, reviewId);
  revalidatePath(PATH);
  return result;
}

export default async function AgreementChecksSection() {
  if (!(await requireOperator())) redirect("/admin/sign-in");
  const result = await fetchAgreementReviews();
  const open = result.ok ? result.data.filter((r) => r.status === "open").length : null;
  return (
    <Section id="agreement-checks" title={`Agreement checks${open === null ? "" : ` (${open} open)`}`}>
      <p className="text-muted text-sm">Signed the DPA as billing no insurance; the website says it accepts insurance. Ask, then record what it says.</p>
      {isHostUnreachable(result) ? (
        <HostStandbyNotice what="The agreement checks" />
      ) : result.ok ? (
        <AgreementChecks reviews={result.data} decide={decide} ask={ask} />
      ) : (
        <Failure failure={result} what="the agreement checks" />
      )}
    </Section>
  );
}
