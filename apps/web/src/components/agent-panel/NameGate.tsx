"use client";

import { useEffect, useId, useRef, useState } from "react";

import { cleanFirstName, FIRST_NAME_MAX } from "@/lib/demo/first-name";

/**
 * The start of a personalised demo call (owner, 24 October 2026): one pill
 * that says "Let's start" with a loading icon, turns into "What's your
 * name?" with a way to answer, and on the answer turns into the line the
 * visitor waits on, its dots moving until the call arrives.
 *
 *   loading  a spinner and "Let's start", a second or so: the demo is
 *            getting ready for them, and it is the beat that makes the
 *            question feel asked rather than demanded;
 *   ask      the pill opens into an input and a submit button;
 *   waiting  the pill closes round "AYA will be with you in a moment…" (the
 *            words come from the way chosen: browser call, call-me, dial).
 *
 * The three states are layers of one element, so the widths and the fades
 * between them are CSS transitions (.name-pill in globals.css) and the pill
 * changes shape instead of swapping. The parent owns the name: it passes it
 * back once taken, which is what moves the pill on to "waiting", and the
 * same parent decides what happens next (start the browser call, show the
 * call-me form, show the number to dial). Under reduced motion the
 * transitions collapse to a single frame and the intro is shorter.
 *
 * What it asks for is a first name a clinic owner types about themselves,
 * checked here with the rule the server applies again (lib/demo/first-name.ts).
 */

/** How long "Let's start" shows before the question: long enough to read, short enough not to feel stuck. */
const INTRO_MS = 1200;
const INTRO_REDUCED_MS = 350;

export function NameGate({
  name,
  waitingText,
  onSubmit,
  introDone,
  onIntroDone,
  disabled = false,
}: {
  /** The name taken, or null while it is still to be asked. */
  name: string | null;
  /** The waiting line, without its dots: "AYA will be with you in a moment". */
  waitingText: string;
  onSubmit: (name: string) => void;
  /** The intro has already played in this visit: open straight on the question. */
  introDone: boolean;
  onIntroDone: () => void;
  disabled?: boolean;
}) {
  const [ready, setReady] = useState(introDone);
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const inputId = useId();
  const errorId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const phase = name ? "waiting" : ready ? "ask" : "loading";

  useEffect(() => {
    if (ready || name) return;
    const reduced = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const id = window.setTimeout(() => {
      setReady(true);
      onIntroDone();
    }, reduced ? INTRO_REDUCED_MS : INTRO_MS);
    return () => window.clearTimeout(id);
  }, [name, onIntroDone, ready]);

  // Someone who came back to this way of calling chose it, so the question takes focus; the first
  // time it opens by itself, and moving focus (and a phone's keyboard) there would be rude.
  const cameBack = useRef(introDone);
  useEffect(() => {
    if (cameBack.current && !name) inputRef.current?.focus({ preventScroll: true });
    // Once, as the gate appears.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- a name given later must not move focus
  }, []);

  function submit(event: React.FormEvent) {
    event.preventDefault();
    if (disabled) return;
    const clean = cleanFirstName(value);
    if (!clean) {
      setError("Just your first name, please: letters only.");
      inputRef.current?.focus();
      return;
    }
    setError(null);
    onSubmit(clean);
  }

  return (
    <div className="name-gate flex w-full flex-col items-center">
      <div className="name-pill" data-phase={phase} role="group" aria-label="Before we start">
        <div className="name-pill__layer name-pill__loading" data-on={phase === "loading" || undefined} inert={phase !== "loading"}>
          <span aria-hidden className="name-spinner" />
          <span role="status" className="text-sm font-semibold">
            {phase === "loading" ? "Let’s start" : ""}
          </span>
        </div>

        <form className="name-pill__layer name-pill__ask" data-on={phase === "ask" || undefined} inert={phase !== "ask"} onSubmit={submit} noValidate>
          <label htmlFor={inputId} className="sr-only">
            What&rsquo;s your name?
          </label>
          <input
            ref={inputRef}
            id={inputId}
            type="text"
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              if (error) setError(null);
            }}
            placeholder={"What’s your name?"}
            autoComplete="given-name"
            enterKeyHint="go"
            maxLength={FIRST_NAME_MAX + 20}
            disabled={disabled}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? errorId : undefined}
            className="name-pill__input"
          />
          <button
            type="submit"
            aria-label="Continue"
            disabled={disabled || !value.trim()}
            className="name-pill__go"
            style={{ background: "var(--clinic)", color: "var(--clinic-ink)" }}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M5 12h14M13 6l6 6-6 6" />
            </svg>
          </button>
        </form>

        <div className="name-pill__layer name-pill__wait" data-on={phase === "waiting" || undefined} inert={phase !== "waiting"}>
          <p role="status" aria-live="polite" className="text-sm font-semibold">
            {phase === "waiting" ? (
              <>
                {waitingText}
                <span aria-hidden className="name-dots">
                  <i />
                  <i />
                  <i />
                </span>
                <span className="sr-only">…</span>
              </>
            ) : null}
          </p>
        </div>
      </div>
      {error ? (
        <p id={errorId} role="alert" className="text-red-deep mt-2 text-xs font-semibold">
          {error}
        </p>
      ) : null}
    </div>
  );
}
