import type { Metadata } from "next";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { HostStandbyPage } from "@/components/admin/HostStandbyNotice";
import { requireOperator } from "@/lib/admin/operator";
import {
  decideAgreementReview as decideAgreementUpstream,
  decidePracticeReview as decideUpstream,
  fetchAgreementReviews,
  fetchPracticeReviews,
  rerunPracticeQuestions as rerunUpstream,
  type CoveredAnswer,
  type PracticeSection,
} from "@/lib/admin/ops-client";
import { isHostUnreachable } from "@/lib/host/state";

import { AgreementChecks } from "./AgreementChecks";
import { ReviewQueue } from "./ReviewQueue";

/**
 * /admin/reviews: the practice questions' review queue (plan Part K, "The
 * audit review queue"). A clinic's run that a judge failed, or whose check
 * failed on our side, waits here for a person, by the day the clinic's
 * tracker names ("Being checked by our team; ready by …"). Passing it passes
 * the run and approves the script it read; failing it keeps the run failed,
 * and naming a section sends the clinic O9.
 *
 * Below them, the agreement checks (plan Part L): a practice that signed the
 * Data Protection Agreement as billing no insurance electronically, whose
 * website says it accepts insurance, waits here until the operator asks it
 * and records its answer, which setCoveredEntity carries out on apps/app.
 *
 * Read and decided through the ops envelope (lib/admin/ops-client.ts). What
 * crosses is synthetic: the cases are templated from the clinic's business
 * profile, and the answers are AYA's to them. No patient is in any of it.
 * Guarded like every page under /admin: requireOperator() here, and the
 * session again inside every call the actions make.
 */

export const metadata: Metadata = { title: "Reviews" };
export const dynamic = "force-dynamic";

const PATH = "/admin/reviews";

async function decide(
  clinicId: string,
  reviewId: string,
  decision: "pass" | "fail",
  section: PracticeSection | null,
) {
  "use server";
  const result = await decideUpstream(clinicId, reviewId, decision, section);
  revalidatePath(PATH);
  return result;
}

async function rerun(clinicId: string) {
  "use server";
  const result = await rerunUpstream(clinicId);
  revalidatePath(PATH);
  return result;
}

async function decideAgreement(clinicId: string, reviewId: string, answer: CoveredAnswer) {
  "use server";
  const result = await decideAgreementUpstream(clinicId, reviewId, answer);
  revalidatePath(PATH);
  return result;
}

export default async function ReviewsPage() {
  if (!(await requireOperator())) redirect("/admin/sign-in");
  const result = await fetchPracticeReviews();
  if (isHostUnreachable(result)) return <HostStandbyPage title="Reviews" />;
  const agreements = await fetchAgreementReviews();

  return (
    <main className="mx-auto w-full max-w-[1240px] px-4 py-10 sm:px-8 lg:px-14">
      <h1 className="font-display text-[28px] leading-tight font-semibold tracking-[-0.02em]">
        Reviews
      </h1>
      <p className="text-muted mt-3 max-w-[70ch] text-[15.6px]">
        Practice questions a judge failed, or a check failed on our side. The clinic&apos;s tracker
        says each will be ready by its day, so decide it by then. The cases are synthetic, built
        from the clinic&apos;s own prices and answers; nothing here is a patient&apos;s.
      </p>
      {result.ok ? (
        <ReviewQueue reviews={result.data} decide={decide} rerun={rerun} />
      ) : (
        <p role="status" className="text-red-deep mt-6 text-sm font-semibold">
          {result.message}
        </p>
      )}

      <h2 className="font-display mt-14 text-[22.8px] leading-tight font-semibold">
        Agreement checks
      </h2>
      <p className="text-muted mt-2 max-w-[70ch] text-[15.6px]">
        Practices that signed the data protection agreement as billing no insurance electronically,
        whose website says they accept insurance. Ask the practice, then record what it says.
      </p>
      {agreements.ok ? (
        <AgreementChecks reviews={agreements.data} decide={decideAgreement} />
      ) : (
        <p role="status" className="text-red-deep mt-4 text-sm font-semibold">
          {agreements.message}
        </p>
      )}
    </main>
  );
}
