"use client";

import { useState } from "react";

import { CodeField, isCompleteCode } from "@/components/admin/ui";

import type {
  AgreementReview,
  CoveredAnswer,
  OpsResult,
  SetCoveredEntityOutcome,
} from "@/lib/admin/ops-client";

/**
 * The misclassification signal's reviews (plan Part L): a practice that
 * signed the Data Protection Agreement as billing no insurance
 * electronically, whose own website says it accepts insurance. Accepting
 * insurance is not billing it, so a person asks the practice, and records its
 * answer here: "No" leaves the DPA in force; "Yes" or "Not sure" pauses AYA
 * and sends the practice its business associate agreement to sign (L22).
 * Either closes the review. Business data only.
 */

type Decide = (
  clinicId: string,
  reviewId: string,
  answer: CoveredAnswer,
  code: string,
) => Promise<OpsResult<SetCoveredEntityOutcome | { status: "code_refused"; message: string }>>;

const ANSWERS: readonly { answer: CoveredAnswer; label: string; done: string }[] = [
  {
    answer: "no",
    label: "No: cash-pay, the DPA stands",
    done: "Recorded: the data protection agreement stays in force.",
  },
  {
    answer: "yes",
    label: "Yes: it bills insurance electronically",
    done: "Recorded: AYA is paused and the practice is sent its BAA to sign.",
  },
  {
    answer: "not_sure",
    label: "Not sure",
    done: "Recorded: AYA is paused and the practice is sent its BAA to sign.",
  },
];

export function AgreementChecks({
  reviews,
  decide,
}: {
  reviews: AgreementReview[];
  decide: Decide;
}) {
  if (reviews.length === 0) {
    return (
      <p className="text-muted mt-4 text-sm">
        No agreement checks open, and none decided in the last two weeks.
      </p>
    );
  }
  return (
    <ul className="mt-4 grid gap-4">
      {reviews.map((review) => (
        <AgreementCheckRow key={review.id} review={review} decide={decide} />
      ))}
    </ul>
  );
}

function AgreementCheckRow({ review, decide }: { review: AgreementReview; decide: Decide }) {
  const [pending, setPending] = useState(false);
  const [answer, setAnswer] = useState<{ ok: boolean; text: string } | null>(null);
  const [code, setCode] = useState("");
  const open = review.status === "open";

  async function send(choice: (typeof ANSWERS)[number]) {
    setPending(true);
    setAnswer(null);
    try {
      const result = await decide(review.clinicId, review.id, choice.answer, code);
      setCode("");
      if (!result.ok) setAnswer({ ok: false, text: result.message });
      else if (result.data.status !== "recorded")
        setAnswer({ ok: false, text: result.data.message });
      else if (result.data.supersedeStarted && !result.data.linkSent)
        setAnswer({
          ok: true,
          text: "Recorded: AYA is paused. Its email did not go yet; the hourly job sends it again.",
        });
      else setAnswer({ ok: true, text: choice.done });
    } catch {
      setAnswer({ ok: false, text: "This page could not reach its own action. Try again." });
    } finally {
      setPending(false);
    }
  }

  return (
    <li className="border-line rounded-md border bg-white p-5">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h3 className="text-[19.2px] font-bold">{review.clinicName}</h3>
        <span className="text-muted text-sm">{review.clinicSlug}</span>
        <span className="text-muted text-sm">
          {open
            ? `Opened ${review.createdAt.at}`
            : `${review.status === "passed" ? "DPA stands" : "BAA sent"} ${review.decidedAt?.at ?? ""} by ${review.decidedByLabel ?? "?"}`}
        </span>
      </div>
      <p className="text-muted mt-1 text-sm">
        Signed the data protection agreement as billing no insurance electronically; its website
        says it accepts insurance. Ask the practice whether it, or a billing service for it, sends
        claims to insurers electronically.
      </p>
      {open ? (
        <div className="mt-4 flex flex-wrap items-end gap-3">
          <CodeField value={code} onChange={setCode} disabled={pending} />
          {ANSWERS.map((choice) => (
            <button
              key={choice.answer}
              type="button"
              disabled={pending || !isCompleteCode(code)}
              onClick={() => send(choice)}
              className="border-line-strong inline-flex min-h-11 items-center rounded-full border px-5 py-2 text-sm font-bold disabled:opacity-50"
            >
              {choice.label}
            </button>
          ))}
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
