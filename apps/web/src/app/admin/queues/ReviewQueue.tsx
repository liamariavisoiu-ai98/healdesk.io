"use client";

import { useState } from "react";

import type {
  OpsResult,
  PracticeReview,
  PracticeReviewOutcome,
  PracticeSection,
} from "@/lib/admin/ops-client";

/**
 * The review queue's rows and their two decisions. Each case shows what the
 * synthetic person asked, what AYA answered on that channel, the checks and
 * the judge's reason. "Pass" passes the run; "Fail" keeps it failed, and a
 * section, when the clinic has something to fix, sends it O9 naming that
 * section and a count (never the service).
 */

const SECTION_LABELS: Record<PracticeSection, string> = {
  practice: "Knowledge → Your practice",
  prices: "Knowledge → Prices",
  policies: "Knowledge → Policies",
  promotions: "Knowledge → Promotions",
  quick_answers: "Knowledge → Quick answers",
  never_say: "Knowledge → Never say",
  hours: "Knowledge → Hours",
  how_aya_talks: "Settings → How AYA talks",
  safety_net: "Settings → Safety net",
};

const CHANNEL_LABELS = {
  web: "Website chat",
  meta: "Instagram, Messenger & WhatsApp",
  voice: "Phone",
} as const;

type Decide = (
  clinicId: string,
  reviewId: string,
  decision: "pass" | "fail",
  section: PracticeSection | null,
) => Promise<OpsResult<PracticeReviewOutcome>>;
type Rerun = (
  clinicId: string,
) => Promise<
  OpsResult<{ status: "updated"; auditRecorded: boolean } | { status: "refused"; message: string }>
>;

export function ReviewQueue({
  reviews,
  decide,
  rerun,
}: {
  reviews: PracticeReview[];
  decide: Decide;
  rerun: Rerun;
}) {
  if (reviews.length === 0) {
    return (
      <p className="text-muted mt-8 text-sm">
        No reviews open, and none decided in the last two weeks.
      </p>
    );
  }
  return (
    <ul className="mt-8 grid gap-4">
      {reviews.map((review) => (
        <ReviewRow key={review.id} review={review} decide={decide} rerun={rerun} />
      ))}
    </ul>
  );
}

