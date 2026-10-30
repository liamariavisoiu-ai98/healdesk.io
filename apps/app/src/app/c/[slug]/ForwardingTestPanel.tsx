"use client";

import { useEffect, useRef, useState } from "react";

import {
  forwardingTestHeading,
  forwardingTestLine,
  type ForwardingTestView,
} from "@/lib/setup/forwarding-test-words";

import { forwardingTestStatusAction, startForwardingTestAction } from "./forwarding-actions";

/** How often the screen asks whether the test call has landed. */
const POLL_MS = 4_000;
/**
 * How long after the window it keeps asking: a call that started inside the
 * five minutes is recorded when it ends, which can be after the window.
 */
const GRACE_MS = 10 * 60 * 1000;
/** Within this long after the window, "no call" is still being checked. */
const CHECKING_MS = 2 * 60 * 1000;

/**
 * "Test it now" (plan Part E step 4) and "Waiting for call forwarding": the
 * clinic opens its own forwarding-test window, rings its main number, and
 * this says what the call showed once it has been recorded. Shared by the
 * wizard's forwarding screen and Settings → Channels. The page is read
 * again once a call passes, so the phone row's status word follows it.
 */
export function ForwardingTestPanel({
  slug,
  initial,
}: {
  slug: string;
  initial: ForwardingTestView;
}) {
  const [view, setView] = useState<ForwardingTestView>(initial);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [until, setUntil] = useState<number | null>(
    initial.state.kind === "open" ? Date.parse(initial.state.until) : null,
  );
  const [now, setNow] = useState(() => Date.now());
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const waiting =
    until !== null &&
    (view.state.kind === "open" || view.state.kind === "no_call") &&
    now < until + GRACE_MS;

  useEffect(() => {
    if (!waiting) return;
    timer.current = setInterval(async () => {
      setNow(Date.now());
      try {
        const next = await forwardingTestStatusAction(slug);
        if (next) setView(next);
      } catch {
        // The next tick asks again.
      }
    }, POLL_MS);
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, [waiting, slug]);

  async function start() {
    setBusy(true);
    setProblem(null);
    try {
      const result = await startForwardingTestAction(slug);
      if (result.ok) {
        setView({ state: result.state, canTest: false });
        if (result.state.kind === "open") setUntil(Date.parse(result.state.until));
        setNow(Date.now());
      } else {
        setProblem(result.message);
      }
    } catch {
      setProblem("The test didn't start. Try again in a moment.");
    }
    setBusy(false);
  }

  const checking = view.state.kind === "no_call" && until !== null && now < until + CHECKING_MS;
  const line = checking
    ? "Checking for a call that started in time. If you're still on it, hang up and the result shows here."
    : forwardingTestLine(view.state);

  return (
    <div className="border-line grid gap-2 rounded-md border px-3 py-3 text-sm">
      <p className="font-semibold">
        {forwardingTestHeading(view.state)}
      </p>
      <p role="status" aria-live="polite">
        {line}
      </p>
      {problem ? (
        <p role="alert" className="text-problem">
          {problem}
        </p>
      ) : null}
      {view.canTest && view.state.kind !== "open" && !checking ? (
        <p>
          <button
            type="button"
            disabled={busy}
            onClick={() => void start()}
            className="bg-ink min-h-11 rounded-full px-5 text-sm font-bold text-white disabled:opacity-50"
          >
            {busy ? "Opening the test…" : "Test it now"}
          </button>
        </p>
      ) : null}
    </div>
  );
}
