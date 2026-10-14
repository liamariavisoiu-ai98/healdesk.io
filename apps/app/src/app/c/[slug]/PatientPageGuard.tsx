"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import { deviceKindFrom } from "@/lib/factors/device";
import { STEP_UP_IDLE_MS } from "@/lib/factors/step-up-windows";

import { keepPatientPageOpen } from "./keep-open";
import { StepUpPrompt } from "./step-up/StepUpPrompt";

/**
 * Wraps what a patient page shows (plan Part D2): 60 seconds before the
 * passkey step-up lapses it warns, with "Keep open"; when it lapses it takes
 * the page's patient data out of the DOM and puts the one-tap passkey prompt
 * in its place, with "Use your phone instead".
 *
 * The server decides: requirePatientPage refuses a lapsed step-up on every
 * request. This only stops a screen left open from showing what it showed.
 * `expiresInMs` is the page's `stepUp.expiresInMs`, measured on the
 * database's clock when the page was rendered; a few seconds come off it for
 * the time the page took to arrive, so the screen closes before the server
 * would refuse. The clock here is Date.now(), checked every second and when
 * the tab is shown again, because timers sleep with a laptop.
 *
 * The warning sits in an assertive live region, which stays in the page so
 * screen readers announce it; nothing moves, so there is no motion to
 * reduce; every target is at least 44px tall (Part F8).
 */

/** How long before the step-up lapses the warning shows. */
export const WARN_BEFORE_MS = 60_000;
/** Taken off the server's figure for the time between the check and the page arriving. */
export const ARRIVAL_MARGIN_MS = 5_000;
const TICK_MS = 1_000;

type Phase = "open" | "warning" | "closed";

export function PatientPageGuard(props: {
  slug: string;
  expiresInMs: number;
  children: ReactNode;
}) {
  const deadline = useRef<number>(0);
  const [phase, setPhase] = useState<Phase>("open");
  const [atLimit, setAtLimit] = useState(false);
  const [working, setWorking] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  /** Where the clock leaves the page. Closed is final: only a passkey, and a fresh page, open it. */
  const check = useCallback(() => {
    const left = deadline.current - Date.now();
    if (left <= 0) setPhase("closed");
    else setPhase((now) => (now === "closed" ? now : left <= WARN_BEFORE_MS ? "warning" : "open"));
  }, []);

  /** Count from a figure the server gave. */
  const fromServer = useCallback(
    (expiresInMs: number) => {
      deadline.current = Date.now() + expiresInMs - ARRIVAL_MARGIN_MS;
      // Right after a check the idle window is whole, so less than that left
      // means the 8-hour limit is the one that applies: "Keep open" cannot help.
      setAtLimit(expiresInMs < STEP_UP_IDLE_MS - TICK_MS);
      check();
    },
    [check],
  );

  useEffect(() => {
    fromServer(props.expiresInMs);
    const timer = setInterval(check, TICK_MS);
    document.addEventListener("visibilitychange", check);
    window.addEventListener("pageshow", check);
    window.addEventListener("focus", check);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", check);
      window.removeEventListener("pageshow", check);
      window.removeEventListener("focus", check);
    };
  }, [props.expiresInMs, fromServer, check]);

  async function keepOpen(): Promise<void> {
    setWorking(true);
    setProblem(null);
    try {
      const kept = await keepPatientPageOpen(props.slug);
      if (kept.ok) fromServer(kept.expiresInMs);
      else setPhase("closed");
    } catch {
      setProblem("That didn't reach us. Try again.");
    } finally {
      setWorking(false);
    }
  }

  return (
    <div>
      <div aria-live="assertive" aria-atomic="true" className="sticky top-0 z-10">
        {phase === "warning" ? (
          <div className="border-line bg-tint-butter my-4 flex flex-wrap items-center gap-3 rounded-2xl border px-4 py-3 text-sm">
            <p className="flex-1">
              {atLimit
                ? "This page closes in a minute: one confirmation lasts 8 hours at most. Confirm it’s you again to carry on."
                : "This page closes in a minute, to keep the details on it private."}
            </p>
            {atLimit ? null : (
              <button
                type="button"
                onClick={() => void keepOpen()}
                disabled={working}
                className="bg-ink min-h-11 rounded-full px-5 text-sm font-bold text-white disabled:opacity-50"
              >
                Keep open
              </button>
            )}
            {problem ? <p className="w-full text-red-800">{problem}</p> : null}
          </div>
        ) : phase === "closed" ? (
          <p className="text-muted mt-6 text-sm">
            This page has closed, to keep the details on it private.
          </p>
        ) : null}
      </div>
      {phase === "closed" ? <Reprompt slug={props.slug} /> : props.children}
    </div>
  );
}

/**
 * The step-up page's own prompt, in place: one tap, or the phone by QR code,
 * then back to this page, which reads everything again. `next` is the path
 * only: a query string can carry a search term, and `next` ends up in history.
 */
function Reprompt({ slug }: { slug: string }) {
  const next = window.location.pathname;
  return (
    <div className="mt-4">
      <StepUpPrompt
        slug={slug}
        next={next}
        hasPasskey
        protectHref={`/c/${slug}/protect?next=${encodeURIComponent(next)}`}
        initialDevice={deviceKindFrom({
          userAgent: navigator.userAgent,
          maxTouchPoints: navigator.maxTouchPoints,
        })}
      />
    </div>
  );
}
