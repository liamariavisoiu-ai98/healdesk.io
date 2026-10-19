import type { Channel } from "@healdesk/catalog";
import { and, desc, eq, gt, inArray, isNotNull, ne, or } from "drizzle-orm";

import {
  auditReviewQueue,
  clinics,
  practiceQuestionResults,
  practiceQuestionRuns,
} from "@/db/schema";
import type { ActorContext, RequestContext } from "@/lib/audit";
import { enqueuePlanNotice } from "@/lib/notices/plan-notices";
import { listClinics } from "@/lib/ops/clinics";
import { publicUrl } from "@/lib/public-url";
import { withTenant, type TenantTx } from "@/lib/tenant";

import { sectionPath } from "./sections";
import { afterPass, requestPracticeQuestions } from "./store";
import type { AuditReviewStatus, PracticeCaseResult, PracticeSection } from "./types";

/**
 * The audit review queue, for the operator (plan Part K, "The audit review
 * queue"; spec, "A single failure routes to a short internal review before
 * launch"). Read and decided through the ops envelope only (lib/ops/api.ts
 * listPracticeReviews, decidePracticeReview), never by the portal. What
 * crosses is synthetic: the cases the questions asked, what AYA answered,
 * what the checks and the judge made of it, ids and dates. No patient is in
 * any of it.
 *
 * A decision:
 *   - pass: the run passes, as if the questions had: its channels' results
 *     are passed, the agent script's version it read is approved if it is
 *     still current, and O8 follows once the tracker is complete;
 *   - fail: the run stays failed, and, when the operator names the section
 *     the clinic must fix, O9 tells the clinic what to fix and where.
 * Either is recorded with the operator's address, in the review, the
 * tenant's audit row and the ops envelope's security event.
 */

const LIST_DECIDED_DAYS = 14;
const MAX_LISTED = 100;

export type ReviewCase = Pick<
  PracticeCaseResult,
  "id" | "status" | "asked" | "answered" | "sources" | "checks" | "judge"
> & {
  channel: Channel;
};

export type ReviewEntry = {
  id: string;
  clinicId: string;
  clinicSlug: string;
  clinicName: string;
  runId: string;
  status: AuditReviewStatus;
  createdAt: string;
  dueOn: string;
  pastDue: boolean;
  decidedAt: string | null;
  decidedByLabel: string | null;
  section: PracticeSection | null;
  /** The cases that sent the run here: failed, or for the judge to decide. */
  cases: ReviewCase[];
};

/** Open reviews first, soonest due; then those decided in the last two weeks, newest first. */
export async function listPracticeReviews(input: {
  now?: Date;
  actor: ActorContext;
  request?: RequestContext;
}): Promise<ReviewEntry[]> {
  const now = input.now ?? new Date();
  const since = new Date(now.getTime() - LIST_DECIDED_DAYS * 24 * 60 * 60 * 1000);
  const entries: ReviewEntry[] = [];
  for (const clinic of await listClinics()) {
    const rows = await withTenant(
      { clinicId: clinic.id, actor: input.actor, request: input.request },
      async (tx) => {
        const reviews = await tx.db
          .select()
          .from(auditReviewQueue)
          .where(
            and(
              eq(auditReviewQueue.clinicId, tx.clinicId),
              // The practice questions' reviews only: the agreement-kind
              // signal shares the queue and has its own reader
              // (lib/agreements/misclassification.ts).
              eq(auditReviewQueue.kind, "practice_questions"),
              isNotNull(auditReviewQueue.runId),
              ne(auditReviewQueue.status, "superseded"),
              or(eq(auditReviewQueue.status, "open"), gt(auditReviewQueue.createdAt, since)),
            ),
          )
          .orderBy(desc(auditReviewQueue.createdAt))
          .limit(MAX_LISTED);
        const runReviews = reviews.flatMap((r) => (r.runId ? [{ ...r, runId: r.runId }] : []));
        if (runReviews.length === 0) return [];
        const results = await tx.db
          .select({
            runId: practiceQuestionResults.runId,
            channel: practiceQuestionResults.channel,
            cases: practiceQuestionResults.cases,
          })
          .from(practiceQuestionResults)
          .where(
            and(
              eq(practiceQuestionResults.clinicId, tx.clinicId),
              inArray(
                practiceQuestionResults.runId,
                runReviews.map((r) => r.runId),
              ),
            ),
          );
        return runReviews.map((review) => ({
          review,
          results: results.filter((r) => r.runId === review.runId),
        }));
      },
    );
    for (const { review, results } of rows) {
      entries.push({
        id: review.id,
        clinicId: clinic.id,
        clinicSlug: clinic.slug,
        clinicName: clinic.name,
        runId: review.runId,
        status: review.status,
        createdAt: review.createdAt.toISOString(),
        dueOn: review.dueOn,
        pastDue: review.status === "open" && review.dueAt.getTime() < now.getTime(),
        decidedAt: review.decidedAt?.toISOString() ?? null,
        decidedByLabel: review.decidedByLabel,
        section: review.section,
        cases: results.flatMap((r) =>
          r.cases
            .filter((c) => c.status === "failed" || c.status === "review")
            .map((c) => ({
              channel: r.channel,
              id: c.id,
              status: c.status,
              asked: c.asked,
              answered: c.answered,
              sources: c.sources,
              checks: c.checks,
              ...(c.judge ? { judge: c.judge } : {}),
            })),
        ),
      });
    }
  }
  return entries
    .sort((a, b) => {
      if ((a.status === "open") !== (b.status === "open")) return a.status === "open" ? -1 : 1;
      return a.status === "open"
        ? a.dueOn.localeCompare(b.dueOn) || a.createdAt.localeCompare(b.createdAt)
        : b.createdAt.localeCompare(a.createdAt);
    })
    .slice(0, MAX_LISTED);
}

