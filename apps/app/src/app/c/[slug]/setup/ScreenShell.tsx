"use client";

import { useId, useState, type ReactNode } from "react";

import { saveScreen, skipScreen, type ScreenActionResult } from "./actions";

/**
 * One setup screen's frame (plan Part E): its question, the fields the
 * screen brings, "Save and continue", and "Skip for now" with what skipping
 * costs said beside it (spec, "No dead ends"). Saving and skipping go
 * through the server actions, which record the screen and say where to go
 * next; the browser then navigates there, so every screen renders from what
 * is saved, never from what a tab remembers.
 */

type Problem = { field: string; message: string; stepUpHref?: string };

export function ScreenShell(props: {
  slug: string;
  screen: string;
  title: string;
  intro?: ReactNode;
  /**
   * What comes between the intro and the screen's fields, outside its form,
   * so it may hold forms of its own (the calendar step's Sign in with Google
   * and Disconnect): a form cannot sit inside another.
   */
  lead?: ReactNode;
  /** What skipping this screen costs, in one sentence. */
  skipCost: string;
  backHref: string | null;
  /** Reads the screen's fields at the moment Save is pressed. */
  payload: () => unknown;
  submitLabel?: string;
  /** False for a screen with nothing to skip, like the channels overview. */
  skippable?: boolean;
  children?: ReactNode;
}) {
  const [working, setWorking] = useState<"save" | "skip" | null>(null);
  const [problem, setProblem] = useState<Problem | null>(null);
  const statusId = useId();
  const skipCostId = useId();

  async function run(action: () => Promise<ScreenActionResult>, which: "save" | "skip") {
    setWorking(which);
    setProblem(null);
    try {
      const result = await action();
      if (result.ok) {
        window.location.assign(result.next);
        return;
      }
      setProblem(result);
    } catch {
      setProblem({
        field: "",
        message: "Something went wrong on our side. Try again in a moment.",
      });
    }
    setWorking(null);
  }

  return (
    <>
      {/* Back sits above the title, top left, as the checkout's StepShell
          puts it (30 October 2026): the way back is read before the question,
          not found under the buttons after it. */}
      {props.backHref ? (
        <p className="mb-3 text-sm">
          <a
            href={props.backHref}
            className="text-muted hover:text-ink -ml-2 inline-flex min-h-11 items-center rounded-sm px-2 font-semibold"
          >
            ← Back
          </a>
        </p>
      ) : null}
      <h1 className="text-2xl font-semibold">{props.title}</h1>
      {props.intro ? <div className="text-muted mt-3 space-y-2">{props.intro}</div> : null}
      {props.lead ? <div className="mt-6 grid gap-5">{props.lead}</div> : null}
      <form
        noValidate
        aria-describedby={statusId}
        onSubmit={(event) => {
          event.preventDefault();
          void run(() => saveScreen(props.slug, props.screen, props.payload()), "save");
        }}
      >
        <div className="mt-6 grid gap-5">{props.children}</div>

        <div
          id={statusId}
          role="status"
          aria-live="polite"
          className={
            problem
              ? "mt-6 rounded-md border border-problem-line bg-white px-4 py-3 text-sm text-problem"
              : "sr-only"
          }
        >
          {problem ? (
            <>
              {problem.message}
              {problem.stepUpHref ? (
                <>
                  {" "}
                  <a href={problem.stepUpHref} className="font-semibold underline">
                    Confirm it&rsquo;s you
                  </a>
                </>
              ) : null}
            </>
          ) : null}
        </div>

        {/* What skipping costs comes before the buttons, and the Skip button
            names it (aria-describedby), so it is read before the choice is
            made and not after. */}
        {props.skippable === false ? null : (
          <p id={skipCostId} className="text-muted mt-6 text-sm">
            If you skip: {props.skipCost}
          </p>
        )}
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <button
            type="submit"
            disabled={working !== null}
            className="bg-ink min-h-11 rounded-full px-6 py-3 text-sm font-bold text-white disabled:opacity-50"
          >
            {working === "save" ? "Saving…" : (props.submitLabel ?? "Save and continue")}
          </button>
          {props.skippable === false ? null : (
            <button
              type="button"
              disabled={working !== null}
              aria-describedby={skipCostId}
              onClick={() => void run(() => skipScreen(props.slug, props.screen), "skip")}
              className="border-line min-h-11 rounded-full border px-5 py-3 text-sm font-semibold disabled:opacity-50"
            >
              {working === "skip" ? "Skipping…" : "Skip for now"}
            </button>
          )}
        </div>
      </form>
    </>
  );
}

