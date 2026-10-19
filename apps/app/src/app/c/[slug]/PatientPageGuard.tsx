"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import { keepPatientPageOpen, patientPageStatus, type PatientPageClock } from "./keep-open";
import { leavePatientPage, reloadPatientPage } from "./patient-navigation";

/**
 * Wraps what a patient page shows (plan Part D2), with the props
 * patientGuardProps(page) gives (lib/portal/patient-page.ts).
 *
 * The server decides: requirePatientPage refuses a lapsed step-up on every
 * request. This keeps the browser from showing what it already holds once
 * the server would no longer:
 *
 * - **Nothing shows until the server answers.** On every mount the guard asks
 *   patientPageStatus whether the step-up the page was rendered under is
 *   still live, and renders nothing of the page until it says yes.
 * - **A payload shown once is never shown again.** Back and Forward replay a
 *   page from the router's cache, and the browser's back-forward cache
 *   restores a whole document. A render this document has already shown, or
 *   a document restored that way, is loaded again from the server, which
 *   checks the step-up and logs the open again.
 * - **The deadline is the server's.** Every answer carries when the step-up
 *   lapses and the server's now, both absolute; the guard counts down from
 *   their difference, less a margin for the answer's trip. A fresh render, a
 *   tab shown again, Back or Forward, and "Keep open" each ask again and
 *   adopt the answer, and at the deadline it asks once more (another tab may
 *   have kept the step-up alive) before it closes.
 * - **Closing leaves the page.** The record leaves the DOM at once and the
 *   browser replaces the page with the step-up page, which offers the
 *   passkey and "Use your phone instead", then comes back with a fresh render
 *   if it can: the payload goes with the document.
 *
 * A minute before the deadline an assertive live region, which stays in the
 * page so screen readers announce it, warns with "Keep open". Nothing moves,
 * and every target is at least 44px tall (Part F8). One guard per page.
 */

/** How long before the step-up lapses the warning shows. */
export const WARN_BEFORE_MS = 60_000;
/** Taken off each deadline for the server's answer to get here. */
export const ANSWER_MARGIN_MS = 2_000;
const TICK_MS = 1_000;

/** The renders this document has shown. A second mount of one is a replay from cache. */
const shown = new Set<string>();

type Phase = "checking" | "unreachable" | "open" | "warning" | "closing" | "closed" | "reloading";
const SHOWING: ReadonlySet<Phase> = new Set(["open", "warning"]);
/** Once the page is leaving or loading again, nothing brings it back. */
const FINAL: ReadonlySet<Phase> = new Set(["closed", "reloading"]);

export function PatientPageGuard(props: {
  slug: string;
  stepUpId: string;
  renderId: string;
  children: ReactNode;
}) {
  const { slug, stepUpId, renderId } = props;
  const deadline = useRef(0);
  const phaseRef = useRef<Phase>("checking");
  const [phase, setPhaseState] = useState<Phase>("checking");
  const [capped, setCapped] = useState(false);
  const [working, setWorking] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const setPhase = useCallback((next: Phase) => {
    if (FINAL.has(phaseRef.current)) return;
    phaseRef.current = next;
    setPhaseState(next);
  }, []);

  /** Off to the step-up page, which comes back with a fresh render if a step-up is live. */
  const leave = useCallback(() => {
    if (FINAL.has(phaseRef.current)) return;
    setPhase("closed");
    leavePatientPage(`/c/${slug}/step-up?next=${encodeURIComponent(window.location.pathname)}`);
  }, [slug, setPhase]);

  /** A replay: load the page again from the server rather than show what is held. */
  const reload = useCallback(() => {
    if (FINAL.has(phaseRef.current)) return;
    setPhase("reloading");
    reloadPatientPage();
  }, [setPhase]);

  /** Show the page until the server's deadline, or leave if the answer is no. */
  const adopt = useCallback(
    (answer: PatientPageClock): boolean => {
      if (!answer.ok || answer.stepUpId !== stepUpId) {
        leave();
        return false;
      }
      const left = Date.parse(answer.expiresAt) - Date.parse(answer.now) - ANSWER_MARGIN_MS;
      deadline.current = Date.now() + left;
      setCapped(answer.capped);
      if (left <= 0) {
        leave();
        return false;
      }
      setPhase(left <= WARN_BEFORE_MS ? "warning" : "open");
      return true;
    },
    [stepUpId, leave, setPhase],
  );

  const firstLook = useCallback(
    (isCurrent: () => boolean) => {
      setPhase("checking");
      patientPageStatus(slug, stepUpId).then(
        (answer) => {
          if (isCurrent() && adopt(answer)) shown.add(renderId);
        },
        () => {
          if (isCurrent()) setPhase("unreachable");
        },
      );
    },
    [slug, stepUpId, renderId, adopt, setPhase],
  );

  // Every render the server sends is checked before it shows; a replay never is.
  useEffect(() => {
    if (shown.has(renderId)) {
      reload();
      return;
    }
    let current = true;
    firstLook(() => current);
    return () => {
      current = false;
    };
  }, [renderId, firstLook, reload]);

  // The clock, and the page coming back into view.
  useEffect(() => {
    /** At the deadline the record goes at once; it comes back only if the server extends it. */
    const expire = () => {
      setPhase("closing");
      patientPageStatus(slug, stepUpId).then(adopt, leave);
    };
    const tick = () => {
      if (!SHOWING.has(phaseRef.current)) return;
      const left = deadline.current - Date.now();
      if (left <= 0) expire();
      else setPhase(left <= WARN_BEFORE_MS ? "warning" : "open");
    };
    /** Shown again: the local clock first (it may have slept), then the server. */
    const look = () => {
      if (document.visibilityState === "hidden") return;
      tick();
      if (!SHOWING.has(phaseRef.current)) return;
      // A failed look keeps the server's last deadline, which the clock still enforces.
      patientPageStatus(slug, stepUpId).then(
        (answer) => {
          if (SHOWING.has(phaseRef.current)) adopt(answer);
        },
        () => undefined,
      );
    };
    const restored = (event: PageTransitionEvent) => {
      if (event.persisted) reload();
    };
    const timer = setInterval(tick, TICK_MS);
    document.addEventListener("visibilitychange", look);
    window.addEventListener("focus", look);
    window.addEventListener("popstate", look);
    window.addEventListener("pageshow", restored);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", look);
      window.removeEventListener("focus", look);
      window.removeEventListener("popstate", look);
      window.removeEventListener("pageshow", restored);
    };
  }, [slug, stepUpId, adopt, leave, reload, setPhase]);

  async function keepOpen(): Promise<void> {
    setWorking(true);
    setProblem(null);
    try {
      adopt(await keepPatientPageOpen(slug, stepUpId));
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
              {capped
                ? "This page closes in a minute: one confirmation lasts 8 hours at most, so you’ll be asked to confirm it’s you again."
                : "This page closes in a minute, to keep the details on it private."}
            </p>
            {capped ? null : (
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
      {SHOWING.has(phase) ? (
        props.children
      ) : phase === "checking" ? (
        <p className="text-muted mt-6 text-sm">Opening&hellip;</p>
      ) : phase === "unreachable" ? (
        <div className="mt-6 text-sm">
          <p>This page couldn&rsquo;t check with healdesk that it&rsquo;s still you.</p>
          <button
            type="button"
            onClick={() => firstLook(() => true)}
            className="border-line mt-3 min-h-11 rounded-full border px-5 font-semibold"
          >
            Try again
          </button>
        </div>
      ) : null}
    </div>
  );
}