async function slugOf(tx: TenantTx): Promise<string> {
  const [row] = await tx.db
    .select({ slug: clinics.slug })
    .from(clinics)
    .where(eq(clinics.id, tx.clinicId))
    .limit(1);
  return row?.slug ?? "";
}

export type ReviewDecision = "pass" | "fail";

export type DecideOutcome =
  { status: "updated"; decision: ReviewDecision } | { status: "refused"; message: string };

export async function decidePracticeReview(input: {
  clinicId: string;
  reviewId: string;
  decision: ReviewDecision;
  /** For a failure the clinic must fix: the section O9 names. */
  section?: PracticeSection | null;
  operatorLabel: string;
  actor: ActorContext;
  request?: RequestContext;
  now?: Date;
}): Promise<DecideOutcome> {
  const now = input.now ?? new Date();
  return withTenant(
    { clinicId: input.clinicId, actor: input.actor, request: input.request },
    async (tx) => {
      const [review] = await tx.db
        .select()
        .from(auditReviewQueue)
        .where(
          and(
            eq(auditReviewQueue.id, input.reviewId),
            eq(auditReviewQueue.clinicId, tx.clinicId),
            eq(auditReviewQueue.kind, "practice_questions"),
          ),
        )
        .for("update")
        .limit(1);
      if (!review || !review.runId) {
        return { status: "refused", message: "No such review at this clinic." };
      }
      const runId = review.runId;
      if (review.status !== "open") {
        return {
          status: "refused",
          message:
            review.status === "superseded"
              ? "A later run of the practice questions replaced this review: decide that one instead."
              : "This review has been decided already.",
        };
      }
      const [run] = await tx.db
        .select()
        .from(practiceQuestionRuns)
        .where(
          and(eq(practiceQuestionRuns.id, runId), eq(practiceQuestionRuns.clinicId, tx.clinicId)),
        )
        .limit(1);
      if (!run) return { status: "refused", message: "The run this review is about is not there." };
      const label = input.operatorLabel.slice(0, 200);
      const results = await tx.db
        .select({
          id: practiceQuestionResults.id,
          channel: practiceQuestionResults.channel,
          status: practiceQuestionResults.status,
          cases: practiceQuestionResults.cases,
        })
        .from(practiceQuestionResults)
        .where(eq(practiceQuestionResults.runId, run.id));

      if (input.decision === "pass") {
        await tx.db
          .update(auditReviewQueue)
          .set({ status: "passed", decidedAt: now, decidedByLabel: label })
          .where(eq(auditReviewQueue.id, review.id));
        await tx.db
          .update(practiceQuestionRuns)
          .set({ status: "passed" })
          .where(eq(practiceQuestionRuns.id, run.id));
        for (const result of results) {
          if (result.status !== "error") {
            await tx.db
              .update(practiceQuestionResults)
              .set({ status: "passed" })
              .where(eq(practiceQuestionResults.id, result.id));
          }
        }
        await afterPass(tx, {
          runId: run.id,
          agentVersion: run.agentVersion,
          slug: await slugOf(tx),
          channels: results.filter((r) => r.status !== "error").map((r) => r.channel),
          now,
        });
      } else {
        const count = results.reduce(
          (n, r) =>
            n + r.cases.filter((c) => c.status === "failed" || c.status === "review").length,
          0,
        );
        const section = input.section ?? null;
        await tx.db
          .update(auditReviewQueue)
          .set({ status: "failed", decidedAt: now, decidedByLabel: label, section })
          .where(eq(auditReviewQueue.id, review.id));
        await tx.db
          .update(practiceQuestionRuns)
          .set({
            status: "failed",
            failedSection: section,
            failedCount: section ? Math.max(1, count) : null,
          })
          .where(eq(practiceQuestionRuns.id, run.id));
        if (section && run.inputVersion) {
          await enqueuePlanNotice(
            tx.db,
            tx.clinicId,
            "practice_questions_failed",
            `practice_questions_failed:${run.inputVersion}`,
            {
              section,
              count: Math.max(1, count),
              fixUrl: publicUrl(sectionPath(await slugOf(tx), section)),
            },
          );
        }
      }
      tx.audit.record({
        action: "update",
        resourceType: "audit_review",
        resourceId: review.id,
        metadata: { decision: input.decision, section: input.section ?? null, runId: run.id },
      });
      return { status: "updated", decision: input.decision };
    },
  );
}

/** An operator asks for the questions again (after a fix on our side): queued like any change. */
export async function rerunPracticeQuestions(input: {
  clinicId: string;
  actor: ActorContext;
  request?: RequestContext;
  now?: Date;
}): Promise<void> {
  await withTenant({ clinicId: input.clinicId, actor: input.actor, request: input.request }, (tx) =>
    requestPracticeQuestions(tx, { reason: "ops", now: input.now }),
  );
}
