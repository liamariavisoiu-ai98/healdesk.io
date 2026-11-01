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
        <p className="-mt-2 mb-2 text-[15px]">
          <a
            href={props.backHref}
            className="text-muted hover:text-ink -ml-2 inline-flex min-h-11 items-center rounded-sm px-2 font-semibold"
          >
            ← Back
          </a>
        </p>
      ) : null}
      <ScreenTitle>{props.title}</ScreenTitle>
      {props.intro ? <ScreenIntro>{props.intro}</ScreenIntro> : null}
      {props.lead ? <div className="mt-7 grid gap-5">{props.lead}</div> : null}
      <form
        noValidate
        aria-describedby={statusId}
        onSubmit={(event) => {
          event.preventDefault();
          void run(() => saveScreen(props.slug, props.screen, props.payload()), "save");
        }}
      >
        {props.children ? <div className="mt-7 grid gap-6">{props.children}</div> : null}

        <div
          id={statusId}
          role="status"
          aria-live="polite"
          className={problem ? "wz-problem mt-7" : "sr-only"}
        >
          {problem ? (
            <>
              <ProblemGlyph />
              <span>
                {problem.message}
                {problem.stepUpHref ? (
                  <>
                    {" "}
                    <a href={problem.stepUpHref} className="font-semibold underline">
                      Confirm it&rsquo;s you
                    </a>
                  </>
                ) : null}
              </span>
            </>
          ) : null}
        </div>

        {/* What skipping costs comes before the buttons, and the Skip button
            names it (aria-describedby), so it is read before the choice is
            made and not after. */}
        {props.skippable === false ? null : (
          <p id={skipCostId} className="text-muted mt-8 text-sm text-pretty">
            If you skip: {props.skipCost}
          </p>
        )}
        {/* The sign-in pages' pills: full width on a phone, the primary on
            top, and side by side from a tablet up. */}
        <div
          className={`grid gap-3 sm:flex sm:flex-wrap sm:items-center ${props.skippable === false ? "mt-8" : "mt-4"}`}
        >
          <button type="submit" disabled={working !== null} className="si-primary sm:w-auto sm:px-8">
            {working === "save" ? "Saving…" : (props.submitLabel ?? "Save and continue")}
          </button>
          {props.skippable === false ? null : (
            <button
              type="button"
              disabled={working !== null}
              aria-describedby={skipCostId}
              onClick={() => void run(() => skipScreen(props.slug, props.screen), "skip")}
              className="si-secondary sm:w-auto sm:px-6"
            >
              {working === "skip" ? "Skipping…" : "Skip for now"}
            </button>
          )}
        </div>
      </form>
    </>
  );
}

/** A screen's question, in the sign-in card's heading type: large and tight. */
export function ScreenTitle({ children }: { children: ReactNode }) {
  return (
    <h1 className="text-[26px] leading-[1.15] font-semibold tracking-[-0.022em] text-balance sm:text-[30px]">
      {children}
    </h1>
  );
}

/** The lines under the question, at the sign-in card's 17px. */
export function ScreenIntro({ children }: { children: ReactNode }) {
  return <div className="text-muted mt-3 space-y-2 text-[17px] leading-[1.47] text-pretty">{children}</div>;
}

/** The sign-in pages' problem glyph, only repeating what the words say. */
function ProblemGlyph() {
  return (
    <svg viewBox="0 0 20 20" width="16" height="16" fill="currentColor" aria-hidden="true" className="mt-0.5 shrink-0">
      <path
        fillRule="evenodd"
        d="M10 18a8 8 0 1 0 0-16 8 8 0 0 0 0 16Zm.75-11.25a.75.75 0 0 0-1.5 0v4.5a.75.75 0 0 0 1.5 0v-4.5ZM10 14.75a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z"
        clipRule="evenodd"
      />
    </svg>
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
  };
  return (
    <div className="grid gap-1.5">
      <label htmlFor={id} className="px-1 text-sm font-semibold">
        {props.label}
      </label>
      {/* The sign-in pages' field (.si-input); a box of several lines grows
          from three rather than keeping the one-line height. */}
      {props.multiline ? (
        <textarea
          {...common}
          rows={3}
          className="si-input h-auto py-3"
          onChange={(event) => props.onChange(event.target.value)}
        />
      ) : (
        <input
          {...common}
          className="si-input"
          type={props.type ?? "text"}
          autoComplete={props.autoComplete ?? AUTOCOMPLETE_BY_TYPE[props.type ?? "text"]}
          inputMode={props.inputMode}
          onChange={(event) => props.onChange(event.target.value)}
        />
      )}
      {props.hint ? (
        <p id={hintId} className="text-muted px-1 text-[13px] leading-snug text-pretty">
          {props.hint}
        </p>
      ) : null}
    </div>
  );
}

/** The class for a list (`<select>`) in the field's shape, with its own chevron. */
export const SELECT_CLASS = "si-input wz-select";

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
    <fieldset className="grid gap-2.5">
      <legend className="mb-2 px-1 text-sm font-semibold">{props.legend}</legend>
      {props.options.map((option) => {
        const id = `${name}-${option.id}`;
        return (
          // A card per choice (globals.css, .wz-choice): the chosen one takes
          // the field's orange ring; a choice not open now is dimmed.
          <label key={option.id} htmlFor={id} className="wz-choice">
            <input
              id={id}
              type="radio"
              name={name}
              value={option.id}
              checked={props.value === option.id}
              disabled={option.disabled}
              aria-describedby={props.describedBy}
              onChange={() => props.onChange(option.id)}
            />
            <span>
              <span className="block font-semibold">{option.label}</span>
              {option.line ? (
                <span className="text-muted mt-0.5 block text-sm text-pretty">{option.line}</span>
              ) : null}
            </span>
          </label>
        );
      })}
    </fieldset>
  );
}