/**
 * What a field offers to fill in when the screen does not say: a phone
 * number, a web address or an email address by its type, since each is a
 * value the browser already keeps and the spec asks that nothing be typed
 * twice. A plain text field offers nothing: a greeting or a question has no
 * stored value worth suggesting.
 */
const AUTOCOMPLETE_BY_TYPE: Record<"text" | "tel" | "url" | "email", string> = {
  text: "off",
  tel: "tel",
  url: "url",
  email: "email",
};

/** A labelled text input, the wizard's one style of field. */
export function Field(props: {
  label: string;
  hint?: string;
  value: string;
  onChange: (value: string) => void;
  type?: "text" | "tel" | "url" | "email";
  autoComplete?: string;
  inputMode?: "text" | "tel" | "decimal" | "numeric";
  maxLength?: number;
  multiline?: boolean;
  /** What an empty field stands for, such as a default number; the hint says it too. */
  placeholder?: string;
}) {
  const id = useId();
  const hintId = useId();
  const common = {
    id,
    value: props.value,
    maxLength: props.maxLength,
    placeholder: props.placeholder || undefined,
    "aria-describedby": props.hint ? hintId : undefined,
    className: "border-line w-full rounded-md border bg-white px-4 py-3 text-base",
  };
  return (
    <div className="grid gap-1">
      <label htmlFor={id} className="text-sm font-semibold">
        {props.label}
      </label>
      {props.multiline ? (
        <textarea {...common} rows={3} onChange={(event) => props.onChange(event.target.value)} />
      ) : (
        <input
          {...common}
          type={props.type ?? "text"}
          autoComplete={props.autoComplete ?? AUTOCOMPLETE_BY_TYPE[props.type ?? "text"]}
          inputMode={props.inputMode}
          onChange={(event) => props.onChange(event.target.value)}
        />
      )}
      {props.hint ? (
        <p id={hintId} className="text-muted text-xs">
          {props.hint}
        </p>
      ) : null}
    </div>
  );
}

/** A set of radio choices with one line under each (spec: every switch says what it does). */
export function Choice<T extends string>(props: {
  legend: string;
  value: T;
  onChange: (value: T) => void;
  options: readonly { id: T; label: string; line?: string; disabled?: boolean }[];
  /** Id of an explainer beside the choices, read out with each radio. */
  describedBy?: string;
}) {
  const name = useId();
  return (
    <fieldset className="grid gap-2">
      <legend className="mb-1 text-sm font-semibold">{props.legend}</legend>
      {props.options.map((option) => {
        const id = `${name}-${option.id}`;
        return (
          <label
            key={option.id}
            htmlFor={id}
            className={`border-line flex min-h-11 gap-3 rounded-md border bg-white px-4 py-3 ${option.disabled ? "opacity-60" : "cursor-pointer"}`}
          >
            <input
              id={id}
              type="radio"
              name={name}
              value={option.id}
              checked={props.value === option.id}
              disabled={option.disabled}
              aria-describedby={props.describedBy}
              onChange={() => props.onChange(option.id)}
              className="mt-1"
            />
            <span>
              <span className="block font-semibold">{option.label}</span>
              {option.line ? <span className="text-muted block text-sm">{option.line}</span> : null}
            </span>
          </label>
        );
      })}
    </fieldset>
  );
}
