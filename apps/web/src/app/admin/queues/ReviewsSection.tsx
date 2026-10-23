import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { HostStandbyNotice } from "@/components/admin/HostStandbyNotice";
import { Failure, Section } from "@/components/admin/ui";
import { requireOperator } from "@/lib/admin/operator";
import {
  decidePracticeReview as decideUpstream,
  fetchPracticeReviews,
  rerunPracticeQuestions as rerunUpstream,
  type PracticeSection,
} from "@/lib/admin/ops-client";
import { isHostUnreachable } from "@/lib/host/state";

import { ReviewQueue } from "./ReviewQueue";

/**
 * Queues › Reviews: the practice questions' review queue (plan Part K, "The
 * audit review queue"). A clinic's run that a judge failed, or whose check
 * failed on our side, waits here for a person, by the day the clinic's
 * tracker names ("Being checked by our team; ready by …"). Passing it passes
 * the run and approves the script it read; failing it keeps the run failed,
 * and naming a section sends the clinic O9. Until the admin redesign
 * (23 October 2026) this was the top of /admin/reviews.
 *
 * What crosses is synthetic: the cases are templated from the clinic's
 * business profile, and the answers are AYA's to them. No patient is in any
 * of it. The session is checked here and again inside every call the
 * actions make.
 */

const PATH = "/admin/queues";

async function decide(clinicId: string, reviewId: string, decision: "pass" | "fail", section: PracticeSection | null) {
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

export default async function ReviewsSection() {
  if (!(await requireOperator())) redirect("/admin/sign-in");
  const result = await fetchPracticeReviews();
  const open = result.ok ? result.data.filter((r) => r.status === "open").length : null;
  return (
    <Section id="reviews" title={`Reviews${open === null ? "" : ` (${open} open)`}`}>
      {isHostUnreachable(result) ? (
        <HostStandbyNotice what="The review queue" />
      ) : result.ok ? (
        <ReviewQueue reviews={result.data} decide={decide} rerun={rerun} />
      ) : (
        <Failure failure={result} what="the review queue" />
      )}
    </Section>
  );
}
