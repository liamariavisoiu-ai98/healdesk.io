import { listPracticeReviews } from "@/lib/engine/practice/review";

import type { InboxRow, InboxSource } from "./types";

/**
 * The practice questions' reviews still open (listPracticeReviews), one row
 * per clinic, due the earliest day promised among them. An open review holds
 * that clinic's channel audit, so it is owed by its day.
 */
export const practiceReviewsSource: InboxSource = {
  name: "the practice reviews",
  async read(ctx) {
    const reviews = await listPracticeReviews({ now: ctx.now, actor: ctx.actor, request: ctx.request });
    const byClinic = new Map<string, { name: string; count: number; dueOn: string; pastDue: boolean }>();
    for (const review of reviews) {
      if (review.status !== "open") continue;
      const seen = byClinic.get(review.clinicId);
      if (!seen) {
        byClinic.set(review.clinicId, {
          name: review.clinicName,
          count: 1,
          dueOn: review.dueOn,
          pastDue: review.pastDue,
        });
        continue;
      }
      seen.count += 1;
      if (review.dueOn < seen.dueOn) seen.dueOn = review.dueOn;
      seen.pastDue ||= review.pastDue;
    }
    const rows: InboxRow[] = [...byClinic].map(([clinicId, r]) => ({
      id: `review:${clinicId}`,
      kind: "practice_review",
      count: r.count,
      sentence: r.pastDue
        ? "Practice question reviews past the day promised."
        : "Practice question reviews to decide.",
      clinic: { id: clinicId, name: r.name },
      button: { label: "Open reviews", kind: "link", href: "/admin/reviews" },
      tone: r.pastDue ? "bad" : "warn",
      dueAt: r.dueOn,
    }));
    return { rows };
  },
};
