"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { ENGINES, PANEL_QUESTIONS } from "@/lib/admin/seo/panel";
import { WHEN_LABEL, type OwnerStep, type StepWhen } from "@/lib/admin/seo/steps";

/**
 * The three things /admin/seo lets the operator do: tick a step, log what an
 * AI engine answered, and tell the search engines the site changed. Each calls
 * a server action defined in page.tsx that re-checks the session; nothing
 * here is trusted for more than which button was pressed.
 */

type Outcome = { ok: true } | { ok: false; message: string };

const ORDER: readonly StepWhen[] = ["today", "week", "ongoing"];

export function StepList({
  steps,
  ticks,
  canSave,
  tick,
}: {
  steps: readonly OwnerStep[];
  ticks: Record<string, boolean>;
  canSave: boolean;
  tick: (stepId: string, done: boolean) => Promise<Outcome>;
}) {
  const [optimistic, setOptimistic] = useState<Record<string, boolean>>({});
  const [problem, setProblem] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const done = (id: string) => optimistic[id] ?? ticks[id] ?? false;

  return (
    <div className="mt-4 grid gap-5">
      {problem ? (
        <p role="alert" className="text-red-deep text-sm">
          {problem}
        </p>
      ) : null}
      {ORDER.map((when) => {
        const group = steps.filter((step) => step.when === when);
        if (group.length === 0) return null;
        const left = group.filter((step) => !done(step.id)).length;
        return (
          <div key={when}>
            <h3 className="text-muted text-xs font-bold tracking-[0.06em] uppercase">
              {WHEN_LABEL[when]} <span className="font-normal normal-case">({left} left)</span>
            </h3>
            <ul className="mt-2 grid gap-1">
              {group.map((step) => {
                const checked = done(step.id);
                return (
                  <li key={step.id} className="flex items-start gap-3 py-1 text-sm">
                    <input
                      id={`step-${step.id}`}
                      type="checkbox"
                      className="mt-0.5 size-5 shrink-0 accent-[#5A9A16]"
                      checked={checked}
                      disabled={!canSave || pending}
                      onChange={(event) => {
                        const next = event.target.checked;
                        setOptimistic((current) => ({ ...current, [step.id]: next }));
                        setProblem(null);
                        start(async () => {
                          const outcome = await tick(step.id, next);
                          if (!outcome.ok) {
                            setOptimistic((current) => ({ ...current, [step.id]: !next }));
                            setProblem(outcome.message);
                          }
                        });
                      }}
                    />
                    <label htmlFor={`step-${step.id}`} className={checked ? "text-muted line-through" : ""}>
                      {step.text}
                      <span className="text-muted mt-0.5 block text-xs no-underline">
                        <a
                          className="underline underline-offset-2"
                          href={step.href}
                          {...(step.href.startsWith("#") ? {} : { target: "_blank", rel: "noreferrer" })}
                        >
                          {step.where}
                        </a>{" "}
                        · {step.time}
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
    </div>
  );
}

export function RecheckButton() {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <button
      type="button"
      disabled={pending}
      onClick={() => start(() => router.refresh())}
      className="border-line-strong min-h-9 rounded-full border px-3 py-1 text-xs font-bold disabled:opacity-60"
    >
      {pending ? "Checking..." : "Check again"}
    </button>
  );
}

export function IndexNowButton({ ping }: { ping: () => Promise<Outcome & { sent?: number }> }) {
  const [pending, start] = useTransition();
  const [result, setResult] = useState<string | null>(null);
  return (
    <span className="flex items-center gap-2">
      <button
        type="button"
        disabled={pending}
        onClick={() =>
          start(async () => {
            const outcome = await ping();
            setResult(outcome.ok ? `Sent ${String(outcome.sent ?? 0)} URLs to Bing and the other IndexNow engines.` : outcome.message);
          })
        }
        className="border-line-strong min-h-9 rounded-full border px-3 py-1 text-xs font-bold disabled:opacity-60"
      >
        {pending ? "Sending..." : "Ping IndexNow"}
      </button>
      {result ? (
        <span role="status" className="text-muted text-xs">
          {result}
        </span>
      ) : null}
    </span>
  );
}

export function PanelLogForm({
  canSave,
  log,
}: {
  canSave: boolean;
  log: (entry: { engine: string; questionId: string; named: boolean; cited: boolean; sources: string; ranOn: string }) => Promise<Outcome>;
}) {
  const [pending, start] = useTransition();
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const today = new Date().toISOString().slice(0, 10);

  return (
    <form
      className="border-line mt-5 grid gap-3 rounded-md border p-4 sm:grid-cols-2"
      onSubmit={(event) => {
        event.preventDefault();
        const form = event.currentTarget;
        const data = new FormData(form);
        const entry = {
          engine: String(data.get("engine") ?? ""),
          questionId: String(data.get("questionId") ?? ""),
          named: data.get("named") === "on",
          cited: data.get("cited") === "on",
          sources: String(data.get("sources") ?? ""),
          ranOn: String(data.get("ranOn") ?? today),
        };
        setMessage(null);
        start(async () => {
          const outcome = await log(entry);
          if (outcome.ok) {
            setMessage({ ok: true, text: "Logged. The grid updates with it." });
            const keep = { engine: entry.engine, ranOn: entry.ranOn };
            form.reset();
            (form.elements.namedItem("engine") as HTMLSelectElement).value = keep.engine;
            (form.elements.namedItem("ranOn") as HTMLInputElement).value = keep.ranOn;
          } else {
            setMessage({ ok: false, text: outcome.message });
          }
        });
      }}
    >
      <h3 className="text-sm font-bold sm:col-span-2">Log an answer</h3>
      <p className="text-muted -mt-2 text-xs sm:col-span-2">
        Ask the engine the question in a fresh, signed-out chat, then record whether the answer named healdesk and whether it linked healdesk.io.
      </p>
      <label className="grid gap-1 text-sm">
        <span className="font-semibold">Engine</span>
        <select name="engine" required className="border-line min-h-11 rounded-md border bg-white px-2">
          {ENGINES.map((engine) => (
            <option key={engine.id} value={engine.id}>
              {engine.label}
            </option>
          ))}
        </select>
      </label>
      <label className="grid gap-1 text-sm">
        <span className="font-semibold">Asked on</span>
        <input name="ranOn" type="date" defaultValue={today} max={today} required className="border-line min-h-11 rounded-md border bg-white px-2" />
      </label>
      <label className="grid gap-1 text-sm sm:col-span-2">
        <span className="font-semibold">Question</span>
        <select name="questionId" required className="border-line min-h-11 rounded-md border bg-white px-2">
          {PANEL_QUESTIONS.map((question) => (
            <option key={question.id} value={question.id}>
              {question.text}
            </option>
          ))}
        </select>
      </label>
      <div className="flex flex-wrap gap-5 text-sm sm:col-span-2">
        <label className="flex min-h-11 items-center gap-2">
          <input name="named" type="checkbox" className="size-5 accent-[#5A9A16]" /> Named healdesk
        </label>
        <label className="flex min-h-11 items-center gap-2">
          <input name="cited" type="checkbox" className="size-5 accent-[#5A9A16]" /> Linked healdesk.io
        </label>
      </div>
      <label className="grid gap-1 text-sm sm:col-span-2">
        <span className="font-semibold">Sources it cited (optional, one URL per line)</span>
        <textarea name="sources" rows={3} className="border-line rounded-md border bg-white p-2 font-mono text-xs" />
      </label>
      <div className="flex flex-wrap items-center gap-3 sm:col-span-2">
        <button
          type="submit"
          disabled={!canSave || pending}
          className="bg-ink min-h-11 rounded-full px-5 text-sm font-bold text-white disabled:opacity-60"
        >
          {pending ? "Saving..." : "Log it"}
        </button>
        {message ? (
          <span role="status" className={`text-sm font-semibold ${message.ok ? "" : "text-red-deep"}`} style={message.ok ? { color: "#5A9A16" } : undefined}>
            {message.text}
          </span>
        ) : null}
      </div>
    </form>
  );
}
