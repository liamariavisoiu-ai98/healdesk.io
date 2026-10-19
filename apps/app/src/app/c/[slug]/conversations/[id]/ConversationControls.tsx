"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { useAnnounce } from "../../feedback";
import { exportPersonAction, flagAnswerAction, sendAgainAction } from "../actions";
import { downloadJson } from "../download";

/**
 * The open conversation's actions (plan Part F4): "Flag this answer" with
 * its optional correction, "Send again", while the transcript's delivery is
 * not confirmed, and the export of the person's records. Each runs behind
 * the step-up on the server and writes the access log; this only asks, says
 * what happened in the portal's status region, and reads the page again so
 * it shows where things now stand.
 */

/**
 * "Flag this answer" (spec: "One click, optional note"): one button, and two
 * optional boxes for the right answer, which goes into Quick answers. With
 * the conversation flagged already and no correction yet, the same boxes add
 * one. A refused correction names what was refused, and offers the text
 * without it when that passes, as Knowledge does.
 */
export function FlagAnswer(props: {
  slug: string;
  conversationId: string;
  /** Flagged already, with no correction: the boxes add one. */
  flagged: boolean;
  audience: "patients" | "clients";
}) {
  const announce = useAnnounce();
  const router = useRouter();
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState("");
  const [problem, setProblem] = useState<{
    message: string;
    field?: string;
    rewrite?: string;
  } | null>(null);
  const [working, setWorking] = useState(false);
  const person = props.audience === "clients" ? "client" : "patient";
  const empty = question.trim() === "" && answer.trim() === "";

  async function flag(): Promise<void> {
    setWorking(true);
    setProblem(null);
    try {
      const result = await flagAnswerAction(props.slug, props.conversationId, { question, answer });
      if (result.ok) {
        announce({ text: result.message, tone: "ok" });
        setQuestion("");
        setAnswer("");
        router.refresh();
      } else {
        setProblem({ message: result.message, field: result.field, rewrite: result.rewrite });
        announce({ text: result.message, tone: "problem" });
      }
    } catch {
      announce({ text: "That didn't reach us. Try again.", tone: "problem" });
    } finally {
      setWorking(false);
    }
  }

  return (
    <form
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void flag();
      }}
      className="mt-3 grid gap-3"
    >
      <p id="flag-correction-note" className="text-muted text-sm">
        {props.flagged ? "Add" : "Optional: add"} the right answer and it goes into your Quick
        answers, where you can change it later. Write it the way AYA should answer anyone: no names,
        numbers or details of this {person}.
      </p>
      <label htmlFor="flag-question" className="text-sm font-semibold">
        The question, in general terms
      </label>
      <input
        id="flag-question"
        value={question}
        onChange={(e) => setQuestion(e.target.value)}
        maxLength={300}
        autoComplete="off"
        placeholder="e.g. Do you open on Saturdays?"
        aria-describedby="flag-correction-note"
        aria-invalid={problem?.field === "question" ? true : undefined}
        className="border-line min-h-11 rounded-xl border bg-white px-3"
      />
      <label htmlFor="flag-answer" className="text-sm font-semibold">
        What AYA should answer
      </label>
      <textarea
        id="flag-answer"
        value={answer}
        onChange={(e) => setAnswer(e.target.value)}
        maxLength={300}
        rows={3}
        aria-describedby="flag-correction-note"
        aria-invalid={problem?.field === "answer" ? true : undefined}
        className="border-line rounded-xl border bg-white px-3 py-2"
      />
      {problem ? (
        <div className="rounded-xl border border-red-200 bg-white px-4 py-3 text-sm">
          <p className="text-red-800">{problem.message}</p>
          {problem.rewrite ? (
            <button
              type="button"
              onClick={() => {
                if (problem.field === "question") setQuestion(problem.rewrite!);
                else setAnswer(problem.rewrite!);
                setProblem(null);
              }}
              className="mt-2 min-h-11 font-semibold underline"
            >
              Use this instead: {problem.rewrite}
            </button>
          ) : null}
        </div>
      ) : null}
      <button
        type="submit"
        disabled={working || (props.flagged && empty)}
        className="bg-ink min-h-11 w-fit rounded-full px-5 text-sm font-bold text-white disabled:opacity-50"
      >
        {working
          ? "Sending…"
          : props.flagged
            ? "Add the correction"
            : empty
              ? "Flag this answer"
              : "Flag this answer and add the correction"}
      </button>
    </form>
  );
}

export function SendAgain(props: { slug: string; conversationId: string }) {
  const announce = useAnnounce();
  const router = useRouter();
  const [working, setWorking] = useState(false);

  async function send(): Promise<void> {
    setWorking(true);
    try {
      const result = await sendAgainAction(props.slug, props.conversationId);
      announce({ text: result.message, tone: result.ok ? "ok" : "problem" });
      router.refresh();
    } catch {
      announce({ text: "That didn't reach us. Try again.", tone: "problem" });
    } finally {
      setWorking(false);
    }
  }

  return (
    <button
      type="button"
      onClick={() => void send()}
      disabled={working}
      aria-describedby="send-again-note"
      className="bg-ink mt-3 min-h-11 rounded-full px-5 text-sm font-bold text-white disabled:opacity-50"
    >
      {working ? "Sending…" : "Send again"}
    </button>
  );
}

export function PersonExport(props: {
  slug: string;
  conversationId: string;
  audience: "patients" | "clients";
  requesters: { value: string; label: string }[];
}) {
  const announce = useAnnounce();
  const [requestedBy, setRequestedBy] = useState(props.requesters[0]?.value ?? "practice");
  const [working, setWorking] = useState(false);
  const person = props.audience === "clients" ? "client" : "patient";

  async function download(): Promise<void> {
    setWorking(true);
    try {
      const result = await exportPersonAction(props.slug, props.conversationId, requestedBy);
      if (result.ok) {
        downloadJson(result.filename, result.body);
        announce({ text: result.message, tone: "ok" });
      } else {
        announce({ text: result.message, tone: "problem" });
      }
    } catch {
      announce({ text: "The export didn't reach you. Try again.", tone: "problem" });
    } finally {
      setWorking(false);
    }
  }

  return (
    <div className="mt-3">
      <p className="text-muted text-sm" id="person-export-note">
        Everything healdesk holds about this {person}, under this name and any record with the same
        number or address, with any amendments and the log of who opened it: what you need to answer
        their request to see their records.
      </p>
      <label htmlFor="person-export-who" className="mt-3 block text-sm font-semibold">
        Who asked
      </label>
      <select
        id="person-export-who"
        value={requestedBy}
        onChange={(e) => setRequestedBy(e.target.value)}
        className="border-line mt-1 min-h-11 w-full rounded-xl border bg-white px-3"
      >
        {props.requesters.map((r) => (
          <option key={r.value} value={r.value}>
            {r.label}
          </option>
        ))}
      </select>
      <button
        type="button"
        onClick={() => void download()}
        disabled={working}
        aria-describedby="person-export-note"
        className="border-ink mt-3 min-h-11 rounded-full border bg-white px-5 text-sm font-bold disabled:opacity-50"
      >
        {working ? "Preparing the export…" : `Download this ${person}'s records`}
      </button>
    </div>
  );
}
