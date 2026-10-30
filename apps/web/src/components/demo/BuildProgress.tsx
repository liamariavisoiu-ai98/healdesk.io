"use client";

import { useEffect, useRef, useState } from "react";

import { type BuildEstimate, type BuildStage, type BuildStep, estimateBuild, timeLeftText } from "@/lib/demo/build-progress";
import { site } from "@/lib/site";

/**
 * A demo's build as a percentage, a bar, the time left and the step it is on
 * (lib/demo/build-progress.ts has the estimate and what it rests on).
 *
 * The server says the stage and how long the build has run at the moment it
 * rendered; the browser carries that forward on its own clock between the
 * holding screen's refreshes, so a visitor's clock being wrong costs nothing.
 * The percentage only ever rises: a refresh that lands a little behind what
 * was shown leaves the bar where it is.
 *
 * `compact` is the homepage window's: the bar and the line under it, no steps.
 */

const STEPS: readonly BuildStep[] = ["read", "learn", "check"];

function stepLabel(step: BuildStep, host: string): string {
  if (step === "read") return `Reading ${host}`;
  if (step === "learn") return "Learning your services, prices and hours";
  return `Testing ${site.agent}’s answers before you see them`;
}

/** The later of two steps, so a step once shown as done stays done. */
function laterStep(a: BuildStep, b: BuildStep): BuildStep {
  return STEPS.indexOf(a) >= STEPS.indexOf(b) ? a : b;
}

export function BuildProgress({
  stage,
  elapsedMs,
  host,
  colour = "var(--clinic)",
  compact = false,
}: {
  stage: BuildStage;
  /** How long the build had run when the server answered. */
  elapsedMs: number;
  /** The site being read, as the visitor typed it. */
  host: string;
  /** The bar's colour: the clinic's on its own page, Safari's blue in the homepage window. */
  colour?: string;
  compact?: boolean;
}) {
  const [shown, setShown] = useState<BuildEstimate>(() => estimateBuild(stage, elapsedMs));
  /** The build's clock reading when this page first saw it reading, and when it first saw it checking. */
  const sawReading = useRef(false);
  const auditingSince = useRef<number | null>(null);

  useEffect(() => {
    if (stage === "building") sawReading.current = true;
    // Seen to begin, the audit is dated from this answer; opened mid-audit,
    // the estimate dates it (estimateBuild).
    else if (sawReading.current && auditingSince.current === null) auditingSince.current = elapsedMs;
    const received = Date.now();
    const tick = () => {
      const next = estimateBuild(stage, elapsedMs + (Date.now() - received), auditingSince.current);
      setShown((prev) => ({
        percent: Math.max(prev.percent, next.percent),
        step: laterStep(prev.step, next.step),
        leftMs: next.leftMs,
      }));
    };
    const id = window.setInterval(tick, 500);
    return () => window.clearInterval(id);
  }, [stage, elapsedMs]);

  const left = timeLeftText(shown.leftMs);
  const current = STEPS.indexOf(shown.step);

  const bar = (
    <div
      role="progressbar"
      aria-label="Building your demo"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={shown.percent}
      aria-valuetext={`${shown.percent}%, ${left.toLowerCase()}`}
      className={`overflow-hidden rounded-full bg-black/[0.08] ${compact ? "h-1.5" : "h-2.5"}`}
    >
      <div
        className="h-full rounded-full transition-[width] duration-base ease-out motion-reduce:transition-none"
        style={{ width: `${shown.percent}%`, background: colour }}
      />
    </div>
  );

  if (compact) {
    return (
      <div className="w-full">
        {bar}
        {/* The step drops out where it would be cut short; the percentage and the time left stay. */}
        <p className="mt-2 flex justify-center gap-3 text-xs font-semibold text-[#6e6e73] sm:justify-between">
          <span className="hidden truncate sm:block">{stepLabel(shown.step, host)}</span>
          <span className="shrink-0 tabular-nums">
            {shown.percent}% &middot; {left}
          </span>
        </p>
      </div>
    );
  }

  return (
    <div className="w-full max-w-[460px]">
      <div className="flex items-baseline justify-between gap-4">
        <span className="font-display text-4xl leading-none font-medium tracking-[-0.02em] tabular-nums">{shown.percent}%</span>
        <span className="text-muted text-sm font-semibold">{left}</span>
      </div>
      <div className="mt-3">{bar}</div>
      <ol className="mt-6 space-y-3 text-left text-sm font-medium">
        {STEPS.map((step, i) => {
          const state = i < current ? "done" : i === current ? "now" : "later";
          return (
            <li key={step} className={`flex items-center gap-3 ${state === "later" ? "text-muted" : ""}`}>
              {state === "done" ? (
                <span aria-hidden className="grid size-5 shrink-0 place-items-center rounded-full" style={{ background: colour, color: "var(--clinic-ink, #fff)" }}>
                  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="size-3">
                    <path d="m3.5 8.5 3 3 6-7" />
                  </svg>
                </span>
              ) : state === "now" ? (
                <span aria-hidden className="size-5 shrink-0 animate-spin rounded-full border-[2.5px] border-t-transparent motion-reduce:animate-none" style={{ borderColor: colour, borderTopColor: "transparent" }} />
              ) : (
                <span aria-hidden className="size-5 shrink-0 rounded-full border-2 border-black/15" />
              )}
              <span>
                <span className="sr-only">{state === "done" ? "Done: " : state === "now" ? "Now: " : "Next: "}</span>
                {stepLabel(step, host)}
              </span>
            </li>
          );
        })}
      </ol>
      <p className="text-muted mt-6 text-sm font-medium">
        {shown.leftMs > 0
          ? "This page will update by itself."
          : stage === "building"
            ? "Some websites take longer to read. This page will update by itself."
            : "Finishing the last checks. This page will update by itself."}
      </p>
    </div>
  );
}