function ReviewRow({
  review,
  decide,
  rerun,
}: {
  review: PracticeReview;
  decide: Decide;
  rerun: Rerun;
}) {
  const [section, setSection] = useState<PracticeSection | "">("");
  const [pending, setPending] = useState(false);
  const [answer, setAnswer] = useState<{ ok: boolean; text: string } | null>(null);
  const open = review.status === "open";

  async function send(
    run: () => Promise<OpsResult<{ status: string; message?: string; auditRecorded?: boolean }>>,
    done: string,
  ) {
    setPending(true);
    setAnswer(null);
    try {
      const result = await run();
      if (!result.ok) setAnswer({ ok: false, text: result.message });
      else if (result.data.status !== "updated")
        setAnswer({ ok: false, text: result.data.message ?? "Refused." });
      else
        setAnswer({
          ok: true,
          text:
            result.data.auditRecorded === false ? `${done} It is not in the security log.` : done,
        });
    } catch {
      setAnswer({ ok: false, text: "This page could not reach its own action. Try again." });
    } finally {
      setPending(false);
    }
  }

  return (
    <li className="border-line rounded-md border bg-white p-5">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="text-[19.2px] font-bold">{review.clinicName}</h2>
        <span className="text-muted text-sm">{review.clinicSlug}</span>
        <span className={review.pastDue ? "text-red-deep text-sm font-bold" : "text-muted text-sm"}>
          {open
            ? `Due ${review.dueOn}${review.pastDue ? ": past due" : ""}`
            : `${review.status} ${review.decidedAt?.at ?? ""} by ${review.decidedByLabel ?? "?"}`}
        </span>
      </div>
      <p className="text-muted mt-1 text-sm">
        Opened {review.createdAt.at}. Run {review.runId}.
      </p>

      <ul className="mt-4 grid gap-3">
        {review.cases.map((c, i) => (
          <li
            key={`${c.channel}-${c.id}-${i}`}
            className="border-line rounded-md border px-4 py-3 text-sm"
          >
            <p className="font-bold">
              {CHANNEL_LABELS[c.channel]}: {c.id.replace(/_/g, " ")}{" "}
              <span className="text-muted font-normal">
                ({c.status === "review" ? "for review" : "failed a check"})
              </span>
            </p>
            {c.asked.map((text, t) => (
              <div key={t} className="mt-2">
                <p>
                  <span className="text-muted">Asked: </span>
                  {text}
                </p>
                {c.answered[t] !== undefined ? (
                  <p className="mt-1 whitespace-pre-wrap">
                    <span className="text-muted">AYA: </span>
                    {c.answered[t]}
                  </p>
                ) : null}
              </div>
            ))}
            {c.asked.length === 0 && c.answered[0] ? (
              <p className="mt-2 whitespace-pre-wrap">
                <span className="text-muted">Opens with: </span>
                {c.answered[0]}
              </p>
            ) : null}
            <ul className="mt-2">
              {c.checks.map((check, k) => (
                <li key={k} className={check.ok ? "text-muted" : "text-red-deep font-semibold"}>
                  {check.ok ? "✓" : "✗"} {check.name.replace(/_/g, " ")}
                  {check.detail ? `: ${check.detail}` : ""}
                </li>
              ))}
            </ul>
            {c.judge ? (
              <p className="mt-2">
                <span className="text-muted">Judge ({c.judge.verdict}): </span>
                {c.judge.reason}
              </p>
            ) : null}
          </li>
        ))}
      </ul>

      {open ? (
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button
            type="button"
            disabled={pending}
            onClick={() =>
              send(
                () => decide(review.clinicId, review.id, "pass", null),
                "Passed: the script it read is approved.",
              )
            }
            className="inline-flex min-h-11 items-center rounded-full bg-black px-5 py-2 text-sm font-bold text-white disabled:opacity-50"
          >
            Pass
          </button>
          <label className="text-sm">
            <span className="sr-only">The section the clinic must fix</span>
            <select
              value={section}
              onChange={(e) => setSection(e.target.value as PracticeSection | "")}
              className="border-line-strong min-h-11 rounded-md border px-3 text-sm"
            >
              <option value="">Fail: ours to fix</option>
              {(Object.keys(SECTION_LABELS) as PracticeSection[]).map((s) => (
                <option key={s} value={s}>
                  Fail: the clinic fixes {SECTION_LABELS[s]}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            disabled={pending}
            onClick={() =>
              send(
                () => decide(review.clinicId, review.id, "fail", section || null),
                section
                  ? "Failed: the clinic is emailed what to fix."
                  : "Failed: fix it on our side, then ask for a run again.",
              )
            }
            className="border-red-deep text-red-deep inline-flex min-h-11 items-center rounded-full border px-5 py-2 text-sm font-bold disabled:opacity-50"
          >
            Fail
          </button>
        </div>
      ) : review.status === "failed" && !review.section ? (
        <div className="mt-4">
          <button
            type="button"
            disabled={pending}
            onClick={() =>
              send(
                () => rerun(review.clinicId),
                "Asked for: the questions run again in about two minutes.",
              )
            }
            className="border-line-strong inline-flex min-h-11 items-center rounded-full border px-5 py-2 text-sm font-bold disabled:opacity-50"
          >
            Run the questions again
          </button>
        </div>
      ) : null}
      {answer ? (
        <p
          role="status"
          className={answer.ok ? "mt-3 text-sm" : "text-red-deep mt-3 text-sm font-semibold"}
        >
          {answer.text}
        </p>
      ) : null}
    </li>
  );
}
